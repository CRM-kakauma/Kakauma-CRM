import type {
  FulfillmentStatus,
  Issue,
  NormalizedAddress,
  NormalizedEvent,
  NormalizedEventType,
  NormalizeResult,
  PaymentMethod,
  SubscriptionStatus,
} from "../types.ts";

/**
 * B4you webhook → normalized event (schema v1).
 *
 * Pure function: no I/O, no clock except the `receivedAt` fallback, so it can be
 * re-run over stored raw events at any time (replay / reprocessing).
 *
 * Field paths are read defensively because B4you payloads vary by event. When a
 * value is not present it becomes null — never guessed.
 */

type Obj = Record<string, unknown>;

// ------------------------------------------------------------------ event names

const EVENT_NAMES: Record<string, NormalizedEventType> = {
  "approved-payment": "PAYMENT_APPROVED",
  "payment-approved": "PAYMENT_APPROVED",
  paid: "PAYMENT_APPROVED",

  "generated-pix": "PAYMENT_PENDING",
  "pix-generated": "PAYMENT_PENDING",
  "generated-billet": "PAYMENT_PENDING",
  "billet-generated": "PAYMENT_PENDING",
  "boleto-generated": "PAYMENT_PENDING",
  "generated-boleto": "PAYMENT_PENDING",

  "declined-payment": "PAYMENT_FAILED",
  "refused-payment": "PAYMENT_FAILED",
  "payment-refused": "PAYMENT_FAILED",
  "payment-declined": "PAYMENT_FAILED",
  "canceled-payment": "PAYMENT_FAILED",
  "pix-expired": "PAYMENT_FAILED",
  "expired-pix": "PAYMENT_FAILED",

  "abandoned-cart": "CHECKOUT_ABANDONED",
  "cart-abandoned": "CHECKOUT_ABANDONED",
  "abandoned-checkout": "CHECKOUT_ABANDONED",

  refund: "REFUND",
  refunded: "REFUND",
  "refund-requested": "REFUND",
  chargeback: "CHARGEBACK",

  "renewed-subscription": "SUBSCRIPTION_RENEWED",
  "subscription-renewed": "SUBSCRIPTION_RENEWED",

  "late-subscription": "SUBSCRIPTION_LATE",
  "subscription-late": "SUBSCRIPTION_LATE",
  "overdue-subscription": "SUBSCRIPTION_LATE",
  "subscription-overdue": "SUBSCRIPTION_LATE",

  "canceled-subscription": "SUBSCRIPTION_CANCELED",
  "cancelled-subscription": "SUBSCRIPTION_CANCELED",
  "subscription-canceled": "SUBSCRIPTION_CANCELED",
  "subscription-cancelled": "SUBSCRIPTION_CANCELED",

  "subscription-expiring-soon": "SUBSCRIPTION_EXPIRING",
  "subscription-expiring": "SUBSCRIPTION_EXPIRING",
  "expiring-subscription": "SUBSCRIPTION_EXPIRING",

  tracking: "TRACKING",
  "tracking-created": "TRACKING",
  "created-tracking": "TRACKING",
  "tracking-updated": "TRACKING",

  "affiliation-requested": "AFFILIATION",
  "affiliation-approved": "AFFILIATION",
  "affiliation-declined": "AFFILIATION",
};

export function normalizeEventName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-");
}

// ------------------------------------------------------------------ readers

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return null;
}

/** First non-empty value among candidate keys. */
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function date(v: unknown, field: string, warnings: Issue[]): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    warnings.push({
      code: "invalid_timestamp",
      message: `${field} is not a valid date`,
      context: { value: s },
    });
    return null;
  }
  return d.toISOString();
}

function dateOnly(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ mappers

function paymentMethod(raw: string | null, o: Obj, type: NormalizedEventType): PaymentMethod {
  const m = raw ? normalizeEventName(raw) : null;
  if (m === "pix") return "pix";
  if (
    m &&
    ["card", "credit-card", "creditcard", "credit", "cartao", "cartao-de-credito"].includes(m)
  )
    return "card";
  if (m && ["billet", "boleto", "bank-slip", "bankslip"].includes(m)) return "billet";
  if (m && ["apple-pay", "applepay"].includes(m)) return "apple_pay";
  if (!m) {
    if (isObj(o["pix"])) return "pix";
    if (isObj(o["billet"]) || isObj(o["boleto"])) return "billet";
    if (type === "PAYMENT_PENDING" && /pix/.test(normalizeEventName(String(o["event_name"] ?? ""))))
      return "pix";
    if (
      type === "PAYMENT_PENDING" &&
      /billet|boleto/.test(normalizeEventName(String(o["event_name"] ?? "")))
    )
      return "billet";
  }
  return "unknown";
}

function subscriptionStatus(raw: string | null): SubscriptionStatus | null {
  if (!raw) return null;
  const s = normalizeEventName(raw);
  if (["active", "ativa", "ativo", "paid", "renewed"].includes(s)) return "ACTIVE";
  if (["trial", "trialing"].includes(s)) return "TRIAL";
  if (["paused", "pausada", "suspended"].includes(s)) return "PAUSED";
  if (
    ["pending", "waiting-payment", "past-due", "late", "overdue", "unpaid", "atrasada"].includes(s)
  )
    return "PAYMENT_PENDING";
  if (["failed", "refused", "declined"].includes(s)) return "PAYMENT_FAILED";
  if (
    ["canceled", "cancelled", "cancelada", "canceled-by-customer", "canceled-by-producer"].includes(
      s,
    )
  )
    return "CANCELLED";
  if (["inactive", "inativa", "inativo"].includes(s)) return "INACTIVE";
  if (["expired", "expirada"].includes(s)) return "EXPIRED";
  return null;
}

function fulfillmentStatus(raw: string | null): FulfillmentStatus {
  if (!raw) return "FULFILLMENT_CREATED";
  const s = normalizeEventName(raw);
  if (/out-for-delivery|saiu-para-entrega/.test(s)) return "OUT_FOR_DELIVERY";
  if (/delivered|entregue/.test(s)) return "DELIVERED";
  if (/transit|transito/.test(s)) return "IN_TRANSIT";
  if (/delay|atras/.test(s)) return "DELIVERY_DELAYED";
  if (/return|devolv/.test(s)) return "DELIVERY_RETURNED";
  if (/lost|extravi/.test(s)) return "DELIVERY_LOST";
  if (/fail|falha/.test(s)) return "DELIVERY_FAILED";
  if (/shipped|posted|postado|enviado|sent/.test(s)) return "SHIPPED";
  return "FULFILLMENT_CREATED";
}

const KNOWN_ATTRIBUTION = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
  "fbclid",
  "gclid",
  "ttclid",
  "fbc",
  "fbp",
  "b1",
  "b2",
  "b3",
  "sck",
  "src",
] as const;

function attribution(o: Obj): NormalizedEvent["attribution"] {
  const t = { ...obj(o["utm"]), ...obj(o["tracking_parameters"]) };
  const out: NormalizedEvent["attribution"] = { extra: {} };
  for (const k of KNOWN_ATTRIBUTION) out[k] = str(t[k]);
  for (const [k, v] of Object.entries(t)) {
    if (
      !(KNOWN_ATTRIBUTION as readonly string[]).includes(k) &&
      v !== null &&
      v !== undefined &&
      v !== ""
    ) {
      out.extra[k] = v; // unknown parameters are kept, never discarded
    }
  }
  // src = "funil-1~<uuid>" → funnel name + instance.
  const src = str(out["src"]);
  if (src && src.includes("~")) {
    const [name, ...rest] = src.split("~");
    out["funnel_name"] = name || null;
    out["funnel_instance_id"] = rest.join("~") || null;
  } else {
    out["funnel_name"] = null;
    out["funnel_instance_id"] = null;
  }
  return out;
}

function address(c: Obj): NormalizedAddress | null {
  const a = obj(c["address"]);
  const addr: NormalizedAddress = {
    street: str(pick(a, "street", "address", "logradouro")),
    number: str(pick(a, "number", "numero")),
    complement: str(pick(a, "complement", "complemento")),
    neighborhood: str(pick(a, "neighborhood", "district", "bairro")),
    city: str(pick(a, "city", "cidade")) ?? str(c["city"]),
    state: str(pick(a, "state", "uf", "estado")) ?? str(c["state"]),
    zipcode: str(pick(a, "zipcode", "zip_code", "zip", "cep", "postal_code")),
  };
  return Object.values(addr).some((v) => v !== null) ? addr : null;
}

function cardInfo(o: Obj): { brand: string | null; last_four: string | null } {
  const raw = o["card"];
  const card = Array.isArray(raw) ? obj(raw[raw.length - 1]) : obj(raw);
  const brand = str(pick(card, "brand", "card_brand", "flag", "bandeira")) ?? str(o["card_brand"]);
  const explicit =
    str(pick(card, "last_four", "last_four_digits", "last_digits", "final_digits", "last4")) ??
    str(o["card_last_four"]);
  let last = explicit ? explicit.replace(/\D/g, "").slice(-4) : null;
  if (!last) {
    const masked = str(pick(card, "number", "card_number", "masked_number"));
    const digits = masked?.replace(/\D/g, "") ?? "";
    // Only derive from masked numbers (never store anything but the last four).
    if (masked && /[*xX•]/.test(masked) && digits.length >= 4) last = digits.slice(-4);
  }
  return { brand, last_four: last && /^\d{4}$/.test(last) ? last : null };
}

function splits(o: Obj): NormalizedEvent["splits"] {
  const raw = o["splits"];
  if (Array.isArray(raw)) {
    const byType = (t: string) =>
      raw.map(obj).find((s) => normalizeEventName(String(s["type"] ?? "")) === t);
    const producer = byType("producer");
    const affiliate = byType("affiliate");
    const platform = byType("platform") ?? byType("fee");
    return {
      fee: num(platform?.["amount"]),
      my_commission: num(producer?.["amount"]),
      affiliate_commission: num(affiliate?.["amount"]),
      released: bool(producer?.["released"]),
      release_date: str(producer?.["release_date"]),
      raw,
    };
  }
  if (isObj(raw)) {
    return {
      fee: num(pick(raw, "fee", "platform_fee", "tax")),
      my_commission: num(pick(raw, "my_commission", "commission", "producer_commission")),
      affiliate_commission: num(pick(raw, "affiliate_commission")),
      released: bool(raw["released"]),
      release_date: str(raw["release_date"]),
      raw,
    };
  }
  return null;
}

// ------------------------------------------------------------------ main

export function normalizeB4you(raw: unknown, opts: { receivedAt: string }): NormalizeResult {
  const warnings: Issue[] = [];
  const errors: Issue[] = [];

  if (!isObj(raw)) {
    return {
      ok: false,
      fatal: true,
      errors: [{ code: "invalid_event", message: "payload is not a JSON object" }],
      event: null,
    };
  }
  const o = raw;
  const eventNameRaw = str(o["event_name"]) ?? str(o["event"]) ?? str(o["type"]);
  if (!eventNameRaw) {
    return {
      ok: false,
      fatal: true,
      errors: [{ code: "invalid_event", message: "missing event_name" }],
      event: null,
    };
  }
  const eventName = normalizeEventName(eventNameRaw);
  const type: NormalizedEventType =
    EVENT_NAMES[eventName] ?? (eventName.startsWith("affiliation-") ? "AFFILIATION" : "UNKNOWN");
  if (type === "UNKNOWN") {
    warnings.push({
      code: "unknown_event_name",
      message: `unhandled B4you event "${eventNameRaw}"`,
    });
  }

  // ---- charge of this event (the realized amount lives here)
  const charges = Array.isArray(o["charges"]) ? o["charges"].map(obj) : [];
  const topChargeId = str(pick(o, "charge_id", "charge_uuid"));
  const charge =
    (topChargeId
      ? charges.find((c) => str(pick(c, "id", "uuid", "charge_id")) === topChargeId)
      : undefined) ??
    charges[charges.length - 1] ??
    null;
  const chargeId = topChargeId ?? (charge ? str(pick(charge, "id", "uuid", "charge_id")) : null);
  const amount = charge ? num(charge["amount"]) : null;
  if (charges.length > 1 && !topChargeId) {
    warnings.push({
      code: "multiple_charges",
      message: "payload has several charges; the last one was used",
      context: { count: charges.length },
    });
  }

  // ---- ids
  const sub = obj(o["subscription"]);
  const subscriptionId = str(pick(sub, "id", "uuid", "code")) ?? str(o["subscription_id"]);
  const saleId = str(o["sale_id"]);
  const groupId = str(o["group_id"]);

  // ---- customer
  const c = obj(o["customer"]);
  const addr = address(c);
  const customer: NormalizedEvent["customer"] = {
    full_name: str(pick(c, "full_name", "name")),
    email: str(c["email"])?.toLowerCase() ?? null,
    phone: str(pick(c, "phone", "cellphone", "telephone")),
    whatsapp: str(pick(c, "whatsapp", "phone", "cellphone")),
    document_number: str(pick(c, "document_number", "document", "cpf", "cnpj")),
    birth_date: dateOnly(pick(c, "birth_date", "birthdate", "date_of_birth")),
    address: addr,
    city: addr?.city ?? null,
    state: addr?.state ?? null,
    zipcode: addr?.zipcode ?? null,
    neighborhood: addr?.neighborhood ?? null,
  };
  const externalCustomerId = str(pick(c, "id", "uuid"));

  // ---- timestamps: the moment the fact happened, not when we received it.
  const paidAt =
    date(pick(o, "paid_at", "approved_at"), "paid_at", warnings) ??
    (charge ? date(charge["paid_at"], "charges.paid_at", warnings) : null);
  const updatedAt = date(o["updated_at"], "updated_at", warnings);
  const createdAt = date(o["created_at"], "created_at", warnings);
  let occurredAt: string | null;
  switch (type) {
    case "PAYMENT_APPROVED":
    case "SUBSCRIPTION_RENEWED":
      occurredAt = paidAt ?? updatedAt ?? createdAt;
      break;
    case "REFUND":
    case "CHARGEBACK":
      occurredAt =
        date(pick(o, "refunded_at", "chargeback_at"), "refunded_at", warnings) ??
        updatedAt ??
        createdAt;
      break;
    default:
      occurredAt = updatedAt ?? createdAt;
  }
  if (!occurredAt) {
    warnings.push({ code: "missing_timestamp", message: "no event timestamp; using received_at" });
    occurredAt = opts.receivedAt;
  } else if (new Date(occurredAt).getTime() > new Date(opts.receivedAt).getTime() + 86_400_000) {
    warnings.push({
      code: "invalid_timestamp",
      message: "event timestamp is more than a day in the future",
      context: { occurred_at: occurredAt },
    });
  }

  // ---- catalog
  const p = obj(o["product"]);
  const product = Object.keys(p).length
    ? {
        id: str(pick(p, "id", "uuid")),
        name: str(p["name"]),
        type: str(p["type"]),
        product_type: str(pick(p, "product_type", "category")),
        cover: str(p["cover"]),
        logo: str(p["logo"]),
      }
    : null;
  const of = obj(o["offer"]);
  const offer = Object.keys(of).length
    ? {
        id: str(pick(of, "id", "uuid")),
        name: str(of["name"]),
        quantity: num(of["quantity"]),
        original_price: num(of["original_price"]), // reference price only
      }
    : null;

  // ---- payment
  const methodRaw = str(o["payment_method"]);
  const method = paymentMethod(methodRaw, o, type);
  if (
    method === "unknown" &&
    ["PAYMENT_APPROVED", "PAYMENT_PENDING", "SUBSCRIPTION_RENEWED"].includes(type)
  ) {
    warnings.push({
      code: "invalid_payment_method",
      message: "payment method missing or not recognized",
      context: { value: methodRaw },
    });
  }
  const card = method === "card" ? cardInfo(o) : { brand: null, last_four: null };
  const pix = obj(o["pix"]);
  const billet = isObj(o["billet"]) ? obj(o["billet"]) : obj(o["boleto"]);

  // ---- subscription
  const subStatusRaw = str(sub["status"]);
  const subStatus = subscriptionStatus(subStatusRaw);
  if (subscriptionId && subStatusRaw && !subStatus) {
    warnings.push({
      code: "unknown_subscription_status",
      message: `subscription status "${subStatusRaw}" not mapped; state left unchanged`,
    });
  }
  const plan = obj(sub["plan"]);
  const subscription: NormalizedEvent["subscription"] = subscriptionId
    ? {
        id: subscriptionId,
        status_raw: subStatusRaw,
        status: subStatus,
        plan_id: str(pick(plan, "id", "uuid")) ?? str(sub["plan_id"]),
        plan_name: str(plan["name"]) ?? str(sub["plan_name"]),
        frequency:
          str(pick(sub, "frequency", "recurrence", "periodicity", "interval")) ??
          str(plan["frequency"]),
        start_date: date(
          pick(sub, "start_date", "started_at", "created_at"),
          "subscription.start_date",
          warnings,
        ),
        next_charge_at: date(
          pick(sub, "next_charge", "next_charge_at", "next_billing_date", "next_payment_date"),
          "subscription.next_charge",
          warnings,
        ),
        cancelled_at: date(
          pick(sub, "canceled_at", "cancelled_at"),
          "subscription.canceled_at",
          warnings,
        ),
        expired_at: date(sub["expired_at"], "subscription.expired_at", warnings),
        cycle: num(pick(sub, "cycle", "current_cycle")),
      }
    : null;

  // ---- refund
  const r = obj(o["refund"]);
  const refund =
    type === "REFUND" || type === "CHARGEBACK"
      ? {
          refund_id: str(pick(r, "id", "uuid")),
          amount: num(pick(r, "amount", "value")) ?? num(o["refund_amount"]),
          reason: str(pick(r, "reason", "motive")) ?? str(o["refund_reason"]),
          status: str(r["status"]) ?? str(o["status"]),
        }
      : null;

  // ---- fulfillment
  const tr = obj(o["tracking"]);
  const shipping = obj(o["shipping"]);
  const providerShipStatus =
    str(pick(tr, "status")) ?? str(o["tracking_status"]) ?? str(o["shipping_status"]);
  const fulfillment =
    type === "TRACKING"
      ? {
          carrier:
            str(pick(tr, "carrier", "company", "shipping_company")) ??
            str(pick(o, "carrier", "shipping_company")) ??
            str(pick(shipping, "carrier", "company")),
          tracking_code: str(pick(tr, "code", "tracking_code")) ?? str(o["tracking_code"]),
          tracking_url: str(pick(tr, "url", "tracking_url", "link")) ?? str(o["tracking_url"]),
          shipping_cost:
            num(pick(shipping, "cost", "price", "value")) ??
            num(pick(o, "shipping_cost", "shipping_price")),
          status: fulfillmentStatus(providerShipStatus),
          provider_status: providerShipStatus,
          shipped_at: date(pick(tr, "shipped_at", "posted_at"), "tracking.shipped_at", warnings),
          estimated_delivery_at: date(
            pick(tr, "estimated_delivery_at", "estimated_delivery", "delivery_forecast"),
            "tracking.estimated_delivery_at",
            warnings,
          ),
          delivered_at: date(pick(tr, "delivered_at"), "tracking.delivered_at", warnings),
        }
      : null;

  const aff = obj(o["affiliate"]);
  const affiliate = Object.keys(aff).length
    ? {
        id: str(pick(aff, "id", "uuid")),
        email: str(aff["email"])?.toLowerCase() ?? null,
        name: str(pick(aff, "full_name", "name")),
        b4f: str(aff["b4f"]),
      }
    : null;

  const cp = obj(o["coupon"]);
  const couponCode = str(pick(cp, "code", "name", "coupon"));
  const coupon = couponCode
    ? { code: couponCode, type: str(cp["type"]), amount: num(cp["amount"]) }
    : null;

  const event: NormalizedEvent = {
    schema_version: "v1",
    source: "b4you",
    source_event_name: eventNameRaw,
    event_type: type,
    occurred_at: occurredAt,
    sale_id: saleId,
    group_id: groupId,
    charge_id: chargeId,
    subscription_id: subscriptionId,
    external_customer_id: externalCustomerId,
    amount,
    currency: str(pick(o, "currency_code", "currency")) ?? "BRL",
    quantity: num(of["quantity"]) ?? num(o["quantity"]),
    checkout_url: str(pick(o, "checkout_url", "url_checkout", "checkout_link")),
    affiliation_status: type === "AFFILIATION" ? eventName.replace(/^affiliation-/, "") : null,
    customer,
    product,
    offer,
    payment: {
      method,
      method_raw: methodRaw,
      status_raw: str(o["status"]),
      installments: num(o["installments"]),
      card_brand: card.brand,
      card_last_four: card.last_four,
      pix_url: str(pick(pix, "url", "qrcode_url", "qr_code_url")),
      pix_code: str(pick(pix, "code", "qrcode", "qr_code", "copy_paste", "emv")),
      billet_url: str(pick(billet, "url", "link")),
      billet_code: str(pick(billet, "code", "barcode", "line", "digitable_line")),
      created_at: createdAt,
      paid_at: paidAt,
      due_at: charge
        ? date(pick(charge, "due_date", "due_at"), "charges.due_date", warnings)
        : null,
    },
    splits: splits(o),
    subscription,
    refund,
    fulfillment,
    attribution: attribution(o),
    affiliate,
    coupon,
    warnings,
  };

  // ---- validation: invalid events go to the dead-letter queue, never half-processed.
  if (type !== "UNKNOWN") {
    if (
      !externalCustomerId &&
      !customer.email &&
      !customer.whatsapp &&
      !customer.document_number &&
      !saleId &&
      !subscriptionId
    ) {
      errors.push({ code: "missing_customer", message: "event has no customer identifier" });
    }
    if (["PAYMENT_APPROVED", "SUBSCRIPTION_RENEWED"].includes(type)) {
      if (amount === null)
        errors.push({
          code: "missing_amount",
          message:
            "paid event without charges[].amount (offer.original_price is never used as revenue)",
        });
      else if (amount < 0)
        errors.push({
          code: "invalid_amount",
          message: "negative charge amount",
          context: { amount },
        });
      if (!saleId && !chargeId && !subscriptionId)
        errors.push({
          code: "missing_sale_id",
          message: "paid event without sale_id or charge id",
        });
    }
    if (type === "SUBSCRIPTION_RENEWED" && !subscriptionId) {
      errors.push({ code: "missing_subscription_id", message: "renewal without subscription id" });
    }
    if (
      ["SUBSCRIPTION_LATE", "SUBSCRIPTION_CANCELED", "SUBSCRIPTION_EXPIRING"].includes(type) &&
      !subscriptionId
    ) {
      errors.push({
        code: "missing_subscription_id",
        message: `${eventNameRaw} without subscription id`,
      });
    }
    if ((type === "REFUND" || type === "CHARGEBACK") && !saleId && !chargeId) {
      errors.push({ code: "missing_sale_id", message: "refund without sale_id or charge id" });
    }
    if (type === "TRACKING" && !fulfillment?.tracking_code && !saleId) {
      errors.push({
        code: "missing_sale_id",
        message: "tracking without tracking code or sale_id",
      });
    }
  }
  if (errors.length) return { ok: false, fatal: true, errors, event };
  return { ok: true, event };
}
