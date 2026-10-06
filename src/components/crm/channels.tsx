import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CircleCheck, CircleDashed, RefreshCw, Send } from "lucide-react";
import { Section } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Connected sending channels (Pushfy) and their balance; manual opt-out sync. */

interface Channels {
  pushfy: {
    configured: boolean;
    live?: boolean;
    sms_from?: string | null;
    balance?: unknown;
    balance_error?: string | null;
  };
  webhook: { configured: boolean };
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
            status={p?.configured ? "só RCS de texto" : "não conectado"}
            detail="Cartão e carrossel ficam em espera até recebermos a documentação desse formato da Pushfy."
          />
          <Row
            name="WhatsApp"
            ok={false}
            status="simulação"
            detail="Aguardando a documentação de WhatsApp da Pushfy."
          />
          <Row
            name="E-mail"
            ok={data?.webhook.configured ?? false}
            status={data?.webhook.configured ? "webhook de saída" : "simulação"}
            detail="Sem provedor de e-mail conectado."
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

/** Editor: send this saved SMS / RCS template to one number now. */
export function TestSend({
  templateKey,
  disabledReason,
}: {
  templateKey: string;
  disabledReason?: string | undefined;
}) {
  const { data } = useChannels();
  const [to, setTo] = useState("");
  const send = useMutation({
    mutationFn: () =>
      getJson<{ to: string }>("/api/crm/messages/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_key: templateKey, to }),
      }),
    onSuccess: (r) =>
      toast.success("Enviado pela Pushfy", { description: `Para ${r.to}. Confira no celular.` }),
    onError: (e) => toast.error("Não enviou", { description: (e as Error).message }),
  });
  if (!data?.pushfy.configured) return null;
  return (
    <div className="surface space-y-2 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Send className="size-4 text-primary" /> Enviar teste de verdade
      </p>
      <p className="text-[11px] text-muted-foreground">
        Manda esta mensagem salva, com os dados de exemplo, para um celular — pela Pushfy (gasta
        saldo). Fica registrado na auditoria.
      </p>
      <div className="flex gap-2">
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="(11) 99999-9999"
          inputMode="tel"
          className="h-8"
        />
        <Button
          size="sm"
          className="h-8"
          disabled={!!disabledReason || to.replace(/\D/g, "").length < 10 || send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Enviando…" : "Enviar"}
        </Button>
      </div>
      {disabledReason && <p className="text-[11px] text-warning-foreground">{disabledReason}</p>}
    </div>
  );
}
