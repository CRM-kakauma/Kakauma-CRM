import { createFileRoute } from "@tanstack/react-router";

/**
 * Evolution API connection (admin):
 *   GET            state of the instance; ?qr=1 also asks Evolution for a QR code to read
 *                  with the phone (WhatsApp → Aparelhos conectados);
 *   POST           registers the CRM webhook in the instance (statuses and PARAR).
 */
export const Route = createFileRoute("/api/crm/whatsapp/evolution")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { evolutionConfig } = await import("@/server/crm/pipeline.server");
        const { evolutionConnect, evolutionStatus } = await import("@/server/crm/evolution");
        const session = await getSession(request);
        if (!session) return json({ error: "unauthenticated" }, 401);
        if (session.role !== "admin") return json({ error: "forbidden" }, 403, session.setCookies);
        const cfg = evolutionConfig();
        if (!cfg)
          return json(
            {
              error: "not_configured",
              message:
                "Configure EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE na Vercel.",
            },
            400,
            session.setCookies,
          );
        try {
          const qr = new URL(request.url).searchParams.get("qr") === "1";
          const status = await evolutionStatus(cfg);
          const connect =
            qr && (!status.ok || status.state !== "open") ? await evolutionConnect(cfg) : null;
          return json({ status, connect }, 200, session.setCookies);
        } catch (e) {
          return json(
            { error: "evolution_error", message: (e as Error).message },
            502,
            session.setCookies,
          );
        }
      },
      POST: async ({ request }) => {
        const { getSession, json } = await import("@/server/crm/auth.server");
        const { env } = await import("@/server/crm/supabase.server");
        const { evolutionConfig } = await import("@/server/crm/pipeline.server");
        const { evolutionSetWebhook } = await import("@/server/crm/evolution");
        const session = await getSession(request);
        if (!session) return json({ error: "unauthenticated" }, 401);
        if (session.role !== "admin") return json({ error: "forbidden" }, 403, session.setCookies);
        const cfg = evolutionConfig();
        const token = env("EVOLUTION_WEBHOOK_TOKEN");
        if (!cfg || !token)
          return json(
            {
              error: "not_configured",
              message:
                "Configure EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE e EVOLUTION_WEBHOOK_TOKEN na Vercel.",
            },
            400,
            session.setCookies,
          );
        // the address the admin is using (the production domain); never localhost in production
        const origin = new URL(request.url).origin;
        const url = `${origin}/api/webhooks/evolution?token=${encodeURIComponent(token)}`;
        try {
          const r = await evolutionSetWebhook(cfg, url);
          if (!r.ok)
            return json({ error: "evolution_error", message: r.error }, 502, session.setCookies);
          return json(
            { ok: true, url: `${origin}/api/webhooks/evolution` },
            200,
            session.setCookies,
          );
        } catch (e) {
          return json(
            { error: "evolution_error", message: (e as Error).message },
            502,
            session.setCookies,
          );
        }
      },
    },
  },
});
