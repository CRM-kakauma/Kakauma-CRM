/**
 * Phase 2: state engine — lifecycle, risk, subscription quality, LTV,
 * customer experience and Customer 360. Dates are relative to now because
 * several states are time-based.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, refreshCustomers, type Rpc } from "../../src/server/crm/pipeline.ts";
import { b4 } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const sql = TEST_DB_URL ? postgres(TEST_DB_URL, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const send = async (p: unknown) => {
  const r = await ingestWebhook(rpc, "b4you", JSON.stringify(p));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const customer = async (externalId: string) =>
  (await sql!`select * from crm.customers where external_customer_id = ${externalId}`)[0]!;
const sub = async (id: string) =>
  (await sql!`select * from crm.subscriptions where subscription_id = ${id}`)[0]!;

// Every test customer gets a distinct phone (a shared phone would correctly merge them into one person).
const phones = new Map<string, string>();
function person(id: string) {
  if (!phones.has(id)) phones.set(id, `11990${String(phones.size + 1).padStart(6, "0")}`);
  return {
    id,
    full_name: `Cliente ${id}`,
    email: `${id.toLowerCase()}@example.com`,
    whatsapp: phones.get(id)!,
  };
}
function paid(
  cust: object,
  sale: string,
  charge: string,
  amount: number,
  paidDaysAgo: number,
  extra: object = {},
) {
  return b4("approved-payment", {
    customer: cust,
    sale_id: sale,
    payment_method: "pix",
    created_at: ago(paidDaysAgo),
    updated_at: ago(paidDaysAgo),
    paid_at: ago(paidDaysAgo),
    charges: [{ id: charge, amount }],
    ...extra,
  });
}

describe("CRM state engine (phase 2)", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await resetCrm(sql!);
    await sql!`update crm.settings set value = '90' where key = 'activity_window_days'`;
  });
  after(() => sql?.end());

  test("commerce lifecycle: checkout → purchased → delivering → delivered → repeat", async () => {
    const p = person("L1");
    await send(b4("abandoned-cart", { customer: p, updated_at: ago(10) }));
    let c = await customer("L1");
    assert.equal(c["current_lifecycle_stage"], "CHECKOUT_STARTED");
    assert.equal(c["current_risk_state"], null);

    await send(paid(p, "SL1", "CL1", 100, 9));
    c = await customer("L1");
    assert.equal(c["current_lifecycle_stage"], "PURCHASED");
    assert.equal(c["current_risk_state"], "HEALTHY");

    await send(
      b4("tracking", {
        customer: p,
        sale_id: "SL1",
        updated_at: ago(8),
        tracking: { code: "T-L1", company: "Loggi", status: "in transit" },
        shipping: { cost: 20 },
      }),
    );
    assert.equal((await customer("L1"))["current_lifecycle_stage"], "DELIVERING");

    await send(
      b4("tracking", {
        customer: p,
        sale_id: "SL1",
        updated_at: ago(5),
        tracking: { code: "T-L1", status: "delivered", delivered_at: ago(5) },
      }),
    );
    assert.equal((await customer("L1"))["current_lifecycle_stage"], "DELIVERED");

    await send(paid(p, "SL2", "CL2", 100, 1));
    c = await customer("L1");
    assert.equal(c["current_lifecycle_stage"], "REPEAT_CUSTOMER");

    const changes =
      await sql!`select data from crm.customer_events where customer_id = ${c["customer_id"]} and fact_type = 'LIFECYCLE_CHANGED' order by created_at`;
    assert.deepEqual(
      changes.map((x) => x["data"]["to"]),
      ["CHECKOUT_STARTED", "PURCHASED", "DELIVERING", "DELIVERED", "REPEAT_CUSTOMER"],
    );
  });

  test("time-based: inactivity → CHURN_RISK → CHURNED (high value escalates)", async () => {
    await send(paid(person("T1"), "ST1", "CT1", 120, 100));
    let c = await customer("T1");
    assert.equal(c["current_risk_state"], "CHURN_RISK");
    assert.equal(c["current_customer_type"], "ONE_TIME_CUSTOMER");

    await send(paid(person("T2"), "ST2", "CT2", 600, 200));
    c = await customer("T2");
    assert.equal(c["current_lifecycle_stage"], "CHURNED");
    assert.equal(c["current_customer_type"], "CHURNED_CUSTOMER");
    assert.equal(c["current_risk_state"], "HIGH_VALUE_AT_RISK");
  });

  test("thresholds come from settings and the periodic refresh applies them", async () => {
    await sql!`update crm.settings set value = '120' where key = 'activity_window_days'`;
    await sql!`update crm.customers set state_refreshed_at = now() - interval '1 day'`;
    const n = await refreshCustomers(rpc, 500);
    assert.ok(n >= 3);
    assert.equal((await customer("T1"))["current_risk_state"], "HEALTHY");
    await sql!`update crm.settings set value = '90' where key = 'activity_window_days'`;
  });

  test("subscriber lifecycle, DUE inference, late, recovery and quality score", async () => {
    const p = person("S1");
    const s = (extra: object = {}) => ({
      id: "SUB-S1",
      status: "active",
      plan: { name: "Mensal" },
      ...extra,
    });

    await send(paid(p, "SS1", "CS1", 150, 5, { subscription: s({ next_charge: ago(-25) }) }));
    let c = await customer("S1");
    assert.equal(c["current_lifecycle_stage"], "NEW_SUBSCRIBER");
    let st = await sub("SUB-S1");
    assert.equal(st["quality_score"], 58); // base 50 + 1 paid cycle × 8
    assert.equal(st["quality_class"], "MEDIUM_QUALITY");

    // The charge date passed with no payment: DUE (inferred), not late/cancelled.
    await sql!`update crm.subscriptions set next_charge_at = now() - interval '3 days' where subscription_id = 'SUB-S1'`;
    await sql!`update crm.customers set state_refreshed_at = null where external_customer_id = 'S1'`;
    await refreshCustomers(rpc, 500);
    st = await sub("SUB-S1");
    assert.equal(st["payment_state"], "DUE");
    assert.equal(st["status"], "ACTIVE");
    assert.equal(st["risk_state"], "AT_RISK");

    await send(b4("late-subscription", { customer: p, updated_at: ago(2), subscription: s() }));
    c = await customer("S1");
    assert.equal(c["current_lifecycle_stage"], "LATE");
    assert.equal(c["current_risk_state"], "AT_RISK");

    await send(
      b4("renewed-subscription", {
        customer: p,
        sale_id: "SS2",
        payment_method: "pix",
        paid_at: ago(1),
        charges: [{ id: "CS2", amount: 150 }],
        subscription: s({ next_charge: ago(-29) }),
      }),
    );
    c = await customer("S1");
    assert.equal(c["current_lifecycle_stage"], "RECOVERED");
    assert.equal(c["current_risk_state"], "HEALTHY");
    st = await sub("SUB-S1");
    // 50 + 2 cycles × 8 − 1 late × 10
    assert.equal(st["quality_score"], 56);
    assert.deepEqual(
      { cycles: st["quality_factors"]["cycles_paid"], late: st["quality_factors"]["late_events"] },
      { cycles: 2, late: 1 },
    );
  });

  test("high-value subscriber at risk is HIGH_VALUE_AT_RISK; cancellation request is CHURN_RISK", async () => {
    const p = person("H1");
    const s = { id: "SUB-H1", status: "active", plan: { name: "Trimestral" } };
    await send(paid(p, "SH1", "CH1", 300, 60, { subscription: { ...s, next_charge: ago(-30) } }));
    await send(
      b4("renewed-subscription", {
        customer: p,
        sale_id: "SH2",
        payment_method: "card",
        paid_at: ago(30),
        charges: [{ id: "CH2", amount: 300 }],
        subscription: { ...s, next_charge: ago(-60) },
      }),
    );
    await send(b4("late-subscription", { customer: p, updated_at: ago(3), subscription: s }));
    let st = await sub("SUB-H1");
    assert.equal(st["risk_state"], "HIGH_VALUE_AT_RISK");
    assert.equal(st["quality_class"], "HIGH_VALUE_AT_RISK");
    assert.equal((await customer("H1"))["current_risk_state"], "HIGH_VALUE_AT_RISK");

    const p2 = person("H2");
    await send(
      paid(p2, "SH3", "CH3", 100, 20, {
        subscription: { id: "SUB-H2", status: "active", next_charge: ago(-10) },
      }),
    );
    await send(
      b4("canceled-subscription", {
        customer: p2,
        updated_at: ago(1),
        subscription: { id: "SUB-H2", status: "active" },
      }),
    );
    st = await sub("SUB-H2");
    assert.equal(st["risk_state"], "CHURN_RISK");
    assert.equal((await customer("H2"))["current_lifecycle_stage"], "CANCELLATION_REQUESTED");
  });

  test("loyal subscriber without incidents scores HIGH_QUALITY", async () => {
    const p = person("Q1");
    const s = { id: "SUB-Q1", status: "active" };
    for (let i = 0; i < 5; i++) {
      const ev = i === 0 ? "approved-payment" : "renewed-subscription";
      await send(
        b4(ev, {
          customer: p,
          sale_id: `SQ${i}`,
          payment_method: "card",
          paid_at: ago(150 - i * 30),
          charges: [{ id: `CQ${i}`, amount: 80 }],
          subscription: { ...s, next_charge: ago(-10) },
        }),
      );
    }
    const st = await sub("SUB-Q1");
    assert.equal(st["current_cycle"], 5);
    assert.equal(st["quality_score"], 90);
    assert.equal(st["quality_class"], "HIGH_QUALITY");
  });

  test("LTV: gross, net and contribution (fees, shipping, commissions)", async () => {
    const p = person("V1");
    await send(
      paid(p, "SV1", "CV1", 200, 10, {
        splits: [
          { type: "platform", amount: 14 },
          { type: "affiliate", amount: 30 },
          { type: "producer", amount: 156 },
        ],
        affiliate: { email: "afiliado@example.com", full_name: "Afiliado X" },
        tracking_parameters: {
          utm_source: "instagram",
          utm_campaign: "reels_1",
          utm_content: "video_a",
        },
      }),
    );
    await send(
      b4("tracking", {
        customer: p,
        sale_id: "SV1",
        updated_at: ago(9),
        tracking: { code: "T-V1", status: "lost" },
        shipping: { cost: 25 },
      }),
    );
    await send(
      b4("refund", {
        customer: p,
        sale_id: "SV1",
        updated_at: ago(2),
        charges: [{ id: "CV1", amount: 200 }],
        refund: { amount: 50 },
      }),
    );
    const c = await customer("V1");
    assert.equal(Number(c["gross_ltv"]), 200);
    assert.equal(Number(c["net_ltv"]), 150);
    assert.equal(Number(c["contribution_ltv"]), 150 - 14 - 25 - 30);
    assert.equal(c["current_risk_state"], "AT_RISK"); // recent refund + lost delivery
  });

  test("Customer 360 answers who, how, what, how much, delivered, risk", async () => {
    const id = (await customer("V1"))["customer_id"] as string;
    const { data, error } = await rpc("crm_customer_360", { p_customer_id: id });
    assert.equal(error, null);
    const c = data as Record<string, any>;
    assert.equal(c["identity"]["email"], "v1@example.com");
    assert.equal(c["acquisition"]["source"], "instagram");
    assert.equal(c["acquisition"]["creative"], "video_a");
    assert.equal(c["acquisition"]["affiliate"]["name"], "Afiliado X");
    assert.equal(c["commerce"]["orders"].length, 1);
    assert.equal(Number(c["financial"]["net_ltv"]), 150);
    assert.equal(c["logistics"][0]["status"], "DELIVERY_LOST");
    assert.equal(c["experience"]["delivery_failures"], 1);
    assert.equal(c["experience"]["refunds"], 1);
    assert.equal(c["crm"]["risk"], "AT_RISK");
    assert.ok(c["timeline"].some((e: { type: string }) => e.type === "REFUND_ISSUED"));

    const sub360 = (
      await rpc("crm_customer_360", { p_customer_id: (await customer("Q1"))["customer_id"] })
    ).data as Record<string, any>;
    assert.equal(sub360["subscriptions"][0]["charges"].length, 5);
    assert.equal(sub360["subscriptions"][0]["quality_class"], "HIGH_QUALITY");
  });

  test("customer search by text, phone and state", async () => {
    const byEmail = (await rpc("crm_search_customers", { p_query: "h1@example.com" })).data as {
      email: string;
    }[];
    assert.deepEqual(
      byEmail.map((r) => r.email),
      ["h1@example.com"],
    );
    const h1Phone = person("H1").whatsapp; // e.g. 11990000005
    const formatted = `(${h1Phone.slice(0, 2)}) ${h1Phone.slice(2, 7)}-${h1Phone.slice(7)}`;
    const byPhone = (await rpc("crm_search_customers", { p_query: formatted })).data as {
      email: string;
    }[];
    assert.deepEqual(
      byPhone.map((r) => r.email),
      ["h1@example.com"],
    );
    const atRisk = (await rpc("crm_search_customers", { p_risk: "HIGH_VALUE_AT_RISK" })).data as {
      email: string;
    }[];
    assert.ok(atRisk.some((r) => r.email === "h1@example.com"));
  });
});
