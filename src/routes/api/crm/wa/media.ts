import { createFileRoute } from "@tanstack/react-router";

/** A photo, audio, video or document of a conversation: GET ?chat=&id=<WhatsApp message id>. */
export const Route = createFileRoute("/api/crm/wa/media")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { waMedia } = await import("@/server/crm/wa-inbox");
        const u = new URL(request.url);
        const chatId = u.searchParams.get("chat");
        const id = u.searchParams.get("id");
        if (!chatId || !id) return json({ error: "invalid_request" }, 400, a.session.setCookies);
        const c = await crmRpc("crm_wa_chat", { p_chat: chatId });
        const chat = c.data as { instance: string } | null;
        if (c.error || !chat) return json({ error: "not_found" }, 404, a.session.setCookies);
        const r = await waMedia(a.cfg, chat.instance, id);
        if (!r.ok) return json({ error: "evolution", message: r.error }, 502, a.session.setCookies);
        const { Buffer } = await import("node:buffer");
        const bytes = Buffer.from(r.data, "base64");
        const headers = new Headers({
          "content-type": r.mimetype.split(";")[0]!,
          "cache-control": "private, max-age=86400",
        });
        for (const c2 of a.session.setCookies) headers.append("set-cookie", c2);
        return new Response(bytes, { status: 200, headers });
      },
    },
  },
});
