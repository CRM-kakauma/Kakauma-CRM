import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, RotateCcw, Upload } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth, Section, Stat } from "@/components/crm/ui";
import { count, dateTime } from "@/lib/crm-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { crmCall, useCrm, type Me } from "@/lib/crm-api";

export const Route = createFileRoute("/operations")({
  head: () => ({ meta: [{ title: "Operação — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Operations me={me} />}</RequireAuth>,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- operational JSON */
type Ops = Record<string, any>;

const STATUS_PT: Record<string, string> = {
  PROCESSED: "Processados",
  IGNORED: "Ignorados (tipo sem tratamento)",
  RECEIVED: "Na fila",
  PROCESSING: "Processando",
  FAILED: "Com erro (vai tentar de novo)",
  DEAD_LETTER: "Fila de erros",
};

function Operations({ me }: { me: Me }) {
  const qc = useQueryClient();
  const ops = useCrm<Ops>("crm_ops_overview", {}, { refetchInterval: 15_000 });
  const isAdmin = me.role === "admin";
  const refresh = () => qc.invalidateQueries({ queryKey: ["crm"] });

  const requeue = useMutation({
    mutationFn: () => crmCall<number>("crm_requeue_dead_letters", {}),
    onSuccess: (n) => {
      toast.success(`${n} evento(s) devolvidos para a fila`, {
        description: "O worker (cron) reprocessa em seguida.",
      });
      void refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (ops.error) return <ApiErrorBox error={ops.error} />;
  if (ops.isLoading || !ops.data) return <Loading rows={5} />;
  const d = ops.data;
  const webhook =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/b4you`
      : "/api/webhooks/b4you";

  return (
    <>
      <PageHeader
        title="Operação"
        description="Saúde da ingestão de eventos, qualidade de dados e importações."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Eventos recebidos (24h)"
          value={count(d["events_24h"])}
          hint={`último: ${dateTime(d["last_event_at"])}`}
        />
        <Stat label="Clientes" value={count(d["totals"]["customers"])} />
        <Stat label="Pedidos" value={count(d["totals"]["orders"])} />
        <Stat
          label="Fila de erros"
          value={count(d["dead_letters_open"])}
          tone={Number(d["dead_letters_open"]) > 0 ? "danger" : undefined}
        />
      </div>

      <Section title="Eventos por status">
        <div className="flex flex-wrap gap-2">
          {Object.entries(d["events"]).map(([k, v]) => (
            <Pill
              key={k}
              tone={
                k === "DEAD_LETTER" || k === "FAILED"
                  ? "danger"
                  : k === "PROCESSED"
                    ? "success"
                    : "muted"
              }
            >
              {STATUS_PT[k] ?? k}: {count(v)}
            </Pill>
          ))}
          {!Object.keys(d["events"]).length && (
            <span className="text-sm text-muted-foreground">Nenhum evento ainda.</span>
          )}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Webhook da B4you: <code className="rounded bg-muted px-1.5 py-0.5">{webhook}</code> (com{" "}
          <code>?token=</code> se B4YOU_WEBHOOK_TOKEN estiver definido). Em localhost a B4you não
          alcança seu computador — use a importação do histórico abaixo.
        </p>
      </Section>

      {isAdmin && <ImportLegacy onDone={refresh} />}

      <Section
        title="Fila de erros"
        description="Eventos que não puderam ser processados. O payload original está guardado; dá para reprocessar depois de corrigir a causa."
        action={
          isAdmin && Number(d["dead_letters_open"]) > 0 ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => requeue.mutate()}
              disabled={requeue.isPending}
            >
              <RotateCcw className="size-4" /> Reprocessar todos
            </Button>
          ) : undefined
        }
      >
        {!d["dead_letters"].length ? (
          <Empty>Fila vazia.</Empty>
        ) : (
          <div className="space-y-2">
            {d["dead_letters"].map((x: Ops) => (
              <div key={x["id"]} className="surface p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{x["event_name"] ?? x["reason"]}</span>
                  <span className="text-xs text-muted-foreground">
                    {dateTime(x["created_at"])} · {x["event_id"] ?? "sem evento"}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-danger">{x["error"]}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Qualidade de dados"
        description="Inconsistências encontradas nos eventos (não bloqueiam o processamento)."
      >
        {!d["data_quality"].length ? (
          <Empty>Nenhum problema registrado.</Empty>
        ) : (
          <div className="flex flex-wrap gap-2">
            {d["data_quality"].map((q: Ops) => (
              <Pill key={q["code"]} tone="warning" title={`último: ${dateTime(q["last_at"])}`}>
                {q["code"]}: {count(q["count"])}
              </Pill>
            ))}
          </div>
        )}
      </Section>

      {isAdmin && <SpendImport rows={d["totals"]["marketing_spend_rows"]} onDone={refresh} />}
      <Settings isAdmin={isAdmin} />
    </>
  );
}

function ImportLegacy({ onDone }: { onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ read: number; counts: Record<string, number> } | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    const total = { read: 0, counts: {} as Record<string, number> };
    let offset = 0;
    try {
      for (;;) {
        const res = await fetch("/api/crm/admin/import-legacy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ offset }),
        });
        const body = (await res.json()) as {
          read: number;
          counts: Record<string, number>;
          next_offset: number;
          done: boolean;
          message?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
        total.read += body.read;
        for (const [k, v] of Object.entries(body.counts))
          total.counts[k] = (total.counts[k] ?? 0) + v;
        setProgress({ ...total, counts: { ...total.counts } });
        offset = body.next_offset;
        if (body.done) break;
      }
      toast.success("Histórico importado", {
        description: `${total.read} webhook(s) lidos do analytics antigo.`,
      });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Section
      title="Importar histórico do analytics antigo"
      description="Lê os webhooks da B4you já guardados no Supabase antigo (VITE_SUPABASE_* do .env) e processa no CRM. Pode rodar quantas vezes quiser: nada é duplicado e eventos antigos não disparam automações."
      action={
        <Button size="sm" onClick={run} disabled={running}>
          <Download className="size-4" /> {running ? "Importando…" : "Importar"}
        </Button>
      }
    >
      {progress && (
        <div className="surface flex flex-wrap gap-2 p-3 text-sm">
          <span>{count(progress.read)} lidos</span>
          {Object.entries(progress.counts).map(([k, v]) => (
            <Pill
              key={k}
              tone={k === "PROCESSED" ? "success" : k === "DEAD_LETTER" ? "danger" : "muted"}
            >
              {STATUS_PT[k] ?? k}: {count(v)}
            </Pill>
          ))}
        </div>
      )}
      {err && <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
    </Section>
  );
}

function SpendImport({ rows, onDone }: { rows: number; onDone: () => void }) {
  const [csv, setCsv] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const lines = csv.trim().split(/\r?\n/).filter(Boolean);
      const header =
        lines
          .shift()
          ?.split(/[;,]/)
          .map((h) => h.trim().toLowerCase()) ?? [];
      for (const h of ["date", "source", "spend"])
        if (!header.includes(h)) throw new Error(`Coluna obrigatória ausente: ${h}`);
      const out = lines.map((l, i) => {
        const cells = l.split(/[;,]/).map((c) => c.trim());
        const row = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ""]));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row["date"] ?? ""))
          throw new Error(`Linha ${i + 2}: data deve ser AAAA-MM-DD`);
        return {
          date: row["date"],
          source: row["source"],
          campaign: row["campaign"] ?? "",
          creative: row["creative"] ?? "",
          spend: Number(String(row["spend"]).replace(",", ".")),
          clicks: row["clicks"] ? Number(row["clicks"]) : null,
          impressions: row["impressions"] ? Number(row["impressions"]) : null,
        };
      });
      return crmCall<number>("crm_import_marketing_spend", { p_rows: out });
    },
    onSuccess: (n) => {
      toast.success(`${n} linha(s) de investimento importadas`);
      setCsv("");
      onDone();
    },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <Section
      title="Investimento em mídia"
      description={`Necessário para CAC e LTV/CAC (a B4you não envia custo). ${count(rows)} linha(s) importadas. Reenviar o mesmo dia/origem/campanha/criativo substitui o valor.`}
    >
      <Textarea
        rows={5}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder={
          "date,source,campaign,creative,spend,clicks,impressions\n2026-09-01,facebook,camp_x,criativo_y,150.00,320,12000"
        }
        className="font-mono text-xs"
      />
      {err && <p className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
      <Button
        size="sm"
        className="mt-2"
        disabled={!csv.trim() || save.isPending}
        onClick={() => {
          setErr(null);
          save.mutate();
        }}
      >
        <Upload className="size-4" /> Importar CSV
      </Button>
    </Section>
  );
}

const SETTING_PT: Record<string, string> = {
  activity_window_days: "Dias sem comprar até risco de churn",
  churn_after_days: "Dias sem comprar até cliente perdido",
  recent_days: "Janela de 'recente' (dias)",
  high_value_net_ltv: "LTV líquido de alto valor (R$)",
  due_grace_days: "Carência de cobrança (dias)",
  max_actions_per_customer_per_day: "Máx. de ações por cliente por dia",
  high_frequency_orders_90d: "Pedidos em 90 dias p/ alta frequência",
  default_cycle_days: "Ciclo padrão de assinatura (dias)",
  value_tiers: "Faixas de valor (JSON)",
  quality_weights: "Pesos do score de qualidade (JSON)",
  report_timezone: "Fuso dos relatórios",
};

function Settings({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } =
    useCrm<{ key: string; value: unknown; description: string | null }[]>("crm_list_settings");
  const save = useMutation({
    mutationFn: (s: { key: string; value: string }) => {
      let v: unknown;
      try {
        v = JSON.parse(s.value);
      } catch {
        throw new Error("Valor inválido (use número ou JSON).");
      }
      return crmCall("crm_update_setting", { p_key: s.key, p_value: v });
    },
    onSuccess: () => {
      toast.success("Configuração salva", {
        description: "Vale nos próximos cálculos; o worker reavalia os clientes.",
      });
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Section
      title="Regras e limites"
      description="Usados por lifecycle, risco, score, segmentos e automações. Toda alteração fica no log de auditoria."
    >
      {isLoading ? (
        <Loading rows={2} />
      ) : (
        <div className="surface divide-y divide-border">
          {(data ?? []).map((s) => (
            <SettingRow
              key={s.key}
              k={s.key}
              value={s.value}
              desc={s.description}
              disabled={!isAdmin}
              onSave={(value) => save.mutate({ key: s.key, value })}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function SettingRow({
  k,
  value,
  desc,
  disabled,
  onSave,
}: {
  k: string;
  value: unknown;
  desc: string | null;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const initial = JSON.stringify(value);
  const [v, setV] = useState(initial);
  const big = typeof value === "object";
  return (
    <div className="grid gap-2 p-3 sm:grid-cols-[1fr_2fr_auto] sm:items-center">
      <div>
        <p className="text-sm font-medium">{SETTING_PT[k] ?? k}</p>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </div>
      {big ? (
        <Textarea
          rows={3}
          value={v}
          disabled={disabled}
          onChange={(e) => setV(e.target.value)}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          value={v}
          disabled={disabled}
          onChange={(e) => setV(e.target.value)}
          className="font-mono text-xs"
        />
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || v === initial}
        onClick={() => onSave(v)}
      >
        Salvar
      </Button>
    </div>
  );
}
