import { createFileRoute } from "@tanstack/react-router";

/**
 * Paylog Webhook V2 (logistics): delivery steps of the orders, "Entrega realizada" among them.
 * Register in Paylog → Ferramentas → Integrações → Webhooks V2:
 *   URL  https://<crm>/api/webhooks/paylog
 *   events  Rastreamento (shipment.*)
 * and put the secret Paylog shows once in PAYLOG_WEBHOOK_SECRET.
 *
 * Every delivery is signed: X-Webhook-Signature = sha256=<HMAC-SHA256 of the raw body>.
 * Paylog retries on anything other than 2xx; repeats are deduplicated by idempotency_key.
 */

export const Route = createFileRoute("/api/webhooks/paylog")({
  server: {
    handlers: {
      // opening the URL in a browser: tells whether it is ready
      GET: async () => {
        const { env } = await import("@/server/crm/supabase.server");
        const ready = !!env("PAYLOG_WEBHOOK_SECRET");
        return Response.json(
          {
            ok: ready,
            message: ready
              ? "Webhook da Paylog ativo. Cadastre esta URL em Webhooks V2 da Paylog (eventos de Rastreamento)."
              : "Falta PAYLOG_WEBHOOK_SECRET: cole no servidor o segredo que a Paylog mostra ao criar o webhook.",
          },
          { status: ready ? 200 : 503 },
        );
      },
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const { env } = await import("@/server/crm/supabase.server");
        const { checkPaylogSignature } = await import("@/server/crm/paylog");
        const denied = await checkPaylogSignature(
          env("PAYLOG_WEBHOOK_SECRET"),
          rawBody,
          request.headers.get("x-webhook-signature"),
          import.meta.env.DEV,
        );
        if (denied) return denied;

        // "Enviar teste" in the Paylog panel: synthetic data, never stored as a real delivery
        if (request.headers.get("x-webhook-test") === "true") {
          const { normalizePaylog } = await import("@/server/crm/normalize/paylog");
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
          }
          const n = normalizePaylog(parsed, { receivedAt: new Date().toISOString() });
          return Response.json({
            ok: true,
            test: true,
            message: "Assinatura correta. Evento de teste recebido e não gravado.",
            event: n.event?.source_event_name ?? null,
            would_be: n.event?.fulfillment
              ? `FULFILLMENT_${n.event.fulfillment.status}`
              : "ignorado (só eventos de Rastreamento viram fatos)",
          });
        }

        const { ingestWebhook } = await import("@/server/crm/pipeline.server");
        try {
          // batch resend ("Reenvio por data / produto"): history, it only frees customers
          // already waiting for the delivery in a flow
          const { isPaylogResend } = await import("@/server/crm/normalize/paylog");
          let resend = false;
          try {
            resend = isPaylogResend(JSON.parse(rawBody));
          } catch {
            // invalid JSON: ingestWebhook keeps it in the dead-letter queue
          }
          const result = await ingestWebhook("paylog", rawBody, { backfill: resend });
          // a delivery may start a flow ("Entrega realizada"): its first message goes now
          if (result.status < 300) {
            const { runFlows } = await import("@/server/crm/pipeline.server");
            await runFlows(50).catch((e) => console.error("[crm] flows after paylog event", e));
          }
          return Response.json(result.body, { status: result.status });
        } catch (e) {
          // 5xx: Paylog delivers again (up to 4 tries), nothing is lost
          console.error("[crm] paylog webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
