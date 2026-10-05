import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { usePeriod } from "@/components/period-context";
import { FilterSelect } from "@/components/crm/filter-select";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth, Stat } from "@/components/crm/ui";
import { count, money, pct, ratio } from "@/lib/crm-format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCrm } from "@/lib/crm-api";

export const Route = createFileRoute("/insights")({
  head: () => ({ meta: [{ title: "Insights — Kakauma CRM" }] }),
  component: () => <RequireAuth>{() => <Insights />}</RequireAuth>,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- analytic rows are dynamic JSON */
type Row = Record<string, any>;

const DIM_LABEL: Record<string, string> = {
  first_purchase_month: "Mês da 1ª compra",
  first_subscription_month: "Mês da 1ª assinatura",
  source: "Origem",
  campaign: "Campanha",
  creative: "Criativo",
  funnel: "Funil",
  product: "Produto",
  offer: "Oferta",
  affiliate: "Afiliado",
  state: "UF",
  payment_method: "Método de pagamento",
  plan: "Plano",
};
const dims = (keys: string[]) => keys.map((k) => ({ value: k, label: DIM_LABEL[k] ?? k }));

function Insights() {
  const { from, to, label } = usePeriod();
  const range = { p_from: from.toISOString(), p_to: to.toISOString() };
  return (
    <>
      <PageHeader
        title="Insights"
        description={`${label} · cohorts consideram clientes/assinaturas iniciados no período. "—" = sem base.`}
      />
      <Tabs defaultValue="funnel">
        <TabsList className="flex-wrap">
          <TabsTrigger value="funnel">Funil</TabsTrigger>
          <TabsTrigger value="campaigns">Campanhas</TabsTrigger>
          <TabsTrigger value="cohorts">Cohorts</TabsTrigger>
          <TabsTrigger value="retention">Retenção</TabsTrigger>
          <TabsTrigger value="refunds">Reembolsos</TabsTrigger>
        </TabsList>
        <TabsContent value="funnel" className="mt-6">
          <Funnel range={range} />
        </TabsContent>
        <TabsContent value="campaigns" className="mt-6">
          <Campaigns range={range} />
        </TabsContent>
        <TabsContent value="cohorts" className="mt-6">
          <Cohorts range={range} />
        </TabsContent>
        <TabsContent value="retention" className="mt-6">
          <Retention range={range} />
        </TabsContent>
        <TabsContent value="refunds" className="mt-6">
          <Refunds range={range} />
        </TabsContent>
      </Tabs>
    </>
  );
}

type Range = { p_from: string; p_to: string };

// ------------------------------------------------------------------ funnel: single-hue bars (magnitude)

function Funnel({ range }: { range: Range }) {
  const { data, isLoading, error } = useCrm<Row>("crm_funnel", range);
  if (error) return <ApiErrorBox error={error} />;
  if (isLoading || !data) return <Loading />;
  const stages: [string, string][] = [
    ["checkout_started", "Checkout iniciado"],
    ["cart_abandoned", "Abandonou carrinho"],
    ["payment_initiated", "Pagamento iniciado"],
    ["payment_approved", "Pagamento aprovado"],
    ["delivered", "Entregue"],
  ];
  const max = Math.max(1, ...stages.map(([k]) => Number(data["stages"][k] ?? 0)));
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="surface space-y-3 p-5 lg:col-span-2">
        <p className="text-sm font-semibold">Clientes por etapa</p>
        {stages.map(([k, l]) => {
          const v = Number(data["stages"][k] ?? 0);
          return (
            <div
              key={k}
              className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 text-sm"
              title={`${l}: ${v}`}
            >
              <span className="text-muted-foreground">{l}</span>
              <div className="h-5 rounded bg-muted">
                <div
                  className="h-5 rounded bg-primary"
                  style={{ width: `${(v / max) * 100}%`, minWidth: v ? 4 : 0 }}
                />
              </div>
              <span className="text-right num">{count(v)}</span>
            </div>
          );
        })}
        <p className="pt-2 text-[11px] text-muted-foreground">{data["note"]}</p>
      </div>
      <div className="grid gap-3">
        <Stat
          label="Conversão de checkout"
          value={pct(data["checkout_conversion"])}
          hint="iniciou pagamento / iniciou checkout"
        />
        <Stat
          label="Abandono de carrinho"
          value={pct(data["cart_abandonment_rate"])}
          hint="abandonou e não comprou"
        />
        <Stat
          label="Conversão de pagamento"
          value={pct(data["payment_conversion"])}
          hint="aprovado / pagamento iniciado"
        />
        <Stat label="Conversão de compra" value={pct(data["purchase_conversion"])} />
      </div>
      <div className="surface p-5 lg:col-span-3">
        <p className="mb-3 text-sm font-semibold">Conversão por método de pagamento</p>
        <div className="grid gap-3 sm:grid-cols-4">
          {Object.entries(data["by_payment_method"] ?? {}).map(([m, v]: [string, any]) => (
            <Stat
              key={m}
              label={m.toUpperCase()}
              value={pct(v.conversion)}
              hint={`${count(v.paid)} pagas de ${count(v.transactions)}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ campaigns

const QUADRANT: Record<
  string,
  { label: string; tone: "success" | "warning" | "primary" | "danger" }
> = {
  HIGH_SALES_HIGH_LTV: { label: "Muita venda · LTV alto", tone: "success" },
  HIGH_SALES_LOW_LTV: { label: "Muita venda · LTV baixo", tone: "warning" },
  LOW_SALES_HIGH_LTV: { label: "Pouca venda · LTV alto", tone: "primary" },
  LOW_SALES_LOW_LTV: { label: "Pouca venda · LTV baixo", tone: "danger" },
};

function Campaigns({ range }: { range: Range }) {
  const [level, setLevel] = useState("campaign");
  const { data, isLoading, error } = useCrm<Row[]>("crm_campaign_quality", {
    ...range,
    p_level: level,
  });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Qualidade de aquisição: vender muito não basta — compare o LTV dos clientes que cada
          campanha trouxe.
        </p>
        <FilterSelect
          value={level}
          onChange={setLevel}
          all=""
          options={dims(["source", "campaign", "creative", "funnel"])}
          hideAll
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Sem dados no período.</Empty>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{DIM_LABEL[level]}</TableHead>
                <TableHead className="text-right">Checkouts</TableHead>
                <TableHead className="text-right">Compras</TableHead>
                <TableHead className="text-right">Receita</TableHead>
                <TableHead className="text-right">Reembolsos</TableHead>
                <TableHead className="text-right">Clientes</TableHead>
                <TableHead className="text-right">LTV líq. médio</TableHead>
                <TableHead className="text-right">Assin. / renov. / churn</TableHead>
                <TableHead className="text-right">Gasto</TableHead>
                <TableHead className="text-right">CAC</TableHead>
                <TableHead className="text-right">LTV/CAC</TableHead>
                <TableHead>Leitura</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r["key"]}>
                  <TableCell className="font-medium">{r["key"]}</TableCell>
                  <TableCell className="text-right num">{count(r["checkouts"])}</TableCell>
                  <TableCell className="text-right num">{count(r["purchases"])}</TableCell>
                  <TableCell className="text-right num">{money(r["revenue"])}</TableCell>
                  <TableCell className="text-right num">{money(r["refunds"])}</TableCell>
                  <TableCell className="text-right num">{count(r["customers_acquired"])}</TableCell>
                  <TableCell className="text-right num">{money(r["avg_net_ltv"])}</TableCell>
                  <TableCell className="text-right num text-muted-foreground">
                    {r["subscriptions"]} / {r["renewals"]} / {r["churned_subscriptions"]}
                  </TableCell>
                  <TableCell className="text-right num">{money(r["spend"])}</TableCell>
                  <TableCell className="text-right num">{money(r["cac"])}</TableCell>
                  <TableCell className="text-right num">{ratio(r["ltv_cac"])}</TableCell>
                  <TableCell>
                    {r["quadrant"] ? (
                      <Pill tone={QUADRANT[r["quadrant"]]?.tone ?? "muted"}>
                        {QUADRANT[r["quadrant"]]?.label}
                      </Pill>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        CAC e LTV/CAC só aparecem para linhas com gasto importado (Operação → Investimento em
        mídia).
      </p>
    </>
  );
}

// ------------------------------------------------------------------ cohorts

function Cohorts({ range }: { range: Range }) {
  const [dim, setDim] = useState("first_purchase_month");
  const { data, isLoading, error } = useCrm<Row[]>("crm_cohorts", { ...range, p_dimension: dim });
  return (
    <>
      <div className="mb-3 flex justify-end">
        <FilterSelect
          value={dim}
          onChange={setDim}
          all=""
          hideAll
          options={dims([
            "first_purchase_month",
            "first_subscription_month",
            "source",
            "campaign",
            "creative",
            "product",
            "offer",
            "funnel",
            "affiliate",
            "state",
            "payment_method",
          ])}
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Nenhum cliente com primeira compra no período.</Empty>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{DIM_LABEL[dim]}</TableHead>
                <TableHead className="text-right">Clientes</TableHead>
                <TableHead className="text-right">LTV bruto</TableHead>
                <TableHead className="text-right">LTV líquido</TableHead>
                <TableHead className="text-right">LTV contrib.</TableHead>
                <TableHead className="text-right">Recompra</TableHead>
                <TableHead className="text-right">Reembolso</TableHead>
                <TableHead className="text-right">Churn</TableHead>
                <TableHead className="text-right">Assinaturas</TableHead>
                <TableHead className="text-right">Renovação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r["cohort"]}>
                  <TableCell className="font-medium">{r["cohort"]}</TableCell>
                  <TableCell className="text-right num">{count(r["customers"])}</TableCell>
                  <TableCell className="text-right num">{money(r["avg_gross_ltv"])}</TableCell>
                  <TableCell className="text-right num">{money(r["avg_net_ltv"])}</TableCell>
                  <TableCell className="text-right num">
                    {money(r["avg_contribution_ltv"])}
                  </TableCell>
                  <TableCell className="text-right num">{pct(r["repeat_rate"])}</TableCell>
                  <TableCell className="text-right num">{pct(r["refund_rate"])}</TableCell>
                  <TableCell className="text-right num">{pct(r["churn_rate"])}</TableCell>
                  <TableCell className="text-right num">{count(r["subscriptions"])}</TableCell>
                  <TableCell className="text-right num">{pct(r["renewal_rate"])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ retention: sequential single-hue heatmap

function Retention({ range }: { range: Range }) {
  const [dim, setDim] = useState("first_subscription_month");
  const { data, isLoading, error } = useCrm<Row[]>("crm_retention", { ...range, p_dimension: dim });
  const cell = (rate: number | null, eligible: number) => {
    if (rate === null || rate === undefined) {
      return (
        <td
          className="px-2 py-2 text-center text-xs text-muted-foreground"
          title="Ainda sem assinaturas com tempo para chegar a este ciclo"
        >
          —
        </td>
      );
    }
    const r = Number(rate);
    return (
      <td className="px-1 py-1">
        <div
          className="rounded-md px-2 py-1.5 text-center text-xs font-medium num"
          style={{
            background: `color-mix(in srgb, var(--primary) ${Math.round(10 + r * 0.75)}%, var(--card))`,
            color: r > 55 ? "var(--primary-foreground)" : "var(--foreground)",
          }}
          title={`${pct(r)} de ${eligible} assinaturas elegíveis`}
        >
          {pct(r)}
        </div>
      </td>
    );
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          % das assinaturas que pagaram cada ciclo, contando só as que já tiveram tempo de chegar
          nele.
        </p>
        <FilterSelect
          value={dim}
          onChange={setDim}
          all=""
          hideAll
          options={dims([
            "first_subscription_month",
            "product",
            "offer",
            "plan",
            "source",
            "campaign",
            "creative",
            "funnel",
            "affiliate",
            "state",
            "payment_method",
          ])}
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Nenhuma assinatura iniciada no período.</Empty>
      ) : (
        <div className="surface overflow-x-auto p-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-2 py-2 font-medium">{DIM_LABEL[dim]}</th>
                <th className="px-2 py-2 text-right font-medium">Assinaturas</th>
                {["C1", "C2", "C3", "C4", "C5"].map((c) => (
                  <th key={c} className="px-2 py-2 text-center font-medium">
                    {c}
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-medium">C1→C2</th>
                <th className="px-2 py-2 text-center font-medium">C2→C3</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r["cohort"]} className="border-t border-border">
                  <td className="px-2 py-2 font-medium">{r["cohort"]}</td>
                  <td className="px-2 py-2 text-right num">{count(r["subscriptions"])}</td>
                  {["c1", "c2", "c3", "c4", "c5"].map((c) => (
                    <Cell key={c} v={r["cycles"]?.[c]} render={cell} />
                  ))}
                  <Cell
                    v={
                      r["steps"]?.["c1_c2"] && {
                        rate: r["steps"]["c1_c2"].rate,
                        eligible: r["steps"]["c1_c2"].base,
                      }
                    }
                    render={cell}
                  />
                  <Cell
                    v={
                      r["steps"]?.["c2_c3"] && {
                        rate: r["steps"]["c2_c3"].rate,
                        eligible: r["steps"]["c2_c3"].base,
                      }
                    }
                    render={cell}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Cell({
  v,
  render,
}: {
  v: { rate: number | null; eligible: number } | undefined;
  render: (r: number | null, e: number) => React.ReactNode;
}) {
  return <>{render(v?.rate ?? null, v?.eligible ?? 0)}</>;
}

// ------------------------------------------------------------------ refunds

function Refunds({ range }: { range: Range }) {
  const [dim, setDim] = useState("product");
  const { data, isLoading, error } = useCrm<Row[]>("crm_refund_metrics", {
    ...range,
    p_dimension: dim,
  });
  return (
    <>
      <div className="mb-3 flex justify-end">
        <FilterSelect
          value={dim}
          onChange={setDim}
          all=""
          hideAll
          options={dims(["product", "offer", "campaign", "source", "affiliate", "payment_method"])}
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Nenhum pedido pago no período.</Empty>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{DIM_LABEL[dim]}</TableHead>
                <TableHead className="text-right">Pedidos</TableHead>
                <TableHead className="text-right">Receita bruta</TableHead>
                <TableHead className="text-right">Reembolsados</TableHead>
                <TableHead className="text-right">Taxa de reembolso</TableHead>
                <TableHead className="text-right">Valor reembolsado</TableHead>
                <TableHead className="text-right">Receita líquida</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r["key"]}>
                  <TableCell className="font-medium">{r["key"]}</TableCell>
                  <TableCell className="text-right num">{count(r["orders"])}</TableCell>
                  <TableCell className="text-right num">{money(r["gross_revenue"])}</TableCell>
                  <TableCell className="text-right num">{count(r["refunded_orders"])}</TableCell>
                  <TableCell className="text-right num">{pct(r["refund_rate"])}</TableCell>
                  <TableCell className="text-right num">{money(r["refund_revenue"])}</TableCell>
                  <TableCell className="text-right num">{money(r["net_revenue"])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
