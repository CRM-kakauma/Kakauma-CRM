import { createFileRoute } from "@tanstack/react-router";

/**
 * History import from a file (admin): POST { source: "b4you", first_line, lines: [...] } with up
 * to 100 JSONL lines per call (the screen sends the file in parts). See server/crm/backfill.ts.
 */
const MAX_LINES = 100;

export const Route = createFileRoute("/api/crm/admin/import-file")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc, demoMode } = await import("@/server/crm/supabase.server");
        const { importBackfill, parseBackfillLine } = await import("@/server/crm/backfill");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role !== "admin")
            return json({ error: "forbidden" }, 403, session.setCookies);
          if (demoMode())
            return json(
              { error: "demo_mode", message: "Modo demonstração: configure o Supabase do CRM." },
              400,
              session.setCookies,
            );
          const body = (await request.json().catch(() => ({}))) as {
            source?: unknown;
            first_line?: unknown;
            lines?: unknown;
          };
          const source = body.source === undefined ? "b4you" : body.source;
          if (source !== "b4you")
            return json(
              { error: "invalid_request", message: "Só webhooks da B4you." },
              400,
              session.setCookies,
            );
          if (!Array.isArray(body.lines) || body.lines.length > MAX_LINES)
            return json(
              { error: "invalid_request", message: `Envie de 1 a ${MAX_LINES} linhas por vez.` },
              400,
              session.setCookies,
            );
          const first = Math.max(1, Number(body.first_line) || 1);
          const items = [];
          const bad: { line: number; error: string }[] = [];
          for (const [i, l] of (body.lines as unknown[]).entries()) {
            try {
              const item = typeof l === "string" ? parseBackfillLine(l) : { payload: l };
              if (item) items.push({ item, line: first + i });
            } catch (e) {
              bad.push({ line: first + i, error: `JSON inválido: ${(e as Error).message}` });
            }
          }
          const counts: Record<string, number> = {};
          const errors = [...bad];
          if (bad.length) counts["inválido"] = bad.length;
          // one at a time, in file order (the order the webhooks arrived)
          for (const { item, line } of items) {
            const r = await importBackfill(crmRpc, "b4you", [item], line);
            for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
            errors.push(...r.errors);
          }
          return json({ received: body.lines.length, counts, errors }, 200, session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
