import { createFileRoute } from "@tanstack/react-router";

/**
 * What Pushfy says about one message right now (GET /getstatus?ext_id=<message_id>).
 * Used by "Ver na Pushfy" to tell "accepted by Pushfy" from "delivered to the phone".
 */
export const Route = createFileRoute("/api/crm/messages/provider-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { pushfyConfig } = await import("@/server/crm/pipeline.server");
        const { pushfyStatus } = await import("@/server/crm/pushfy");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          const id = new URL(request.url).searchParams.get("id") ?? "";
          if (!/^[0-9a-f-]{36}$/i.test(id))
            return json({ error: "invalid_request" }, 400, session.setCookies);
          const cfg = pushfyConfig();
          if (!cfg)
            return json(
              { error: "not_configured", message: "PUSHFY_API_TOKEN não configurado." },
              400,
              session.setCookies,
            );
          const r = await pushfyStatus(cfg, id);
          return json({ ok: r.ok, http_status: r.status, pushfy: r.body }, 200, session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
