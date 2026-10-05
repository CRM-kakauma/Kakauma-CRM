import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/crm/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { login, json } = await import("@/server/crm/auth.server");
        const body = (await request.json().catch(() => ({}))) as {
          email?: unknown;
          password?: unknown;
        };
        if (
          typeof body.email !== "string" ||
          typeof body.password !== "string" ||
          !body.email ||
          !body.password
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        try {
          const r = await login(request, body.email.trim().toLowerCase(), body.password);
          if (!r.ok) return json({ error: r.error }, r.error === "no_access" ? 403 : 401);
          return json({ email: r.session.email, role: r.session.role }, 200, r.session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
