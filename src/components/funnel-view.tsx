import { ArrowDown } from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/format";
import type { FunnelResult } from "@/services/analytics";
import { cn } from "@/lib/utils";

const BAR_TONE = ["bg-primary/85", "bg-primary", "bg-accent"];

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center">
      <p className="text-sm font-medium">Ainda sem dados suficientes</p>
      <p className="mt-1 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

export function FunnelView({ funnel, dense = false }: { funnel: FunnelResult; dense?: boolean }) {
  const top = funnel.stages[0]?.users ?? 0;
  if (top === 0) {
    return (
      <EmptyNote>
        O funil aparece quando a B4you enviar carrinhos abandonados, Pix ou boletos neste período.
      </EmptyNote>
    );
  }
  return (
    <div className="space-y-3">
      {funnel.stages.map((stage, i) => {
        const pct = i === 0 ? 100 : stage.conversion;
        return (
          <div key={stage.key}>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-40">
                  <p className="text-sm font-medium">
                    <span className="mr-2 text-muted-foreground num">{i + 1}.</span>
                    {stage.label}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground num">
                      {formatNumber(stage.users)}
                    </span>{" "}
                    {stage.users === 1 ? "cliente" : "clientes"}
                  </p>
                </div>
                {i > 0 && (
                  <div className={cn("flex items-center gap-6 text-right", dense && "gap-4")}>
                    <div>
                      <p className="label-eyebrow">Avançaram</p>
                      <p className="mt-0.5 text-sm font-semibold num">
                        {formatPercent(stage.conversion)}
                      </p>
                    </div>
                    <div>
                      <p className="label-eyebrow">Desistiram</p>
                      <p className="mt-0.5 text-sm font-semibold num text-muted-foreground">
                        {formatNumber(stage.drop_off_users)}
                        {!dense && ` (${formatPercent(stage.drop_off)})`}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
                {pct > 0 && (
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      BAR_TONE[i] ?? "bg-primary",
                    )}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                )}
              </div>
            </div>
            {i < funnel.stages.length - 1 && (
              <div className="flex justify-center py-1">
                <ArrowDown className="size-4 text-border-strong" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MethodSplit({ funnel }: { funnel: FunnelResult }) {
  const items = [
    { key: "PIX", data: funnel.methods.pix, tone: "text-primary", soft: "bg-primary-soft" },
    { key: "BOLETO", data: funnel.methods.boleto, tone: "text-accent", soft: "bg-accent-soft" },
  ];

  if (items.every((i) => i.data.generated === 0)) {
    return <EmptyNote>Nenhum Pix ou boleto gerado neste período.</EmptyNote>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => {
        const has = item.data.generated > 0;
        return (
          <div key={item.key} className="surface p-5">
            <div className="flex items-center justify-between">
              <p className="label-eyebrow">{item.key}</p>
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs font-semibold num",
                  item.soft,
                  item.tone,
                )}
              >
                {has ? `${formatPercent(item.data.conversion)} aprovados` : "sem dados"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Gerados</p>
                <p className="mt-1 text-lg font-semibold num">
                  {formatNumber(item.data.generated)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pagos</p>
                <p className="mt-1 text-lg font-semibold num">{formatNumber(item.data.approved)}</p>
              </div>
            </div>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
              {has && item.data.conversion > 0 && (
                <div
                  className={cn(
                    "h-full rounded-full",
                    item.key === "PIX" ? "bg-primary" : "bg-accent",
                  )}
                  style={{ width: `${Math.min(100, item.data.conversion)}%` }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
