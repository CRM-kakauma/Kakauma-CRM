export function formatCurrency(value: number | null | undefined, compact = false) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: compact && Math.abs(n) >= 10000 ? "compact" : "standard",
    maximumFractionDigits: compact && Math.abs(n) >= 10000 ? 1 : 2,
  }).format(n);
}

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat("pt-BR").format(Number(value ?? 0));
}

export function formatPercent(value: number | null | undefined, digits = 1) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value ?? 0))}%`;
}

export function formatDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;
}

export function percentChange(current: number, previous: number) {
  if (!previous) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string) {
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

export function formatBucket(iso: string, bucket: "day" | "week" | "month") {
  const d = new Date(iso);
  if (bucket === "month") return d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
  if (bucket === "week") return `Sem ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
