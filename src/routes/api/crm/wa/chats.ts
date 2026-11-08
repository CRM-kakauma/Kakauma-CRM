import { createFileRoute } from "@tanstack/react-router";

/**
 * Conversations of a WhatsApp number. GET ?instance=&q=&filter=all|unread|archived
 * POST { instance, phone, name? }: opens a conversation with a number (new contact).
 */
export const Route = createFileRoute("/api/crm/wa/chats")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const u = new URL(request.url);
        const r = await crmRpc("crm_wa_chats", {
          p_instance: u.searchParams.get("instance") ?? "",
          p_search: u.searchParams.get("q") || null,
          p_filter: u.searchParams.get("filter") || "all",
          p_limit: 300,
        });
        if (r.error)
          return json({ error: "database", message: r.error.message }, 500, a.session.setCookies);
        return json({ chats: r.data ?? [] }, 200, a.session.setCookies);
      },
      POST: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        if (!a.canSend) return json({ error: "forbidden" }, 403, a.session.setCookies);
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { phoneToJid } = await import("@/server/crm/wa-inbox");
        const b = (await request.json().catch(() => ({}))) as {
          instance?: string;
          phone?: string;
          name?: string;
        };
        const p = phoneToJid(b.phone ?? "");
        if (!b.instance || !p)
          return json(
            {
              error: "invalid_request",
              message: "Número inválido: use DDD + número (ex.: 31 99999-9999).",
            },
            400,
            a.session.setCookies,
          );
        const r = await crmRpc("crm_wa_open_chat", {
          p_instance: b.instance,
          p_remote_jid: p.jid,
          p_phone: p.phone,
          p_name: b.name ?? null,
        });
        if (r.error)
          return json({ error: "database", message: r.error.message }, 500, a.session.setCookies);
        return json({ ok: true, chat_id: r.data }, 200, a.session.setCookies);
      },
    },
  },
});
