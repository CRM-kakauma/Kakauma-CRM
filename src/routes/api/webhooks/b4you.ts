import { createFileRoute } from "@tanstack/react-router";

/**
 * B4you webhook endpoint for the CRM event store.
 *
 * Shared secret B4YOU_WEBHOOK_TOKEN (required in production, optional in local
 * development): the request must carry it as ?token=... or in the
 * x-webhook-token header.
 *
 * GET (opening the URL in a browser) only reports whether the endpoint is
 * configured and the token is right; events arrive by POST.
 */
async function checkToken(request: Request): Promise<Response | null> {
  const { env } = await import("@/server/crm/supabase.server");
  const expected = env("B4YOU_WEBHOOK_TOKEN");
  // In production the endpoint is public: without a token anyone could post fake sales.
  if (!expected && !import.meta.env.DEV) {
    return Response.json(
      { ok: false, error: "B4YOU_WEBHOOK_TOKEN não configurado no servidor" },
      { status: 503 },
    );
  }
  if (expected) {
    const url = new URL(request.url);
    const given = request.headers.get("x-webhook-token") ?? url.searchParams.get("token") ?? "";
    const { createHash, timingSafeEqual } = await import("node:crypto");
    const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
    if (!timingSafeEqual(digest(given), digest(expected))) {
      return Response.json(
        {
          ok: false,
          error: "unauthorized",
          detail: "Token ausente ou diferente do B4YOU_WEBHOOK_TOKEN",
        },
        { status: 401 },
      );
    }
  }
  return null;
}

export const Route = createFileRoute("/api/webhooks/b4you")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await checkToken(request);
        if (denied) return denied;
        return Response.json({
          ok: true,
          message:
            "Webhook da B4you ativo e token correto. Cadastre esta mesma URL na B4you — os eventos chegam por POST.",
        });
      },
      POST: async ({ request }) => {
        const denied = await checkToken(request);
        if (denied) return denied;
        const { ingestWebhook } = await import("@/server/crm/pipeline.server");
        try {
          const result = await ingestWebhook("b4you", await request.text());
          return Response.json(result.body, { status: result.status });
        } catch (e) {
          // JSON 5xx: the B4you retries, nothing is lost
          console.error("[crm] webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
