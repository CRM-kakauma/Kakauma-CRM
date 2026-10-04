import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { eventMeta } from "@/lib/events";
import { formatCurrency, formatDate, formatTime } from "@/lib/format";
import type { EventRow } from "@/services/analytics";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="label-eyebrow">{label}</p>
      <p className="mt-1 break-all text-sm">{value ?? "—"}</p>
    </div>
  );
}

export function EventDetailSheet({ event, onClose }: { event: EventRow | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const json = event ? JSON.stringify(event, null, 2) : "";
  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Sheet open={!!event} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {event && (
          <>
            <SheetHeader>
              <SheetTitle>{eventMeta(event.event_type).label}</SheetTitle>
              <SheetDescription>
                {formatDate(event.timestamp)} · {formatTime(event.timestamp)}
              </SheetDescription>
            </SheetHeader>
            <div className="mt-6 grid grid-cols-2 gap-4">
              <Field label="ID do evento" value={<span className="font-mono text-xs">{event.event_id}</span>} />
              <Field label="Valor" value={event.value != null ? formatCurrency(event.value) : "—"} />
              <Field label="Cliente" value={event.users?.name ?? "—"} />
              <Field label="E-mail" value={event.users?.email ?? "—"} />
              <Field label="Transação" value={event.transactions?.external_transaction_id ?? "—"} />
              <Field label="Origem" value={event.source ?? "—"} />
            </div>
            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <p className="label-eyebrow">Evento completo</p>
                <button onClick={copy} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </div>
              <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed">
                {json}
              </pre>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
