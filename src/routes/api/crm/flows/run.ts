import { createFileRoute } from "@tanstack/react-router";

/**
 * "Processar agora": advances every flow and delivers the queued messages now,
 * without waiting for the scheduled job (operator or admin).
 */
export const Route = createFileRoute("/api/crm/flows/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { atLeast, getSession, json } = await import("@/server/crm/auth.server");
        const { runFlows } = await import("@/server/crm/pipeline.server");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (!atLeast(session.role, "operator"))
            return json({ error: "forbidden" }, 403, session.setCookies);
          const run = await runFlows(200);
          const count = (s: string) => run.messages.filter((m) => m.status === s).length;
          return json(
            {
              ok: true,
              advanced: run.advanced,
              messages: run.messages.length,
              sent: count("SENT"),
              dry_run: count("DRY_RUN"),
              skipped: count("SKIPPED"),
              failed: count("FAILED"),
            },
            200,
            session.setCookies,
          );
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
