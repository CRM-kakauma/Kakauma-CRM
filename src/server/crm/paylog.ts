/**
 * Paylog Webhook V2: who may post deliveries.
 *
 *   - PAYLOG_WEBHOOK_SECRET: the secret Paylog shows once when the webhook is created; every delivery
 *     then carries X-Webhook-Signature = sha256=<HMAC-SHA256 of the raw body>.
 *   - PAYLOG_WEBHOOK_TOKEN: when the secret was not copied, a token of our own in the URL
 *     (…/api/webhooks/paylog?token=…), as with the B4you.
 *
 * Either one is enough. With neither configured the endpoint refuses everything (503) outside
 * local development, so nobody can post fake deliveries.
 */
export async function checkPaylogAuth(opts: {
  secret: string | undefined;
  token: string | undefined;
  rawBody: string;
  signature: string | null;
  url: string;
  dev?: boolean;
}): Promise<Response | null> {
  const { createHash, createHmac, timingSafeEqual } = await import("node:crypto");
  const { Buffer } = await import("node:buffer");
  const same = (a: string, b: string) => {
    const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
    return timingSafeEqual(digest(a), digest(b));
  };
  const secret = opts.secret?.trim();
  const token = opts.token?.trim();
  if (!secret && !token) {
    if (opts.dev) return null;
    return Response.json(
      {
        ok: false,
        error: "PAYLOG_WEBHOOK_SECRET (ou PAYLOG_WEBHOOK_TOKEN) não configurado no servidor",
      },
      { status: 503 },
    );
  }
  const signature = (opts.signature ?? "").trim();
  if (secret && signature) {
    const expected =
      "sha256=" +
      createHmac("sha256", secret).update(Buffer.from(opts.rawBody, "utf8")).digest("hex");
    if (same(signature, expected)) return null;
  }
  const given = new URL(opts.url).searchParams.get("token") ?? "";
  if (token && given && same(given, token)) return null;
  return Response.json(
    {
      ok: false,
      error: "unauthorized",
      detail: secret
        ? "Assinatura X-Webhook-Signature ausente ou diferente do PAYLOG_WEBHOOK_SECRET"
        : "Token ausente ou diferente do PAYLOG_WEBHOOK_TOKEN (?token=…)",
    },
    { status: 401 },
  );
}
