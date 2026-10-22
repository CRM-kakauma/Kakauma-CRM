/**
 * Evolution API (WhatsApp unofficial, v2) — https://doc.evolution-api.com
 *
 *   POST /message/sendText/{instance}       { number, text, delay?, linkPreview? }
 *   POST /message/sendMedia/{instance}      { number, mediatype, media (url), caption, fileName? }
 *        → 201 { key: { remoteJid, fromMe, id }, status, messageTimestamp }
 *   GET  /instance/connectionState/{instance} → { instance: { state: "open" | "close" | "connecting" } }
 *   GET  /instance/connect/{instance}          → { base64 (QR image), pairingCode, code }
 *   GET  /instance/fetchInstances?instanceName= → the instance (number, profile name)
 *   POST /webhook/set/{instance}               { webhook: { enabled, url, events, … } }
 *
 * Auth: header apikey (EVOLUTION_API_KEY). No approved templates: any text goes, any time —
 * but it is an unofficial connection: mass marketing can get the number banned by WhatsApp.
 */
import { toPushfyNumber } from "./pushfy.ts";

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instance: string;
  /** ms Evolution shows "digitando…" before each message (spaces the sends out) */
  delayMs?: number | undefined;
  fetchImpl?: typeof fetch;
}

export interface EvolutionResult {
  ok: boolean;
  /** true when retrying cannot help (number without WhatsApp, bad key, empty message) */
  permanent: boolean;
  httpStatus: number | null;
  body: unknown;
  /** id of the WhatsApp message (the webhook statuses come with it) */
  id?: string | undefined;
  error?: string;
}

const root = (c: EvolutionConfig) => c.baseUrl.replace(/\/+$/, "");
const inst = (c: EvolutionConfig) => encodeURIComponent(c.instance);

async function call(c: EvolutionConfig, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await (c.fetchImpl ?? fetch)(`${root(c)}${path}`, {
    method,
    headers: {
      apikey: c.apiKey,
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

/** Evolution's error answers in plain words. */
export function evolutionError(status: number, body: unknown) {
  const b = (body ?? {}) as {
    response?: { message?: unknown };
    message?: unknown;
    error?: unknown;
  };
  const raw = b.response?.message ?? b.message ?? b.error;
  const list = Array.isArray(raw) ? raw : [raw];
  // number check: [{ exists: false, number }]
  if (list.some((x) => x && typeof x === "object" && (x as { exists?: unknown }).exists === false))
    return { error: "Número sem WhatsApp", permanent: true };
  const text = list
    .map((x) => (typeof x === "string" ? x : x ? JSON.stringify(x) : ""))
    .filter(Boolean)
    .join("; ");
  if (status === 401 || status === 403)
    return { error: "Chave da Evolution inválida (EVOLUTION_API_KEY)", permanent: true };
  if (status === 404)
    return {
      error: `Instância "${text || "?"}" não encontrada na Evolution (EVOLUTION_INSTANCE)`,
      permanent: true,
    };
  if (/connection closed|not connected|disconnected/i.test(text))
    return {
      error: "WhatsApp desconectado na Evolution: leia o QR code de novo",
      permanent: false,
    };
  return {
    error: text || `Evolution respondeu ${status}`,
    permanent: status >= 400 && status < 500 && status !== 408 && status !== 429,
  };
}

interface RenderedWa {
  header?: { type: string; text?: string; url?: string | null } | null;
  body?: string;
  footer?: string | null;
  buttons?: { type: string; text?: string; url?: string | null; code?: string; phone?: string }[];
}

/** What goes to Evolution for a rendered WhatsApp message: text, or media with caption. */
export function evolutionPlan(rendered: unknown) {
  const r = (rendered ?? {}) as RenderedWa;
  // buttons are not reliable outside the official API: links and codes go in the text
  const extras = (r.buttons ?? [])
    .map((b) =>
      b.type === "url" && b.url
        ? `${b.text}: ${b.url}`
        : b.type === "copy_code" && b.code
          ? `${b.text}: ${b.code}`
          : b.type === "phone" && b.phone
            ? `${b.text}: ${b.phone}`
            : "",
    )
    .filter(Boolean);
  const text = [
    r.header?.type === "text" && r.header.text ? `*${r.header.text}*` : "",
    r.body ?? "",
    ...extras,
    r.footer ? `_${r.footer}_` : "",
  ]
    .filter((x) => x.trim())
    .join("\n\n");
  const h = r.header;
  if (h && (h.type === "image" || h.type === "video" || h.type === "document") && h.url)
    return { kind: "media" as const, mediatype: h.type, media: h.url, text };
  return { kind: "text" as const, text };
}

export async function evolutionSend(
  c: EvolutionConfig,
  phone: string,
  rendered: unknown,
): Promise<EvolutionResult> {
  const number = toPushfyNumber(phone);
  if (!number)
    return { ok: false, permanent: true, httpStatus: null, body: null, error: "Telefone inválido" };
  const plan = evolutionPlan(rendered);
  if (!plan.text.trim() && plan.kind === "text")
    return { ok: false, permanent: true, httpStatus: null, body: null, error: "Mensagem vazia" };
  const delay = c.delayMs && c.delayMs > 0 ? { delay: c.delayMs } : {};
  try {
    const res =
      plan.kind === "media"
        ? await call(c, "POST", `/message/sendMedia/${inst(c)}`, {
            number,
            mediatype: plan.mediatype,
            media: plan.media,
            caption: plan.text,
            ...(plan.mediatype === "document" ? { fileName: "arquivo.pdf" } : {}),
            ...delay,
          })
        : await call(c, "POST", `/message/sendText/${inst(c)}`, {
            number,
            text: plan.text,
            linkPreview: true,
            ...delay,
          });
    const id = (res.body as { key?: { id?: string } } | null)?.key?.id;
    if (res.status >= 200 && res.status < 300 && id)
      return { ok: true, permanent: false, httpStatus: res.status, body: res.body, id };
    const e = evolutionError(res.status, res.body);
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

/** Connection of the instance and, when available, its number and profile name. */
export async function evolutionStatus(c: EvolutionConfig) {
  const st = await call(c, "GET", `/instance/connectionState/${inst(c)}`);
  if (st.status !== 200)
    return { ok: false as const, error: evolutionError(st.status, st.body).error };
  const state = String(
    (st.body as { instance?: { state?: unknown }; state?: unknown } | null)?.instance?.state ??
      (st.body as { state?: unknown } | null)?.state ??
      "unknown",
  );
  let number: string | null = null;
  let name: string | null = null;
  try {
    const f = await call(c, "GET", `/instance/fetchInstances?instanceName=${inst(c)}`);
    const list = Array.isArray(f.body) ? f.body : [f.body];
    const i = (list[0] ?? {}) as Record<string, unknown>;
    const nested = (i["instance"] ?? {}) as Record<string, unknown>;
    const owner = String(i["ownerJid"] ?? nested["owner"] ?? i["number"] ?? "");
    number = owner ? owner.split("@")[0]!.replace(/\D/g, "") || null : null;
    name = (i["profileName"] ?? nested["profileName"] ?? null) as string | null;
  } catch {
    /* only the state then */
  }
  return { ok: true as const, state, number, name };
}

/** QR code (data URI) to connect the phone, or the state when it is already connected. */
export async function evolutionConnect(c: EvolutionConfig) {
  const res = await call(c, "GET", `/instance/connect/${inst(c)}`);
  if (res.status !== 200)
    return { ok: false as const, error: evolutionError(res.status, res.body).error };
  const b = (res.body ?? {}) as {
    base64?: string;
    pairingCode?: string;
    instance?: { state?: string };
  };
  return {
    ok: true as const,
    qr: b.base64 ?? null,
    pairingCode: b.pairingCode ?? null,
    state: b.instance?.state ?? null,
  };
}

export const EVOLUTION_EVENTS = [
  "MESSAGES_UPSERT",
  "MESSAGES_UPDATE",
  "SEND_MESSAGE",
  "CONNECTION_UPDATE",
];

/**
 * Points the instance's webhook to the CRM. Evolution v2.1+ wants { webhook: { … } }; v2.0 the
 * same fields flat (webhookByEvents / webhookBase64) — the second form is tried when the
 * first is refused.
 */
export async function evolutionSetWebhook(c: EvolutionConfig, url: string) {
  const path = `/webhook/set/${inst(c)}`;
  let res = await call(c, "POST", path, {
    webhook: { enabled: true, url, byEvents: false, base64: false, events: EVOLUTION_EVENTS },
  });
  if (res.status === 400)
    res = await call(c, "POST", path, {
      enabled: true,
      url,
      webhookByEvents: false,
      webhookBase64: false,
      events: EVOLUTION_EVENTS,
    });
  if (res.status >= 200 && res.status < 300) return { ok: true as const };
  return { ok: false as const, error: evolutionError(res.status, res.body).error };
}

const STATUS: Record<string, string> = {
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
};
/** Digits of a WhatsApp jid; LIDs (hidden numbers) fall back to the alternative jid. */
function jidPhone(...jids: unknown[]) {
  for (const j of jids) {
    const s = typeof j === "string" ? j : "";
    if (!s || s.endsWith("@g.us") || s.endsWith("@lid") || s.includes("broadcast")) continue;
    const d = s.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");
    if (d.length >= 10) return d;
  }
  return null;
}
/** Same words the database treats as opt-out (crm_whatsapp_event). */
const OPTOUT_RE = /^(sair|parar|pare|cancelar|remover|stop|descadastrar|parar promo.*)$/i;
const unixTs = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return String(n > 1e12 ? Math.floor(n / 1000) : Math.floor(n));
};

/**
 * Evolution webhook events → the same status / message items the CRM keeps for WhatsApp
 * (crm_whatsapp_event): messages.update (SERVER_ACK / DELIVERY_ACK / READ / ERROR) and
 * messages.upsert from the customer (text, PARAR…). Anything else is ignored.
 */
export function evolutionItems(body: unknown): ["status" | "reply", Record<string, unknown>][] {
  const b = (body ?? {}) as { event?: unknown; data?: unknown };
  const event = String(b.event ?? "")
    .toLowerCase()
    .replace(/_/g, ".");
  const data = Array.isArray(b.data) ? b.data : b.data ? [b.data] : [];
  const out: ["status" | "reply", Record<string, unknown>][] = [];
  for (const d0 of data) {
    const d = (d0 ?? {}) as Record<string, unknown>;
    const key = (d["key"] ?? {}) as Record<string, unknown>;
    if (event === "messages.update") {
      const status =
        STATUS[String(d["status"] ?? (d["update"] as { status?: unknown })?.status ?? "")];
      const id = d["keyId"] ?? key["id"] ?? d["messageId"];
      if (!status || typeof id !== "string") continue;
      out.push([
        "status",
        {
          id,
          status,
          timestamp: unixTs(d["datetime"] ?? d["messageTimestamp"]),
          recipient_id: jidPhone(d["remoteJid"], key["remoteJid"]),
          provider: "evolution",
        },
      ]);
    } else if (event === "messages.upsert") {
      if (key["fromMe"] === true) continue;
      const from = jidPhone(key["remoteJid"], key["remoteJidAlt"], key["senderPn"], d["sender"]);
      const msg = (d["message"] ?? {}) as Record<string, unknown>;
      const text = String(
        msg["conversation"] ??
          (msg["extendedTextMessage"] as { text?: string } | undefined)?.text ??
          (msg["buttonsResponseMessage"] as { selectedDisplayText?: string } | undefined)
            ?.selectedDisplayText ??
          "",
      );
      // only what the CRM acts on (opt-out words): customers' conversations are not stored
      if (!from || typeof key["id"] !== "string" || !OPTOUT_RE.test(text.trim())) continue;
      out.push([
        "reply",
        {
          id: key["id"],
          from,
          timestamp: unixTs(d["messageTimestamp"]),
          type: "text",
          text: { body: text },
          provider: "evolution",
        },
      ]);
    }
  }
  return out;
}
