import type { Rpc } from "./pipeline.ts";
import { resendLastEvent, type ResendConfig } from "./resend.ts";

/**
 * E-mail status straight from Resend, for e-mails the webhook did not report
 * (sent before it existed, or a lost delivery). A few per run, spaced for
 * Resend's rate limit; each state is applied once, like a webhook event.
 */
export async function syncResendStatus(
  rpc: Rpc,
  cfg: ResendConfig | undefined,
  limit = 20,
  pauseMs = 550,
) {
  if (!cfg) return { checked: 0, updated: 0 };
  const { data, error } = await rpc("crm_resend_sync_batch", { p_limit: limit });
  if (error) throw new Error(error.message);
  let checked = 0;
  let updated = 0;
  for (const m of (data ?? []) as {
    message_id: string;
    email_id: string;
    executed_at: string | null;
  }[]) {
    if (checked > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    checked++;
    const last = await resendLastEvent(cfg, m.email_id);
    if (!last || ["sent", "queued", "scheduled"].includes(last)) continue;
    const r = await rpc("crm_resend_event", {
      p_event_id: `sync:${m.message_id}:${last}`,
      p_payload: {
        type: `email.${last}`,
        // the exact moment is not in the API answer: the day it was sent stands in
        created_at: m.executed_at ?? new Date().toISOString(),
        data: { email_id: m.email_id, tags: { message_id: m.message_id } },
      },
    });
    if (!r.error && (r.data as { status?: string } | null)?.status) updated++;
  }
  return { checked, updated };
}
