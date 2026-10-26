/** Repurchase: second purchase, within 30/60/90 days, LTV — upsell is not a repurchase, renewals optional. */
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
const call = async <T = unknown>(fn: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const person = (n: string) => ({
  id: `cus_rp_${n}`,
  full_name: `P ${n}`,
  email: `rp_${n}@example.com`,
});
const buy = async (
  n: string,
  sale: string,
  days: number,
  extra: Record<string, unknown> = {},
  event = "approved-payment",
) => {
  const r = await ingestWebhook(
    rpc,
    "b4you",
    JSON.stringify(
      b4(event, {
        customer: person(n),
        sale_id: sale,
        group_id: `G-${sale}`,
        payment_method: "pix",
        created_at: ago(days),
        updated_at: ago(days),
        paid_at: ago(days),
        charges: [{ id: `C-${sale}`, amount: 100 }],
        ...extra,
      }),
    ),
  );
  assert.ok(r.status < 300, JSON.stringify(r.body));
};

describe("Repurchase", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    // A: bought 120 days ago (+ an upsell in the same checkout), again 20 days later
    await buy("A", "A1", 120);
    await buy("A", "A1-up", 120, { type: "upsell", group_id: "G-A1" });
    await buy("A", "A2", 100);
    // B: bought 120 days ago and again 50 days later (repeat within 60/90, not 30)
    await buy("B", "B1", 120);
    await buy("B", "B2", 70);
    // C: bought once, 120 days ago (only an upsell in the same checkout)
    await buy("C", "C1", 120);
    await buy("C", "C1-up", 120, { type: "order-bump", group_id: "G-C1" });
    // D: bought 10 days ago: the 30-day window is not over
    await buy("D", "D1", 10);
    // E: subscriber, renewal 25 days after the first charge
    const sub = { id: "SUB-E", status: "active", frequency: "monthly" };
    await buy("E", "E1", 120, { subscription: { ...sub, next_charge: ago(90) } });
    await buy(
      "E",
      "E2",
      95,
      { subscription: { ...sub, next_charge: ago(65) } },
      "renewed-subscription",
    );
  });
  after(async () => {
    await sql?.end();
  });

  const total = async (renewals = false) =>
    (
      await call<{ rows: Record<string, unknown>[] }>("crm_repurchase", {
        p_dimension: "total",
        p_from: ago(365),
        p_to: ago(-1),
        p_include_renewals: renewals,
      })
    ).rows[0]!;

  test("upsell / order-bump are the same purchase; renewals are not a repurchase", async () => {
    const t = await total();
    assert.equal(t["customers"], 5);
    assert.equal(t["repeat_customers"], 2); // A and B; C's order-bump and E's renewal do not count
    assert.equal(Number(t["repeat_rate"]), 40);
    // 30/60/90 days: only customers whose first purchase is that old (D is not)
    assert.deepEqual(
      [t["base_30"], Number(t["repeat_30"]), Number(t["repeat_60"]), Number(t["repeat_90"])],
      [4, 25, 50, 50],
    );
    assert.equal(Number(t["median_days_to_second"]), 35);
  });

  test("renewals can be counted as a repurchase", async () => {
    const t = await total(true);
    assert.equal(t["repeat_customers"], 3);
    assert.equal(Number(t["repeat_30"]), 50); // A (20 days) and E (25 days) of 4
  });

  test("by month of the first purchase and by product; Cohorts uses the same rule", async () => {
    const r = await call<{ rows: Record<string, unknown>[] }>("crm_repurchase", {
      p_dimension: "first_purchase_month",
      p_from: ago(365),
      p_to: ago(-1),
    });
    assert.equal(
      r.rows.reduce((a, x) => a + Number(x["customers"]), 0),
      5,
    );
    const coh = await call<Record<string, unknown>[]>("crm_cohorts", {
      p_dimension: "source",
      p_from: ago(365),
      p_to: ago(-1),
    });
    assert.equal(Number(coh[0]!["repeat_rate"]), 40);
  });
});
