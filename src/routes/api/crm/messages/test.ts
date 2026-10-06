import { createFileRoute } from "@tanstack/react-router";

/**
 * Test send of one SMS / RCS template to a given number through Pushfy
 * (operator or admin). Works with PUSHFY_API_TOKEN even before PUSHFY_LIVE,
 * so the channel can be checked without messaging customers. Audited.
 * Body: { template_key, to, customer_id? } — customer_id fills the variables.
 */
export const Route = createFileRoute("/api/crm/messages/test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { pushfyConfig } = await import("@/server/crm/pipeline.server");
        const { pushfySend, toPushfyNumber } = await import("@/server/crm/pushfy");
        const { renderMessage, SAMPLE_CUSTOMER } = await import("@/lib/crm-messages");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role === "viewer")
            return json({ error: "forbidden" }, 403, session.setCookies);
          const cfg = pushfyConfig();
          if (!cfg)
            return json(
              {
                error: "not_configured",
                message: "Configure PUSHFY_API_TOKEN na Vercel para enviar.",
              },
              400,
              session.setCookies,
            );
          const body = (await request.json().catch(() => ({}))) as {
            template_key?: unknown;
            to?: unknown;
            customer_id?: unknown;
          };
          const to = toPushfyNumber(typeof body.to === "string" ? body.to : "");
          if (!to || typeof body.template_key !== "string")
            return json(
              { error: "invalid_request", message: "Informe um celular com DDD." },
              400,
              session.setCookies,
            );

          const list = await crmRpc("crm_list_templates", { p_include_archived: true });
          if (list.error) throw new Error(list.error.message);
          const tpl = (
            (list.data ?? []) as { key: string; channel: string; content: unknown }[]
          ).find((t) => t.key === body.template_key);
          if (!tpl)
            return json(
              { error: "not_found", message: "Mensagem não encontrada." },
              404,
              session.setCookies,
            );
          if (tpl.channel !== "sms" && tpl.channel !== "rcs")
            return json(
              {
                error: "unsupported",
                message: "Envio real disponível por enquanto para SMS e RCS.",
              },
              400,
              session.setCookies,
            );

          let vars: Record<string, unknown> = SAMPLE_CUSTOMER;
          if (typeof body.customer_id === "string" && body.customer_id) {
            const c = await crmRpc("crm_message_customer", { p_customer_id: body.customer_id });
            if (c.data) vars = c.data as Record<string, unknown>;
          }
          const rendered = renderMessage(tpl.channel, tpl.content as never, vars) as {
            kind?: string;
            text?: string;
          };
          if (tpl.channel === "rcs" && rendered.kind !== "text") {
            return json(
              {
                error: "unsupported",
                message:
                  "RCS com cartão/carrossel ainda não é enviado: falta a documentação desse formato na Pushfy. RCS de texto já funciona.",
              },
              400,
              session.setCookies,
            );
          }
          const { randomUUID } = await import("node:crypto");
          const sent = await pushfySend(cfg, tpl.channel, {
            to,
            text: rendered.text ?? "",
            extId: `teste-${randomUUID()}`,
          });
          await crmRpc("crm_log_test_message", {
            p_template: tpl.key,
            p_channel: tpl.channel,
            p_to: to,
            p_status: sent.ok ? "enviado" : "falhou",
            p_detail: sent.ok ? null : (sent.error ?? null),
            p_actor: session.email,
          });
          return json(
            sent.ok
              ? { ok: true, to, response: sent.body }
              : { ok: false, error: "send_failed", message: sent.error, response: sent.body },
            sent.ok ? 200 : 502,
            session.setCookies,
          );
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
