import { createFileRoute } from "@tanstack/react-router";

/**
 * Evolution API webhook (WhatsApp unofficial): message statuses (sent, delivered, read, error)
 * and customers answering PARAR / SAIR (opt-out of WhatsApp); every 1:1 conversation of every
 * number also goes to the WhatsApp screen (atendimento). The CRM registers it in the
 * instance itself (Operação → Canais de envio → "Cadastrar webhook na Evolution") as
 * https://<crm>/api/webhooks/evolution?token=<EVOLUTION_WEBHOOK_TOKEN>.
 */
async function checkToken(request: Request): Promise<Response | null> {
  const { env } = await import("@/server/crm/supabase.server");
  const expected = env("EVOLUTION_WEBHOOK_TOKEN");
  if (!expected)
    return Response.json(
      { ok: false, error: "EVOLUTION_WEBHOOK_TOKEN não configurado no servidor" },
      { status: 503 },
    );
  const url = new URL(request.url);
  const given = request.headers.get("x-webhook-token") ?? url.searchParams.get("token") ?? "";
  const { createHash, timingSafeEqual } = await import("node:crypto");
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  if (!timingSafeEqual(digest(given), digest(expected)))
    return Response.json(
      {
        ok: false,
        error: "unauthorized",
        detail: "Token ausente ou diferente do EVOLUTION_WEBHOOK_TOKEN",
      },
      { status: 401 },
    );
  return null;
}

export const Route = createFileRoute("/api/webhooks/evolution")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await checkToken(request);
        if (denied) return denied;
        return Response.json({ ok: true, message: "Webhook da Evolution ativo e token correto." });
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
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { evolutionItems } = await import("@/server/crm/evolution");
        // the inbox (WhatsApp screen): every 1:1 message of every number. Never holds up the
        // flows' statuses below (e.g. before the database update that creates the inbox)
        try {
          const { parseWaWebhook } = await import("@/server/crm/wa-inbox");
          const wa = parseWaWebhook(body);
          if (wa.instance && (wa.messages.length || wa.statuses.length || wa.state)) {
            const r = await crmRpc("crm_wa_ingest", {
              p_instance: wa.instance,
              p_messages: wa.messages,
              p_statuses: wa.statuses,
              p_state: wa.state,
              p_history: false,
            });
            if (r.error) console.error("[crm] whatsapp inbox", r.error.message);
          }
        } catch (e) {
          console.error("[crm] whatsapp inbox", e);
        }
        try {
          let matched = false;
          const items = evolutionItems(body);
          for (const [kind, payload] of items) {
            const r = await crmRpc("crm_whatsapp_event", { p_kind: kind, p_payload: payload });
            if (r.error) throw new Error(r.error.message);
            if ((r.data as { message_matched?: boolean } | null)?.message_matched) matched = true;
          }
          // a status may continue a flow waiting on it ("Aguardar entrega")
          if (matched) {
            const { runFlows } = await import("@/server/crm/pipeline.server");
            await runFlows(100, 5_000).catch((e) =>
              console.error("[crm] flows after evolution event", e),
            );
          }
          return Response.json({ ok: true, received: items.length });
        } catch (e) {
          // 5xx: Evolution may deliver again; repeated events are ignored by the database
          console.error("[crm] evolution webhook failed", e);
          return Response.json({ ok: false, error: (e as Error).message }, { status: 503 });
        }
      },
    },
  },
});
