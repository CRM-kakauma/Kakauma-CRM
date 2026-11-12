/** Paylog Webhook V2: delivery steps become the CRM's fulfillment facts ("Entrega realizada"). */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import {
  isPaylogResend,
  isPaylogV1,
  normalizePaylog,
  paylogV1Kind,
  paylogV1ToV2,
} from "../../src/server/crm/normalize/paylog.ts";
import { checkPaylogAuth } from "../../src/server/crm/paylog.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

type Obj = Record<string, unknown>;
const RECEIVED = "2026-11-05T12:00:00.000Z";

/** Paylog V2 payload, shape from the Paylog documentation (full schema, nulls included). */
function paylog(event: string, extra: { order?: Obj; shipment?: Obj; root?: Obj } = {}): Obj {
  return {
    event,
    event_label: "Entregue",
    event_timestamp: "2026-11-05T09:15:30-03:00",
    idempotency_key: `idem-${event}-${Math.random().toString(36).slice(2)}`,
    cancelable: false,
    order: {
      pedido_id: 12345,
      codigo_transacao: "S-PL1",
      referencia_externa: null,
      plataforma: "B4You",
      status: { code: 7, label: "Entregue" },
      motivo_parado: null,
      customer: {
        nome: "Maria Souza",
        cpf: "123.456.789-09",
        email: "maria.souza@example.com",
        telefone: "(11) 98888-7777",
        endereco: {
          logradouro: "Rua A",
          numero: "10",
          complemento: null,
          bairro: "Centro",
          cidade: "São Paulo",
          uf: "SP",
          cep: "01000-000",
          pais: "BR",
        },
      },
      items: [
        {
          descricao: "Sleep Drink",
          quantidade: 1,
          valor_unitario_cents: 22700,
          produto: { id: 42, nome: "Sleep Drink" },
        },
      ],
      frete_cents: 1895,
      ...extra.order,
    },
    shipment: {
      tracking_code: "AA123456789BR",
      tracking_url: "https://ev.paylog.cash/rastreio/AA123456789BR",
      carrier: { code: "correios", name: "CORREIOS" },
      tracking_status: { code: 70, label: "Entregue" },
      description: "Objeto entregue ao destinatário",
      location: "São Paulo/SP",
      occurred_at: "2026-11-05T09:10:00-03:00",
      collection_address: null,
      delivery_proof: {
        image_url: null,
        signature_url: null,
        received_by: null,
        signatory: null,
        delivery_lat: null,
        delivery_lng: null,
      },
      ...extra.shipment,
    },
    meta: { webhook_version: 2, api_version: 2 },
    ...extra.root,
  };
}

describe("Paylog normalizer", () => {
  test("shipment.delivered → TRACKING DELIVERED at the carrier's time", () => {
    const n = normalizePaylog(paylog("shipment.delivered"), { receivedAt: RECEIVED });
    assert.ok(n.ok);
    const e = n.event!;
    assert.equal(e.source, "paylog");
    assert.equal(e.event_type, "TRACKING");
    assert.equal(e.occurred_at, "2026-11-05T12:10:00.000Z");
    assert.equal(e.sale_id, "S-PL1");
    assert.equal(e.customer.email, "maria.souza@example.com");
    assert.equal(e.customer.whatsapp, "(11) 98888-7777");
    assert.equal(e.fulfillment?.status, "DELIVERED");
    assert.equal(e.fulfillment?.tracking_code, "AA123456789BR");
    assert.equal(e.fulfillment?.delivered_at, "2026-11-05T12:10:00.000Z");
    assert.equal(e.fulfillment?.shipping_cost, 18.95);
    assert.equal(e.fulfillment?.carrier, "CORREIOS");
    // nothing that would count as a campaign touch or a product of the catalog
    assert.deepEqual(e.attribution, { extra: {} });
    assert.equal(e.product, null);
  });

  test("the other delivery steps", () => {
    const steps: Record<string, string> = {
      "shipment.posted": "SHIPPED",
      "shipment.in_transit": "IN_TRANSIT",
      "shipment.out_for_delivery": "OUT_FOR_DELIVERY",
      "shipment.awaiting_pickup": "DELIVERY_FAILED",
      "shipment.returned": "DELIVERY_RETURNED",
    };
    for (const [ev, status] of Object.entries(steps)) {
      const n = normalizePaylog(paylog(ev), { receivedAt: RECEIVED });
      assert.equal(n.event?.fulfillment?.status, status, ev);
    }
  });

  test("order events and the delivery proof are kept but ignored", () => {
    for (const ev of ["order.created", "order.canceled", "shipment.delivery_proof"]) {
      const n = normalizePaylog(paylog(ev), { receivedAt: RECEIVED });
      assert.ok(n.ok);
      assert.equal(n.event?.event_type, "UNKNOWN", ev);
    }
  });

  test("batch resend (no carrier date): only an order delivered today counts", () => {
    const resend = (event: string, label: string) =>
      normalizePaylog(
        paylog(event, {
          shipment: {
            occurred_at: null,
            description: null,
            location: null,
            tracking_status: { code: 1, label },
          },
        }),
        { receivedAt: RECEIVED },
      );
    assert.ok(isPaylogResend(paylog("shipment.delivered", { shipment: { occurred_at: null } })));
    assert.ok(!isPaylogResend(paylog("shipment.delivered")));

    const ok = resend("shipment.delivered", "Entregue");
    assert.equal(ok.event?.event_type, "TRACKING");
    assert.equal(ok.event?.fulfillment?.status, "DELIVERED");
    assert.equal(ok.event?.occurred_at, "2026-11-05T12:15:30.000Z"); // the resend time
    assert.ok(ok.event?.warnings.some((w) => w.code === "paylog_resend"));
    // "delivered" emitted for orders that were not delivered: ignored
    for (const label of [
      "Em Trânsito",
      "Saiu para Entrega",
      "Não entregue",
      "Entregue ao remetente",
    ]) {
      const n = resend("shipment.delivered", label);
      assert.equal(n.event?.event_type, "UNKNOWN", label);
    }
    // the other steps from a resend: ignored
    assert.equal(resend("shipment.in_transit", "Em Trânsito").event?.event_type, "UNKNOWN");
  });

  test("a delivery with no customer and no reference is invalid", () => {
    const n = normalizePaylog(
      paylog("shipment.delivered", {
        order: {
          codigo_transacao: null,
          customer: { nome: null, cpf: null, email: null, telefone: null, endereco: {} },
        },
        shipment: { tracking_code: null },
      }),
      { receivedAt: RECEIVED },
    );
    assert.equal(n.ok, false);
  });
});

describe("Paylog signature", () => {
  const body = JSON.stringify(paylog("shipment.delivered"));
  const sign = (s: string, b: string) =>
    "sha256=" + createHmac("sha256", s).update(b, "utf8").digest("hex");

  const URL_ = "https://crm.example/api/webhooks/paylog";
  const auth = (o: {
    secret?: string;
    token?: string;
    body?: string;
    signature?: string | null;
    url?: string;
    dev?: boolean;
  }) =>
    checkPaylogAuth({
      secret: o.secret,
      token: o.token,
      rawBody: o.body ?? body,
      signature: o.signature ?? null,
      url: o.url ?? URL_,
      dev: o.dev ?? false,
    });

  test("valid signature over the raw body", async () => {
    assert.equal(await auth({ secret: "segredo", signature: sign("segredo", body) }), null);
  });
  test("wrong secret, changed body or no header → 401", async () => {
    assert.equal((await auth({ secret: "segredo", signature: sign("outro", body) }))?.status, 401);
    assert.equal(
      (await auth({ secret: "segredo", body: body + " ", signature: sign("segredo", body) }))
        ?.status,
      401,
    );
    assert.equal((await auth({ secret: "segredo" }))?.status, 401);
  });
  test("without the secret: a token in the URL", async () => {
    assert.equal(await auth({ token: "tok123", url: URL_ + "?token=tok123" }), null);
    assert.equal((await auth({ token: "tok123", url: URL_ + "?token=errado" }))?.status, 401);
    assert.equal((await auth({ token: "tok123" }))?.status, 401);
    // both configured: either one is enough
    assert.equal(
      await auth({ secret: "segredo", token: "tok123", url: URL_ + "?token=tok123" }),
      null,
    );
    assert.equal(
      await auth({ secret: "segredo", token: "tok123", signature: sign("segredo", body) }),
      null,
    );
  });
  test("nothing configured on the server: 503 in production, open in development", async () => {
    assert.equal((await auth({}))?.status, 503);
    assert.equal(await auth({ dev: true }), null);
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async (fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data;
};

describe("Paylog → CRM", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'pl_%')`;
    await sql!`delete from crm.flows where key like 'pl_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_save_flow", {
      p_key: "pl_delivered",
      p_name: "Entrega realizada",
      p_trigger_fact: "FULFILLMENT_DELIVERED",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "w", type: "wait", config: { amount: 1, unit: "days" } },
        ],
        edges: [{ source: "start", target: "w", handle: "next" }],
      },
    });
    await call("crm_publish_flow", { p_key: "pl_delivered" });
    // the buyer already exists, from the B4you sale
    const paid = await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", { sale_id: "S-PL1", charges: [{ id: "CH-PL1", amount: 227 }] }),
      ),
    );
    assert.ok(paid.status < 300, JSON.stringify(paid.body));
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'pl_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("delivery reaches the B4you customer, the order and the delivery flow", async () => {
    const now = new Date();
    const body = paylog("shipment.delivered", {
      shipment: { occurred_at: now.toISOString() },
    });
    const r = await ingestWebhook(rpc, "paylog", JSON.stringify(body));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body["status"], "PROCESSED");

    const customers = await sql!`select count(*)::int as n from crm.customers`;
    assert.equal(customers[0]!["n"], 1, "same person, not a new customer");
    const [fu] = await sql!`select status, order_id, carrier, delivered_at from crm.fulfillments
                             where tracking_code = 'AA123456789BR'`;
    assert.equal(fu!["status"], "DELIVERED");
    assert.ok(fu!["order_id"], "linked to the B4you order by codigo_transacao");
    assert.equal(fu!["carrier"], "CORREIOS");
    const facts =
      await sql!`select fact_type from crm.customer_events where fact_type = 'FULFILLMENT_DELIVERED'`;
    assert.equal(facts.length, 1);
    const en =
      await sql!`select count(*)::int as n from crm.flow_enrollments en join crm.flows f using (flow_id)
                           where f.key = 'pl_delivered'`;
    assert.equal(en[0]!["n"], 1);

    // Paylog retries with the same idempotency_key: one stored event, one fact
    const again = await ingestWebhook(rpc, "paylog", JSON.stringify(body));
    assert.equal(again.body["duplicate"], true);
    // a batch resend of the same delivery (new key, no carrier date): history, same fact
    const resend = paylog("shipment.delivered", { shipment: { occurred_at: null } });
    const r2 = await ingestWebhook(rpc, "paylog", JSON.stringify(resend), { backfill: true });
    assert.equal(r2.body["status"], "PROCESSED");
    const facts2 =
      await sql!`select count(*)::int as n from crm.customer_events where fact_type = 'FULFILLMENT_DELIVERED'`;
    assert.equal(facts2[0]!["n"], 1);
  });

  test("batch resend frees the customer stuck waiting for the delivery, starts no flow", async () => {
    await call("crm_save_flow", {
      p_key: "pl_stuck",
      p_name: "Pós-compra",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          {
            id: "env",
            type: "wait_event",
            config: { fact: "FULFILLMENT_DELIVERED", timeout_hours: 720 },
          },
          { id: "after", type: "wait", config: { amount: 1, unit: "days" } },
        ],
        edges: [
          { source: "start", target: "env", handle: "next" },
          { source: "env", target: "after", handle: "event" },
        ],
      },
    });
    await call("crm_publish_flow", { p_key: "pl_stuck" });
    const buyer = {
      ...(b4("x")["customer"] as Obj),
      id: "cus_pl2",
      email: "joao@example.com",
      whatsapp: "(31) 97777-6666",
      document_number: "987.654.321-00",
    };
    const paid = await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: buyer,
          sale_id: "S-PL2",
          charges: [{ id: "CH-PL2", amount: 227 }],
          // a recent purchase: the post-purchase flow takes it
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
        }),
      ),
    );
    assert.ok(paid.status < 300, JSON.stringify(paid.body));
    await runFlows(rpc, {});
    const state = async () =>
      (
        await sql!`select en.status, en.current_node from crm.flow_enrollments en join crm.flows f using (flow_id)
                    join crm.customers c using (customer_id)
                    where f.key = 'pl_stuck' and c.external_customer_id = 'cus_pl2'`
      )[0];
    assert.equal((await state())!["status"], "WAITING"); // stuck at "Aguardar entrega"
    // the stuck customer started waiting a while ago
    await sql!`update crm.flow_enrollments set wait_started_at = now() - interval '5 days', entered_at = now() - interval '5 days'
                where status = 'WAITING' and wait_fact = 'FULFILLMENT_DELIVERED'`;
    const before =
      await sql!`select count(*)::int as n from crm.flow_enrollments en join crm.flows f using (flow_id)
                               where f.key = 'pl_delivered'`;

    const resend = paylog("shipment.delivered", {
      order: {
        codigo_transacao: "S-PL2",
        customer: {
          nome: "João",
          cpf: "987.654.321-00",
          email: "joao@example.com",
          telefone: "(31) 97777-6666",
          endereco: {},
        },
      },
      shipment: {
        tracking_code: "BB222BR",
        occurred_at: null,
        tracking_status: { code: 70, label: "Entregue" },
      },
      // a batch resend is dated when it is sent: now
      root: { event_timestamp: new Date().toISOString() },
    });
    const r = await ingestWebhook(rpc, "paylog", JSON.stringify(resend), { backfill: true });
    assert.equal(r.body["status"], "PROCESSED", JSON.stringify(r.body));
    const s = await state();
    assert.equal(s!["status"], "ACTIVE");
    assert.equal(s!["current_node"], "after");
    // nobody new in "Entrega realizada"
    const afterCount =
      await sql!`select count(*)::int as n from crm.flow_enrollments en join crm.flows f using (flow_id)
                                   where f.key = 'pl_delivered'`;
    assert.equal(afterCount[0]!["n"], before[0]!["n"]);
  });

  test("V1 delivery (converted) is a live delivery: enters the delivery flow", async () => {
    const v1 = paylogV1ToV2(
      {
        dados: {
          pedido_id: 555,
          cpf_cliente: null,
          nome_cliente: "Carla",
          email_cliente: "carla@example.com",
          telefone_cliente: null,
          cod_transacao: "S-PLV1",
          plataforma: "B4You",
          cod_rastreio: "CC333BR",
          referencia_externa: null,
        },
      },
      "entregue",
      new Date().toISOString(),
    );
    const r = await ingestWebhook(rpc, "paylog", JSON.stringify(v1));
    assert.equal(r.body["status"], "PROCESSED", JSON.stringify(r.body));
    const [n] =
      await sql!`select count(*)::int as n from crm.flow_enrollments en join crm.flows f using (flow_id)
                            join crm.customers c using (customer_id)
                            where f.key = 'pl_delivered' and c.email = 'carla@example.com'`;
    assert.equal(n!["n"], 1);
    const again = await ingestWebhook(rpc, "paylog", JSON.stringify(v1));
    assert.equal(again.body["duplicate"], true);
  });

  test("an order event is stored and ignored", async () => {
    const r = await ingestWebhook(rpc, "paylog", JSON.stringify(paylog("order.created")));
    assert.equal(r.status, 200);
    assert.equal(r.body["status"], "IGNORED");
  });
});

describe("Paylog Webhook V1 (legacy)", () => {
  const delivered = {
    dados: {
      pedido_id: 12345,
      cpf_cliente: "123.456.789-09",
      nome_cliente: "Maria Souza",
      email_cliente: "maria.souza@example.com",
      telefone_cliente: "(11) 98888-7777",
      cod_transacao: "S-PL1",
      plataforma: "B4You",
      cod_rastreio: "AA123456789BR",
      referencia_externa: null,
    },
  };
  const tracking = {
    dados: { ...delivered.dados, transportadora: "CORREIOS" },
  };

  test("recognized, and the kind comes from the URL or the transportadora key", () => {
    assert.ok(isPaylogV1(delivered));
    assert.ok(!isPaylogV1(paylog("shipment.delivered")));
    assert.equal(paylogV1Kind(delivered, null), "entregue");
    assert.equal(paylogV1Kind(tracking, null), "rastreio");
    assert.equal(paylogV1Kind(tracking, "entregue"), "entregue");
    assert.equal(paylogV1Kind(delivered, "rastreio"), "rastreio");
  });

  test("Pedido entregue → DELIVERED at the time it arrived", () => {
    const v2 = paylogV1ToV2(delivered, "entregue", RECEIVED);
    assert.equal(v2.idempotency_key, "v1:entregue:12345:AA123456789BR");
    const n = normalizePaylog(v2, { receivedAt: RECEIVED });
    assert.ok(n.ok);
    assert.equal(n.event?.event_type, "TRACKING");
    assert.equal(n.event?.fulfillment?.status, "DELIVERED");
    assert.equal(n.event?.occurred_at, RECEIVED);
    assert.equal(n.event?.sale_id, "S-PL1");
    assert.equal(n.event?.customer.email, "maria.souza@example.com");
    assert.equal(n.event?.customer.address, null);
  });

  test("Código de rastreio recebido → FULFILLMENT_CREATED with the carrier", () => {
    const n = normalizePaylog(paylogV1ToV2(tracking, "rastreio", RECEIVED), {
      receivedAt: RECEIVED,
    });
    assert.equal(n.event?.fulfillment?.status, "FULFILLMENT_CREATED");
    assert.equal(n.event?.fulfillment?.carrier, "CORREIOS");
    assert.equal(
      n.event?.fulfillment?.tracking_url,
      "https://ev.paylog.cash/rastreio/AA123456789BR",
    );
  });
});
