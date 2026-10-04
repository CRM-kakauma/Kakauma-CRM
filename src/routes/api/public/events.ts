import { createFileRoute } from "@tanstack/react-router";

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
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
