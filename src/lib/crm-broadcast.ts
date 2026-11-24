/** Disparos (scheduled flows for a segment): settings and how they read in Portuguese. */

export type BroadcastSchedule =
  | { mode: "once"; at: string } // "YYYY-MM-DDTHH:MM", Brasília
  | { mode: "daily"; time: string; days?: number[] }; // 0 = domingo

export interface BroadcastConfig {
  segment: string;
  schedule: BroadcastSchedule;
  audience: "once_ever" | "once_per_journey";
}

export const BROADCAST_FACT = "BROADCAST";

export const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export const AUDIENCE_LABEL: Record<BroadcastConfig["audience"], string> = {
  once_ever: "Uma vez na vida do cliente",
  once_per_journey: "Uma vez durante a jornada",
};

export const AUDIENCE_HINT: Record<BroadcastConfig["audience"], string> = {
  once_ever:
    "Cada cliente recebe este disparo uma única vez. Quem entrar no segmento depois recebe no próximo horário.",
  once_per_journey:
    "Cada cliente recebe uma vez por jornada: só recebe de novo depois de começar uma jornada (fluxo) nova.",
};

/** Tomorrow at 10:00 (Brasília), the default of a new disparo. */
export function defaultBroadcast(): BroadcastConfig {
  const d = new Date(Date.now() + 86_400_000);
  const day = d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  return { segment: "", schedule: { mode: "once", at: `${day}T10:00` }, audience: "once_ever" };
}

export function describeSchedule(s: BroadcastSchedule | null | undefined): string {
  if (!s) return "Sem agenda";
  if (s.mode === "once") {
    const [day, time] = s.at.split("T");
    const [y, m, d] = (day ?? "").split("-");
    return `Uma vez: ${d}/${m}/${y} às ${time ?? "--:--"}`;
  }
  const days = (s.days ?? []).slice().sort();
  const when =
    days.length === 0 || days.length === 7
      ? "Todo dia"
      : days.length === 5 && days.join() === "1,2,3,4,5"
        ? "Seg a sex"
        : days.map((x) => WEEKDAYS[x]).join(", ");
  return `${when} às ${s.time}`;
}

export interface BroadcastRun {
  run_id: string;
  ran_at: string;
  scheduled_for: string | null;
  status: "DONE" | "MISSED" | "EMPTY";
  manual: boolean;
  audience: number | null;
  enrolled: number | null;
  already_received: number | null;
  still_in_flow: number | null;
}

export const RUN_STATUS: Record<
  BroadcastRun["status"],
  { label: string; tone: "success" | "warning" | "muted" }
> = {
  DONE: { label: "Disparado", tone: "success" },
  EMPTY: { label: "Segmento vazio", tone: "muted" },
  MISSED: { label: "Perdido", tone: "warning" },
};
