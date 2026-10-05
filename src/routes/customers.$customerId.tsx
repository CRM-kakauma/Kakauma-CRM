import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Mail, MessageCircle, ShieldOff } from "lucide-react";
import {
  ApiErrorBox,
  Empty,
  LifecyclePill,
  Loading,
  Pill,
  RequireAuth,
  RiskPill,
  Section,
  Stat,
  TypePill,
} from "@/components/crm/ui";
import { count, date, dateTime, money } from "@/lib/crm-format";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FACT_LABEL,
  RUN_STATUS_LABEL,
  SKIP_LABEL,
  crmCall,
  label,
  useCrm,
  type Me,
} from "@/lib/crm-api";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL } from "@/lib/crm-messages";

export const Route = createFileRoute("/customers/$customerId")({
  head: () => ({ meta: [{ title: "Cliente 360 — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Customer360 me={me} />}</RequireAuth>,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- the 360 payload is a wide, read-only JSON document */
type C360 = Record<string, any>;

const STATUS_PT: Record<string, string> = {
  PENDING: "Pendente",
  PAID: "Pago",
  FAILED: "Recusado",
  PARTIALLY_REFUNDED: "Reembolso parcial",
  REFUNDED: "Reembolsado",
  CHARGEBACK: "Chargeback",
  CANCELLED: "Cancelado",
  ACTIVE: "Ativa",
  TRIAL: "Teste",
  PAUSED: "Pausada",
  PAYMENT_PENDING: "Pagamento pendente",
  PAYMENT_FAILED: "Pagamento falhou",
  INACTIVE: "Inativa",
  EXPIRED: "Expirada",
  REACTIVATED: "Reativada",
  LATE: "Atrasada",
  RECOVERED: "Recuperada",
  CURRENT: "Em dia",
  DUE: "Vencida",
  FULFILLMENT_CREATED: "Envio criado",
  SHIPPED: "Enviado",
  IN_TRANSIT: "Em trânsito",
  OUT_FOR_DELIVERY: "Saiu para entrega",
  DELIVERED: "Entregue",
  DELIVERY_DELAYED: "Atrasado",
  DELIVERY_FAILED: "Falhou",
  DELIVERY_RETURNED: "Devolvido",
  DELIVERY_LOST: "Extraviado",
};
const st = (s: string | null | undefined) => label(STATUS_PT, s);
const BAD = new Set([
  "FAILED",
  "REFUNDED",
  "CHARGEBACK",
  "CANCELLED",
  "INACTIVE",
  "EXPIRED",
  "LATE",
  "DUE",
  "DELIVERY_DELAYED",
  "DELIVERY_FAILED",
  "DELIVERY_RETURNED",
  "DELIVERY_LOST",
  "PARTIALLY_REFUNDED",
]);
const StatusPill = ({ s }: { s: string | null }) => (
  <Pill
    tone={
      s && BAD.has(s)
        ? "warning"
        : s === "PAID" || s === "DELIVERED" || s === "ACTIVE"
          ? "success"
          : "muted"
    }
  >
    {st(s)}
  </Pill>
);

function Customer360({ me }: { me: Me }) {
  const { customerId } = Route.useParams();
  const { data, isLoading, error } = useCrm<C360 | null>("crm_customer_360", {
    p_customer_id: customerId,
  });

  if (isLoading) return <Loading rows={6} />;
  if (error) return <ApiErrorBox error={error} />;
  if (!data) return <Empty>Cliente não encontrado.</Empty>;

  const id = data["identity"];
  const fin = data["financial"];
  const com = data["commerce"];
  const crm = data["crm"];
  const acq = data["acquisition"];
  const exp = data["experience"] ?? {};
  const wa = String(id["whatsapp"] ?? "").replace(/\D/g, "");

  return (
    <>
      <Link
        to="/customers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="size-4" /> Clientes
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {id["full_name"] ?? id["email"] ?? "Cliente"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[id["email"], id["whatsapp"], [id["city"], id["state"]].filter(Boolean).join("/")]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <TypePill type={crm["customer_type"]} />
            <LifecyclePill stage={crm["lifecycle"]} />
            <RiskPill risk={crm["risk"]} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {me.role === "admin" && !id["anonymized_at"] && (
            <Anonymize
              customerId={id["customer_id"]}
              name={id["full_name"] ?? id["email"] ?? "este cliente"}
            />
          )}
          {wa.length >= 10 && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`https://wa.me/${wa.length <= 11 ? `55${wa}` : wa}`}
                target="_blank"
                rel="noreferrer"
              >
                <MessageCircle className="size-4" /> WhatsApp
              </a>
            </Button>
          )}
          {id["email"] && (
            <Button variant="outline" size="sm" asChild>
              <a href={`mailto:${id["email"]}`}>
                <Mail className="size-4" /> E-mail
              </a>
            </Button>
          )}
        </div>
      </div>

      {id["anonymized_at"] && (
        <p className="mt-4 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          Dados pessoais anonimizados em {dateTime(id["anonymized_at"])} (LGPD). Valores e histórico
          de compras continuam nos relatórios.
        </p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="LTV bruto" value={money(fin["gross_ltv"])} />
        <Stat
          label="LTV líquido"
          value={money(fin["net_ltv"])}
          hint={`reembolsos ${money(fin["refunds"])}`}
        />
        <Stat
          label="LTV de contribuição"
          value={money(fin["contribution_ltv"])}
          hint="− taxas, frete, comissões"
        />
        <Stat
          label="Lucro do cliente"
          value={fin["profit_ltv"] != null ? money(fin["profit_ltv"]) : "incompleto"}
          hint={profitHint(fin)}
        />
        <Stat
          label="Pedidos pagos"
          value={count(com["paid_orders"])}
          hint={`ticket médio ${money(com["average_order_value"])}`}
        />
        <Stat
          label="Saldo a liberar"
          value={money(fin["pending_release"])}
          hint={`liberado ${money(fin["released"])}`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Section title="Assinaturas">
            {!data["subscriptions"].length ? (
              <Empty>Sem assinaturas.</Empty>
            ) : (
              <div className="space-y-3">
                {data["subscriptions"].map((s: C360) => (
                  <div key={s["subscription_id"]} className="surface p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium">{s["plan"] ?? s["subscription_id"]}</p>
                        <p className="text-xs text-muted-foreground">
                          ciclo {s["current_cycle"]} · próxima cobrança {date(s["next_charge_at"])}{" "}
                          · desde {date(s["start_date"])}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusPill s={s["status"]} />
                        <Pill tone={s["payment_state"] === "CURRENT" ? "success" : "warning"}>
                          pagamento: {st(s["payment_state"])}
                        </Pill>
                        {s["cancellation_requested"] && (
                          <Pill tone="danger">pediu cancelamento</Pill>
                        )}
                        <RiskPill risk={s["risk_state"]} />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                      <span>Receita {money(s["total_revenue"])}</span>
                      <span>Líquida {money(s["net_revenue"])}</span>
                      <span title={JSON.stringify(s["quality_factors"] ?? {}, null, 1)}>
                        Qualidade <strong className="num">{s["quality_score"] ?? "—"}</strong>/100 (
                        {label(QUALITY, s["quality_class"])})
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {s["charges"].map((c: C360) => (
                        <span
                          key={c["charge_id"]}
                          className={cn(
                            "rounded-md px-2 py-1 text-[11px]",
                            c["paid_at"]
                              ? "bg-success-soft text-success"
                              : "bg-warning-soft text-warning-foreground",
                          )}
                          title={`${st(c["status"])} · ${money(c["amount"])} · ${date(c["paid_at"] ?? c["late_at"] ?? c["failed_at"])}`}
                        >
                          C{c["cycle"] ?? "?"} {money(c["amount"])}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Pedidos">
            {!com["orders"].length ? (
              <Empty>Sem pedidos.</Empty>
            ) : (
              <div className="surface overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produto / oferta</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Método</TableHead>
                      <TableHead className="text-right">Valor pago</TableHead>
                      <TableHead className="text-right">Data</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {com["orders"].map((o: C360) => (
                      <TableRow key={o["order_id"]}>
                        <TableCell>
                          <p>{o["product"] ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            {o["offer"] ?? ""} · venda {o["sale_id"]}
                          </p>
                        </TableCell>
                        <TableCell>
                          <StatusPill s={o["status"]} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {o["payment_method"] ?? "—"}
                          {o["installments"] > 1 ? ` ${o["installments"]}x` : ""}
                        </TableCell>
                        <TableCell className="text-right num">{money(o["amount"])}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {date(o["paid_at"] ?? o["created_at"])}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Section>

          <Section title="Logística">
            {!data["logistics"].length ? (
              <Empty>Sem rastreamento recebido.</Empty>
            ) : (
              <div className="space-y-2">
                {data["logistics"].map((f: C360, i: number) => (
                  <div
                    key={i}
                    className="surface flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                  >
                    <span>
                      {f["carrier"] ?? "Transportadora ?"} ·{" "}
                      {f["tracking_url"] ? (
                        <a
                          href={f["tracking_url"]}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {f["tracking_code"]}
                        </a>
                      ) : (
                        (f["tracking_code"] ?? "sem código")
                      )}
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      frete {money(f["shipping_cost"])} · entregue {date(f["delivered_at"])}{" "}
                      <StatusPill s={f["status"]} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="Linha do tempo"
            description="Fatos derivados dos eventos, do mais recente ao mais antigo"
          >
            <ol className="surface space-y-3 p-4">
              {data["timeline"].map((e: C360, i: number) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="w-28 shrink-0 text-xs text-muted-foreground">
                    {dateTime(e["occurred_at"])}
                  </span>
                  <span>
                    <span className="font-medium">{label(FACT_LABEL, e["type"])}</span>
                    <TimelineDetail e={e} />
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <div>
          <Section title="Aquisição">
            <dl className="surface grid grid-cols-2 gap-3 p-4 text-sm">
              <Field k="Origem" v={acq?.["source"]} />
              <Field k="Mídia" v={acq?.["medium"]} />
              <Field k="Campanha" v={acq?.["campaign"]} />
              <Field k="Criativo" v={acq?.["creative"]} />
              <Field k="Funil" v={acq?.["funnel"]} />
              <Field
                k="Afiliado"
                v={acq?.["affiliate"]?.["name"] ?? acq?.["affiliate"]?.["email"]}
              />
              <Field k="Primeiro contato" v={date(acq?.["occurred_at"])} />
            </dl>
          </Section>
          <Section title="Experiência">
            <dl className="surface grid grid-cols-2 gap-3 p-4 text-sm">
              <Field k="CX score" v={exp["cx_score"] != null ? `${exp["cx_score"]}/100` : null} />
              <Field
                k="Prazo médio de entrega"
                v={exp["avg_delivery_days"] != null ? `${exp["avg_delivery_days"]} dias` : null}
              />
              <Field k="Atrasos de entrega" v={exp["delivery_delays"]} />
              <Field k="Falhas de entrega" v={exp["delivery_failures"]} />
              <Field k="Reembolsos" v={exp["refunds"]} />
              <Field k="Atrasos de assinatura" v={exp["subscription_late_events"]} />
              <Field k="Recompras" v={exp["reorders"]} />
            </dl>
          </Section>
          <Section title="Segmentos">
            <div className="flex flex-wrap gap-1.5">
              {crm["segments"].length ? (
                crm["segments"].map((s: C360) => (
                  <Link key={s["key"]} to="/customers" search={{ segment: s["key"] }}>
                    <Pill tone="primary">{s["name"]}</Pill>
                  </Link>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">Nenhum.</span>
              )}
            </div>
          </Section>
          <Section title="Fluxos">
            {!(crm["flows"] ?? []).length ? (
              <Empty>Não passou por nenhum fluxo.</Empty>
            ) : (
              <ul className="space-y-2">
                {crm["flows"].map((f: C360, i: number) => (
                  <li
                    key={i}
                    className="surface flex items-center justify-between gap-2 p-3 text-sm"
                  >
                    <Link
                      to="/flows/$key"
                      params={{ key: f["flow"] }}
                      className="font-medium hover:text-primary"
                    >
                      {f["name"]}
                    </Link>
                    <span className="text-right text-xs text-muted-foreground">
                      <Pill
                        tone={
                          f["status"] === "GOAL"
                            ? "success"
                            : ["ACTIVE", "WAITING"].includes(f["status"])
                              ? "primary"
                              : "muted"
                        }
                      >
                        {ENROLL_PT[f["status"]] ?? f["status"]}
                      </Pill>
                      <br />
                      {dateTime(f["entered_at"])}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Mensagens">
            <Optouts
              customerId={id["customer_id"]}
              optouts={crm["optouts"] ?? []}
              canEdit={me.role !== "viewer"}
            />
            {!(crm["messages"] ?? []).length ? (
              <Empty>Nenhuma mensagem de fluxo.</Empty>
            ) : (
              <ul className="mt-3 space-y-2">
                {crm["messages"].map((m: C360) => (
                  <li key={m["message_id"]} className="surface p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {CHANNEL_LABEL[m["channel"] as keyof typeof CHANNEL_LABEL] ?? m["channel"]}
                        {m["flow"] ? (
                          <span className="font-normal text-muted-foreground"> · {m["flow"]}</span>
                        ) : null}
                      </span>
                      <Pill
                        tone={
                          m["status"] === "SENT"
                            ? "success"
                            : m["status"] === "DRY_RUN"
                              ? "primary"
                              : m["status"] === "SKIPPED"
                                ? "warning"
                                : "muted"
                        }
                      >
                        {MSG_PT[m["status"]] ?? m["status"]}
                      </Pill>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {dateTime(m["at"])}
                      {m["skip_reason"] ? ` · ${m["skip_reason"]}` : ""}
                    </p>
                    {m["rendered"] && (
                      <p className="mt-2 line-clamp-3 rounded-lg bg-muted/60 px-3 py-2 text-xs">
                        {m["rendered"]["subject"] ??
                          m["rendered"]["text"] ??
                          m["rendered"]["body"] ??
                          m["rendered"]["cards"]?.[0]?.["title"] ??
                          ""}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Automações simples">
            {!crm["automations"].length ? (
              <Empty>Nenhuma automação disparada.</Empty>
            ) : (
              <ul className="space-y-2">
                {crm["automations"].map((a: C360, i: number) => {
                  const msg = crm["communications"].find(
                    (m: C360) =>
                      m["automation"] === a["automation"] && m["sent_at"] === a["executed_at"],
                  );
                  return (
                    <li key={i} className="surface p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{a["name"]}</span>
                        <Pill
                          tone={
                            a["status"] === "SENT"
                              ? "success"
                              : a["status"] === "DRY_RUN"
                                ? "primary"
                                : "muted"
                          }
                        >
                          {label(RUN_STATUS_LABEL, a["status"])}
                        </Pill>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {dateTime(a["executed_at"] ?? a["scheduled_for"])}
                        {a["skip_reason"] ? ` · ${label(SKIP_LABEL, a["skip_reason"])}` : ""}
                      </p>
                      {msg?.["message"] && (
                        <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-xs">
                          {msg["message"]}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

const ENROLL_PT: Record<string, string> = {
  ACTIVE: "em andamento",
  WAITING: "aguardando",
  COMPLETED: "concluiu",
  GOAL: "meta atingida",
  EXITED: "saiu",
  FAILED: "erro",
};
const MSG_PT: Record<string, string> = {
  QUEUED: "na fila",
  PROCESSING: "enviando",
  SENT: "enviada",
  DRY_RUN: "simulação",
  SKIPPED: "não enviada",
  FAILED: "falhou",
};

/** Channels the customer does not want marketing on (LGPD opt-out). */
function Optouts({
  customerId,
  optouts,
  canEdit,
}: {
  customerId: string;
  optouts: string[];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (v: { channel: string; out: boolean }) =>
      crmCall("crm_set_optout", {
        p_customer_id: customerId,
        p_channel: v.channel,
        p_opt_out: v.out,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm"] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="surface p-3 text-xs">
      <p className="mb-2 font-medium">Recebe marketing por</p>
      <div className="flex flex-wrap gap-3">
        {(["email", "sms", "whatsapp", "rcs"] as const).map((ch) => {
          const out = optouts.includes(ch) || optouts.includes("all");
          return (
            <label key={ch} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!out}
                disabled={!canEdit || optouts.includes("all") || set.isPending}
                onChange={(e) => set.mutate({ channel: ch, out: !e.target.checked })}
              />
              {CHANNEL_LABEL[ch]}
            </label>
          );
        })}
      </div>
      <p className="mt-2 text-muted-foreground">
        Desmarcado = a pessoa pediu para não receber. Mensagens transacionais (pagamento, entrega)
        continuam.
      </p>
    </div>
  );
}

const QUALITY: Record<string, string> = {
  HIGH_QUALITY: "alta",
  MEDIUM_QUALITY: "média",
  LOW_QUALITY: "baixa",
  AT_RISK: "em risco",
  HIGH_VALUE_AT_RISK: "alto valor em risco",
};

function profitHint(fin: C360) {
  if (fin["cogs_missing_sales"] > 0)
    return `${fin["cogs_missing_sales"]} venda(s) sem custo cadastrado`;
  if (fin["tax_rate_pct"] == null) return "defina a alíquota de impostos em Operação";
  return `CMV ${money(fin["cogs"])} · impostos ${money(fin["taxes"])}`;
}

function Anonymize({ customerId, name }: { customerId: string; name: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const run = useMutation({
    mutationFn: () =>
      crmCall<{ events_redacted: number }>("crm_anonymize_customer", {
        p_customer_id: customerId,
        p_reason: reason,
      }),
    onSuccess: (r) => {
      toast.success("Cliente anonimizado", {
        description: `${r.events_redacted} evento(s) brutos tiveram os dados pessoais removidos.`,
      });
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <ShieldOff className="size-4" /> Anonimizar (LGPD)
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anonimizar {name}?</DialogTitle>
            <DialogDescription>
              Remove nome, e-mail, telefone, documento, endereço, links de pagamento e rastreio —
              também dentro dos eventos brutos guardados. Valores e histórico de compras ficam (sem
              identificar a pessoa). Não dá para desfazer; se a pessoa comprar de novo, vira um
              cliente novo.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Motivo / protocolo da solicitação</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Pedido do titular, e-mail de 05/10"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Digite ANONIMIZAR para confirmar</Label>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || confirm !== "ANONIMIZAR" || run.isPending}
              onClick={() => run.mutate()}
            >
              Anonimizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ k, v }: { k: string; v: unknown }) {
  return (
    <div>
      <dt className="label-eyebrow">{k}</dt>
      <dd className="mt-1 break-words">
        {v === null || v === undefined || v === "" ? "—" : String(v)}
      </dd>
    </div>
  );
}

function TimelineDetail({ e }: { e: C360 }) {
  const d = e["data"] ?? {};
  const parts: string[] = [];
  if (d["amount"] != null) parts.push(money(d["amount"]));
  if (d["from"] !== undefined || d["to"] !== undefined)
    parts.push(`${d["from"] ?? "—"} → ${d["to"] ?? "—"}`);
  if (d["segment"]) parts.push(d["segment"]);
  if (d["cycle"] != null) parts.push(`ciclo ${d["cycle"]}`);
  if (d["method"]) parts.push(String(d["method"]).toUpperCase());
  if (d["carrier"]) parts.push(d["carrier"]);
  return parts.length ? (
    <span className="text-muted-foreground"> · {parts.join(" · ")}</span>
  ) : null;
}
