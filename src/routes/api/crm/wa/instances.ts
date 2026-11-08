import { createFileRoute } from "@tanstack/react-router";

/**
 * WhatsApp numbers of the inbox (Evolution instances).
 * GET: the numbers with their live connection state and unread count.
 * POST { action }: create (new number + QR) · connect (QR again) · state · rename · sync (bring the
 * phone's conversations) · logout (disconnect) · delete (admin).
 */
type Row = { name: string; label: string; color: string; state: string | null };

export const Route = createFileRoute("/api/crm/wa/instances")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { waAccess, flowsInstance } = await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const { evolutionStatus } = await import("@/server/crm/evolution");
        const flows = flowsInstance();
        let r = await crmRpc("crm_wa_instances", {});
        if (r.error)
          return json(
            {
              error: "database",
              message: r.error.message.includes("crm_wa_instances")
                ? "Rode a atualização do Supabase (0046) para usar o WhatsApp."
                : r.error.message,
            },
            500,
            a.session.setCookies,
          );
        let rows = (r.data ?? []) as Row[];
        // the number of the flows (EVOLUTION_INSTANCE) is always there
        if (flows && !rows.some((x) => x.name === flows)) {
          await crmRpc("crm_wa_save_instance", {
            p_name: flows,
            p_label: "Kakauma",
            p_color: "#075DA8",
          });
          r = await crmRpc("crm_wa_instances", {});
          rows = (r.data ?? []) as Row[];
        }
        // live state, a few seconds at most
        const live = await Promise.all(
          rows.map(async (row) => {
            try {
              const st = await Promise.race([
                evolutionStatus({ ...a.cfg, instance: row.name }),
                new Promise<null>((res) => setTimeout(() => res(null), 4000)),
              ]);
              if (st && st.ok) {
                await crmRpc("crm_wa_save_instance", {
                  p_name: row.name,
                  p_label: null,
                  p_number: st.number,
                  p_profile: st.name,
                  p_state: st.state,
                });
                return {
                  ...row,
                  state: st.state,
                  number: st.number ?? (row as { number?: string | null }).number ?? null,
                  profile_name:
                    st.name ?? (row as { profile_name?: string | null }).profile_name ?? null,
                };
              }
              if (st && !st.ok) return { ...row, state: "missing", error: st.error };
            } catch {
              /* keep the last known state */
            }
            return row;
          }),
        );
        return json(
          {
            instances: live.map((x) => ({ ...x, flows: x.name === flows })),
            can_manage: a.session.role !== "viewer",
            can_delete: a.session.role === "admin",
          },
          200,
          a.session.setCookies,
        );
      },
      POST: async ({ request }) => {
        const { waAccess, waWebhookUrl, flowsInstance } =
          await import("@/server/crm/wa-route.server");
        const a = await waAccess(request);
        if (!a.ok) return a.response;
        const { json } = await import("@/server/crm/auth.server");
        const { crmRpc } = await import("@/server/crm/supabase.server");
        const wa = await import("@/server/crm/wa-inbox");
        const { evolutionConnect, evolutionSetWebhook, evolutionStatus } =
          await import("@/server/crm/evolution");
        const out = (body: unknown, status = 200) => json(body, status, a.session.setCookies);
        if (!a.canSend) return out({ error: "forbidden" }, 403);
        const b = (await request.json().catch(() => ({}))) as {
          action?: string;
          name?: string;
          label?: string;
          color?: string;
        };
        const name = (b.name ?? "").trim();
        const hook = waWebhookUrl(request);
        try {
          switch (b.action) {
            case "create": {
              const label = (b.label ?? "").trim() || "WhatsApp";
              if (!hook)
                return out(
                  {
                    error: "not_configured",
                    message: "Falta EVOLUTION_WEBHOOK_TOKEN no servidor.",
                  },
                  400,
                );
              const inst = wa.instanceName(label);
              const r = await wa.waCreateInstance(a.cfg, inst, hook);
              if (!r.ok) return out({ error: "evolution", message: r.error }, 502);
              await crmRpc("crm_wa_save_instance", {
                p_name: inst,
                p_label: label,
                p_color: b.color ?? null,
                p_state: "connecting",
                p_actor: a.session.email,
              });
              let qr = r.qr;
              if (!qr) {
                const c = await evolutionConnect({ ...a.cfg, instance: inst });
                if (c.ok) qr = c.qr;
              }
              return out({ ok: true, name: inst, qr });
            }
            case "connect": {
              if (!name) return out({ error: "invalid_request" }, 400);
              // the webhook goes with it: the conversations of this number reach the CRM
              if (hook)
                await evolutionSetWebhook({ ...a.cfg, instance: name }, hook).catch(() => null);
              const c = await evolutionConnect({ ...a.cfg, instance: name });
              if (!c.ok) return out({ error: "evolution", message: c.error }, 502);
              return out({ ok: true, qr: c.qr, pairing_code: c.pairingCode, state: c.state });
            }
            case "state": {
              const st = await evolutionStatus({ ...a.cfg, instance: name });
              if (!st.ok) return out({ ok: false, state: "missing", error: st.error });
              await crmRpc("crm_wa_save_instance", {
                p_name: name,
                p_label: null,
                p_number: st.number,
                p_profile: st.name,
                p_state: st.state,
              });
              return out({ ok: true, state: st.state, number: st.number, profile_name: st.name });
            }
            case "rename": {
              await crmRpc("crm_wa_save_instance", {
                p_name: name,
                p_label: b.label ?? null,
                p_color: b.color ?? null,
              });
              return out({ ok: true });
            }
            case "sync": {
              const r = await wa.waChats(a.cfg, name);
              if (!r.ok) return out({ error: "evolution", message: r.error }, 502);
              const s = await crmRpc("crm_wa_ingest", {
                p_instance: name,
                p_messages: r.messages,
                p_statuses: [],
                p_history: true,
              });
              if (s.error) return out({ error: "database", message: s.error.message }, 500);
              return out({ ok: true, chats: r.messages.length });
            }
            case "logout": {
              const r = await wa.waLogout(a.cfg, name);
              if (!r.ok) return out({ error: "evolution", message: r.error }, 502);
              await crmRpc("crm_wa_save_instance", {
                p_name: name,
                p_label: null,
                p_state: "close",
              });
              return out({ ok: true });
            }
            case "delete": {
              if (a.session.role !== "admin") return out({ error: "forbidden" }, 403);
              if (name === flowsInstance())
                return out(
                  {
                    error: "invalid_request",
                    message:
                      "Este é o número dos fluxos (EVOLUTION_INSTANCE): não pode ser apagado aqui.",
                  },
                  400,
                );
              const r = await wa.waDeleteInstance(a.cfg, name);
              if (!r.ok) return out({ error: "evolution", message: r.error }, 502);
              await crmRpc("crm_wa_delete_instance", { p_name: name });
              return out({ ok: true });
            }
            default:
              return out({ error: "invalid_request" }, 400);
          }
        } catch (e) {
          return out({ error: "server_error", message: (e as Error).message }, 500);
        }
      },
    },
  },
});
