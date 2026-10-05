import { createFileRoute } from "@tanstack/react-router";

/** Invite a CRM user (Supabase Auth account + role). Admin only; not available in demo mode. */
export const Route = createFileRoute("/api/crm/admin/users")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json, createCrmUser } = await import("@/server/crm/auth.server");
        const { demoMode } = await import("@/server/crm/supabase.server");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role !== "admin")
            return json({ error: "forbidden" }, 403, session.setCookies);
          if (demoMode()) {
            return json(
              {
                error: "demo_mode",
                message:
                  "No modo demonstração não há login: configure o Supabase do CRM para criar usuários.",
              },
              400,
              session.setCookies,
            );
          }
          const body = (await request.json().catch(() => ({}))) as {
            email?: unknown;
            password?: unknown;
            role?: unknown;
          };
          const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
          const password = typeof body.password === "string" ? body.password : "";
          const role =
            body.role === "admin" || body.role === "operator" || body.role === "viewer"
              ? body.role
              : null;
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 10 || !role) {
            return json(
              {
                error: "invalid_request",
                message: "E-mail válido, senha com 10+ caracteres e papel.",
              },
              400,
              session.setCookies,
            );
          }
          await createCrmUser(email, password, role);
          return json({ ok: true, email, role }, 200, session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
