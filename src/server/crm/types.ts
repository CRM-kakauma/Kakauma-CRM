/**
 * Normalized event contract (v1).
 *
 * Every provider payload is translated into this shape before any business
 * logic runs. The SQL engine (crm.apply_event) only ever reads this format;
 * the original payload stays untouched in crm.events for audit and replay.
 *
 * Unknown values are null — never invented.
 */

export const NORMALIZED_EVENT_TYPES = [
  "CHECKOUT_ABANDONED",
  "PAYMENT_PENDING",
  "PAYMENT_APPROVED",
  "PAYMENT_FAILED",
  "REFUND",
  "CHARGEBACK",
  "SUBSCRIPTION_RENEWED",
  "SUBSCRIPTION_LATE",
  "SUBSCRIPTION_CANCELED",
  "SUBSCRIPTION_EXPIRING",
  "TRACKING",
  "AFFILIATION",
  "UNKNOWN",
] as const;

export type NormalizedEventType = (typeof NORMALIZED_EVENT_TYPES)[number];

export type PaymentMethod = "pix" | "card" | "billet" | "apple_pay" | "unknown";

export type SubscriptionStatus =
  | "TRIAL"
  | "ACTIVE"
  | "PAUSED"
  | "PAYMENT_PENDING"
  | "PAYMENT_FAILED"
  | "CANCELLED"
  | "INACTIVE"
  | "EXPIRED";

export type FulfillmentStatus =
  | "FULFILLMENT_CREATED"
  | "SHIPPED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "DELIVERY_DELAYED"
  | "DELIVERY_FAILED"
  | "DELIVERY_RETURNED"
  | "DELIVERY_LOST";

export interface Issue {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface NormalizedAddress {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
}

export interface NormalizedEvent {
  schema_version: "v1";
  source: string;
  source_event_name: string;
  event_type: NormalizedEventType;
  occurred_at: string;

  sale_id: string | null;
  group_id: string | null;
  charge_id: string | null;
  subscription_id: string | null;
  external_customer_id: string | null;

  /** Realized amount of this event's charge (charges[].amount). Never offer.original_price. */
  amount: number | null;
  currency: string;
  quantity: number | null;
  checkout_url: string | null;
  affiliation_status: string | null;

  customer: {
    full_name: string | null;
    email: string | null;
    phone: string | null;
    whatsapp: string | null;
    document_number: string | null;
    birth_date: string | null;
    address: NormalizedAddress | null;
    city: string | null;
    state: string | null;
    zipcode: string | null;
    neighborhood: string | null;
  };
  product: {
    id: string | null;
    name: string | null;
    type: string | null;
    product_type: string | null;
    cover: string | null;
    logo: string | null;
  } | null;
  offer: {
    id: string | null;
    name: string | null;
    quantity: number | null;
    original_price: number | null;
  } | null;
  payment: {
    method: PaymentMethod;
    method_raw: string | null;
    status_raw: string | null;
    installments: number | null;
    card_brand: string | null;
    card_last_four: string | null;
    pix_url: string | null;
    pix_code: string | null;
    billet_url: string | null;
    billet_code: string | null;
    created_at: string | null;
    paid_at: string | null;
    due_at: string | null;
  };
  splits: {
    fee: number | null;
    my_commission: number | null;
    affiliate_commission: number | null;
    released: boolean | null;
    release_date: string | null;
    raw: unknown;
  } | null;
  subscription: {
    id: string;
    status_raw: string | null;
    /** Provider-confirmed status. Null when unknown — the engine then changes nothing. */
    status: SubscriptionStatus | null;
    plan_id: string | null;
    plan_name: string | null;
    frequency: string | null;
    start_date: string | null;
    next_charge_at: string | null;
    cancelled_at: string | null;
    expired_at: string | null;
    cycle: number | null;
  } | null;
  refund: {
    refund_id: string | null;
    amount: number | null;
    reason: string | null;
    status: string | null;
  } | null;
  fulfillment: {
    carrier: string | null;
    tracking_code: string | null;
    tracking_url: string | null;
    shipping_cost: number | null;
    status: FulfillmentStatus;
    provider_status: string | null;
    shipped_at: string | null;
    estimated_delivery_at: string | null;
    delivered_at: string | null;
  } | null;
  attribution: Record<string, unknown> & { extra: Record<string, unknown> };
  affiliate: {
    id: string | null;
    email: string | null;
    name: string | null;
    b4f: string | null;
  } | null;
  coupon: { code: string; type: string | null; amount: number | null } | null;

  warnings: Issue[];
}

export type NormalizeResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; fatal: true; errors: Issue[]; event: NormalizedEvent | null };
