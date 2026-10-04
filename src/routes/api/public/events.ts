import { createFileRoute } from "@tanstack/react-router";

/**
 * While B4you still posts here, B4you webhooks are also written to the CRM
 * event store (idempotent, so the same payload sent to both endpoints is
 * stored once). A CRM failure never affects the legacy analytics response.
 */
async function mirrorToCrm(payload: unknown) {
  const { isB4youPayload } = await import("@/lib/b4you.server");
  if (!isB4youPayload(payload)) return;
  try {
    const { ingestWebhook } = await import("@/server/crm/pipeline.server");
    await ingestWebhook("b4you", JSON.stringify(payload));
  } catch (e) {
    console.error("[crm] mirror failed", e);
  }
}

/**
 * Public ingestion endpoint for external producers (checkout, gateway webhooks).
 * Same handler as /api/events; idempotent by event_id.
 */
export const Route = createFileRoute("/api/public/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { ingestEvent } = await import("@/lib/ingest.server");
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
        }
        const result = await ingestEvent(payload);
        await mirrorToCrm(payload);
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
