import { useState } from "react";
import { legacyGuard } from "@/lib/legacy";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { FunnelView } from "@/components/funnel-view";
import { BlockSkeleton, CardsSkeleton, ErrorState } from "@/components/states";
import { usePeriod } from "@/components/period-context";
import { PeriodSelector } from "@/components/period-selector";
import {
  formatBucket,
  formatCurrency,
  formatNumber,
  formatPercent,
  percentChange,
} from "@/lib/format";
import { fetchFunnel, fetchOverview, fetchTimeseries, type Bucket } from "@/services/analytics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  beforeLoad: legacyGuard,
  head: () => ({
    meta: [
      { title: "Visão Geral — Kakauma Analytics" },
      {
        name: "description",
        content:
          "KPIs de receita, aprovações, conversão, reembolsos e chargebacks calculados a partir dos eventos da Kakauma.",
      },
      { property: "og:title", content: "Visão Geral — Kakauma Analytics" },
      {
        property: "og:description",
        content: "Acompanhe o desempenho do funil de compra da Kakauma em tempo real.",
      },
    ],
  }),
  component: OverviewPage,
});

const METRICS = [
  { key: "revenue", label: "Receita" },
  { key: "net_revenue", label: "Receita Líquida" },
  { key: "approved_purchases", label: "Compras Aprovadas" },
  { key: "users", label: "Usuários" },
  { key: "transactions_count", label: "Transações" },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];

const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "day", label: "Dia" },
  { key: "week", label: "Semana" },
  { key: "month", label: "Mês" },
];

function OverviewPage() {
  const { from, to } = usePeriod();
  const [metric, setMetric] = useState<MetricKey>("revenue");
  const [bucket, setBucket] = useState<Bucket>("day");

  const overview = useQuery({
    queryKey: ["overview", from.toISOString(), to.toISOString()],
    queryFn: () => fetchOverview(from, to),
  });

  const series = useQuery({
    queryKey: ["timeseries", from.toISOString(), to.toISOString(), bucket],
    queryFn: () => fetchTimeseries(from, to, bucket),
  });

  const funnel = useQuery({
    queryKey: ["funnel", from.toISOString(), to.toISOString()],
    queryFn: () => fetchFunnel(from, to),
  });

  const c = overview.data?.current;
  const p = overview.data?.previous;

  return (
    <>
      <PageHeader title="Visão Geral" description="Veja como está o desempenho do seu funil.">
        <div className="lg:hidden">
          <PeriodSelector />
        </div>
      </PageHeader>

      {overview.isLoading && <CardsSkeleton />}
      {overview.error && <ErrorState message={(overview.error as Error).message} />}
      {c && p && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            label="Receita"
            value={formatCurrency(c.revenue)}
            delta={percentChange(c.revenue, p.revenue)}
          />
          <MetricCard
            label="Receita Líquida"
            value={formatCurrency(c.net_revenue)}
            delta={percentChange(c.net_revenue, p.net_revenue)}
            hint="líquido do produtor"
          />
          <MetricCard
            label="Custo com Afiliados"
            value={formatCurrency(c.affiliate_cost)}
            delta={percentChange(c.affiliate_cost, p.affiliate_cost)}
            lowerIsBetter
            hint="comissões de afiliados"
          />
          <MetricCard
            label="Compras Aprovadas"
            value={formatNumber(c.approved_purchases)}
            delta={percentChange(c.approved_purchases, p.approved_purchases)}
          />
          <MetricCard
            label="Taxa de Conversão"
            value={formatPercent(c.conversion_rate)}
            delta={percentChange(c.conversion_rate, p.conversion_rate)}
          />
          <MetricCard
            label="Taxa de Reembolso"
            value={formatPercent(c.refund_rate)}
            delta={percentChange(c.refund_rate, p.refund_rate)}
            lowerIsBetter
          />
          <MetricCard
            label="Taxa de Chargeback"
            value={formatPercent(c.chargeback_rate, 2)}
            delta={percentChange(c.chargeback_rate, p.chargeback_rate)}
            lowerIsBetter
          />
          <MetricCard
            label="Pagamentos Recusados"
            value={formatNumber(c.failed_payments)}
            delta={percentChange(c.failed_payments, p.failed_payments)}
            lowerIsBetter
          />
        </div>
      )}

      <section className="mt-8 surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Desempenho</h2>
            <p className="text-xs text-muted-foreground">
              Série agregada no banco, sem cálculo no navegador.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-border bg-muted/50 p-0.5">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setMetric(m.key)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary",
                    metric === m.key && "bg-card text-primary shadow-card",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="flex rounded-lg border border-border bg-muted/50 p-0.5">
              {BUCKETS.map((b) => (
                <button
                  key={b.key}
                  onClick={() => setBucket(b.key)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary",
                    bucket === b.key && "bg-card text-primary shadow-card",
                  )}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 h-[320px]">
          {series.isLoading && <BlockSkeleton height={300} />}
          {series.error && <ErrorState message={(series.error as Error).message} />}
          {series.data && (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={series.data.map((d) => ({
                  ...d,
                  label: formatBucket(d.bucket, bucket),
                }))}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  minTickGap={24}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={86}
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickFormatter={(v: number) =>
                    metric === "revenue" || metric === "net_revenue"
                      ? formatCurrency(v, true)
                      : formatNumber(v)
                  }
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid var(--color-border)",
                    boxShadow: "var(--shadow-float)",
                    fontSize: 12,
                  }}
                  formatter={(v: number) => [
                    metric === "revenue" || metric === "net_revenue"
                      ? formatCurrency(v)
                      : formatNumber(v),
                    METRICS.find((m) => m.key === metric)?.label ?? "",
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey={metric}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  fill="url(#metricFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Funil de Compras</h2>
            <p className="text-xs text-muted-foreground">
              Usuários únicos por etapa — o mesmo usuário nunca é contado duas vezes.
            </p>
          </div>
          <Link
            to="/funnels"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            Ver detalhes <ArrowRight className="size-4" />
          </Link>
        </div>
        {funnel.isLoading && <BlockSkeleton height={280} />}
        {funnel.error && <ErrorState message={(funnel.error as Error).message} />}
        {funnel.data && <FunnelView funnel={funnel.data} dense />}
      </section>
    </>
  );
}
