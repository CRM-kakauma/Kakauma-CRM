/**
 * Pushfy (SMS / RCS) — only what the documentation describes
 * (https://portal.pushfy.com/docs/#/pt/api-reference and #/pt/product-rcs):
 *
 *   POST /webapi        SMS          { messages: [{ destinations: [{ to }], from?, text, ext_id? }] }
 *   POST /apircsbasic   RCS Basic    same envelope, plain text
 *   POST /apircs        RCS Single   same envelope; the card goes "flat" in text:
 *                                    TITLE image-url BODY button-url BUTTON-TEXT (URLs are the separators)
 *   GET  /optoutapi     opt-outs (date?, limit ≤ 1000, offset); 404 = empty list (plain text)
 *   GET  /balance       balances per channel
 *
 * Answers: SMS { accepted, queued }; RCS one item per accepted message [{ id, phone, date, ext_id }].
 * Without the account's RCS API campaign the API answers rcs_campaign_not_found.
 * Auth: Authorization: Bearer <token>. Numbers in international format (5511999999999).
 */

export interface PushfyConfig {
  token: string;
  baseUrl?: string | undefined;
  smsFrom?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface PushfySendResult {
  ok: boolean;
  /** true when retrying cannot help (invalid number, bad request, auth) */
  permanent: boolean;
  httpStatus: number | null;
  body: unknown;
  error?: string;
}

const base = (c: PushfyConfig) => (c.baseUrl ?? "https://portal.pushfy.com").replace(/\/+$/, "");

/** Brazilian numbers to 55DDDNUMBER; anything else that is not plausible → null. */
export function toPushfyNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
  return null;
}

async function call(c: PushfyConfig, method: "GET" | "POST", path: string, body?: unknown) {
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
    /* plain-text answers (e.g. 404 on /optoutapi) */
  }
  return { status: res.status, body: parsed };
}

export type PushfyKind = "sms" | "rcs_basic" | "rcs_single";
const PATH: Record<PushfyKind, string> = {
  sms: "/webapi",
  rcs_basic: "/apircsbasic",
  rcs_single: "/apircs",
};

/** What goes to Pushfy for a rendered message of a channel. */
export interface PushfyPlan {
  kind: PushfyKind;
  text: string;
  /** set when the message had to be adapted (shown in the CRM) */
  sentAs?: "rcs_single_first_card" | "rcs_basic_no_button" | undefined;
}

const URL_RE = /https?:\/\/\S+/gi;
/** Title / body must not contain URLs: in the flat format URLs are the separators. */
const plain = (t: string | null | undefined) =>
  (t ?? "")
    .replace(URL_RE, "")
    .replace(/[ \t]+/g, " ")
    .trim();

interface RenderedRcs {
  kind?: string;
  text?: string | null;
  cards?: { title?: string; description?: string; media_url?: string | null }[];
  suggestions?: { type?: string; text?: string; url?: string | null }[];
}

/**
 * RCS text → Basic. Card → Single: "TITLE image BODY link BUTTON", the button being the first
 * link suggestion (Single has one action). A carousel goes as its first card. Without a link
 * button the image would be read as the button link, so the card goes as Basic text instead.
 */
export function pushfyPlan(channel: "sms" | "rcs", rendered: unknown): PushfyPlan {
  const r = rendered as RenderedRcs & { text?: string | null };
  if (channel === "sms") return { kind: "sms", text: r.text ?? "" };
  if (r.kind === "text") return { kind: "rcs_basic", text: r.text ?? "" };
  const card = r.cards?.[0] ?? {};
  const title = plain(card.title);
  const body = plain(card.description);
  const cta = (r.suggestions ?? []).find((x) => x.type === "url" && x.url);
  const sentAs = r.kind === "carousel" ? ("rcs_single_first_card" as const) : undefined;
  if (!cta?.url) {
    return {
      kind: "rcs_basic",
      text: [title, body].filter(Boolean).join("\n"),
      sentAs: "rcs_basic_no_button",
    };
  }
  const text = [title, card.media_url ?? "", body, cta.url, plain(cta.text) || "Abrir"]
    .filter(Boolean)
    .join(" ");
  return { kind: "rcs_single", text, sentAs };
}

export async function pushfySend(
  c: PushfyConfig,
  kind: PushfyKind,
  msg: { to: string; text: string; extId: string },
): Promise<PushfySendResult> {
  const message: Record<string, unknown> = {
    destinations: [{ to: msg.to }],
    text: msg.text,
    ext_id: msg.extId, // idempotency / status lookup (DLR webhooks echo it)
  };
  if (kind === "sms" && c.smsFrom) message["from"] = c.smsFrom;
  try {
    const r = await call(c, "POST", PATH[kind], { messages: [message] });
    const b = (r.body ?? {}) as { accepted?: number };
    if (r.status >= 200 && r.status < 300) {
      // SMS: { accepted }; RCS: one item per accepted message. Anything else (an error
      // message with 200, an empty body) is not taken as sent: the answer is kept to see why.
      const accepted = Array.isArray(r.body)
        ? r.body.length
        : typeof b.accepted === "number"
          ? b.accepted
          : 0;
      const detail = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return accepted > 0
        ? { ok: true, permanent: false, httpStatus: r.status, body: r.body }
        : {
            ok: false,
            permanent: true,
            httpStatus: r.status,
            body: r.body,
            error: `Pushfy não aceitou a mensagem: ${detail?.slice(0, 300) || "resposta vazia"}`,
          };
    }
    const permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
    const detail = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok: false,
      permanent,
      httpStatus: r.status,
      body: r.body,
      error: `Pushfy respondeu ${r.status}: ${detail?.slice(0, 300)}`,
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

export interface PushfyOptout {
  phone_number: string;
  optout_via: string | null;
  opted_out_at: string | null;
}

/** All opt-outs (optionally of one day, YYYY-MM-DD), following the 1000-row pages. */
export async function pushfyOptouts(c: PushfyConfig, date?: string): Promise<PushfyOptout[]> {
  const out: PushfyOptout[] = [];
  for (let offset = 0; offset < 200_000; offset += 1000) {
    const q = new URLSearchParams({
      limit: "1000",
      offset: String(offset),
      ...(date ? { date } : {}),
    });
    const r = await call(c, "GET", `/optoutapi?${q}`);
    if (r.status === 404) break; // "nothing found" (plain text)
    if (r.status !== 200) throw new Error(`Pushfy /optoutapi respondeu ${r.status}`);
    const rows = Array.isArray(r.body) ? (r.body as PushfyOptout[]) : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export async function pushfyBalance(
  c: PushfyConfig,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const r = await call(c, "GET", "/balance");
  return { ok: r.status === 200, status: r.status, body: r.body };
}

/** Current status of a message at Pushfy, by the ext_id sent with it (our message_id). */
export async function pushfyStatus(
  c: PushfyConfig,
  extId: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const r = await call(c, "GET", `/getstatus?${new URLSearchParams({ ext_id: extId })}`);
  return { ok: r.status === 200, status: r.status, body: r.body };
}
