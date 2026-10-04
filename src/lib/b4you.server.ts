import type { EventType } from "@/lib/events";

/**
 * Adapter for B4you native webhooks.
 * B4you posts its own payload shape (event_name + sale_id + customer + charges),
 * so we translate it into the canonical event payload consumed by ingestEvent().
 */

const EVENT_NAME_MAP: Record<string, EventType> = {
  "approved-payment": "PURCHASE_APPROVED",
  "payment-approved": "PURCHASE_APPROVED",
  "paid": "PURCHASE_APPROVED",
  "declined-payment": "PURCHASE_DECLINED",
  "refused-payment": "PURCHASE_DECLINED",
  "payment-refused": "PURCHASE_DECLINED",
  "canceled-payment": "PURCHASE_DECLINED",
  "refund": "REFUND",
  "refunded": "REFUND",
  "chargeback": "CHARGEBACK",
  "abandoned-cart": "CART_ABANDONED",
  "cart-abandoned": "CART_ABANDONED",
  "abandoned-checkout": "CART_ABANDONED",
  "pix-generated": "PIX_GENERATED",
  "generated-pix": "PIX_GENERATED",
  "pix-expired": "PIX_EXPIRED",
  "expired-pix": "PIX_EXPIRED",
  "billet-generated": "BOLETO_GENERATED",
  "generated-billet": "BOLETO_GENERATED",
  "boleto-generated": "BOLETO_GENERATED",
  "tracking-created": "TRACKING_CREATED",
  "created-tracking": "TRACKING_CREATED",
  "subscription-renewed": "SUBSCRIPTION_RENEWED",
  "renewed-subscription": "SUBSCRIPTION_RENEWED",
  "subscription-canceled": "SUBSCRIPTION_CANCELLED",
  "subscription-cancelled": "SUBSCRIPTION_CANCELLED",
  "canceled-subscription": "SUBSCRIPTION_CANCELLED",
  "subscription-overdue": "SUBSCRIPTION_OVERDUE",
  "overdue-subscription": "SUBSCRIPTION_OVERDUE",
  "subscription-expiring": "SUBSCRIPTION_EXPIRING",
  "expiring-subscription": "SUBSCRIPTION_EXPIRING",
  "affiliation-requested": "AFFILIATION_REQUESTED",
  "affiliation-approved": "AFFILIATION_APPROVED",
  "affiliation-declined": "AFFILIATION_DECLINED",
};

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function isB4youPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return typeof o["event_name"] === "string" && ("sale_id" in o || "customer" in o || "charges" in o);
}

function methodFrom(o: Record<string, unknown>, eventType: EventType): string | null {
  const pm = typeof o["payment_method"] === "string" ? norm(o["payment_method"] as string) : null;
  if (pm === "card" || pm === "credit-card" || pm === "creditcard") return "card";
  if (pm === "pix") return "pix";
  if (pm === "billet" || pm === "boleto" || pm === "bank-slip") return "boleto";
  if (o["pix"]) return "pix";
  if (o["billet"]) return "boleto";
  if (Array.isArray(o["card"]) && (o["card"] as unknown[]).length > 0) return "card";
  if (eventType === "PIX_GENERATED" || eventType === "PIX_EXPIRED") return "pix";
  if (eventType === "BOLETO_GENERATED") return "boleto";
  return null;
}

function pickAmount(o: Record<string, unknown>): number | null {
  const charges = o["charges"];
  if (Array.isArray(charges) && charges.length > 0) {
    const last = charges[charges.length - 1] as Record<string, unknown>;
    if (typeof last["amount"] === "number") return last["amount"];
  }
  const splits = o["splits"] as Record<string, unknown> | undefined;
  if (splits && typeof splits["base_price"] === "number") return splits["base_price"] as number;
  const offer = o["offer"] as Record<string, unknown> | undefined;
  if (offer && typeof offer["original_price"] === "number") return offer["original_price"] as number;
  return null;
}

interface SplitInfo {
  amount: number | null;
  email: string | null;
  release_date: string | null;
}

const EMPTY_SPLIT: SplitInfo = { amount: null, email: null, release_date: null };

/** Split entry of a given type ("producer", "affiliate", ...) from the B4you splits array. */
function pickSplit(o: Record<string, unknown>, type: string): SplitInfo {
  const splits = o["splits"];
  if (!Array.isArray(splits)) return EMPTY_SPLIT;
  const entry = splits.find(
    (s) => s && typeof s === "object" && (s as Record<string, unknown>)["type"] === type,
  ) as Record<string, unknown> | undefined;
  if (!entry) return EMPTY_SPLIT;
  return {
    amount: typeof entry["amount"] === "number" ? entry["amount"] : null,
    email: typeof entry["email"] === "string" ? entry["email"] : null,
    release_date: typeof entry["release_date"] === "string" ? entry["release_date"] : null,
  };
}

function pickTimestamp(o: Record<string, unknown>, eventType: EventType): string {
  const candidates =
    eventType === "PURCHASE_APPROVED"
      ? ["paid_at", "updated_at", "created_at"]
      : ["updated_at", "created_at", "paid_at"];
  for (const key of candidates) {
    const v = o[key];
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return new Date().toISOString();
}

export interface B4youMapResult {
  ok: boolean;
  error?: string;
  event_name?: string;
  payload?: Record<string, unknown>;
}

export function mapB4youPayload(raw: unknown): B4youMapResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_payload" };
  const o = raw as Record<string, unknown>;
  const eventName = norm(String(o["event_name"] ?? ""));
  const eventType = EVENT_NAME_MAP[eventName];
  if (!eventType) {
    return { ok: false, error: "unsupported_event_name", event_name: eventName };
  }

  const customer = (o["customer"] ?? {}) as Record<string, unknown>;
  const externalUserId =
    (typeof customer["id"] === "string" && customer["id"]) ||
    (typeof customer["email"] === "string" && customer["email"]) ||
    null;
  if (!externalUserId) return { ok: false, error: "missing_customer" };

  const saleId =
    (typeof o["sale_id"] === "string" && o["sale_id"]) ||
    (typeof o["group_id"] === "string" && o["group_id"]) ||
    null;

  const subscription = o["subscription"] as Record<string, unknown> | null;
  const subscriptionId =
    subscription && typeof subscription === "object"
      ? (typeof subscription["id"] === "string" && subscription["id"]) ||
        (typeof subscription["code"] === "string" && subscription["code"]) ||
        null
      : null;

  const product = (o["product"] ?? {}) as Record<string, unknown>;
  const offer = (o["offer"] ?? {}) as Record<string, unknown>;
  const tracking = (o["tracking_parameters"] ?? {}) as Record<string, unknown>;
  const affiliate = (o["affiliate"] ?? null) as Record<string, unknown> | null;
  const coupon = (o["coupon"] ?? null) as Record<string, unknown> | null;

  const paymentMethod = methodFrom(o, eventType);
  const ts = pickTimestamp(o, eventType);
  const producerSplit = pickSplit(o, "producer");
  const affiliateSplit = pickSplit(o, "affiliate");

  // event_id is deterministic so B4you retries never duplicate anything.
  const eventId = `b4you:${saleId ?? externalUserId}:${eventName}:${ts}`;

  const payload: Record<string, unknown> = {
    event_id: eventId,
    event_type: eventType,
    user_id: externalUserId,
    transaction_id: saleId,
    subscription_id: subscriptionId,
    product_id: (typeof product["id"] === "string" && product["id"]) || null,
    value: pickAmount(o),
    net_value: producerSplit.amount,
    affiliate_value: affiliateSplit.amount,
    currency: typeof o["currency_code"] === "string" ? o["currency_code"] : "BRL",
    timestamp: ts,
    source: typeof tracking["utm_source"] === "string" ? tracking["utm_source"] : "b4you",
    payment_method: paymentMethod,
    name: typeof customer["full_name"] === "string" ? customer["full_name"] : null,
    email: typeof customer["email"] === "string" ? customer["email"] : null,
    metadata: {
      provider: "b4you",
      raw_payload: o,
      event_name: eventName,
      status: o["status"] ?? null,
      payment_method: paymentMethod,
      installments: o["installments"] ?? null,
      product_name: product["name"] ?? null,
      offer_name: offer["name"] ?? null,
      quantity: offer["quantity"] ?? null,
      coupon: coupon ? { name: coupon["name"] ?? null, amount: coupon["amount"] ?? null } : null,
      producer_split: producerSplit.amount != null ? producerSplit : null,
      affiliate_split: affiliateSplit.amount != null ? affiliateSplit : null,
      affiliate: affiliate ? { email: affiliate["email"] ?? null, name: affiliate["full_name"] ?? null } : null,
      whatsapp: customer["whatsapp"] ?? null,
      document: customer["document_number"] ?? null,
      address: customer["address"] ?? null,
      offer_id: offer["id"] ?? null,
      product_id: product["id"] ?? null,
      city: ((customer["address"] ?? {}) as Record<string, unknown>)["city"] ?? null,
      state: ((customer["address"] ?? {}) as Record<string, unknown>)["state"] ?? null,
      utm: {
        source: tracking["utm_source"] ?? null,
        medium: tracking["utm_medium"] ?? null,
        campaign: tracking["utm_campaign"] ?? null,
        content: tracking["utm_content"] ?? null,
        term: tracking["utm_term"] ?? null,
        id: tracking["utm_id"] ?? null,
      },
      sale_id: saleId,
      group_id: o["group_id"] ?? null,
    },
  };

  return { ok: true, event_name: eventName, payload };
}
