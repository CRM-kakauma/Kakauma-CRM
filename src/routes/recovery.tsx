import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { FilterSelect } from "@/components/crm/filter-select";
import {
  ApiErrorBox,
  Empty,
  Loading,
  Pill,
  RequireAuth,
  RiskPill,
  Stat,
} from "@/components/crm/ui";
import { count, dateTime, money } from "@/lib/crm-format";
import { Button } from "@/components/ui/button";
import { useCrm } from "@/lib/crm-api";

export const Route = createFileRoute("/recovery")({
  head: () => ({ meta: [{ title: "Recuperação — Kakauma CRM" }] }),
  component: () => <RequireAuth>{() => <Recovery />}</RequireAuth>,
});

interface Item {
  kind: string;
  customer_id: string;
  full_name: string | null;
  email: string | null;
  whatsapp: string | null;
  amount: number | null;
  since: string | null;
  detail: string | null;
  net_ltv: number;
  risk: string | null;
}

const KIND: Record<string, { label: string; message: (first: string) => string }> = {
  CHECKOUT_ABANDONED: {
    label: "Checkout abandonado",
    message: (n) => `Oi ${n}, vi que você não finalizou seu pedido. Posso ajudar?`,
  },
  PAYMENT_PENDING: {
    label: "PIX/boleto em aberto",
    message: (n) => `Oi ${n}, seu pagamento ainda está em aberto. Quer que eu envie um novo link?`,
  },
  SUBSCRIPTION_LATE: {
    label: "Assinatura atrasada",
    message: (n) =>
      `Oi ${n}, não conseguimos confirmar o pagamento da sua assinatura. Posso ajudar?`,
  },
  SUBSCRIPTION_FAILED: {
    label: "Cobrança recusada",
    message: (n) =>
      `Oi ${n}, a cobrança da sua assinatura foi recusada. Quer atualizar o pagamento?`,
  },
  SUBSCRIPTION_DUE: {
    label: "Cobrança vencida",
    message: (n) => `Oi ${n}, a renovação da sua assinatura venceu. Posso ajudar com o pagamento?`,
  },
  CANCELLATION_REQUESTED: {
    label: "Pediu cancelamento",
    message: (n) =>
      `Oi ${n}, recebemos seu pedido de cancelamento. Posso entender o que aconteceu?`,
  },
};

function Recovery() {
  const [kind, setKind] = useState("all");
  const { data, isLoading, error } = useCrm<Item[]>("crm_recovery_queue", { p_limit: 500 });
  const items = (data ?? []).filter((i) => kind === "all" || i.kind === kind);
  const by = (k: string) => (data ?? []).filter((i) => i.kind === k);
  const sum = (xs: Item[]) => xs.reduce((s, i) => s + Number(i.amount ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Recuperação"
        help="recuperacao"
        description="Situações abertas agora, a partir dos eventos. Some daqui sozinho quando o cliente paga, renova ou o prazo passa."
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Checkouts abandonados"
          value={count(by("CHECKOUT_ABANDONED").length)}
          hint="últimos 30 dias"
        />
        <Stat
          label="Pagamentos em aberto"
          value={count(by("PAYMENT_PENDING").length)}
          hint={money(sum(by("PAYMENT_PENDING")))}
        />
        <Stat
          label="Assinaturas com cobrança pendente"
          value={count(
            by("SUBSCRIPTION_LATE").length +
              by("SUBSCRIPTION_FAILED").length +
              by("SUBSCRIPTION_DUE").length,
          )}
        />
        <Stat label="Pedidos de cancelamento" value={count(by("CANCELLATION_REQUESTED").length)} />
      </div>
      <div className="mb-4">
        <FilterSelect
          value={kind}
          onChange={setKind}
          all="Todas as situações"
          options={Object.entries(KIND).map(([value, k]) => ({ value, label: k.label }))}
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading rows={5} />
      ) : !items.length ? (
        <Empty>Nada para recuperar agora.</Empty>
      ) : (
        <div className="space-y-2">
          {items.map((i, idx) => {
            const k = KIND[i.kind];
            const first = (i.full_name ?? "").split(" ")[0] || "tudo bem";
            const wa = String(i.whatsapp ?? "").replace(/\D/g, "");
            return (
              <div
                key={`${i.kind}-${i.customer_id}-${idx}`}
                className="surface flex flex-wrap items-center gap-4 p-4"
              >
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: i.customer_id }}
                  className="min-w-52 flex-1"
                >
                  <p className="font-medium text-primary hover:underline">
                    {i.full_name ?? i.email ?? "Cliente"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {i.whatsapp ?? i.email ?? "sem contato"}
                  </p>
                </Link>
                <div className="min-w-44">
                  <Pill tone={i.kind === "CANCELLATION_REQUESTED" ? "danger" : "warning"}>
                    {k?.label ?? i.kind}
                  </Pill>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i.detail ?? ""} · {dateTime(i.since)}
                  </p>
                </div>
                <RiskPill risk={i.risk} />
                <div className="w-28 text-right">
                  <p className="font-semibold num">{money(i.amount)}</p>
                  <p className="text-[11px] text-muted-foreground">LTV {money(i.net_ltv)}</p>
                </div>
                {wa.length >= 10 && k && (
                  <Button size="sm" variant="outline" asChild>
                    <a
                      href={`https://wa.me/${wa.length <= 11 ? `55${wa}` : wa}?text=${encodeURIComponent(k.message(first))}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MessageCircle className="size-4" /> WhatsApp
                    </a>
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
