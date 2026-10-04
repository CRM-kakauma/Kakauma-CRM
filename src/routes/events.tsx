import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/states";
import { usePeriod } from "@/components/period-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { eventMeta, EVENT_TYPES, TONE_CLASSES, type EventType } from "@/lib/events";
import { formatCurrency, formatDate, formatTime } from "@/lib/format";
import { fetchEvents } from "@/services/analytics";
import { cn } from "@/lib/utils";
import { EventDetailSheet } from "@/components/event-detail-sheet";
import type { EventRow } from "@/services/analytics";

export const Route = createFileRoute("/events")({
  head: () => ({
    meta: [
      { title: "Eventos — Kakauma Analytics" },
      {
        name: "description",
        content: "Stream de eventos brutos recebidos pela Kakauma Analytics, com filtros e origem.",
      },
      { property: "og:title", content: "Eventos — Kakauma Analytics" },
      {
        property: "og:description",
        content: "A fonte de verdade da plataforma: todos os eventos recebidos.",
      },
    ],
  }),
  component: EventsPage,
});

function EventsPage() {
  const { from, to } = usePeriod();
  const [eventType, setEventType] = useState<EventType | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<EventRow | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const events = useQuery({
    queryKey: ["events", eventType, from.toISOString(), to.toISOString()],
    queryFn: () => fetchEvents({ eventType, from, to, limit: 200 }),
  });

  const rows = (events.data ?? []).filter((e) => {
    if (!debounced) return true;
    const u = e.users;
    return (
      (u?.name ?? "").toLowerCase().includes(debounced) ||
      (u?.email ?? "").toLowerCase().includes(debounced) ||
      (u?.external_user_id ?? "").toLowerCase().includes(debounced) ||
      (e.transactions?.external_transaction_id ?? "").toLowerCase().includes(debounced)
    );
  });

  return (
    <>
      <PageHeader
        title="Eventos"
        description="Todos os eventos recebidos — a fonte de verdade da plataforma."
      />

      <div className="surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filtrar por cliente ou transação"
              className="w-full rounded-lg border border-input bg-card py-2 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </div>
          <Select value={eventType} onValueChange={(v) => setEventType(v as EventType | "ALL")}>
            <SelectTrigger className="w-60">
              <SelectValue placeholder="Todos os eventos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos os eventos</SelectItem>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {eventMeta(t).label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4">
        {events.isLoading && <BlockSkeleton height={400} />}
        {events.error && <ErrorState message={(events.error as Error).message} />}
        {events.data && rows.length === 0 && (
          <EmptyState
            title="Nenhum evento no período"
            description="Ajuste o período, o tipo de evento ou o filtro de busca para ver resultados."
          />
        )}
        {rows.length > 0 && (
          <div className="surface overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {["Data/Hora", "Evento", "Cliente", "Transação", "Valor", "Origem"].map((h) => (
                    <th key={h} className="label-eyebrow px-4 py-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const meta = eventMeta(e.event_type);
                  const tone = TONE_CLASSES[meta.tone];
                  return (
                    <tr key={e.id} onClick={() => setSelected(e)} className="cursor-pointer border-b border-border/70 last:border-0 hover:bg-muted/40">
                      <td className="whitespace-nowrap px-4 py-3 num text-muted-foreground">
                        {formatDate(e.timestamp)} · {formatTime(e.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium",
                            tone.bg,
                            tone.text,
                          )}
                        >
                          <span className={cn("size-1.5 rounded-full", tone.dot)} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="block max-w-44 truncate">{e.users?.name ?? "—"}</span>
                        <span className="block max-w-44 truncate text-xs text-muted-foreground">
                          {e.users?.external_user_id}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted-foreground">
                        {e.transactions?.external_transaction_id
                          ? `#${e.transactions.external_transaction_id}`
                          : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 num">
                        {e.value != null ? formatCurrency(e.value) : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{e.source ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <EventDetailSheet event={selected} onClose={() => setSelected(null)} />
    </>
  );
}
