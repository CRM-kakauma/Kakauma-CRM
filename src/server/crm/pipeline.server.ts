import * as core from "./pipeline.ts";
import { runAutomations as runAutomationsCore } from "./automation.ts";
import { runFlows as runFlowsCore } from "./messages.ts";
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
export const runFlows = (limit = 100) =>
  runFlowsCore(rpc, {
    limit,
    webhookUrl: env("CRM_AUTOMATION_WEBHOOK_URL"),
    webhookSecret: env("CRM_AUTOMATION_WEBHOOK_SECRET"),
  });
