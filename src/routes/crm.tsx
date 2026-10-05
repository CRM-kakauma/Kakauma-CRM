import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { usePeriod } from "@/components/period-context";
import { ApiErrorBox, Loading, RequireAuth, Section, Stat } from "@/components/crm/ui";
import { TrendCharts } from "@/components/crm/trend-charts";
import { count, money, pct } from "@/lib/crm-format";
import { useCrm } from "@/lib/crm-api";

export const Route = createFileRoute("/crm")({
  head: () => ({ meta: [{ title: "Painel — Kakauma CRM" }] }),
  component: () => <RequireAuth>{() => <Dashboard />}</RequireAuth>,
});

type Obj = Record<string, unknown>;
interface DashboardData {
  acquisition: Obj;
  commerce: Obj;
  subscription: Obj;
  fulfillment: Obj;
  customer: Obj;
}

function Dashboard() {
  const { from, to, label } = usePeriod();
  const { data, isLoading, error } = useCrm<DashboardData>("crm_dashboard", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });

  return (
    <>
      <PageHeader
        title="Painel"
        help="painel"
        description={`Calculado a partir dos eventos da B4you · ${label}. "—" = sem base para calcular.`}
      />
      <ApiErrorBox error={error} />
      {isLoading || !data ? (
        <Loading rows={5} />
      ) : (
        <>
          <TrendCharts from={from} to={to} />

          <Section title="Aquisição" action={<More to="/insights" label="Campanhas e cohorts" />}>
            <Grid>
              <Stat
                label="Clientes adquiridos"
                value={count(data.acquisition["customers_acquired"])}
                hint="primeira compra no período"
              />
              <Stat
                label="Investimento"
                value={money(data.acquisition["spend"])}
                hint="gasto de mídia importado"
              />
              <Stat
                label="CAC"
                value={money(data.acquisition["cac"])}
                hint={data.acquisition["cac"] == null ? "importe o gasto em Operação" : undefined}
              />
              <Stat
                label="Conversão"
                value={pct(data.acquisition["conversion"])}
                hint="checkout → compra"
              />
              <Stat
                label="Receita de campanhas"
                value={money(data.acquisition["campaign_revenue"])}
                hint="pedidos com UTM"
              />
            </Grid>
          </Section>

          <Section title="Vendas">
            <Grid>
              <Stat label="Pedidos pagos" value={count(data.commerce["orders"])} />
              <Stat label="Receita bruta" value={money(data.commerce["gross_revenue"])} />
              <Stat
                label="Receita líquida"
                value={money(data.commerce["net_revenue"])}
                hint={`reembolsos ${money(data.commerce["refunds"])}`}
              />
              <Stat label="Ticket médio" value={money(data.commerce["aov"])} />
              <Stat label="Taxa de reembolso" value={pct(data.commerce["refund_rate"])} />
              <Stat label="Taxas da plataforma" value={money(data.commerce["platform_fees"])} />
              <Stat
                label="Saldo a liberar"
                value={money(data.commerce["pending_release"])}
                hint="comissão ainda não liberada"
              />
              <Stat
                label="Lucro do período"
                value={
                  data.commerce["profit"] != null ? money(data.commerce["profit"]) : "incompleto"
                }
                hint={
                  Number(data.commerce["cogs_missing_sales"]) > 0
                    ? `${count(data.commerce["cogs_missing_sales"])} venda(s) sem custo cadastrado`
                    : data.commerce["taxes"] == null
                      ? "defina a alíquota de impostos em Operação"
                      : `CMV ${money(data.commerce["cogs"])} · impostos ${money(data.commerce["taxes"])}`
                }
              />
            </Grid>
          </Section>

          <Section title="Assinaturas" action={<More to="/recovery" label="Fila de recuperação" />}>
            <Grid>
              <Stat
                label="Assinantes ativos"
                value={count(data.subscription["active_subscribers"])}
                hint="agora"
              />
              <Stat label="Novos assinantes" value={count(data.subscription["new_subscribers"])} />
              <Stat label="Renovações" value={count(data.subscription["renewals"])} />
              <Stat
                label="Taxa de renovação"
                value={pct(data.subscription["renewal_rate"])}
                hint={`${count(data.subscription["renewals_due"])} renovações devidas`}
              />
              <Stat
                label="Churn"
                value={count(data.subscription["churned"])}
                hint={`taxa ${pct(data.subscription["churn_rate"])}`}
              />
              <Stat
                label="Pagamentos atrasados"
                value={count(data.subscription["late_payments"])}
                hint={`recuperação ${pct(data.subscription["recovery_rate"])}`}
              />
              <Stat
                label="Pedidos de cancelamento"
                value={count(data.subscription["cancellation_requests"])}
                hint={`retidos ${pct(data.subscription["save_rate"])}`}
              />
            </Grid>
          </Section>

          <Section title="Logística">
            <Grid>
              <Stat label="Envios" value={count(data.fulfillment["fulfillments"])} />
              <Stat label="Em trânsito" value={count(data.fulfillment["in_transit"])} />
              <Stat label="Entregues" value={count(data.fulfillment["delivered"])} />
              <Stat
                label="Atrasados"
                value={count(data.fulfillment["delayed"])}
                tone={Number(data.fulfillment["delayed"]) > 0 ? "danger" : undefined}
              />
              <Stat
                label="Falhas"
                value={count(data.fulfillment["failed"])}
                tone={Number(data.fulfillment["failed"]) > 0 ? "danger" : undefined}
              />
              <Stat
                label="Prazo médio"
                value={
                  data.fulfillment["avg_delivery_days"] == null
                    ? "—"
                    : `${Number(data.fulfillment["avg_delivery_days"]).toLocaleString("pt-BR")} dias`
                }
              />
            </Grid>
          </Section>

          <Section
            title="Clientes"
            description="Situação atual (não depende do período)"
            action={<More to="/customers" label="Ver clientes" />}
          >
            <Grid>
              <Stat label="Clientes com compra" value={count(data.customer["customers"])} />
              <Stat
                label="LTV líquido médio"
                value={money(data.customer["avg_net_ltv"])}
                hint={`bruto ${money(data.customer["avg_gross_ltv"])}`}
              />
              <Stat
                label="LTV de contribuição"
                value={money(data.customer["avg_contribution_ltv"])}
                hint="− taxas, frete e comissões"
              />
              <Stat
                label="Lucro médio por cliente"
                value={
                  data.customer["avg_profit_ltv"] != null
                    ? money(data.customer["avg_profit_ltv"])
                    : "—"
                }
                hint={`${count(data.customer["profit_known_customers"])} com custo completo · − CMV e impostos`}
              />
              <Stat
                label="CX score médio"
                value={
                  data.customer["avg_cx_score"] != null
                    ? `${data.customer["avg_cx_score"]}/100`
                    : "—"
                }
                hint="entrega, reembolsos e atritos"
              />
              <Stat label="Alto valor" value={count(data.customer["high_value_customers"])} />
              <Stat
                label="Em risco"
                value={count(data.customer["at_risk_customers"])}
                hint={`${count(data.customer["high_value_at_risk"])} de alto valor`}
                tone={Number(data.customer["high_value_at_risk"]) > 0 ? "danger" : undefined}
              />
              <Stat label="Reativados" value={count(data.customer["reactivated_customers"])} />
            </Grid>
          </Section>
        </>
      )}
    </>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">{children}</div>;
}

function More({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
      {label} <ArrowRight className="size-3" />
    </Link>
  );
}
