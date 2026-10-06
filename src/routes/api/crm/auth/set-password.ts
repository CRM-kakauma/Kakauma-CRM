import { createFileRoute } from "@tanstack/react-router";

/** Invite / recovery: { access_token, password } → sets the password and opens a session. */
export const Route = createFileRoute("/api/crm/auth/set-password")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { setPasswordWithToken, json } = await import("@/server/crm/auth.server");
        const body = (await request.json().catch(() => ({}))) as {
          access_token?: unknown;
          password?: unknown;
        };
        if (
          typeof body.access_token !== "string" ||
          !body.access_token ||
          typeof body.password !== "string"
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        if (body.password.length < 10)
          return json({ error: "weak_password", message: "Use pelo menos 10 caracteres." }, 400);
        try {
          const r = await setPasswordWithToken(request, body.access_token, body.password);
          if (!r.ok)
            return json(
              { error: r.error, message: r.message },
              r.error === "no_access" ? 403 : 400,
            );
          return json({ email: r.session.email, role: r.session.role }, 200, r.session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
