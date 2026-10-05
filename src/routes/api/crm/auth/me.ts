import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/crm/auth/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getSession, json, loginDisabled } = await import("@/server/crm/auth.server");
        const { demoMode } = await import("@/server/crm/supabase.server");
        let demoState: string | undefined;
        if (demoMode()) {
          // Start building the demo database right away (first request of the server).
          const demo = await import("@/server/crm/demo/demo.server");
          void demo.demoRpc().catch(() => undefined);
          demoState = demo.demoStatus().state;
        }
        try {
          const s = await getSession(request);
          if (!s) return json({ error: "unauthenticated" }, 401);
          return json(
            {
              email: s.email,
              role: s.role,
              login: !loginDisabled(),
              demo: demoMode(),
              demo_state: demoState,
            },
            200,
            s.setCookies,
          );
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
