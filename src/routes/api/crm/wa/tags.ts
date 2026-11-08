import { createFileRoute } from "@tanstack/react-router";

/**
 * Tags of a WhatsApp contact (attendance).
 * GET: tags already used (suggestions) and the levels config (Sem compra / Bronze / Prata / Ouro).
 * POST { chat, tag, add }: puts / removes a manual tag (on the customer, or on the chat while the
 * contact is not a customer). POST { tiers }: saves the levels config (admin).
 */
export const Route = createFileRoute("/api/crm/wa/tags")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const [t, c] = await Promise.all([
          crmRpc("crm_wa_tag_list", {}),
          crmRpc("crm_customer_tiers_config", {}),
        ]);
        return json(
          {
            tags: t.data ?? [],
            tiers: c.data ?? null,
            can_edit_tiers: a.session.role === "admin",
          },
          200,
          a.session.setCookies,
        );
      },
      POST: async ({ request }) => {
        const { waAccess } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const out = (body: unknown, status = 200) => json(body, status, a.session.setCookies);
        if (!a.canSend) return out({ error: "forbidden" }, 403);
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const b = (await request.json().catch(() => ({}))) as {
          chat?: string;
          tag?: string;
          add?: boolean;
          tiers?: unknown;
        };
        if (b.tiers !== undefined) {
          if (a.session.role !== "admin") return out({ error: "forbidden" }, 403);
          const r = await crmRpc("crm_save_customer_tiers", {
            p_value: b.tiers,
            p_actor: a.session.email,
          });
          if (r.error) return out({ error: "invalid_request", message: r.error.message }, 400);
          return out({ ok: true });
        }
        if (!b.chat || !b.tag?.trim()) return out({ error: "invalid_request" }, 400);
        const r = await crmRpc("crm_wa_tag", {
          p_chat: b.chat,
          p_tag: b.tag,
          p_add: b.add !== false,
          p_actor: a.session.email,
        });
        if (r.error) return out({ error: "invalid_request", message: r.error.message }, 400);
        return out({ ok: true });
      },
    },
  },
});
