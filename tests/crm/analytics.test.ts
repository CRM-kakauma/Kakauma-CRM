/**
 * Phase 4: analytics. A small, fully known dataset; every expected number is
 * derived by hand in the comments so the formulas are verified, not just run.
 *
 * Campaign camp_a (facebook): A1 abandons (100d), buys R$200 PIX (99d), rebuys R$100 card (10d, no UTM →
 *   inherited). A2 generates a PIX (50d) and never pays.
 * Campaign camp_b (instagram): B1 buys R$100 billet (80d), fully refunded (70d).
 * Campaign camp_s (google), monthly subscriptions of R$50 started 100d ago:
 *   S1 pays cycles at 100/70/40/10d → 4 cycles, active.
 *   S2 pays 100/70d, late at 38d, asks to cancel at 35d, cancelled at 30d.
 *   S3 pays 100d only, late at 68d, cancelled at 60d.
 */
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

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const FROM = ago(120);
const TO = ago(-1);
let n = 0;
const person = (name: string) => ({
  id: `cus_${name}`,
  full_name: name,
  email: `${name.toLowerCase()}@example.com`,
  whatsapp: `1197${String(++n).padStart(7, "0")}`,
});
const send = async (p: unknown) => {
  const r = await ingestWebhook(rpc, "b4you", JSON.stringify(p));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual((r.body as { status?: string }).status, "DEAD_LETTER", JSON.stringify(r.body));
};
const call = async <T = any>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await rpc(fn, args);
  assert.equal(error, null, error?.message);
  return data as T;
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const UTM = {
  a: { utm_source: "facebook", utm_campaign: "camp_a", utm_content: "cre_1" },
  b: { utm_source: "instagram", utm_campaign: "camp_b", utm_content: "cre_2" },
  s: { utm_source: "google", utm_campaign: "camp_s", utm_content: "cre_3" },
};

describe("CRM analytics (phase 4)", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`truncate crm.marketing_spend`;
    await sql!`update crm.automations set active = false`; // not under test here

    const a1 = person("A1");
    await send(
      b4("abandoned-cart", { customer: a1, updated_at: ago(100), tracking_parameters: UTM.a }),
    );
    await send(
      b4("approved-payment", {
        customer: a1,
        sale_id: "SA1",
        payment_method: "pix",
        created_at: ago(99),
        paid_at: ago(99),
        charges: [{ id: "CA1", amount: 200 }],
        tracking_parameters: UTM.a,
      }),
    );
    await send(
      b4("tracking", {
        customer: a1,
        sale_id: "SA1",
        created_at: ago(95),
        updated_at: ago(95),
        tracking: { code: "TA1", status: "delivered" },
      }),
    );
    await send(
      b4("approved-payment", {
        customer: a1,
        sale_id: "SA2",
        payment_method: "card",
        created_at: ago(10),
        paid_at: ago(10),
        charges: [{ id: "CA2", amount: 100 }],
      }),
    );

    const a2 = person("A2");
    await send(
      b4("generated-pix", {
        customer: a2,
        sale_id: "SA3",
        payment_method: "pix",
        created_at: ago(50),
        updated_at: ago(50),
        charges: [{ id: "CA3", amount: 200 }],
        tracking_parameters: UTM.a,
      }),
    );

    const b1 = person("B1");
    await send(
      b4("approved-payment", {
        customer: b1,
        sale_id: "SB1",
        payment_method: "billet",
        created_at: ago(80),
        paid_at: ago(80),
        charges: [{ id: "CB1", amount: 100 }],
        tracking_parameters: UTM.b,
      }),
    );
    await send(
      b4("refund", {
        customer: b1,
        sale_id: "SB1",
        updated_at: ago(70),
        charges: [{ id: "CB1", amount: 100 }],
      }),
    );

    const subs: [string, number[]][] = [
      ["S1", [100, 70, 40, 10]],
      ["S2", [100, 70]],
      ["S3", [100]],
    ];
    for (const [name, payments] of subs) {
      const p = person(name);
      const sub = { id: `SUB-${name}`, status: "active", frequency: "monthly" };
      for (const [i, d] of payments.entries()) {
        await send(
          b4(i === 0 ? "approved-payment" : "renewed-subscription", {
            customer: p,
            sale_id: `S-${name}-${i}`,
            payment_method: "card",
            created_at: ago(d),
            paid_at: ago(d),
            charges: [{ id: `C-${name}-${i}`, amount: 50 }],
            subscription: { ...sub, next_charge: ago(d - 30) },
            ...(i === 0 ? { tracking_parameters: UTM.s } : {}),
          }),
        );
      }
    }
    // Later subscription events identify the customer by e-mail only (identity resolution links them).
    const s2 = { email: "s2@example.com" };
    await send(
      b4("late-subscription", {
        customer: s2,
        updated_at: ago(38),
        subscription: { id: "SUB-S2", status: "active" },
      }),
    );
    await send(
      b4("canceled-subscription", {
        customer: s2,
        updated_at: ago(35),
        subscription: { id: "SUB-S2", status: "active" },
      }),
    );
    await send(
      b4("canceled-subscription", {
        customer: s2,
        updated_at: ago(30),
        subscription: { id: "SUB-S2", status: "canceled" },
      }),
    );
    await send(
      b4("late-subscription", {
        customer: { email: "s3@example.com" },
        updated_at: ago(68),
        subscription: { id: "SUB-S3", status: "active" },
      }),
    );
    await send(
      b4("canceled-subscription", {
        customer: { email: "s3@example.com" },
        updated_at: ago(60),
        subscription: { id: "SUB-S3", status: "canceled" },
      }),
    );

    await call("crm_import_marketing_spend", {
      p_rows: [
        {
          date: ago(60).slice(0, 10),
          source: "Facebook",
          campaign: "camp_a",
          creative: "cre_1",
          spend: 100,
          clicks: 40,
        },
        {
          date: ago(30).slice(0, 10),
          source: "facebook",
          campaign: "camp_a",
          creative: "cre_1",
          spend: 50,
          clicks: 20,
        },
      ],
    });
  });
  after(async () => {
    await sql`update crm.automations set active = true`;
    await sql?.end();
  });

  test("dataset sanity: 6 customers, 3 subscriptions", async () => {
    const r =
      await sql!`select (select count(*)::int from crm.customers) c, (select count(*)::int from crm.subscriptions) s`;
    assert.deepEqual([r[0]!["c"], r[0]!["s"]], [6, 3]);
  });

  test("dashboard: commerce", async () => {
    const d = await call("crm_dashboard", { p_from: FROM, p_to: TO });
    const c = d.commerce;
    // gross = 200+100 (A1) + 100 (B1) + 4×50 + 2×50 + 1×50 = 750; refunds 100; 10 paid charges
    assert.equal(num(c.gross_revenue), 750);
    assert.equal(num(c.refunds), 100);
    assert.equal(num(c.net_revenue), 650);
    assert.equal(num(c.aov), 75);
    assert.equal(c.orders, 10);
    assert.equal(num(c.refund_rate), 10); // 1 of 10 paid orders
    assert.equal(d.acquisition.customers_acquired, 5); // A2 never paid
    assert.equal(num(d.acquisition.spend), 150);
    assert.equal(num(d.acquisition.cac), 30);
  });

  test("dashboard: subscriptions (renewal, churn, late, recovery, cancellation)", async () => {
    const s = (await call("crm_dashboard", { p_from: FROM, p_to: TO })).subscription;
    assert.equal(s.active_subscribers, 1);
    assert.equal(s.new_subscribers, 3);
    assert.equal(s.renewals, 4); // S1: 3, S2: 1
    // renewals due & past grace: S1 at 70/40/10d (all paid), S2 at 70d (paid) and 40d (not), S3 at 70d (not) → 4/6
    assert.equal(s.renewals_due, 6);
    assert.equal(num(s.renewal_rate), 66.7);
    assert.equal(s.churned, 2);
    assert.equal(s.churn_rate, null); // no subscription existed before the period: no base, no invented rate
    assert.equal(s.late_payments, 2);
    assert.equal(num(s.late_rate), 66.7);
    assert.equal(num(s.recovery_rate), 0);
    assert.equal(num(s.churn_after_late_rate), 100);
    assert.equal(s.cancellation_requests, 1);
    assert.equal(num(s.cancellation_completion_rate), 100);
    assert.equal(num(s.save_rate), 0);
  });

  test("dashboard: fulfillment and customers", async () => {
    const d = await call("crm_dashboard", { p_from: FROM, p_to: TO });
    assert.equal(d.fulfillment.fulfillments, 1);
    assert.equal(d.fulfillment.delivered, 1);
    assert.equal(d.customer.customers, 5);
  });

  test("funnel and payment-method conversion", async () => {
    const f = await call("crm_funnel", { p_from: FROM, p_to: TO });
    assert.deepEqual(f.stages, {
      checkout_started: 6,
      cart_abandoned: 1,
      payment_initiated: 6,
      payment_approved: 5,
      delivered: 1,
    });
    assert.equal(num(f.cart_abandonment_rate), 0); // A1 abandoned but bought later
    assert.equal(num(f.payment_conversion), 83.3);
    assert.equal(num(f.pix_conversion), 50); // A1 paid, A2 did not
  });

  test("subscription retention C1→C12 only counts eligible subscriptions", async () => {
    const [r] = await call<any[]>("crm_retention", {
      p_dimension: "campaign",
      p_from: FROM,
      p_to: TO,
    });
    assert.equal(r.cohort, "camp_s");
    assert.equal(r.subscriptions, 3);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(r.cycles).map(([k, v]: [string, any]) => [
          k,
          v.rate === null ? null : Number(v.rate),
        ]),
      ),
      // C5 needs 121 days; started 100 days ago
      {
        c1: 100,
        c2: 66.7,
        c3: 33.3,
        c4: 33.3,
        c5: null,
        c6: null,
        c7: null,
        c8: null,
        c9: null,
        c10: null,
        c11: null,
        c12: null,
      },
    );
    assert.equal(num(r.steps.c1_c2.rate), 66.7);
    assert.equal(num(r.steps.c2_c3.rate), 50);
    assert.equal(num(r.steps.c3_c4.rate), 100);
    assert.equal(r.steps.c4_c5.rate, null);
    assert.equal(r.steps.c11_c12.rate, null);
    assert.equal(r.steps.c12_c13, undefined);
  });

  test("cohorts by campaign: LTV, refund rate, renewal", async () => {
    const rows = await call<any[]>("crm_cohorts", {
      p_dimension: "campaign",
      p_from: FROM,
      p_to: TO,
    });
    const by = Object.fromEntries(rows.map((r) => [r.cohort, r]));
    assert.equal(by["camp_a"].customers, 1);
    assert.equal(num(by["camp_a"].avg_net_ltv), 300);
    assert.equal(num(by["camp_b"].refund_rate), 100);
    assert.equal(num(by["camp_b"].avg_net_ltv), 0);
    assert.equal(by["camp_s"].subscriptions, 3);
    assert.equal(num(by["camp_s"].renewal_rate), 66.7);
    assert.equal(num(by["camp_s"].avg_net_ltv), 116.67); // (200 + 100 + 50) / 3
  });

  test("refund metrics by payment method", async () => {
    const rows = await call<any[]>("crm_refund_metrics", {
      p_dimension: "payment_method",
      p_from: FROM,
      p_to: TO,
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(num(by["billet"].refund_rate), 100);
    assert.equal(num(by["pix"].refund_rate), 0);
    assert.equal(by["card"].orders, 8);
  });

  test("campaign quality: CAC, LTV/CAC and quadrants; no spend → no CAC", async () => {
    const rows = await call<any[]>("crm_campaign_quality", {
      p_level: "campaign",
      p_from: FROM,
      p_to: TO,
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    const a = by["camp_a"];
    assert.equal(a.customers_acquired, 1);
    assert.equal(a.purchases, 2); // the rebuy without UTM inherits camp_a
    assert.equal(a.checkouts, 4); // 1 abandoned + 3 orders started (A1 ×2, A2)
    assert.equal(num(a.checkout_conversion), 50);
    assert.equal(num(a.cac), 150);
    assert.equal(num(a.ltv_cac), 2);
    assert.equal(a.clicks, 60);
    assert.equal(a.quadrant, "HIGH_SALES_HIGH_LTV");
    assert.equal(by["camp_b"].cac, null);
    assert.equal(by["camp_b"].quadrant, "HIGH_SALES_LOW_LTV");
    assert.equal(num(by["camp_b"].net_revenue), 0);
    assert.equal(by["camp_s"].subscriptions, 3);
    assert.equal(by["camp_s"].renewals, 4);
    assert.equal(by["camp_s"].churned_subscriptions, 2);
  });

  test("unknown dimensions are rejected", async () => {
    const { error } = await rpc("crm_cohorts", { p_dimension: "password", p_from: FROM, p_to: TO });
    assert.match(String(error?.message), /unknown dimension/);
  });
});
