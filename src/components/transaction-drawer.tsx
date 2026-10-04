import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/states";
import { eventMeta, TONE_CLASSES } from "@/lib/events";
import { formatCurrency, formatDateTime, formatNumber, formatTime } from "@/lib/format";
import { fetchTransactionDetail } from "@/services/analytics";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  approved: "bg-success-soft text-success",
  refunded: "bg-warning-soft text-warning",
  chargeback: "bg-danger-soft text-danger",
  declined: "bg-danger-soft text-danger",
  expired: "bg-muted text-muted-foreground",
  pending: "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
  approved: "aprovada",
  refunded: "reembolsada",
  chargeback: "chargeback",
  declined: "recusada",
  expired: "expirada",
  pending: "pendente",
};

export function TransactionDrawer({
  transactionId,
  onClose,
}: {
  transactionId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["transaction", transactionId],
    queryFn: () => fetchTransactionDetail(transactionId as string),
    enabled: !!transactionId,
  });

  return (
    <Sheet open={!!transactionId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Transação</SheetTitle>
        </SheetHeader>

        <div className="px-4 pb-8">
          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
          {error && <ErrorState message={(error as Error).message} />}
          {data?.transaction && (
            <div className="space-y-6">
              <div>
                <p className="font-mono text-sm font-semibold">
                  #{data.transaction.external_transaction_id}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(data.transaction.created_at)}
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-muted/40 p-4">
                <div className="col-span-2">
                  <dt className="label-eyebrow">Cliente</dt>
                  <dd className="mt-1 text-sm font-medium">{data.user?.name ?? "—"}</dd>
                  <dd className="text-xs text-muted-foreground">{data.user?.email}</dd>
                </div>
                <div>
                  <dt className="label-eyebrow">Valor</dt>
                  <dd className="mt-1 text-sm font-semibold num">
                    {formatCurrency(data.transaction.value)}
                  </dd>
                </div>
                <div>
                  <dt className="label-eyebrow">Valor Líquido</dt>
                  <dd className="mt-1 text-sm font-semibold num">
                    {data.transaction.net_value != null
                      ? formatCurrency(data.transaction.net_value)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="label-eyebrow">Afiliado</dt>
                  <dd className="mt-1 text-sm font-semibold num">
                    {data.transaction.affiliate_value != null
                      ? formatCurrency(data.transaction.affiliate_value)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="label-eyebrow">Método de Pagamento</dt>
                  <dd className="mt-1 text-sm font-medium uppercase">
                    {data.transaction.payment_method ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="label-eyebrow">Status</dt>
                  <dd className="mt-1">
                    <span
                      className={cn(
                        "rounded-md px-2 py-0.5 text-xs font-semibold capitalize",
                        STATUS_TONE[data.transaction.status] ?? "bg-muted text-muted-foreground",
                      )}
                    >
                      {STATUS_LABEL[data.transaction.status] ?? data.transaction.status}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="label-eyebrow">Produto</dt>
                  <dd className="mt-1 text-xs text-muted-foreground">
                    {data.transaction.product_id ?? "—"}
                  </dd>
                </div>
              </dl>

              <div className="grid grid-cols-2 gap-3">
                <div className="surface p-4">
                  <p className="label-eyebrow">Tentativas de Pagamento</p>
                  <p className="mt-2 text-xl font-semibold num">
                    {formatNumber(data.payment_attempts)}
                  </p>
                </div>
                <div className="surface p-4">
                  <p className="label-eyebrow">Tempo até Conversão</p>
                  <p className="mt-2 text-xl font-semibold num">
                    {data.time_to_conversion_minutes != null
                      ? `${formatNumber(data.time_to_conversion_minutes)} min`
                      : "—"}
                  </p>
                </div>
              </div>

              <div>
                <p className="label-eyebrow mb-3">Linha do Tempo</p>
                <ol className="space-y-3 border-l border-border pl-4">
                  {data.timeline.map((e) => {
                    const meta = eventMeta(e.event_type);
                    const tone = TONE_CLASSES[meta.tone];
                    return (
                      <li key={e.id} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[21px] top-1.5 size-2 rounded-full ring-2 ring-card",
                            tone.dot,
                          )}
                        />
                        <p className="text-sm font-medium">{meta.label}</p>
                        <p className="text-xs text-muted-foreground num">
                          {formatTime(e.timestamp)}
                          {e.value != null ? ` · ${formatCurrency(e.value)}` : ""}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
