import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, MessageCircle, PhoneCall, X } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { ContactSheet } from "@/components/crm/contact-sheet";
import { FilterSelect } from "@/components/crm/filter-select";
import { useInvalidateCrm } from "@/components/crm/forms";
import { Avatar, ReasonPill, RecoveryStatusPill, whatsappLink } from "@/components/crm/pills";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/format";
import {
  RECOVERY_REASON_LABEL,
  RECOVERY_STATUS_LABEL,
  listRecoveries,
  updateRecovery,
  type RecoveryReason,
  type RecoveryStatus,
  type RecoveryWithContact,
} from "@/services/crm";

export const Route = createFileRoute("/recovery")({
  head: () => ({
    meta: [
      { title: "Recuperação de vendas — Kakauma CRM" },
      {
        name: "description",
        content:
          "Fila de carrinhos abandonados, PIX expirados, boletos em aberto e pagamentos recusados.",
      },
    ],
  }),
  component: RecoveryPage,
});

const MESSAGE: Record<RecoveryReason, (first: string, product: string) => string> = {
  CART_ABANDONED: (n, p) =>
    `Oi ${n}! Vi que você começou a compra do ${p} e não finalizou. Posso te ajudar com alguma dúvida?`,
  PIX_EXPIRED: (n, p) =>
    `Oi ${n}! O PIX do seu pedido (${p}) expirou. Quer que eu gere um novo para você?`,
  BOLETO_GENERATED: (n, p) =>
    `Oi ${n}! Seu boleto do ${p} ainda está em aberto. Se preferir, posso enviar um PIX para agilizar.`,
  PURCHASE_DECLINED: (n, p) =>
    `Oi ${n}! O pagamento do ${p} não foi aprovado. Quer tentar outro cartão ou pagar via PIX?`,
};

function RecoveryPage() {
  const invalidate = useInvalidateCrm();
  const [status, setStatus] = useState<RecoveryStatus | "all">("pendente");
  const [reason, setReason] = useState<RecoveryReason | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);

  const filters = { status, reason };
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "recoveries", filters],
    queryFn: () => listRecoveries(filters),
  });
  const { data: all = [] } = useQuery({
    queryKey: ["crm", "recoveries", {}],
    queryFn: () => listRecoveries(),
  });

  const m = useMutation({
    mutationFn: ({ id, s }: { id: string; s: RecoveryStatus }) => updateRecovery(id, s),
    onSuccess: (r) => {
      if (r.status === "recuperado")
        toast.success("Venda recuperada", { description: formatCurrency(r.value) });
      invalidate();
    },
  });

  const open = all.filter((r) => r.status === "pendente" || r.status === "contatado");
  const recovered = all.filter((r) => r.status === "recuperado");
  const closed = recovered.length + all.filter((r) => r.status === "perdido").length;

  return (
    <>
      <PageHeader
        title="Recuperação de vendas"
        description="Fila gerada a partir dos eventos de checkout. Entre em contato e marque o resultado."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Kpi
          label="Em aberto"
          value={formatNumber(open.length)}
          hint={formatCurrency(open.reduce((s, r) => s + r.value, 0))}
        />
        <Kpi
          label="Recuperado"
          value={formatCurrency(recovered.reduce((s, r) => s + r.value, 0))}
          hint={`${recovered.length} vendas`}
        />
        <Kpi
          label="Taxa de recuperação"
          value={`${closed ? Math.round((recovered.length * 100) / closed) : 0}%`}
          hint="das recuperações encerradas"
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterSelect
          value={status}
          onChange={(v) => setStatus(v as RecoveryStatus | "all")}
          all="Todos os status"
          options={(Object.keys(RECOVERY_STATUS_LABEL) as RecoveryStatus[]).map((k) => ({
            value: k,
            label: RECOVERY_STATUS_LABEL[k],
          }))}
        />
        <FilterSelect
          value={reason}
          onChange={(v) => setReason(v as RecoveryReason | "all")}
          all="Todos os motivos"
          options={(Object.keys(RECOVERY_REASON_LABEL) as RecoveryReason[]).map((k) => ({
            value: k,
            label: RECOVERY_REASON_LABEL[k],
          }))}
        />
      </div>

      {isLoading ? (
        <BlockSkeleton height={400} />
      ) : !data?.length ? (
        <EmptyState
          title="Fila vazia"
          description="Nenhuma venda para recuperar com esses filtros."
        />
      ) : (
        <div className="grid gap-3">
          {data.map((r) => (
            <RecoveryRow
              key={r.id}
              r={r}
              busy={m.isPending}
              onOpen={() => setSelected(r.contact_id)}
              onSet={(s) => m.mutate({ id: r.id, s })}
            />
          ))}
        </div>
      )}

      <ContactSheet contactId={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function RecoveryRow({
  r,
  busy,
  onOpen,
  onSet,
}: {
  r: RecoveryWithContact;
  busy: boolean;
  onOpen: () => void;
  onSet: (s: RecoveryStatus) => void;
}) {
  const first = r.contact.name.split(" ")[0] ?? "";
  const wa = whatsappLink(r.contact.phone, MESSAGE[r.reason](first, r.product));
  const closed = r.status === "recuperado" || r.status === "perdido";

  return (
    <div className="surface flex flex-wrap items-center gap-x-4 gap-y-3 p-4 xl:grid xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_6rem_22rem]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-56 flex-1 items-center gap-3 text-left xl:min-w-0"
      >
        <Avatar name={r.contact.name} />
        <div className="min-w-0">
          <p className="truncate font-medium">{r.contact.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {r.contact.phone ?? r.contact.email}
          </p>
        </div>
      </button>
      <div className="min-w-44 xl:min-w-0">
        <p className="text-sm">{r.product}</p>
        <p className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</p>
      </div>
      <div className="flex min-w-48 flex-wrap items-center gap-1.5 xl:min-w-0">
        <ReasonPill reason={r.reason} />
        <RecoveryStatusPill status={r.status} />
        {r.attempts > 0 && (
          <span className="text-[11px] text-muted-foreground">{r.attempts}× contato</span>
        )}
      </div>
      <p className="w-24 text-right font-semibold num">{formatCurrency(r.value)}</p>
      <div className="flex flex-wrap gap-1.5 xl:flex-nowrap xl:justify-end">
        {wa && !closed && (
          <Button size="sm" variant="outline" className="gap-1.5" asChild>
            <a href={wa} target="_blank" rel="noreferrer" onClick={() => onSet("contatado")}>
              <MessageCircle className="size-4" /> WhatsApp
            </a>
          </Button>
        )}
        {!closed && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              disabled={busy}
              onClick={() => onSet("contatado")}
            >
              <PhoneCall className="size-4" /> Contatado
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-success hover:text-success"
              disabled={busy}
              onClick={() => onSet("recuperado")}
            >
              <Check className="size-4" /> Recuperado
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 text-muted-foreground"
              aria-label="Marcar como perdido"
              disabled={busy}
              onClick={() => onSet("perdido")}
            >
              <X className="size-4" />
            </Button>
          </>
        )}
        {closed && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSet("pendente")}>
            Reabrir
          </Button>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="surface p-5">
      <p className="label-eyebrow">{label}</p>
      <p className="metric-value mt-3">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
