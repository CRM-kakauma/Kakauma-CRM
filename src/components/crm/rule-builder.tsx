import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { crmCall, useCrm } from "@/lib/crm-api";

/**
 * Visual editor for the CRM rule language (segments and automation conditions).
 * Edits a flat list of conditions joined by "all" (E) or "any" (OU); anything
 * more complex (nested groups, "not") falls back to the JSON editor.
 */

export type Rule = Record<string, unknown>;
interface Cond {
  field: string;
  op: string;
  value: string;
}

export const FIELD_LABEL: Record<string, string> = {
  customer_type: "Tipo de cliente",
  lifecycle: "Etapa do ciclo de vida",
  risk: "Risco",
  net_ltv: "LTV líquido (R$)",
  gross_ltv: "LTV bruto (R$)",
  contribution_ltv: "LTV de contribuição (R$)",
  profit_ltv: "Lucro do cliente (R$)",
  paid_orders: "Pedidos pagos",
  paid_orders_90d: "Pedidos pagos em 90 dias",
  days_since_last_purchase: "Dias desde a última compra",
  days_since_first_seen: "Dias desde o primeiro contato",
  value_tier: "Faixa de valor (high/medium/low)",
  acquisition_source: "Origem de aquisição",
  acquisition_medium: "Mídia de aquisição",
  acquisition_campaign: "Campanha de aquisição",
  acquisition_creative: "Criativo de aquisição",
  acquisition_funnel: "Funil de aquisição",
  has_affiliate: "Veio de afiliado",
  state: "UF",
  has_active_subscription: "Tem assinatura ativa",
  subscription_status: "Status da assinatura",
  subscription_payment_state: "Pagamento da assinatura",
  subscription_lifecycle: "Etapa da assinatura",
  subscription_cycle: "Ciclo da assinatura",
  subscription_quality_class: "Qualidade do assinante",
  subscription_quality_score: "Score de qualidade (0–100)",
  cancellation_requested: "Pediu cancelamento",
  product_ids: "Produtos comprados (ids)",
  offer_ids: "Ofertas compradas (ids)",
  refunds: "Reembolsos",
  delivery_problems: "Problemas de entrega",
  cx_score: "CX score (0–100)",
  has_email: "Tem e-mail",
  has_whatsapp: "Tem WhatsApp",
};

const OPS: { value: string; label: string; needsValue: boolean }[] = [
  { value: "=", label: "é igual a", needsValue: true },
  { value: "!=", label: "é diferente de", needsValue: true },
  { value: ">", label: "maior que", needsValue: true },
  { value: ">=", label: "maior ou igual a", needsValue: true },
  { value: "<", label: "menor que", needsValue: true },
  { value: "<=", label: "menor ou igual a", needsValue: true },
  { value: "in", label: "é um de (vírgulas)", needsValue: true },
  { value: "not_in", label: "não é nenhum de", needsValue: true },
  { value: "contains", label: "contém", needsValue: true },
  { value: "is_true", label: "é verdadeiro", needsValue: false },
  { value: "is_false", label: "é falso", needsValue: false },
  { value: "is_null", label: "está vazio", needsValue: false },
  { value: "is_not_null", label: "não está vazio", needsValue: false },
];

function parseValue(op: string, raw: string): unknown {
  if (op === "in" || op === "not_in") {
    return raw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
  }
  if (/^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
  return raw.trim();
}

function toRule(join: "all" | "any", conds: Cond[]): Rule {
  const items = conds
    .filter((c) => c.field)
    .map((c) => {
      const op = OPS.find((o) => o.value === c.op);
      return op?.needsValue
        ? { field: c.field, op: c.op, value: parseValue(c.op, c.value) }
        : { field: c.field, op: c.op };
    });
  if (!items.length) return {};
  return items.length === 1 ? items[0]! : { [join]: items };
}

/** Flat rules → editable rows; null when the rule needs the JSON editor. */
function fromRule(rule: Rule): { join: "all" | "any"; conds: Cond[] } | null {
  const one = (r: Rule): Cond | null =>
    typeof r["field"] === "string"
      ? {
          field: r["field"],
          op: String(r["op"] ?? "="),
          value: Array.isArray(r["value"])
            ? r["value"].join(", ")
            : r["value"] == null
              ? ""
              : String(r["value"]),
        }
      : null;
  if (!rule || Object.keys(rule).length === 0) return { join: "all", conds: [] };
  if ("field" in rule) {
    const c = one(rule);
    return c ? { join: "all", conds: [c] } : null;
  }
  for (const join of ["all", "any"] as const) {
    if (Array.isArray(rule[join])) {
      const conds = (rule[join] as Rule[]).map(one);
      return conds.every(Boolean) ? { join, conds: conds as Cond[] } : null;
    }
  }
  return null;
}

export function RuleBuilder({
  value,
  onChange,
  emptyMeans = "todos os clientes",
}: {
  value: Rule;
  onChange: (r: Rule) => void;
  emptyMeans?: string;
}) {
  const { data: fields = [] } = useCrm<string[]>("crm_rule_fields");
  const parsed = useMemo(() => fromRule(value), [value]);
  const [mode, setMode] = useState<"visual" | "json">(parsed ? "visual" : "json");
  const [json, setJson] = useState(JSON.stringify(value, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    { matches: number; total: number } | { error: string } | null
  >(null);

  // Rows live in local state (a new, still empty row is not part of the rule yet).
  const [join, setJoin] = useState<"all" | "any">(parsed?.join ?? "all");
  const [conds, setConds] = useState<Cond[]>(parsed?.conds ?? []);
  const setRows = (j: "all" | "any", c: Cond[]) => {
    setJoin(j);
    setConds(c);
    onChange(toRule(j, c));
  };

  // Live preview: how many customers match now.
  useEffect(() => {
    const t = setTimeout(() => {
      crmCall<{ matches: number; total: number }>("crm_preview_rule", { p_rule: value, p_limit: 0 })
        .then(setPreview)
        .catch((e: Error) => setPreview({ error: e.message }));
    }, 400);
    return () => clearTimeout(t);
  }, [value]);

  const fieldOptions = fields.filter((f) => f !== "customer_id");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {mode === "visual" ? (
          <div className="flex items-center gap-2 text-sm">
            <span>Clientes que atendem a</span>
            <Select value={join} onValueChange={(v) => setRows(v as "all" | "any", conds)}>
              <SelectTrigger className="h-8 w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">todas as condições (E)</SelectItem>
                <SelectItem value="any">qualquer condição (OU)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : (
          <span className="text-sm">Regra em JSON</span>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (mode === "visual") {
              setJson(JSON.stringify(value, null, 2));
              setMode("json");
            } else if (fromRule(value)) {
              const back = fromRule(value)!;
              setJoin(back.join);
              setConds(back.conds);
              setMode("visual");
            } else {
              setJsonError("Esta regra tem grupos aninhados ou 'not': edite em JSON.");
            }
          }}
        >
          {mode === "visual" ? "Editar como JSON" : "Editor visual"}
        </Button>
      </div>

      {mode === "visual" ? (
        <div className="space-y-2">
          {conds.map((c, i) => {
            const op = OPS.find((o) => o.value === c.op);
            const update = (patch: Partial<Cond>) =>
              setRows(
                join,
                conds.map((x, j) => (j === i ? { ...x, ...patch } : x)),
              );
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1.2fr_auto]">
                <Select value={c.field} onValueChange={(v) => update({ field: v })}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Campo" />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldOptions.map((f) => (
                      <SelectItem key={f} value={f}>
                        {FIELD_LABEL[f] ?? f}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={c.op} onValueChange={(v) => update({ op: v })}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {op?.needsValue ? (
                  <Input
                    className="h-9"
                    value={c.value}
                    onChange={(e) => update({ value: e.target.value })}
                    placeholder="valor"
                  />
                ) : (
                  <span />
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-9"
                  aria-label="Remover condição"
                  onClick={() =>
                    setRows(
                      join,
                      conds.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}
          {!conds.length && (
            <p className="text-sm text-muted-foreground">Sem condições: vale para {emptyMeans}.</p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRows(join, [...conds, { field: "", op: "=", value: "" }])}
          >
            <Plus className="size-4" /> Condição
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <Textarea
            rows={8}
            value={json}
            spellCheck={false}
            className="font-mono text-xs"
            onChange={(e) => {
              setJson(e.target.value);
              try {
                onChange(JSON.parse(e.target.value) as Rule);
                setJsonError(null);
              } catch {
                setJsonError("JSON inválido");
              }
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            <code>all</code> / <code>any</code> / <code>not</code> com{" "}
            <code>{"{field, op, value}"}</code>. Campos: {fieldOptions.join(", ")}
          </p>
        </div>
      )}
      {jsonError && <p className="text-xs text-danger">{jsonError}</p>}
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
        {preview === null ? (
          "Calculando…"
        ) : "error" in preview ? (
          <span className="text-danger">{preview.error}</span>
        ) : (
          <>
            Agora: <strong className="num">{preview.matches.toLocaleString("pt-BR")}</strong> de{" "}
            {preview.total.toLocaleString("pt-BR")} clientes atendem a esta regra.
          </>
        )}
      </p>
    </div>
  );
}
