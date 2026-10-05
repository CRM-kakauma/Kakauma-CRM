import { createFileRoute } from "@tanstack/react-router";

/** Single entry point for the CRM screens: session + role check, then the allow-listed database function. */
export const Route = createFileRoute("/api/crm/rpc")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { authorizeRpc } = await import("@/server/crm/gateway");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          const body = (await request.json().catch(() => ({}))) as { fn?: unknown; args?: unknown };
          const auth = authorizeRpc(body.fn, body.args, session);
          if (!auth.ok) return json({ error: auth.error }, auth.status, session.setCookies);
          const { data, error } = await crmRpc(auth.fn, auth.args);
          if (error)
            return json({ error: "rpc_error", message: error.message }, 400, session.setCookies);
          return json({ data }, 200, session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
