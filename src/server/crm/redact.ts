/**
 * Removes card secrets before a payload is stored. Everything else is kept
 * byte-for-byte: the raw store must preserve the original evidence, but a full
 * card number or CVV must never reach the database.
 */

const SECRET_KEY = /^(cvv|cvc|cvv2|security_?code|card_?cvv|card_?security_?code)$/i;
const CARD_NUMBER_KEY = /^(card_?number|number|pan|full_?number)$/i;
const CARD_CONTEXT = /card|cartao|cartão/i;

function looksLikeCardNumber(v: unknown) {
  if (typeof v !== "string" && typeof v !== "number") return false;
  const digits = String(v).replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digits);
}

export function redactCardData(payload: unknown): { payload: unknown; redacted: string[] } {
  const redacted: string[] = [];

  function walk(node: unknown, path: string, inCard: boolean): unknown {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`, inCard));
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      const cardScope = inCard || CARD_CONTEXT.test(k);
      if (SECRET_KEY.test(k) && v != null && v !== "") {
        out[k] = "[REDACTED]";
        redacted.push(p);
      } else if (
        (CARD_NUMBER_KEY.test(k) && cardScope && looksLikeCardNumber(v)) ||
        (/card_?number/i.test(k) && looksLikeCardNumber(v))
      ) {
        out[k] = "[REDACTED]";
        redacted.push(p);
      } else {
        out[k] = walk(v, p, cardScope);
      }
    }
    return out;
  }

  const result = walk(payload, "", false);
  return { payload: redacted.length ? result : payload, redacted };
}
