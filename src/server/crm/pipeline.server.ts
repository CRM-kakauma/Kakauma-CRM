import * as core from "./pipeline.ts";
import { runAutomations as runAutomationsCore } from "./automation.ts";
import { runFlows as runFlowsCore, syncPushfyOptouts as syncOptoutsCore } from "./messages.ts";
import { crmRpc as rpc, env } from "./supabase.server.ts";
import { syncResendStatus as syncResendCore } from "./resend-sync.ts";

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
/**
 * WhatsApp Cloud API (Meta) when WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set; real sends
 * only with WHATSAPP_LIVE=true. WHATSAPP_WABA_ID lists the approved templates.
 */
export function whatsappConfig() {
  const token = env("WHATSAPP_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) return undefined;
  return {
    token,
    phoneNumberId,
    wabaId: env("WHATSAPP_WABA_ID"),
    apiVersion: env("WHATSAPP_API_VERSION"),
    baseUrl: env("WHATSAPP_BASE_URL"),
    live: env("WHATSAPP_LIVE") === "true",
  };
}
/**
 * WhatsApp through Evolution API (unofficial) when EVOLUTION_API_URL + EVOLUTION_API_KEY +
 * EVOLUTION_INSTANCE are set — it takes the place of the official API. Real sends from flows
 * only with WHATSAPP_LIVE=true (tests go out before). EVOLUTION_DELAY_MS: "digitando…" before
 * each message.
 */
export function evolutionConfig() {
  const baseUrl = env("EVOLUTION_API_URL");
  const apiKey = env("EVOLUTION_API_KEY");
  const instance = env("EVOLUTION_INSTANCE");
  if (!baseUrl || !apiKey || !instance) return undefined;
  const delay = Number(env("EVOLUTION_DELAY_MS") ?? "");
  return {
    baseUrl,
    apiKey,
    instance,
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 10_000) : undefined,
    live: env("WHATSAPP_LIVE") === "true",
  };
}
export const runFlows = (limit = 100) =>
  runFlowsCore(rpc, {
    limit,
    pushfy: pushfyConfig(),
    resend: resendConfig(),
    whatsapp: whatsappConfig(),
    evolution: evolutionConfig(),
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

/** E-mail opens/clicks/deliveries the webhook did not bring, from the Resend API (a few per run). */
export const syncResendStatus = (limit = 20) => syncResendCore(rpc, resendConfig(), limit);
