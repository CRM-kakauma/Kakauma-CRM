import { Link } from "@tanstack/react-router";
import { ExternalLink, Info, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RuleBuilder, type Rule } from "@/components/crm/rule-builder";
import { TriggerFilter } from "@/components/crm/automation-dialog";
import { NODE_ICON } from "@/components/crm/flow-canvas";
import { FACT_LABEL, label, useCrm } from "@/lib/crm-api";
import { NODE_META, type FlowNode, type SplitBranch } from "@/lib/crm-flows";
import { CHANNEL_LABEL, VARIABLES, summary, type Channel, type Content } from "@/lib/crm-messages";
import { cn } from "@/lib/utils";

export interface FlowSettings {
  key: string;
  name: string;
  description: string | null;
  trigger_fact: string;
  trigger_filter: Record<string, unknown>;
  entry_rule: Rule;
  reentry: "once" | "after_exit";
  max_trigger_age_hours: number;
  goal_fact: string | null;
}

export interface TemplateLite {
  key: string;
  name: string;
  channel: Channel;
  purpose: string;
  content: Content;
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{title}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

function FactSelect({
  value,
  onChange,
  none,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  none?: string;
}) {
  const { data: facts = [] } = useCrm<string[]>("crm_trigger_facts");
  return (
    <Select value={value ?? "__none"} onValueChange={(v) => onChange(v === "__none" ? null : v)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {none && <SelectItem value="__none">{none}</SelectItem>}
        {facts.map((f) => (
          <SelectItem key={f} value={f}>
            {label(FACT_LABEL, f)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FlowPanel({
  node,
  settings,
  templates,
  readOnly,
  removalCost,
  onConfig,
  onSettings,
  onDelete,
  onClose,
}: {
  node: FlowNode;
  settings: FlowSettings;
  templates: TemplateLite[];
  readOnly: boolean;
  removalCost: number;
  onConfig: (c: Record<string, unknown>) => void;
  onSettings: (patch: Partial<FlowSettings>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const meta = NODE_META[node.type];
  const Icon = NODE_ICON[node.type];
  const c = node.config;
  const set = (patch: Record<string, unknown>) => onConfig({ ...c, ...patch });

  return (
    <aside className="surface flex max-h-[calc(100vh-200px)] flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2.5">
          <span className={cn("flex size-8 items-center justify-center rounded-lg", meta.tone)}>
            <Icon className="size-4" />
          </span>
          <div>
            <p className="font-semibold">{meta.label}</p>
            <p className="font-mono text-[10px] text-muted-foreground">{node.id}</p>
          </div>
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

      <fieldset disabled={readOnly} className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">
          <p className="flex gap-1.5">
            <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span>
              {meta.what} <span className="text-muted-foreground">{meta.when}</span>
            </span>
          </p>
        </div>

        {node.type === "trigger" && (
          <>
            <Row title="Gatilho" hint="O fato que coloca o cliente neste fluxo.">
              <FactSelect
                value={settings.trigger_fact}
                onChange={(v) => v && onSettings({ trigger_fact: v, trigger_filter: {} })}
              />
            </Row>
            <TriggerFilter
              fact={settings.trigger_fact}
              value={settings.trigger_filter}
              onChange={(v) => onSettings({ trigger_filter: v })}
            />
            <Row
              title="Quem pode entrar"
              hint="Conferido no estado do cliente quando ele entra. Vazio = todos."
            >
              <RuleBuilder
                value={settings.entry_rule}
                onChange={(r) => onSettings({ entry_rule: r })}
                emptyMeans="todo cliente que tiver o fato"
              />
            </Row>
            <Row
              title="Meta (conversão)"
              hint="Quando o cliente fizer isto, sai do fluxo como “meta atingida” — mede a conversão e para os próximos envios."
            >
              <FactSelect
                value={settings.goal_fact}
                onChange={(v) => onSettings({ goal_fact: v })}
                none="Sem meta"
              />
            </Row>
            <Row title="Pode entrar de novo?">
              <Select
                value={settings.reentry}
                onValueChange={(v) => onSettings({ reentry: v as FlowSettings["reentry"] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="after_exit">Sim, depois de terminar o anterior</SelectItem>
                  <SelectItem value="once">Não, só uma vez na vida</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row
              title="Ignorar fatos mais antigos que (horas)"
              hint="Evita que importações de histórico disparem mensagens."
            >
              <Input
                type="number"
                min={1}
                value={settings.max_trigger_age_hours}
                onChange={(e) =>
                  onSettings({ max_trigger_age_hours: Math.max(1, Number(e.target.value) || 1) })
                }
              />
            </Row>
          </>
        )}

        {node.type === "send" && <SendConfig c={c} set={set} templates={templates} />}

        {node.type === "wait" && (
          <div className="grid grid-cols-2 gap-2">
            <Row title="Quanto tempo">
              <Input
                type="number"
                min={1}
                value={Number(c["amount"] ?? 1)}
                onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Row>
            <Row title="Unidade">
              <Select value={String(c["unit"] ?? "days")} onValueChange={(v) => set({ unit: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutos</SelectItem>
                  <SelectItem value="hours">horas</SelectItem>
                  <SelectItem value="days">dias</SelectItem>
                </SelectContent>
              </Select>
            </Row>
          </div>
        )}

        {node.type === "wait_event" && (
          <>
            <Row title="Esperar que o cliente…">
              <FactSelect value={String(c["fact"] ?? "")} onChange={(v) => v && set({ fact: v })} />
            </Row>
            <Row
              title="Prazo (horas)"
              hint={`${Math.round((Number(c["timeout_hours"] ?? 0) / 24) * 10) / 10} dia(s). Depois disso segue por “Não aconteceu”.`}
            >
              <Input
                type="number"
                min={1}
                max={2160}
                value={Number(c["timeout_hours"] ?? 48)}
                onChange={(e) =>
                  set({ timeout_hours: Math.min(2160, Math.max(1, Number(e.target.value) || 1)) })
                }
              />
            </Row>
          </>
        )}

        {node.type === "condition" && (
          <Row
            title="Regra"
            hint="Avaliada no momento em que o cliente chega aqui. Atende → “Sim”; não atende → “Não”."
          >
            <RuleBuilder
              key={node.id}
              value={(c["rule"] as Rule) ?? {}}
              onChange={(r) => set({ rule: r })}
              emptyMeans="ninguém (defina a regra)"
            />
          </Row>
        )}

        {node.type === "split" && <SplitConfig c={c} set={set} />}

        {node.type === "alert_team" && (
          <Row
            title="Mensagem para a equipe"
            hint={`Variáveis: ${VARIABLES.slice(0, 6)
              .map((v) => `{{${v.key}}}`)
              .join(" ")}`}
          >
            <Textarea
              rows={4}
              value={String(c["message"] ?? "")}
              onChange={(e) => set({ message: e.target.value })}
            />
          </Row>
        )}
      </fieldset>

      {node.type !== "trigger" && !readOnly && (
        <div className="border-t border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-danger hover:text-danger"
            onClick={() => {
              if (
                removalCost > 0 &&
                !confirm(
                  `Remover esta etapa e ${removalCost} etapa(s) nos outros caminhos abaixo dela?`,
                )
              )
                return;
              onDelete();
            }}
          >
            <Trash2 className="size-4" /> Remover etapa
          </Button>
        </div>
      )}
    </aside>
  );
}

function SendConfig({
  c,
  set,
  templates,
}: {
  c: Record<string, unknown>;
  set: (p: Record<string, unknown>) => void;
  templates: TemplateLite[];
}) {
  const current = templates.find((t) => t.key === c["template_key"]);
  const channel = (c["channel_filter"] as Channel | undefined) ?? current?.channel ?? "all";
  const list = templates.filter((t) => channel === "all" || t.channel === channel);
  return (
    <>
      <Row title="Canal">
        <Select
          value={channel}
          onValueChange={(v) => set({ channel_filter: v === "all" ? undefined : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {(["email", "sms", "whatsapp", "rcs"] as const).map((ch) => (
              <SelectItem key={ch} value={ch}>
                {CHANNEL_LABEL[ch]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row title="Mensagem">
        <Select
          value={String(c["template_key"] || "__none")}
          onValueChange={(v) => set({ template_key: v === "__none" ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Escolha…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none">Escolha…</SelectItem>
            {list.map((t) => (
              <SelectItem key={t.key} value={t.key}>
                {CHANNEL_LABEL[t.channel]} · {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {current ? (
        <div className="rounded-lg border border-border p-3 text-xs">
          <p className="mb-1 font-medium">
            {current.purpose === "transactional" ? "Transacional" : "Marketing"}
          </p>
          <p className="line-clamp-4 text-muted-foreground">
            {summary(current.channel, current.content)}
          </p>
          <Link
            to="/messages/$key"
            params={{ key: current.key }}
            target="_blank"
            className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
          >
            Abrir no editor <ExternalLink className="size-3" />
          </Link>
        </div>
      ) : null}
      <Link
        to="/messages/$key"
        params={{ key: "new" }}
        search={channel === "all" ? {} : { channel }}
        target="_blank"
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        <Plus className="size-3" /> Criar nova mensagem (abre em outra aba)
      </Link>
    </>
  );
}

function SplitConfig({
  c,
  set,
}: {
  c: Record<string, unknown>;
  set: (p: Record<string, unknown>) => void;
}) {
  const branches = (c["branches"] as SplitBranch[] | undefined) ?? [];
  const sum = branches.reduce((a, b) => a + (Number(b.percent) || 0), 0);
  const upd = (b: SplitBranch[]) => set({ branches: b });
  const keys = "abcd";
  return (
    <div className="space-y-2">
      {branches.map((b, i) => (
        <div key={b.key} className="grid grid-cols-[auto_1fr_80px_auto] items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{b.key.toUpperCase()}</span>
          <Input
            value={b.label}
            onChange={(e) =>
              upd(branches.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
            }
            placeholder="Nome do caminho"
          />
          <div className="relative">
            <Input
              type="number"
              min={0}
              max={100}
              value={b.percent}
              onChange={(e) =>
                upd(
                  branches.map((x, j) =>
                    j === i
                      ? { ...x, percent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) }
                      : x,
                  ),
                )
              }
              className="pr-6"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              %
            </span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={branches.length <= 2}
            onClick={() => upd(branches.filter((_, j) => j !== i))}
            aria-label="Remover caminho"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-xs",
            sum === 100 ? "text-muted-foreground" : "font-medium text-danger",
          )}
        >
          Total: {sum}%
        </span>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const each = Math.floor(100 / branches.length);
              upd(
                branches.map((b, i) => ({
                  ...b,
                  percent: i === 0 ? 100 - each * (branches.length - 1) : each,
                })),
              );
            }}
          >
            Dividir igual
          </Button>
          {branches.length < 4 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const key = [...keys].find((k) => !branches.some((b) => b.key === k))!;
                upd([...branches, { key, label: key.toUpperCase(), percent: 0 }]);
              }}
            >
              <Plus className="size-3.5" /> Caminho
            </Button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Dica: deixe um caminho sem nenhuma etapa como <strong>grupo de controle</strong> —
        comparando a meta entre os caminhos você vê o efeito real das mensagens.
      </p>
    </div>
  );
}
