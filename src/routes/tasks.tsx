import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContactSheet } from "@/components/crm/contact-sheet";
import { FilterSelect } from "@/components/crm/filter-select";
import { NewTaskDialog, useInvalidateCrm } from "@/components/crm/forms";
import { PriorityPill } from "@/components/crm/pills";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  OWNERS,
  TASK_TYPE_LABEL,
  listTasks,
  toggleTask,
  type TaskWithContact,
} from "@/services/crm";

export const Route = createFileRoute("/tasks")({
  head: () => ({
    meta: [
      { title: "Tarefas — Kakauma CRM" },
      { name: "description", content: "Follow-ups, ligações e mensagens agendadas da equipe." },
    ],
  }),
  component: TasksPage,
});

type View = "open" | "done";

function bucketOf(t: TaskWithContact, now: Date) {
  const due = new Date(t.due_at);
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  if (due < now) return "Atrasadas";
  if (due <= endToday) return "Hoje";
  const endWeek = new Date(endToday.getTime() + 6 * 86_400_000);
  if (due <= endWeek) return "Próximos 7 dias";
  return "Depois";
}

const BUCKETS = ["Atrasadas", "Hoje", "Próximos 7 dias", "Depois"] as const;

function TasksPage() {
  const invalidate = useInvalidateCrm();
  const [view, setView] = useState<View>("open");
  const [owner, setOwner] = useState("all");
  const [newOpen, setNewOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ["crm", "tasks"], queryFn: listTasks });
  const toggle = useMutation({ mutationFn: toggleTask, onSuccess: () => invalidate() });

  const now = new Date();
  const tasks = (data ?? []).filter(
    (t) => (owner === "all" || t.owner === owner) && t.done === (view === "done"),
  );

  return (
    <>
      <PageHeader title="Tarefas" description="Follow-ups, ligações e mensagens da equipe.">
        <Button className="gap-2" onClick={() => setNewOpen(true)}>
          <Plus className="size-4" /> Nova tarefa
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="open">Em aberto</TabsTrigger>
            <TabsTrigger value="done">Concluídas</TabsTrigger>
          </TabsList>
        </Tabs>
        <FilterSelect
          value={owner}
          onChange={setOwner}
          all="Todos os responsáveis"
          options={OWNERS.map((o) => ({ value: o, label: o }))}
        />
      </div>

      {isLoading ? (
        <BlockSkeleton height={400} />
      ) : !tasks.length ? (
        <EmptyState
          title="Nenhuma tarefa"
          description={
            view === "open" ? "Tudo em dia por aqui." : "Nenhuma tarefa concluída ainda."
          }
        />
      ) : view === "done" ? (
        <TaskList
          tasks={[...tasks].reverse()}
          onToggle={(id) => toggle.mutate(id)}
          onOpen={setSelected}
        />
      ) : (
        <div className="space-y-6">
          {BUCKETS.map((b) => {
            const xs = tasks.filter((t) => bucketOf(t, now) === b);
            if (!xs.length) return null;
            return (
              <section key={b}>
                <h2
                  className={cn("mb-2 text-sm font-semibold", b === "Atrasadas" && "text-danger")}
                >
                  {b} <span className="font-normal text-muted-foreground">({xs.length})</span>
                </h2>
                <TaskList
                  tasks={xs}
                  overdue={b === "Atrasadas"}
                  onToggle={(id) => toggle.mutate(id)}
                  onOpen={setSelected}
                />
              </section>
            );
          })}
        </div>
      )}

      <NewTaskDialog open={newOpen} onOpenChange={setNewOpen} />
      <ContactSheet contactId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function TaskList({
  tasks,
  overdue,
  onToggle,
  onOpen,
}: {
  tasks: TaskWithContact[];
  overdue?: boolean;
  onToggle: (id: string) => void;
  onOpen: (contactId: string) => void;
}) {
  return (
    <ul className="surface divide-y divide-border overflow-hidden">
      {tasks.map((t) => (
        <li key={t.id} className="flex items-center gap-3 px-4 py-3">
          <button
            type="button"
            aria-label={t.done ? "Reabrir tarefa" : "Concluir tarefa"}
            onClick={() => onToggle(t.id)}
          >
            <CheckCircle2
              className={cn(
                "size-5",
                t.done ? "text-success" : "text-muted-foreground/40 hover:text-success",
              )}
            />
          </button>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm font-medium",
                t.done && "text-muted-foreground line-through",
              )}
            >
              {t.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {TASK_TYPE_LABEL[t.type]} ·{" "}
              <span className={cn(overdue && "text-danger")}>{formatDateTime(t.due_at)}</span> ·{" "}
              {t.owner}
            </p>
          </div>
          {t.contact && (
            <button
              type="button"
              onClick={() => onOpen(t.contact!.id)}
              className="hidden text-xs text-primary hover:underline sm:block"
            >
              {t.contact.name}
            </button>
          )}
          <PriorityPill priority={t.priority} />
        </li>
      ))}
    </ul>
  );
}
