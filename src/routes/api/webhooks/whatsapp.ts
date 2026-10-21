import { createFileRoute } from "@tanstack/react-router";

/**
 * WhatsApp Cloud API webhooks (Meta): message statuses (sent, delivered, read, failed) and
 * messages from customers (PARAR / SAIR → opt-out of WhatsApp).
 * In the Meta app (WhatsApp → Configuração → Webhooks): URL https://<crm>/api/webhooks/whatsapp,
 * "Verificar token" = WHATSAPP_VERIFY_TOKEN, and subscribe the "messages" field. Every POST is
 * checked against X-Hub-Signature-256 with the app secret (WHATSAPP_APP_SECRET).
 */
export const Route = createFileRoute("/api/webhooks/whatsapp")({
  server: {
    handlers: {
      // Meta's check when saving the URL (hub.challenge); opened in a browser: tells whether it is ready
      GET: async ({ request }) => {
        const { env } = await import("@/server/crm/supabase.server");
        const url = new URL(request.url);
        const verify = env("WHATSAPP_VERIFY_TOKEN");
        const mode = url.searchParams.get("hub.mode");
        if (mode) {
          const { createHash, timingSafeEqual } = await import("node:crypto");
          const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
          const given = url.searchParams.get("hub.verify_token") ?? "";
          if (mode === "subscribe" && verify && timingSafeEqual(digest(given), digest(verify)))
            return new Response(url.searchParams.get("hub.challenge") ?? "", {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          return Response.json(
            { ok: false, error: "Verificar token diferente do WHATSAPP_VERIFY_TOKEN" },
            { status: 403 },
          );
        }
        const missing = ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"].filter((k) => !env(k));
        return Response.json(
          missing.length
            ? { ok: false, error: `Falta configurar no servidor: ${missing.join(", ")}` }
            : {
                ok: true,
                message:
                  "Webhook do WhatsApp ativo. Cadastre esta URL no app da Meta (WhatsApp → Configuração) e assine o campo messages.",
              },
          { status: missing.length ? 503 : 200 },
        );
      },
      POST: async ({ request }) => {
        const { env, crmRpc } = await import("@/server/crm/supabase.server");
        const { handleWhatsappWebhook, verifyMetaSignature } =
          await import("@/server/crm/whatsapp");
        const secret = env("WHATSAPP_APP_SECRET");
        if (!secret)
          return Response.json(
            { ok: false, error: "WHATSAPP_APP_SECRET não configurado no servidor" },
            { status: 503 },
          );
        const raw = await request.text();
        if (!(await verifyMetaSignature(secret, request.headers.get("x-hub-signature-256"), raw)))
          return Response.json({ ok: false, error: "assinatura inválida" }, { status: 401 });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        try {
          const r = await handleWhatsappWebhook(crmRpc, body);
          // a status may continue a flow waiting on it ("Aguardar entrega")
          if (r.matched) {
            const { runFlows } = await import("@/server/crm/pipeline.server");
            await runFlows(100).catch((e) => console.error("[crm] flows after whatsapp event", e));
          }
          return Response.json({ ok: true, received: r.results.length });
        } catch (e) {
          // 5xx: Meta delivers again later, nothing is lost
          console.error("[crm] whatsapp webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
