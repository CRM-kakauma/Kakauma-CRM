import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/states";
import { TransactionDrawer } from "@/components/transaction-drawer";
import { CustomerProfile } from "@/components/customer-profile";
import { Skeleton } from "@/components/ui/skeleton";
import { eventMeta, TONE_CLASSES } from "@/lib/events";
import { formatCurrency, formatDate, formatNumber, formatTime } from "@/lib/format";
import { fetchCustomer, fetchRecentUsers, searchUsers, type UserHit } from "@/services/analytics";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/journey")({
  head: () => ({
    meta: [
      { title: "Jornada do Cliente — Kakauma Analytics" },
      {
        name: "description",
        content:
          "Pesquise um cliente da Kakauma e veja a jornada completa de eventos, tentativas de pagamento e transações.",
      },
      { property: "og:title", content: "Jornada do Cliente — Kakauma Analytics" },
      {
        property: "og:description",
        content: "Pesquise um cliente para visualizar sua jornada evento por evento.",
      },
    ],
  }),
  component: JourneyPage,
});

function JourneyPage() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<UserHit | null>(null);
  const [txId, setTxId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const results = useQuery({
    queryKey: ["search-users", debounced],
    queryFn: () => searchUsers(debounced),
    enabled: debounced.length >= 2,
  });

  const recent = useQuery({ queryKey: ["recent-users"], queryFn: () => fetchRecentUsers(6) });

  const customer = useQuery({
    queryKey: ["customer", selected?.id],
    queryFn: () => fetchCustomer(selected!.id),
    enabled: !!selected,
  });

  const list = debounced.length >= 2 ? results.data : recent.data;

  return (
    <>
      <PageHeader
        title="Jornada do Cliente"
        description="Pesquise um cliente para visualizar sua jornada."
      />

      <div className="surface p-5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nome, email ou ID do cliente"
            className="w-full rounded-lg border border-input bg-card py-2.5 pl-9 pr-3 text-sm outline-none transition-shadow focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
        </div>

        <div className="mt-4">
          <p className="label-eyebrow">
            {debounced.length >= 2 ? "Resultados" : "Clientes mais recentes"}
          </p>
          {(results.isLoading || recent.isLoading) && (
            <div className="mt-3 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          )}
          {list && list.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Nenhum cliente encontrado para “{debounced}”.
            </p>
          )}
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {list?.map((u) => (
              <button
                key={u.id}
                onClick={() => setSelected(u)}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary-soft",
                  selected?.id === u.id && "border-primary/50 bg-primary-soft",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{u.name ?? "Sem nome"}</span>
                  <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {u.external_user_id}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {!selected && (
        <div className="mt-6">
          <EmptyState
            title="Nenhum cliente selecionado"
            description="Busque por nome, email ou ID do cliente e selecione um cliente para abrir a jornada completa."
          />
        </div>
      )}

      {selected && (
        <section className="mt-8">
          {customer.isLoading && <BlockSkeleton height={360} />}
          {customer.error && <ErrorState message={(customer.error as Error).message} />}
          {customer.data?.user && (
            <>
              <div className="surface p-5">
                <h2 className="text-lg font-semibold">{customer.data.user.name ?? "Sem nome"}</h2>
                <p className="text-sm text-muted-foreground">{customer.data.user.email}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  ID do cliente: {customer.data.user.external_user_id}
                </p>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  {
                    label: "Total Gasto",
                    value: formatCurrency(customer.data.metrics.total_spent),
                  },
                  { label: "Transações", value: formatNumber(customer.data.metrics.transactions) },
                  { label: "Reembolsos", value: formatNumber(customer.data.metrics.refunds) },
                  { label: "Chargebacks", value: formatNumber(customer.data.metrics.chargebacks) },
                ].map((m) => (
                  <div key={m.label} className="surface p-5">
                    <p className="label-eyebrow">{m.label}</p>
                    <p className="mt-3 text-xl font-semibold num">{m.value}</p>
                  </div>
                ))}
              </div>

              <CustomerProfile userId={customer.data.user.id} onOpenTx={setTxId} />

              <div className="mt-8">
                <h3 className="text-base font-semibold">Linha do tempo</h3>
                <p className="mb-4 text-xs text-muted-foreground">
                  {formatNumber(customer.data.journey.length)} eventos registrados
                </p>
                {customer.data.journey.length === 0 ? (
                  <EmptyState
                    title="Sem eventos"
                    description="Este cliente ainda não possui eventos registrados."
                  />
                ) : (
                  <ol className="space-y-1 border-l border-border pl-6">
                    {customer.data.journey.map((e) => {
                      const meta = eventMeta(e.event_type);
                      const tone = TONE_CLASSES[meta.tone];
                      const Icon = meta.icon;
                      const clickable = !!e.transaction_id;
                      return (
                        <li key={e.id} className="relative">
                          <span
                            className={cn(
                              "absolute -left-[37px] top-3 flex size-6 items-center justify-center rounded-full ring-4 ring-background",
                              tone.bg,
                            )}
                          >
                            <Icon className={cn("size-3.5", tone.text)} />
                          </span>
                          <button
                            disabled={!clickable}
                            onClick={() => clickable && setTxId(e.transaction_id)}
                            className={cn(
                              "flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition-colors",
                              clickable ? "hover:bg-primary-soft" : "cursor-default",
                            )}
                          >
                            <span>
                              <span className="block text-sm font-medium">{meta.label}</span>
                              <span className="block text-xs text-muted-foreground num">
                                {formatDate(e.timestamp)} · {formatTime(e.timestamp)}
                                {e.external_transaction_id
                                  ? ` · #${e.external_transaction_id}`
                                  : ""}
                              </span>
                            </span>
                            {e.value != null && (
                              <span className="text-sm font-semibold num">
                                {formatCurrency(e.value)}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <TransactionDrawer transactionId={txId} onClose={() => setTxId(null)} />
    </>
  );
}
