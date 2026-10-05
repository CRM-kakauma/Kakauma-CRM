import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/crm/auth/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getSession, json, loginDisabled } = await import("@/server/crm/auth.server");
        try {
          const s = await getSession(request);
          if (!s) return json({ error: "unauthenticated" }, 401);
          return json({ email: s.email, role: s.role, login: !loginDisabled() }, 200, s.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
