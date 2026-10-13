import { crmCall } from "./crm-api.ts";

/** Saved fields of a flow (what crm_get_flow returns and crm_save_flow takes). */
interface SavedFlow {
  key: string;
  name: string;
  description: string | null;
  trigger_fact: string;
  trigger_filter: Record<string, unknown> | null;
  entry_rule: Record<string, unknown> | null;
  reentry: string;
  max_trigger_age_hours: number;
  goal_fact: string | null;
  graph: unknown;
}

/**
 * Copies a flow as a new draft (never published, nobody inside): same trigger, rules,
 * goal and steps. The key gets a free "_copia" suffix — a saved key is never overwritten,
 * archived ones included.
 */
export async function duplicateFlow(key: string): Promise<string> {
  const f = await crmCall<SavedFlow | null>("crm_get_flow", { p_key: key });
  if (!f) throw new Error("Fluxo não encontrado");
  const base = `${key.slice(0, 50)}_copia`;
  let newKey = base;
  for (let i = 2; await crmCall<unknown>("crm_get_flow", { p_key: newKey }); i++) {
    if (i > 50) throw new Error("Não achei uma chave livre para a cópia");
    newKey = `${base}_${i}`;
  }
  await crmCall("crm_save_flow", {
    p_key: newKey,
    p_name: `Cópia de ${f.name}`.slice(0, 200),
    p_trigger_fact: f.trigger_fact,
    p_graph: f.graph,
    p_description: f.description,
    p_trigger_filter: f.trigger_filter ?? {},
    p_entry_rule: f.entry_rule ?? {},
    p_reentry: f.reentry,
    p_max_trigger_age_hours: f.max_trigger_age_hours,
    p_goal_fact: f.goal_fact,
  });
  return newKey;
}
