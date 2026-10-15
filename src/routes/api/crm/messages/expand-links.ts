import { createFileRoute } from "@tanstack/react-router";

/**
 * "Trocar links curtos": in every e-mail, follows the short links (bit.ly…)
 * and puts back the store address they lead to, so the automatic UTMs apply.
 * Body: { apply?: boolean } — without apply it only shows what would change.
 * Saved like an edit by this person (audited). Operator or admin.
 */
export const Route = createFileRoute("/api/crm/messages/expand-links")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { atLeast, getSession, json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { candidateLinks, replaceLinks, resolveStoreLinks } =
          await import("@/server/crm/expand-links");
        try {
          const session = await getSession(request);
          if (!session) return json({ error: "unauthenticated" }, 401);
          if (!atLeast(session.role, "operator"))
            return json({ error: "forbidden" }, 403, session.setCookies);
          const body = (await request.json().catch(() => ({}))) as { apply?: unknown };
          const list = await crmRpc("crm_list_templates", { p_channel: "email" });
          if (list.error) throw new Error(list.error.message);
          type Tpl = {
            key: string;
            name: string;
            channel: string;
            purpose: string;
            description: string | null;
            content: import("@/lib/crm-messages").EmailContent;
          };
          const templates = (list.data ?? []) as Tpl[];
          const urls = [...new Set(templates.flatMap((t) => candidateLinks(t.content)))].slice(
            0,
            80,
          );
          const { map, other } = await resolveStoreLinks(urls);

          const changes = [];
          for (const t of templates) {
            const links = candidateLinks(t.content).filter((u) => map.has(u));
            if (!links.length) continue;
            const change = {
              key: t.key,
              name: t.name,
              links: links.map((u) => ({ from: u, to: map.get(u)! })),
              saved: false,
              error: null as string | null,
            };
            if (body.apply === true) {
              const r = await crmRpc("crm_upsert_template", {
                p_key: t.key,
                p_name: t.name,
                p_channel: t.channel,
                p_content: replaceLinks(t.content, map),
                p_purpose: t.purpose,
                p_description: t.description,
                p_actor: session.email,
              });
              change.saved = !r.error;
              change.error = r.error?.message ?? null;
            }
            changes.push(change);
          }
          return json(
            { ok: true, applied: body.apply === true, changes, other },
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
