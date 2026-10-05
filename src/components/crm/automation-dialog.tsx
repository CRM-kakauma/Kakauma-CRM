import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RuleBuilder, type Rule } from "@/components/crm/rule-builder";
import { FACT_LABEL, LIFECYCLE_LABEL, RISK_LABEL, crmCall, label, useCrm } from "@/lib/crm-api";
import { renderTemplate } from "@/lib/crm-template";

export interface EditableAutomation {
  key: string;
  name: string;
  description: string | null;
  trigger_fact: string;
  trigger_filter: Record<string, unknown>;
  conditions: Rule;
  action_type: "message" | "internal_alert";
  action_config: { channel?: string; template?: string; message?: string };
  delay_minutes: number;
  cooldown_hours: number;
  max_trigger_age_hours: number;
  priority: number;
  active: boolean;
}

const SAMPLE_CUSTOMER = {
  first_name: "Maria",
  full_name: "Maria Souza",
  email: "maria@exemplo.com.br",
  net_ltv: 561,
  gross_ltv: 561,
  subscription_cycle: 3,
  lifecycle: "ACTIVE_SUBSCRIBER",
  risk: "AT_RISK",
  paid_orders: 3,
};

const VARIABLES = [
  "first_name",
  "full_name",
  "net_ltv",
  "subscription_cycle",
  "paid_orders",
  "lifecycle",
  "risk",
];

/** Trigger facts whose data can be filtered, and the editor for that filter. */
function TriggerFilter({
  fact,
  value,
  onChange,
}: {
  fact: string;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const { data: segments = [] } = useCrm<{ key: string; name: string }[]>("crm_list_segments");
  const pick = (k: string, options: { value: string; label: string }[], title: string) => (
    <div className="grid gap-1.5">
      <Label>{title}</Label>
      <Select
        value={String(value[k] ?? "any")}
        onValueChange={(v) => onChange(v === "any" ? {} : { [k]: v })}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">qualquer</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  const entries = (m: Record<string, string>) =>
    Object.entries(m).map(([v, l]) => ({ value: v, label: l }));
  if (fact === "PAYMENT_PENDING")
    return pick(
      "method",
      [
        { value: "pix", label: "PIX" },
        { value: "billet", label: "Boleto" },
      ],
      "Método",
    );
  if (fact === "RISK_CHANGED") return pick("to", entries(RISK_LABEL), "Quando o risco passar a");
  if (fact === "LIFECYCLE_CHANGED")
    return pick("to", entries(LIFECYCLE_LABEL), "Quando a etapa passar a");
  if (fact === "SEGMENT_ENTERED" || fact === "SEGMENT_EXITED") {
    return pick(
      "segment",
      segments.map((s) => ({ value: s.key, label: s.name })),
      "Segmento",
    );
  }
  return null;
}

export function AutomationDialog({
  automation,
  onClose,
}: {
  automation: EditableAutomation | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: facts = [] } = useCrm<string[]>("crm_trigger_facts");
  const [a, setA] = useState<EditableAutomation>(
    automation ?? {
      key: "",
      name: "",
      description: null,
      trigger_fact: "PURCHASE_PAID",
      trigger_filter: {},
      conditions: {},
      action_type: "message",
      action_config: { channel: "whatsapp", message: "Oi {{first_name}}, " },
      delay_minutes: 0,
      cooldown_hours: 24,
      max_trigger_age_hours: 72,
      priority: 100,
      active: true,
    },
  );
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof EditableAutomation>(k: K, v: EditableAutomation[K]) =>
    setA((x) => ({ ...x, [k]: v }));
  const channel = a.action_config.channel ?? "whatsapp";

  const save = useMutation({
    mutationFn: () =>
      crmCall("crm_upsert_automation", {
        p_key: a.key,
        p_name: a.name,
        p_description: a.description,
        p_trigger_fact: a.trigger_fact,
        p_trigger_filter: a.trigger_filter,
        p_conditions: a.conditions,
        p_action_type: channel === "team" ? "internal_alert" : "message",
        p_action_config: {
          ...a.action_config,
          channel,
          template: a.action_config.template ?? a.key,
        },
        p_delay_minutes: a.delay_minutes,
        p_cooldown_hours: a.cooldown_hours,
        p_max_trigger_age_hours: a.max_trigger_age_hours,
        p_priority: a.priority,
        p_active: a.active,
      }),
    onSuccess: () => {
      toast.success("Automação salva", {
        description: "Vale para os próximos fatos que acontecerem.",
      });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });

  const num = (
    k: "delay_minutes" | "cooldown_hours" | "max_trigger_age_hours" | "priority",
    title: string,
    hint: string,
  ) => (
    <div className="grid gap-1.5">
      <Label>{title}</Label>
      <Input
        type="number"
        min={0}
        value={a[k]}
        onChange={(e) => set(k, Math.max(0, Number(e.target.value) || 0))}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{automation ? "Editar automação" : "Nova automação"}</DialogTitle>
          <DialogDescription>
            Quando o fato acontecer e o cliente atender às condições (conferidas de novo na hora do
            envio), a ação é executada.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Nome</Label>
            <Input
              value={a.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Boas-vindas para alto valor"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Chave</Label>
            <Input
              value={a.key}
              disabled={!!automation}
              onChange={(e) => set("key", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="boas_vindas_vip"
            />
          </div>
        </div>

        <section className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm font-semibold">1. Quando</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Fato</Label>
              <Select
                value={a.trigger_fact}
                onValueChange={(v) => setA((x) => ({ ...x, trigger_fact: v, trigger_filter: {} }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {facts.map((f) => (
                    <SelectItem key={f} value={f}>
                      {label(FACT_LABEL, f)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TriggerFilter
              fact={a.trigger_fact}
              value={a.trigger_filter}
              onChange={(v) => set("trigger_filter", v)}
            />
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm font-semibold">2. Para quem (condições)</p>
          <RuleBuilder
            value={a.conditions}
            onChange={(r) => set("conditions", r)}
            emptyMeans="qualquer cliente que tiver o fato"
          />
        </section>

        <section className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm font-semibold">3. Ação</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Canal</Label>
              <Select
                value={channel}
                onValueChange={(v) => set("action_config", { ...a.action_config, channel: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="whatsapp">WhatsApp do cliente</SelectItem>
                  <SelectItem value="email">E-mail do cliente</SelectItem>
                  <SelectItem value="team">Alerta para a equipe</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {num("delay_minutes", "Esperar (min)", "antes de executar")}
            {num("cooldown_hours", "Intervalo mínimo (h)", "entre envios ao mesmo cliente")}
          </div>
          <div className="grid gap-1.5">
            <Label>Mensagem</Label>
            <Textarea
              rows={4}
              value={a.action_config.message ?? ""}
              onChange={(e) =>
                set("action_config", { ...a.action_config, message: e.target.value })
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Variáveis: {VARIABLES.map((v) => `{{${v}}}`).join(" ")}
            </p>
          </div>
          <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
            <span className="font-medium">Prévia: </span>
            {renderTemplate(a.action_config.message ?? "", SAMPLE_CUSTOMER) || "—"}
          </div>
        </section>

        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer text-sm font-semibold">Avançado</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {num(
              "max_trigger_age_hours",
              "Idade máxima do fato (h)",
              "fatos mais antigos não disparam (ex.: importação)",
            )}
            {num("priority", "Prioridade", "menor = processada antes")}
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={a.active} onCheckedChange={(v) => set("active", v)} id="active" />
              <Label htmlFor="active">Ativa</Label>
            </div>
          </div>
        </details>

        {err && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!a.name || !a.key || save.isPending}
            onClick={() => {
              setErr(null);
              save.mutate();
            }}
          >
            {save.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
