import { createFileRoute } from "@tanstack/react-router";

/**
 * Worker for the CRM event store: retries failed events (with backoff) and
 * processes events stored without inline processing (e.g. legacy backfill).
 *
 * It also re-evaluates time-based customer state (DUE, CHURN_RISK, CHURNED),
 * executes due automation runs, advances flows and delivers their messages
 * (DRY_RUN until a channel webhook is configured).
 *
 * Auth: "Authorization: Bearer <secret>", where the secret is CRON_SECRET
 * (Vercel Cron sends it automatically, with GET) or the Lovable cron secret.
 * POST body (optional JSON): { "limit": 200, "backfill": true }
 */
async function run(request: Request) {
  const { env } = await import("@/server/crm/supabase.server");
  const secrets = [
    env("CRON_SECRET"),
    env("LOVABLE_CRON_SECRET"),
    env("LOVABLE_CRON_SECRET_PREVIOUS"),
  ].filter((x): x is string => !!x);
  if (!secrets.length)
    return new Response("Server configuration error: set CRON_SECRET", { status: 500 });
  const token = /^Bearer ([^\s,]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return new Response("Unauthorized", { status: 401 });
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  if (!secrets.some((s) => timingSafeEqual(digest(token), digest(s)))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (request.method === "POST" ? await request.json().catch(() => ({})) : {}) as {
    limit?: number;
    backfill?: boolean;
  };
  const {
    backfillFromLegacy,
    processPending,
    refreshCustomers,
    runAutomations,
    runFlows,
    syncPushfyOptouts,
  } = await import("@/server/crm/pipeline.server");
  const backfilled = body.backfill ? await backfillFromLegacy() : 0;
  const summary = await processPending({
    limit: Math.min(Math.max(body.limit ?? 200, 1), 1000),
  });
  const refreshed = await refreshCustomers();
  const automations = await runAutomations();
  // opt-outs first, so nobody who answered PARAR gets the next marketing message
  const optouts = await syncPushfyOptouts().catch((e: Error) => ({ error: e.message }));
  const flows = await runFlows();
  return Response.json({
    ok: true,
    backfilled,
    ...summary,
    refreshed,
    automations,
    optouts,
    flows,
  });
}

export const Route = createFileRoute("/api/cron/crm-process")({
  server: {
    handlers: {
      GET: ({ request }) => run(request),
      POST: ({ request }) => run(request),
    },
  },
});
