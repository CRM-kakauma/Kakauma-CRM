import { createFileRoute } from "@tanstack/react-router";

/**
 * B4you webhook endpoint for the CRM event store.
 *
 * Shared secret B4YOU_WEBHOOK_TOKEN (required in production, optional in local
 * development): the request must carry it as ?token=... or in the
 * x-webhook-token header.
 */
export const Route = createFileRoute("/api/webhooks/b4you")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
          const given =
            request.headers.get("x-webhook-token") ?? url.searchParams.get("token") ?? "";
          const { createHash, timingSafeEqual } = await import("node:crypto");
          const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
          if (!timingSafeEqual(digest(given), digest(expected))) {
            return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
          }
        }
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
