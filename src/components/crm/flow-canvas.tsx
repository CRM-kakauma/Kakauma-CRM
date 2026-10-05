import { useRef, useState, type ReactNode } from "react";
import {
  Bell,
  CircleAlert,
  Clock,
  FlaskConical,
  GitBranch,
  Hourglass,
  LogOut,
  Maximize2,
  Minus,
  Plus,
  Send,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ADDABLE,
  NODE_META,
  child,
  handleLabel,
  handlesOf,
  type FlowNode,
  type Graph,
  type NodeType,
} from "@/lib/crm-flows";
import { cn } from "@/lib/utils";

export const NODE_ICON: Record<NodeType, typeof Zap> = {
  trigger: Zap,
  send: Send,
  wait: Clock,
  wait_event: Hourglass,
  condition: GitBranch,
  split: FlaskConical,
  alert_team: Bell,
  exit: LogOut,
};

export interface NodeStats {
  passed?: number;
  here?: number;
  outcomes?: Record<string, number>;
  /** A/B paths: goal rate of finished enrollments per path */
  goalRate?: Record<string, number | null>;
}

interface CanvasProps {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string) => void;
  onInsert?: ((parent: string, handle: string, type: NodeType) => void) | undefined;
  describe: (n: FlowNode) => string;
  problem: (n: FlowNode) => string | null;
  stats?: Record<string, NodeStats> | undefined;
  /** simulation: nodes and "id:handle" outputs the customer goes through */
  path?: { nodes: Set<string>; outs: Set<string> } | null;
}

export function FlowCanvas(props: CanvasProps) {
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const root = props.graph.nodes.find((n) => n.type === "trigger");

  return (
    <div className="relative">
      <div
        ref={box}
        className="flow-canvas h-[calc(100vh-260px)] min-h-[520px] cursor-grab overflow-auto rounded-xl border border-border active:cursor-grabbing"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("[data-node],button,[role=menu]")) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: box.current!.scrollLeft,
            top: box.current!.scrollTop,
          };
        }}
        onMouseMove={(e) => {
          if (!drag.current || !box.current) return;
          box.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
          box.current.scrollTop = drag.current.top - (e.clientY - drag.current.y);
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        <div className="flex w-max min-w-full justify-center p-10" style={{ zoom }}>
          {root ? <Branch id={root.id} p={props} depth={0} seen={new Set()} /> : null}
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))}
          aria-label="Diminuir"
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="w-10 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => setZoom((z) => Math.min(1.3, +(z + 0.1).toFixed(1)))}
          aria-label="Aumentar"
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => setZoom(1)}
          aria-label="Tamanho normal"
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function Branch({
  id,
  p,
  depth,
  seen,
}: {
  id: string;
  p: CanvasProps;
  depth: number;
  seen: Set<string>;
}) {
  const n = p.graph.nodes.find((x) => x.id === id);
  if (!n || seen.has(id) || depth > 60) return null; // guards against hand-edited cyclic graphs
  const next = new Set(seen).add(id);
  const handles = handlesOf(n);
  const onPath = (h: string) => p.path?.outs.has(`${n.id}:${h}`) ?? false;

  return (
    <div className="flex flex-col items-center">
      <NodeCard n={n} p={p} />
      {handles.length === 1 ? (
        <Continue
          parent={n.id}
          handle={handles[0]!}
          p={p}
          depth={depth}
          seen={next}
          active={onPath(handles[0]!)}
        />
      ) : handles.length > 1 ? (
        <>
          <Stem active={handles.some(onPath)} />
          <div className="flow-branches">
            {handles.map((h) => (
              <div key={h} className="flow-branch">
                <Stem h={14} active={onPath(h)} />
                <span
                  className={cn(
                    "rounded-full border bg-card px-2.5 py-0.5 text-[11px] font-medium shadow-sm",
                    onPath(h)
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {handleLabel(n, h)}
                  {p.stats?.[n.id]?.outcomes?.[h] != null && (
                    <span className="ml-1 tabular-nums text-foreground">
                      · {p.stats[n.id]!.outcomes![h]}
                    </span>
                  )}
                  {p.stats?.[n.id]?.goalRate?.[h] != null && (
                    <span className="ml-1 tabular-nums text-success">
                      · meta {p.stats[n.id]!.goalRate![h]}%
                    </span>
                  )}
                </span>
                <Continue
                  parent={n.id}
                  handle={h}
                  p={p}
                  depth={depth}
                  seen={next}
                  active={onPath(h)}
                />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Continue({
  parent,
  handle,
  p,
  depth,
  seen,
  active,
}: {
  parent: string;
  handle: string;
  p: CanvasProps;
  depth: number;
  seen: Set<string>;
  active: boolean;
}) {
  const target = child(p.graph, parent, handle);
  return (
    <>
      <Stem h={14} active={active} />
      {p.onInsert ? <AddButton onPick={(t) => p.onInsert!(parent, handle, t)} /> : null}
      <Stem h={14} active={active} />
      {target ? (
        <Branch id={target} p={p} depth={depth + 1} seen={seen} />
      ) : (
        <span className="rounded-full border border-dashed border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
          Fim
        </span>
      )}
    </>
  );
}

function Stem({ h = 20, active }: { h?: number; active?: boolean }) {
  return <div className={cn("flow-stem", active && "!bg-primary")} style={{ height: h }} />;
}

function AddButton({ onPick }: { onPick: (t: NodeType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary"
          aria-label="Adicionar etapa aqui"
        >
          <Plus className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72" align="center">
        <DropdownMenuLabel className="text-xs">Adicionar etapa</DropdownMenuLabel>
        {ADDABLE.map((t) => {
          const Icon = NODE_ICON[t];
          return (
            <DropdownMenuItem
              key={t}
              onSelect={() => onPick(t)}
              className="items-start gap-2.5 py-2"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md",
                  NODE_META[t].tone,
                )}
              >
                <Icon className="size-3.5" />
              </span>
              <span>
                <span className="block text-sm font-medium">{NODE_META[t].label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  {NODE_META[t].what}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NodeCard({ n, p }: { n: FlowNode; p: CanvasProps }) {
  const Icon = NODE_ICON[n.type];
  const meta = NODE_META[n.type];
  const problem = p.problem(n);
  const s = p.stats?.[n.id];
  const sel = p.selected === n.id;
  const dim = p.path && !p.path.nodes.has(n.id);
  return (
    <button
      type="button"
      data-node
      onClick={() => p.onSelect(n.id)}
      className={cn(
        "w-[260px] rounded-xl border bg-card p-3 text-left shadow-sm transition-all hover:shadow-md",
        sel
          ? "border-primary ring-2 ring-primary/25"
          : problem
            ? "border-danger/60"
            : "border-border",
        dim && "opacity-40",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", meta.tone)}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {meta.label}
          </p>
          <p className="line-clamp-2 text-sm font-medium leading-snug">{p.describe(n)}</p>
        </div>
      </div>
      {problem && (
        <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-danger">
          <CircleAlert className="size-3" /> {problem}
        </p>
      )}
      {s && (s.passed || s.here) ? (
        <div className="mt-2 flex gap-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
          <Stat icon={<Users className="size-3" />} label="passaram" v={s.passed ?? 0} />
          {s.here ? (
            <Stat icon={<Hourglass className="size-3" />} label="aqui agora" v={s.here} strong />
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function Stat({
  icon,
  label,
  v,
  strong,
}: {
  icon: ReactNode;
  label: string;
  v: number;
  strong?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-1", strong && "font-medium text-primary")}>
      {icon}
      <span className="tabular-nums">{v.toLocaleString("pt-BR")}</span> {label}
    </span>
  );
}
