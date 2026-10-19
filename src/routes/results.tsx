import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Table2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { usePeriod } from "@/components/period-context";
import { ApiErrorBox, Empty, Loading, RequireAuth, Stat } from "@/components/crm/ui";
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
import { count, money, pct } from "@/lib/crm-format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/results")({
  head: () => ({ meta: [{ title: "Resultados — Kakauma CRM" }] }),
  component: () => <RequireAuth>{() => <Results />}</RequireAuth>,
});

/**
 * What the CRM's messages did: sends, clicks, orders with the CRM's UTMs
 * (utm_medium=crm on the checkout) and orders influenced by a message (the
 * last one the customer got up to N days before paying), per flow, message,
 * channel and day. Channel colors are fixed (chart-1…3); the money chart uses
 * chart-4 so it never reads as a channel. Every chart has a table view.
 */

interface Metrics {
  sent: number;
  reached: number;
  clicks: number;
  infl_orders: number;
  infl_revenue: number;
  utm_orders: number;
  utm_revenue: number;
}
interface FlowRow extends Metrics {
  campaign: string;
  name: string;
}
interface ChannelRow extends Metrics {
  channel: string;
}
interface MessageRow extends Metrics {
  campaign: string;
  content: string | null;
  channel: string;
  flow_name: string;
  message_name: string | null;
}
interface Day {
  day: string;
  sent_email: number;
  sent_sms: number;
  sent_rcs: number;
  clicks: number;
  infl_revenue: number;
  utm_revenue: number;
}
interface Data {
  window_days: number;
  totals: Metrics;
  by_flow: FlowRow[];
  by_channel: ChannelRow[];
  by_message: MessageRow[];
  daily: Day[];
}

const CHANNEL: Record<string, string> = {
  email: "E-mail",
  sms: "SMS",
  rcs: "RCS",
  whatsapp: "WhatsApp",
  "?": "Outro",
};
const channelLabel = (c: string) => CHANNEL[c] ?? c;
const WINDOWS = [3, 7, 14] as const;

/** Share as a percentage, "—" when there is no base. */
const share = (n: number, d: number) => (d > 0 ? pct((100 * n) / d) : "—");

function Results() {
  const { from, to, label } = usePeriod();
  const [win, setWin] = useState<(typeof WINDOWS)[number]>(7);
  const { data, isLoading, error } = useCrm<Data>("crm_results", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_window_days: win,
  });
  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Resultados do CRM"
        help="resultados"
        description={`${label} · o que os fluxos (e-mail, SMS e RCS) trouxeram: envios, cliques e vendas.`}
      >
        <div
          className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5"
          role="group"
          aria-label="Janela de influência"
        >
          <span className="px-2 text-xs text-muted-foreground">Compra até</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWin(w)}
              aria-pressed={win === w}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                win === w
                  ? "bg-primary-soft font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w} dias
            </button>
          ))}
          <span className="px-2 text-xs text-muted-foreground">depois da mensagem</span>
        </div>
      </PageHeader>
      <ApiErrorBox error={error} />
      {isLoading || !data || !t ? (
        <Loading rows={4} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Mensagens enviadas"
              value={count(t.sent)}
              hint={`${count(t.reached)} clientes alcançados`}
            />
            <Stat
              label="Cliques"
              value={count(t.clicks)}
              hint={`${share(t.clicks, t.sent)} das mensagens · links do CRM, RCS e vendas com UTM`}
            />
            <Stat
              label="Receita influenciada"
              value={money(t.infl_revenue)}
              hint={`${count(t.infl_orders)} pedidos até ${data.window_days} dias depois de uma mensagem`}
              tone={t.infl_revenue > 0 ? "success" : undefined}
            />
            <Stat
              label="Conversão"
              value={share(t.infl_orders, t.reached)}
              hint="pedidos influenciados ÷ clientes alcançados"
            />
            <Stat
              label="Receita com UTM do CRM"
              value={money(t.utm_revenue)}
              hint={`${count(t.utm_orders)} pedidos com utm_medium=crm no checkout`}
            />
            <Stat
              label="Ticket médio influenciado"
              value={t.infl_orders > 0 ? money(t.infl_revenue / t.infl_orders) : "—"}
              hint="receita influenciada ÷ pedidos"
            />
          </div>

          <Daily rows={data.daily} />

          <Tabs defaultValue="flows" className="mt-8">
            <TabsList className="flex-wrap">
              <TabsTrigger value="flows">Por fluxo</TabsTrigger>
              <TabsTrigger value="messages">Por mensagem</TabsTrigger>
              <TabsTrigger value="channels">Por canal</TabsTrigger>
            </TabsList>
            <TabsContent value="flows" className="mt-4">
              <MetricsTable
                rows={data.by_flow}
                first={[["Fluxo", (r) => <span className="font-medium">{r.name}</span>]]}
              />
            </TabsContent>
            <TabsContent value="messages" className="mt-4">
              <MetricsTable
                rows={data.by_message}
                first={[
                  ["Fluxo", (r) => r.flow_name],
                  [
                    "Mensagem",
                    (r) => (
                      <span className="font-medium">{r.message_name ?? r.content ?? "—"}</span>
                    ),
                  ],
                  ["Canal", (r) => channelLabel(r.channel)],
                ]}
              />
            </TabsContent>
            <TabsContent value="channels" className="mt-4">
              <MetricsTable
                rows={data.by_channel}
                first={[
                  ["Canal", (r) => <span className="font-medium">{channelLabel(r.channel)}</span>],
                ]}
              />
            </TabsContent>
          </Tabs>

          <div className="mt-6 space-y-1 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Receita influenciada</span>: pedidos
              pagos até {data.window_days} dias depois de o cliente receber uma mensagem do CRM —
              conta para a última mensagem antes da compra. Funciona mesmo quando o UTM não chega ao
              checkout.
            </p>
            <p>
              <span className="font-medium text-foreground">Receita com UTM do CRM</span>: pedidos
              cujo checkout da B4you trouxe utm_medium=crm (o cliente clicou num link e comprou). Se
              ficar zerada com vendas influenciadas, o site não está passando os UTMs para o
              checkout.
            </p>
            <p>
              <span className="font-medium text-foreground">Cliques</span>: mensagens clicadas (o
              link do site vira um link do CRM no envio, que registra o clique — no e-mail só com o
              domínio próprio CRM_LINK_BASE), cliques em RCS avisados pela Pushfy e links curtos
              criados no botão “Encurtar”. Uma venda com utm_medium=crm também conta como clique (o
              cliente clicou no link) — assim mensagens antigas, sem o link do CRM, entram também —
              sem contar de novo quando o CRM já registrou o clique daquele cliente no fluxo.
            </p>
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ per day

const axis = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11, fill: "var(--color-muted-foreground)" },
} as const;
const brlShort = (v: number) =>
  Math.abs(v) >= 1000
    ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`
    : `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;
const dayTick = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const dayLong = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
const tooltip = (fmt: (v: number) => string) => ({
  contentStyle: {
    borderRadius: 12,
    border: "1px solid var(--color-border)",
    boxShadow: "var(--shadow-float)",
    fontSize: 12,
  },
  labelFormatter: (_: unknown, p: readonly { payload?: Day }[]) =>
    p?.[0]?.payload ? dayLong(p[0].payload.day) : "",
  formatter: (v: number, name: string) => [fmt(Number(v)), name],
  cursor: { fill: "var(--color-muted)", opacity: 0.6 },
});

function Daily({ rows }: { rows: Day[] }) {
  const [table, setTable] = useState(false);
  const data = rows.map((r) => ({ ...r, label: dayTick(r.day) }));
  const sum = (k: keyof Day) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Dia a dia</h2>
          <p className="text-xs text-muted-foreground">
            Envios no dia em que saíram; vendas no dia em que foram pagas.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setTable((x) => !x)}
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
      {!rows.length ? (
        <Empty>Nenhum envio ou venda ligada ao CRM no período.</Empty>
      ) : table ? (
        <div className="surface max-h-[420px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dia</TableHead>
                <TableHead className="text-right">E-mail</TableHead>
                <TableHead className="text-right">SMS</TableHead>
                <TableHead className="text-right">RCS</TableHead>
                <TableHead className="text-right">Cliques</TableHead>
                <TableHead className="text-right">Receita influenciada</TableHead>
                <TableHead className="text-right">Receita com UTM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.day}>
                  <TableCell>{dayLong(r.day)}</TableCell>
                  <TableCell className="text-right num">{count(r.sent_email)}</TableCell>
                  <TableCell className="text-right num">{count(r.sent_sms)}</TableCell>
                  <TableCell className="text-right num">{count(r.sent_rcs)}</TableCell>
                  <TableCell className="text-right num">{count(r.clicks)}</TableCell>
                  <TableCell className="text-right num">{money(r.infl_revenue)}</TableCell>
                  <TableCell className="text-right num">{money(r.utm_revenue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="Receita influenciada"
            headline={money(sum("infl_revenue"))}
            sub={`no período · com UTM do CRM ${money(sum("utm_revenue"))}`}
          >
            <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={20} />
              <YAxis {...axis} width={72} tickFormatter={brlShort} />
              <Tooltip {...tooltip((v) => money(v))} />
              <Bar
                dataKey="infl_revenue"
                name="Receita influenciada"
                fill="var(--chart-4)"
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
              />
            </BarChart>
          </ChartCard>
          <ChartCard
            title="Mensagens enviadas"
            headline={count(sum("sent_email") + sum("sent_sms") + sum("sent_rcs"))}
            sub={`${count(sum("sent_email"))} e-mails · ${count(sum("sent_sms"))} SMS · ${count(sum("sent_rcs"))} RCS`}
          >
            <BarChart
              data={data}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              barGap={2}
              barCategoryGap="20%"
            >
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={20} />
              <YAxis {...axis} width={40} allowDecimals={false} />
              <Tooltip {...tooltip((v) => count(v))} />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} iconType="square" />
              <Bar
                dataKey="sent_email"
                name="E-mail"
                fill="var(--chart-1)"
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
              />
              <Bar
                dataKey="sent_sms"
                name="SMS"
                fill="var(--chart-2)"
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
              />
              <Bar
                dataKey="sent_rcs"
                name="RCS"
                fill="var(--chart-3)"
                radius={[4, 4, 0, 0]}
                maxBarSize={14}
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

// ------------------------------------------------------------------ tables

function MetricsTable<R extends Metrics>({
  rows,
  first,
}: {
  rows: R[];
  first: [string, (r: R) => React.ReactNode][];
}) {
  if (!rows.length) return <Empty>Nada no período.</Empty>;
  return (
    <div className="surface overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {first.map(([h]) => (
              <TableHead key={h}>{h}</TableHead>
            ))}
            <TableHead className="text-right">Enviadas</TableHead>
            <TableHead className="text-right">Cliques</TableHead>
            <TableHead className="text-right">Taxa de clique</TableHead>
            <TableHead className="text-right">Pedidos influenciados</TableHead>
            <TableHead className="text-right">Conversão</TableHead>
            <TableHead className="text-right">Receita influenciada</TableHead>
            <TableHead className="text-right">Pedidos com UTM</TableHead>
            <TableHead className="text-right">Receita com UTM</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {first.map(([h, cell]) => (
                <TableCell key={h}>{cell(r)}</TableCell>
              ))}
              <TableCell className="text-right num">{count(r.sent)}</TableCell>
              <TableCell className="text-right num">{count(r.clicks)}</TableCell>
              <TableCell className="text-right num">{share(r.clicks, r.sent)}</TableCell>
              <TableCell className="text-right num">{count(r.infl_orders)}</TableCell>
              <TableCell className="text-right num">{share(r.infl_orders, r.reached)}</TableCell>
              <TableCell className="text-right num">{money(r.infl_revenue)}</TableCell>
              <TableCell className="text-right num">{count(r.utm_orders)}</TableCell>
              <TableCell className="text-right num">{money(r.utm_revenue)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
