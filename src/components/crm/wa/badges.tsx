/**
 * What the attendant sees about the contact in the WhatsApp screen: temperature (Quente / Morno /
 * Frio), how much was spent, orders, pots, last purchase, opportunity tags, manual tags and the
 * history of everything the customer did.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CircleDollarSign,
  CreditCard,
  Flame,
  Lightbulb,
  Loader2,
  Package,
  PackageCheck,
  Plus,
  Repeat,
  ShoppingCart,
  Snowflake,
  Sun,
  Tag,
  Truck,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  useWaHistory,
  useWaTags,
  waFetch,
  type Temperature,
  type TemperatureConfig,
  type WaBadges,
  type WaHistoryItem,
} from "./api";

export const money = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const date = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "—";
const ago = (days: number | null | undefined) =>
  days == null ? "" : days === 0 ? "hoje" : days === 1 ? "ontem" : `há ${days} dias`;

const TEMP: Record<Temperature, { cls: string; dot: string; Icon: typeof Flame; label: string }> = {
  quente: {
    cls: "bg-gradient-to-r from-orange-500 to-rose-500 text-white",
    dot: "bg-rose-500",
    Icon: Flame,
    label: "Quente",
  },
  morno: {
    cls: "bg-gradient-to-r from-amber-300 to-amber-400 text-amber-950",
    dot: "bg-amber-400",
    Icon: Sun,
    label: "Morno",
  },
  frio: {
    cls: "bg-gradient-to-r from-sky-400 to-blue-500 text-white",
    dot: "bg-sky-500",
    Icon: Snowflake,
    label: "Frio",
  },
};

/** Small temperature mark next to the name in the conversation list. */
export function TempMark({
  temperature,
  className,
}: {
  temperature?: Temperature | null | undefined;
  className?: string;
}) {
  if (!temperature) return null;
  const t = TEMP[temperature];
  return (
    <span
      title={`Cliente ${t.label.toLowerCase()}`}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-px align-middle text-[10px] font-semibold",
        t.cls,
        className,
      )}
    >
      <t.Icon className="size-2.5" /> {t.label}
    </span>
  );
}

const TONE: Record<string, string> = {
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  danger: "bg-rose-50 text-rose-800 ring-rose-200",
};

function Stat({ icon: Icon, label, value }: { icon: typeof Flame; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#f0f2f5] px-2 py-1 text-xs text-[#41525d]">
      <Icon className="size-3.5 text-[#667781]" />
      <span className="text-[#667781]">{label}</span>
      <span className="font-semibold text-[#111b21]">{value}</span>
    </span>
  );
}

/** The strip under the conversation header: temperature, spent, orders, pots, last purchase, tags. */
export function ContactTags({
  chatId,
  badges,
  canEdit,
}: {
  chatId: string;
  badges: WaBadges;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const tags = useWaTags();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const t = TEMP[badges.temperature];
  const s = badges.summary ?? {};

  async function change(tag: string, add: boolean) {
    setBusy(true);
    try {
      await waFetch("tags", { chat: chatId, tag, add });
      await qc.invalidateQueries({ queryKey: ["wa"] });
      setText("");
      if (add) setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const suggestions = (tags.data?.tags ?? [])
    .filter((x) => !badges.manual.includes(x))
    .filter((x) => !text || x.toLowerCase().includes(text.toLowerCase()))
    .slice(0, 12);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-1.5 border-b border-l border-border bg-white px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex cursor-default items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold shadow-sm",
                  t.cls,
                )}
              >
                <t.Icon className="size-3.5" /> {badges.temperature_label}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{badges.temperature_reason}</TooltipContent>
          </Tooltip>
          {Number(s.orders ?? 0) > 0 ? (
            <>
              <Stat icon={CircleDollarSign} label="Gastou" value={money(s.spent)} />
              <Stat icon={ShoppingCart} label="Pedidos" value={String(s.orders)} />
              <Stat icon={Package} label="Potes" value={String(Number(s.pots ?? 0))} />
              <Stat
                icon={Repeat}
                label="Última compra"
                value={`${date(s.last_purchase_at)}${s.days_since_purchase != null ? ` (${ago(s.days_since_purchase)})` : ""}`}
              />
            </>
          ) : (
            <span className="text-xs text-[#667781]">Ainda não comprou</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {badges.auto.map((x) => (
            <Tooltip key={x.key}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "cursor-default rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                    TONE[x.tone],
                  )}
                >
                  {x.label}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{x.hint}</TooltipContent>
            </Tooltip>
          ))}
          {badges.manual.map((x) => (
            <span
              key={x}
              className="inline-flex items-center gap-1 rounded-full bg-[#e7f3ff] px-2 py-0.5 text-xs font-medium text-[#075DA8] ring-1 ring-[#bfdbfe]"
            >
              <Tag className="size-3" /> {x}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Tirar a tag ${x}`}
                  disabled={busy}
                  onClick={() => void change(x, false)}
                  className="-mr-0.5 rounded-full p-0.5 hover:bg-[#bfdbfe]"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
          {canEdit && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-[#54656f] ring-1 ring-[#cbd5e1] hover:bg-[#f0f2f5]"
                >
                  <Plus className="size-3" /> Tag
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (text.trim()) void change(text.trim(), true);
                  }}
                  className="flex gap-2"
                >
                  <Input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Ex.: Prefere áudio, Kit família"
                    maxLength={40}
                    autoFocus
                    className="h-8"
                  />
                  <Button size="sm" type="submit" disabled={busy || !text.trim()} className="h-8">
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Pôr"}
                  </Button>
                </form>
                {suggestions.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {suggestions.map((x) => (
                      <button
                        key={x}
                        type="button"
                        disabled={busy}
                        onClick={() => void change(x, true)}
                        className="rounded-full bg-[#f0f2f5] px-2 py-0.5 text-xs text-[#41525d] hover:bg-[#e7f3ff] hover:text-[#075DA8]"
                      >
                        {x}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2.5 text-[11px] text-muted-foreground">
                  A tag fica no cliente e aparece em todas as conversas dele.
                </p>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** Tip of the temperature plus the opportunities of the moment, above the messages. */
export function SalesTip({ badges, onHide }: { badges: WaBadges; onHide: () => void }) {
  const lines = [badges.tip, ...badges.auto.slice(0, 2).map((x) => x.hint)].filter(
    Boolean,
  ) as string[];
  if (!lines.length) return null;
  return (
    <div className="mx-auto flex max-w-2xl items-start gap-2.5 rounded-xl border border-amber-200 bg-[#fffbeb]/95 px-3.5 py-2.5 text-[13px] text-[#78350f] shadow-sm">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-semibold">
          Dica · cliente {badges.temperature_label.toLowerCase()} —{" "}
          {badges.temperature_reason.toLowerCase()}
        </p>
        {lines.map((l) => (
          <p key={l} className="leading-snug">
            {l}
          </p>
        ))}
      </div>
      <button
        type="button"
        onClick={onHide}
        className="rounded p-0.5 text-amber-700/70 hover:bg-amber-100"
        aria-label="Esconder dica"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/** Contact panel: the full picture of the customer. */
export function CustomerPicture({ badges }: { badges: WaBadges }) {
  const s = badges.summary ?? {};
  const t = TEMP[badges.temperature];
  const rows: [string, string][] = [
    ["Total gasto", money(s.spent)],
    ["Pedidos pagos", String(s.orders ?? 0)],
    ["Potes comprados", String(Number(s.pots ?? 0))],
    ["Ticket médio", s.avg_ticket != null ? money(s.avg_ticket) : "—"],
    ["Primeira compra", date(s.first_purchase_at)],
    [
      "Última compra",
      s.last_purchase_at ? `${date(s.last_purchase_at)} (${ago(s.days_since_purchase)})` : "—",
    ],
    [
      "Último produto",
      s.last_product ? `${s.last_product}${s.last_pots ? ` · ${s.last_pots} pote(s)` : ""}` : "—",
    ],
    ["Reembolsos", String(s.refunds ?? 0)],
  ];
  return (
    <div className="space-y-3">
      <div className={cn("flex items-center gap-2 rounded-xl px-3 py-2.5", t.cls)}>
        <t.Icon className="size-5" />
        <div className="min-w-0">
          <p className="text-sm font-bold">Cliente {badges.temperature_label.toLowerCase()}</p>
          <p className="text-xs opacity-90">{badges.temperature_reason}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className={cn(k === "Último produto" && "col-span-2")}>
            <dt className="text-[11px] text-[#667781]">{k}</dt>
            <dd className="font-medium text-[#111b21]">{v}</dd>
          </div>
        ))}
      </dl>
      {(s.products?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1 text-[11px] text-[#667781]">O que já comprou</p>
          <ul className="space-y-1 text-[13px]">
            {s.products!.map((p) => (
              <li key={p.name} className="flex justify-between gap-2">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 text-[#667781]">
                  {Number(p.pots)} pote(s) · {p.n}x
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const KIND: Record<string, { label: string; Icon: typeof Flame; color: string }> = {
  PURCHASE_PAID: {
    label: "Comprou",
    Icon: CircleDollarSign,
    color: "text-emerald-600 bg-emerald-50",
  },
  RENEWAL_PAID: {
    label: "Renovou a assinatura",
    Icon: Repeat,
    color: "text-emerald-600 bg-emerald-50",
  },
  CHECKOUT_ABANDONED: {
    label: "Abandonou o carrinho",
    Icon: ShoppingCart,
    color: "text-amber-600 bg-amber-50",
  },
  PAYMENT_PENDING: {
    label: "Gerou Pix/boleto",
    Icon: CreditCard,
    color: "text-amber-600 bg-amber-50",
  },
  PAYMENT_FAILED: {
    label: "Pagamento recusado",
    Icon: CreditCard,
    color: "text-rose-600 bg-rose-50",
  },
  PAYMENT_EXPIRED: {
    label: "Pix/boleto expirou",
    Icon: CreditCard,
    color: "text-rose-600 bg-rose-50",
  },
  REFUND_ISSUED: { label: "Reembolso", Icon: Undo2, color: "text-rose-600 bg-rose-50" },
  CHARGEBACK_RECEIVED: { label: "Chargeback", Icon: Undo2, color: "text-rose-600 bg-rose-50" },
  FULFILLMENT_SHIPPED: { label: "Pedido postado", Icon: Truck, color: "text-sky-600 bg-sky-50" },
  FULFILLMENT_IN_TRANSIT: { label: "Em trânsito", Icon: Truck, color: "text-sky-600 bg-sky-50" },
  FULFILLMENT_OUT_FOR_DELIVERY: {
    label: "Saiu para entrega",
    Icon: Truck,
    color: "text-sky-600 bg-sky-50",
  },
  FULFILLMENT_DELIVERED: {
    label: "Pedido entregue",
    Icon: PackageCheck,
    color: "text-emerald-600 bg-emerald-50",
  },
  FULFILLMENT_DELIVERY_FAILED: {
    label: "Aguardando retirada",
    Icon: Package,
    color: "text-amber-600 bg-amber-50",
  },
  FULFILLMENT_DELIVERY_RETURNED: {
    label: "Pedido devolvido",
    Icon: Undo2,
    color: "text-rose-600 bg-rose-50",
  },
  SUBSCRIPTION_CREATED: { label: "Assinou", Icon: Repeat, color: "text-violet-600 bg-violet-50" },
  SUBSCRIPTION_RENEWED: {
    label: "Assinatura renovada",
    Icon: Repeat,
    color: "text-violet-600 bg-violet-50",
  },
  SUBSCRIPTION_PAYMENT_LATE: {
    label: "Assinatura atrasada",
    Icon: Repeat,
    color: "text-rose-600 bg-rose-50",
  },
  SUBSCRIPTION_CANCELLATION_REQUESTED: {
    label: "Pediu cancelamento",
    Icon: Repeat,
    color: "text-rose-600 bg-rose-50",
  },
  SUBSCRIPTION_CANCELLED: {
    label: "Assinatura cancelada",
    Icon: Repeat,
    color: "text-rose-600 bg-rose-50",
  },
};
const PAY: Record<string, string> = { pix: "Pix", card: "cartão", billet: "boleto" };

/** Everything the customer did, newest first. */
export function CustomerHistory({ chatId, enabled }: { chatId: string; enabled: boolean }) {
  const h = useWaHistory(chatId, enabled);
  if (!enabled) return null;
  if (h.isLoading)
    return <Loader2 className="mx-auto my-4 size-5 animate-spin text-muted-foreground" />;
  const items = h.data?.history ?? [];
  if (!items.length)
    return <p className="text-[13px] text-[#667781]">Nenhuma ação registrada ainda.</p>;
  return (
    <ol className="relative space-y-3 border-l border-[#e9edef] pl-4">
      {items.map((e: WaHistoryItem, i) => {
        const k = KIND[e.kind] ?? {
          label: e.kind,
          Icon: Package,
          color: "text-slate-600 bg-slate-50",
        };
        return (
          <li key={`${e.at}-${e.kind}-${i}`} className="relative">
            <span
              className={cn(
                "absolute -left-[26px] top-0 flex size-5 items-center justify-center rounded-full",
                k.color,
              )}
            >
              <k.Icon className="size-3" />
            </span>
            <p className="text-[13px] font-medium text-[#111b21]">
              {k.label}
              {e.kind === "PURCHASE_PAID" && e.amount != null && (
                <span className="font-normal"> · {money(e.amount)}</span>
              )}
            </p>
            {(e.product || e.pots || e.payment_method || e.tracking_code) && (
              <p className="text-xs text-[#667781]">
                {[
                  e.product,
                  e.pots ? `${Number(e.pots)} pote(s)` : null,
                  e.kind === "PURCHASE_PAID" && e.payment_method
                    ? (PAY[e.payment_method] ?? e.payment_method)
                    : null,
                  e.order_status === "REFUNDED" ? "reembolsado" : null,
                  e.tracking_code,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <p className="text-[11px] text-[#8696a0]">
              {new Date(e.at).toLocaleString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                year: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/** Admin: when a customer is quente / morno / frio, and the tip of each. */
export function TemperatureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const tags = useWaTags();
  const [cfg, setCfg] = useState<TemperatureConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const value = cfg ?? tags.data?.temperature ?? null;
  const set = (patch: (c: TemperatureConfig) => void) => {
    if (!value) return;
    const c = structuredClone(value);
    patch(c);
    setCfg(c);
  };
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      await waFetch("tags", { temperature: value });
      toast.success("Temperatura salva");
      await qc.invalidateQueries({ queryKey: ["wa"] });
      setCfg(null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Temperatura do cliente</DialogTitle>
          <DialogDescription>
            Sinal de compra = abandonou carrinho, gerou Pix/boleto ou teve pagamento recusado, sem
            comprar depois.
          </DialogDescription>
        </DialogHeader>
        {!value ? (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl border border-border p-3">
              <TempMark temperature="quente" />
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                comprou nos últimos
                <Input
                  className="h-8 w-16"
                  value={String(value.hot_purchase_days)}
                  onChange={(e) => set((c) => void (c.hot_purchase_days = num(e.target.value)))}
                />
                dias, ou teve sinal de compra nos últimos
                <Input
                  className="h-8 w-16"
                  value={String(value.hot_signal_days)}
                  onChange={(e) => set((c) => void (c.hot_signal_days = num(e.target.value)))}
                />
                dias
              </p>
              <Textarea
                className="mt-2"
                rows={2}
                value={value.quente.tip}
                onChange={(e) => set((c) => void (c.quente.tip = e.target.value))}
              />
            </div>
            <div className="rounded-xl border border-border p-3">
              <TempMark temperature="morno" />
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                comprou nos últimos
                <Input
                  className="h-8 w-16"
                  value={String(value.warm_purchase_days)}
                  onChange={(e) => set((c) => void (c.warm_purchase_days = num(e.target.value)))}
                />
                dias, ou teve sinal de compra nos últimos
                <Input
                  className="h-8 w-16"
                  value={String(value.warm_signal_days)}
                  onChange={(e) => set((c) => void (c.warm_signal_days = num(e.target.value)))}
                />
                dias
              </p>
              <Textarea
                className="mt-2"
                rows={2}
                value={value.morno.tip}
                onChange={(e) => set((c) => void (c.morno.tip = e.target.value))}
              />
            </div>
            <div className="rounded-xl border border-border p-3">
              <TempMark temperature="frio" />
              <p className="mt-2 text-muted-foreground">
                todos os outros (compra antiga, ou nunca comprou e sem sinal recente)
              </p>
              <Textarea
                className="mt-2"
                rows={2}
                value={value.frio.tip}
                onChange={(e) => set((c) => void (c.frio.tip = e.target.value))}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => void save()} disabled={busy || !value}>
            {busy && <Loader2 className="size-4 animate-spin" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
