import { supabaseAdmin } from "@/integrations/supabase/client.server";
import * as core from "./pipeline.ts";
import type { Rpc } from "./pipeline.ts";
import { runAutomations as runAutomationsCore } from "./automation.ts";

// The crm_* functions are not in the generated Supabase types yet.
const rpc: Rpc = (fn, args) => (supabaseAdmin.rpc as unknown as Rpc)(fn, args);

export const ingestWebhook = (source: string, rawBody: string) =>
  core.ingestWebhook(rpc, source, rawBody);
export const processPending = (opts: { limit?: number; id?: string } = {}) =>
  core.processPending(rpc, opts);
export const backfillFromLegacy = (limit = 5000) => core.backfillFromLegacy(rpc, limit);
export const refreshCustomers = (limit = 500) => core.refreshCustomers(rpc, limit);
export const runAutomations = (limit = 100) =>
  runAutomationsCore(rpc, {
    limit,
    webhookUrl: process.env["CRM_AUTOMATION_WEBHOOK_URL"],
    webhookSecret: process.env["CRM_AUTOMATION_WEBHOOK_SECRET"],
  });
