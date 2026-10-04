import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Bucket } from "@/services/analytics";

export type PeriodPreset = "7d" | "30d" | "90d" | "custom";

export interface PeriodValue {
  preset: PeriodPreset;
  from: Date;
  to: Date;
  label: string;
  bucket: Bucket;
  setPreset: (preset: Exclude<PeriodPreset, "custom">) => void;
  setCustom: (from: Date, to: Date) => void;
}

const PRESET_DAYS: Record<Exclude<PeriodPreset, "custom">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const PRESET_LABELS: Record<PeriodPreset, string> = {
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  "90d": "Últimos 90 dias",
  custom: "Personalizado",
};

const PeriodContext = createContext<PeriodValue | null>(null);

function daysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [preset, setPresetState] = useState<PeriodPreset>("30d");
  const [range, setRange] = useState<{ from: Date; to: Date }>(() => ({
    from: daysAgo(30),
    to: new Date(),
  }));

  const value = useMemo<PeriodValue>(() => {
    const days = Math.max(
      1,
      Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000),
    );
    const bucket: Bucket = days <= 14 ? "day" : days <= 120 ? "day" : "week";
    return {
      preset,
      from: range.from,
      to: range.to,
      bucket,
      label:
        preset === "custom"
          ? `${range.from.toLocaleDateString("pt-BR")} — ${range.to.toLocaleDateString("pt-BR")}`
          : PRESET_LABELS[preset],
      setPreset: (p) => {
        setPresetState(p);
        setRange({ from: daysAgo(PRESET_DAYS[p]), to: new Date() });
      },
      setCustom: (from, to) => {
        setPresetState("custom");
        setRange({ from, to });
      },
    };
  }, [preset, range]);

  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod() {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error("usePeriod must be used inside PeriodProvider");
  return ctx;
}
