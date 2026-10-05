import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Heading,
  Image as ImageIcon,
  Minus,
  MousePointerClick,
  MoveVertical,
  Plus,
  Trash2,
  Type,
} from "lucide-react";
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
import { SmsMeter } from "@/components/crm/simulators";
import { useCrm } from "@/lib/crm-api";
import {
  SAMPLE_CUSTOMER,
  VARIABLES,
  smsInfo,
  type Channel,
  type Content,
  type EmailBlock,
  type EmailContent,
  type RcsContent,
  type SmsContent,
  type WhatsappContent,
} from "@/lib/crm-messages";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ variables inserted at the cursor

type Target = { el: HTMLInputElement | HTMLTextAreaElement; apply: (v: string) => void } | null;
let lastTarget: Target = null;

/** Remembers the focused field; the ref always holds the latest onChange (no stale content). */
function useTrack(onChange: (v: string) => void) {
  const ref = useRef(onChange);
  ref.current = onChange;
  return (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    lastTarget = { el: e.currentTarget, apply: (v) => ref.current(v) };
  };
}

export function VariableBar() {
  const insert = (key: string) => {
    const t = lastTarget;
    if (!t || !document.body.contains(t.el)) return;
    const tag = `{{${key}}}`;
    const start = t.el.selectionStart ?? t.el.value.length;
    const end = t.el.selectionEnd ?? start;
    t.apply(t.el.value.slice(0, start) + tag + t.el.value.slice(end));
    requestAnimationFrame(() => {
      t.el.focus();
      t.el.setSelectionRange(start + tag.length, start + tag.length);
    });
  };
  return (
    <div className="rounded-lg border border-dashed border-border p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Personalize: clique em um campo de texto e depois na variável. Se o cliente não tiver o
        dado, ela fica vazia.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {VARIABLES.map((v) => (
          <button
            key={v.key}
            type="button"
            // keep the focus (and cursor) in the field being edited
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(v.key)}
            className="rounded-md bg-primary-soft px-2 py-1 font-mono text-[11px] text-primary hover:bg-primary/15"
            title={v.label}
          >
            {`{{${v.key}}}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  count,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  count?: [number, number];
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-end justify-between gap-2">
        <Label>{label}</Label>
        {count && (
          <span
            className={cn(
              "text-[11px] text-muted-foreground",
              count[0] > count[1] && "font-medium text-danger",
            )}
          >
            {count[0]}/{count[1]}
          </span>
        )}
      </div>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function TextIn({
  value,
  onChange,
  placeholder,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  max?: number;
}) {
  const onFocus = useTrack(onChange);
  return (
    <Input
      value={value}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      maxLength={max ? max * 2 : undefined}
    />
  );
}

function TextArea({
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const onFocus = useTrack(onChange);
  return (
    <Textarea
      rows={rows}
      value={value}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Pick<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Move({
  i,
  n,
  onMove,
  onDelete,
}: {
  i: number;
  n: number;
  onMove: (to: number) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        disabled={i === 0}
        onClick={() => onMove(i - 1)}
        aria-label="Subir"
      >
        <ArrowUp className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        disabled={i === n - 1}
        onClick={() => onMove(i + 1)}
        aria-label="Descer"
      >
        <ArrowDown className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={onDelete}
        aria-label="Remover"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}

const move = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
};

export function ChannelEditor({
  channel,
  content,
  onChange,
}: {
  channel: Channel;
  content: Content;
  onChange: (c: Content) => void;
}) {
  switch (channel) {
    case "email":
      return <EmailEditor c={content as EmailContent} set={onChange} />;
    case "sms":
      return <SmsEditor c={content as SmsContent} set={onChange} />;
    case "whatsapp":
      return <WhatsappEditor c={content as WhatsappContent} set={onChange} />;
    case "rcs":
      return <RcsEditor c={content as RcsContent} set={onChange} />;
  }
}

// ------------------------------------------------------------------ e-mail

const BLOCKS: {
  type: EmailBlock["type"];
  label: string;
  icon: typeof Type;
  make: () => EmailBlock;
}[] = [
  {
    type: "heading",
    label: "Título",
    icon: Heading,
    make: () => ({ type: "heading", text: "Título" }),
  },
  { type: "text", label: "Texto", icon: Type, make: () => ({ type: "text", text: "" }) },
  {
    type: "button",
    label: "Botão",
    icon: MousePointerClick,
    make: () => ({ type: "button", text: "Saiba mais", url: "https://" }),
  },
  {
    type: "image",
    label: "Imagem",
    icon: ImageIcon,
    make: () => ({ type: "image", url: "https://", alt: "" }),
  },
  { type: "divider", label: "Divisor", icon: Minus, make: () => ({ type: "divider" }) },
  {
    type: "spacer",
    label: "Espaço",
    icon: MoveVertical,
    make: () => ({ type: "spacer", size: 24 }),
  },
];

function EmailEditor({ c, set }: { c: EmailContent; set: (c: EmailContent) => void }) {
  const upd = (patch: Partial<EmailContent>) => set({ ...c, ...patch });
  const setBlock = (i: number, b: EmailBlock) =>
    upd({ blocks: c.blocks.map((x, j) => (j === i ? b : x)) });
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Assunto"
          count={[c.subject.length, 150]}
          hint="Até ~50 caracteres aparece inteiro no celular."
        >
          <TextIn value={c.subject} onChange={(v) => upd({ subject: v })} />
        </Field>
        <Field
          label="Pré-cabeçalho"
          count={[(c.preheader ?? "").length, 200]}
          hint="O resumo cinza ao lado do assunto na caixa de entrada."
        >
          <TextIn value={c.preheader ?? ""} onChange={(v) => upd({ preheader: v })} />
        </Field>
        <Field label="Nome do remetente">
          <TextIn value={c.from_name ?? ""} onChange={(v) => upd({ from_name: v })} />
        </Field>
        <Field label="Cor de destaque" hint="Botões e faixa do topo.">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={c.accent ?? "#075DA8"}
              onChange={(e) => upd({ accent: e.target.value })}
              className="h-9 w-12 cursor-pointer rounded border border-input"
              aria-label="Cor de destaque"
            />
            <span className="font-mono text-xs text-muted-foreground">{c.accent ?? "#075DA8"}</span>
          </div>
        </Field>
      </div>

      <div className="space-y-2">
        <Label>Conteúdo</Label>
        {c.blocks.map((b, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {BLOCKS.find((x) => x.type === b.type)?.label}
              </span>
              <Move
                i={i}
                n={c.blocks.length}
                onMove={(to) => upd({ blocks: move(c.blocks, i, to) })}
                onDelete={() => upd({ blocks: c.blocks.filter((_, j) => j !== i) })}
              />
            </div>
            {(b.type === "heading" || b.type === "button") && (
              <TextIn
                value={b.text}
                onChange={(v) => setBlock(i, { ...b, text: v })}
                placeholder="Texto"
              />
            )}
            {b.type === "text" && (
              <TextArea value={b.text} onChange={(v) => setBlock(i, { ...b, text: v })} rows={4} />
            )}
            {b.type === "button" && (
              <div className="mt-2">
                <TextIn
                  value={b.url}
                  onChange={(v) => setBlock(i, { ...b, url: v })}
                  placeholder="https://"
                />
              </div>
            )}
            {b.type === "image" && (
              <div className="grid gap-2">
                <TextIn
                  value={b.url}
                  onChange={(v) => setBlock(i, { ...b, url: v })}
                  placeholder="Link da imagem (https://…)"
                />
                <TextIn
                  value={b.alt ?? ""}
                  onChange={(v) => setBlock(i, { ...b, alt: v })}
                  placeholder="Descrição (para quem não vê a imagem)"
                />
                <TextIn
                  value={b.link ?? ""}
                  onChange={(v) => setBlock(i, { ...b, link: v })}
                  placeholder="Ao clicar, abrir (opcional)"
                />
              </div>
            )}
            {(b.type === "heading" || b.type === "text" || b.type === "button") && (
              <div className="mt-2 w-40">
                <Pick
                  value={b.align ?? "left"}
                  onChange={(v) => setBlock(i, { ...b, align: v })}
                  options={[
                    ["left", "Alinhar à esquerda"],
                    ["center", "Centralizar"],
                  ]}
                />
              </div>
            )}
            {b.type === "spacer" && (
              <Pick
                value={String(b.size ?? 24) as "12" | "24" | "48"}
                onChange={(v) => setBlock(i, { ...b, size: Number(v) })}
                options={[
                  ["12", "Pequeno"],
                  ["24", "Médio"],
                  ["48", "Grande"],
                ]}
              />
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-1.5">
          {BLOCKS.map((k) => (
            <Button
              key={k.type}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => upd({ blocks: [...c.blocks, k.make()] })}
            >
              <k.icon className="size-3.5" /> {k.label}
            </Button>
          ))}
        </div>
      </div>
      <Field
        label="Rodapé"
        hint="Identifique a empresa e diga por que a pessoa recebe. Em marketing, informe como deixar de receber."
      >
        <TextIn value={c.footer ?? ""} onChange={(v) => upd({ footer: v })} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ SMS

function SmsEditor({ c, set }: { c: SmsContent; set: (c: SmsContent) => void }) {
  return (
    <div className="space-y-3">
      <Field
        label="Texto"
        hint="Comece com o nome da marca (ex.: “Kakauma:”). Links curtos ajudam. Evite acentos para caber 160 caracteres por SMS."
      >
        <TextArea value={c.text} onChange={(v) => set({ text: v })} rows={6} />
      </Field>
      <SmsMeter info={smsInfo(c.text)} />
    </div>
  );
}

// ------------------------------------------------------------------ WhatsApp

function WhatsappEditor({ c, set }: { c: WhatsappContent; set: (c: WhatsappContent) => void }) {
  const upd = (patch: Partial<WhatsappContent>) => set({ ...c, ...patch });
  const header = c.header ?? { type: "none" };
  const buttons = c.buttons ?? [];
  const nUrl = buttons.filter((b) => b.type === "url").length;
  const nPhone = buttons.filter((b) => b.type === "phone").length;
  return (
    <div className="space-y-4">
      <Field
        label="Categoria"
        hint={
          c.category === "utility"
            ? "Utilidade: sobre algo que a pessoa já fez (pedido, pagamento, entrega). Custo menor e aprovação mais fácil."
            : "Marketing: ofertas, novidades, reativação. A Meta cobra mais e a pessoa pode bloquear com um toque."
        }
      >
        <Pick
          value={c.category}
          onChange={(v) => upd({ category: v })}
          options={[
            ["marketing", "Marketing"],
            ["utility", "Utilidade (transacional)"],
          ]}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
        <Field label="Cabeçalho">
          <Pick
            value={header.type}
            onChange={(v) => upd({ header: { type: v } })}
            options={[
              ["none", "Nenhum"],
              ["text", "Texto"],
              ["image", "Imagem"],
            ]}
          />
        </Field>
        {header.type === "text" && (
          <Field label="Texto do cabeçalho" count={[(header.text ?? "").length, 60]}>
            <TextIn
              value={header.text ?? ""}
              onChange={(v) => upd({ header: { ...header, text: v } })}
            />
          </Field>
        )}
        {header.type === "image" && (
          <Field label="Link da imagem">
            <TextIn
              value={header.url ?? ""}
              onChange={(v) => upd({ header: { ...header, url: v } })}
              placeholder="https://"
            />
          </Field>
        )}
      </div>
      <Field
        label="Mensagem"
        count={[c.body.length, 1024]}
        hint="*negrito*  _itálico_  ~riscado~  ```mono```"
      >
        <TextArea value={c.body} onChange={(v) => upd({ body: v })} rows={6} />
      </Field>
      <Field label="Rodapé (opcional)" count={[(c.footer ?? "").length, 60]}>
        <TextIn value={c.footer ?? ""} onChange={(v) => upd({ footer: v })} />
      </Field>
      <div className="space-y-2">
        <Label>Botões ({buttons.length}/3)</Label>
        {buttons.map((b, i) => (
          <div
            key={i}
            className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto]"
          >
            <TextIn
              value={b.text}
              onChange={(v) =>
                upd({ buttons: buttons.map((x, j) => (j === i ? { ...x, text: v } : x)) })
              }
              placeholder={b.type === "quick_reply" ? "Resposta rápida" : "Texto do botão"}
            />
            {b.type === "url" ? (
              <TextIn
                value={b.url ?? ""}
                onChange={(v) =>
                  upd({ buttons: buttons.map((x, j) => (j === i ? { ...x, url: v } : x)) })
                }
                placeholder="https://"
              />
            ) : b.type === "phone" ? (
              <TextIn
                value={b.phone ?? ""}
                onChange={(v) =>
                  upd({ buttons: buttons.map((x, j) => (j === i ? { ...x, phone: v } : x)) })
                }
                placeholder="+55 11 99999-9999"
              />
            ) : (
              <span className="self-center text-xs text-muted-foreground">
                a pessoa toca e a resposta chega para vocês
              </span>
            )}
            <Move
              i={i}
              n={buttons.length}
              onMove={(to) => upd({ buttons: move(buttons, i, to) })}
              onDelete={() => upd({ buttons: buttons.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        {buttons.length < 3 && (
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => upd({ buttons: [...buttons, { type: "quick_reply", text: "" }] })}
            >
              <Plus className="size-3.5" /> Resposta rápida
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={nUrl >= 2}
              onClick={() =>
                upd({ buttons: [...buttons, { type: "url", text: "", url: "https://" }] })
              }
            >
              <Plus className="size-3.5" /> Link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={nPhone >= 1}
              onClick={() =>
                upd({ buttons: [...buttons, { type: "phone", text: "Ligar", phone: "" }] })
              }
            >
              <Plus className="size-3.5" /> Ligar
            </Button>
          </div>
        )}
      </div>
      <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
        Fora da janela de 24h de conversa, o WhatsApp só entrega mensagens de modelos aprovados pela
        Meta. Ao conectar o canal, este modelo precisa ser enviado para aprovação com o mesmo texto.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ RCS

function RcsEditor({ c, set }: { c: RcsContent; set: (c: RcsContent) => void }) {
  const upd = (patch: Partial<RcsContent>) => set({ ...c, ...patch });
  const cards = c.cards ?? [];
  const sugg = c.suggestions ?? [];
  return (
    <div className="space-y-4">
      <Field
        label="Formato"
        hint="RCS é o “SMS rico” do Android (app Mensagens): mostra marca verificada, imagens e botões. iPhone e aparelhos sem RCS recebem o SMS alternativo."
      >
        <Pick
          value={c.kind}
          onChange={(v) =>
            upd({
              kind: v,
              cards:
                v === "carousel" && cards.length < 2
                  ? [
                      ...cards,
                      ...Array.from({ length: 2 - cards.length }, () => ({
                        title: "",
                        description: "",
                        media_url: "",
                        media_height: "medium" as const,
                      })),
                    ]
                  : v === "card"
                    ? cards.slice(0, 1).length
                      ? cards.slice(0, 1)
                      : [{ title: "", media_height: "medium" as const }]
                    : cards,
            })
          }
          options={[
            ["text", "Só texto"],
            ["card", "Cartão (imagem + título + botões)"],
            ["carousel", "Carrossel (2 a 10 cartões)"],
          ]}
        />
      </Field>
      {c.kind === "text" ? (
        <Field label="Texto" count={[(c.text ?? "").length, 2000]}>
          <TextArea value={c.text ?? ""} onChange={(v) => upd({ text: v })} rows={5} />
        </Field>
      ) : (
        <div className="space-y-2">
          {cards.map((k, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Cartão {i + 1}</span>
                {c.kind === "carousel" && (
                  <Move
                    i={i}
                    n={cards.length}
                    onMove={(to) => upd({ cards: move(cards, i, to) })}
                    onDelete={() =>
                      cards.length > 2 && upd({ cards: cards.filter((_, j) => j !== i) })
                    }
                  />
                )}
              </div>
              <TextIn
                value={k.title}
                onChange={(v) =>
                  upd({ cards: cards.map((x, j) => (j === i ? { ...x, title: v } : x)) })
                }
                placeholder="Título"
              />
              <TextArea
                value={k.description ?? ""}
                onChange={(v) =>
                  upd({ cards: cards.map((x, j) => (j === i ? { ...x, description: v } : x)) })
                }
                rows={3}
                placeholder="Descrição"
              />
              <div className="grid gap-2 sm:grid-cols-[1fr_160px]">
                <TextIn
                  value={k.media_url ?? ""}
                  onChange={(v) =>
                    upd({ cards: cards.map((x, j) => (j === i ? { ...x, media_url: v } : x)) })
                  }
                  placeholder="Imagem (https://…)"
                />
                <Pick
                  value={k.media_height ?? "medium"}
                  onChange={(v) =>
                    upd({ cards: cards.map((x, j) => (j === i ? { ...x, media_height: v } : x)) })
                  }
                  options={[
                    ["short", "Imagem baixa"],
                    ["medium", "Imagem média"],
                    ["tall", "Imagem alta"],
                  ]}
                />
              </div>
            </div>
          ))}
          {c.kind === "carousel" && cards.length < 10 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => upd({ cards: [...cards, { title: "", media_height: "medium" }] })}
            >
              <Plus className="size-3.5" /> Cartão
            </Button>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Label>Sugestões / botões ({sugg.length}/4)</Label>
        {sugg.map((s, i) => (
          <div
            key={i}
            className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[140px_1fr_1fr_auto]"
          >
            <Pick
              value={s.type}
              onChange={(v) =>
                upd({ suggestions: sugg.map((x, j) => (j === i ? { ...x, type: v } : x)) })
              }
              options={[
                ["reply", "Resposta"],
                ["url", "Abrir link"],
                ["dial", "Ligar"],
              ]}
            />
            <TextIn
              value={s.text}
              onChange={(v) =>
                upd({ suggestions: sugg.map((x, j) => (j === i ? { ...x, text: v } : x)) })
              }
              placeholder="Texto (até 25)"
            />
            {s.type === "url" ? (
              <TextIn
                value={s.url ?? ""}
                onChange={(v) =>
                  upd({ suggestions: sugg.map((x, j) => (j === i ? { ...x, url: v } : x)) })
                }
                placeholder="https://"
              />
            ) : s.type === "dial" ? (
              <TextIn
                value={s.phone ?? ""}
                onChange={(v) =>
                  upd({ suggestions: sugg.map((x, j) => (j === i ? { ...x, phone: v } : x)) })
                }
                placeholder="+55…"
              />
            ) : (
              <span />
            )}
            <Move
              i={i}
              n={sugg.length}
              onMove={(to) => upd({ suggestions: move(sugg, i, to) })}
              onDelete={() => upd({ suggestions: sugg.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        {sugg.length < 4 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => upd({ suggestions: [...sugg, { type: "reply", text: "" }] })}
          >
            <Plus className="size-3.5" /> Sugestão
          </Button>
        )}
      </div>
      <Field
        label="SMS alternativo"
        hint="Enviado para quem não tem RCS (iPhone, aparelhos antigos). Obrigatório."
      >
        <TextArea value={c.fallback_sms} onChange={(v) => upd({ fallback_sms: v })} rows={3} />
      </Field>
      <SmsMeter info={smsInfo(c.fallback_sms)} />
    </div>
  );
}

// ------------------------------------------------------------------ preview customer

/** "Ver como": sample data or a real customer (their data fills the variables). */
export function PreviewAs({
  onVars,
}: {
  onVars: (v: Record<string, unknown>, label: string) => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data } = useCrm<
    { customer_id: string; full_name: string | null; email: string | null }[]
  >(
    "crm_search_customers",
    { p_query: debounced || null, p_limit: 8 },
    { enabled: open && debounced.length >= 2 },
  );
  return (
    <div className="relative" ref={box}>
      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          placeholder="Ver como um cliente real (nome ou e-mail)…"
          className="h-8 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 shrink-0 text-xs"
          onClick={() => {
            setQ("");
            onVars(SAMPLE_CUSTOMER, "Cliente de exemplo");
          }}
        >
          Exemplo
        </Button>
      </div>
      {open && debounced.length >= 2 && (data?.length ?? 0) > 0 && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          {data!.map((c) => (
            <button
              key={c.customer_id}
              type="button"
              className="block w-full px-3 py-2 text-left text-xs hover:bg-muted"
              onClick={async () => {
                setOpen(false);
                setQ(c.full_name ?? c.email ?? "");
                const { crmCall } = await import("@/lib/crm-api");
                const v = await crmCall<Record<string, unknown>>("crm_message_customer", {
                  p_customer_id: c.customer_id,
                });
                onVars(v, c.full_name ?? c.email ?? "cliente");
              }}
            >
              <span className="font-medium">{c.full_name ?? "—"}</span>{" "}
              <span className="text-muted-foreground">{c.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
