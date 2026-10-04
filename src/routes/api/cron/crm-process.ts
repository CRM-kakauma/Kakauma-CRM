import { createFileRoute } from "@tanstack/react-router";

/**
 * Worker for the CRM event store: retries failed events (with backoff) and
 * processes events stored without inline processing (e.g. legacy backfill).
 * Authenticated with the Lovable cron secret (Authorization: Bearer ...).
 *
 * It also re-evaluates time-based customer state (DUE, CHURN_RISK, CHURNED)
 * and executes due automation runs (DRY_RUN until a channel webhook is configured).
 *
 * Body (optional JSON): { "limit": 200, "backfill": true }
 */
export const Route = createFileRoute("/api/cron/crm-process")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authenticateCronRequest } = await import("@/integrations/supabase/cron-auth");
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const body = (await request.json().catch(() => ({}))) as {
          limit?: number;
          backfill?: boolean;
        };
        const { backfillFromLegacy, processPending, refreshCustomers, runAutomations } =
          await import("@/server/crm/pipeline.server");
        const backfilled = body.backfill ? await backfillFromLegacy() : 0;
        const summary = await processPending({
          limit: Math.min(Math.max(body.limit ?? 200, 1), 1000),
        });
        const refreshed = await refreshCustomers();
        const automations = await runAutomations();
        return Response.json({ ok: true, backfilled, ...summary, refreshed, automations });
      },
    },
  },
});
