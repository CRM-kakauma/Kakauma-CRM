import type { Rpc } from "./pipeline.ts";
import { renderMessage, VARIABLES, type Channel, type Content } from "../../lib/crm-messages.ts";
import { renderTemplate } from "../../lib/crm-template.ts";
import {
  pushfyOptouts,
  pushfyPlan,
  pushfySend,
  toPushfyNumber,
  type PushfyConfig,
} from "./pushfy.ts";
import { isEmail, resendSend, type ResendConfig } from "./resend.ts";
import { whatsappSend, type WhatsappConfig } from "./whatsapp.ts";
import { evolutionSend, type EvolutionConfig } from "./evolution.ts";
import { mapRenderedLinks, storeLinks, tagRendered, utmSlug } from "../../lib/crm-utm.ts";

/**
 * Flow worker: advances due flow enrollments, then delivers queued messages.
 *
 * The SQL side already skipped what must not go out (opt-out, no contact,
 * daily cap, outside the send window). Here each message is rendered with the
 * same code the editor's simulator uses, then:
 *   - SMS and RCS go through Pushfy: RCS text as Basic, a card as Single (image + button),
 *     a carousel as its first card; an RCS refused or reported as not delivered goes again
 *     as its "SMS alternativo". All this when PUSHFY_API_TOKEN is set and
 *     PUSHFY_LIVE=true (with the token but not live: DRY_RUN, nothing is sent —
 *     except test launches, which go out so the channel can be checked);
 *   - e-mail goes through Resend when RESEND_API_KEY + EMAIL_FROM are set and EMAIL_LIVE=true
 *     (test launches go out even before that);
 *   - WhatsApp goes through Evolution API (unofficial: plain text / media, any time) when
 *     EVOLUTION_API_URL + EVOLUTION_API_KEY + EVOLUTION_INSTANCE are set; otherwise
 *   - WhatsApp goes through the official Cloud API (Meta) when WHATSAPP_TOKEN +
 *     WHATSAPP_PHONE_NUMBER_ID are set and WHATSAPP_LIVE=true (tests before that): an
 *     approved template, or free text, which Meta only delivers inside the 24 h window;
 *   - other channels go to CRM_AUTOMATION_WEBHOOK_URL (HMAC-signed) when set;
 *   - otherwise DRY_RUN: the rendered content is stored and visible in the CRM.
 */

interface ClaimedMessage {
  message_id: string;
  channel: Channel | "team";
  purpose: string;
  template_key: string | null;
  content: Content | null;
  team_text: string | null;
  customer: Record<string, unknown>;
  flow_key: string | null;
  /** fired by "Disparar teste" for contacts chosen by hand */
  is_test?: boolean;
}

export interface MessageOptions {
  limit?: number;
  pushfy?: (PushfyConfig & { live: boolean }) | undefined;
  resend?: (ResendConfig & { live: boolean }) | undefined;
  whatsapp?: (WhatsappConfig & { live: boolean }) | undefined;
  /** WhatsApp through Evolution API; takes the place of the official API when set */
  evolution?: (EvolutionConfig & { live: boolean }) | undefined;
  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  /** click tracking: links become <base>/l/<code>; e-mail only with a domain of the brand */
  links?: { base: string; email: boolean } | undefined;
  fetchImpl?: typeof fetch;
}

export interface FlowSummary {
  advanced: number;
  messages: { message_id: string; channel: string; status: string; error?: string }[];
}

async function sign(secret: string, body: string) {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** The RCS template's "SMS alternativo", already filled with the customer's data. */
function rcsFallbackText(rendered: unknown): string {
  return String((rendered as { fallback_sms?: unknown } | null)?.fallback_sms ?? "").trim();
}

/**
 * RCS the operator later reported as not delivered (Pushfy webhook) goes again as its
 * "SMS alternativo". The database hands each message out once.
 */
export async function runRcsFallbacks(rpc: Rpc, opts: MessageOptions = {}) {
  const out: FlowSummary["messages"] = [];
  if (!opts.pushfy) return out;
  const { data, error } = await rpc("crm_claim_rcs_fallbacks", { p_limit: opts.limit ?? 100 });
  if (error) throw new Error(error.message);
  for (const m of (data ?? []) as {
    message_id: string;
    recipient: string | null;
    fallback_sms: string | null;
    is_test: boolean;
  }[]) {
    const done = async (status: string, result: Record<string, unknown>, err?: string) => {
      const r = await rpc("crm_rcs_fallback_done", {
        p_message_id: m.message_id,
        p_status: status,
        p_result: result,
      });
      if (r.error) throw new Error(r.error.message);
      out.push({
        message_id: m.message_id,
        channel: "sms",
        status,
        ...(err ? { error: err } : {}),
      });
    };
    const to = toPushfyNumber(m.recipient);
    const text = (m.fallback_sms ?? "").trim();
    if (!opts.pushfy.live && !m.is_test) await done("DRY_RUN", { reason: "pushfy_not_live" });
    else if (!to || !text) await done("SKIPPED", {}, !to ? "invalid_phone" : "empty_message");
    else {
      const sms = await pushfySend(opts.pushfy, "sms", { to, text, extId: m.message_id });
      const result = { to, http_status: sms.httpStatus, response: sms.body };
      if (sms.ok) await done("SENT", result);
      else await done("FAILED", result, sms.error ?? "falha no envio");
    }
  }
  return out;
}

const ORDER_SAMPLE = Object.fromEntries(
  VARIABLES.filter((v) => v.group === "pedido").map((v) => [v.key, v.sample]),
);

/** Order variables per message. Without the database function (update not applied yet): none. */
async function messageVars(rpc: Rpc, msgs: ClaimedMessage[]) {
  const map = new Map<string, Record<string, unknown>>();
  const ids = msgs.filter((m) => m.channel !== "team").map((m) => m.message_id);
  if (!ids.length) return map;
  const { data, error } = await rpc("crm_message_vars", { p_message_ids: ids });
  if (error) {
    console.error("[crm] order variables", error.message);
    return map;
  }
  for (const r of (data ?? []) as { message_id: string; vars: Record<string, unknown> | null }[])
    map.set(r.message_id, r.vars ?? {});
  return map;
}

/**
 * Each store link of the message becomes a CRM link that counts the click (per message and
 * customer) and then opens the store page. Without the database function: links as they are.
 */
async function trackLinks<T>(
  rpc: Rpc,
  messageId: string,
  channel: string,
  rendered: T,
  base: string,
) {
  const urls = storeLinks(channel, rendered);
  if (!urls.length) return rendered;
  const { data, error } = await rpc("crm_track_links", { p_message_id: messageId, p_urls: urls });
  if (error || !data) {
    if (error) console.error("[crm] click tracking", error.message);
    return rendered;
  }
  const codes = data as Record<string, string>;
  return mapRenderedLinks(channel, rendered, (u) => (codes[u] ? `${base}/l/${codes[u]}` : u));
}

/** Flow and message names for the UTMs (keys stand in if the lists cannot be read). */
async function utmNames(rpc: Rpc, msgs: ClaimedMessage[]) {
  const flows = new Map<string, string>();
  const templates = new Map<string, string>();
  if (!msgs.some((m) => m.channel !== "team")) return { flows, templates };
  const [f, t] = await Promise.all([
    rpc("crm_list_flows", {}),
    rpc("crm_list_templates", { p_include_archived: true }),
  ]);
  for (const r of (f.data ?? []) as { key: string; name: string }[]) flows.set(r.key, r.name);
  for (const r of (t.data ?? []) as { key: string; name: string }[]) templates.set(r.key, r.name);
  return { flows, templates };
}

export async function runMessages(rpc: Rpc, opts: MessageOptions = {}) {
  // never holds up the queue (e.g. the database update with this function not applied yet)
  const fallbacks = await runRcsFallbacks(rpc, opts).catch((e: Error) => {
    console.error("[crm] rcs sms fallback", e.message);
    return [];
  });
  const { data, error } = await rpc("crm_claim_messages", { p_limit: opts.limit ?? 100 });
  if (error) throw new Error(error.message);
  const out: FlowSummary["messages"] = [...fallbacks];
  const doFetch = opts.fetchImpl ?? fetch;
  const claimed = (data ?? []) as ClaimedMessage[];
  const orderVars = await messageVars(rpc, claimed);
  const names = await utmNames(rpc, claimed);

  for (const m of claimed) {
    // order data ({{order_number}}, {{product_name}}…); a test contact without orders gets the samples
    const order = orderVars.get(m.message_id) ?? {};
    // UTM values: the flow's and the message's names (keys when a name is missing)
    const utm = {
      channel: m.channel,
      campaign: utmSlug(names.flows.get(m.flow_key ?? "") ?? m.flow_key) || null,
      content: utmSlug(names.templates.get(m.template_key ?? "") ?? m.template_key) || null,
    };
    m.customer = {
      ...(m.is_test && !Object.keys(order).length ? ORDER_SAMPLE : order),
      ...m.customer,
      // for links written with their own tracking: {{canal}}, {{nome_fluxo}}, {{chave}}
      canal: m.channel,
      nome_fluxo: utm.campaign ?? "",
      chave: utm.content ?? "",
    };
    let rendered =
      m.channel === "team"
        ? { text: renderTemplate(m.team_text ?? "", m.customer) }
        : tagRendered(m.channel, renderMessage(m.channel, m.content as Content, m.customer), utm);
    // store links become CRM click links (/l/<code>) when the message really goes out
    const goesOut =
      m.channel === "email"
        ? !!opts.resend && (opts.resend.live || !!m.is_test)
        : m.channel === "whatsapp"
          ? (() => {
              const wa = opts.evolution ?? opts.whatsapp;
              return !!wa && (wa.live || !!m.is_test);
            })()
          : (m.channel === "sms" || m.channel === "rcs") &&
            !!opts.pushfy &&
            (opts.pushfy.live || !!m.is_test);
    if (goesOut && opts.links && (m.channel !== "email" || opts.links.email))
      rendered = await trackLinks(rpc, m.message_id, m.channel, rendered, opts.links.base);
    const recipient =
      m.channel === "team"
        ? "equipe"
        : m.channel === "email"
          ? ((m.customer["email"] as string | null) ?? null)
          : m.channel === "whatsapp"
            ? ((m.customer["whatsapp"] as string | null) ??
              (m.customer["phone"] as string | null) ??
              null)
            : ((m.customer["phone"] as string | null) ?? null);
    const complete = async (
      status: string,
      result: unknown,
      err: string | null = null,
      retry = true,
    ) => {
      const r = await rpc("crm_complete_message", {
        p_message_id: m.message_id,
        p_status: status,
        p_recipient: recipient,
        p_rendered: rendered,
        p_result: result ?? null,
        p_error: err,
        p_retry: retry,
      });
      out.push({
        message_id: m.message_id,
        channel: m.channel,
        status: String(r.data ?? status),
        ...(err ? { error: err } : {}),
      });
    };

    if (opts.pushfy && (m.channel === "sms" || m.channel === "rcs")) {
      // a test goes out for real even before the channel is set live: that is its purpose
      if (!opts.pushfy.live && !m.is_test) {
        await complete("DRY_RUN", { reason: "pushfy_not_live" });
        continue;
      }
      const to = toPushfyNumber(recipient);
      if (!to) {
        await complete("SKIPPED", null, "invalid_phone");
        continue;
      }
      const plan = pushfyPlan(m.channel, rendered);
      if (!plan.text.trim()) {
        await complete("SKIPPED", null, "empty_message");
        continue;
      }
      const sent = await pushfySend(opts.pushfy, plan.kind, {
        to,
        text: plan.text,
        extId: m.message_id,
      });
      const result = {
        provider: "pushfy",
        endpoint: plan.kind,
        to,
        ...(plan.sentAs ? { sent_as: plan.sentAs } : {}),
        http_status: sent.httpStatus,
        response: sent.body,
      };
      if (sent.ok) {
        await complete("SENT", result);
        continue;
      }
      // RCS refused: the template's own "SMS alternativo" goes instead, right away
      const smsText = m.channel === "rcs" ? rcsFallbackText(rendered) : "";
      if (smsText) {
        const sms = await pushfySend(opts.pushfy, "sms", {
          to,
          text: smsText,
          extId: m.message_id,
        });
        const fallback = {
          status: sms.ok ? "SENT" : "FAILED",
          rcs_error: sent.error ?? null,
          http_status: sms.httpStatus,
          response: sms.body,
        };
        if (sms.ok) {
          await complete("SENT", { ...result, sent_as: "sms_fallback", fallback });
          continue;
        }
        await complete(
          "FAILED",
          { ...result, fallback },
          `RCS: ${sent.error ?? "falha"} · SMS: ${sms.error ?? "falha"}`,
          !sent.permanent || !sms.permanent,
        );
        continue;
      }
      await complete("FAILED", result, sent.error ?? "falha no envio", !sent.permanent);
      continue;
    }

    if (opts.resend && m.channel === "email") {
      // same rule as Pushfy: real e-mails only when live, except test launches
      if (!opts.resend.live && !m.is_test) {
        await complete("DRY_RUN", { reason: "email_not_live" });
        continue;
      }
      if (!isEmail(recipient)) {
        await complete("SKIPPED", null, "invalid_email");
        continue;
      }
      const e = rendered as { subject?: string; html?: string; text?: string; from_name?: string };
      const sent = await resendSend(opts.resend, {
        to: recipient!,
        subject: e.subject ?? "",
        html: e.html ?? "",
        text: e.text ?? "",
        fromName: e.from_name,
        idempotencyKey: m.message_id,
        tags: { message_id: m.message_id }, // the Resend webhook finds the message by it
      });
      const result = {
        provider: "resend",
        to: recipient,
        http_status: sent.httpStatus,
        response: sent.body,
      };
      if (sent.ok) await complete("SENT", result);
      else await complete("FAILED", result, sent.error ?? "falha no envio", !sent.permanent);
      continue;
    }

    if (opts.evolution && m.channel === "whatsapp") {
      if (!opts.evolution.live && !m.is_test) {
        await complete("DRY_RUN", { reason: "whatsapp_not_live" });
        continue;
      }
      const to = toPushfyNumber(recipient);
      if (!to) {
        await complete("SKIPPED", null, "invalid_phone");
        continue;
      }
      const sent = await evolutionSend(opts.evolution, to, rendered);
      const result = {
        provider: "evolution",
        to,
        // same field as the official API: the webhook statuses find the message by it
        ...(sent.id ? { wamid: sent.id } : {}),
        http_status: sent.httpStatus,
        response: sent.body,
      };
      if (sent.ok) await complete("SENT", result);
      else await complete("FAILED", result, sent.error ?? "falha no envio", !sent.permanent);
      continue;
    }

    if (opts.whatsapp && m.channel === "whatsapp") {
      if (!opts.whatsapp.live && !m.is_test) {
        await complete("DRY_RUN", { reason: "whatsapp_not_live" });
        continue;
      }
      const to = toPushfyNumber(recipient);
      if (!to) {
        await complete("SKIPPED", null, "invalid_phone");
        continue;
      }
      const sent = await whatsappSend(opts.whatsapp, to, rendered, m.message_id);
      const result = {
        provider: "whatsapp",
        to,
        ...(sent.id ? { wamid: sent.id } : {}),
        http_status: sent.httpStatus,
        response: sent.body,
      };
      if (sent.ok) await complete("SENT", result);
      else await complete("FAILED", result, sent.error ?? "falha no envio", !sent.permanent);
      continue;
    }

    if (!opts.webhookUrl) {
      await complete("DRY_RUN", { reason: "no_channel_configured" });
      continue;
    }
    const body = JSON.stringify({
      message_id: m.message_id, // idempotency key for the receiving tool
      type: "message",
      channel: m.channel,
      purpose: m.purpose,
      template: m.template_key,
      flow: m.flow_key,
      to: recipient,
      content: rendered,
      customer: { customer_id: m.customer["customer_id"], full_name: m.customer["full_name"] },
    });
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.webhookSecret)
        headers["x-kakauma-signature"] = `sha256=${await sign(opts.webhookSecret, body)}`;
      const res = await doFetch(opts.webhookUrl, { method: "POST", headers, body });
      if (res.ok) await complete("SENT", { http_status: res.status });
      else await complete("FAILED", { http_status: res.status }, `webhook responded ${res.status}`);
    } catch (e) {
      await complete("FAILED", null, (e as Error).message);
    }
  }
  return out;
}

export async function runFlows(rpc: Rpc, opts: MessageOptions = {}): Promise<FlowSummary> {
  const tick = await rpc("crm_flow_tick", { p_limit: 500 });
  if (tick.error) throw new Error(tick.error.message);
  const messages = await runMessages(rpc, opts);
  // second pass: a send that failed just now wakes "Aguardar entrega", whose
  // "not delivered" path (e.g. an SMS after an RCS) then goes out in this same run
  const again = await rpc("crm_flow_tick", { p_limit: 500 });
  if (again.error) throw new Error(again.error.message);
  const more = Number(again.data ?? 0) > 0 ? await runMessages(rpc, opts) : [];
  return {
    advanced: Number(tick.data ?? 0) + Number(again.data ?? 0),
    messages: [...messages, ...more],
  };
}

/** Brings Pushfy's opt-out list (PARAR, SAIR…) into crm.channel_optouts. Without `date`, everything. */
export async function syncPushfyOptouts(rpc: Rpc, cfg: PushfyConfig, date?: string) {
  const rows = await pushfyOptouts(cfg, date);
  if (!rows.length) return { received: 0, customers: 0, added: 0 };
  const { data, error } = await rpc("crm_import_optouts", { p_rows: rows, p_source: "pushfy" });
  if (error) throw new Error(error.message);
  return data as { received: number; customers: number; added: number };
}
