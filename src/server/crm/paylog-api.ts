/**
 * Paylog API v1 (https://ev.paylog.cash/docs/1.0/api/pedidos): recovers the deliveries the CRM
 * missed (before the Webhook V2 existed).
 *
 * GET /api/v1/pedidos?status=14 lists the orders whose status is "Entregue", up to 500 per page,
 * with the delivery date (data_entrega), the customer (e-mail, CPF, phone) and the tracking code.
 * Each one becomes the same payload the Webhook V2 sends for shipment.delivered, with the real
 * delivery date, and goes in as history (server/crm/backfill.ts): it frees customers waiting for
 * "Entrega realizada" in a flow but never starts a flow or an automation.
 */

export const PAYLOG_API = "https://ev.paylog.cash/api/v1";
/** Order status "Entregue" in the Paylog API. */
export const PAYLOG_STATUS_DELIVERED = 14;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const str = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null;

export interface PaylogPage {
  orders: Obj[];
  page: number;
  lastPage: number;
}

export class PaylogApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** One page of delivered orders, oldest first (stable order: pages do not shift while reading). */
export async function fetchDeliveredPage(
  token: string,
  page: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PaylogPage> {
  const url = `${PAYLOG_API}/pedidos?${new URLSearchParams({
    status: String(PAYLOG_STATUS_DELIVERED),
    order: "asc",
    page: String(page),
  })}`;
  const res = await fetchImpl(url, {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as Obj | null;
  if (res.status === 401)
    throw new PaylogApiError(
      "Token da Paylog inválido ou sem acesso (PAYLOG_API_TOKEN). Crie outro em Tokens de Acesso API.",
      401,
    );
  if (res.status === 403)
    throw new PaylogApiError(
      "O usuário dono do token não tem a permissão listar_pedido_api na Paylog.",
      403,
    );
  if (!res.ok || !body)
    throw new PaylogApiError(
      `Paylog respondeu ${res.status}: ${str(body?.["message"]) ?? "sem detalhe"}`,
      res.status,
    );
  return {
    orders: Array.isArray(body["data"]) ? (body["data"] as unknown[]).filter(isObj) : [],
    page: Number(body["current_page"]) || page,
    lastPage: Number(body["last_page"]) || page,
  };
}

/**
 * Paylog dates: ISO 8601 with offset, or "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DD" in Brasília time.
 * Null when absent or unreadable.
 */
export function paylogDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const local = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(s);
  const d = local
    ? new Date(`${local[1]}T${local[2] ?? "12:00:00"}${local[2]?.length === 5 ? ":00" : ""}-03:00`)
    : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A delivered order of the API → the Webhook V2 payload of shipment.delivered
 * (same normalizer, same deduplication: the fact key is the tracking code).
 * Null when the order has no delivery date (it would be dated "now" and look new): see
 * fetchDeliveryDate for those.
 */
export function deliveredOrderToPayload(
  order: Obj,
  deliveredAtFallback?: string | null,
): Obj | null {
  const id = str(order["id"]);
  const deliveredAt = paylogDate(order["data_entrega"]) ?? paylogDate(deliveredAtFallback);
  if (!id || !deliveredAt) return null;
  const c = obj(order["cliente"]);
  const track = obj(order["rastreamento"]);
  const carrier = obj(track["transportadora"] ?? order["transportadora"]);
  const status = obj(track["status"]);
  const proof = obj(track["comprovante_entrega"]);
  const items = Array.isArray(order["itens"]) ? (order["itens"] as unknown[]).filter(isObj) : [];
  return {
    event: "shipment.delivered",
    event_label: "Entregue",
    event_timestamp: deliveredAt,
    // one per order: reading the API again does not store it twice
    idempotency_key: `api:delivered:${id}`,
    cancelable: false,
    order: {
      pedido_id: Number(id),
      codigo_transacao: str(order["codigo_transacao"]),
      referencia_externa: str(order["referencia_externa"]),
      plataforma: "API v1",
      status: { code: PAYLOG_STATUS_DELIVERED, label: str(order["status"]) ?? "Entregue" },
      motivo_parado: null,
      customer: {
        nome: str(c["nome"]),
        cpf: str(c["cpf"]),
        email: str(c["email"]),
        telefone: str(c["celular"]) ?? str(c["telefone"]),
        endereco: {
          logradouro: str(c["endereco"]),
          numero: str(c["numero"]),
          complemento: str(c["complemento"]),
          bairro: str(c["bairro"]),
          cidade: str(c["cidade"]),
          uf: str(c["estado"]),
          cep: str(c["cep"]),
          pais: str(c["pais"]) ?? "BR",
        },
      },
      items: items.map((i) => ({
        descricao: str(i["descricao"]),
        quantidade: Number(i["quantidade"]) || 0,
        valor_unitario_cents: typeof i["valor_unitario"] === "number" ? i["valor_unitario"] : null,
        produto: { id: null, nome: str(i["descricao"]) },
      })),
      frete_cents: typeof order["frete"] === "number" ? order["frete"] : null,
    },
    shipment: {
      tracking_code: str(track["codigo"]),
      tracking_url: str(track["url_rastreamento"]),
      carrier: { code: str(carrier["codigo"]), name: str(carrier["nome"]) },
      tracking_status: {
        code: typeof status["codigo"] === "number" ? status["codigo"] : null,
        label: str(status["descricao"]) ?? "Entregue",
      },
      description: null,
      location: null,
      occurred_at: deliveredAt,
      collection_address: null,
      delivery_proof: {
        image_url: str(proof["imagem_url"]),
        signature_url: str(proof["assinatura_url"]),
        received_by: str(proof["recebido_por"]),
        signatory: str(proof["signatario"]),
        delivery_lat: null,
        delivery_lng: null,
      },
    },
    meta: { webhook_version: 2, api_version: 2, origin: "paylog_api_v1" },
  };
}

/**
 * Delivery date from the tracking timeline (GET /pedidos/{id}/rastreamento), for a delivered order
 * without data_entrega: the time of the last event with the order's current (delivered) status.
 */
export async function fetchDeliveryDate(
  token: string,
  orderId: string | number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `${PAYLOG_API}/pedidos/${encodeURIComponent(String(orderId))}/rastreamento`,
    {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) return null;
  const body = obj(await res.json().catch(() => null));
  const track = obj(body["rastreamento"]);
  const current = obj(track["status"])["codigo"];
  const events = (Array.isArray(track["eventos"]) ? (track["eventos"] as unknown[]) : []).filter(
    isObj,
  );
  for (const e of [...events].reverse()) {
    const st = obj(e["status"]);
    const label = (str(st["descricao"]) ?? "").toLowerCase();
    if ((current !== undefined && st["codigo"] === current) || /entregue/.test(label)) {
      const at = paylogDate(e["ocorrido_em"]);
      if (at) return at;
    }
  }
  return null;
}
