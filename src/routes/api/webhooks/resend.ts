import { createFileRoute } from "@tanstack/react-router";

/**
 * Resend webhooks: e-mail delivered, opened, clicked, bounced, marked as spam.
 * Register in Resend (Webhooks → Add endpoint): https://<crm>/api/webhooks/resend
 * and put its signing secret (whsec_…) in RESEND_WEBHOOK_SECRET. Every request is
 * checked against that signature. Repeated events are ignored by the database.
 */
export const Route = createFileRoute("/api/webhooks/resend")({
  server: {
    handlers: {
      // opening the URL in a browser: tells whether it is ready
      GET: async () => {
        const { env } = await import("@/server/crm/supabase.server");
        return Response.json(
          env("RESEND_WEBHOOK_SECRET")
            ? {
                ok: true,
                message:
                  "Webhook do Resend ativo. Cadastre esta URL no Resend (Webhooks) com os eventos de e-mail.",
              }
            : { ok: false, error: "RESEND_WEBHOOK_SECRET não configurado no servidor" },
          { status: env("RESEND_WEBHOOK_SECRET") ? 200 : 503 },
        );
      },
      POST: async ({ request }) => {
        const { env, crmRpc } = await import("@/server/crm/supabase.server");
        const { verifySvix } = await import("@/server/crm/svix");
        const secret = env("RESEND_WEBHOOK_SECRET");
        if (!secret)
          return Response.json(
            { ok: false, error: "RESEND_WEBHOOK_SECRET não configurado no servidor" },
            { status: 503 },
          );
        const raw = await request.text();
        const headers = {
          id: request.headers.get("svix-id"),
          timestamp: request.headers.get("svix-timestamp"),
          signature: request.headers.get("svix-signature"),
        };
        if (!verifySvix(secret, headers, raw))
          return Response.json({ ok: false, error: "assinatura inválida" }, { status: 401 });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        try {
          const r = await crmRpc("crm_resend_event", { p_event_id: headers.id, p_payload: body });
          if (r.error) throw new Error(r.error.message);
          return Response.json({ ok: true, result: r.data });
        } catch (e) {
          // 5xx: Resend delivers again later, nothing is lost
          console.error("[crm] resend webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
