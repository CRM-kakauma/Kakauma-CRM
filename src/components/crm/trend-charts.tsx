import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table2 } from "lucide-react";
import { ApiErrorBox, Loading } from "@/components/crm/ui";
import { useCrm } from "@/lib/crm-api";
import { count, money } from "@/lib/crm-format";
import { cn } from "@/lib/utils";

/**
 * Dashboard trends: money, orders/customers and subscriptions per day, week or
 * month. Fixed series colors (chart-1…4, validated for color-vision deficiency);
 * every chart has a legend and the table view carries the exact numbers.
 */

type Bucket = "day" | "week" | "month";
interface Point {
  bucket: string;
  gross_revenue: number;
  net_revenue: number;
  refunds: number;
  orders: number;
  new_customers: number;
  new_subscriptions: number;
  renewals: number;
  cancellations: number;
  late_payments: number;
  spend: number | null;
}

const C1 = "var(--chart-1)";
const C2 = "var(--chart-2)";
const C3 = "var(--chart-3)";
const C4 = "var(--chart-4)";

const DAY = 86_400_000;
const autoBucket = (days: number): Bucket => (days <= 62 ? "day" : days <= 200 ? "week" : "month");

function tick(b: string, bucket: Bucket) {
  const d = new Date(`${b}T12:00:00`);
  if (bucket === "month")
    return d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }).replace(". de ", "/");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function longLabel(b: string, bucket: Bucket) {
  const d = new Date(`${b}T12:00:00`);
  if (bucket === "month") return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  if (bucket === "week")
    return `Semana de ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}`;
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
}

/** Axis labels: "R$ 6 mil" instead of "R$ 6.000,00". */
const brlShort = (v: number) =>
  Math.abs(v) >= 1000
    ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`
    : `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;

const sum = (rows: Point[], k: keyof Point) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

export function TrendCharts({ from, to }: { from: Date; to: Date }) {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY));
  const [chosen, setChosen] = useState<Bucket | null>(null);
  const bucket = chosen && !(chosen === "day" && days > 400) ? chosen : autoBucket(days);
  const [table, setTable] = useState(false);
  const { data, isLoading, error } = useCrm<Point[]>("crm_timeseries", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_bucket: bucket,
  });

  const rows = (data ?? []).map((r) => ({ ...r, label: tick(r.bucket, bucket) }));
  const axis = {
    tickLine: false,
    axisLine: false,
    tick: { fontSize: 11, fill: "var(--color-muted-foreground)" },
  } as const;
  const tooltip = (fmt: (v: number) => string) => ({
    contentStyle: {
      borderRadius: 12,
      border: "1px solid var(--color-border)",
      boxShadow: "var(--shadow-float)",
      fontSize: 12,
    },
    labelFormatter: (_: unknown, p: readonly { payload?: Point }[]) =>
      p?.[0]?.payload ? longLabel(p[0].payload.bucket, bucket) : "",
    formatter: (v: number, name: string) => [fmt(Number(v)), name],
    cursor: { stroke: "var(--color-border)", strokeWidth: 1 },
  });
  const barTooltip = (fmt: (v: number) => string) => ({
    ...tooltip(fmt),
    cursor: { fill: "var(--color-muted)", opacity: 0.6 },
  });
  const legend = { wrapperStyle: { fontSize: 12, paddingTop: 4 }, iconType: "plainline" as const };
  const lineProps = {
    type: "linear" as const,
    strokeWidth: 2,
    dot: rows.length <= 16 ? { r: 3 } : false,
    activeDot: { r: 5, strokeWidth: 2, stroke: "var(--card)" },
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Ao longo do tempo</h2>
          <p className="text-xs text-muted-foreground">
            Cada ponto é um{" "}
            {bucket === "day" ? "dia" : bucket === "week" ? "semana (começa na segunda)" : "mês"} do
            período escolhido. O último ponto pode estar incompleto (período ainda em andamento).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex rounded-lg border border-border bg-card p-0.5"
            role="group"
            aria-label="Agrupar por"
          >
            {(
              [
                ["day", "Dia"],
                ["week", "Semana"],
                ["month", "Mês"],
              ] as const
            ).map(([b, l]) => (
              <button
                key={b}
                type="button"
                disabled={b === "day" && days > 400}
                onClick={() => setChosen(b)}
                aria-pressed={bucket === b}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs disabled:opacity-40",
                  bucket === b
                    ? "bg-primary-soft font-medium text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setTable((t) => !t)}
            aria-pressed={table}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs",
              table
                ? "bg-primary-soft font-medium text-primary"
                : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            <Table2 className="size-3.5" /> Tabela
          </button>
        </div>
      </div>
      <ApiErrorBox error={error} />
      {isLoading || !data ? (
        <Loading rows={3} />
      ) : table ? (
        <TrendTable rows={data} bucket={bucket} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="Receita"
            headline={money(sum(data, "net_revenue"))}
            sub={`líquida no período · bruta ${money(sum(data, "gross_revenue"))}`}
          >
            <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={20} />
              <YAxis {...axis} width={72} tickFormatter={brlShort} />
              <Tooltip {...tooltip((v) => money(v))} />
              <Legend {...legend} />
              <Line {...lineProps} dataKey="gross_revenue" name="Bruta" stroke={C1} />
              <Line
                {...lineProps}
                dataKey="net_revenue"
                name="Líquida (− reembolsos)"
                stroke={C2}
              />
            </LineChart>
          </ChartCard>

          <ChartCard
            title="Pedidos e novos clientes"
            headline={count(sum(data, "orders"))}
            sub={`pedidos pagos · ${count(sum(data, "new_customers"))} novos clientes`}
          >
            <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={20} />
              <YAxis {...axis} width={40} allowDecimals={false} />
              <Tooltip {...tooltip((v) => count(v))} />
              <Legend {...legend} />
              <Line {...lineProps} dataKey="orders" name="Pedidos pagos" stroke={C1} />
              <Line {...lineProps} dataKey="new_customers" name="Novos clientes" stroke={C3} />
            </LineChart>
          </ChartCard>

          <ChartCard
            title="Assinaturas"
            headline={`${sum(data, "new_subscriptions") - sum(data, "cancellations") >= 0 ? "+" : ""}${count(sum(data, "new_subscriptions") - sum(data, "cancellations"))}`}
            sub={`saldo (novas − canceladas) · ${count(sum(data, "renewals"))} renovações`}
          >
            <BarChart
              data={rows}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              barGap={2}
              barCategoryGap="20%"
            >
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={20} />
              <YAxis {...axis} width={40} allowDecimals={false} />
              <Tooltip {...barTooltip((v) => count(v))} />
              <Legend {...legend} iconType="square" />
              <Bar
                dataKey="new_subscriptions"
                name="Novas"
                fill={C3}
                radius={[4, 4, 0, 0]}
                maxBarSize={18}
              />
              <Bar
                dataKey="renewals"
                name="Renovações"
                fill={C1}
                radius={[4, 4, 0, 0]}
                maxBarSize={18}
              />
              <Bar
                dataKey="cancellations"
                name="Canceladas / expiradas"
                fill={C4}
                radius={[4, 4, 0, 0]}
                maxBarSize={18}
              />
            </BarChart>
          </ChartCard>

          <ChartCard
            title="Reembolsos e chargebacks"
            headline={money(sum(data, "refunds"))}
            sub={`no período · ${count(sum(data, "late_payments"))} pagamentos de assinatura atrasaram`}
          >
            <BarChart
              data={rows}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              barCategoryGap="20%"
            >
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={20} />
              <YAxis {...axis} width={72} tickFormatter={brlShort} />
              <Tooltip {...barTooltip((v) => money(v))} />
              <Bar
                dataKey="refunds"
                name="Reembolsos + chargebacks"
                fill={C2}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
              />
            </BarChart>
          </ChartCard>
        </div>
      )}
    </section>
  );
}

function ChartCard({
  title,
  headline,
  sub,
  children,
}: {
  title: string;
  headline: string;
  sub: string;
  children: React.ReactElement;
}) {
  return (
    <div className="surface p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{headline}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
      <div className="mt-3 h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TrendTable({ rows, bucket }: { rows: Point[]; bucket: Bucket }) {
  const cols: [keyof Point, string, (v: unknown) => string][] = [
    ["gross_revenue", "Receita bruta", money],
    ["refunds", "Reembolsos", money],
    ["net_revenue", "Receita líquida", money],
    ["orders", "Pedidos", count],
    ["new_customers", "Novos clientes", count],
    ["new_subscriptions", "Novas assinaturas", count],
    ["renewals", "Renovações", count],
    ["cancellations", "Canceladas", count],
    ["late_payments", "Atrasos", count],
    ["spend", "Investimento", money],
  ];
  return (
    <div className="surface max-h-[520px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">
              {bucket === "day" ? "Dia" : bucket === "week" ? "Semana" : "Mês"}
            </th>
            {cols.map(([, l]) => (
              <th key={l} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.bucket} className="border-b border-border last:border-0">
              <td className="whitespace-nowrap px-3 py-1.5">{longLabel(r.bucket, bucket)}</td>
              {cols.map(([k, l, f]) => (
                <td key={l} className="px-3 py-1.5 text-right tabular-nums">
                  {f(r[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
