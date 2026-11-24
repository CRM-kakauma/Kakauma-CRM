import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Zap } from "lucide-react";
import { ApiErrorBox, Empty, Loading, Pill } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { crmCall, useCrm } from "@/lib/crm-api";
import { count, dateTime } from "@/lib/crm-format";
import { RUN_STATUS, type BroadcastRun } from "@/lib/crm-broadcast";

interface RunResult {
  audience: number;
  enrolled: number;
  already_received: number;
  still_in_flow: number;
}

/** "Disparar agora": one run outside the schedule (the schedule stays). */
export function RunBroadcastNow({
  flowKey,
  blocked,
  onDone,
}: {
  flowKey: string;
  blocked?: string | undefined;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (blocked) return void toast.error(blocked);
    if (
      !confirm(
        "Disparar agora para o segmento? Quem já recebeu (pela regra escolhida) fica de fora. A agenda continua igual.",
      )
    )
      return;
    setBusy(true);
    try {
      const r = await crmCall<RunResult>("crm_run_broadcast_now", { p_key: flowKey });
      const skipped = [
        r.already_received ? `${count(r.already_received)} já tinham recebido` : "",
        r.still_in_flow ? `${count(r.still_in_flow)} ainda no disparo anterior` : "",
      ].filter(Boolean);
      toast.success(`${count(r.enrolled)} cliente(s) entraram no disparo`, {
        description: `${count(r.audience)} no segmento${skipped.length ? `; ${skipped.join(", ")}` : ""}. As mensagens saem no próximo processamento (até 5 min).`,
      });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      onDone?.();
    } catch (e) {
      toast.error("Não disparou", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" onClick={() => void run()} disabled={busy} title={blocked}>
      <Zap className="size-4" /> {busy ? "Disparando…" : "Disparar agora"}
    </Button>
  );
}

export function BroadcastRuns({
  flowKey,
  nextRunAt,
}: {
  flowKey: string;
  nextRunAt: string | null;
}) {
  const { data, isLoading, error } = useCrm<BroadcastRun[]>(
    "crm_broadcast_runs",
    { p_key: flowKey },
    { refetchInterval: 30_000 },
  );
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm">
        <CalendarClock className="size-4 text-primary" />
        {nextRunAt ? (
          <>
            Próximo disparo: <strong>{dateTime(nextRunAt)}</strong>
          </>
        ) : (
          <span className="text-muted-foreground">
            Nenhum disparo agendado (rascunho, pausado ou a data já passou).
          </span>
        )}
      </p>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Ainda não disparou.</Empty>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">No segmento</TableHead>
                <TableHead className="text-right">Entraram</TableHead>
                <TableHead className="text-right">Já tinham recebido</TableHead>
                <TableHead className="text-right">Ainda no anterior</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.run_id}>
                  <TableCell className="whitespace-nowrap">
                    {dateTime(r.status === "MISSED" ? r.scheduled_for : r.ran_at)}
                    {r.manual && (
                      <span className="ml-1.5 text-xs text-muted-foreground">manual</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Pill tone={RUN_STATUS[r.status]?.tone ?? "muted"}>
                      {RUN_STATUS[r.status]?.label ?? r.status}
                    </Pill>
                    {r.status === "MISSED" && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        passou mais de 3h do horário (pausado ou fora do ar)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{count(r.audience)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {count(r.enrolled)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(r.already_received)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(r.still_in_flow)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
