/** Resultados → "Desde o início, o CRM trouxe": recovered, clicked, influenced (one bucket per order). */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
type Bucket = { orders: number; revenue: number };
type Impact = {
  since: string | null;
  store: Bucket;
  totals: Record<string, Bucket>;
  by_flow: { name: string; recovered: number; clicked: number; influenced: number }[];
  by_channel: { channel: string; recovered: number }[];
};

describe("O que o CRM trouxe", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`delete from crm.flow_versions where flow_id in (select flow_id from crm.flows where key like 'im_%')`;
    await sql!`delete from crm.flows where key like 'im_%'`;
    const [ev] =
      await sql!`insert into crm.events (source, idempotency_key, payload, payload_hash, schema_version)
                             values ('b4you', 'im-1', '{}', 'x', 'v1') returning id`;
    const raw = ev!["id"];
    const [cart] =
      await sql!`insert into crm.flows (key, name, trigger_fact) values ('im_cart', 'Carrinho abandonado', 'CHECKOUT_ABANDONED') returning flow_id`;
    const [post] =
      await sql!`insert into crm.flows (key, name, trigger_fact) values ('im_post', 'Pós-compra', 'PURCHASE_PAID') returning flow_id`;
    const cust = async (name: string) =>
      (
        await sql!`insert into crm.customers (full_name) values (${name}) returning customer_id`
      )[0]!["customer_id"];
    const rec = await cust("Recuperada");
    const clk = await cust("Clicou");
    const inf = await cust("Influenciada");
    const none = await cust("Sem CRM");
    await sql!`insert into crm.customer_events (dedupe_key, fact_type, customer_id, occurred_at, raw_event_id)
               values ('im-c1', 'CHECKOUT_ABANDONED', ${rec}, now() - interval '2 days', ${raw})`;
    await sql!`insert into crm.messages (customer_id, channel, template_key, status, executed_at, flow_id)
               values (${rec}, 'whatsapp', 'x', 'SENT', now() - interval '1 day', ${cart!["flow_id"]}),
                      (${inf}, 'sms', 'y', 'SENT', now() - interval '3 days', ${post!["flow_id"]})`;
    const [a] =
      await sql!`insert into crm.attributions (customer_id, raw_event_id, touch_type, occurred_at, utm_medium, utm_campaign, utm_source)
                            values (${clk}, ${raw}, 'touch', now(), 'crm', 'recompra', 'rcs') returning attribution_id`;
    await sql!`insert into crm.orders (sale_id, customer_id, gross_amount, status, paid_at, attribution_id) values
               ('IM-1', ${rec}, 297, 'PAID', now(), null),
               ('IM-2', ${clk}, 147, 'PAID', now(), ${a!["attribution_id"]}),
               ('IM-3', ${inf}, 227, 'PAID', now(), null),
               ('IM-4', ${none}, 500, 'PAID', now(), null),
               ('IM-5', ${rec}, 999, 'REFUNDED', now(), null)`;
  });
  after(async () => {
    await sql?.end();
  });

  test("each order in one bucket; refunds and orders without the CRM stay out", async () => {
    const { data, error } = await rpc("crm_impact", {});
    assert.equal(error, null, error?.message);
    const d = data as Impact;
    assert.ok(d.since);
    const t = (k: string) => [Number(d.totals[k]!.orders), Number(d.totals[k]!.revenue)];
    assert.deepEqual(t("recovered"), [1, 297]);
    assert.deepEqual(t("clicked"), [1, 147]);
    assert.deepEqual(t("influenced"), [1, 227]);
    assert.deepEqual([Number(d.store.orders), Number(d.store.revenue)], [4, 1171]);
    const flows = Object.fromEntries(d.by_flow.map((f) => [f.name, f]));
    assert.equal(Number(flows["Carrinho abandonado"]!.recovered), 297);
    assert.equal(Number(flows["recompra"]!.clicked), 147);
    assert.equal(Number(flows["Pós-compra"]!.influenced), 227);
    assert.deepEqual(d.by_channel.map((c) => c.channel).sort(), ["rcs", "sms", "whatsapp"]);
  });
});
