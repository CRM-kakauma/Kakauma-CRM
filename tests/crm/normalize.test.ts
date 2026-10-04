import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeB4you } from "../../src/server/crm/normalize/b4you.ts";
import { redactCardData } from "../../src/server/crm/redact.ts";
import { b4, FB_UTMS } from "./fixtures.ts";

const RECEIVED = "2026-09-01T12:00:00.000Z";
const ok = (raw: unknown) => {
  const r = normalizeB4you(raw, { receivedAt: RECEIVED });
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  return r.event;
};

test("revenue comes from charges[].amount, never offer.original_price", () => {
  const ev = ok(
    b4("approved-payment", {
      sale_id: "s1",
      payment_method: "pix",
      charges: [{ id: "ch1", amount: 252 }],
    }),
  );
  assert.equal(ev.event_type, "PAYMENT_APPROVED");
  assert.equal(ev.amount, 252);
  assert.equal(ev.offer?.original_price, 227);
  assert.equal(ev.charge_id, "ch1");
});

test("paid event without charges is rejected instead of using original_price", () => {
  const r = normalizeB4you(b4("approved-payment", { sale_id: "s1", payment_method: "pix" }), {
    receivedAt: RECEIVED,
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.code === "missing_amount"));
});

test("generated-pix is pending even when payload status says paid", () => {
  const ev = ok(
    b4("generated-pix", {
      sale_id: "s1",
      status: "paid",
      pix: { url: "https://pix", code: "000201" },
      charges: [{ id: "ch1", amount: 252 }],
    }),
  );
  assert.equal(ev.event_type, "PAYMENT_PENDING");
  assert.equal(ev.payment.method, "pix");
  assert.equal(ev.payment.pix_code, "000201");
});

test("event names are normalized (dots, underscores, case)", () => {
  assert.equal(
    ok(b4("subscription.expiring_soon", { subscription: { id: "sub1", status: "active" } }))
      .event_type,
    "SUBSCRIPTION_EXPIRING",
  );
  assert.equal(
    ok(b4("Canceled-Subscription", { subscription: { id: "sub1", status: "active" } })).event_type,
    "SUBSCRIPTION_CANCELED",
  );
  assert.equal(ok(b4("something-new", {})).event_type, "UNKNOWN");
});

test("subscription status is the provider-confirmed status, not the event name", () => {
  const ev = ok(b4("canceled-subscription", { subscription: { id: "sub1", status: "active" } }));
  assert.equal(ev.subscription?.status, "ACTIVE");
  const ev2 = ok(b4("canceled-subscription", { subscription: { id: "sub1", status: "canceled" } }));
  assert.equal(ev2.subscription?.status, "CANCELLED");
  const ev3 = ok(b4("canceled-subscription", { subscription: { id: "sub1", status: "weird" } }));
  assert.equal(ev3.subscription?.status, null);
  assert.ok(ev3.warnings.some((w) => w.code === "unknown_subscription_status"));
});

test("attribution keeps unknown params and splits funnel src", () => {
  const ev = ok(b4("abandoned-cart", { tracking_parameters: FB_UTMS }));
  assert.equal(ev.attribution["utm_source"], "facebook");
  assert.equal(ev.attribution["funnel_name"], "funil-1");
  assert.equal(ev.attribution["funnel_instance_id"], "2f6c1a9e-1111-2222-3333-444455556666");
  assert.deepEqual(ev.attribution.extra, { custom_param: "kept" });
});

test("payment methods are normalized; card keeps only brand and last four", () => {
  const ev = ok(
    b4("approved-payment", {
      sale_id: "s1",
      payment_method: "credit_card",
      card: [{ brand: "visa", number: "4111********1234" }],
      charges: [{ id: "c", amount: 10 }],
    }),
  );
  assert.equal(ev.payment.method, "card");
  assert.equal(ev.payment.card_brand, "visa");
  assert.equal(ev.payment.card_last_four, "1234");
  assert.equal(
    ok(b4("generated-billet", { sale_id: "s", payment_method: "billet" })).payment.method,
    "billet",
  );
});

test("splits are read from object and array forms", () => {
  const a = ok(
    b4("approved-payment", {
      sale_id: "s",
      payment_method: "pix",
      charges: [{ amount: 100 }],
      splits: { fee: 7.5, my_commission: 92.5, released: false, release_date: "2026-10-01" },
    }),
  );
  assert.equal(a.splits?.fee, 7.5);
  assert.equal(a.splits?.my_commission, 92.5);
  const b = ok(
    b4("approved-payment", {
      sale_id: "s",
      payment_method: "pix",
      charges: [{ amount: 100 }],
      splits: [
        { type: "producer", amount: 80 },
        { type: "affiliate", amount: 12 },
      ],
    }),
  );
  assert.equal(b.splits?.my_commission, 80);
  assert.equal(b.splits?.affiliate_commission, 12);
});

test("tracking maps carrier, code and cost", () => {
  const ev = ok(
    b4("tracking", {
      sale_id: "s1",
      tracking: { code: "ICNTOCXX", company: "Loggi", url: "https://t", status: "posted" },
      shipping: { cost: 25 },
    }),
  );
  assert.equal(ev.event_type, "TRACKING");
  assert.equal(ev.fulfillment?.carrier, "Loggi");
  assert.equal(ev.fulfillment?.tracking_code, "ICNTOCXX");
  assert.equal(ev.fulfillment?.shipping_cost, 25);
  assert.equal(ev.fulfillment?.status, "SHIPPED");
});

test("events without any customer identifier are invalid", () => {
  const r = normalizeB4you({ event_name: "abandoned-cart" }, { receivedAt: RECEIVED });
  assert.equal(r.ok, false);
});

test("card secrets are redacted before storage, everything else untouched", () => {
  const { payload, redacted } = redactCardData({
    a: 1,
    card: { number: "4111 1111 1111 1234", cvv: "123", brand: "visa" },
  });
  assert.deepEqual(payload, {
    a: 1,
    card: { number: "[REDACTED]", cvv: "[REDACTED]", brand: "visa" },
  });
  assert.deepEqual(redacted, ["card.number", "card.cvv"]);
  const clean = { a: 1, sale_id: "4111111111111234" };
  assert.equal(redactCardData(clean).payload, clean);
});
