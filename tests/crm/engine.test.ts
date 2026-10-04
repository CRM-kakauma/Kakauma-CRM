/**
 * Integration tests: real pipeline code (src/server/crm/pipeline.ts) against a
 * Postgres database with every migration applied.
 *
 *   CRM_TEST_DATABASE_URL=postgres://... node --test tests/crm/engine.test.ts
 *
 * Use scripts/crm-test-db.sh to create a disposable database. Skipped when the
 * variable is not set.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { ingestWebhook, processPending, type Rpc } from "../../src/server/crm/pipeline.ts";
import { b4, FB_UTMS } from "./fixtures.ts";
import { makeRpc, resetCrm, TEST_DB_URL } from "./db.ts";

const url = TEST_DB_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
const rpc: Rpc = sql
  ? makeRpc(sql)
  : async () => ({ data: null, error: { message: "no database" } });

const send = async (payload: unknown) => {
  const r = await ingestWebhook(
    rpc,
    "b4you",
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  return r.body as { ok: boolean; duplicate?: boolean; event_id?: string; status?: string };
};
const one = async <T = Record<string, unknown>>(q: string, ...v: unknown[]) =>
  (await sql!.unsafe(q, v as never[]))[0] as T;
const num = (v: unknown) => Number(v);

describe("CRM event engine", { skip: !sql && "CRM_TEST_DATABASE_URL not set" }, () => {
  before(async () => {
    await sql!.unsafe("set search_path = public, extensions");
    await resetCrm(sql!);
  });
  after(async () => {
    await sql?.end();
  });

  // ------------------------------------------------------------ one-time purchase journey

  test("abandoned cart: customer + checkout, no order, no revenue", async () => {
    const r = await send(
      b4("abandoned-cart", {
        customer: { email: "maria.souza@example.com", full_name: "Maria Souza" },
        tracking_parameters: FB_UTMS,
        checkout_url: "https://checkout/1",
      }),
    );
    assert.equal(r.status, "PROCESSED");
    const c = await one("select * from crm.customers where email = 'maria.souza@example.com'");
    assert.equal(c["current_customer_type"], "PROSPECT");
    assert.equal(c["acquisition_source"], "facebook");
    assert.equal(num((await one("select count(*) from crm.orders"))["count"]), 0);
    assert.equal(num((await one("select count(*) from crm.financial_events"))["count"]), 0);
    assert.equal((await one("select status from crm.checkouts"))["status"], "ABANDONED");
    const a = await one("select * from crm.attributions where touch_type = 'acquisition'");
    assert.equal(a["funnel_name"], "funil-1");
    assert.deepEqual(a["extra"], { custom_param: "kept" });
  });

  test("generated PIX with status=paid is still only pending (rule 10)", async () => {
    await send(
      b4("generated-pix", {
        sale_id: "S1",
        status: "paid",
        payment_method: "pix",
        pix: { url: "https://pix/1", code: "000201PIX" },
        charges: [{ id: "CH1", amount: 252 }],
      }),
    );
    // Same person (matched by email), now with the B4you customer id attached.
    assert.equal(num((await one("select count(*) from crm.customers"))["count"]), 1);
    const tx = await one("select * from crm.transactions where charge_id = 'CH1'");
    assert.equal(tx["status"], "PENDING");
    assert.equal(tx["pix_code"], "000201PIX");
    const fe = await sql!`select event_type from crm.financial_events`;
    assert.deepEqual(
      fe.map((x) => x["event_type"]),
      ["PAYMENT_PENDING"],
    );
    const c = await one("select * from crm.customers");
    assert.equal(c["external_customer_id"], "cus_100");
    assert.equal(num(c["total_gross_revenue"]), 0);
  });

  test("approved payment: revenue = charges.amount (252), not original_price (227)", async () => {
    const approved = b4("approved-payment", {
      sale_id: "S1",
      status: "paid",
      payment_method: "pix",
      paid_at: "2026-09-01T10:05:00.000Z",
      charges: [{ id: "CH1", amount: 252 }],
      splits: {
        fee: 17.64,
        my_commission: 234.36,
        released: false,
        release_date: "2026-10-01T00:00:00Z",
      },
    });
    const r = await send(approved);
    assert.equal(r.status, "PROCESSED");
    const o = await one("select * from crm.orders where sale_id = 'S1'");
    assert.equal(o["status"], "PAID");
    assert.equal(num(o["gross_amount"]), 252);
    const tx = await one("select * from crm.transactions where charge_id = 'CH1'");
    assert.equal(tx["status"], "PAID");
    assert.equal(num(tx["platform_fee"]), 17.64);
    const c = await one("select * from crm.customers");
    assert.equal(num(c["total_gross_revenue"]), 252);
    assert.equal(c["current_customer_type"], "ONE_TIME_CUSTOMER");
    assert.equal((await one("select status from crm.checkouts"))["status"], "CONVERTED");

    // Same webhook again → duplicate, nothing re-applied (rule 15).
    const dup = await send(approved);
    assert.equal(dup.duplicate, true);
    // Same fact with a different payload (e.g. updated_at changed) → stored, but no second revenue.
    const resend = await send({ ...approved, updated_at: "2026-09-01T11:00:00.000Z" });
    assert.equal(resend.duplicate, false);
    assert.equal(
      num(
        (
          await one(
            "select count(*) from crm.financial_events where event_type = 'PAYMENT_APPROVED'",
          )
        )["count"],
      ),
      1,
    );
    assert.equal(
      num((await one("select total_gross_revenue from crm.customers"))["total_gross_revenue"]),
      252,
    );
    assert.equal(num((await one("select count(*) from crm.orders"))["count"]), 1);
  });

  test("tracking creates fulfillment, never a purchase (rule 9)", async () => {
    await send(
      b4("tracking", {
        sale_id: "S1",
        updated_at: "2026-09-02T09:00:00.000Z",
        tracking: {
          code: "ICNTOCXX",
          company: "Loggi",
          url: "https://loggi/ICNTOCXX",
          status: "posted",
        },
        shipping: { cost: 25 },
      }),
    );
    const f = await one("select * from crm.fulfillments");
    assert.equal(f["carrier"], "Loggi");
    assert.equal(f["status"], "SHIPPED");
    assert.equal(num(f["shipping_cost"]), 25);
    assert.equal(num((await one("select count(*) from crm.orders"))["count"]), 1);
    assert.equal(
      num(
        (
          await one(
            "select count(*) from crm.financial_events where event_type in ('PAYMENT_APPROVED','RENEWAL_PAYMENT')",
          )
        )["count"],
      ),
      1,
    );
    assert.equal(
      num((await one("select total_shipping_cost from crm.customers"))["total_shipping_cost"]),
      25,
    );
  });

  test("refunds never delete the purchase; partial then full (rule 5)", async () => {
    await send(
      b4("refund", {
        sale_id: "S1",
        updated_at: "2026-09-05T10:00:00.000Z",
        charges: [{ id: "CH1", amount: 252 }],
        refund: { amount: 100, reason: "damaged" },
      }),
    );
    let o = await one("select * from crm.orders where sale_id = 'S1'");
    assert.equal(o["status"], "PARTIALLY_REFUNDED");
    assert.equal(num(o["gross_amount"]), 252);
    let c = await one("select * from crm.customers");
    assert.equal(num(c["total_net_revenue"]), 152);

    await send(
      b4("refund", {
        sale_id: "S1",
        updated_at: "2026-09-06T10:00:00.000Z",
        charges: [{ id: "CH1", amount: 252 }],
        refund: { amount: 152 },
      }),
    );
    o = await one("select * from crm.orders where sale_id = 'S1'");
    assert.equal(o["status"], "REFUNDED");
    c = await one("select * from crm.customers");
    assert.equal(num(c["total_gross_revenue"]), 252);
    assert.equal(num(c["total_refund_amount"]), 252);
    assert.equal(num(c["total_net_revenue"]), 0);
    const kinds = await sql!`select kind from crm.refunds order by created_at`;
    assert.deepEqual(
      kinds.map((k) => k["kind"]),
      ["PARTIAL_REFUND", "REFUND"],
    );
  });

  // ------------------------------------------------------------ subscription journey

  const SUB_CUSTOMER = {
    id: "cus_200",
    full_name: "João Lima",
    email: "joao@example.com",
    whatsapp: "11977776666",
  };
  const sub = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "SUB1",
    status,
    next_charge: "2026-10-01T00:00:00Z",
    plan: { id: "plan_m", name: "Mensal" },
    frequency: "monthly",
    ...extra,
  });
  const subState = () => one("select * from crm.subscriptions where subscription_id = 'SUB1'");

  test("first subscription payment creates subscription cycle 1", async () => {
    await send(
      b4("approved-payment", {
        customer: SUB_CUSTOMER,
        sale_id: "S2",
        payment_method: "card",
        card: { brand: "mastercard", last_four: "4444" },
        paid_at: "2026-09-01T12:00:00Z",
        charges: [{ id: "CH-A", amount: 187 }],
        subscription: sub("active"),
        tracking_parameters: { utm_source: "google", utm_campaign: "search_brand" },
      }),
    );
    const s = await subState();
    assert.equal(s["status"], "ACTIVE");
    assert.equal(s["current_cycle"], 1);
    assert.equal(num(s["total_revenue"]), 187);
    const c = await one("select * from crm.customers where external_customer_id = 'cus_200'");
    assert.equal(c["current_customer_type"], "SUBSCRIBER");
    assert.equal(
      (await one("select card_last_four from crm.transactions where charge_id = 'CH-A'"))[
        "card_last_four"
      ],
      "4444",
    );
  });

  test("expiring soon is not a cancellation (rule 8)", async () => {
    await send(
      b4("subscription.expiring_soon", {
        customer: SUB_CUSTOMER,
        updated_at: "2026-09-25T00:00:00Z",
        subscription: sub("active"),
      }),
    );
    const s = await subState();
    assert.equal(s["status"], "ACTIVE");
    assert.equal(s["lifecycle_state"], "EXPIRING");
    assert.ok(s["expiring_at"]);
  });

  test("renewal reuses the subscription, adds cycle 2, inherits attribution (rules 4, 11)", async () => {
    await send(
      b4("renewed-subscription", {
        customer: SUB_CUSTOMER,
        sale_id: "S3",
        payment_method: "card",
        paid_at: "2026-10-01T03:00:00Z",
        charges: [{ id: "CH-B", amount: 187 }],
        subscription: sub("active", { next_charge: "2026-11-01T00:00:00Z" }),
      }),
    );
    assert.equal(num((await one("select count(*) from crm.subscriptions"))["count"]), 1);
    const s = await subState();
    assert.equal(s["current_cycle"], 2);
    assert.equal(s["lifecycle_state"], "RENEWED");
    assert.equal(num(s["total_revenue"]), 374);
    const fe = await one("select event_type from crm.financial_events where charge_id = 'CH-B'");
    assert.equal(fe["event_type"], "RENEWAL_PAYMENT");
    const attr = await one("select touch_type from crm.attributions where sale_id = 'S3'");
    assert.equal(attr["touch_type"], "inherited");
    const c = await one("select * from crm.customers where external_customer_id = 'cus_200'");
    assert.equal(c["acquisition_source"], "google");
    assert.equal(num(c["total_renewal_revenue"]), 187);

    // approved-payment for the same renewal charge must not double the revenue.
    await send(
      b4("approved-payment", {
        customer: SUB_CUSTOMER,
        sale_id: "S3",
        payment_method: "card",
        paid_at: "2026-10-01T03:00:05Z",
        charges: [{ id: "CH-B", amount: 187 }],
        subscription: sub("active", { next_charge: "2026-11-01T00:00:00Z" }),
      }),
    );
    assert.equal(num((await subState())["total_revenue"]), 374);
    assert.equal(num((await one("select count(*) from crm.subscription_charges"))["count"]), 2);
  });

  test("late is not cancellation; next payment recovers (rules 7, 13)", async () => {
    await send(
      b4("late-subscription", {
        customer: SUB_CUSTOMER,
        updated_at: "2026-11-02T00:00:00Z",
        subscription: sub("active"),
      }),
    );
    let s = await subState();
    assert.equal(s["status"], "ACTIVE");
    assert.equal(s["payment_state"], "LATE");
    assert.equal(s["risk_state"], "AT_RISK");

    await send(
      b4("renewed-subscription", {
        customer: SUB_CUSTOMER,
        sale_id: "S4",
        payment_method: "card",
        paid_at: "2026-11-04T00:00:00Z",
        charges: [{ id: "CH-C", amount: 187 }],
        subscription: sub("active", { next_charge: "2026-12-01T00:00:00Z" }),
      }),
    );
    s = await subState();
    assert.equal(s["payment_state"], "RECOVERED");
    assert.equal(s["risk_state"], "HEALTHY");
    assert.equal(s["current_cycle"], 3);
    assert.ok(
      await one(
        "select 1 from crm.customer_events where fact_type = 'SUBSCRIPTION_PAYMENT_RECOVERED'",
      ),
    );
  });

  test("refund does not cancel the subscription (rule 6)", async () => {
    await send(
      b4("refund", {
        customer: SUB_CUSTOMER,
        sale_id: "S4",
        updated_at: "2026-11-05T00:00:00Z",
        charges: [{ id: "CH-C", amount: 187 }],
      }),
    );
    const s = await subState();
    assert.equal(s["status"], "ACTIVE");
    assert.equal(num(s["total_refunds"]), 187);
    assert.equal(num(s["net_revenue"]), 374);
  });

  test("canceled-subscription with status active = cancellation REQUEST (rules 13, 19)", async () => {
    await send(
      b4("canceled-subscription", {
        customer: SUB_CUSTOMER,
        updated_at: "2026-11-10T00:00:00Z",
        subscription: sub("active"),
      }),
    );
    const s = await subState();
    assert.equal(s["status"], "ACTIVE");
    assert.equal(s["cancellation_requested"], true);
    assert.equal(s["lifecycle_state"], "CANCELLATION_REQUESTED");
    assert.ok(
      await one(
        "select 1 from crm.customer_events where fact_type = 'SUBSCRIPTION_CANCELLATION_REQUESTED'",
      ),
    );
    assert.equal(
      await one("select 1 from crm.customer_events where fact_type = 'SUBSCRIPTION_CANCELLED'"),
      undefined,
    );
  });

  test("confirmed inactive status ends it; returning reactivates", async () => {
    await send(
      b4("canceled-subscription", {
        customer: SUB_CUSTOMER,
        updated_at: "2026-12-01T00:00:00Z",
        subscription: sub("canceled"),
      }),
    );
    let s = await subState();
    assert.equal(s["status"], "CANCELLED");
    assert.equal(s["lifecycle_state"], "CANCELLED");
    let c = await one("select * from crm.customers where external_customer_id = 'cus_200'");
    assert.equal(c["current_customer_type"], "FORMER_SUBSCRIBER");

    // An older event arriving late must not resurrect it.
    await send(
      b4("late-subscription", {
        customer: SUB_CUSTOMER,
        updated_at: "2026-11-20T00:00:00Z",
        subscription: sub("active"),
      }),
    );
    assert.equal((await subState())["status"], "CANCELLED");

    await send(
      b4("renewed-subscription", {
        customer: SUB_CUSTOMER,
        sale_id: "S5",
        payment_method: "pix",
        paid_at: "2027-01-10T00:00:00Z",
        charges: [{ id: "CH-D", amount: 187 }],
        subscription: sub("active", { next_charge: "2027-02-10T00:00:00Z" }),
      }),
    );
    s = await subState();
    assert.equal(s["status"], "REACTIVATED");
    c = await one("select * from crm.customers where external_customer_id = 'cus_200'");
    assert.equal(c["current_customer_type"], "REACTIVATED_CUSTOMER");
    const audit =
      await sql!`select field, old_value, new_value from crm.audit_logs where entity = 'subscriptions' and field = 'status' order by id`;
    assert.deepEqual(
      audit.map((a) => `${a["old_value"]}->${a["new_value"]}`),
      ["ACTIVE->CANCELLED", "CANCELLED->REACTIVATED"],
    );
  });

  // ------------------------------------------------------------ resilience, security, quality

  test("identity: event without customer.id resolves by whatsapp, no duplicate customer", async () => {
    const before = num((await one("select count(*) from crm.customers"))["count"]);
    await send(
      b4("abandoned-cart", {
        customer: { whatsapp: "+55 11 97777-6666" },
        updated_at: "2027-01-11T00:00:00Z",
      }),
    );
    assert.equal(num((await one("select count(*) from crm.customers"))["count"]), before);
  });

  test("invalid events go to the dead-letter queue; raw payload is kept", async () => {
    const bad = await send("{not json");
    assert.equal(bad.ok, false);
    assert.ok(await one("select 1 from crm.dead_letter_events where reason = 'invalid_json'"));

    const noAmount = await send(b4("approved-payment", { sale_id: "S9", payment_method: "pix" }));
    assert.equal(noAmount.status, "DEAD_LETTER");
    assert.equal(await one("select 1 from crm.orders where sale_id = 'S9'"), undefined);
    const raw = await one(
      "select payload, processing_error from crm.events where payload ->> 'sale_id' = 'S9'",
    );
    assert.match(String(raw["processing_error"]), /missing_amount/);

    const unknown = await send(b4("brand-new-event", { sale_id: "S10" }));
    assert.equal(unknown.status, "IGNORED");
  });

  test("card numbers and CVV are never stored", async () => {
    await send(
      b4("approved-payment", {
        customer: { id: "cus_300", email: "card@example.com" },
        sale_id: "S11",
        payment_method: "card",
        card: { brand: "visa", number: "4111111111111234", cvv: "999" },
        charges: [{ id: "CH-X", amount: 50 }],
      }),
    );
    const e = await one<{ payload: { card: Record<string, string> }; redacted_fields: string[] }>(
      "select payload, redacted_fields from crm.events where payload ->> 'sale_id' = 'S11'",
    );
    assert.equal(e.payload.card["number"], "[REDACTED]");
    assert.equal(e.payload.card["cvv"], "[REDACTED]");
    const dump = JSON.stringify(await sql!`select * from crm.transactions where sale_id = 'S11'`);
    assert.ok(!dump.includes("4111111111111234"));
  });

  test("raw events are append-only", async () => {
    await assert.rejects(sql!.unsafe("update crm.events set payload = '{}'::jsonb"), /immutable/);
    await assert.rejects(sql!.unsafe("delete from crm.events"), /append-only/);
  });

  test("failures retry with backoff, then dead-letter, and can be requeued", async () => {
    const id = (
      await one<{ id: string }>("select id from crm.events where payload ->> 'sale_id' = 'S10'")
    ).id;
    await sql!.unsafe("update crm.events set processing_status = 'PROCESSING' where id = $1", [id]);
    for (let i = 1; i <= 4; i++) {
      const { data } = await rpc("crm_fail_event", {
        p_raw_event_id: id,
        p_error: "db timeout",
        p_fatal: false,
      });
      assert.equal(data, "FAILED");
    }
    const { data } = await rpc("crm_fail_event", {
      p_raw_event_id: id,
      p_error: "db timeout",
      p_fatal: false,
    });
    assert.equal(data, "DEAD_LETTER");
    const { data: n } = await rpc("crm_requeue_dead_letters", { p_error_prefix: "db timeout" });
    assert.equal(n, 1);
    const res = await processPending(rpc, { id });
    assert.equal(res.results[0]?.status, "IGNORED");
  });

  test("private schema: anon/authenticated cannot read CRM data", async () => {
    await assert.rejects(
      sql!.begin(async (tx) => {
        await tx.unsafe("set local role anon");
        await tx.unsafe("select * from crm.customers");
      }),
      /permission denied/,
    );
    await assert.rejects(
      sql!.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        await tx.unsafe("select public.crm_ingest_event('b4you', 'x', null, '{}'::jsonb)");
      }),
      /permission denied/,
    );
  });

  test("processing logs are written for every attempt", async () => {
    const n = num((await one("select count(*) from crm.event_processing_logs"))["count"]);
    const events = num((await one("select count(*) from crm.events"))["count"]);
    assert.ok(n >= events, `${n} logs for ${events} events`);
  });
});
