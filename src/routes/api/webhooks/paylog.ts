import { createFileRoute } from "@tanstack/react-router";

/**
 * Paylog Webhook V2 (logistics): delivery steps of the orders, "Entrega realizada" among them.
 * Register in Paylog → Ferramentas → Integrações → Webhooks V2:
 *   URL  https://<crm>/api/webhooks/paylog
 *   events  Rastreamento (shipment.*)
 * and put the secret Paylog shows once in PAYLOG_WEBHOOK_SECRET — or, without it, a token of our
 * own in PAYLOG_WEBHOOK_TOKEN and the URL …/api/webhooks/paylog?token=<the same value>.
 *
 * Every delivery is signed: X-Webhook-Signature = sha256=<HMAC-SHA256 of the raw body>.
 * The legacy Webhook V1 ("E-mails e Webhook": Pedido Entregue / Rastreio, unsigned, {"dados":…})
 * is accepted too, with the token in the URL; see paylogV1ToV2.
 * Paylog retries on anything other than 2xx; repeats are deduplicated by idempotency_key.
 */

export const Route = createFileRoute("/api/webhooks/paylog")({
  server: {
    handlers: {
      // opening the URL in a browser: tells whether it is ready
      GET: async () => {
        const { env } = await import("@/server/crm/supabase.server");
        const ready = !!(env("PAYLOG_WEBHOOK_SECRET") || env("PAYLOG_WEBHOOK_TOKEN"));
        return Response.json(
          {
            ok: ready,
            message: ready
              ? "Webhook da Paylog ativo. Cadastre esta URL em Webhooks V2 da Paylog (eventos de Rastreamento)."
              : "Falta PAYLOG_WEBHOOK_SECRET (segredo que a Paylog mostra ao criar o webhook) ou PAYLOG_WEBHOOK_TOKEN (token na URL ?token=…).",
          },
          { status: ready ? 200 : 503 },
        );
      },
      POST: async ({ request }) => {
        const rawBody = await request.text();
        const { env } = await import("@/server/crm/supabase.server");
        const { checkPaylogAuth } = await import("@/server/crm/paylog");
        const denied = await checkPaylogAuth({
          secret: env("PAYLOG_WEBHOOK_SECRET"),
          token: env("PAYLOG_WEBHOOK_TOKEN"),
          rawBody,
          signature: request.headers.get("x-webhook-signature"),
          url: request.url,
          dev: import.meta.env.DEV,
        });
        if (denied) return denied;

        const { normalizePaylog, isPaylogV1, paylogV1Kind, paylogV1ToV2, isPaylogResend } =
          await import("@/server/crm/normalize/paylog");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = null; // ingestWebhook keeps it in the dead-letter queue
        }
        // Webhook V1 (legacy screen "E-mails e Webhook"): converted to the V2 shape
        const v1 = parsed !== null && isPaylogV1(parsed);
        let body = rawBody;
        if (v1) {
          const kind = paylogV1Kind(parsed, new URL(request.url).searchParams.get("tipo"));
          parsed = paylogV1ToV2(parsed, kind, new Date().toISOString());
          body = JSON.stringify(parsed);
        }

        // "Enviar teste" in the Paylog panel: synthetic data, never stored as a real delivery
        // (V2: X-Webhook-Test; V1: X-PayLog-Test and pedido_id "TEST-…")
        const isTest =
          request.headers.get("x-webhook-test") === "true" ||
          request.headers.get("x-paylog-test") === "true" ||
          (v1 &&
            /^TEST-/i.test(
              String((parsed as { order?: { pedido_id?: unknown } }).order?.pedido_id ?? ""),
            ));
        if (isTest) {
          if (parsed === null)
            return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
          const n = normalizePaylog(parsed, { receivedAt: new Date().toISOString() });
          return Response.json({
            ok: true,
            test: true,
            webhook: v1 ? "v1" : "v2",
            message: "Webhook da Paylog conectado. Evento de teste recebido e não gravado.",
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
          const resend = parsed !== null && !v1 && isPaylogResend(parsed);
          const result = await ingestWebhook("paylog", body, { backfill: resend });
          // a delivery may start a flow ("Entrega realizada"): its first message goes now
          if (result.status < 300) {
            const { runFlows } = await import("@/server/crm/pipeline.server");
            // V1 gives up after 10 s (and never retries): a few only, the cron does the rest
            await runFlows(v1 ? 10 : 50, v1 ? 3_000 : 10_000).catch((e) =>
              console.error("[crm] flows after paylog event", e),
            );
          }
          return Response.json(result.body, { status: result.status });
        } catch (e) {
          // 5xx: Paylog V2 delivers again (up to 4 tries); V1 does not retry (recover with the
          // API: Operação → Paylog: recuperar entregas)
          console.error("[crm] paylog webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
