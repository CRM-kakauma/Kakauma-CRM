import type { FulfillmentStatus, Issue, NormalizedEvent, NormalizeResult } from "../types.ts";

/**
 * Paylog Webhook V2 (logistics) → normalized event (schema v1).
 * https://ev.paylog.cash/docs/1.0/webhook/webhooks-v2
 *
 * Only the tracking events (shipment.*) become facts: "Entrega realizada" (FULFILLMENT_DELIVERED)
 * and the other delivery steps, on the same path the B4you tracking events use. Order events
 * (order.*) are kept in the event store and ignored: payments, refunds and cancellations come
 * from the B4you.
 *
 * The Paylog batch resend ("Reenvio por data / produto") rebuilds events from the current order
 * state, with a new idempotency_key, every marked event for every order (even ones that never
 * happened) and without the carrier's date (occurred_at null). Of those, only "delivered" for an
 * order whose tracking says delivered counts: the route stores it as history (crm.events.backfill),
 * so it frees customers waiting for the delivery in a flow but never starts a flow. The rest is
 * ignored.
 *
 * Pure function: no I/O, so stored events can be replayed.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
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

/** Paylog shipment event → CRM delivery step. Absent: not a tracking event. */
const SHIPMENT_STATUS: Record<string, FulfillmentStatus> = {
  "shipment.posted": "SHIPPED",
  "shipment.in_transit": "IN_TRANSIT",
  "shipment.out_for_delivery": "OUT_FOR_DELIVERY",
  // the carrier could not deliver: the customer has to pick it up
  "shipment.awaiting_pickup": "DELIVERY_FAILED",
  "shipment.returning": "DELIVERY_RETURNED",
  "shipment.returned": "DELIVERY_RETURNED",
  "shipment.delivered": "DELIVERED",
  // Webhook V1 "Código de rastreio recebido" (converted by paylogV1ToV2)
  "v1.tracking_received": "FULFILLMENT_CREATED",
};

export const PAYLOG_EVENTS = Object.keys(SHIPMENT_STATUS);

/**
 * Webhook V1 (legacy, "E-mails e Webhook" screen): {"dados": {...}}, no event name, no date, no
 * signature, no retry. The two kinds are told apart by the URL (?tipo=entregue|rastreio) or, as the
 * Paylog documents, by the "transportadora" key, present only in "Código de rastreio recebido".
 * Paylog sends it the moment it happens, so the time it arrived is the time of the event.
 * Converted to the V2 shape (same normalizer); the original body is kept in v1_dados.
 */
export function isPaylogV1(raw: unknown): boolean {
  const o = obj(raw);
  return isObj(o["dados"]) && !("event" in o);
}

export function paylogV1Kind(raw: unknown, tipo: string | null): "entregue" | "rastreio" {
  const t = (tipo ?? "").toLowerCase();
  if (/rastre/.test(t)) return "rastreio";
  if (/entreg/.test(t)) return "entregue";
  return "transportadora" in obj(obj(raw)["dados"]) ? "rastreio" : "entregue";
}

export function paylogV1ToV2(raw: unknown, kind: "entregue" | "rastreio", receivedAt: string) {
  const d = obj(obj(raw)["dados"]);
  const pedido = str(d["pedido_id"]);
  const event = kind === "entregue" ? "shipment.delivered" : "v1.tracking_received";
  const tracking = str(d["cod_rastreio"]);
  return {
    event,
    event_label: kind === "entregue" ? "Entregue" : "Código de rastreio recebido",
    event_timestamp: receivedAt,
    // one per order and kind: a repeated notification is not stored twice
    idempotency_key: `v1:${kind}:${pedido ?? "?"}:${tracking ?? ""}`,
    cancelable: false,
    order: {
      pedido_id: pedido,
      codigo_transacao: str(d["cod_transacao"]),
      referencia_externa: str(d["referencia_externa"]),
      plataforma: str(d["plataforma"]),
      status: { code: null, label: null },
      motivo_parado: null,
      customer: {
        nome: str(d["nome_cliente"]),
        cpf: str(d["cpf_cliente"]),
        email: str(d["email_cliente"]),
        telefone: str(d["telefone_cliente"]),
        endereco: {},
      },
      items: [],
      frete_cents: null,
    },
    shipment: {
      tracking_code: tracking,
      tracking_url: tracking
        ? `https://ev.paylog.cash/rastreio/${encodeURIComponent(tracking)}`
        : null,
      carrier: { code: null, name: str(d["transportadora"]) },
      tracking_status: {
        code: null,
        label: kind === "entregue" ? "Entregue" : "Código de rastreio recebido",
      },
      description: null,
      location: null,
      occurred_at: receivedAt,
      collection_address: null,
      delivery_proof: {
        image_url: null,
        signature_url: null,
        received_by: null,
        signatory: null,
        delivery_lat: null,
        delivery_lng: null,
      },
    },
    meta: { webhook_version: 1, api_version: null },
    v1_dados: d,
  };
}

/**
 * Batch resend ("Reenvio por data / produto"): rebuilt from the current order state, without the
 * carrier's date (shipment.occurred_at null), for every order, whether the event happened or not.
 */
export function isPaylogResend(raw: unknown): boolean {
  const o = obj(raw);
  return (str(o["event"]) ?? "").startsWith("shipment.") && !str(obj(o["shipment"])["occurred_at"]);
}

/** The order's current tracking says delivered (the only proof a batch resend carries). */
export function isDeliveredNow(raw: unknown): boolean {
  const ship = obj(obj(raw)["shipment"]);
  const label = (str(obj(ship["tracking_status"])["label"]) ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const proof = obj(ship["delivery_proof"]);
  const labelSaysDelivered =
    /\bentregue\b|\bentrega realizada\b|\bdelivered\b/.test(label) &&
    !/saiu|\bnao\b|tentativa|problema|devolu|remetente|aguardando|retirada/.test(label);
  return (
    labelSaysDelivered ||
    !!(str(proof["image_url"]) || str(proof["received_by"]) || str(proof["signatory"]))
  );
}

export function normalizePaylog(raw: unknown, opts: { receivedAt: string }): NormalizeResult {
  const warnings: Issue[] = [];
  const errors: Issue[] = [];
  const o = obj(raw);
  const eventName = str(o["event"]) ?? "unknown";
  const order = obj(o["order"]);
  const ship = obj(o["shipment"]);
  const c = obj(order["customer"]);
  const end = obj(c["endereco"]);
  const carrier = obj(ship["carrier"]);
  const trackingStatus = obj(ship["tracking_status"]);

  const shipStatus = SHIPMENT_STATUS[eventName] ?? null;
  const occurredAt = date(ship["occurred_at"], "shipment.occurred_at", warnings);
  const eventAt = date(o["event_timestamp"], "event_timestamp", warnings);

  let type: NormalizedEvent["event_type"] = shipStatus ? "TRACKING" : "UNKNOWN";
  if (shipStatus && !occurredAt) {
    if (shipStatus === "DELIVERED" && isDeliveredNow(raw)) {
      // batch resend of an order whose tracking says delivered today: kept as history
      // (the route stores it marked, so it only frees customers waiting for the delivery)
      warnings.push({
        code: "paylog_resend",
        message: "delivery from a Paylog batch resend: carrier date unknown, resend time used",
      });
    } else {
      type = "UNKNOWN";
      warnings.push({
        code: "paylog_without_tracking_date",
        message:
          "shipment event without shipment.occurred_at (Paylog batch resend) for an order not delivered: ignored",
      });
    }
  }

  const tracking = str(ship["tracking_code"]);
  const saleId = str(order["codigo_transacao"]);
  const address =
    Object.keys(end).length > 0
      ? {
          street: str(end["logradouro"]),
          number: str(end["numero"]),
          complement: str(end["complemento"]),
          neighborhood: str(end["bairro"]),
          city: str(end["cidade"]),
          state: str(end["uf"]),
          zipcode: str(end["cep"]),
        }
      : null;
  const freight = typeof order["frete_cents"] === "number" ? order["frete_cents"] / 100 : null;

  const event: NormalizedEvent = {
    schema_version: "v1",
    source: "paylog",
    source_event_name: eventName,
    event_type: type,
    occurred_at: occurredAt ?? eventAt ?? opts.receivedAt,
    sale_id: saleId,
    group_id: null,
    charge_id: null,
    subscription_id: null,
    external_customer_id: null,
    amount: null,
    currency: "BRL",
    quantity: null,
    checkout_url: null,
    affiliation_status: null,
    customer: {
      full_name: str(c["nome"]),
      email: str(c["email"])?.toLowerCase() ?? null,
      phone: str(c["telefone"]),
      whatsapp: str(c["telefone"]),
      document_number: str(c["cpf"]),
      birth_date: null,
      address,
      city: address?.city ?? null,
      state: address?.state ?? null,
      zipcode: address?.zipcode ?? null,
      neighborhood: address?.neighborhood ?? null,
    },
    // the Paylog product id is not the B4you one: the catalog is left alone
    product: null,
    offer: null,
    payment: {
      method: "unknown",
      method_raw: null,
      status_raw: null,
      installments: null,
      card_brand: null,
      card_last_four: null,
      pix_url: null,
      pix_code: null,
      billet_url: null,
      billet_code: null,
      created_at: null,
      paid_at: null,
      due_at: null,
    },
    splits: null,
    subscription: null,
    refund: null,
    fulfillment: shipStatus
      ? {
          carrier: str(carrier["name"]) ?? str(carrier["code"]),
          tracking_code: tracking,
          tracking_url: str(ship["tracking_url"]),
          shipping_cost: freight,
          status: shipStatus,
          provider_status: str(trackingStatus["label"]) ?? eventName,
          shipped_at: shipStatus === "SHIPPED" ? occurredAt : null,
          estimated_delivery_at: null,
          delivered_at: shipStatus === "DELIVERED" ? occurredAt : null,
        }
      : null,
    // no campaign data in a delivery: an attribution row would take the acquisition source
    attribution: { extra: {} },
    affiliate: null,
    coupon: null,
    warnings,
  };

  if (type === "TRACKING") {
    const c2 = event.customer;
    if (!c2.email && !c2.whatsapp && !c2.document_number && !saleId)
      errors.push({ code: "missing_customer", message: "event has no customer identifier" });
    if (!tracking && !saleId)
      errors.push({
        code: "missing_sale_id",
        message: "tracking without tracking code or codigo_transacao",
      });
  }
  if (errors.length) return { ok: false, fatal: true, errors, event };
  return { ok: true, event };
}
