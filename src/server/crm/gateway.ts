import type { Role } from "./auth.server.ts";

/**
 * Which public.crm_* functions the app may call, and the minimum role.
 * Anything not listed (ingestion, claims, grants, backfill...) is never
 * reachable from the browser. Mutations receive p_actor for the audit log.
 */
export const RPC_PERMISSIONS: Record<string, { role: Role; actor?: true }> = {
  crm_dashboard: { role: "viewer" },
  crm_funnel: { role: "viewer" },
  crm_cohorts: { role: "viewer" },
  crm_retention: { role: "viewer" },
  crm_refund_metrics: { role: "viewer" },
  crm_campaign_quality: { role: "viewer" },
  crm_customer_360: { role: "viewer" },
  crm_search_customers: { role: "viewer" },
  crm_list_segments: { role: "viewer" },
  crm_list_automations: { role: "viewer" },
  crm_list_automation_runs: { role: "viewer" },
  crm_recovery_queue: { role: "viewer" },
  crm_ops_overview: { role: "viewer" },
  crm_list_settings: { role: "viewer" },
  crm_rule_fields: { role: "viewer" },
  crm_trigger_facts: { role: "viewer" },
  crm_preview_rule: { role: "viewer" },
  crm_ltv_curve: { role: "viewer" },
  crm_list_product_costs: { role: "viewer" },
  crm_list_templates: { role: "viewer" },
  crm_template_errors: { role: "viewer" },
  crm_list_flows: { role: "viewer" },
  crm_get_flow: { role: "viewer" },
  crm_flow_graph_errors: { role: "viewer" },
  crm_flow_stats: { role: "viewer" },
  crm_simulate_flow: { role: "viewer" },
  crm_message_customer: { role: "viewer" },
  crm_list_messages: { role: "viewer" },
  // operator: day-to-day CRM work
  crm_upsert_segment: { role: "operator", actor: true },
  crm_delete_segment: { role: "operator", actor: true },
  crm_set_automation_active: { role: "operator", actor: true },
  crm_upsert_automation: { role: "operator", actor: true },
  crm_upsert_template: { role: "operator", actor: true },
  crm_archive_template: { role: "operator", actor: true },
  crm_save_flow: { role: "operator", actor: true },
  crm_publish_flow: { role: "operator", actor: true },
  crm_set_flow_status: { role: "operator", actor: true },
  crm_set_optout: { role: "operator", actor: true },
  // admin: data, rules, people
  crm_requeue_dead_letters: { role: "admin", actor: true },
  crm_requeue_event: { role: "admin", actor: true },
  crm_update_setting: { role: "admin", actor: true },
  crm_import_marketing_spend: { role: "admin" },
  crm_refresh_customers: { role: "admin" },
  crm_list_app_users: { role: "admin" },
  crm_set_user_access: { role: "admin", actor: true },
  crm_list_audit: { role: "admin" },
  crm_set_product_cost: { role: "admin", actor: true },
  crm_anonymize_customer: { role: "admin", actor: true },
};

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function authorizeRpc(
  fn: unknown,
  args: unknown,
  session: { role: Role; email: string },
):
  | { ok: true; fn: string; args: Record<string, unknown> }
  | { ok: false; status: number; error: string } {
  if (typeof fn !== "string" || !Object.hasOwn(RPC_PERMISSIONS, fn)) {
    return { ok: false, status: 404, error: "unknown_function" };
  }
  const rule = RPC_PERMISSIONS[fn]!;
  if (RANK[session.role] < RANK[rule.role]) return { ok: false, status: 403, error: "forbidden" };
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    return { ok: false, status: 400, error: "invalid_args" };
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((args ?? {}) as Record<string, unknown>)) {
    if (!/^p_[a-z_]+$/.test(k) || k === "p_actor")
      return { ok: false, status: 400, error: `invalid_arg:${k}` };
    clean[k] = v;
  }
  if (rule.actor) clean["p_actor"] = session.email; // never trust a client-supplied actor
  return { ok: true, fn, args: clean };
}
