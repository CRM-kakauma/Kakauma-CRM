import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/crm/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { logout, json } = await import("@/server/crm/auth.server");
        return json({ ok: true }, 200, await logout(request));
      },
    },
  },
});
