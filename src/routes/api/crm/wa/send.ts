import { createFileRoute } from "@tanstack/react-router";

/**
 * Sends from the WhatsApp screen: POST { chat, text?, media?: { data (base64 or data: URL),
 * mimetype, fileName? }, quoted?: { id, text } }. Text, photo, video, document or voice note.
 */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export const Route = createFileRoute("/api/crm/wa/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const out = (body: unknown, status = 200) => json(body, status, a.session.setCookies);
        if (!a.canSend) return out({ error: "forbidden" }, 403);
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { waSend } = await import("@/server/crm/wa-inbox");
        const b = (await request.json().catch(() => ({}))) as {
          chat?: string;
          text?: string;
          media?: { data?: string; mimetype?: string; fileName?: string } | null;
          quoted?: { id?: string; text?: string } | null;
        };
        const text = (b.text ?? "").trim();
        const data = (b.media?.data ?? "").replace(/^data:[^,]*,/, "");
        if (!b.chat || (!text && !data))
          return out(
            { error: "invalid_request", message: "Escreva uma mensagem ou anexe um arquivo." },
            400,
          );
        if (data && data.length * 0.75 > MAX_MEDIA_BYTES)
          return out({ error: "too_large", message: "Arquivo maior que 16 MB." }, 400);
        const c = await crmRpc("crm_wa_chat", { p_chat: b.chat });
        const chat = c.data as {
          instance: string;
          remote_jid: string;
          phone: string | null;
        } | null;
        if (c.error || !chat) return out({ error: "not_found" }, 404);
        const r = await waSend(a.cfg, chat.instance, {
          number: chat.phone ?? chat.remote_jid,
          text: text || null,
          media: data
            ? {
                data,
                mimetype: b.media?.mimetype || "application/octet-stream",
                fileName: b.media?.fileName ?? null,
              }
            : null,
          quoted: b.quoted?.id ? { id: b.quoted.id, text: b.quoted.text ?? null } : null,
        });
        if (!r.ok) return out({ error: "evolution", message: r.error }, 502);
        const msg = {
          wa_id: r.id,
          remote_jid: chat.remote_jid,
          phone: chat.phone,
          from_me: true,
          push_name: null,
          type: r.type,
          body: r.body,
          media: r.media,
          status: "sent",
          at: new Date().toISOString(),
          sent_by: a.session.email,
        };
        const s = await crmRpc("crm_wa_ingest", {
          p_instance: chat.instance,
          p_messages: [msg],
          p_statuses: [],
          p_history: false,
        });
        if (s.error) console.error("[crm] whatsapp send stored", s.error.message);
        return out({ ok: true, message: msg });
      },
    },
  },
});
