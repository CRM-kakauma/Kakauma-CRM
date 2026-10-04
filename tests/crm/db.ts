import postgres from "postgres";
import type { Rpc } from "../../src/server/crm/pipeline.ts";

export const TEST_DB_URL = process.env["CRM_TEST_DATABASE_URL"];

/** Direct-connection implementation of the Supabase RPC call used by the pipeline. */
export function makeRpc(sql: postgres.Sql): Rpc {
  return async (fn, args) => {
    const values: unknown[] = [];
    const params = Object.keys(args).map((k, i) => {
      const v = args[k];
      values.push(v); // the driver serializes jsonb / array parameters itself
      if (Array.isArray(v) && k === "p_redacted") return `${k} => $${i + 1}::text[]`;
      if (v !== null && typeof v === "object") return `${k} => $${i + 1}::jsonb`;
      return `${k} => $${i + 1}`;
    });
    try {
      const rows = await sql.unsafe(
        `select * from public.${fn}(${params.join(", ")})`,
        values as never[],
      );
      const first = rows[0] as Record<string, unknown> | undefined;
      // Scalar functions come back as a single column named after the function.
      if (rows.length === 1 && first && Object.keys(first).length === 1 && fn in first)
        return { data: first[fn], error: null };
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
}

/** Empties every CRM table (TRUNCATE bypasses the append-only row trigger; test databases only). */
export async function resetCrm(sql: postgres.Sql) {
  await sql.unsafe(
    `truncate crm.events, crm.customers, crm.products, crm.offers, crm.coupons, crm.affiliates,
              crm.dead_letter_events, crm.audit_logs, crm.data_quality_issues restart identity cascade`,
  );
}
