import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as core from "../pipeline.ts";
import { runAutomations } from "../automation.ts";
import { runFlows } from "../messages.ts";
import type { Rpc } from "../pipeline.ts";
import { buildDemoData } from "./seed.ts";

/** text[] parameters (every other array/object is sent as jsonb). */
const TEXT_ARRAYS = new Set(["p_redacted", "p_events"]);

/**
 * Demo mode (local development only): when no CRM Supabase project is
 * configured, the CRM runs on an in-memory Postgres (PGlite) with the real
 * migrations, fed with FICTITIOUS B4you webhooks through the real pipeline.
 * Data is rebuilt on every server start.
 */

interface PGliteLike {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

let ready: Promise<Rpc> | null = null;
let status: {
  state: "loading" | "ready" | "error";
  webhooks?: number;
  ms?: number;
  error?: string;
} = {
  state: "loading",
};

export const demoStatus = () => status;

function makeRpc(db: PGliteLike): Rpc {
  return async (fn, args) => {
    if (!/^crm_[a-z0-9_]+$/.test(fn)) return { data: null, error: { message: "unknown function" } };
    const keys = Object.keys(args);
    const values = keys.map((k) => args[k]);
    const params = keys.map((k, i) => {
      const v = args[k];
      if (Array.isArray(v) && TEXT_ARRAYS.has(k)) return `${k} => $${i + 1}::text[]`;
      if (v !== null && typeof v === "object") return `${k} => $${i + 1}::jsonb`;
      return `${k} => $${i + 1}`;
    });
    try {
      const { rows } = await db.query<Record<string, unknown>>(
        `select * from public.${fn}(${params.join(", ")})`,
        values,
      );
      const first = rows[0];
      // Same shape as PostgREST: scalars bare, set-returning functions as arrays.
      if (rows.length === 1 && first && Object.keys(first).length === 1 && fn in first) {
        return { data: first[fn], error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  };
}

async function boot(): Promise<Rpc> {
  const started = Date.now();
  // Non-literal specifiers keep PGlite out of production bundles.
  const pgliteMod = "@electric-sql/pglite";
  const cryptoMod = "@electric-sql/pglite/contrib/pgcrypto";
  const { PGlite } = (await import(/* @vite-ignore */ pgliteMod)) as {
    PGlite: { create(o: unknown): Promise<PGliteLike> };
  };
  const { pgcrypto } = (await import(/* @vite-ignore */ cryptoMod)) as { pgcrypto: unknown };
  const db = await PGlite.create({ extensions: { pgcrypto } });

  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls; create schema extensions;
  `);
  const dir = join(process.cwd(), "drizzle", "migrations");
  for (const f of readdirSync(dir)
    .filter((x) => /^\d{4}_.*\.sql$/.test(x) && Number(x.slice(0, 4)) >= 8)
    .sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }

  const rpc = makeRpc(db);
  const { webhooks, spend } = buildDemoData();
  // The starter flows go live before the events, so recent facts enter them.
  for (const key of ["recuperacao_pagamento", "boas_vindas"]) {
    await rpc("crm_publish_flow", { p_key: key, p_actor: "demo" });
  }
  for (const p of webhooks) {
    await core.ingestWebhook(rpc, "b4you", JSON.stringify(p));
  }
  await rpc("crm_import_marketing_spend", { p_rows: spend });
  // Fictitious unit costs and tax rate so profit per customer shows up in the demo.
  for (const product of ["prod_sleep", "prod_sleep_sub"]) {
    await rpc("crm_set_product_cost", { p_product_id: product, p_unit_cost: 42, p_note: "demo" });
  }
  await rpc("crm_update_setting", { p_key: "tax_rate_pct", p_value: 6 });
  await runAutomations(rpc, { limit: 500 }); // no channel → DRY_RUN with rendered messages
  await runFlows(rpc, { limit: 500 });
  status = { state: "ready", webhooks: webhooks.length, ms: Date.now() - started };
  console.log(`[crm demo] ${webhooks.length} webhooks fictícios processados em ${status.ms} ms`);
  return rpc;
}

export function demoRpc(): Promise<Rpc> {
  if (!ready) {
    console.log("[crm demo] preparando banco de demonstração (dados fictícios)…");
    ready = boot().catch((e: Error) => {
      status = { state: "error", error: e.message };
      ready = null;
      throw e;
    });
  }
  return ready;
}
