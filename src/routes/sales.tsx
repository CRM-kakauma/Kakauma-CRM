import { createFileRoute } from "@tanstack/react-router";
import { legacyGuard } from "@/lib/legacy";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/states";
import { usePeriod } from "@/components/period-context";
import { formatCurrency, formatNumber } from "@/lib/format";
import { fetchBreakdown, type BreakdownRow } from "@/services/analytics";

export const Route = createFileRoute("/sales")({
  beforeLoad: legacyGuard,
  head: () => ({
    meta: [
      { title: "Vendas por Origem e Produto — Kakauma Analytics" },
      {
        name: "description",
        content: "Vendas aprovadas separadas por UTM source, UTM campaign e oferta.",
      },
      { property: "og:title", content: "Vendas por Origem e Produto — Kakauma Analytics" },
      {
        property: "og:description",
        content: "Compare campanhas, testes A/B e ofertas que mais vendem.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SalesPage,
});

function Table({ title, hint, rows }: { title: string; hint: string; rows: BreakdownRow[] }) {
  const total = rows.reduce((s, r) => s + Number(r.revenue), 0) || 1;
  return (
    <div className="surface p-5">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mb-4 text-xs text-muted-foreground">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma venda aprovada no período.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Nome</th>
                <th className="py-2 pr-3 text-right font-medium">Vendas</th>
                <th className="py-2 pr-3 text-right font-medium">Unidades</th>
                <th className="py-2 pr-3 text-right font-medium">Faturado</th>
                <th className="py-2 pr-3 text-right font-medium">Líquido</th>
                <th className="py-2 pr-3 text-right font-medium">Afiliados</th>
                <th className="py-2 text-right font-medium">% do total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = (Number(r.revenue) / total) * 100;
                return (
                  <tr key={r.key} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pr-3">
                      <span className="block font-medium">{r.key}</span>
                      <span className="mt-1 block h-1 rounded-full bg-muted">
                        <span
                          className="block h-1 rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right num">{formatNumber(r.sales)}</td>
                    <td className="py-2.5 pr-3 text-right num">{formatNumber(r.units)}</td>
                    <td className="py-2.5 pr-3 text-right num font-semibold">
                      {formatCurrency(r.revenue)}
                    </td>
                    <td className="py-2.5 pr-3 text-right num">{formatCurrency(r.net_revenue)}</td>
                    <td className="py-2.5 pr-3 text-right num">
                      {formatCurrency(r.affiliate_cost)}
                    </td>
                    <td className="py-2.5 text-right num text-muted-foreground">
                      {pct.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SalesPage() {
  const { from, to } = usePeriod();
  const q = useQuery({
    queryKey: ["breakdown", from.toISOString(), to.toISOString()],
    queryFn: () => fetchBreakdown(from, to),
  });
  return (
    <>
      <PageHeader
        title="Vendas"
        description="Veja de onde vêm suas vendas e quais produtos mais saem."
      />
      {q.isLoading && <BlockSkeleton height={360} />}
      {q.error && <ErrorState message={(q.error as Error).message} />}
      {q.data && q.data.offers.length === 0 && (
        <EmptyState
          title="Sem vendas no período"
          description="Assim que vendas aprovadas chegarem, elas aparecem aqui."
        />
      )}
      {q.data && q.data.offers.length > 0 && (
        <div className="space-y-6">
          <Table
            title="Produtos / Ofertas"
            hint="Quais ofertas mais estão saindo"
            rows={q.data.offers}
          />
          <Table
            title="UTM Source"
            hint="Origem do tráfego que gerou a venda"
            rows={q.data.sources}
          />
          <Table
            title="UTM Campaign"
            hint="Origem · campanha — compare seus testes A/B"
            rows={q.data.campaigns}
          />
        </div>
      )}
    </>
  );
}
