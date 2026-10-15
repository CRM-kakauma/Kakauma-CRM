/** Order variables in messages ({{order_number}}, {{product_name}}…), from the B4you event behind the flow. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { runFlows } from "../../src/server/crm/messages.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async <T = unknown>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const now = new Date().toISOString();
const customer = {
  id: "cus_ov",
  full_name: "Olga Vars",
  email: "olga@example.com",
  whatsapp: "11977770001",
};

const SUMMARY = [
  "PEDIDO #{{order_number}}",
  "PRODUTO {{product_name}} ({{offer_name}})",
  "QUANTIDADE {{quantity}}",
  "PAGAMENTO {{payment_method}}",
  "TOTAL {{order_total}}",
  "DATA {{order_date}}",
  "CUPOM {{coupon_code}}",
  '<a href="https://kakauma.com.br/?utm_source=sms&utm_content={{USER_ID}}">Loja</a>',
].join("<br>");

describe("Order variables", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'ov_%')`;
    await sql!`delete from crm.flows where key like 'ov_%'`;
    await sql!`delete from crm.message_templates where key like 'ov_%'`;
    await sql!`update crm.flows set status = 'ARCHIVED' where status = 'ACTIVE'`;
    await sql!`update crm.automations set active = false`;
    await call("crm_upsert_template", {
      p_key: "ov_email",
      p_name: "Resumo do pedido",
      p_channel: "email",
      p_purpose: "transactional",
      p_content: { subject: "Pedido {{order_number}}", format: "html", html: SUMMARY, blocks: [] },
    });
    for (const [key, fact] of [
      ["ov_paid", "PURCHASE_PAID"],
      ["ov_cart", "CHECKOUT_ABANDONED"],
    ] as const) {
      await call("crm_save_flow", {
        p_key: key,
        p_name: key,
        p_trigger_fact: fact,
        p_graph: {
          nodes: [
            { id: "start", type: "trigger", config: {} },
            { id: "mail", type: "send", config: { template_key: "ov_email" } },
          ],
          edges: [{ source: "start", target: "mail", handle: "next" }],
        },
      });
      assert.equal(await call("crm_publish_flow", { p_key: key }), 1);
    }
  });
  after(async () => {
    await sql!`update crm.flows set status = 'ARCHIVED' where key like 'ov_%'`;
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  const rendered = async (flow: string) =>
    (
      await sql!`select m.rendered from crm.messages m join crm.flows f using (flow_id)
                  where f.key = ${flow} order by m.created_at desc limit 1`
    )[0]?.["rendered"] as { subject: string; html: string; text: string } | undefined;

  test("a purchase fills the order summary of the e-mail", async () => {
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("approved-payment", {
          customer,
          sale_id: "SALE-OV-1",
          payment_method: "credit_card",
          installments: 3,
          card: { brand: "visa", last_four: "4242" },
          coupon: { code: "BEMVINDO10", type: "percent", amount: 10 },
          offer: { id: "off_ov", name: "1 Lata - Kakauma", quantity: 2, original_price: 227 },
          created_at: now,
          updated_at: now,
          paid_at: now,
          charges: [{ id: "C-OV-1", amount: 1234.5 }],
        }),
      ),
    );
    await runFlows(rpc, {});
    const r = await rendered("ov_paid");
    assert.ok(r, "message rendered");
    assert.equal(r.subject, "Pedido SALE-OV-1");
    for (const part of [
      "PEDIDO #SALE-OV-1",
      "PRODUTO Sleep Drink (1 Lata - Kakauma)",
      "QUANTIDADE 2",
      "PAGAMENTO Cartão de crédito em 3x",
      "TOTAL R$ 1.234,50",
      "CUPOM BEMVINDO10",
    ])
      assert.ok(r.text.includes(part), `${part} in ${r.text}`);
    assert.match(r.text, /DATA \d\d\/\d\d\/\d{4}/);
    // store link: UTMs with the flow's and the message's names
    assert.match(
      r.html,
      /href="https:\/\/kakauma\.com\.br\/\?utm_source=email&amp;utm_medium=crm&amp;utm_campaign=ov_paid&amp;utm_content=resumo_do_pedido"/,
    );
  });

  test("an abandoned checkout brings its link and product, not an older order", async () => {
    await ingestWebhook(
      rpc,
      "b4you",
      JSON.stringify(
        b4("abandoned-cart", {
          customer,
          checkout_url: "https://checkout.example.com/ov",
          product: { id: "prod_sub", name: "Assinatura Sleep" },
          offer: { id: "off_sub", name: "Assinatura mensal", quantity: 1 },
          created_at: now,
          updated_at: now,
        }),
      ),
    );
    await sql!`update crm.messages set scheduled_for = now() where status = 'QUEUED'`;
    await sql!`update crm.flow_enrollments set next_run_at = now() where status = 'ACTIVE'`;
    await runFlows(rpc, {});
    const [{ n }] = (await sql!`select count(*)::int as n from crm.checkouts`) as unknown as [
      { n: number },
    ];
    assert.ok(n > 0, "checkout stored");
    const vars = await call<Record<string, unknown>>("crm_message_vars", {
      p_message_ids: (
        await sql!`select m.message_id from crm.messages m join crm.flows f using (flow_id) where f.key = 'ov_cart'`
      ).map((x) => x["message_id"]),
    });
    const v = (vars as unknown as { vars: Record<string, unknown> }[])[0]?.vars ?? {};
    assert.equal(v["checkout_url"], "https://checkout.example.com/ov");
    assert.equal(v["product_name"], "Assinatura Sleep");
    assert.equal(v["order_number"], undefined);
  });

  test("previews as a real customer show their latest order", async () => {
    const [c] =
      await sql!`select customer_id from crm.customers where external_customer_id = 'cus_ov'`;
    const v = await call<Record<string, unknown>>("crm_message_customer", {
      p_customer_id: c!["customer_id"],
    });
    assert.equal(v["first_name"], "Olga");
    assert.equal(v["order_number"], "SALE-OV-1");
    assert.equal(v["order_total"], "R$ 1.234,50");
  });
});
