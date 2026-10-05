import type { Rpc } from "./pipeline.ts";
import { renderMessage, type Channel, type Content } from "../../lib/crm-messages.ts";
import { renderTemplate } from "../../lib/crm-template.ts";

/**
 * Flow worker: advances due flow enrollments, then delivers queued messages.
 *
 * The SQL side already skipped what must not go out (opt-out, no contact,
 * daily cap, outside the send window). Here each message is rendered with the
 * same code the editor's simulator uses. Without a channel webhook it is stored
 * as DRY_RUN (the rendered content is visible in the CRM); with
 * CRM_AUTOMATION_WEBHOOK_URL it is POSTed there, signed with HMAC-SHA256.
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
    const complete = async (status: string, result: unknown, err: string | null = null) => {
      const r = await rpc("crm_complete_message", {
        p_message_id: m.message_id,
        p_status: status,
        p_recipient: recipient,
        p_rendered: rendered,
        p_result: result ?? null,
        p_error: err,
      });
      out.push({
        message_id: m.message_id,
        channel: m.channel,
        status: String(r.data ?? status),
        ...(err ? { error: err } : {}),
      });
    };

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
