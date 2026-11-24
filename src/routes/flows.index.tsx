import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Copy, Megaphone, Play, Plus, Workflow } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AUDIENCE_LABEL,
  BROADCAST_FACT,
  describeSchedule,
  RUN_STATUS,
  type BroadcastConfig,
  type BroadcastRun,
} from "@/lib/crm-broadcast";
import { canOperate, FACT_LABEL, label, useCrm, type Me } from "@/lib/crm-api";
import { duplicateFlow } from "@/lib/crm-flow-copy";
import { count, date, dateTime, pct } from "@/lib/crm-format";

export const Route = createFileRoute("/flows/")({
  head: () => ({ meta: [{ title: "Fluxos — Kakauma CRM" }] }),
  validateSearch: (s: Record<string, unknown>): { aba?: "disparos" | undefined } => ({
    aba: s["aba"] === "disparos" ? "disparos" : undefined,
  }),
  component: () => <RequireAuth>{(me) => <Flows me={me} />}</RequireAuth>,
});

interface FlowRow {
  key: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "PAUSED";
  trigger_fact: string;
  goal_fact: string | null;
  version: number;
  published_at: string | null;
  updated_at: string;
  steps: number;
  live: number;
  completed: number;
  goals: number;
  exited: number;
  entered_30d: number;
  messages_30d: number;
  broadcast: BroadcastConfig | null;
  next_run_at: string | null;
  last_run_at: string | null;
  segment_name: string | null;
  last_run: BroadcastRun | null;
}

export const FLOW_STATUS: Record<string, { label: string; tone: "success" | "warning" | "muted" }> =
  {
    ACTIVE: { label: "Ativo", tone: "success" },
    PAUSED: { label: "Pausado", tone: "warning" },
    DRAFT: { label: "Rascunho", tone: "muted" },
    ARCHIVED: { label: "Arquivado", tone: "muted" },
  };

function Flows({ me }: { me: Me }) {
  const { data, isLoading, error } = useCrm<FlowRow[]>(
    "crm_list_flows",
    {},
    { refetchInterval: 30_000 },
  );
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [copying, setCopying] = useState<string | null>(null);
  const duplicate = (key: string) => {
    setCopying(key);
    duplicateFlow(key)
      .then((k) => {
        toast.success("Fluxo duplicado", {
          description: "A cópia é um rascunho: ajuste e publique quando quiser.",
        });
        void qc.invalidateQueries({ queryKey: ["crm"] });
        void navigate({ to: "/flows/$key", params: { key: k } });
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setCopying(null));
  };
  const { aba } = Route.useSearch();
  const tab = aba ?? "jornadas";
  const journeys = (data ?? []).filter((f) => f.trigger_fact !== BROADCAST_FACT);
  const broadcasts = (data ?? []).filter((f) => f.trigger_fact === BROADCAST_FACT);
  const copyButton = (f: FlowRow) =>
    canOperate(me) && (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 shrink-0 text-xs"
        disabled={copying !== null}
        onClick={(e) => {
          // the card is a link: duplicate without opening the flow
          e.preventDefault();
          e.stopPropagation();
          duplicate(f.key);
        }}
      >
        <Copy className="size-3.5" /> {copying === f.key ? "Duplicando…" : "Duplicar"}
      </Button>
    );
  return (
    <>
      <PageHeader
        title="Fluxos"
        description="Jornadas começam quando o cliente faz algo (abandona o carrinho, compra…). Disparos são agendados: num horário, enviam para todos de um segmento."
        help="fluxos"
      >
        {canOperate(me) && <RunNow />}
        {canOperate(me) &&
          (tab === "disparos" ? (
            <Button asChild>
              <Link to="/flows/$key" params={{ key: "new" }} search={{ tipo: "disparo" }}>
                <Plus className="size-4" /> Novo disparo
              </Link>
            </Button>
          ) : (
            <Button asChild>
              <Link to="/flows/$key" params={{ key: "new" }}>
                <Plus className="size-4" /> Nova jornada
              </Link>
            </Button>
          ))}
      </PageHeader>
      <ApiErrorBox error={error} />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          void navigate({
            to: "/flows",
            search: { aba: v === "disparos" ? "disparos" : undefined },
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="jornadas">
            <Workflow className="size-4" /> Jornadas
            {data && <span className="ml-1 text-xs text-muted-foreground">{journeys.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="disparos">
            <Megaphone className="size-4" /> Disparos
            {data && (
              <span className="ml-1 text-xs text-muted-foreground">{broadcasts.length}</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="jornadas" className="mt-4">
          {isLoading ? (
            <Loading />
          ) : !journeys.length ? (
            <Empty>Nenhuma jornada ainda. Crie a primeira com “Nova jornada”.</Empty>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {journeys.map((f) => {
                const finished = Number(f.completed) + Number(f.goals) + Number(f.exited);
                return (
                  <Link
                    key={f.key}
                    to="/flows/$key"
                    params={{ key: f.key }}
                    className="surface block p-4 transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          <Workflow className="size-4 shrink-0 text-primary" />
                          <span className="truncate">{f.name}</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Quando: {label(FACT_LABEL, f.trigger_fact)}
                          {f.goal_fact ? ` · Meta: ${label(FACT_LABEL, f.goal_fact)}` : ""} ·{" "}
                          {f.steps} etapas
                        </p>
                      </div>
                      <Pill tone={FLOW_STATUS[f.status]?.tone ?? "muted"}>
                        {FLOW_STATUS[f.status]?.label ?? f.status}
                      </Pill>
                    </div>
                    {f.description && (
                      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                        {f.description}
                      </p>
                    )}
                    <div className="mt-3 grid grid-cols-4 gap-2 border-t border-border pt-3 text-center">
                      <Mini label="no fluxo agora" v={count(f.live)} />
                      <Mini label="entraram (30d)" v={count(f.entered_30d)} />
                      <Mini
                        label="meta atingida"
                        v={
                          f.goal_fact
                            ? pct(finished ? (Number(f.goals) / finished) * 100 : null)
                            : "—"
                        }
                      />
                      <Mini label="mensagens (30d)" v={count(f.messages_30d)} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] text-muted-foreground">
                        {f.version
                          ? `versão ${f.version} publicada ${date(f.published_at)}`
                          : "nunca publicado"}{" "}
                        · editado {date(f.updated_at)}
                      </p>
                      {copyButton(f)}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="disparos" className="mt-4">
          {isLoading ? (
            <Loading />
          ) : !broadcasts.length ? (
            <Empty>
              Nenhum disparo ainda. Com “Novo disparo” você escolhe o segmento, o dia e horário (uma
              vez ou todo dia) e se cada cliente recebe uma vez na vida ou uma vez por jornada.
            </Empty>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {broadcasts.map((f) => {
                const last = f.last_run;
                const scheduled = f.status === "ACTIVE" && f.next_run_at;
                return (
                  <Link
                    key={f.key}
                    to="/flows/$key"
                    params={{ key: f.key }}
                    className="surface block p-4 transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          <Megaphone className="size-4 shrink-0 text-primary" />
                          <span className="truncate">{f.name}</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Para: {f.segment_name ?? "segmento não escolhido"} · {f.steps} etapas
                        </p>
                      </div>
                      <Pill tone={FLOW_STATUS[f.status]?.tone ?? "muted"}>
                        {FLOW_STATUS[f.status]?.label ?? f.status}
                      </Pill>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                      <span className="rounded-md bg-muted px-2 py-0.5">
                        {describeSchedule(f.broadcast?.schedule)}
                      </span>
                      {f.broadcast && (
                        <span className="rounded-md bg-muted px-2 py-0.5">
                          {AUDIENCE_LABEL[f.broadcast.audience]}
                        </span>
                      )}
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
                      <Mini label="no disparo agora" v={count(f.live)} />
                      <Mini
                        label="entraram no último"
                        v={last && last.status !== "MISSED" ? count(last.enrolled) : "—"}
                      />
                      <Mini label="mensagens (30d)" v={count(f.messages_30d)} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <CalendarClock className="size-3.5" />
                        {scheduled ? `Próximo: ${dateTime(f.next_run_at)}` : "Nada agendado"}
                        {last &&
                          ` · último: ${dateTime(last.status === "MISSED" ? last.scheduled_for : last.ran_at)} (${(RUN_STATUS[last.status]?.label ?? last.status).toLowerCase()})`}
                      </p>
                      {copyButton(f)}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function Mini({ label: l, v }: { label: string; v: string }) {
  return (
    <div>
      <p className="text-base font-semibold tabular-nums">{v}</p>
      <p className="text-[10px] text-muted-foreground">{l}</p>
    </div>
  );
}

/** Advances every flow and sends what is due now, without waiting for the scheduled job. */
function RunNow() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/crm/flows/run", {
        method: "POST",
        credentials: "same-origin",
      });
      const b = (await res.json().catch(() => ({}))) as {
        advanced?: number;
        messages?: number;
        sent?: number;
        dry_run?: number;
        skipped?: number;
        failed?: number;
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(b.message ?? b.error ?? `HTTP ${res.status}`);
      const parts = [
        b.sent ? `${b.sent} enviada(s)` : "",
        b.dry_run ? `${b.dry_run} em simulação` : "",
        b.skipped ? `${b.skipped} ignorada(s)` : "",
        b.failed ? `${b.failed} com falha` : "",
      ].filter(Boolean);
      toast.success("Fluxos processados", {
        description: b.messages
          ? `${b.advanced ?? 0} etapa(s) avançada(s); mensagens: ${parts.join(", ")}.`
          : b.advanced
            ? `${b.advanced} etapa(s) avançada(s); nenhuma mensagem para enviar agora.`
            : "Nada pendente agora: quem está nos fluxos está esperando uma etapa de espera.",
      });
      void qc.invalidateQueries({ queryKey: ["crm"] });
    } catch (e) {
      toast.error("Não processou", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" onClick={() => void run()} disabled={busy}>
      <Play className="size-4" /> {busy ? "Processando…" : "Processar agora"}
    </Button>
  );
}
