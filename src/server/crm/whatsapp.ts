/**
 * WhatsApp Cloud API (Meta) — https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 *   POST /{phone-number-id}/messages        send (template or, inside the 24 h window, text)
 *        → 200 { contacts: [{ wa_id }], messages: [{ id: "wamid…" }] }
 *   GET  /{waba-id}/message_templates       templates of the account (name, language, status,
 *                                           category, parameter_format, components)
 *   GET  /{phone-number-id}                 the number (display_phone_number, verified_name,
 *                                           quality_rating) — checks the token
 *
 * Auth: Authorization: Bearer <token> (a system user's permanent token, with
 * whatsapp_business_messaging + whatsapp_business_management). Errors come as
 * { error: { message, code, error_data: { details } } }.
 */
import type { MetaTemplate } from "../../lib/crm-whatsapp.ts";

export interface WhatsappConfig {
  token: string;
  phoneNumberId: string;
  wabaId?: string | undefined;
  apiVersion?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface WhatsappResult {
  ok: boolean;
  /** true when retrying cannot help (bad number, template, outside the 24 h window, token) */
  permanent: boolean;
  httpStatus: number | null;
  body: unknown;
  /** wamid of the message (the webhook statuses come with it) */
  id?: string | undefined;
  error?: string;
}

const base = (c: WhatsappConfig) =>
  `${(c.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "")}/${c.apiVersion ?? "v23.0"}`;

async function call(c: WhatsappConfig, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await (c.fetchImpl ?? fetch)(`${base(c)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${c.token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep the text */
  }
  return { status: res.status, body: parsed };
}

/** The most common Meta error codes, in plain words. */
const ERRORS: Record<number, string> = {
  190: "Token do WhatsApp inválido ou expirado (WHATSAPP_TOKEN)",
  10: "O token não tem permissão para este número (whatsapp_business_messaging)",
  100: "Parâmetro inválido",
  131008: "Faltou um parâmetro obrigatório",
  131009: "Valor de parâmetro inválido",
  131026: "Mensagem não entregue: número sem WhatsApp ou que não pode receber",
  131030: "Número fora da lista de teste (app em desenvolvimento)",
  131031: "Conta do WhatsApp bloqueada pela Meta",
  131042: "Problema de pagamento na conta do WhatsApp (cadastre a forma de pagamento)",
  131047: "Fora da janela de 24h: use um modelo aprovado pela Meta",
  131048: "Limite de spam: muitas mensagens bloqueadas ou denunciadas",
  131049: "A Meta não entregou para manter a qualidade (limite de marketing para este cliente)",
  131050: "O cliente parou de receber mensagens de marketing",
  131051: "Tipo de mensagem não suportado",
  131056: "Muitas mensagens para o mesmo número em pouco tempo",
  130429: "Limite de envios por segundo atingido",
  132000: "Número de parâmetros diferente do modelo aprovado",
  132001: "Modelo não existe neste idioma (ou ainda não foi aprovado)",
  132005: "Texto do modelo ficou grande demais com os parâmetros",
  132007: "Conteúdo do modelo viola as regras do WhatsApp",
  132012: "Formato de parâmetro diferente do modelo (ex.: imagem no cabeçalho)",
  132015: "Modelo pausado pela Meta por baixa qualidade",
  132016: "Modelo desativado pela Meta",
  133010: "Número do WhatsApp ainda não registrado na Cloud API",
};
/** Codes worth another try later (rate limits, temporary errors). */
const TEMPORARY = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004]);

export function whatsappError(status: number, body: unknown) {
  const e = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const code = Number(e["code"] ?? 0);
  const details = (e["error_data"] as { details?: unknown } | undefined)?.details;
  const msg =
    ERRORS[code] ??
    String(
      e["error_user_msg"] ?? e["message"] ?? (status ? `WhatsApp respondeu ${status}` : "falha"),
    );
  return {
    error: `${msg}${code ? ` (${code})` : ""}${details ? ` — ${String(details)}` : ""}`,
    permanent: !TEMPORARY.has(code) && status >= 400 && status < 500 && status !== 429,
  };
}

interface RenderedWa {
  header?: { type: string; text?: string; url?: string | null } | null;
  body?: string;
  footer?: string | null;
  buttons?: {
    type: string;
    text?: string;
    url?: string | null;
    base?: string;
    fixed?: boolean;
    code?: string;
  }[];
  meta?: {
    name: string;
    language: string;
    format?: "positional" | "named";
    header_params?: { key: string; value: string }[];
    params?: { key: string; value: string }[];
  } | null;
}

/** The request body for a rendered WhatsApp message (see renderMessage). */
export function whatsappPayload(to: string, rendered: unknown, messageId?: string) {
  const r = (rendered ?? {}) as RenderedWa;
  const common = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    // comes back in the status webhooks
    ...(messageId ? { biz_opaque_callback_data: messageId } : {}),
  };
  const m = r.meta;
  if (m?.name) {
    const named = m.format === "named";
    const text = (p: { key: string; value: string }) =>
      named
        ? { type: "text", parameter_name: p.key, text: p.value }
        : { type: "text", text: p.value };
    const components: Record<string, unknown>[] = [];
    const h = r.header;
    if (h?.type === "text" && m.header_params?.length)
      components.push({ type: "header", parameters: m.header_params.map(text) });
    else if (h && (h.type === "image" || h.type === "video" || h.type === "document") && h.url)
      components.push({
        type: "header",
        parameters: [{ type: h.type, [h.type]: { link: h.url } }],
      });
    if (m.params?.length) components.push({ type: "body", parameters: m.params.map(text) });
    (r.buttons ?? []).forEach((b, i) => {
      if (b.type === "url" && !b.fixed && b.base !== undefined) {
        const url = b.url ?? "";
        const suffix = url.startsWith(b.base) ? url.slice(b.base.length) : "";
        components.push({
          type: "button",
          sub_type: "url",
          index: String(i),
          parameters: [{ type: "text", text: suffix || "-" }],
        });
      } else if (b.type === "copy_code") {
        components.push({
          type: "button",
          sub_type: "copy_code",
          index: String(i),
          parameters: [{ type: "coupon_code", coupon_code: b.code || "-" }],
        });
      }
    });
    return {
      ...common,
      type: "template",
      template: {
        name: m.name,
        language: { code: m.language },
        ...(components.length ? { components } : {}),
      },
    };
  }
  // free text: only delivered inside the 24 h window after the customer wrote
  const links = (r.buttons ?? [])
    .filter((b) => b.type === "url" && b.url)
    .map((b) => `${b.text}: ${b.url}`);
  const parts = [
    r.header?.type === "text" && r.header.text ? `*${r.header.text}*` : "",
    r.body ?? "",
    ...links,
    r.footer ? `_${r.footer}_` : "",
  ].filter(Boolean);
  const body = parts.join("\n\n");
  if (r.header?.type === "image" && r.header.url)
    return { ...common, type: "image", image: { link: r.header.url, caption: body } };
  return { ...common, type: "text", text: { body, preview_url: true } };
}

export async function whatsappSend(
  c: WhatsappConfig,
  to: string,
  rendered: unknown,
  messageId?: string,
): Promise<WhatsappResult> {
  const payload = whatsappPayload(to, rendered, messageId);
  try {
    const res = await call(c, "POST", `/${c.phoneNumberId}/messages`, payload);
    const id = (res.body as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
    if (res.status >= 200 && res.status < 300 && id)
      return { ok: true, permanent: false, httpStatus: res.status, body: res.body, id };
    const e = whatsappError(res.status, res.body);
    return {
      ok: false,
      permanent: e.permanent,
      httpStatus: res.status,
      body: res.body,
      error: e.error,
    };
  } catch (e) {
    return {
      ok: false,
      permanent: false,
      httpStatus: null,
      body: null,
      error: (e as Error).message,
    };
  }
}

/** Every template of the WhatsApp account (all pages). */
export async function whatsappTemplates(c: WhatsappConfig): Promise<MetaTemplate[]> {
  if (!c.wabaId) throw new Error("Configure WHATSAPP_WABA_ID (ID da conta do WhatsApp Business).");
  const out: MetaTemplate[] = [];
  let path: string | null =
    `/${c.wabaId}/message_templates?fields=name,language,status,category,parameter_format,components&limit=100`;
  for (let page = 0; path && page < 20; page++) {
    const res = await call(c, "GET", path);
    if (res.status !== 200) throw new Error(whatsappError(res.status, res.body).error);
    const b = res.body as {
      data?: MetaTemplate[];
      paging?: { next?: string; cursors?: { after?: string } };
    };
    out.push(...(b.data ?? []));
    const after = b.paging?.next ? b.paging.cursors?.after : undefined;
    path = after
      ? `/${c.wabaId}/message_templates?fields=name,language,status,category,parameter_format,components&limit=100&after=${encodeURIComponent(after)}`
      : null;
  }
  return out;
}

/** The connected number — also tells whether the token works. */
export async function whatsappNumber(c: WhatsappConfig) {
  const res = await call(
    c,
    "GET",
    `/${c.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
  );
  if (res.status !== 200)
    return { ok: false as const, error: whatsappError(res.status, res.body).error };
  return { ok: true as const, number: res.body as Record<string, unknown> };
}

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256 of the raw body with the app secret. */
export async function verifyMetaSignature(secret: string, header: string | null, raw: string) {
  const given = (header ?? "")
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

/**
 * A webhook delivery: { object: "whatsapp_business_account", entry: [{ changes: [{ field:
 * "messages", value: { statuses: [...], messages: [...] } }] }] } — each status and each
 * received message goes to the database once.
 */
export async function handleWhatsappWebhook(
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
  body: unknown,
) {
  const results: unknown[] = [];
  let matched = false;
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const changes = (entry as { changes?: unknown[] } | null)?.changes;
    for (const ch of Array.isArray(changes) ? changes : []) {
      const c = ch as { field?: string; value?: Record<string, unknown> } | null;
      if (c?.field !== "messages" || !c.value) continue;
      const items: [string, unknown][] = [
        ...((Array.isArray(c.value["statuses"]) ? c.value["statuses"] : []) as unknown[]).map(
          (s): [string, unknown] => ["status", s],
        ),
        ...((Array.isArray(c.value["messages"]) ? c.value["messages"] : []) as unknown[]).map(
          (m): [string, unknown] => ["reply", m],
        ),
      ];
      for (const [kind, payload] of items) {
        if (!payload || typeof payload !== "object") continue;
        const r = await rpc("crm_whatsapp_event", { p_kind: kind, p_payload: payload });
        if (r.error) throw new Error(r.error.message);
        if ((r.data as { message_matched?: boolean } | null)?.message_matched) matched = true;
        results.push(r.data);
      }
    }
  }
  return { results, matched };
}
