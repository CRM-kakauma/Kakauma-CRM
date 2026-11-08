/** Shared checks of the WhatsApp inbox routes (/api/crm/wa/*). */
import { getSession, json, type Session } from "./auth.server.ts";
import { demoMode, env } from "./supabase.server.ts";

export type WaAccess =
  | { ok: true; session: Session; cfg: { baseUrl: string; apiKey: string }; canSend: boolean }
  | { ok: false; response: Response };

/**
 * Who opens the inbox: X1 (atendimento), operators and admins send; "viewer" only reads.
 * Needs EVOLUTION_API_URL and EVOLUTION_API_KEY (the same Evolution server of the flows).
 */
export async function waAccess(request: Request): Promise<WaAccess> {
  const session = await getSession(request);
  if (!session) return { ok: false, response: json({ error: "unauthenticated" }, 401) };
  if (demoMode())
    return {
      ok: false,
      response: json(
        { error: "demo_mode", message: "Modo demonstração: configure o Supabase do CRM." },
        400,
        session.setCookies,
      ),
    };
  const baseUrl = env("EVOLUTION_API_URL")?.trim();
  const apiKey = env("EVOLUTION_API_KEY")?.trim();
  if (!baseUrl || !apiKey)
    return {
      ok: false,
      response: json(
        {
          error: "not_configured",
          message: "Falta EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor (Cloudflare).",
        },
        400,
        session.setCookies,
      ),
    };
  return { ok: true, session, cfg: { baseUrl, apiKey }, canSend: session.role !== "viewer" };
}

/** URL the Evolution instances post to (the same webhook of the flows). */
export function waWebhookUrl(request: Request): string | null {
  const token = env("EVOLUTION_WEBHOOK_TOKEN")?.trim();
  if (!token) return null;
  const base = (env("CRM_APP_URL")?.trim() || new URL(request.url).origin).replace(/\/+$/, "");
  return `${base}/api/webhooks/evolution?token=${encodeURIComponent(token)}`;
}

export const flowsInstance = () => env("EVOLUTION_INSTANCE")?.trim() || null;
