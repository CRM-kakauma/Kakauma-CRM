import { Link } from "@tanstack/react-router";
import { Mail, MessageCircle } from "lucide-react";
import {
  ApiErrorBox,
  Empty,
  LifecyclePill,
  Loading,
  RiskPill,
  TypePill,
} from "@/components/crm/ui";
import { LIFECYCLE_LABEL, RISK_LABEL, TYPE_LABEL, useCrm } from "@/lib/crm-api";
import { count, money } from "@/lib/crm-format";
import { cn } from "@/lib/utils";

/**
 * Customers as a board. Columns are the customer's computed state (lifecycle,
 * risk, type or value tier): they change with events, not by dragging cards.
 */

export type BoardGroup = "lifecycle" | "risk" | "customer_type" | "value_tier";

export const BOARD_GROUPS: { value: BoardGroup; label: string }[] = [
  { value: "lifecycle", label: "Etapa do ciclo de vida" },
  { value: "risk", label: "Risco" },
  { value: "customer_type", label: "Tipo de cliente" },
  { value: "value_tier", label: "Faixa de valor" },
];

const VALUE_LABEL: Record<string, string> = {
  high: "Alto valor",
  medium: "Valor médio",
  low: "Baixo valor",
};

/** Column order follows the journey, not the size. */
const ORDER: Record<BoardGroup, string[]> = {
  lifecycle: [
    "LEAD",
    "PROSPECT",
    "CHECKOUT_STARTED",
    "PURCHASED",
    "DELIVERING",
    "DELIVERED",
    "ACTIVE_CUSTOMER",
    "REPEAT_CUSTOMER",
    "NEW_SUBSCRIBER",
    "ACTIVE_SUBSCRIBER",
    "RENEWED",
    "EXPIRING",
    "LATE",
    "RECOVERED",
    "CANCELLATION_REQUESTED",
    "CANCELLED",
    "CHURNED",
    "REACTIVATED",
  ],
  risk: ["HEALTHY", "AT_RISK", "PAYMENT_RISK", "CHURN_RISK", "HIGH_VALUE_AT_RISK"],
  customer_type: [
    "LEAD",
    "PROSPECT",
    "ONE_TIME_CUSTOMER",
    "SUBSCRIBER",
    "HYBRID_CUSTOMER",
    "REACTIVATED_CUSTOMER",
    "FORMER_SUBSCRIBER",
    "CHURNED_CUSTOMER",
  ],
  value_tier: ["high", "medium", "low"],
};
const LABELS: Record<BoardGroup, Record<string, string>> = {
  lifecycle: LIFECYCLE_LABEL,
  risk: RISK_LABEL,
  customer_type: TYPE_LABEL,
  value_tier: VALUE_LABEL,
};
const EMPTY_LABEL: Record<BoardGroup, string> = {
  lifecycle: "Sem etapa",
  risk: "Sem risco calculado",
  customer_type: "Sem tipo",
  value_tier: "Ainda não comprou",
};
const VALUE_SEGMENT: Record<string, string> = {
  high: "value_high",
  medium: "value_medium",
  low: "value_low",
};

interface Card {
  customer_id: string;
  full_name: string | null;
  email: string | null;
  whatsapp: string | null;
  customer_type: string;
  lifecycle: string | null;
  risk: string | null;
  net_ltv: number;
  paid_orders: number;
  cx_score: number | null;
  last_purchase_at: string | null;
}
interface Column {
  key: string | null;
  count: number;
  net_ltv: number;
  cards: Card[];
}

export function CustomerBoard({
  group,
  sort,
  filters,
  onShowAll,
}: {
  group: BoardGroup;
  sort: "value" | "recent";
  filters: {
    p_query: string | null;
    p_lifecycle: string | null;
    p_risk: string | null;
    p_type: string | null;
    p_segment: string | null;
  };
  onShowAll: (group: BoardGroup, key: string) => void;
}) {
  const { data, isLoading, error } = useCrm<Column[]>("crm_customer_board", {
    ...filters,
    p_group: group,
    p_sort: sort,
    p_per_column: 25,
  });
  if (error) return <ApiErrorBox error={error} />;
  if (isLoading) return <Loading rows={4} />;
  if (!data?.length) return <Empty>Nenhum cliente com esses filtros.</Empty>;

  const rank = (k: string | null) =>
    k === null ? 999 : ORDER[group].indexOf(k) === -1 ? 500 : ORDER[group].indexOf(k);
  const cols = [...data].sort((a, b) => rank(a.key) - rank(b.key));

  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        As colunas são calculadas a partir dos eventos (compras, pagamentos, entregas): o cliente
        muda de coluna sozinho quando algo acontece. Por isso os cartões não são arrastados.
      </p>
      <div className="overflow-x-auto pb-4">
        <div className="flex min-w-max items-start gap-3">
          {cols.map((c) => (
            <section
              key={String(c.key)}
              className="flex w-[280px] shrink-0 flex-col rounded-xl border border-border bg-muted/40"
            >
              <header className="border-b border-border px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate text-sm font-semibold">
                    {c.key === null ? EMPTY_LABEL[group] : (LABELS[group][c.key] ?? c.key)}
                  </h3>
                  <span className="rounded-md bg-card px-1.5 py-0.5 text-xs font-medium tabular-nums">
                    {count(c.count)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  LTV líquido somado {money(c.net_ltv, true)}
                </p>
              </header>
              <div className="flex max-h-[calc(100vh-330px)] flex-col gap-2 overflow-y-auto p-2">
                {c.cards.map((k) => (
                  <CardItem key={k.customer_id} k={k} group={group} />
                ))}
                {c.count > c.cards.length && c.key !== null && (
                  <button
                    type="button"
                    onClick={() => onShowAll(group, c.key!)}
                    className="rounded-lg py-2 text-xs font-medium text-primary hover:bg-card"
                  >
                    Ver todos os {count(c.count)} →
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

function CardItem({ k, group }: { k: Card; group: BoardGroup }) {
  const wa = (k.whatsapp ?? "").replace(/\D/g, "");
  return (
    <Link
      to="/customers/$customerId"
      params={{ customerId: k.customer_id }}
      className="block rounded-lg border border-border bg-card p-3 shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">
          {k.full_name ?? k.email ?? "Sem nome"}
        </p>
        <span className="shrink-0 text-sm font-semibold tabular-nums">{money(k.net_ltv)}</span>
      </div>
      <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
        {wa.length >= 10 && <MessageCircle className="size-3 shrink-0" aria-label="tem WhatsApp" />}
        {k.email && <Mail className="size-3 shrink-0" aria-label="tem e-mail" />}
        <span className="truncate">{k.email ?? k.whatsapp ?? "—"}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {group !== "lifecycle" && <LifecyclePill stage={k.lifecycle} />}
        {group !== "risk" && k.risk && k.risk !== "HEALTHY" && <RiskPill risk={k.risk} />}
        {group !== "customer_type" && group !== "lifecycle" && <TypePill type={k.customer_type} />}
      </div>
      <p className={cn("mt-2 flex justify-between text-[11px] text-muted-foreground")}>
        <span>
          {k.paid_orders} pedido{k.paid_orders === 1 ? "" : "s"} · última{" "}
          {k.last_purchase_at
            ? new Date(k.last_purchase_at).toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                year: "2-digit",
              })
            : "—"}
        </span>
        {k.cx_score != null && <span title="CX score">CX {k.cx_score}</span>}
      </p>
    </Link>
  );
}

export { VALUE_SEGMENT };
