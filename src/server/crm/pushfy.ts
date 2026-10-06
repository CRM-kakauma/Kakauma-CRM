/**
 * Pushfy (SMS / RCS) — only what the API reference documents
 * (https://portal.pushfy.com/docs/#/pt/api-reference):
 *
 *   POST /webapi       SMS   { messages: [{ destinations: [{ to }], from?, text, ext_id? }] } → { accepted, queued }
 *   POST /rcs          RCS   same envelope with `text` (rich cards: format not documented yet)
 *   GET  /optoutapi    opt-outs (date?, limit ≤ 1000, offset); 404 = empty list (plain text)
 *   GET  /balance      balances per channel
 *
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

export async function pushfySend(
  c: PushfyConfig,
  channel: "sms" | "rcs",
  msg: { to: string; text: string; extId: string },
): Promise<PushfySendResult> {
  const message: Record<string, unknown> = {
    destinations: [{ to: msg.to }],
    text: msg.text,
    ext_id: msg.extId, // idempotency / status lookup
  };
  if (channel === "sms" && c.smsFrom) message["from"] = c.smsFrom;
  try {
    const r = await call(c, "POST", channel === "sms" ? "/webapi" : "/rcs", {
      messages: [message],
    });
    const b = (r.body ?? {}) as { accepted?: number };
    if (r.status >= 200 && r.status < 300) {
      const accepted = typeof b.accepted === "number" ? b.accepted : 1;
      return accepted > 0
        ? { ok: true, permanent: false, httpStatus: r.status, body: r.body }
        : {
            ok: false,
            permanent: true,
            httpStatus: r.status,
            body: r.body,
            error: "Pushfy não aceitou a mensagem",
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
