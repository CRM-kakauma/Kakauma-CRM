import * as core from "./pipeline.ts";
import { runAutomations as runAutomationsCore } from "./automation.ts";
import { runFlows as runFlowsCore, syncPushfyOptouts as syncOptoutsCore } from "./messages.ts";
import { crmRpc as rpc, env } from "./supabase.server.ts";

// Everything runs against the CRM's own Supabase project (CRM_SUPABASE_* in .env).
export const ingestWebhook = (source: string, rawBody: string) =>
  core.ingestWebhook(rpc, source, rawBody);
export const processPending = (opts: { limit?: number; id?: string } = {}) =>
  core.processPending(rpc, opts);
export const backfillFromLegacy = (limit = 5000) => core.backfillFromLegacy(rpc, limit);
export const refreshCustomers = (limit = 500) => core.refreshCustomers(rpc, limit);
export const runAutomations = (limit = 100) =>
  runAutomationsCore(rpc, {
    limit,
    webhookUrl: env("CRM_AUTOMATION_WEBHOOK_URL"),
    webhookSecret: env("CRM_AUTOMATION_WEBHOOK_SECRET"),
  });
/** Pushfy (SMS / RCS) when PUSHFY_API_TOKEN is set; real sends only with PUSHFY_LIVE=true. */
export function pushfyConfig() {
  const token = env("PUSHFY_API_TOKEN");
  if (!token) return undefined;
  return {
    token,
    baseUrl: env("PUSHFY_BASE_URL"),
    smsFrom: env("PUSHFY_SMS_FROM"),
    live: env("PUSHFY_LIVE") === "true",
  };
}
/**
 * Click tracking base. CRM_LINK_BASE (a domain of the brand, e.g. https://k.kakauma.com.br,
 * pointing to this project) turns it on for every channel; without it, the project's own
 * Vercel address is used for SMS/RCS only (an unknown domain in e-mails hurts delivery).
 * CRM_LINK_TRACKING=false turns it off.
 */
export function linkTracking() {
  if (env("CRM_LINK_TRACKING") === "false") return undefined;
  const own = env("CRM_LINK_BASE")?.replace(/\/+$/, "");
  if (own) return { base: own, email: true };
  const vercel = env("VERCEL_PROJECT_PRODUCTION_URL");
  return vercel
    ? { base: `https://${vercel.replace(/^https?:\/\//, "")}`, email: false }
    : undefined;
}

export function resendConfig() {
  const apiKey = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  if (!apiKey || !from) return undefined;
  return {
    apiKey,
    from,
    replyTo: env("EMAIL_REPLY_TO"),
    live: env("EMAIL_LIVE") === "true",
  };
}
export const runFlows = (limit = 100) =>
  runFlowsCore(rpc, {
    limit,
    pushfy: pushfyConfig(),
    resend: resendConfig(),
    links: linkTracking(),
    webhookUrl: env("CRM_AUTOMATION_WEBHOOK_URL"),
    webhookSecret: env("CRM_AUTOMATION_WEBHOOK_SECRET"),
  });
/** Opt-outs of today and yesterday (Brasília), or everything with full=true. */
export async function syncPushfyOptouts(full = false) {
  const cfg = pushfyConfig();
  if (!cfg) return null;
  if (full) return syncOptoutsCore(rpc, cfg);
  const day = (offset: number) =>
    new Date(Date.now() - offset * 86_400_000).toLocaleDateString("sv-SE", {
      timeZone: "America/Sao_Paulo",
    });
  const a = await syncOptoutsCore(rpc, cfg, day(0));
  const b = await syncOptoutsCore(rpc, cfg, day(1));
  return {
    received: a.received + b.received,
    customers: a.customers + b.customers,
    added: a.added + b.added,
  };
}
