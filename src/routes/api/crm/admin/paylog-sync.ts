import { createFileRoute } from "@tanstack/react-router";

/**
 * Recover deliveries from the Paylog API (admin): POST { page, offset }.
 * Reads the delivered orders (GET /api/v1/pedidos?status=14, 500 per page) and stores each one as
 * history with its real delivery date: customers waiting for "Entrega realizada" in a flow move on,
 * nobody enters a new flow. Each call works for a few seconds and answers where to go on from
 * (next_page / next_offset); the screen calls again until done. Safe to run again: an order
 * already recovered is not stored twice. See server/crm/paylog-api.ts.
 */
const BUDGET_MS = 15_000;
/** Orders per call: each one is a few database calls (Cloudflare limits calls per request). */
const MAX_ORDERS = 100;

export const Route = createFileRoute("/api/crm/admin/paylog-sync")({
  server: {
    handlers: {
      // the screen: is the token there, how many customers are waiting for the delivery
      GET: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc, demoMode, env } = await import("@/server/crm/supabase.server");
        const session = await getSession(request);
        if (!session) return json({ error: "unauthenticated" }, 401);
        if (session.role !== "admin") return json({ error: "forbidden" }, 403, session.setCookies);
        if (demoMode()) return json({ configured: false, waiting: null }, 200, session.setCookies);
        const r = await crmRpc("crm_waiting_count", { p_fact: "FULFILLMENT_DELIVERED" });
        return json(
          {
            configured: !!env("PAYLOG_API_TOKEN")?.trim(),
            waiting: r.error ? null : Number(r.data),
            // before the database update (0042) the count is not available
            waiting_error: r.error?.message ?? null,
          },
          200,
          session.setCookies,
        );
      },
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc, demoMode, env } = await import("@/server/crm/supabase.server");
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
          const token = env("PAYLOG_API_TOKEN")?.trim();
          if (!token)
            return json(
              {
                error: "not_configured",
                message:
                  "Falta PAYLOG_API_TOKEN: crie um token em Paylog → Tokens de Acesso API e cadastre como Secret na Cloudflare.",
              },
              400,
              session.setCookies,
            );
          const body = (await request.json().catch(() => ({}))) as {
            page?: unknown;
            offset?: unknown;
          };
          const page = Math.max(1, Math.floor(Number(body.page) || 1));
          const offset = Math.max(0, Math.floor(Number(body.offset) || 0));

          const { fetchDeliveredPage, deliveredOrderToPayload, fetchDeliveryDate, PaylogApiError } =
            await import("@/server/crm/paylog-api");
          const { importBackfill } = await import("@/server/crm/backfill");
          const waiting = async () => {
            const r = await crmRpc("crm_waiting_count", { p_fact: "FULFILLMENT_DELIVERED" });
            return r.error ? null : Number(r.data);
          };

          let pg;
          try {
            pg = await fetchDeliveredPage(token, page);
          } catch (e) {
            if (e instanceof PaylogApiError)
              return json(
                { error: "paylog_api", message: e.message },
                e.status === 401 || e.status === 403 ? 400 : 502,
                session.setCookies,
              );
            throw e;
          }

          const counts: Record<string, number> = {};
          const errors: { line: number; error: string }[] = [];
          const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
          const started = Date.now();
          let i = offset;
          let handled = 0;
          for (; i < pg.orders.length; i++) {
            if (handled >= MAX_ORDERS || Date.now() - started > BUDGET_MS) break;
            handled++;
            const order = pg.orders[i]!;
            let payload = deliveredOrderToPayload(order);
            if (!payload) {
              // no data_entrega: the date of the delivery event in the tracking timeline
              const at = order["id"] ? await fetchDeliveryDate(token, String(order["id"])) : null;
              payload = deliveredOrderToPayload(order, at);
            }
            if (!payload) {
              bump("sem data de entrega");
              continue;
            }
            const occurred = (payload["shipment"] as { occurred_at: string }).occurred_at;
            const r = await importBackfill(
              crmRpc,
              "paylog",
              [{ payload, received_at: occurred }],
              Number(order["id"]) || 0,
            );
            for (const [k, v] of Object.entries(r.counts)) bump(k, v);
            errors.push(...r.errors);
          }

          const endOfPage = i >= pg.orders.length;
          const done = endOfPage && pg.page >= pg.lastPage;
          return json(
            {
              page: pg.page,
              last_page: pg.lastPage,
              orders_in_page: pg.orders.length,
              next_page: endOfPage ? pg.page + 1 : pg.page,
              next_offset: endOfPage ? 0 : i,
              done,
              counts,
              errors,
              waiting: await waiting(),
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
