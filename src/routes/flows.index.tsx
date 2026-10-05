import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Workflow } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { FACT_LABEL, label, useCrm, type Me } from "@/lib/crm-api";
import { count, date, pct } from "@/lib/crm-format";

export const Route = createFileRoute("/flows/")({
  head: () => ({ meta: [{ title: "Fluxos — Kakauma CRM" }] }),
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
  return (
    <>
      <PageHeader
        title="Fluxos"
        description="Jornadas com várias etapas: um fato coloca o cliente no fluxo, que envia mensagens, espera, verifica condições e testa variações até a meta."
        help="fluxos"
      >
        {me.role !== "viewer" && (
          <Button asChild>
            <Link to="/flows/$key" params={{ key: "new" }}>
              <Plus className="size-4" /> Novo fluxo
            </Link>
          </Button>
        )}
      </PageHeader>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Nenhum fluxo ainda. Crie o primeiro com “Novo fluxo”.</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((f) => {
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
                      {f.goal_fact ? ` · Meta: ${label(FACT_LABEL, f.goal_fact)}` : ""} · {f.steps}{" "}
                      etapas
                    </p>
                  </div>
                  <Pill tone={FLOW_STATUS[f.status]?.tone ?? "muted"}>
                    {FLOW_STATUS[f.status]?.label ?? f.status}
                  </Pill>
                </div>
                {f.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{f.description}</p>
                )}
                <div className="mt-3 grid grid-cols-4 gap-2 border-t border-border pt-3 text-center">
                  <Mini label="no fluxo agora" v={count(f.live)} />
                  <Mini label="entraram (30d)" v={count(f.entered_30d)} />
                  <Mini
                    label="meta atingida"
                    v={
                      f.goal_fact ? pct(finished ? (Number(f.goals) / finished) * 100 : null) : "—"
                    }
                  />
                  <Mini label="mensagens (30d)" v={count(f.messages_30d)} />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {f.version
                    ? `versão ${f.version} publicada ${date(f.published_at)}`
                    : "nunca publicado"}{" "}
                  · editado {date(f.updated_at)}
                </p>
              </Link>
            );
          })}
        </div>
      )}
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
