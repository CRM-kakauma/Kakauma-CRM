/** Paylog Webhook V2: signature check (HMAC-SHA256 of the raw body, header X-Webhook-Signature). */

/** Checks the Paylog signature over the exact bytes received. Null when valid. */
export async function checkPaylogSignature(
  secret: string | undefined,
  rawBody: string,
  header: string | null,
  dev = false,
): Promise<Response | null> {
  if (!secret) {
    if (dev) return null;
    return Response.json(
      { ok: false, error: "PAYLOG_WEBHOOK_SECRET não configurado no servidor" },
      { status: 503 },
    );
  }
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const { Buffer } = await import("node:buffer");
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"),
  );
  const given = Buffer.from((header ?? "").trim());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json(
      {
        ok: false,
        error: "unauthorized",
        detail: "Assinatura X-Webhook-Signature ausente ou diferente (PAYLOG_WEBHOOK_SECRET)",
      },
      { status: 401 },
    );
  }
  return null;
}
