import { createFileRoute } from "@tanstack/react-router";

/**
 * Test send of one saved template (operator or admin), audited:
 *   SMS / RCS → a phone, through Pushfy (RCS card with image via /apircs);
 *   e-mail    → an address, through Resend.
 * Works before PUSHFY_LIVE / EMAIL_LIVE, so a channel can be checked without
 * messaging customers. Body: { template_key, to, customer_id? } — customer_id fills the variables.
 */
export const Route = createFileRoute("/api/crm/messages/test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { pushfyConfig, resendConfig } = await import("@/server/crm/pipeline.server");
        const { isEmail, resendSend } = await import("@/server/crm/resend");
        const { pushfyPlan, pushfySend, toPushfyNumber } = await import("@/server/crm/pushfy");
        const { renderMessage, SAMPLE_CUSTOMER } = await import("@/lib/crm-messages");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role === "viewer")
            return json({ error: "forbidden" }, 403, session.setCookies);
          const fail = (status: number, error: string, message: string) =>
            json({ error, message }, status, session.setCookies);

          const body = (await request.json().catch(() => ({}))) as {
            template_key?: unknown;
            to?: unknown;
            customer_id?: unknown;
          };
          if (typeof body.template_key !== "string")
            return fail(400, "invalid_request", "Mensagem não informada.");
          const list = await crmRpc("crm_list_templates", { p_include_archived: true });
          if (list.error) throw new Error(list.error.message);
          const tpl = (
            (list.data ?? []) as { key: string; channel: string; content: unknown }[]
          ).find((t) => t.key === body.template_key);
          if (!tpl) return fail(404, "not_found", "Mensagem não encontrada.");

          let vars: Record<string, unknown> = SAMPLE_CUSTOMER;
          if (typeof body.customer_id === "string" && body.customer_id) {
            const c = await crmRpc("crm_message_customer", { p_customer_id: body.customer_id });
            if (c.data) vars = c.data as Record<string, unknown>;
          }
          const rawTo = typeof body.to === "string" ? body.to.trim() : "";
          const { randomUUID } = await import("node:crypto");
          const audit = (to: string, ok: boolean, detail: string | null) =>
            crmRpc("crm_log_test_message", {
              p_template: tpl.key,
              p_channel: tpl.channel,
              p_to: to,
              p_status: ok ? "enviado" : "falhou",
              p_detail: detail,
              p_actor: session.email,
            });

          if (tpl.channel === "email") {
            const cfg = resendConfig();
            if (!cfg)
              return fail(
                400,
                "not_configured",
                "Configure RESEND_API_KEY e EMAIL_FROM na Vercel para enviar e-mails.",
              );
            if (!isEmail(rawTo)) return fail(400, "invalid_request", "Informe um e-mail válido.");
            const e = renderMessage("email", tpl.content as never, vars) as {
              subject: string;
              html: string;
              text: string;
              from_name?: string;
            };
            const sent = await resendSend(cfg, {
              to: rawTo,
              subject: `[TESTE] ${e.subject}`,
              html: e.html,
              text: e.text,
              fromName: e.from_name,
              idempotencyKey: `teste-${randomUUID()}`,
            });
            // the audit keeps only the domain of the address
            await audit(`*@${rawTo.split("@")[1]}`, sent.ok, sent.ok ? null : (sent.error ?? null));
            return json(
              sent.ok
                ? { ok: true, to: rawTo, provider: "resend", response: sent.body }
                : { ok: false, error: "send_failed", message: sent.error, response: sent.body },
              sent.ok ? 200 : 502,
              session.setCookies,
            );
          }

          if (tpl.channel !== "sms" && tpl.channel !== "rcs")
            return fail(
              400,
              "unsupported",
              "Envio real disponível para SMS, RCS e e-mail (WhatsApp ainda não).",
            );
          const cfg = pushfyConfig();
          if (!cfg)
            return fail(400, "not_configured", "Configure PUSHFY_API_TOKEN na Vercel para enviar.");
          const to = toPushfyNumber(rawTo);
          if (!to) return fail(400, "invalid_request", "Informe um celular com DDD.");
          const rendered = renderMessage(tpl.channel, tpl.content as never, vars);
          const plan = pushfyPlan(tpl.channel, rendered);
          const sent = await pushfySend(cfg, plan.kind, {
            to,
            text: plan.text,
            extId: `teste-${randomUUID()}`,
          });
          await audit(to, sent.ok, sent.ok ? null : (sent.error ?? null));
          return json(
            sent.ok
              ? {
                  ok: true,
                  to,
                  provider: "pushfy",
                  response: sent.body,
                  endpoint: plan.kind,
                  ...(plan.sentAs ? { sent_as: plan.sentAs } : {}),
                }
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
