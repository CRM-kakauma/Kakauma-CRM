/**
 * Resend (e-mail) — https://resend.com/docs/api-reference/emails/send-email
 *
 *   POST https://api.resend.com/emails   Authorization: Bearer <RESEND_API_KEY>
 *   { from: "Nome <email@dominio-verificado>", to: [..], subject, html, text, reply_to? }
 *   → 200 { id }.  Idempotency-Key header: the same key never sends twice (24 h).
 *
 * The From address must be on a domain verified in Resend (DNS records).
 */

export interface ResendConfig {
  apiKey: string;
  /** address on a verified domain, e.g. contato@kakauma.com.br */
  from: string;
  replyTo?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface ResendResult {
  ok: boolean;
  /** true when retrying cannot help (invalid address, unverified domain, bad key) */
  permanent: boolean;
  httpStatus: number | null;
  body: unknown;
  error?: string;
}

export const isEmail = (v: string | null | undefined) =>
  !!v && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(v.trim());

/** "Kakauma <contato@kakauma.com.br>" — the display name cannot carry quotes or brackets. */
export function fromHeader(name: string | null | undefined, address: string) {
  const n = (name ?? "").replace(/["<>\r\n]/g, "").trim();
  return n ? `${n} <${address}>` : address;
}

export async function resendSend(
  c: ResendConfig,
  msg: {
    to: string;
    subject: string;
    html: string;
    text: string;
    fromName?: string | null | undefined;
    idempotencyKey: string;
  },
): Promise<ResendResult> {
  const body = {
    from: fromHeader(msg.fromName, c.from),
    to: [msg.to.trim()],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(c.replyTo ? { reply_to: c.replyTo } : {}),
  };
  try {
    const res = await (c.fetchImpl ?? fetch)(
      `${(c.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "")}/emails`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": msg.idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* plain text */
    }
    const id = (parsed as { id?: unknown } | null)?.id;
    if (res.ok && typeof id === "string") {
      return { ok: true, permanent: false, httpStatus: res.status, body: parsed };
    }
    const m = (parsed as { message?: unknown } | null)?.message;
    const detail =
      typeof m === "string" ? m : typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    return {
      ok: false,
      permanent: res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429),
      httpStatus: res.status,
      body: parsed,
      error: `Resend respondeu ${res.status}: ${String(detail).slice(0, 300)}`,
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
