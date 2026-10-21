import { createFileRoute } from "@tanstack/react-router";

/** GET: the WhatsApp templates of the Meta account (approved and not), for the message editor. */
export const Route = createFileRoute("/api/crm/whatsapp/templates")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { atLeast, getSession, json } = await import("@/server/crm/auth.server");
        const { whatsappConfig } = await import("@/server/crm/pipeline.server");
        const { whatsappTemplates } = await import("@/server/crm/whatsapp");
        const session = await getSession(request);
        if (!session) return json({ error: "unauthenticated" }, 401);
        if (!atLeast(session.role, "operator"))
          return json({ error: "forbidden" }, 403, session.setCookies);
        const cfg = whatsappConfig();
        if (!cfg)
          return json(
            {
              error: "not_configured",
              message: "Configure WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID na Vercel.",
            },
            400,
            session.setCookies,
          );
        try {
          return json({ templates: await whatsappTemplates(cfg) }, 200, session.setCookies);
        } catch (e) {
          return json(
            { error: "meta_error", message: (e as Error).message },
            502,
            session.setCookies,
          );
        }
      },
    },
  },
});
