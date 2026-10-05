import type { Rpc } from "./pipeline.ts";

/**
 * Connection to the CRM's own Supabase project (separate from the legacy
 * analytics project). Only the server talks to it; the browser never receives
 * any key.
 *
 *   CRM_SUPABASE_URL               https://<ref>.supabase.co
 *   CRM_SUPABASE_ANON_KEY          publishable/anon key (used for Supabase Auth logins)
 *   CRM_SUPABASE_SERVICE_ROLE_KEY  secret/service_role key (server only)
 */

let fileEnv: Record<string, string> | null = null;

/** process.env first; in local development also reads .env (Vite does not export non-VITE_ vars to the server). */
export function env(name: string): string | undefined {
  const v = process.env[name];
  if (v) return v;
  if (fileEnv === null) {
    fileEnv = {};
    try {
      const fs = globalThis.process?.getBuiltinModule?.("node:fs") as
        typeof import("node:fs") | undefined;
      const text = fs?.readFileSync(".env", "utf8") ?? "";
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) fileEnv[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
      }
    } catch {
      // no .env file: rely on process.env only
    }
  }
  return fileEnv[name] || undefined;
}

export function crmConfig() {
  const url = env("CRM_SUPABASE_URL")?.replace(/\/+$/, "");
  const anonKey = env("CRM_SUPABASE_ANON_KEY");
  const serviceKey = env("CRM_SUPABASE_SERVICE_ROLE_KEY");
  const missing = [
    !url && "CRM_SUPABASE_URL",
    !anonKey && "CRM_SUPABASE_ANON_KEY",
    !serviceKey && "CRM_SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    throw new CrmConfigError(`Configuração do CRM incompleta no .env: ${missing.join(", ")}`);
  }
  return { url: url!, anonKey: anonKey!, serviceKey: serviceKey! };
}

export class CrmConfigError extends Error {}

/** Legacy analytics project (only to import historical webhooks). */
export function legacyConfig() {
  const url = (env("VITE_SUPABASE_URL") ?? env("SUPABASE_URL"))?.replace(/\/+$/, "");
  const key = env("VITE_SUPABASE_PUBLISHABLE_KEY") ?? env("SUPABASE_PUBLISHABLE_KEY");
  return url && key ? { url, key } : null;
}

/** Headers for a Supabase API key: new opaque keys (sb_...) are not bearer JWTs. */
export function keyHeaders(key: string): Record<string, string> {
  return key.startsWith("sb_") ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
}

/**
 * Demo mode: local development without CRM_SUPABASE_URL (or with CRM_DEMO=true)
 * runs on an in-memory database with fictitious data. Never in production builds.
 */
export function demoMode(): boolean {
  if (!import.meta.env.DEV) return false;
  return env("CRM_DEMO") === "true" || !env("CRM_SUPABASE_URL");
}

/** public.crm_* functions through PostgREST, as service_role (or the demo database). */
export const crmRpc: Rpc = async (fn, args) => {
  if (demoMode()) {
    const { demoRpc } = await import("./demo/demo.server.ts");
    try {
      return await (
        await demoRpc()
      )(fn, args);
    } catch (e) {
      return {
        data: null,
        error: { message: `Banco de demonstração falhou: ${(e as Error).message}` },
      };
    }
  }
  const { url, serviceKey } = crmConfig();
  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
      method: "POST",
      headers: { ...keyHeaders(serviceKey), "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch (e) {
    return {
      data: null,
      error: { message: `Supabase do CRM inacessível: ${(e as Error).message}` },
    };
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    return { data: null, error: { message } };
  }
  return { data: body, error: null };
};
