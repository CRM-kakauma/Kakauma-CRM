import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CHANNEL_LABEL, summary, type Channel, type Content } from "@/lib/crm-messages";
import { fold, snippet } from "@/lib/crm-search";
import { cn } from "@/lib/utils";

export interface PickableTemplate {
  key: string;
  name: string;
  channel: Channel;
  content: Content;
}

/** Every text inside a template (subject, body, buttons, cards…). */
function textsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textsOf(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => textsOf(x, out));
  return out;
}

/** "Mensagem" of a send step: a list with a search box (by name or by the message's text). */
export function TemplatePicker({
  value,
  templates,
  onChange,
}: {
  value: string;
  templates: PickableTemplate[];
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = templates.find((t) => t.key === value);
  const indexed = useMemo(
    () => templates.map((t) => ({ t, texts: textsOf(t.content).filter((s) => s.length > 1) })),
    [templates],
  );
  const q = fold(query.trim());
  const shown = q
    ? indexed
        .map(({ t, texts }) => {
          const inName = fold(`${t.name} ${t.key}`).includes(q);
          const hitText = texts.find((s) => fold(s).includes(q));
          return inName || hitText ? { t, hitText: inName ? undefined : hitText } : null;
        })
        .filter((x): x is { t: PickableTemplate; hitText: string | undefined } => x !== null)
        // name matches first
        .sort((a, b) => Number(!!a.hitText) - Number(!!b.hitText))
    : indexed.map(({ t }) => ({ t, hitText: undefined }));

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-sm focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className={cn("truncate", !current && "text-muted-foreground")}>
            {current ? `${CHANNEL_LABEL[current.channel]} · ${current.name}` : "Escolha…"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector("input")?.focus();
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                e.preventDefault();
                onChange(shown[0].t.key);
                setOpen(false);
              }
            }}
            placeholder="Buscar pelo nome ou texto da mensagem"
            aria-label="Buscar mensagem"
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1" role="listbox">
          {shown.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nenhuma mensagem com “{query.trim()}”.
            </p>
          ) : (
            shown.map(({ t, hitText }) => {
              const sn = hitText ? snippet(hitText, query, 40) : null;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="option"
                  aria-selected={t.key === value}
                  onClick={() => {
                    onChange(t.key);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <Check
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      t.key === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">
                      <span className="text-muted-foreground">{CHANNEL_LABEL[t.channel]} ·</span>{" "}
                      {t.name}
                    </span>
                    <span className="line-clamp-1 text-[11px] text-muted-foreground">
                      {sn ? (
                        <>
                          {sn.before}
                          <mark className="rounded bg-warning-soft px-0.5 text-foreground">
                            {sn.hit}
                          </mark>
                          {sn.after}
                        </>
                      ) : (
                        summary(t.channel, t.content)
                      )}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className="w-full border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            Tirar a mensagem desta etapa
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
