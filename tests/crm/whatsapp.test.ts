/** WhatsApp Cloud API (Meta): approved template rendering, sending through flows, webhook statuses and PARAR. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import {
  handleWhatsappWebhook,
  verifyMetaSignature,
  whatsappError,
  whatsappPayload,
  whatsappSend,
  whatsappTemplates,
} from "../../src/server/crm/whatsapp.ts";
import { renderMessage, type WhatsappContent } from "../../src/lib/crm-messages.ts";
import { contentFromTemplate, type MetaTemplate } from "../../src/lib/crm-whatsapp.ts";
import { tagRendered } from "../../src/lib/crm-utm.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
function fakeFetch(responses: { status: number; body: unknown }[] = []) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift() ?? {
      status: 200,
      body: { messaging_product: "whatsapp", messages: [{ id: `wamid.${calls.length}` }] },
    };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const META: MetaTemplate = {
  name: "pedido_aprovado",
  language: "pt_BR",
  status: "APPROVED",
  category: "UTILITY",
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Oi {{1}}, seu pedido {{2}} foi aprovado!" },
    { type: "FOOTER", text: "Kakauma" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Ver pedido", url: "https://kakauma.com.br/{{1}}" },
        { type: "URL", text: "Loja", url: "https://kakauma.com.br/" },
        { type: "COPY_CODE", text: "Copiar código" },
        { type: "QUICK_REPLY", text: "Parar promoções" },
      ],
    },
  ],
};
const linked = (): WhatsappContent => {
  const c = contentFromTemplate(META);
  c.header = { type: "image", url: "https://cdn.example.com/a.png" };
  c.meta = {
    ...c.meta!,
    params: { "1": "{{first_name}}", "2": "{{order_number}}" },
    button_params: { "0": "conta/pedidos", "2": "VOLTA10" },
  };
  return c;
};
const utm = { channel: "whatsapp", campaign: "compra_aprovada", content: "pedido_aprovado" };

describe("WhatsApp approved templates", () => {
  test("a Meta template becomes the editor's content (texts, buttons, variables)", () => {
    const c = contentFromTemplate(META);
    assert.equal(c.category, "utility");
    assert.equal(c.body, META.components[1]!.text);
    assert.deepEqual(
      c.buttons!.map((b) => b.type),
      ["url", "url", "copy_code", "quick_reply"],
    );
    assert.deepEqual(c.meta!.params, { "1": "", "2": "" });
    // picking the same template again keeps what was filled
    const again = contentFromTemplate(META, linked());
    assert.equal(again.meta!.params!["1"], "{{first_name}}");
    assert.equal(again.header!.url, "https://cdn.example.com/a.png");
  });

  test("rendered with the customer's data; the request has template, parameters and UTMs", () => {
    const r = tagRendered(
      "whatsapp",
      renderMessage("whatsapp", linked(), { first_name: "Ana", order_number: "B4-77" }),
      utm,
    );
    assert.equal((r as { body: string }).body, "Oi Ana, seu pedido B4-77 foi aprovado!");
    const p = whatsappPayload("5511988887777", r, "msg-1") as any;
    assert.equal(p.type, "template");
    assert.equal(p.biz_opaque_callback_data, "msg-1");
    assert.deepEqual(p.template.language, { code: "pt_BR" });
    const comp = (t: string) => p.template.components.filter((c: any) => c.type === t);
    assert.deepEqual(comp("header")[0].parameters, [
      { type: "image", image: { link: "https://cdn.example.com/a.png" } },
    ]);
    assert.deepEqual(comp("body")[0].parameters, [
      { type: "text", text: "Ana" },
      { type: "text", text: "B4-77" },
    ]);
    const [url, code] = comp("button");
    assert.equal(url.index, "0");
    // only what comes after the template's fixed address, with the UTMs of the CRM
    assert.equal(
      url.parameters[0].text,
      "conta/pedidos?utm_source=whatsapp&utm_medium=crm&utm_campaign=compra_aprovada&utm_content=pedido_aprovado",
    );
    assert.deepEqual(code, {
      type: "button",
      sub_type: "copy_code",
      index: "2",
      parameters: [{ type: "coupon_code", coupon_code: "VOLTA10" }],
    });
    // the fixed link button cannot change: not tagged, no parameter
    assert.equal((r as any).buttons[1].url, "https://kakauma.com.br/");
  });

  test("named templates use parameter_name; empty values never go empty", () => {
    const c = contentFromTemplate({
      ...META,
      parameter_format: "NAMED",
      components: [{ type: "BODY", text: "Oi {{first_name}}! Cupom {{cupom}}" }],
    });
    assert.deepEqual(c.meta!.params, { first_name: "{{first_name}}", cupom: "{{cupom}}" });
    const p = whatsappPayload("55119", renderMessage("whatsapp", c, { first_name: "Bia" })) as any;
    assert.deepEqual(p.template.components[0].parameters, [
      { type: "text", parameter_name: "first_name", text: "Bia" },
      { type: "text", parameter_name: "cupom", text: "-" },
    ]);
  });

  test("without a template: free text (only inside the 24 h window)", () => {
    const p = whatsappPayload(
      "5511988887777",
      renderMessage(
        "whatsapp",
        {
          category: "marketing",
          header: { type: "none" },
          body: "Oi {{first_name}}",
          footer: "",
          buttons: [{ type: "url", text: "Loja", url: "https://kakauma.com.br/" }],
        },
        { first_name: "Ana" },
      ),
    ) as any;
    assert.equal(p.type, "text");
    assert.equal(p.text.body, "Oi Ana\n\nLoja: https://kakauma.com.br/");
  });

  test("errors in plain words; temporary ones are retried", async () => {
    const e = whatsappError(400, { error: { code: 131047, message: "Re-engagement" } });
    assert.match(e.error, /24h/);
    assert.equal(e.permanent, true);
    assert.equal(whatsappError(400, { error: { code: 130429 } }).permanent, false);
    assert.equal(whatsappError(500, { error: { code: 1 } }).permanent, false);
    const f = fakeFetch([{ status: 401, body: { error: { code: 190, message: "expired" } } }]);
    const r = await whatsappSend({ token: "t", phoneNumberId: "123", fetchImpl: f.impl }, "55", {});
    assert.equal(r.ok, false);
    assert.match(r.error!, /Token/);
  });

  test("templates are listed page by page", async () => {
    const f = fakeFetch([
      { status: 200, body: { data: [META], paging: { next: "x", cursors: { after: "C1" } } } },
      { status: 200, body: { data: [{ ...META, name: "outro" }] } },
    ]);
    const list = await whatsappTemplates({
      token: "t",
      phoneNumberId: "1",
      wabaId: "W9",
      fetchImpl: f.impl,
    });
    assert.deepEqual(
      list.map((t) => t.name),
      ["pedido_aprovado", "outro"],
    );
    assert.match(f.calls[0]!.url, /\/v23\.0\/W9\/message_templates\?/);
    assert.match(f.calls[1]!.url, /after=C1/);
    assert.equal(f.calls[0]!.headers["authorization"], "Bearer t");
  });

  test("webhook signature (X-Hub-Signature-256)", async () => {
    const raw = '{"entry":[]}';
    const sig = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;
    assert.equal(await verifyMetaSignature("app-secret", sig, raw), true);
    assert.equal(await verifyMetaSignature("app-secret", sig, raw + " "), false);
    assert.equal(await verifyMetaSignature("outro", sig, raw), false);
    assert.equal(await verifyMetaSignature("app-secret", null, raw), false);
  });
});

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async <T = unknown>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const hook = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "W9", changes: [{ field: "messages", value }] }],
});

describe("WhatsApp in the CRM", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.provider_events where provider = 'whatsapp'`;
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'wa_%')`;
    await sql!`delete from crm.flows where key like 'wa_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'wa_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("a linked message is checked against the template's variables", async () => {
    const c = linked();
    c.meta!.params = { "1": "{{first_name}}" }; // {{2}} missing
    c.meta!.button_params = {};
    const r = await rpc("crm_upsert_template", {
      p_key: "wa_bad",
      p_name: "Ruim",
      p_channel: "whatsapp",
      p_purpose: "transactional",
      p_content: c,
    });
    assert.ok(r.error, "refused");
    assert.match(r.error!.message, /\{\{2\}\}/);
    assert.match(r.error!.message, /final do link/);
  });

  test("the flow sends the template; statuses, read and PARAR come back by webhook", async () => {
    await call("crm_upsert_template", {
      p_key: "wa_pedido",
      p_name: "Pedido aprovado",
      p_channel: "whatsapp",
      p_purpose: "transactional",
      p_content: linked(),
    });
    await call("crm_save_flow", {
      p_key: "wa_flow",
      p_name: "Compra aprovada",
      p_trigger_fact: "PURCHASE_PAID",
      p_graph: {
        nodes: [
          { id: "start", type: "trigger", config: {} },
          { id: "m", type: "send", config: { template_key: "wa_pedido" } },
          { id: "d", type: "wait_delivery", config: { timeout_hours: 24 } },
        ],
        edges: [
          { source: "start", target: "m", handle: "next" },
          { source: "m", target: "d", handle: "next" },
        ],
      },
    });
    assert.equal(await call("crm_publish_flow", { p_key: "wa_flow" }), 1);
    const now = new Date().toISOString();
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer: {
            id: "cus_wa",
            full_name: "Wanda A",
            email: "wa@example.com",
            whatsapp: "(11) 97777-6666",
          },
          sale_id: "WA-1",
          payment_method: "pix",
          created_at: now,
          updated_at: now,
          paid_at: now,
          charges: [{ id: "CWA", amount: 80 }],
        }),
      ),
    );
    const f = fakeFetch();
    const cfg = { token: "tok", phoneNumberId: "PN1", fetchImpl: f.impl };
    // not live: simulation, nothing sent
    await runFlows(rpc, { whatsapp: { ...cfg, live: false } });
    let [m] =
      await sql!`select message_id, status from crm.messages where template_key = 'wa_pedido'`;
    assert.equal(m!["status"], "DRY_RUN");
    assert.equal(f.calls.length, 0);

    await sql!`update crm.messages set status = 'QUEUED', executed_at = null where message_id = ${m!["message_id"]}`;
    await runFlows(rpc, { whatsapp: { ...cfg, live: true } });
    [m] =
      await sql!`select message_id, status, recipient, result from crm.messages where template_key = 'wa_pedido'`;
    assert.equal(m!["status"], "SENT");
    assert.equal(m!["recipient"], "(11) 97777-6666");
    assert.equal((m!["result"] as any).wamid, "wamid.1");
    assert.match(f.calls[0]!.url, /\/PN1\/messages$/);
    assert.equal(f.calls[0]!.body.to, "5511977776666");
    assert.equal(f.calls[0]!.body.template.name, "pedido_aprovado");
    assert.equal(f.calls[0]!.body.biz_opaque_callback_data, m!["message_id"]);
    const bodyParams = f.calls[0]!.body.template.components.find((c: any) => c.type === "body");
    assert.equal(bodyParams.parameters[0].text, "Wanda");

    // read before delivered (out of order); "Aguardar entrega" continues as delivered
    const st = (status: string, extra: Record<string, unknown> = {}) =>
      handleWhatsappWebhook(
        rpc,
        hook({
          statuses: [
            {
              id: "wamid.1",
              status,
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: "5511977776666",
              ...extra,
            },
          ],
        }),
      );
    assert.equal((await st("read")).matched, true);
    await st("delivered");
    await st("read"); // repeated: ignored
    const [row] =
      await sql!`select provider_status, delivered_at, opened_at from crm.messages where message_id = ${m!["message_id"]}`;
    assert.equal(row!["provider_status"], "Read");
    assert.ok(row!["delivered_at"] && row!["opened_at"]);
    await call("crm_flow_tick", { p_limit: 50 });
    const [step] =
      await sql!`select st.outcome from crm.flow_steps st join crm.flow_enrollments e using (enrollment_id)
                  join crm.flows f using (flow_id) where f.key = 'wa_flow' and st.node_id = 'd' order by st.id desc limit 1`;
    assert.equal(step!["outcome"], "delivered");

    // the customer answers PARAR: opted out of WhatsApp only
    const r = await handleWhatsappWebhook(
      rpc,
      hook({
        messages: [
          { from: "5511977776666", id: "wamid.in1", type: "text", text: { body: " parar " } },
        ],
      }),
    );
    assert.equal((r.results[0] as any).optout, 1);
    const opts =
      await sql!`select o.channel from crm.channel_optouts o join crm.customers c using (customer_id)
                             where c.email = 'wa@example.com'`;
    assert.deepEqual(
      opts.map((o) => o["channel"]),
      ["whatsapp"],
    );
  });

  test("a failed status keeps Meta's reason", async () => {
    const [m] = await sql!`select message_id from crm.messages where template_key = 'wa_pedido'`;
    await sql!`update crm.messages set provider_status = null where message_id = ${m!["message_id"]}`;
    await handleWhatsappWebhook(
      rpc,
      hook({
        statuses: [
          {
            id: "x",
            biz_opaque_callback_data: m!["message_id"],
            status: "failed",
            errors: [{ code: 131026, title: "Message undeliverable" }],
          },
        ],
      }),
    );
    const [row] =
      await sql!`select provider_status, error from crm.messages where message_id = ${m!["message_id"]}`;
    assert.equal(row!["provider_status"], "Undelivered");
    assert.equal(row!["error"], "Message undeliverable (131026)");
  });
});
