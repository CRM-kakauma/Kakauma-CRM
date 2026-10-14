import { createFileRoute } from "@tanstack/react-router";

/**
 * Pushfy webhooks: delivery status (DLR) and replies (MO).
 * Register in the Pushfy panel: https://<crm>/api/webhooks/pushfy?token=<PUSHFY_WEBHOOK_TOKEN>
 * (or send the token in the x-webhook-token header). Answers 200 quickly; Pushfy retries
 * on anything else, and repeated events are ignored by the database.
 */
async function checkToken(request: Request): Promise<Response | null> {
  const { env } = await import("@/server/crm/supabase.server");
  const expected = env("PUSHFY_WEBHOOK_TOKEN");
  if (!expected && !import.meta.env.DEV) {
    return Response.json(
      { ok: false, error: "PUSHFY_WEBHOOK_TOKEN não configurado no servidor" },
      { status: 503 },
    );
  }
  if (expected) {
    const url = new URL(request.url);
    const given = request.headers.get("x-webhook-token") ?? url.searchParams.get("token") ?? "";
    const { createHash, timingSafeEqual } = await import("node:crypto");
    const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
    if (!timingSafeEqual(digest(given), digest(expected))) {
      return Response.json(
        {
          ok: false,
          error: "unauthorized",
          detail: "Token ausente ou diferente do PUSHFY_WEBHOOK_TOKEN",
        },
        { status: 401 },
      );
    }
  }
  return null;
}

export const Route = createFileRoute("/api/webhooks/pushfy")({
  server: {
    handlers: {
      // opening the URL in a browser: tells whether it is ready
      GET: async ({ request }) => {
        const denied = await checkToken(request);
        if (denied) return denied;
        return Response.json({
          ok: true,
          message:
            "Webhook da Pushfy ativo e token correto. Cadastre esta mesma URL no painel da Pushfy (status e respostas).",
        });
      },
      POST: async ({ request }) => {
        const denied = await checkToken(request);
        if (denied) return denied;
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        const events = (Array.isArray(body) ? body : [body]).filter(
          (e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e),
        );
        const { crmRpc } = await import("@/server/crm/supabase.server");
        try {
          const results = [];
          for (const e of events) {
            const r = await crmRpc("crm_pushfy_event", { p_payload: e });
            if (r.error) throw new Error(r.error.message);
            results.push(r.data);
          }
          // a delivery report may continue a flow waiting on it ("Aguardar entrega")
          if (results.some((r) => (r as { message_matched?: boolean } | null)?.message_matched)) {
            const { runFlows } = await import("@/server/crm/pipeline.server");
            await runFlows(100).catch((e) => console.error("[crm] flows after pushfy event", e));
          }
          return Response.json({ ok: true, received: events.length, results });
        } catch (e) {
          // 5xx: Pushfy delivers again later, nothing is lost
          console.error("[crm] pushfy webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
