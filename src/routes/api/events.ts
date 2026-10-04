import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/events")({
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
