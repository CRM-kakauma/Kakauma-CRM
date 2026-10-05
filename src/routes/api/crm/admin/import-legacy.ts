import { createFileRoute } from "@tanstack/react-router";

/**
 * Imports the B4you webhooks already stored by the legacy analytics project
 * (public.events.metadata.raw_payload) into the CRM, one page per call.
 * Idempotent: re-importing the same payload is a no-op. Old facts never
 * trigger automations (max_trigger_age_hours).
 */
const PAGE = 200;

export const Route = createFileRoute("/api/crm/admin/import-legacy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc, legacyConfig, keyHeaders } = await import("@/server/crm/supabase.server");
        const { ingestWebhook } = await import("@/server/crm/pipeline");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role !== "admin")
            return json({ error: "forbidden" }, 403, session.setCookies);
          const legacy = legacyConfig();
          if (!legacy) {
            return json(
              {
                error: "legacy_not_configured",
                message: "VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY ausentes no .env",
              },
              400,
              session.setCookies,
            );
          }
          const { offset = 0 } = (await request.json().catch(() => ({}))) as { offset?: number };
          const url =
            `${legacy.url}/rest/v1/events?select=metadata&metadata->>provider=eq.b4you` +
            `&order=timestamp.asc,id.asc&limit=${PAGE}&offset=${Math.max(0, Number(offset) || 0)}`;
          const res = await fetch(url, { headers: keyHeaders(legacy.key) });
          if (!res.ok) {
            return json(
              { error: "legacy_read_failed", message: `HTTP ${res.status}: ${await res.text()}` },
              502,
              session.setCookies,
            );
          }
          const rows = (await res.json()) as { metadata: { raw_payload?: unknown } | null }[];
          const counts: Record<string, number> = {};
          for (const r of rows) {
            const payload = r.metadata?.raw_payload;
            if (!payload || typeof payload !== "object") {
              counts["sem_payload"] = (counts["sem_payload"] ?? 0) + 1;
              continue;
            }
            const out = await ingestWebhook(crmRpc, "b4you", JSON.stringify(payload));
            const key = out.body["duplicate"]
              ? "duplicado"
              : String(out.body["status"] ?? out.body["error"] ?? "erro");
            counts[key] = (counts[key] ?? 0) + 1;
          }
          return json(
            {
              read: rows.length,
              counts,
              next_offset: Number(offset) + rows.length,
              done: rows.length < PAGE,
            },
            200,
            session.setCookies,
          );
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
