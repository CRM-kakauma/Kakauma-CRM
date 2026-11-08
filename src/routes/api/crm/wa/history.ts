import { createFileRoute } from "@tanstack/react-router";

/** Everything the customer of a conversation did (purchases, carts, Pix, deliveries…): GET ?chat= */
export const Route = createFileRoute("/api/crm/wa/history")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const chat = new URL(request.url).searchParams.get("chat");
        if (!chat) return json({ error: "invalid_request" }, 400, a.session.setCookies);
        const r = await crmRpc("crm_wa_history", { p_chat: chat, p_limit: 80 });
        if (r.error)
          return json({ error: "database", message: r.error.message }, 500, a.session.setCookies);
        return json({ history: r.data ?? [] }, 200, a.session.setCookies);
      },
    },
  },
});
