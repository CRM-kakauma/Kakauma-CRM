/**
 * Signature of Resend webhooks (Svix): headers svix-id, svix-timestamp and
 * svix-signature ("v1,<base64> v1,<base64>…"). The signed content is
 * "<id>.<timestamp>.<raw body>", HMAC-SHA256 with the secret after "whsec_"
 * (base64). Timestamps older or newer than 5 minutes are refused (replays).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySvix(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
