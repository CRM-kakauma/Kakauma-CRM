import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  FlaskConical,
  MoreHorizontal,
  Pause,
  Play,
  Rocket,
  Save,
  X,
} from "lucide-react";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth } from "@/components/crm/ui";
import { FlowCanvas, NODE_ICON, type NodeStats } from "@/components/crm/flow-canvas";
import { FlowPanel, type FlowSettings, type TemplateLite } from "@/components/crm/flow-panel";
import { Simulator } from "@/components/crm/simulators";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FACT_LABEL, crmCall, label, useCrm, type Me } from "@/lib/crm-api";
import {
  EMPTY_GRAPH,
  NODE_META,
  describe as describeNode,
  hoursText,
  insertNode,
  nodeProblem,
  removalCost,
  removeNode,
  updateConfig,
  waitText,
  type Graph,
} from "@/lib/crm-flows";
import { CHANNEL_LABEL } from "@/lib/crm-messages";
import { count, dateTime, pct } from "@/lib/crm-format";
import { FLOW_STATUS } from "./flows.index";

export const Route = createFileRoute("/flows/$key")({
  head: () => ({ meta: [{ title: "Fluxo — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Loader me={me} />}</RequireAuth>,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- stats and simulation are dynamic JSON */
type Obj = any;

interface FlowDoc extends FlowSettings {
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  version: number;
  graph: Graph;
  published_at: string | null;
  has_unpublished_changes: boolean;
}

const NEW: FlowDoc = {
  key: "",
  name: "",
  description: null,
  trigger_fact: "PURCHASE_PAID",
  trigger_filter: {},
  entry_rule: {},
  reentry: "after_exit",
  max_trigger_age_hours: 72,
  goal_fact: null,
  status: "DRAFT",
  version: 0,
  graph: EMPTY_GRAPH,
  published_at: null,
  has_unpublished_changes: true,
};

function Loader({ me }: { me: Me }) {
  const { key } = Route.useParams();
  const isNew = key === "new";
  const { data, isLoading, error } = useCrm<FlowDoc | null>(
    "crm_get_flow",
    { p_key: key },
    { enabled: !isNew },
  );
  if (isNew) return <Builder me={me} initial={NEW} isNew />;
  if (isLoading) return <Loading rows={6} />;
  if (error) return <ApiErrorBox error={error} />;
  if (!data) return <Empty>Fluxo não encontrado.</Empty>;
  return <Builder key={`${data.key}:${data.version}`} me={me} initial={data} isNew={false} />;
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 50);

const settingsOf = (d: FlowDoc): FlowSettings => ({
  key: d.key,
  name: d.name,
  description: d.description,
  trigger_fact: d.trigger_fact,
  trigger_filter: d.trigger_filter,
  entry_rule: d.entry_rule,
  reentry: d.reentry,
  max_trigger_age_hours: d.max_trigger_age_hours,
  goal_fact: d.goal_fact,
});

function Builder({ me, initial, isNew }: { me: Me; initial: FlowDoc; isNew: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canEdit = me.role !== "viewer" && initial.status !== "ARCHIVED";
  const [settings, setSettings] = useState<FlowSettings>(settingsOf(initial));
  const [graph, setGraph] = useState<Graph>(initial.graph);
  const [savedSnapshot, setSavedSnapshot] = useState(
    JSON.stringify([settingsOf(initial), initial.graph]),
  );
  const [selected, setSelected] = useState<string | null>(isNew ? "start" : null);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [sim, setSim] = useState<Obj | null>(null);
  const [simOpen, setSimOpen] = useState(false);
  const dirty = JSON.stringify([settings, graph]) !== savedSnapshot;

  const { data: templates = [] } = useCrm<TemplateLite[]>("crm_list_templates", {});
  const tplMap = useMemo(() => new Map(templates.map((t) => [t.key, t])), [templates]);
  const stats = useCrm<Obj>(
    "crm_flow_stats",
    { p_key: initial.key },
    { enabled: !isNew && initial.version > 0, refetchInterval: 15_000 },
  );

  useEffect(() => {
    const t = setTimeout(() => {
      crmCall<string[]>("crm_flow_graph_errors", { p_graph: graph })
        .then(setErrors)
        .catch(() => setErrors(null));
    }, 400);
    return () => clearTimeout(t);
  }, [graph]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const nodeStats = useMemo(() => {
    const s = stats.data;
    if (!s) return undefined;
    const out: Record<string, NodeStats> = {};
    for (const n of graph.nodes) {
      out[n.id] = {
        passed: Number(s.nodes?.[n.id]?.passed ?? 0),
        here: Number(s.here_now?.[n.id] ?? 0),
        outcomes: Object.fromEntries(
          Object.entries(s.nodes?.[n.id]?.outcomes ?? {}).map(([k, v]) => [k, Number(v)]),
        ),
        goalRate: Object.fromEntries(
          Object.entries(s.split_goals ?? {})
            .filter(([k]) => k.startsWith(`${n.id}:`))
            .map(([k, v]: [string, any]) => [
              k.slice(n.id.length + 1),
              v.rate == null ? null : Number(v.rate),
            ]),
        ),
      };
    }
    return out;
  }, [stats.data, graph.nodes]);

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      const key = settings.key || slug(settings.name);
      await crmCall("crm_save_flow", {
        p_key: key,
        p_name: settings.name,
        p_description: settings.description,
        p_trigger_fact: settings.trigger_fact,
        p_trigger_filter: settings.trigger_filter,
        p_entry_rule: settings.entry_rule,
        p_reentry: settings.reentry,
        p_max_trigger_age_hours: settings.max_trigger_age_hours,
        p_goal_fact: settings.goal_fact,
        p_graph: graph,
      });
      if (publish) await crmCall("crm_publish_flow", { p_key: key });
      return key;
    },
    onSuccess: (key, publish) => {
      toast.success(publish ? "Fluxo publicado" : "Rascunho salvo", {
        description: publish
          ? "Novos fatos já entram nesta versão. Quem já estava segue a versão anterior."
          : undefined,
      });
      setSavedSnapshot(JSON.stringify([{ ...settings, key }, graph]));
      void qc.invalidateQueries({ queryKey: ["crm"] });
      if (isNew) void navigate({ to: "/flows/$key", params: { key } });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const status = useMutation({
    mutationFn: (s: "ACTIVE" | "PAUSED" | "ARCHIVED") =>
      crmCall("crm_set_flow_status", { p_key: initial.key, p_status: s }),
    onSuccess: (_, s) => {
      toast.success(
        s === "ACTIVE" ? "Fluxo retomado" : s === "PAUSED" ? "Fluxo pausado" : "Fluxo arquivado",
      );
      void qc.invalidateQueries({ queryKey: ["crm"] });
      if (s === "ARCHIVED") void navigate({ to: "/flows" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const ctx = { templates: tplMap, triggerFact: settings.trigger_fact };
  const path = useMemo(() => {
    if (!sim?.path) return null;
    const nodes = new Set<string>(sim.path.map((s: Obj) => s.node_id));
    const outs = new Set<string>(sim.path.map((s: Obj) => `${s.node_id}:${s.outcome}`));
    return { nodes, outs };
  }, [sim]);
  const st = FLOW_STATUS[initial.status] ?? FLOW_STATUS["DRAFT"]!;
  const ready = errors !== null && errors.length === 0;

  return (
    <>
      <Link
        to="/flows"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="size-4" /> Fluxos
      </Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={settings.name}
              disabled={!canEdit}
              onChange={(e) => setSettings((s) => ({ ...s, name: e.target.value }))}
              placeholder="Nome do fluxo"
              className="h-10 max-w-md border-transparent bg-transparent px-1 text-xl font-semibold shadow-none md:text-xl hover:border-border focus-visible:border-input"
            />
            {!isNew && <Pill tone={st.tone}>{st.label}</Pill>}
            {!isNew && initial.version > 0 && (
              <span className="text-xs text-muted-foreground">versão {initial.version}</span>
            )}
          </div>
          <Input
            value={settings.description ?? ""}
            disabled={!canEdit}
            onChange={(e) => setSettings((s) => ({ ...s, description: e.target.value || null }))}
            placeholder="Para que serve este fluxo (opcional)"
            className="mt-1 h-8 max-w-2xl border-transparent bg-transparent px-1 text-sm text-muted-foreground shadow-none hover:border-border"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setSimOpen((o) => !o)}>
            <FlaskConical className="size-4" /> Simular
          </Button>
          {canEdit && (
            <>
              <Button
                variant="outline"
                onClick={() => save.mutate(false)}
                disabled={!settings.name || save.isPending || (!dirty && !isNew)}
              >
                <Save className="size-4" /> Salvar rascunho
              </Button>
              <Button
                onClick={() => {
                  if (
                    confirm(
                      "Publicar? A partir de agora, novos fatos colocam clientes nesta versão do fluxo (mensagens de verdade quando o canal estiver conectado).",
                    )
                  )
                    save.mutate(true);
                }}
                disabled={
                  !settings.name ||
                  !ready ||
                  save.isPending ||
                  (!dirty && !initial.has_unpublished_changes)
                }
                title={ready ? undefined : "Corrija os pontos indicados antes de publicar"}
              >
                <Rocket className="size-4" /> {initial.version ? "Publicar alterações" : "Publicar"}
              </Button>
              {!isNew && initial.version > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Mais ações">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {initial.status === "ACTIVE" ? (
                      <DropdownMenuItem onSelect={() => status.mutate("PAUSED")}>
                        <Pause className="size-4" /> Pausar (ninguém avança nem entra)
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => status.mutate("ACTIVE")}>
                        <Play className="size-4" /> Retomar
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="text-danger"
                      onSelect={() =>
                        confirm("Arquivar? Todos que estão no fluxo saem dele.") &&
                        status.mutate("ARCHIVED")
                      }
                    >
                      <Archive className="size-4" /> Arquivar
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          )}
        </div>
      </div>

      {!isNew && initial.status === "ACTIVE" && (initial.has_unpublished_changes || dirty) && (
        <p className="mb-3 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
          Há alterações não publicadas. O fluxo continua rodando a versão {initial.version} até você
          publicar.
        </p>
      )}
      {initial.status === "PAUSED" && (
        <p className="mb-3 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
          Pausado: ninguém novo entra e quem está dentro fica parado onde está até retomar.
        </p>
      )}

      <Tabs defaultValue="builder">
        <TabsList>
          <TabsTrigger value="builder">Construtor</TabsTrigger>
          {!isNew && initial.version > 0 && (
            <TabsTrigger value="people">Clientes no fluxo</TabsTrigger>
          )}
          {!isNew && initial.version > 0 && (
            <TabsTrigger value="messages">Mensagens enviadas</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="builder" className="mt-4">
          {stats.data && <Summary s={stats.data} hasGoal={!!settings.goal_fact} />}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-3">
              <FlowCanvas
                graph={graph}
                selected={selected}
                onSelect={(id) => {
                  setSelected(id);
                  setSimOpen(false);
                }}
                onInsert={
                  canEdit
                    ? (parent, handle, t) => {
                        const r = insertNode(graph, parent, handle, t);
                        setGraph(r.graph);
                        setSelected(r.id);
                        setSimOpen(false);
                      }
                    : undefined
                }
                describe={(n) => describeNode(n, ctx)}
                problem={(n) => nodeProblem(n, tplMap)}
                stats={nodeStats}
                path={simOpen ? path : null}
              />
              {errors !== null && (
                <div
                  className={
                    errors.length
                      ? "rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger"
                      : "rounded-lg bg-success-soft px-3 py-2 text-xs text-success"
                  }
                >
                  {errors.length ? (
                    <>
                      <p className="mb-1 flex items-center gap-1 font-medium">
                        <CircleAlert className="size-3.5" /> Para publicar, corrija:
                      </p>
                      <ul className="list-disc pl-5">
                        {errors.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="flex items-center gap-1">
                      <CircleCheck className="size-3.5" /> Fluxo válido. Clique no “+” entre as
                      etapas para adicionar mais.
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="xl:sticky xl:top-4 xl:self-start">
              {simOpen ? (
                <SimulationPanel
                  graph={graph}
                  settings={settings}
                  result={sim}
                  onResult={setSim}
                  onClose={() => setSimOpen(false)}
                  templates={tplMap}
                />
              ) : node ? (
                <FlowPanel
                  key={node.id}
                  node={node}
                  settings={settings}
                  templates={templates}
                  readOnly={!canEdit}
                  removalCost={removalCost(graph, node.id)}
                  onConfig={(c) => setGraph((g) => updateConfig(g, node.id, c))}
                  onSettings={(p) => setSettings((s) => ({ ...s, ...p }))}
                  onDelete={() => {
                    setGraph((g) => removeNode(g, node.id));
                    setSelected(null);
                  }}
                  onClose={() => setSelected(null)}
                />
              ) : (
                <Guide />
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="people" className="mt-4">
          <People s={stats.data} />
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          <SentMessages flowKey={initial.key} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Summary({ s, hasGoal }: { s: Obj; hasGoal: boolean }) {
  const e = s.enrollments ?? {};
  const m = s.messages ?? {};
  const items: [string, string, (string | undefined)?][] = [
    ["Entraram", count(e.total)],
    ["No fluxo agora", count(e.live)],
    ["Concluíram", count(e.completed)],
    ...(hasGoal
      ? ([["Meta atingida", count(e.goal), pct(e.goal_rate)]] as [string, string, string][])
      : []),
    ["Saíram antes", count(Number(e.exited ?? 0) + Number(e.failed ?? 0))],
    [
      "Mensagens",
      count(Number(m.sent ?? 0) + Number(m.dry_run ?? 0)),
      m.skipped ? `${m.skipped} puladas` : undefined,
    ],
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([l, v, h]) => (
        <div key={l} className="surface px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{l}</p>
          <p className="text-lg font-semibold tabular-nums">
            {v} {h && <span className="text-xs font-normal text-muted-foreground">{h}</span>}
          </p>
        </div>
      ))}
    </div>
  );
}

function Guide() {
  return (
    <aside className="surface space-y-3 p-4 text-sm">
      <p className="font-semibold">Como montar</p>
      <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
        <li>
          Clique em <strong className="text-foreground">Início</strong> para escolher o gatilho,
          quem pode entrar e a meta.
        </li>
        <li>
          Use o <strong className="text-foreground">+</strong> entre as etapas para adicionar
          envios, esperas, condições e testes A/B.
        </li>
        <li>Clique numa etapa para configurar. Arraste o fundo para navegar.</li>
        <li>
          <strong className="text-foreground">Simular</strong> mostra o caminho de um cliente real,
          sem enviar nada.
        </li>
        <li>
          <strong className="text-foreground">Publicar</strong> liga o fluxo. Editar depois cria uma
          nova versão.
        </li>
      </ol>
      <div className="space-y-2 border-t border-border pt-3">
        {(Object.keys(NODE_META) as (keyof typeof NODE_META)[]).map((t) => {
          const Icon = NODE_ICON[t];
          return (
            <p key={t} className="flex gap-2 text-xs">
              <span
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded ${NODE_META[t].tone}`}
              >
                <Icon className="size-3" />
              </span>
              <span>
                <strong>{NODE_META[t].label}:</strong>{" "}
                <span className="text-muted-foreground">{NODE_META[t].what}</span>
              </span>
            </p>
          );
        })}
      </div>
      <Link
        to="/help/$slug"
        params={{ slug: "fluxos" }}
        className="inline-block text-xs font-medium text-primary hover:underline"
      >
        Guia completo de fluxos →
      </Link>
    </aside>
  );
}

function SimulationPanel({
  graph,
  settings,
  result,
  onResult,
  onClose,
  templates,
}: {
  graph: Graph;
  settings: FlowSettings;
  result: Obj | null;
  onResult: (r: Obj | null) => void;
  onClose: () => void;
  templates: Map<string, TemplateLite>;
}) {
  const [q, setQ] = useState("");
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const waitFacts = [
    ...new Set(
      graph.nodes.filter((n) => n.type === "wait_event").map((n) => String(n.config["fact"])),
    ),
  ];
  const { data: found } = useCrm<Obj[]>(
    "crm_search_customers",
    { p_query: q.trim() || null, p_limit: 6 },
    { enabled: q.trim().length >= 2 && !customer },
  );

  const run = async (id: string, ev: string[]) => {
    setRunning(true);
    try {
      onResult(
        await crmCall<Obj>("crm_simulate_flow", {
          p_customer_id: id,
          p_graph: graph,
          p_entry_rule: settings.entry_rule,
          p_events: ev,
        }),
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    if (customer) void run(customer.id, events);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when inputs or the draft change
  }, [customer, events, graph, settings.entry_rule]);

  const when = (m: number) =>
    m === 0
      ? "na hora"
      : m % 1440 === 0
        ? `após ${waitText(m / 1440, "days")}`
        : m % 60 === 0
          ? `após ${hoursText(m / 60)}`
          : `após ${waitText(m, "minutes")}`;

  return (
    <aside className="surface flex max-h-[calc(100vh-200px)] flex-col overflow-hidden">
      <div className="flex items-start justify-between border-b border-border p-4">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            <FlaskConical className="size-4 text-primary" /> Simular
          </p>
          <p className="text-xs text-muted-foreground">
            O caminho de um cliente real com os dados de agora. Nada é enviado.
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={onClose}
          aria-label="Fechar"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {customer ? (
          <div className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-sm">
            <span className="font-medium">{customer.name}</span>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => {
                setCustomer(null);
                onResult(null);
              }}
            >
              trocar
            </button>
          </div>
        ) : (
          <div>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar cliente (nome, e-mail, telefone)…"
            />
            <div className="mt-1 space-y-0.5">
              {(found ?? []).map((c) => (
                <button
                  key={c.customer_id}
                  type="button"
                  className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                  onClick={() =>
                    setCustomer({ id: c.customer_id, name: c.full_name ?? c.email ?? "cliente" })
                  }
                >
                  <span className="font-medium">{c.full_name ?? "—"}</span>{" "}
                  <span className="text-muted-foreground">{c.email}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {waitFacts.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-border p-3">
            <p className="text-xs font-medium">E se o cliente…</p>
            {waitFacts.map((f) => (
              <label key={f} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={events.includes(f)}
                  onCheckedChange={(v) =>
                    setEvents((e) => (v ? [...e, f] : e.filter((x) => x !== f)))
                  }
                />
                {label(FACT_LABEL, f)} durante a espera
              </label>
            ))}
          </div>
        )}
        {running && <p className="text-xs text-muted-foreground">Simulando…</p>}
        {result && (
          <ol className="space-y-2">
            {result.path.map((s: Obj, i: number) => {
              const n = graph.nodes.find((x) => x.id === s.node_id);
              const Icon = n ? NODE_ICON[n.type] : null;
              const t = s.template_key ? templates.get(s.template_key) : null;
              return (
                <li key={i} className="rounded-lg border border-border p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-medium">
                      {Icon && <Icon className="size-3.5 text-primary" />}
                      {n ? NODE_META[n.type].label : s.node_id}
                      {s.outcome !== "next" && s.outcome !== "entry_rule_not_met" && n && (
                        <Pill tone="primary">
                          {n.type === "split"
                            ? String(
                                ((n.config["branches"] as Obj[]) ?? []).find(
                                  (b) => b.key === s.outcome,
                                )?.label ?? s.outcome,
                              )
                            : (NODE_META[n.type].handles?.[s.outcome] ?? s.outcome)}
                        </Pill>
                      )}
                    </span>
                    <span className="text-muted-foreground">{when(Number(s.after_minutes))}</span>
                  </div>
                  {s.outcome === "entry_rule_not_met" && (
                    <p className="mt-1 text-danger">
                      Não atende à regra de entrada: não entraria no fluxo.
                    </p>
                  )}
                  {t && result.customer && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-primary">
                        Ver {CHANNEL_LABEL[t.channel]}: {t.name}
                      </summary>
                      <div className="mt-2 origin-top scale-[0.85]">
                        <Simulator channel={t.channel} content={t.content} vars={result.customer} />
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
            <li className="text-center text-xs text-muted-foreground">
              {result.result === "EXITED" ? "Fim (não entra)" : "Fim do caminho"}
            </li>
          </ol>
        )}
      </div>
    </aside>
  );
}

const ENROLL_STATUS: Record<string, string> = {
  ACTIVE: "Em andamento",
  WAITING: "Aguardando evento",
  COMPLETED: "Concluiu",
  GOAL: "Meta atingida",
  EXITED: "Saiu",
  FAILED: "Erro",
};
const EXIT_REASON: Record<string, string> = {
  entry_rule_not_met: "não atendia à regra de entrada",
  exit_step: "etapa “Sair”",
  flow_archived: "fluxo arquivado",
};

function People({ s }: { s: Obj | undefined }) {
  if (!s) return <Loading />;
  if (!s.recent?.length) return <Empty>Ninguém entrou ainda.</Empty>;
  return (
    <div className="surface overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Cliente</TableHead>
            <TableHead>Situação</TableHead>
            <TableHead>Entrou</TableHead>
            <TableHead>Próximo passo / fim</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.recent.map((r: Obj) => (
            <TableRow key={r.enrollment_id}>
              <TableCell>
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: r.customer_id }}
                  className="font-medium hover:text-primary"
                >
                  {r.full_name ?? "—"}
                </Link>
              </TableCell>
              <TableCell>
                <Pill
                  tone={
                    r.status === "GOAL"
                      ? "success"
                      : r.status === "FAILED"
                        ? "danger"
                        : r.status === "EXITED"
                          ? "muted"
                          : "primary"
                  }
                >
                  {ENROLL_STATUS[r.status] ?? r.status}
                </Pill>
                {r.exit_reason && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {EXIT_REASON[r.exit_reason] ?? r.exit_reason}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{dateTime(r.entered_at)}</TableCell>
              <TableCell className="text-muted-foreground">
                {r.finished_at
                  ? dateTime(r.finished_at)
                  : r.next_run_at
                    ? `${r.current_node ?? "fim"} · ${dateTime(r.next_run_at)}`
                    : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export const MESSAGE_STATUS: Record<
  string,
  { label: string; tone: "success" | "primary" | "warning" | "danger" | "muted" }
> = {
  QUEUED: { label: "Na fila", tone: "muted" },
  PROCESSING: { label: "Enviando", tone: "muted" },
  SENT: { label: "Enviada", tone: "success" },
  DRY_RUN: { label: "Simulação", tone: "primary" },
  SKIPPED: { label: "Não enviada", tone: "warning" },
  FAILED: { label: "Falhou", tone: "danger" },
};
export const SKIP_REASON: Record<string, string> = {
  opt_out: "cliente pediu para não receber",
  daily_cap: "limite diário de mensagens",
  no_contact_for_email: "sem e-mail",
  no_contact_for_sms: "sem telefone",
  no_contact_for_whatsapp: "sem WhatsApp",
  no_contact_for_rcs: "sem telefone",
  template_missing: "mensagem não existe mais",
};

function SentMessages({ flowKey }: { flowKey: string }) {
  const { data, isLoading, error } = useCrm<Obj[]>("crm_list_messages", {
    p_flow_key: flowKey,
    p_limit: 200,
  });
  if (error) return <ApiErrorBox error={error} />;
  if (isLoading) return <Loading />;
  if (!data?.length) return <Empty>Nenhuma mensagem ainda.</Empty>;
  return (
    <div className="surface overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quando</TableHead>
            <TableHead>Cliente</TableHead>
            <TableHead>Canal</TableHead>
            <TableHead>Situação</TableHead>
            <TableHead>Conteúdo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((m) => (
            <TableRow key={m.message_id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {dateTime(m.at)}
              </TableCell>
              <TableCell>
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: m.customer_id }}
                  className="hover:text-primary"
                >
                  {m.full_name ?? "—"}
                </Link>
              </TableCell>
              <TableCell>
                {CHANNEL_LABEL[m.channel as keyof typeof CHANNEL_LABEL] ?? m.channel}
              </TableCell>
              <TableCell>
                <Pill tone={MESSAGE_STATUS[m.status]?.tone ?? "muted"}>
                  {MESSAGE_STATUS[m.status]?.label ?? m.status}
                </Pill>
                {m.skip_reason && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {SKIP_REASON[m.skip_reason] ?? m.skip_reason}
                  </span>
                )}
              </TableCell>
              <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                {m.rendered?.subject ??
                  m.rendered?.text ??
                  m.rendered?.body ??
                  m.rendered?.cards?.[0]?.title ??
                  "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
