import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatDelta } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  delta,
  lowerIsBetter = false,
  hint,
}: {
  label: string;
  value: string;
  delta: number;
  lowerIsBetter?: boolean;
  hint?: string;
}) {
  const flat = Math.abs(delta) < 0.05;
  const good = lowerIsBetter ? delta < 0 : delta > 0;
  const Icon = flat ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="surface p-5 transition-shadow hover:shadow-float">
      <p className="label-eyebrow">{label}</p>
      <p className="metric-value mt-3">{value}</p>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium num",
            flat
              ? "bg-muted text-muted-foreground"
              : good
                ? "bg-success-soft text-success"
                : "bg-danger-soft text-danger",
          )}
        >
          <Icon className="size-3" />
          {formatDelta(delta)}
        </span>
        <span className="text-xs text-muted-foreground">{hint ?? "vs. período anterior"}</span>
      </div>
    </div>
  );
}
