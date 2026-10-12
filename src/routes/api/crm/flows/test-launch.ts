import { createFileRoute } from "@tanstack/react-router";

/**
 * "Disparar teste": puts every member of a manual segment (default "teste")
 * into the flow now, then runs the flow worker immediately so the messages
 * go out without waiting for the scheduled job (operator or admin).
 * Body: { key, segment?, skip_waits? }
 */
export const Route = createFileRoute("/api/crm/flows/test-launch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { runFlows } = await import("@/server/crm/pipeline.server");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (session.role === "viewer")
            return json({ error: "forbidden" }, 403, session.setCookies);
          const body = (await request.json().catch(() => ({}))) as {
            key?: unknown;
            segment?: unknown;
            skip_waits?: unknown;
          };
          if (typeof body.key !== "string" || !body.key)
            return json(
              { error: "invalid_request", message: "Fluxo não informado." },
              400,
              session.setCookies,
            );
          const launch = await crmRpc("crm_launch_flow_test", {
            p_key: body.key,
            p_segment: typeof body.segment === "string" && body.segment ? body.segment : "teste",
            p_skip_waits: body.skip_waits !== false,
            p_actor: session.email,
          });
          if (launch.error)
            return json(
              { error: "launch_failed", message: launch.error.message },
              400,
              session.setCookies,
            );
          // the scheduled job runs once a day on the Hobby plan: process now
          const run = await runFlows(200);
          return json({ ok: true, launch: launch.data, run }, 200, session.setCookies);
        } catch (e) {
          return json({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
