import { formatCurrency, formatNumber } from "@/lib/format";

// ------------------------------------------------------------------ values (null = "no data", never 0)

export const money = (v: unknown, compact = false) =>
  v === null || v === undefined || v === "" ? "—" : formatCurrency(Number(v), compact);
export const count = (v: unknown) =>
  v === null || v === undefined ? "—" : formatNumber(Number(v));
export const pct = (v: unknown) =>
  v === null || v === undefined
    ? "—"
    : `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
export const ratio = (v: unknown) =>
  v === null || v === undefined
    ? "—"
    : `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}×`;
export const date = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
export const dateTime = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
