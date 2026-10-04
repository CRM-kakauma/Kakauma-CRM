import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, CardsSkeleton } from "@/components/states";
import { ContactSheet } from "@/components/crm/contact-sheet";
import { Avatar, PriorityPill, ReasonPill } from "@/components/crm/pills";
import { formatCurrency, formatDateTime, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  DEAL_STAGE_LABEL,
  TASK_TYPE_LABEL,
  crmSummary,
  listRecoveries,
  listTasks,
} from "@/services/crm";

export const Route = createFileRoute("/crm")({
  head: () => ({
    meta: [
      { title: "Painel CRM — Kakauma" },
      {
        name: "description",
        content: "Resumo do relacionamento: pipeline, recuperação de vendas e tarefas do dia.",
      },
    ],
  }),
  component: CrmDashboard,
});

const STAGE_BAR: Record<string, string> = {
  novo: "bg-muted-foreground/40",
  contato: "bg-primary/60",
  proposta: "bg-primary",
  negociacao: "bg-warning",
  ganho: "bg-success",
  perdido: "bg-danger",
};

function CrmDashboard() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data: s, isLoading } = useQuery({ queryKey: ["crm", "summary"], queryFn: crmSummary });
  const { data: tasks = [] } = useQuery({ queryKey: ["crm", "tasks"], queryFn: listTasks });
  const { data: recs = [] } = useQuery({
    queryKey: ["crm", "recoveries", { status: "pendente" }],
    queryFn: () => listRecoveries({ status: "pendente" }),
  });

  const upcoming = tasks.filter((t) => !t.done).slice(0, 6);
  const maxStage = Math.max(1, ...(s?.stages.map((x) => x.value) ?? [1]));

  return (
    <>
      <PageHeader title="Painel CRM" description="O que precisa da sua atenção hoje." />

      {isLoading || !s ? (
        <CardsSkeleton count={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label="Contatos"
            value={formatNumber(s.contacts)}
            hint={`${s.leads} leads · ${s.customers} clientes · +${s.newContacts7d} em 7 dias`}
            to="/contacts"
          />
          <Kpi
            label="Pipeline em aberto"
            value={formatCurrency(s.pipelineValue, true)}
            hint={`${s.openDeals} negócios · ${formatPercent(s.winRate, 0)} de ganho`}
            to="/pipeline"
          />
          <Kpi
            label="A recuperar"
            value={formatCurrency(s.recoveryPendingValue, true)}
            hint={`${s.recoveryPending} vendas · ${formatCurrency(s.recoveredValue, true)} recuperados`}
            to="/recovery"
          />
          <Kpi
            label="Tarefas"
            value={formatNumber(s.tasksOverdue + s.tasksToday)}
            hint={`${s.tasksOverdue} atrasadas · ${s.tasksToday} para hoje`}
            to="/tasks"
            alert={s.tasksOverdue > 0}
          />
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <section className="surface p-5 xl:col-span-1">
          <SectionTitle title="Pipeline por etapa" to="/pipeline" />
          {!s ? (
            <BlockSkeleton height={220} />
          ) : (
            <ul className="space-y-3">
              {s.stages.map((st) => (
                <li key={st.key}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span>
                      {DEAL_STAGE_LABEL[st.key]}{" "}
                      <span className="text-muted-foreground">({st.count})</span>
                    </span>
                    <span className="num">{formatCurrency(st.value, true)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className={cn("h-2 rounded-full", STAGE_BAR[st.key])}
                      style={{ width: `${(st.value / maxStage) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="surface p-5">
          <SectionTitle title="Próximas tarefas" to="/tasks" />
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma tarefa em aberto.</p>
          ) : (
            <ul className="space-y-3">
              {upcoming.map((t) => {
                const late = new Date(t.due_at) < new Date();
                return (
                  <li key={t.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{t.title}</p>
                      <p className={cn("text-xs text-muted-foreground", late && "text-danger")}>
                        {TASK_TYPE_LABEL[t.type]} · {formatDateTime(t.due_at)}
                      </p>
                    </div>
                    <PriorityPill priority={t.priority} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="surface p-5">
          <SectionTitle title="Recuperação pendente" to="/recovery" />
          {recs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma venda pendente.</p>
          ) : (
            <ul className="space-y-3">
              {recs.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(r.contact_id)}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <Avatar name={r.contact.name} className="size-7 text-[10px]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{r.contact.name}</p>
                      <ReasonPill reason={r.reason} />
                    </div>
                    <span className="text-sm num">{formatCurrency(r.value)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ContactSheet contactId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function Kpi({
  label,
  value,
  hint,
  to,
  alert,
}: {
  label: string;
  value: string;
  hint: string;
  to: string;
  alert?: boolean;
}) {
  return (
    <Link to={to} className="surface block p-5 transition-shadow hover:shadow-float">
      <p className="label-eyebrow">{label}</p>
      <p className={cn("metric-value mt-3", alert && "text-danger")}>{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </Link>
  );
}

function SectionTitle({ title, to }: { title: string; to: string }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-base font-semibold">{title}</h2>
      <Link to={to} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        Ver tudo <ArrowRight className="size-3" />
      </Link>
    </div>
  );
}
