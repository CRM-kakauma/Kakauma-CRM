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
  delivered: number;
  opens: number;
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
  opens: number;
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

/** Links shortened while the message was in no flow carry the placeholder name. */
const flowLabel = (name: string) =>
  name === "nome_do_fluxo" ? "Links encurtados sem fluxo (nome_do_fluxo)" : name;

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
        description={`${label} · o que os fluxos (e-mail, SMS, RCS e WhatsApp) trouxeram: envios, cliques e vendas.`}
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
      <CrmImpact />
      <ApiErrorBox error={error} />
      {isLoading || !data || !t ? (
        <Loading rows={4} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Mensagens enviadas"
              value={count(t.sent)}
              hint={`${count(t.reached)} clientes alcançados`}
            />
            <Stat
              label="Entregues"
              value={count(t.delivered)}
              hint={`${share(t.delivered, t.sent)} das mensagens · confirmadas por Resend, Pushfy e WhatsApp`}
            />
            <Stat
              label="Aberturas (e-mail e WhatsApp)"
              value={count(t.opens)}
              hint={(() => {
                const sent = data.by_channel
                  .filter((c) => c.channel === "email" || c.channel === "whatsapp")
                  .reduce((a, c) => a + (c.sent ?? 0), 0);
                return `${share(t.opens, sent)} dos e-mails e WhatsApps enviados · Resend e leitura no WhatsApp`;
              })()}
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
                first={[["Fluxo", (r) => <span className="font-medium">{flowLabel(r.name)}</span>]]}
              />
            </TabsContent>
            <TabsContent value="messages" className="mt-4">
              <MetricsTable
                rows={data.by_message}
                first={[
                  ["Fluxo", (r) => flowLabel(r.flow_name)],
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
              <span className="font-medium text-foreground">Entregues e aberturas</span>: avisados
              pelo Resend (e-mail) e pela Pushfy (SMS/RCS, só entrega) pelos webhooks. A abertura é
              contada uma vez por e-mail; alguns leitores (como o Apple Mail) abrem sozinhos, então
              a taxa de abertura costuma ficar acima da real.
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

interface ImpactBucket {
  orders: number;
  revenue: number;
}
interface ImpactRow {
  orders: number;
  revenue: number;
  recovered: number;
  clicked: number;
  influenced: number;
}
interface Impact {
  since: string | null;
  store: { orders: number; revenue: number };
  totals: Partial<Record<"recovered" | "clicked" | "influenced", ImpactBucket>> | null;
  by_month: ({ month: string } & Omit<ImpactRow, "revenue">)[];
  by_flow: ({ name: string } & ImpactRow)[];
  by_channel: ({ channel: string } & ImpactRow)[];
}
const CH_LABEL: Record<string, string> = {
  email: "E-mail",
  sms: "SMS",
  rcs: "RCS",
  whatsapp: "WhatsApp",
  link: "Link (UTM)",
};
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/**
 * Since the first real send: how much the CRM brought, in three buckets (each order in one):
 * recovered (a lost sale that came back after a message), clicked (checkout with the CRM's UTM)
 * and influenced (bought up to 7 days after a message).
 */
function CrmImpact() {
  const { data, isLoading, error } = useCrm<Impact>("crm_impact", {});
  if (error) return null; // before the database update (0050): the period numbers below still work
  if (isLoading || !data) return <Loading rows={2} />;
  if (!data.since) return null;
  const b = (k: "recovered" | "clicked" | "influenced") =>
    data.totals?.[k] ?? { orders: 0, revenue: 0 };
  const rec = b("recovered");
  const clk = b("clicked");
  const inf = b("influenced");
  const sure = Number(rec.revenue) + Number(clk.revenue);
  const all = sure + Number(inf.revenue);
  const store = Number(data.store.revenue);
  const since = new Date(data.since).toLocaleDateString("pt-BR");
  const maxMonth = Math.max(1, ...data.by_month.map((m) => m.recovered + m.clicked + m.influenced));
  const parts = [
    {
      key: "recovered",
      label: "Recuperado",
      v: rec,
      cls: "bg-emerald-600",
      hint: "Abandonou carrinho, gerou Pix ou teve pagamento recusado, recebeu mensagem do CRM e comprou em até 7 dias",
    },
    {
      key: "clicked",
      label: "Clique confirmado",
      v: clk,
      cls: "bg-sky-600",
      hint: "Comprou pelo link de uma mensagem do CRM (checkout com a UTM do CRM)",
    },
    {
      key: "influenced",
      label: "Influenciado",
      v: inf,
      cls: "bg-slate-400",
      hint: "Comprou até 7 dias depois de receber mensagem, sem clique registrado (pode ter comprado de qualquer jeito)",
    },
  ] as const;

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="grid gap-6 bg-gradient-to-br from-emerald-50 via-card to-sky-50 p-5 sm:p-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Desde {since}, o CRM trouxe
          </p>
          <p className="mt-1 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            {money(sure)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            recuperado + clique confirmado · {count(rec.orders + clk.orders)}{" "}
            {rec.orders + clk.orders === 1 ? "pedido" : "pedidos"}
            {store > 0 && <> · {pct((100 * sure) / store)} do faturamento da loja no período</>}
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Somando os influenciados: <strong className="text-foreground">{money(all)}</strong> em{" "}
            {count(rec.orders + clk.orders + inf.orders)} pedidos.
          </p>
        </div>
        <div className="grid gap-2">
          {parts.map((p) => (
            <div
              key={p.key}
              className="flex items-start gap-3 rounded-xl bg-card/80 p-3 ring-1 ring-border"
              title={p.hint}
            >
              <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", p.cls)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  <span className="text-base font-semibold tabular-nums">{money(p.v.revenue)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {count(p.v.orders)} {Number(p.v.orders) === 1 ? "pedido" : "pedidos"} · {p.hint}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 border-t border-border p-5 sm:p-6 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-sm font-semibold">Por mês</p>
          {data.by_month.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma venda ainda.</p>
          ) : (
            <ul className="space-y-2.5">
              {data.by_month.map((m) => {
                const [y, mo] = m.month.split("-");
                const total = m.recovered + m.clicked + m.influenced;
                return (
                  <li
                    key={m.month}
                    className="grid grid-cols-[70px_1fr_auto] items-center gap-3 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {MONTHS[Number(mo) - 1]}/{y?.slice(2)}
                    </span>
                    <span
                      className="flex h-3 overflow-hidden rounded-full bg-muted"
                      title={`${count(m.orders)} pedidos`}
                    >
                      <span
                        className="bg-emerald-600"
                        style={{ width: `${(100 * m.recovered) / maxMonth}%` }}
                      />
                      <span
                        className="ml-px bg-sky-600"
                        style={{ width: `${(100 * m.clicked) / maxMonth}%` }}
                      />
                      <span
                        className="ml-px bg-slate-400"
                        style={{ width: `${(100 * m.influenced) / maxMonth}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums">
                      <strong>{money(m.recovered + m.clicked)}</strong>
                      <span className="block text-[11px] text-muted-foreground">
                        + {money(m.influenced)} infl.
                      </span>
                    </span>
                    <span className="sr-only">{money(total)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="space-y-5">
          <ImpactTable
            title="Por fluxo"
            rows={data.by_flow.slice(0, 8).map((r) => ({ ...r, label: r.name }))}
          />
          <ImpactTable
            title="Por canal"
            rows={data.by_channel.map((r) => ({ ...r, label: CH_LABEL[r.channel] ?? r.channel }))}
          />
        </div>
      </div>
    </section>
  );
}

function ImpactTable({ title, rows }: { title: string; rows: ({ label: string } & ImpactRow)[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <p className="mb-2 text-sm font-semibold">{title}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead className="text-right">Recuperado</TableHead>
            <TableHead className="text-right">Clique</TableHead>
            <TableHead className="text-right">Influenciado</TableHead>
            <TableHead className="text-right">Pedidos</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.label}>
              <TableCell className="max-w-[180px] truncate font-medium">{r.label}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.recovered)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.clicked)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {money(r.influenced)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{count(r.orders)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

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
                <TableHead className="text-right">Aberturas</TableHead>
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
                  <TableCell className="text-right num">{count(r.opens)}</TableCell>
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
            <TableHead className="text-right">Entregues</TableHead>
            <TableHead className="text-right">Aberturas</TableHead>
            <TableHead className="text-right">Taxa de abertura</TableHead>
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
              <TableCell className="text-right num">{count(r.delivered)}</TableCell>
              <TableCell className="text-right num">{count(r.opens)}</TableCell>
              <TableCell className="text-right num">{share(r.opens, r.sent)}</TableCell>
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
