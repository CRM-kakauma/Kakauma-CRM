/** Customers board (kanban) and dashboard time series. */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, type Rpc } from "../../src/server/crm/pipeline.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });
const call = async <T = any>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const person = (id: string, phone: string) => ({
  id: `cus_${id}`,
  full_name: `Pessoa ${id}`,
  email: `${id}@example.com`,
  whatsapp: phone,
});
const send = (p: object) => ingestWebhook(rpc, "b4you", JSON.stringify(p));
const paid = (cust: object, sale: string, amount: number, days: number) =>
  send(
    b4("approved-payment", {
      customer: cust,
      sale_id: sale,
      payment_method: "pix",
      created_at: ago(days),
      updated_at: ago(days),
      paid_at: ago(days),
      charges: [{ id: `C${sale}`, amount }],
    }),
  );

describe("CRM board and time series", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`update crm.automations set active = false`;
    await paid(person("b1", "11911110001"), "SB1", 600, 10);
    await paid(person("b2", "11911110002"), "SB2", 100, 40);
    await paid(person("b3", "11911110003"), "SB3", 200, 12);
    await send(b4("abandoned-cart", { customer: person("b4", "11911110004"), updated_at: ago(2) }));
  });
  after(async () => {
    await sql!`update crm.automations set active = true`;
    await sql?.end();
  });

  test("board groups customers into columns with full counts and limited cards", async () => {
    const tiers = await call<any[]>("crm_customer_board", { p_group: "value_tier" });
    const by = Object.fromEntries(tiers.map((c) => [String(c.key), c]));
    assert.equal(by["high"].count, 1); // 600 (>= 500)
    assert.equal(by["medium"].count, 1); // 200 (>= 150)
    assert.equal(by["low"].count, 1); // 100
    assert.equal(by["null"].count, 1); // never bought
    assert.equal(Number(by["high"].net_ltv), 600);

    const types = await call<any[]>("crm_customer_board", {
      p_group: "customer_type",
      p_per_column: 1,
    });
    const purchased = types.find((c) => c.key === "ONE_TIME_CUSTOMER");
    assert.equal(purchased.count, 3);
    assert.equal(purchased.cards.length, 1); // limited, count stays complete
    assert.equal(purchased.cards[0].full_name, "Pessoa b1"); // highest LTV first

    const recent = await call<any[]>("crm_customer_board", {
      p_group: "customer_type",
      p_sort: "recent",
      p_per_column: 3,
    });
    assert.deepEqual(
      recent.find((c) => c.key === "ONE_TIME_CUSTOMER").cards.map((c: any) => c.full_name),
      ["Pessoa b1", "Pessoa b3", "Pessoa b2"],
    );

    const filtered = await call<any[]>("crm_customer_board", { p_group: "risk", p_query: "b3" });
    assert.equal(
      filtered.reduce((a, c) => a + c.count, 0),
      1,
    );

    const bad = await rpc("crm_customer_board", { p_group: "senha" });
    assert.match(String(bad.error?.message), /unknown board group/);
  });

  test("time series has every bucket and the period totals", async () => {
    const from = new Date(Date.now() - 60 * DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    const days = await call<any[]>("crm_timeseries", { p_from: from, p_to: to, p_bucket: "day" });
    assert.ok(days.length >= 61 && days.length <= 63, `got ${days.length} days`);
    const sum = (k: string) => days.reduce((a, d) => a + Number(d[k]), 0);
    assert.equal(sum("gross_revenue"), 900);
    assert.equal(sum("net_revenue"), 900);
    assert.equal(sum("orders"), 3);
    assert.equal(sum("new_customers"), 3);
    assert.ok(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.bucket)));
    assert.equal(days.filter((d) => Number(d.gross_revenue) > 0).length, 3);

    const months = await call<any[]>("crm_timeseries", {
      p_from: from,
      p_to: to,
      p_bucket: "month",
    });
    assert.ok(months.length >= 2 && months.length <= 4);
    assert.equal(
      months.reduce((a, d) => a + Number(d.gross_revenue), 0),
      900,
    );

    const tooMany = await rpc("crm_timeseries", {
      p_from: "2020-01-01",
      p_to: to,
      p_bucket: "day",
    });
    assert.match(String(tooMany.error?.message), /too many points/);
  });
});
