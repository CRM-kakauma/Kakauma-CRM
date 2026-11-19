/** "Por que não entrou?": of everyone who triggered the flow, who entered and why the others did not. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ApiErrorBox, Empty, Loading, Pill } from "@/components/crm/ui";
import { FACT_LABEL, label, useCrm } from "@/lib/crm-api";
import { count, dateTime } from "@/lib/crm-format";
import { cn } from "@/lib/utils";

interface Diagnosis {
  flow: string;
  status: string;
  reentry: string;
  trigger_fact: string;
  max_trigger_age_hours: number;
  hours: number;
  facts: number;
  people: number;
  by_result: Record<string, number>;
  recent: { at: string; customer_id: string; who: string; result: string }[];
}

const RESULT: Record<
  string,
  { label: string; tone: "success" | "warning" | "danger" | "muted"; why: string; fix?: string }
> = {
  entered: { label: "Entrou", tone: "success", why: "Entrou no fluxo." },
  entry_rule: {
    label: "Entrou e saiu (regra de entrada)",
    tone: "warning",
    why: "Entrou, mas não passou na regra de entrada do fluxo e saiu na hora, sem receber nada.",
    fix: "Confira a regra de entrada em Configurações do fluxo.",
  },
  once: {
    label: "Já tinha passado pelo fluxo",
    tone: "warning",
    why: "O fluxo está como “uma vez só na vida” e essa pessoa já tinha passado por ele antes.",
    fix: "Para deixar a pessoa entrar de novo: Construtor → Configurações → “Pode entrar de novo?” → “Sim, depois de terminar o anterior”.",
  },
  busy: {
    label: "Já estava no fluxo",
    tone: "muted",
    why: "A pessoa ainda estava no meio do fluxo (por um gatilho anterior) quando o gatilho se repetiu.",
  },
  filter: {
    label: "Fora do filtro do gatilho",
    tone: "muted",
    why: "O evento não bate com o filtro do gatilho (ex.: outro produto ou oferta).",
    fix: "Confira o filtro do gatilho em Configurações do fluxo.",
  },
  too_old: {
    label: "Evento antigo",
    tone: "muted",
    why: "O evento chegou ao CRM depois do prazo “Ignorar fatos mais antigos que (horas)”.",
    fix: "Aumente esse prazo em Configurações, se fizer sentido.",
  },
  history: {
    label: "Histórico (importação/reenvio)",
    tone: "muted",
    why: "Veio de importação de histórico ou reenvio em lote: nunca coloca ninguém em fluxo.",
  },
  inactive: {
    label: "Fluxo não estava ativo",
    tone: "danger",
    why: "O fluxo estava pausado ou em rascunho.",
    fix: "Publique e ative o fluxo.",
  },
  other: { label: "Não entrou (outro motivo)", tone: "danger", why: "Motivo não identificado." },
};
const ORDER = [
  "entered",
  "once",
  "busy",
  "entry_rule",
  "filter",
  "too_old",
  "history",
  "inactive",
  "other",
];

export function FlowEntryDiagnosis({ flowKey }: { flowKey: string }) {
  const [hours, setHours] = useState(24);
  const { data, isLoading, error } = useCrm<Diagnosis>("crm_flow_entry_diagnosis", {
    p_key: flowKey,
    p_hours: hours,
  });
  if (error) return <ApiErrorBox error={error} />;
  if (isLoading || !data) return <Loading rows={3} />;
  const entered = (data.by_result["entered"] ?? 0) as number;
  const out = data.facts - entered;
  const reasons = ORDER.filter((k) => k !== "entered" && (data.by_result[k] ?? 0) > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          Gatilho “{label(FACT_LABEL, data.trigger_fact)}” nas últimas
        </span>
        {[24, 72, 168].map((h) => (
          <button
            key={h}
            type="button"
            onClick={() => setHours(h)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs",
              hours === h
                ? "bg-primary-soft font-medium text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {h === 24 ? "24 horas" : h === 72 ? "3 dias" : "7 dias"}
          </button>
        ))}
      </div>

      {data.facts === 0 ? (
        <Empty>
          Ninguém disparou o gatilho “{label(FACT_LABEL, data.trigger_fact)}” nesse período. Se você
          esperava eventos, o problema está antes do fluxo: confira em Operação se os eventos da
          B4you estão chegando.
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="surface p-4">
              <p className="text-xs text-muted-foreground">Dispararam o gatilho</p>
              <p className="text-2xl font-semibold">{count(data.facts)}</p>
              <p className="text-xs text-muted-foreground">{count(data.people)} pessoas</p>
            </div>
            <div className="surface p-4">
              <p className="text-xs text-muted-foreground">Entraram</p>
              <p className="text-2xl font-semibold text-success">{count(entered)}</p>
            </div>
            <div className="surface p-4">
              <p className="text-xs text-muted-foreground">Ficaram de fora</p>
              <p className={cn("text-2xl font-semibold", out > 0 && "text-warning-foreground")}>
                {count(out)}
              </p>
            </div>
          </div>

          {reasons.length > 0 && (
            <div className="surface divide-y divide-border">
              {reasons.map((k) => {
                const r = RESULT[k] ?? RESULT["other"]!;
                return (
                  <div key={k} className="flex flex-wrap items-start gap-3 p-4">
                    <Pill tone={r.tone}>{count(data.by_result[k] ?? 0)}</Pill>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{r.label}</p>
                      <p className="text-sm text-muted-foreground">{r.why}</p>
                      {r.fix && <p className="mt-1 text-sm text-primary">→ {r.fix}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Quando</th>
                  <th className="px-4 py-2 font-medium">Cliente</th>
                  <th className="px-4 py-2 font-medium">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r, i) => {
                  const res = RESULT[r.result] ?? RESULT["other"]!;
                  return (
                    <tr key={`${r.at}-${i}`} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {dateTime(r.at)}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          to="/customers/$customerId"
                          params={{ customerId: r.customer_id }}
                          className="hover:text-primary"
                        >
                          {r.who}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        <Pill tone={res.tone}>{res.label}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
