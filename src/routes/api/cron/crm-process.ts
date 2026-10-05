import { createFileRoute } from "@tanstack/react-router";

/**
 * Worker for the CRM event store: retries failed events (with backoff) and
 * processes events stored without inline processing (e.g. legacy backfill).
 * Authenticated with the Lovable cron secret (Authorization: Bearer ...).
 *
 * It also re-evaluates time-based customer state (DUE, CHURN_RISK, CHURNED)
 * executes due automation runs, advances flows and delivers their messages
 * (DRY_RUN until a channel webhook is configured).
 *
 * Body (optional JSON): { "limit": 200, "backfill": true }
 */
export const Route = createFileRoute("/api/cron/crm-process")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Same check as the Lovable cron helper, but the secret may also come from .env (local dev).
        const { env } = await import("@/server/crm/supabase.server");
        const secrets = [env("LOVABLE_CRON_SECRET"), env("LOVABLE_CRON_SECRET_PREVIOUS")].filter(
          (x): x is string => !!x,
        );
        if (!secrets.length) return new Response("Server configuration error", { status: 500 });
        const token = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        if (!token) return new Response("Unauthorized", { status: 401 });
        const { createHash, timingSafeEqual } = await import("node:crypto");
        const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
        if (!secrets.some((s) => timingSafeEqual(digest(token), digest(s)))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const body = (await request.json().catch(() => ({}))) as {
          limit?: number;
          backfill?: boolean;
        };
        const { backfillFromLegacy, processPending, refreshCustomers, runAutomations, runFlows } =
          await import("@/server/crm/pipeline.server");
        const backfilled = body.backfill ? await backfillFromLegacy() : 0;
        const summary = await processPending({
          limit: Math.min(Math.max(body.limit ?? 200, 1), 1000),
        });
        const refreshed = await refreshCustomers();
        const automations = await runAutomations();
        const flows = await runFlows();
        return Response.json({ ok: true, backfilled, ...summary, refreshed, automations, flows });
      },
    },
  },
});
