/** Paylog API v1: delivered orders recovered as history free customers waiting for the delivery. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import { importBackfill } from "../../src/server/crm/backfill.ts";
import {
  deliveredOrderToPayload,
  fetchDeliveredPage,
  fetchDeliveryDate,
  paylogDate,
} from "../../src/server/crm/paylog-api.ts";
import { normalizePaylog } from "../../src/server/crm/normalize/paylog.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

type Obj = Record<string, unknown>;

/** An order as GET /api/v1/pedidos returns it (shape from the Paylog documentation). */
function apiOrder(extra: Obj = {}, cliente: Obj = {}): Obj {
  return {
    id: 64913,
    referencia_externa: null,
    codigo_transacao: "S-API1",
    status: "Entregue",
    status_code_id: 14,
    frete: 5781,
    data_saida: "2026-10-20T19:13:00-03:00",
    data_entrega: "2026-10-23 14:05:00",
    created_at: "2026-10-20 12:35:23",
    itens: [{ id: 1, quantidade: 2, valor_unitario: 12990, descricao: "Sleep Drink" }],
    cliente: {
      id: 291955,
      nome: "Ana Lima",
      email: "ana@example.com",
      cpf: "52998224725",
      endereco: "Avenida Paulista",
      cep: "01310100",
      numero: "1000",
      complemento: null,
      estado: "SP",
      bairro: "Bela Vista",
      cidade: "Sao Paulo",
      pais: "Brasil",
      celular: "11999887766",
      telefone: "1133221100",
      ...cliente,
    },
    transportadora: { codigo: "correios", nome: "Correios" },
    rastreamento: {
      codigo: "AD123456789BR",
      transportadora: { codigo: "correios", nome: "Correios" },
      servico: "SEDEX",
      url_rastreamento: "https://ev.paylog.cash/rastreio/AD123456789BR",
      status: { codigo: 70, descricao: "Entregue" },
      comprovante_entrega: { imagem_url: "https://cdn/x.jpg", recebido_por: "Porteiro" },
    },
    ...extra,
  };
}

const fakeFetch =
  (status: number, body: unknown, seen: string[] = []): typeof fetch =>
  async (url, init) => {
    seen.push(`${String(url)} ${(init?.headers as Record<string, string>)?.["authorization"]}`);
    return new Response(JSON.stringify(body), { status });
  };

describe("Paylog API mapping", () => {
  test("dates: Brasília local time, ISO, date only, empty", () => {
    assert.equal(paylogDate("2026-10-23 14:05:00"), "2026-10-23T17:05:00.000Z");
    assert.equal(paylogDate("2026-10-23T14:05:00-03:00"), "2026-10-23T17:05:00.000Z");
    assert.equal(paylogDate("2026-10-23"), "2026-10-23T15:00:00.000Z");
    assert.equal(paylogDate(null), null);
    assert.equal(paylogDate("ontem"), null);
  });

  test("a delivered order becomes the Webhook V2 delivery, with the real date", () => {
    const p = deliveredOrderToPayload(apiOrder())!;
    assert.equal(p["idempotency_key"], "api:delivered:64913");
    const n = normalizePaylog(p, { receivedAt: "2026-11-05T12:00:00Z" });
    assert.ok(n.ok);
    const e = n.event!;
    assert.equal(e.event_type, "TRACKING");
    assert.equal(e.occurred_at, "2026-10-23T17:05:00.000Z");
    assert.equal(e.sale_id, "S-API1");
    assert.equal(e.customer.email, "ana@example.com");
    assert.equal(e.customer.whatsapp, "11999887766"); // celular first
    assert.equal(e.customer.state, "SP");
    assert.equal(e.fulfillment?.status, "DELIVERED");
    assert.equal(e.fulfillment?.tracking_code, "AD123456789BR");
    assert.equal(e.fulfillment?.shipping_cost, 57.81);
  });

  test("no data_entrega: the date from the tracking timeline, else skipped", async () => {
    assert.equal(deliveredOrderToPayload(apiOrder({ data_entrega: null })), null);
    const timeline = {
      code: 200,
      pedido_id: 64913,
      rastreamento: {
        status: { codigo: 70, descricao: "Entregue" },
        eventos: [
          {
            ocorrido_em: "2026-10-21T10:00:00-03:00",
            status: { codigo: 30, descricao: "Em trânsito" },
          },
          {
            ocorrido_em: "2026-10-24T09:30:00-03:00",
            status: { codigo: 70, descricao: "Entregue" },
          },
        ],
      },
    };
    const seen: string[] = [];
    const at = await fetchDeliveryDate("tok", 64913, fakeFetch(200, timeline, seen));
    assert.equal(at, "2026-10-24T12:30:00.000Z");
    assert.match(seen[0]!, /\/api\/v1\/pedidos\/64913\/rastreamento Bearer tok$/);
    const p = deliveredOrderToPayload(apiOrder({ data_entrega: null }), at)!;
    assert.equal((p["shipment"] as Obj)["occurred_at"], "2026-10-24T12:30:00.000Z");
  });

  test("list call: status 14, oldest first, Bearer token; clear errors", async () => {
    const seen: string[] = [];
    const pg = await fetchDeliveredPage(
      "tok",
      2,
      fakeFetch(200, { current_page: 2, last_page: 3, data: [apiOrder()] }, seen),
    );
    assert.deepEqual([pg.page, pg.lastPage, pg.orders.length], [2, 3, 1]);
    assert.match(seen[0]!, /pedidos\?status=14&order=asc&page=2 Bearer tok$/);
    await assert.rejects(
      fetchDeliveredPage("x", 1, fakeFetch(401, { message: "Unauthenticated." })),
      /Token da Paylog/,
    );
    await assert.rejects(fetchDeliveredPage("x", 1, fakeFetch(403, {})), /listar_pedido_api/);
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
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

describe("Paylog API → stuck customers", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'pa_%')`;
    await sql!`delete from crm.flows where key like 'pa_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    const wait = (fact: string) => ({
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "env", type: "wait_event", config: { fact, timeout_hours: 720 } },
          { id: "after", type: "wait", config: { amount: 1, unit: "days" } },
        ],
        edges: [
          { source: "start", target: "env", handle: "next" },
          { source: "env", target: "after", handle: "event" },
        ],
      },
    });
    await call("crm_save_flow", {
      p_key: "pa_post",
      p_name: "Pós-compra",
      p_trigger_fact: "PURCHASE_PAID",
      ...wait("FULFILLMENT_DELIVERED"),
    });
    await call("crm_save_flow", {
      p_key: "pa_delivered",
      p_name: "Entrega realizada",
      p_trigger_fact: "FULFILLMENT_DELIVERED",
      p_max_trigger_age_hours: 24 * 400,
      ...wait("PURCHASE_PAID"),
    });
    await call("crm_publish_flow", { p_key: "pa_post" });
    await call("crm_publish_flow", { p_key: "pa_delivered" });
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'pa_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("delivered before the wait started (but after the purchase) frees the customer", async () => {
    const bought = daysAgo(6).toISOString();
    const paid = await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: {
            id: "cus_api1",
            full_name: "Ana Lima",
            email: "ana@example.com",
            whatsapp: "(11) 99988-7766",
            document_number: "529.982.247-25",
          },
          sale_id: "S-API1",
          charges: [{ id: "CH-API1", amount: 259.8 }],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
        }),
      ),
    );
    assert.ok(paid.status < 300, JSON.stringify(paid.body));
    await runFlows(rpc, {});
    // the customer bought 6 days ago and reached "Aguardar entrega" 2 days ago
    await sql!`update crm.flow_enrollments set entered_at = ${bought}, wait_started_at = now() - interval '2 days'
                where status = 'WAITING' and wait_fact = 'FULFILLMENT_DELIVERED'`;
    assert.equal(await call("crm_waiting_count", { p_fact: "FULFILLMENT_DELIVERED" }), 1);

    // delivered 4 days ago: after the purchase, before the wait started
    const order = apiOrder({ data_entrega: daysAgo(4).toISOString() });
    const payload = deliveredOrderToPayload(order)!;
    const r = await importBackfill(
      rpc,
      "paylog",
      [{ payload, received_at: daysAgo(4).toISOString() }],
      64913,
    );
    assert.deepEqual(r.counts, { importado: 1 }, JSON.stringify(r.errors));

    assert.equal(await call("crm_waiting_count", { p_fact: "FULFILLMENT_DELIVERED" }), 0);
    const [en] = await sql!`select en.status, en.current_node from crm.flow_enrollments en
                             join crm.flows f using (flow_id) where f.key = 'pa_post'`;
    assert.deepEqual([en!["status"], en!["current_node"]], ["ACTIVE", "after"]);
    // history: nobody enters "Entrega realizada"
    const [n] = await sql!`select count(*)::int as n from crm.flow_enrollments en
                            join crm.flows f using (flow_id) where f.key = 'pa_delivered'`;
    assert.equal(n!["n"], 0);
    // same customer (matched by e-mail / CPF), linked order, real delivery date
    const [c] = await sql!`select count(*)::int as n from crm.customers`;
    assert.equal(c!["n"], 1);
    const [fu] =
      await sql!`select order_id, delivered_at from crm.fulfillments where tracking_code = 'AD123456789BR'`;
    assert.ok(fu!["order_id"]);
    const delivered = (fu!["delivered_at"] as Date).getTime();
    assert.ok(Math.abs(delivered - daysAgo(4).getTime()) < 120_000, "the real delivery date");

    // running the recovery again stores nothing twice
    const again = await importBackfill(rpc, "paylog", [{ payload, received_at: null }], 64913);
    assert.deepEqual(again.counts, { "já existia": 1 });
  });

  test("a delivery from before the purchase does not free the wait", async () => {
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: { id: "cus_api2", full_name: "Bia", email: "bia@example.com" },
          sale_id: "S-API2",
          charges: [{ id: "CH-API2", amount: 100 }],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
        }),
      ),
    );
    await runFlows(rpc, {});
    const old = deliveredOrderToPayload(
      apiOrder(
        {
          id: 70000,
          codigo_transacao: "S-OLD",
          data_entrega: daysAgo(90).toISOString(),
          rastreamento: { codigo: "OLD1BR", status: { codigo: 70, descricao: "Entregue" } },
        },
        { email: "bia@example.com", cpf: null, celular: null, telefone: null },
      ),
    )!;
    await importBackfill(rpc, "paylog", [{ payload: old, received_at: null }], 70000);
    assert.equal(await call("crm_waiting_count", { p_fact: "FULFILLMENT_DELIVERED" }), 1);
  });
});
