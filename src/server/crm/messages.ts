import type { Rpc } from "./pipeline.ts";
import { renderMessage, type Channel, type Content } from "../../lib/crm-messages.ts";
import { renderTemplate } from "../../lib/crm-template.ts";
import { pushfyOptouts, pushfySend, toPushfyNumber, type PushfyConfig } from "./pushfy.ts";

/**
 * Flow worker: advances due flow enrollments, then delivers queued messages.
 *
 * The SQL side already skipped what must not go out (opt-out, no contact,
 * daily cap, outside the send window). Here each message is rendered with the
 * same code the editor's simulator uses, then:
 *   - SMS and RCS (text) go through Pushfy when PUSHFY_API_TOKEN is set and
 *     PUSHFY_LIVE=true (with the token but not live: DRY_RUN, nothing is sent);
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
}

export interface MessageOptions {
  limit?: number;
  pushfy?: (PushfyConfig & { live: boolean }) | undefined;
  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
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

export async function runMessages(rpc: Rpc, opts: MessageOptions = {}) {
  const { data, error } = await rpc("crm_claim_messages", { p_limit: opts.limit ?? 100 });
  if (error) throw new Error(error.message);
  const out: FlowSummary["messages"] = [];
  const doFetch = opts.fetchImpl ?? fetch;

  for (const m of (data ?? []) as ClaimedMessage[]) {
    const rendered =
      m.channel === "team"
        ? { text: renderTemplate(m.team_text ?? "", m.customer) }
        : renderMessage(m.channel, m.content as Content, m.customer);
    const recipient =
      m.channel === "team"
        ? "equipe"
        : m.channel === "email"
          ? ((m.customer["email"] as string | null) ?? null)
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
      if (!opts.pushfy.live) {
        await complete("DRY_RUN", { reason: "pushfy_not_live" });
        continue;
      }
      const to = toPushfyNumber(recipient);
      if (!to) {
        await complete("SKIPPED", null, "invalid_phone");
        continue;
      }
      const r = rendered as { kind?: string; text?: string | null };
      if (m.channel === "rcs" && r.kind !== "text") {
        // card / carousel: Pushfy's rich-content format is not documented yet
        await complete("SKIPPED", null, "rcs_rich_not_supported");
        continue;
      }
      const sent = await pushfySend(opts.pushfy, m.channel, {
        to,
        text: r.text ?? "",
        extId: m.message_id,
      });
      const result = { provider: "pushfy", to, http_status: sent.httpStatus, response: sent.body };
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
  return { advanced: Number(tick.data ?? 0), messages };
}

/** Brings Pushfy's opt-out list (PARAR, SAIR…) into crm.channel_optouts. Without `date`, everything. */
export async function syncPushfyOptouts(rpc: Rpc, cfg: PushfyConfig, date?: string) {
  const rows = await pushfyOptouts(cfg, date);
  if (!rows.length) return { received: 0, customers: 0, added: 0 };
  const { data, error } = await rpc("crm_import_optouts", { p_rows: rows, p_source: "pushfy" });
  if (error) throw new Error(error.message);
  return data as { received: number; customers: number; added: number };
}
