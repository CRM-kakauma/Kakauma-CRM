import { createFileRoute } from "@tanstack/react-router";

/**
 * Test send of one saved template (operator or admin), audited:
 *   SMS / RCS → a phone, through Pushfy (RCS card with image via /apircs; a refused RCS
 *               goes as its "SMS alternativo");
 *   e-mail    → an address, through Resend;
 *   WhatsApp  → a phone, through Evolution API when connected, else the Cloud API (Meta).
 * Works before PUSHFY_LIVE / EMAIL_LIVE, so a channel can be checked without
 * messaging customers. Body: { template_key, to, customer_id? } — customer_id fills the variables.
 */
export const Route = createFileRoute("/api/crm/messages/test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { atLeast, getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { evolutionConfig, pushfyConfig, resendConfig, whatsappConfig } =
          await import("@/server/crm/pipeline.server");
        const { isEmail, resendSend } = await import("@/server/crm/resend");
        const { pushfyPlan, pushfySend, toPushfyNumber } = await import("@/server/crm/pushfy");
        const { renderMessage, SAMPLE_CUSTOMER } = await import("@/lib/crm-messages");
        const { mapRenderedLinks, storeLinks, tagRendered, utmSlug } =
          await import("@/lib/crm-utm");
        const { linkTracking } = await import("@/server/crm/pipeline.server");
        /**
         * SMS, RCS and WhatsApp tests go out as a customer would get them: store links become
         * CRM short links (manual short links, campaign "teste"). Without tracking: as they are.
         */
        let actor: string | null = null;
        const shorten = async <T>(channel: string, rendered: T): Promise<T> => {
          const links = linkTracking();
          if (!links || channel === "email") return rendered;
          const codes: Record<string, string> = {};
          for (const url of storeLinks(channel, rendered)) {
            const r = await crmRpc("crm_create_short_link", { p_url: url, p_actor: actor });
            if (!r.error && r.data) codes[url] = (r.data as { code: string }).code;
          }
          return mapRenderedLinks(channel, rendered, (u) =>
            codes[u] ? `${links.base}/l/${codes[u]}` : u,
          );
        };
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (!atLeast(session.role, "operator"))
            return json({ error: "forbidden" }, 403, session.setCookies);
          actor = session.email;
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
            (list.data ?? []) as { key: string; name: string; channel: string; content: unknown }[]
          ).find((t) => t.key === body.template_key);
          if (!tpl) return fail(404, "not_found", "Mensagem não encontrada.");

          let vars: Record<string, unknown> = SAMPLE_CUSTOMER;
          if (typeof body.customer_id === "string" && body.customer_id) {
            const c = await crmRpc("crm_message_customer", { p_customer_id: body.customer_id });
            if (c.data) vars = c.data as Record<string, unknown>;
          }
          // store links get the same UTMs as a real send, with campaign "teste"
          const utm = {
            channel: tpl.channel,
            campaign: "teste",
            content: utmSlug(tpl.name) || tpl.key,
          };
          vars = { ...vars, canal: tpl.channel, nome_fluxo: "teste", chave: utm.content };
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
            const e = tagRendered(
              "email",
              renderMessage("email", tpl.content as never, vars),
              utm,
            ) as {
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

          if (tpl.channel === "whatsapp" && evolutionConfig()) {
            const { evolutionSend } = await import("@/server/crm/evolution");
            const to = toPushfyNumber(rawTo);
            if (!to) return fail(400, "invalid_request", "Informe um celular com DDD.");
            const rendered = await shorten(
              "whatsapp",
              tagRendered("whatsapp", renderMessage("whatsapp", tpl.content as never, vars), utm),
            );
            const sent = await evolutionSend(evolutionConfig()!, to, rendered);
            await audit(to, sent.ok, sent.ok ? null : (sent.error ?? null));
            return json(
              sent.ok
                ? { ok: true, to, provider: "evolution", response: sent.body }
                : { ok: false, error: "send_failed", message: sent.error, response: sent.body },
              sent.ok ? 200 : 502,
              session.setCookies,
            );
          }

          if (tpl.channel === "whatsapp") {
            const { whatsappSend } = await import("@/server/crm/whatsapp");
            const cfg = whatsappConfig();
            if (!cfg)
              return fail(
                400,
                "not_configured",
                "Configure WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID na Vercel para enviar.",
              );
            const to = toPushfyNumber(rawTo);
            if (!to) return fail(400, "invalid_request", "Informe um celular com DDD.");
            const rendered = await shorten(
              "whatsapp",
              tagRendered("whatsapp", renderMessage("whatsapp", tpl.content as never, vars), utm),
            );
            const sent = await whatsappSend(cfg, to, rendered);
            await audit(to, sent.ok, sent.ok ? null : (sent.error ?? null));
            return json(
              sent.ok
                ? { ok: true, to, provider: "whatsapp", response: sent.body }
                : { ok: false, error: "send_failed", message: sent.error, response: sent.body },
              sent.ok ? 200 : 502,
              session.setCookies,
            );
          }

          if (tpl.channel !== "sms" && tpl.channel !== "rcs")
            return fail(400, "unsupported", "Canal sem envio de teste.");
          const cfg = pushfyConfig();
          if (!cfg)
            return fail(400, "not_configured", "Configure PUSHFY_API_TOKEN na Vercel para enviar.");
          const to = toPushfyNumber(rawTo);
          if (!to) return fail(400, "invalid_request", "Informe um celular com DDD.");
          const rendered = await shorten(
            tpl.channel,
            tagRendered(tpl.channel, renderMessage(tpl.channel, tpl.content as never, vars), utm),
          );
          const plan = pushfyPlan(tpl.channel, rendered);
          const sent = await pushfySend(cfg, plan.kind, {
            to,
            text: plan.text,
            extId: `teste-${randomUUID()}`,
          });
          // RCS refused: the template's "SMS alternativo" goes instead, as it would for a customer
          const smsText =
            !sent.ok && tpl.channel === "rcs"
              ? String((rendered as { fallback_sms?: unknown }).fallback_sms ?? "").trim()
              : "";
          if (smsText) {
            const sms = await pushfySend(cfg, "sms", {
              to,
              text: smsText,
              extId: `teste-${randomUUID()}`,
            });
            await audit(
              to,
              sms.ok,
              sms.ok
                ? `RCS falhou (${sent.error}); foi o SMS alternativo`
                : `RCS: ${sent.error} · SMS: ${sms.error}`,
            );
            return json(
              sms.ok
                ? {
                    ok: true,
                    to,
                    provider: "pushfy",
                    response: sms.body,
                    endpoint: "sms",
                    sent_as: "sms_fallback",
                    rcs_error: sent.error,
                  }
                : {
                    ok: false,
                    error: "send_failed",
                    message: `RCS: ${sent.error} · SMS: ${sms.error}`,
                    response: sms.body,
                  },
              sms.ok ? 200 : 502,
              session.setCookies,
            );
          }
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
