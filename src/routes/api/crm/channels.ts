import { createFileRoute } from "@tanstack/react-router";

/**
 * GET: which sending channels are connected (no secrets), plus the Pushfy balance.
 * POST: full opt-out sync from Pushfy (admin).
 */
export const Route = createFileRoute("/api/crm/channels")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { env } = await import("@/server/crm/supabase.server");
        const { pushfyConfig } = await import("@/server/crm/pipeline.server");
        const { pushfyBalance } = await import("@/server/crm/pushfy");
        const session = await getSession(request);
        if (!session) return json({ error: "unauthenticated" }, 401);
        const cfg = pushfyConfig();
        let balance: unknown = null;
        let balanceError: string | null = null;
        if (cfg) {
          try {
            const b = await pushfyBalance(cfg);
            if (b.ok) balance = b.body;
            else
              balanceError =
                b.status === 401 ? "Token da Pushfy inválido" : `Pushfy respondeu ${b.status}`;
          } catch (e) {
            balanceError = (e as Error).message;
          }
        }
        return json(
          {
            pushfy: cfg
              ? {
                  configured: true,
                  live: cfg.live,
                  sms_from: cfg.smsFrom ?? null,
                  balance,
                  balance_error: balanceError,
                }
              : { configured: false },
            webhook: { configured: !!env("CRM_AUTOMATION_WEBHOOK_URL") },
          },
          200,
          session.setCookies,
        );
      },
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { syncPushfyOptouts } = await import("@/server/crm/pipeline.server");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role !== "admin")
            return json({ error: "forbidden" }, 403, session.setCookies);
          const r = await syncPushfyOptouts(true);
          if (!r)
            return json(
              { error: "not_configured", message: "Configure PUSHFY_API_TOKEN." },
              400,
              session.setCookies,
            );
          return json({ ok: true, ...r }, 200, session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
