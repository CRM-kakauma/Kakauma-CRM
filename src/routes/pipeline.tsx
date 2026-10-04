import { useState, type DragEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContactSheet } from "@/components/crm/contact-sheet";
import { FilterSelect } from "@/components/crm/filter-select";
import { NewDealDialog, useInvalidateCrm } from "@/components/crm/forms";
import { Avatar } from "@/components/crm/pills";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  DEAL_STAGES,
  OWNERS,
  listDeals,
  moveDeal,
  type DealStage,
  type DealWithContact,
} from "@/services/crm";

export const Route = createFileRoute("/pipeline")({
  head: () => ({
    meta: [
      { title: "Pipeline — Kakauma CRM" },
      {
        name: "description",
        content: "Funil de vendas em kanban: arraste negócios entre as etapas.",
      },
    ],
  }),
  component: PipelinePage,
});

const COLUMN_ACCENT: Record<DealStage, string> = {
  novo: "bg-muted-foreground/40",
  contato: "bg-primary/60",
  proposta: "bg-primary",
  negociacao: "bg-warning",
  ganho: "bg-success",
  perdido: "bg-danger",
};

function PipelinePage() {
  const invalidate = useInvalidateCrm();
  const [owner, setOwner] = useState("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<DealStage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newStage, setNewStage] = useState<DealStage | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["crm", "deals"], queryFn: listDeals });
  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: DealStage }) => moveDeal(id, stage),
    onSuccess: (d) => {
      if (d.stage === "ganho") toast.success("Negócio ganho! 🎉");
      invalidate();
    },
  });

  const deals = (data ?? []).filter((d) => owner === "all" || d.owner === owner);

  function onDrop(e: DragEvent, stage: DealStage) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    setOver(null);
    setDragging(null);
    if (id) move.mutate({ id, stage });
  }

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Arraste os negócios entre as etapas do funil de vendas."
      >
        <div className="flex gap-2">
          <FilterSelect
            value={owner}
            onChange={setOwner}
            all="Todos os responsáveis"
            options={OWNERS.map((o) => ({ value: o, label: o }))}
          />
          <Button className="gap-2" onClick={() => setNewStage("novo")}>
            <Plus className="size-4" /> Novo negócio
          </Button>
        </div>
      </PageHeader>

      {isLoading ? (
        <BlockSkeleton height={520} />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
          <div className="flex min-w-max gap-4">
            {DEAL_STAGES.map((s) => {
              const col = deals.filter((d) => d.stage === s.key);
              const total = col.reduce((sum, d) => sum + d.value, 0);
              return (
                <section
                  key={s.key}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(s.key);
                  }}
                  onDragLeave={() => setOver((o) => (o === s.key ? null : o))}
                  onDrop={(e) => onDrop(e, s.key)}
                  className={cn(
                    "flex w-72 flex-col rounded-xl border border-border bg-muted/40 transition-colors",
                    over === s.key && "border-primary bg-primary-soft/60",
                  )}
                >
                  <header className="flex items-start justify-between gap-2 px-3 pb-2 pt-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={cn("size-2 rounded-full", COLUMN_ACCENT[s.key])} />
                        <h2 className="text-sm font-semibold">{s.label}</h2>
                        <span className="rounded bg-background px-1.5 text-xs text-muted-foreground">
                          {col.length}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground num">
                        {formatCurrency(total)}
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Novo negócio em ${s.label}`}
                      onClick={() => setNewStage(s.key)}
                    >
                      <Plus className="size-4" />
                    </Button>
                  </header>
                  <div className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-3">
                    {col.map((d) => (
                      <DealCard
                        key={d.id}
                        deal={d}
                        dragging={dragging === d.id}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", d.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(d.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        onOpen={() => setSelected(d.contact_id)}
                        onMove={(stage) => move.mutate({ id: d.id, stage })}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <ContactSheet contactId={selected} onClose={() => setSelected(null)} />
      {newStage && (
        <NewDealDialog open onOpenChange={(o) => !o && setNewStage(null)} stage={newStage} />
      )}
    </>
  );
}

function DealCard({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onMove,
}: {
  deal: DealWithContact;
  dragging: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onMove: (stage: DealStage) => void;
}) {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "cursor-grab rounded-lg border border-border bg-card p-3 shadow-card transition hover:shadow-float active:cursor-grabbing",
        dragging && "opacity-50",
      )}
    >
      {/* A native <button> would block dragging in Chromium, so this is a div with button semantics. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="block w-full rounded text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <p className="text-sm font-medium leading-snug">{deal.title}</p>
        <div className="mt-2 flex items-center gap-2">
          <Avatar name={deal.contact.name} className="size-6 text-[10px]" />
          <span className="truncate text-xs text-muted-foreground">{deal.contact.name}</span>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold num">{formatCurrency(deal.value)}</span>
        <span className="text-[11px] text-muted-foreground">
          {deal.owner} · {formatDate(deal.updated_at)}
        </span>
      </div>
      {/* Touch devices have no drag & drop: let the stage be changed from the card. */}
      <Select value={deal.stage} onValueChange={(v) => onMove(v as DealStage)}>
        <SelectTrigger className="mt-2 h-7 text-xs lg:hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEAL_STAGES.map((s) => (
            <SelectItem key={s.key} value={s.key}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </article>
  );
}
