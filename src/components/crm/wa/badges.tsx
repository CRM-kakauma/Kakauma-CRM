/** Customer level (Sem compra / Bronze / Prata / Ouro), sales tip and tags in the WhatsApp screen. */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lightbulb, Loader2, Plus, Tag, X } from "lucide-react";
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
import { useWaTags, waFetch, type Tier, type TiersConfig, type WaBadges } from "./api";

const TIER_STYLE: Record<Tier, { bg: string; ring: string; text: string; icon: string }> = {
  sem_compra: { bg: "#eef2f7", ring: "#cbd5e1", text: "#475569", icon: "○" },
  bronze: {
    bg: "linear-gradient(135deg,#f3d1b0,#c98a52)",
    ring: "#b87333",
    text: "#5b3416",
    icon: "3",
  },
  prata: {
    bg: "linear-gradient(135deg,#f5f6f8,#b9bec7)",
    ring: "#9aa1ab",
    text: "#3f4650",
    icon: "2",
  },
  ouro: {
    bg: "linear-gradient(135deg,#fff3b0,#e0b23a)",
    ring: "#c9971c",
    text: "#5c4300",
    icon: "1",
  },
};
const TIER_NAME: Record<Tier, string> = {
  sem_compra: "Sem compra",
  bronze: "Bronze",
  prata: "Prata",
  ouro: "Ouro",
};

/** Small medal next to the name in the list. */
export function TierMedal({
  tier,
  className,
}: {
  tier?: Tier | null | undefined;
  className?: string;
}) {
  if (!tier) return null;
  const s = TIER_STYLE[tier];
  if (tier === "sem_compra")
    return (
      <span
        title="Ainda não comprou"
        className={cn(
          "rounded px-1 py-px text-[10px] font-medium text-[#64748b] ring-1 ring-[#cbd5e1]",
          className,
        )}
      >
        sem compra
      </span>
    );
  return (
    <span
      title={`Cliente ${TIER_NAME[tier]}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-px align-middle text-[10px] font-semibold",
        className,
      )}
      style={{ background: s.bg, color: s.text, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
    >
      ★ {TIER_NAME[tier]}
    </span>
  );
}

const money = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const TONE: Record<string, string> = {
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  danger: "bg-rose-50 text-rose-800 ring-rose-200",
};

/** The strip under the conversation header: level, automatic tags, manual tags, "+ tag". */
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
  const s = TIER_STYLE[badges.tier];

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
    .filter((t) => !badges.manual.includes(t))
    .filter((t) => !text || t.toLowerCase().includes(text.toLowerCase()))
    .slice(0, 12);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-l border-border bg-white px-4 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex cursor-default items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
              style={{ background: s.bg, color: s.text, boxShadow: `inset 0 0 0 1px ${s.ring}` }}
            >
              {badges.tier === "sem_compra" ? "○" : "★"} {badges.tier_label}
              {badges.orders > 0 && (
                <span className="font-normal opacity-80">
                  · {badges.orders} {badges.orders === 1 ? "pedido" : "pedidos"} ·{" "}
                  {money(Number(badges.revenue))}
                </span>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{badges.tip ?? badges.tier_label}</TooltipContent>
        </Tooltip>
        {badges.auto.map((t) => (
          <Tooltip key={t.key}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "cursor-default rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                  TONE[t.tone],
                )}
              >
                {t.label}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t.hint}</TooltipContent>
          </Tooltip>
        ))}
        {badges.manual.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-[#e7f3ff] px-2 py-0.5 text-xs font-medium text-[#075DA8] ring-1 ring-[#bfdbfe]"
          >
            <Tag className="size-3" /> {t}
            {canEdit && (
              <button
                type="button"
                aria-label={`Tirar a tag ${t}`}
                disabled={busy}
                onClick={() => void change(t, false)}
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
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-[#54656f] ring-1 ring-dashed ring-[#cbd5e1] hover:bg-[#f0f2f5]"
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
                  {suggestions.map((t) => (
                    <button
                      key={t}
                      type="button"
                      disabled={busy}
                      onClick={() => void change(t, true)}
                      className="rounded-full bg-[#f0f2f5] px-2 py-0.5 text-xs text-[#41525d] hover:bg-[#e7f3ff] hover:text-[#075DA8]"
                    >
                      {t}
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
    </TooltipProvider>
  );
}

/** Sales tip of the level plus the first opportunity, above the messages; can be hidden. */
export function SalesTip({ badges, onHide }: { badges: WaBadges; onHide: () => void }) {
  const lines = [badges.tip, ...badges.auto.slice(0, 2).map((t) => t.hint)].filter(
    Boolean,
  ) as string[];
  if (!lines.length) return null;
  return (
    <div className="mx-auto flex max-w-2xl items-start gap-2.5 rounded-xl border border-amber-200 bg-[#fffbeb]/95 px-3.5 py-2.5 text-[13px] text-[#78350f] shadow-sm backdrop-blur">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-semibold">Dica de venda · {badges.tier_label}</p>
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

/** Admin: thresholds, names and tips of the levels. */
export function TiersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const tags = useWaTags();
  const [cfg, setCfg] = useState<TiersConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const value = cfg ?? tags.data?.tiers ?? null;
  const set = (patch: (c: TiersConfig) => TiersConfig) =>
    value && setCfg(patch(structuredClone(value)));

  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      await waFetch("tags", { tiers: value });
      toast.success("Níveis salvos");
      await qc.invalidateQueries({ queryKey: ["wa"] });
      setCfg(null);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const num = (v: string) => Math.max(0, Number(v.replace(",", ".")) || 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Níveis do cliente</DialogTitle>
          <DialogDescription>
            Prata e Ouro: o cliente chega no nível com o número de pedidos pagos <strong>ou</strong>{" "}
            com o valor gasto (líquido de reembolsos). Bronze: 1 compra. A dica aparece para a
            atendente ao abrir a conversa.
          </DialogDescription>
        </DialogHeader>
        {!value ? (
          <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4">
            {(["sem_compra", "bronze", "prata", "ouro"] as const).map((k) => (
              <div key={k} className="rounded-xl border border-border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <TierMedal tier={k} />
                  <Input
                    value={value[k].label}
                    onChange={(e) => set((c) => ((c[k].label = e.target.value), c))}
                    className="h-8 w-40"
                  />
                  {(k === "prata" || k === "ouro") && (
                    <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      a partir de
                      <Input
                        value={String(value[k].orders)}
                        onChange={(e) => set((c) => ((c[k].orders = num(e.target.value)), c))}
                        className="h-8 w-14"
                        inputMode="numeric"
                      />
                      pedidos ou R$
                      <Input
                        value={String(value[k].revenue)}
                        onChange={(e) => set((c) => ((c[k].revenue = num(e.target.value)), c))}
                        className="h-8 w-20"
                        inputMode="decimal"
                      />
                    </span>
                  )}
                </div>
                <Textarea
                  value={value[k].tip}
                  onChange={(e) => set((c) => ((c[k].tip = e.target.value), c))}
                  rows={2}
                  className="text-sm"
                  placeholder="Dica de venda para este nível"
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              “Hora da recompra” após
              <Input
                value={String(value.repurchase_days)}
                onChange={(e) => set((c) => ((c.repurchase_days = num(e.target.value)), c))}
                className="h-8 w-14"
              />
              dias da última compra; “Sem comprar há…” após
              <Input
                value={String(value.inactive_days)}
                onChange={(e) => set((c) => ((c.inactive_days = num(e.target.value)), c))}
                className="h-8 w-14"
              />
              dias.
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => void save()} disabled={busy || !value}>
            {busy && <Loader2 className="size-4 animate-spin" />} Salvar níveis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
