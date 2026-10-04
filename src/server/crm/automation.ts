import type { Rpc } from "./pipeline.ts";

/**
 * Executes due automation runs.
 *
 * No real channel is connected yet: without a webhook URL every action is
 * recorded as DRY_RUN with the rendered message, so the team can review what
 * would have been sent. With CRM_AUTOMATION_WEBHOOK_URL set, each action is
 * POSTed there (signed with HMAC-SHA256) for a messaging tool to deliver.
 */

interface ClaimedRun {
  run_id: string;
  automation_key: string;
  action_type: "message" | "internal_alert";
  action_config: { channel?: string; template?: string; message?: string };
  customer: Record<string, unknown>;
  trigger: { fact_type: string; occurred_at: string; data: Record<string, unknown> } | null;
}

export interface AutomationOptions {
  limit?: number;
  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface AutomationSummary {
  claimed: number;
  results: { run_id: string; automation: string; status: string; error?: string }[];
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))
    return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return String(v);
}

/** Replaces {{name}} with customer fields, then trigger data. Unknown names render empty. */
export function renderTemplate(
  template: string,
  customer: Record<string, unknown>,
  trigger: Record<string, unknown> = {},
) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) =>
    format(customer[key] ?? trigger[key]),
  );
}

async function sign(secret: string, body: string) {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function runAutomations(
  rpc: Rpc,
  opts: AutomationOptions = {},
): Promise<AutomationSummary> {
  const { data, error } = await rpc("crm_claim_automation_runs", { p_limit: opts.limit ?? 100 });
  if (error) throw new Error(error.message);
  const runs = (data ?? []) as ClaimedRun[];
  const results: AutomationSummary["results"] = [];
  const doFetch = opts.fetchImpl ?? fetch;

  for (const run of runs) {
    const channel =
      run.action_config.channel ?? (run.action_type === "internal_alert" ? "team" : "whatsapp");
    const message = renderTemplate(
      run.action_config.message ?? "",
      run.customer,
      run.trigger?.data ?? {},
    );
    const complete = async (status: string, result: unknown, err: string | null = null) => {
      const r = await rpc("crm_complete_automation_run", {
        p_run_id: run.run_id,
        p_status: status,
        p_channel: channel,
        p_message: message,
        p_result: result ?? null,
        p_error: err,
      });
      results.push({
        run_id: run.run_id,
        automation: run.automation_key,
        status: String(r.data ?? status),
        ...(err ? { error: err } : {}),
      });
    };

    const to = {
      whatsapp: (run.customer["whatsapp"] as string | null) ?? null,
      email: (run.customer["email"] as string | null) ?? null,
    };
    if (
      run.action_type === "message" &&
      ((channel === "whatsapp" && !to.whatsapp) || (channel === "email" && !to.email))
    ) {
      await complete("SKIPPED", null, `no_contact_for_${channel}`);
      continue;
    }

    if (!opts.webhookUrl) {
      await complete("DRY_RUN", { reason: "no_channel_configured" });
      continue;
    }

    const body = JSON.stringify({
      run_id: run.run_id, // idempotency key for the receiving tool
      automation: run.automation_key,
      type: run.action_type,
      channel,
      template: run.action_config.template ?? null,
      message,
      to,
      customer: {
        customer_id: run.customer["customer_id"],
        full_name: run.customer["full_name"],
        lifecycle: run.customer["lifecycle"],
        risk: run.customer["risk"],
      },
      trigger: run.trigger,
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
  return { claimed: runs.length, results };
}
