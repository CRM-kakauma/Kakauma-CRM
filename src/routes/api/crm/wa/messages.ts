import { createFileRoute } from "@tanstack/react-router";

/**
 * One conversation. GET ?chat=&before=: the contact and a page of messages.
 * POST { chat, action }: read (marks it read here and on the phone) · archive · unarchive ·
 * history (older messages kept by Evolution, page by page).
 */
export const Route = createFileRoute("/api/crm/wa/messages")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const u = new URL(request.url);
        const chat = u.searchParams.get("chat");
        if (!chat) return json({ error: "invalid_request" }, 400, a.session.setCookies);
        const [c, m] = await Promise.all([
          crmRpc("crm_wa_chat", { p_chat: chat }),
          crmRpc("crm_wa_messages", {
            p_chat: chat,
            p_before: u.searchParams.get("before") || null,
            p_limit: 60,
          }),
        ]);
        const err = c.error ?? m.error;
        if (err)
          return json({ error: "database", message: err.message }, 500, a.session.setCookies);
        return json({ chat: c.data, messages: m.data ?? [] }, 200, a.session.setCookies);
      },
      POST: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const wa = await import("@/server/crm/wa-inbox");
        const out = (body: unknown, status = 200) => json(body, status, a.session.setCookies);
        const b = (await request.json().catch(() => ({}))) as {
          chat?: string;
          action?: string;
          page?: number;
        };
        if (!b.chat) return out({ error: "invalid_request" }, 400);
        const c = await crmRpc("crm_wa_chat", { p_chat: b.chat });
        const chat = c.data as { instance: string; remote_jid: string; unread: number } | null;
        if (c.error || !chat) return out({ error: "not_found" }, 404);
        switch (b.action) {
          case "read": {
            if (chat.unread > 0) {
              await crmRpc("crm_wa_update_chat", { p_chat: b.chat, p_unread: 0 });
              // blue ticks on the customer's phone too (best effort)
              const m = await crmRpc("crm_wa_messages", { p_chat: b.chat, p_limit: 20 });
              const inbound = ((m.data ?? []) as { wa_id: string; from_me: boolean }[])
                .filter((x) => !x.from_me)
                .slice(-Math.min(chat.unread, 20))
                .map((x) => ({ remoteJid: chat.remote_jid, id: x.wa_id }));
              await wa.waMarkRead(a.cfg, chat.instance, inbound);
            }
            return out({ ok: true });
          }
          case "archive":
          case "unarchive":
            await crmRpc("crm_wa_update_chat", {
              p_chat: b.chat,
              p_archived: b.action === "archive",
            });
            return out({ ok: true });
          case "history": {
            const r = await wa.waHistory(
              a.cfg,
              chat.instance,
              chat.remote_jid,
              Math.max(1, b.page ?? 1),
            );
            if (!r.ok) return out({ error: "evolution", message: r.error }, 502);
            if (r.messages.length) {
              const s = await crmRpc("crm_wa_ingest", {
                p_instance: chat.instance,
                p_messages: r.messages,
                p_statuses: [],
                p_history: true,
              });
              if (s.error) return out({ error: "database", message: s.error.message }, 500);
            }
            return out({ ok: true, received: r.messages.length, pages: r.pages });
          }
          default:
            return out({ error: "invalid_request" }, 400);
        }
      },
    },
  },
});
