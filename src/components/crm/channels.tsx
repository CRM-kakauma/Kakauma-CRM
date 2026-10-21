import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleCheck, CircleDashed, RefreshCw, Send } from "lucide-react";
import { Section } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Connected sending channels (Pushfy, Resend, WhatsApp) and their state; manual opt-out sync. */

interface Channels {
  whatsapp?: {
    configured: boolean;
    live?: boolean;
    /** WHATSAPP_WABA_ID set: the approved templates can be listed */
    templates?: boolean;
    /** WHATSAPP_APP_SECRET + WHATSAPP_VERIFY_TOKEN set */
    webhook?: boolean;
    number?: { display?: string; name?: string; quality?: string; tier?: string } | null;
    error?: string | null;
  };
  pushfy: {
    configured: boolean;
    live?: boolean;
    sms_from?: string | null;
    balance?: unknown;
    balance_error?: string | null;
  };
  email?: { configured: boolean; provider?: string; live?: boolean; from?: string };
  webhook: { configured: boolean };
  /** store links become <base>/l/<code> when sent (e-mail only with a domain of the brand) */
  link_tracking?: { base: string; email: boolean } | null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

export function useChannels() {
  return useQuery({
    queryKey: ["crm-channels"],
    queryFn: () => getJson<Channels>("/api/crm/channels"),
    staleTime: 60_000,
  });
}

function Row({
  name,
  ok,
  status,
  detail,
}: {
  name: string;
  ok: boolean;
  status: string;
  detail?: string;
}) {
  const Icon = ok ? CircleCheck : CircleDashed;
  return (
    <div className="flex items-start gap-3 p-3">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", ok ? "text-success" : "text-muted-foreground")}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {name}{" "}
          <span
            className={cn(
              "ml-1 text-xs font-normal",
              ok ? "text-success" : "text-muted-foreground",
            )}
          >
            {status}
          </span>
        </p>
        {detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

/** Balance as the API returns it: { saldo, channels } — shown key by key. */
function Balance({ value }: { value: unknown }) {
  if (value == null) return null;
  const v = value as { channels?: unknown; saldo?: unknown };
  const channels = v.channels ?? v;
  const entries: [string, unknown][] = Array.isArray(channels)
    ? channels.map((c, i) => {
        const o = (c ?? {}) as Record<string, unknown>;
        return [
          String(o["channel"] ?? o["canal"] ?? o["name"] ?? i),
          o["balance"] ?? o["saldo"] ?? o["value"] ?? JSON.stringify(o),
        ];
      })
    : typeof channels === "object"
      ? Object.entries(channels as Record<string, unknown>)
      : [["saldo", channels]];
  return (
    <div className="flex flex-wrap gap-2 p-3 pt-0">
      {entries.map(([k, val]) => (
        <span key={k} className="rounded-md bg-muted px-2 py-1 text-xs">
          <span className="text-muted-foreground">{k}:</span>{" "}
          <span className="font-medium tabular-nums">
            {typeof val === "object" ? JSON.stringify(val) : String(val)}
          </span>
        </span>
      ))}
    </div>
  );
}

export function ChannelsSection({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useChannels();
  const sync = useMutation({
    mutationFn: () =>
      getJson<{ received: number; customers: number; added: number }>("/api/crm/channels", {
        method: "POST",
      }),
    onSuccess: (r) => {
      toast.success("Descadastros sincronizados", {
        description: `${r.received} na Pushfy · ${r.customers} clientes encontrados · ${r.added} novos bloqueios`,
      });
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const p = data?.pushfy;
  const pushStatus = !p?.configured
    ? "não conectado"
    : p.live
      ? "conectado · envio real LIGADO"
      : "conectado · envio real desligado (só testes)";
  return (
    <Section
      title="Canais de envio"
      description="Por onde as mensagens dos fluxos saem. Enquanto o envio real estiver desligado, tudo fica como Simulação."
      action={
        isAdmin && p?.configured ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
          >
            <RefreshCw className={cn("size-4", sync.isPending && "animate-spin")} /> Sincronizar
            descadastros
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Verificando…</p>
      ) : error ? (
        <p className="text-sm text-danger">{(error as Error).message}</p>
      ) : (
        <div className="surface divide-y divide-border">
          <Row
            name="SMS · Pushfy"
            ok={!!p?.configured && !!p.live}
            status={pushStatus}
            detail={
              !p?.configured
                ? "Coloque PUSHFY_API_TOKEN na Vercel. Depois de testar, ligue o envio real com PUSHFY_LIVE=true."
                : `Remetente: ${p.sms_from || "padrão da conta"}. Quem responder PARAR/SAIR é bloqueado na Pushfy e sincronizado aqui.`
            }
          />
          <Row
            name="RCS · Pushfy"
            ok={!!p?.configured && !!p.live}
            status={pushStatus}
            detail="Texto pelo RCS Basic; cartão com imagem e um botão de link pelo RCS Single; carrossel vai como o primeiro cartão."
          />
          <WhatsappRow wa={data?.whatsapp} />
          <Row
            name="E-mail · Resend"
            ok={!!data?.email?.configured && !!data.email.live}
            status={
              !data?.email?.configured
                ? "não conectado"
                : data.email.live
                  ? "envio real"
                  : "só testes"
            }
            detail={
              !data?.email?.configured
                ? "Coloque RESEND_API_KEY e EMAIL_FROM (endereço do domínio verificado no Resend) na Vercel. Depois de testar, ligue o envio real com EMAIL_LIVE=true."
                : `Remetente: ${data.email.from}. ${data.email.live ? "Fluxos publicados enviam e-mails de verdade." : "Testes (Enviar teste e Disparar teste) já saem; para os fluxos, EMAIL_LIVE=true."}`
            }
          />
          {p?.configured && (
            <div>
              <p className="px-3 pt-3 text-xs font-medium">Saldo na Pushfy</p>
              {p.balance_error ? (
                <p className="p-3 pt-1 text-xs text-danger">{p.balance_error}</p>
              ) : (
                <Balance value={p.balance} />
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

const QUALITY: Record<string, string> = {
  GREEN: "qualidade alta",
  YELLOW: "qualidade média",
  RED: "qualidade baixa",
};

function WhatsappRow({ wa }: { wa: Channels["whatsapp"] }) {
  if (!wa?.configured)
    return (
      <Row
        name="WhatsApp · API oficial (Meta)"
        ok={false}
        status="não conectado"
        detail="Coloque WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_WABA_ID na Vercel (passo a passo na Central de ajuda). Depois de testar, ligue o envio real com WHATSAPP_LIVE=true."
      />
    );
  const n = wa.number;
  const missing = [
    !wa.templates && "WHATSAPP_WABA_ID (para listar os modelos)",
    !wa.webhook && "WHATSAPP_APP_SECRET e WHATSAPP_VERIFY_TOKEN (status de entrega e PARAR)",
  ].filter(Boolean);
  return (
    <Row
      name="WhatsApp · API oficial (Meta)"
      ok={!wa.error && !!wa.live}
      status={
        wa.error
          ? "erro na conexão"
          : wa.live
            ? "conectado · envio real LIGADO"
            : "conectado · envio real desligado (só testes)"
      }
      detail={[
        wa.error ??
          (n
            ? `Número ${n.display ?? "?"}${n.name ? ` (${n.name})` : ""}${n.quality ? ` · ${QUALITY[n.quality] ?? n.quality}` : ""}.`
            : ""),
        missing.length ? `Falta: ${missing.join("; ")}.` : "",
        "Fora da janela de 24h só saem modelos aprovados na Meta: vincule o modelo na mensagem.",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

/** Editor: send this saved SMS / RCS / e-mail / WhatsApp template to one contact now. */
export function TestSend({
  templateKey,
  disabledReason,
  channel = "sms",
}: {
  templateKey: string;
  disabledReason?: string | undefined;
  channel?: "sms" | "rcs" | "email" | "whatsapp";
}) {
  const { data } = useChannels();
  const isEmail = channel === "email";
  const isWa = channel === "whatsapp";
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () =>
      getJson<{ to: string; sent_as?: string; rcs_error?: string }>("/api/crm/messages/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_key: templateKey, to }),
      }),
    onSuccess: (r) =>
      toast.success(
        isEmail ? "Enviado pelo Resend" : isWa ? "Enviado pelo WhatsApp" : "Enviado pela Pushfy",
        {
          description: isEmail
            ? `Para ${r.to}. Confira a caixa de entrada (e o spam).`
            : r.sent_as === "sms_fallback"
              ? `O RCS falhou (${r.rcs_error ?? "recusado"}); foi o SMS alternativo para ${r.to}.`
              : `Para ${r.to}. Confira no celular.`,
        },
      ),
    onError: (e) => toast.error("Não enviou", { description: (e as Error).message }),
  });
  if (
    isEmail
      ? !data?.email?.configured
      : isWa
        ? !data?.whatsapp?.configured
        : !data?.pushfy.configured
  )
    return null;
  return (
    <div className="surface space-y-2 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Send className="size-4 text-primary" /> Enviar teste de verdade
      </p>
      <p className="text-[11px] text-muted-foreground">
        {isEmail
          ? "Manda este e-mail salvo, com os dados de exemplo, para um endereço — pelo Resend (o assunto vai com [TESTE]). Fica registrado na auditoria."
          : isWa
            ? "Manda esta mensagem salva, com os dados de exemplo, para um WhatsApp — pela API oficial (a Meta cobra a conversa). Fora da janela de 24h só chega se estiver vinculada a um modelo aprovado. Fica registrado na auditoria."
            : "Manda esta mensagem salva, com os dados de exemplo, para um celular — pela Pushfy (gasta saldo). Fica registrado na auditoria."}
      </p>
      <div className="flex gap-2">
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={isEmail ? "voce@exemplo.com" : "(11) 99999-9999"}
          inputMode={isEmail ? "email" : "tel"}
          className="h-8"
        />
        <Button
          size="sm"
          className="h-8"
          disabled={
            !!disabledReason ||
            (isEmail ? !/^\S+@\S+\.\S+$/.test(to) : to.replace(/\D/g, "").length < 10) ||
            send.isPending
          }
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
      {disabledReason && <p className="text-[11px] text-warning-foreground">{disabledReason}</p>}
    </div>
  );
}
