import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { FunnelView, MethodSplit } from "@/components/funnel-view";
import { BlockSkeleton, ErrorState } from "@/components/states";
import { usePeriod } from "@/components/period-context";
import { PeriodSelector } from "@/components/period-selector";
import { fetchFunnel, fetchOverview } from "@/services/analytics";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/funnels")({
  head: () => ({
    meta: [
      { title: "Funis — Kakauma Analytics" },
      {
        name: "description",
        content:
          "Funil de compra da Kakauma com conversão, drop-off e comparação entre Pix e boleto.",
      },
      { property: "og:title", content: "Funis — Kakauma Analytics" },
      {
        property: "og:description",
        content: "Entenda onde seus clientes estão convertendo ou abandonando.",
      },
    ],
  }),
  component: FunnelsPage,
});

function FunnelsPage() {
  const { from, to } = usePeriod();

  const funnel = useQuery({
    queryKey: ["funnel", from.toISOString(), to.toISOString()],
    queryFn: () => fetchFunnel(from, to),
  });

  const overview = useQuery({
    queryKey: ["overview", from.toISOString(), to.toISOString()],
    queryFn: () => fetchOverview(from, to),
  });

  const c = overview.data?.current;

  return (
    <>
      <PageHeader
        title="Funis"
        description="Entenda onde seus clientes estão convertendo ou abandonando."
      >
        <div className="lg:hidden">
          <PeriodSelector />
        </div>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Usuários Únicos", value: c ? formatNumber(c.unique_users) : "—" },
          { label: "Transações", value: c ? formatNumber(c.transactions_count) : "—" },
          { label: "Tentativas de Pagamento", value: c ? formatNumber(c.payment_attempts) : "—" },
          { label: "Eventos", value: c ? formatNumber(c.events_count) : "—" },
        ].map((item) => (
          <div key={item.label} className="surface p-5">
            <p className="label-eyebrow">{item.label}</p>
            <p className="mt-3 text-xl font-semibold num">{item.value}</p>
          </div>
        ))}
      </div>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Funil de Compras</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Checkout Iniciado → Pagamento Iniciado (Pix, Boleto e Cartão) → Compra Aprovada
        </p>
        {funnel.isLoading && <BlockSkeleton height={320} />}
        {funnel.error && <ErrorState message={(funnel.error as Error).message} />}
        {funnel.data && <FunnelView funnel={funnel.data} />}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Pagamento Iniciado · Pix vs Boleto</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Transações geradas e aprovadas por método de pagamento.
        </p>
        {funnel.isLoading && <BlockSkeleton height={200} />}
        {funnel.data && <MethodSplit funnel={funnel.data} />}
      </section>
    </>
  );
}
