import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { FilterSelect } from "@/components/crm/filter-select";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth } from "@/components/crm/ui";
import { count, dateTime } from "@/lib/crm-format";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { AutomationDialog } from "@/components/crm/automation-dialog";
import type { Rule } from "@/components/crm/rule-builder";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FACT_LABEL,
  RUN_STATUS_LABEL,
  SKIP_LABEL,
  crmCall,
  label,
  useCrm,
  type Me,
} from "@/lib/crm-api";

export const Route = createFileRoute("/automations")({
  head: () => ({ meta: [{ title: "Automações — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Automations me={me} />}</RequireAuth>,
});

interface Automation {
  key: string;
  name: string;
  description: string | null;
  trigger_fact: string;
  trigger_filter: Record<string, unknown>;
  conditions: Rule;
  action_type: "message" | "internal_alert";
  action_config: { channel?: string; template?: string; message?: string };
  max_trigger_age_hours: number;
  priority: number;
  active: boolean;
  delay_minutes: number;
  cooldown_hours: number;
  queued: number;
  sent: number;
  dry_run: number;
  skipped: number;
  failed: number;
}
interface Run {
  run_id: string;
  automation: string;
  automation_name: string;
  customer_id: string;
  customer_name: string | null;
  status: string;
  skip_reason: string | null;
  channel: string | null;
  message: string | null;
  scheduled_for: string;
  executed_at: string | null;
  error: string | null;
}

const RUN_TONE: Record<string, "success" | "primary" | "warning" | "danger" | "muted"> = {
  SENT: "success",
  DRY_RUN: "primary",
  QUEUED: "muted",
  PROCESSING: "muted",
  SKIPPED: "muted",
  FAILED: "danger",
};

function Automations({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const canEdit = me.role !== "viewer";
  const list = useCrm<Automation[]>("crm_list_automations");
  const runs = useCrm<Run[]>("crm_list_automation_runs", {
    p_key: filter === "all" ? null : filter,
    p_limit: 100,
  });

  const toggle = useMutation({
    mutationFn: (a: { key: string; active: boolean }) =>
      crmCall("crm_set_automation_active", { p_key: a.key, p_active: a.active }),
    onSuccess: (_, a) => {
      toast.success(a.active ? "Automação ligada" : "Automação desligada");
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <>
      <PageHeader
        title="Automações simples"
        help="fluxos"
        description="Uma mensagem quando um fato acontece (fato → filtro → condições → ação). Para jornadas com várias etapas, esperas e testes A/B, use Fluxos."
      >
        {canEdit && <Button onClick={() => setEditing("new")}>Nova automação</Button>}
      </PageHeader>
      <ApiErrorBox error={list.error} />
      {list.isLoading ? (
        <Loading rows={5} />
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Automação</TableHead>
                <TableHead>Gatilho</TableHead>
                <TableHead className="text-right">Espera</TableHead>
                <TableHead className="text-right">Simuladas</TableHead>
                <TableHead className="text-right">Enviadas</TableHead>
                <TableHead className="text-right">Puladas</TableHead>
                <TableHead className="text-right">Agendadas</TableHead>
                <TableHead className="text-right">Ativa</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((a) => (
                <TableRow key={a.key}>
                  <TableCell>
                    <button type="button" className="text-left" onClick={() => setFilter(a.key)}>
                      <p className="font-medium hover:text-primary">{a.name}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{a.key}</p>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {label(FACT_LABEL, a.trigger_fact)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {a.delay_minutes ? `${a.delay_minutes} min` : "imediato"}
                  </TableCell>
                  <TableCell className="text-right num">{count(a.dry_run)}</TableCell>
                  <TableCell className="text-right num">{count(a.sent)}</TableCell>
                  <TableCell className="text-right num">{count(a.skipped)}</TableCell>
                  <TableCell className="text-right num">{count(a.queued)}</TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={a.active}
                      disabled={!canEdit || toggle.isPending}
                      onCheckedChange={(v) => toggle.mutate({ key: a.key, active: v })}
                      aria-label={`Ligar/desligar ${a.name}`}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                        Editar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Execuções recentes</h2>
          <p className="text-xs text-muted-foreground">
            Cada execução mostra a mensagem que seria (ou foi) enviada.
          </p>
        </div>
        <FilterSelect
          value={filter}
          onChange={setFilter}
          all="Todas as automações"
          options={(list.data ?? []).map((a) => ({ value: a.key, label: a.name }))}
        />
      </div>
      <ApiErrorBox error={runs.error} />
      {runs.isLoading ? (
        <Loading rows={4} />
      ) : !runs.data?.length ? (
        <Empty>
          Nenhuma execução ainda. Elas aparecem quando novos eventos disparam automações.
        </Empty>
      ) : (
        <div className="space-y-2">
          {runs.data.map((r) => (
            <div key={r.run_id} className="surface p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{r.automation_name}</span> →{" "}
                  <Link
                    to="/customers/$customerId"
                    params={{ customerId: r.customer_id }}
                    className="text-primary hover:underline"
                  >
                    {r.customer_name ?? "cliente"}
                  </Link>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {dateTime(r.executed_at ?? r.scheduled_for)}
                  <Pill tone={RUN_TONE[r.status] ?? "muted"}>
                    {label(RUN_STATUS_LABEL, r.status)}
                  </Pill>
                </span>
              </div>
              {r.skip_reason && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Motivo: {label(SKIP_LABEL, r.skip_reason)}
                </p>
              )}
              {r.error && <p className="mt-1 text-xs text-danger">{r.error}</p>}
              {r.message && (
                <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs">
                  <span className="mr-1 font-medium uppercase text-muted-foreground">
                    {r.channel}
                  </span>{" "}
                  {r.message}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <AutomationDialog
          automation={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
