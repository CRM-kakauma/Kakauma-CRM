import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Mail, MessageCircle, Plus, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  CONTACT_STATUS_LABEL,
  OWNERS,
  TASK_TYPE_LABEL,
  addNote,
  getContact,
  toggleTask,
  updateContact,
  type ActivityType,
  type ContactStatus,
} from "@/services/crm";
import { NewDealDialog, NewTaskDialog, useInvalidateCrm } from "./forms";
import {
  Avatar,
  PriorityPill,
  ReasonPill,
  RecoveryStatusPill,
  StagePill,
  whatsappLink,
} from "./pills";

const ACTIVITY_DOT: Record<ActivityType, string> = {
  note: "bg-primary",
  stage_change: "bg-warning",
  status_change: "bg-warning",
  task_done: "bg-success",
  recovery: "bg-danger",
  purchase: "bg-success",
  created: "bg-muted-foreground",
};

export function ContactSheet({
  contactId,
  onClose,
}: {
  contactId: string | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!contactId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {contactId && <ContactBody key={contactId} contactId={contactId} />}
      </SheetContent>
    </Sheet>
  );
}

function ContactBody({ contactId }: { contactId: string }) {
  const invalidate = useInvalidateCrm();
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "contact", contactId],
    queryFn: () => getContact(contactId),
  });
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const [dealOpen, setDealOpen] = useState(false);

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof updateContact>[1]) => updateContact(contactId, patch),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error((e as Error).message),
  });
  const noteM = useMutation({
    mutationFn: () => addNote(contactId, note),
    onSuccess: () => {
      setNote("");
      invalidate();
    },
  });
  const taskM = useMutation({ mutationFn: toggleTask, onSuccess: () => invalidate() });

  if (isLoading || !data) {
    return (
      <div className="space-y-4 pt-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { contact: c, deals, recoveries, tasks, activities } = data;
  const wa = whatsappLink(c.phone, `Olá ${c.name.split(" ")[0]}, tudo bem?`);

  function addTag() {
    const t = tag.trim();
    if (!t || c.tags.includes(t)) return setTag("");
    update.mutate({ tags: [...c.tags, t] });
    setTag("");
  }

  return (
    <>
      <SheetHeader className="text-left">
        <div className="flex items-center gap-3">
          <Avatar name={c.name} className="size-11 text-sm" />
          <div className="min-w-0">
            <SheetTitle className="truncate">{c.name}</SheetTitle>
            <SheetDescription className="truncate">{c.email}</SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" asChild disabled={!wa}>
          <a href={wa ?? undefined} target="_blank" rel="noreferrer" aria-disabled={!wa}>
            <MessageCircle className="size-4" /> WhatsApp
          </a>
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" asChild>
          <a href={`mailto:${c.email}`}>
            <Mail className="size-4" /> E-mail
          </a>
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setTaskOpen(true)}>
          <Plus className="size-4" /> Tarefa
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDealOpen(true)}>
          <Plus className="size-4" /> Negócio
        </Button>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <Stat label="Total gasto" value={formatCurrency(c.total_spent)} />
        <Stat label="Pedidos" value={String(c.orders)} />
        <Stat
          label="Última compra"
          value={c.last_purchase_at ? formatDate(c.last_purchase_at) : "—"}
        />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="label-eyebrow mb-1">Status</dt>
          <Select
            value={c.status}
            onValueChange={(v) => update.mutate({ status: v as ContactStatus })}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {CONTACT_STATUS_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <dt className="label-eyebrow mb-1">Responsável</dt>
          <Select value={c.owner} onValueChange={(v) => update.mutate({ owner: v })}>
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OWNERS.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Info label="WhatsApp" value={c.phone} />
        <Info label="Cidade" value={[c.city, c.state].filter(Boolean).join(" / ") || null} />
        <Info label="Origem" value={c.source} />
        <Info label="Cadastrado em" value={formatDate(c.created_at)} />
      </dl>

      <div className="mt-5">
        <p className="label-eyebrow mb-2">Tags</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {c.tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
            >
              {t}
              <button
                type="button"
                aria-label={`Remover tag ${t}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => update.mutate({ tags: c.tags.filter((x) => x !== t) })}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <form
            className="flex items-center"
            onSubmit={(e) => {
              e.preventDefault();
              addTag();
            }}
          >
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="+ tag"
              className="h-7 w-24 text-xs"
            />
          </form>
        </div>
      </div>

      <Tabs defaultValue="activity" className="mt-6">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="activity">Atividades</TabsTrigger>
          <TabsTrigger value="deals">Negócios ({deals.length})</TabsTrigger>
          <TabsTrigger value="tasks">Tarefas ({tasks.filter((t) => !t.done).length})</TabsTrigger>
          <TabsTrigger value="recovery">Recuperação ({recoveries.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="mt-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) noteM.mutate();
            }}
            className="grid gap-2"
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Escreva uma anotação sobre o contato…"
              rows={3}
            />
            <Button
              type="submit"
              size="sm"
              className="justify-self-end gap-1.5"
              disabled={!note.trim() || noteM.isPending}
            >
              <StickyNote className="size-4" /> Salvar anotação
            </Button>
          </form>
          <ol className="mt-4 space-y-4 border-l border-border pl-4">
            {activities.map((a) => (
              <li key={a.id} className="relative">
                <span
                  className={cn(
                    "absolute -left-[21px] top-1.5 size-2 rounded-full",
                    ACTIVITY_DOT[a.type],
                  )}
                />
                <p
                  className={cn(
                    "text-sm",
                    a.type === "note" && "whitespace-pre-wrap rounded-lg bg-muted/60 px-3 py-2",
                  )}
                >
                  {a.text}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {a.author} · {formatDateTime(a.created_at)}
                </p>
              </li>
            ))}
          </ol>
        </TabsContent>

        <TabsContent value="deals" className="mt-4 space-y-2">
          {deals.length === 0 && <Empty text="Nenhum negócio para este contato." />}
          {deals.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">{d.title}</p>
                <p className="text-xs text-muted-foreground">
                  Atualizado {formatDate(d.updated_at)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm num">{formatCurrency(d.value)}</span>
                <StagePill stage={d.stage} />
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="tasks" className="mt-4 space-y-2">
          {tasks.length === 0 && <Empty text="Nenhuma tarefa para este contato." />}
          {tasks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => taskM.mutate(t.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2 text-left hover:bg-muted/50"
            >
              <CheckCircle2
                className={cn(
                  "size-4 shrink-0",
                  t.done ? "text-success" : "text-muted-foreground/40",
                )}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn("truncate text-sm", t.done && "text-muted-foreground line-through")}
                >
                  {t.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {TASK_TYPE_LABEL[t.type]} · {formatDateTime(t.due_at)}
                </p>
              </div>
              <PriorityPill priority={t.priority} />
            </button>
          ))}
        </TabsContent>

        <TabsContent value="recovery" className="mt-4 space-y-2">
          {recoveries.length === 0 && <Empty text="Nenhuma venda a recuperar." />}
          {recoveries.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium">{r.product}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ReasonPill reason={r.reason} />
                <RecoveryStatusPill status={r.status} />
              </div>
            </div>
          ))}
        </TabsContent>
      </Tabs>

      <NewTaskDialog
        open={taskOpen}
        onOpenChange={setTaskOpen}
        contactId={c.id}
        defaultTitle={`Follow-up com ${c.name.split(" ")[0]}`}
      />
      <NewDealDialog open={dealOpen} onOpenChange={setDealOpen} contactId={c.id} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2.5">
      <p className="label-eyebrow">{label}</p>
      <p className="mt-1 text-sm font-semibold num">{value}</p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="label-eyebrow">{label}</dt>
      <dd className="mt-1 break-words">{value ?? "—"}</dd>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
      {text}
    </p>
  );
}
