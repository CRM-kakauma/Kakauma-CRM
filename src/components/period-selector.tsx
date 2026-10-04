import { useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESET_LABELS, usePeriod, type PeriodPreset } from "@/components/period-context";
import { cn } from "@/lib/utils";

const PRESETS: Exclude<PeriodPreset, "custom">[] = ["7d", "30d", "90d"];

function toInput(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function PeriodSelector() {
  const period = usePeriod();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(toInput(period.from));
  const [to, setTo] = useState(toInput(period.to));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="h-9 gap-2 rounded-lg border-border bg-card text-sm font-medium shadow-none hover:bg-primary-soft hover:text-primary"
        >
          <CalendarDays className="size-4 text-muted-foreground" />
          {period.label}
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="space-y-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => {
                period.setPreset(p);
                setOpen(false);
              }}
              className={cn(
                "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-primary-soft hover:text-primary",
                period.preset === p && "bg-primary-soft font-medium text-primary",
              )}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="label-eyebrow">Personalizado</p>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded-md border border-input bg-card px-2 py-1.5 text-xs"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              const f = new Date(`${from}T00:00:00`);
              const t = new Date(`${to}T23:59:59`);
              if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && f < t) {
                period.setCustom(f, t);
                setOpen(false);
              }
            }}
          >
            Aplicar período
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
