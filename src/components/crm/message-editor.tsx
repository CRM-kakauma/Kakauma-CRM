import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Code,
  Copy,
  FileUp,
  Link2,
  Heading,
  LayoutList,
  Image as ImageIcon,
  Minus,
  MousePointerClick,
  MoveVertical,
  Plus,
  RefreshCw,
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
import { mapText, ownDomain, tagText, tagUrl, type UtmContext } from "@/lib/crm-utm";
import { useChannels } from "@/components/crm/channels";
import { useQuery } from "@tanstack/react-query";
import { contentFromTemplate, usableTemplates, type MetaTemplate } from "@/lib/crm-whatsapp";
import { toast } from "sonner";
import { crmCall, useCrm } from "@/lib/crm-api";
import {
  EMAIL_HTML_MAX,
  SAMPLE_CUSTOMER,
  VARIABLES,
  blocksToHtml,
  smsInfo,
  waPlaceholders,
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
      {(
        [
          ["Cliente", VARIABLES.filter((v) => !v.group)],
          [
            "Pedido (do evento da B4you que disparou o fluxo)",
            VARIABLES.filter((v) => v.group === "pedido"),
          ],
          [
            "Rastreamento — links para kakauma.com.br recebem os UTMs sozinhos (também os já escritos)",
            VARIABLES.filter((v) => v.group === "utm"),
          ],
        ] as const
      ).map(([title, vars]) => (
        <div key={title} className="mt-2 first:mt-0">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</p>
          <div className="flex flex-wrap gap-1.5">
            {vars.map((v) => (
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
      ))}
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
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  const onFocus = useTrack(onChange);
  return (
    <Textarea
      rows={rows}
      value={value}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      className={className}
      spellCheck={className?.includes("font-mono") ? false : undefined}
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
  utm,
}: {
  channel: Channel;
  content: Content;
  onChange: (c: Content) => void;
  /** the UTMs links will get when sent, so SMS counters show the real size */
  utm?: UtmContext | undefined;
}) {
  switch (channel) {
    case "email":
      return <EmailEditor c={content as EmailContent} set={onChange} />;
    case "sms":
      return <SmsEditor c={content as SmsContent} set={onChange} utm={utm} />;
    case "whatsapp":
      return <WhatsappEditor c={content as WhatsappContent} set={onChange} utm={utm} />;
    case "rcs":
      return <RcsEditor c={content as RcsContent} set={onChange} utm={utm} />;
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
  const isHtml = c.format === "html";
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-border p-0.5" role="radiogroup">
        {(
          [
            ["blocks", "Montar com blocos", LayoutList],
            ["html", "HTML próprio", Code],
          ] as const
        ).map(([f, label, Icon]) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={(c.format ?? "blocks") === f}
            onClick={() =>
              upd(
                f === "html"
                  ? // first switch: start from the current blocks so nothing is lost
                    { format: "html", html: c.html?.trim() ? c.html : blocksToHtml(c) }
                  : { format: "blocks" },
              )
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
              (c.format ?? "blocks") === f
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

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
        {!isHtml && (
          <Field label="Cor de destaque" hint="Botões e faixa do topo.">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={c.accent ?? "#075DA8"}
                onChange={(e) => upd({ accent: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-input"
                aria-label="Cor de destaque"
              />
              <span className="font-mono text-xs text-muted-foreground">
                {c.accent ?? "#075DA8"}
              </span>
            </div>
          </Field>
        )}
      </div>

      {isHtml ? (
        <HtmlField c={c} upd={upd} />
      ) : (
        <>
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
                  <TextArea
                    value={b.text}
                    onChange={(v) => setBlock(i, { ...b, text: v })}
                    rows={4}
                  />
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
        </>
      )}
    </div>
  );
}

function HtmlField({ c, upd }: { c: EmailContent; upd: (p: Partial<EmailContent>) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const html = c.html ?? "";
  const [err, setErr] = useState<string | null>(null);
  return (
    <Field
      label="HTML do e-mail"
      count={[html.length, EMAIL_HTML_MAX]}
      hint={
        <>
          Cole o HTML pronto (de um editor de e-mail, agência ou arquivo .html) ou edite aqui. As
          variáveis como <code className="font-mono">{"{{first_name}}"}</code> funcionam e o
          simulador ao lado mostra o resultado. Imagens precisam estar publicadas na internet
          (https://). Scripts e formulários não são permitidos. Em e-mails de marketing, inclua um
          link para deixar de receber.
        </>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" onClick={() => file.current?.click()}>
          <FileUp className="size-3.5" /> Importar arquivo .html
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            (!html.trim() ||
              window.confirm("Substituir o HTML atual pelo layout montado com os blocos?")) &&
            upd({ html: blocksToHtml(c) })
          }
        >
          <LayoutList className="size-3.5" /> Gerar a partir dos blocos
        </Button>
        <input
          ref={file}
          type="file"
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > EMAIL_HTML_MAX * 2) {
              setErr("Arquivo grande demais para um e-mail (máximo ~100 KB).");
              return;
            }
            setErr(null);
            void f.text().then((t) => upd({ html: t }));
          }}
        />
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
      <TextArea
        value={html}
        onChange={(v) => upd({ html: v })}
        rows={18}
        placeholder="<html>…</html>"
        className="font-mono text-xs leading-relaxed"
      />
    </Field>
  );
}

// ------------------------------------------------------------------ SMS

/** Long store link with this message's UTMs, to copy into a link shortener. */
function UtmLinkBuilder({ utm }: { utm?: UtmContext | undefined }) {
  const [page, setPage] = useState("https://kakauma.com.br/");
  const [short, setShort] = useState<{ long: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!utm) return null;
  let url = "";
  let problem = "";
  try {
    const u = new URL(page.trim());
    url = tagUrl(u.toString(), utm);
    if (!ownDomain(u.hostname.toLowerCase())) problem = "Use um endereço do kakauma.com.br.";
  } catch {
    problem = "Cole o endereço completo da página (com https://).";
  }
  const noFlow = utm.campaign === "nome_do_fluxo";
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Link copiado"))
      .catch(() => toast.error("Não foi possível copiar; selecione e copie à mão"));
  const shorten = async () => {
    setBusy(true);
    try {
      const r = await crmCall<{ code: string }>("crm_create_short_link", { p_url: url });
      // VITE_SHORT_LINK_BASE: a short domain of yours pointing to this CRM (e.g. https://k.kakauma.com.br)
      const base =
        (import.meta.env["VITE_SHORT_LINK_BASE"] as string | undefined)?.replace(/\/+$/, "") ||
        window.location.origin;
      setShort({ long: url, url: `${base}/l/${r.code}` });
    } catch (e) {
      toast.error("Não encurtou", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-dashed border-border p-3">
      <p className="text-xs font-medium">Gerar link com UTM (para encurtar)</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Cole a página do site. O link abaixo já tem canal ({utm.channel}), fluxo e mensagem. Clique
        em “Encurtar” e use o link curto no texto (ou copie o longo para outro encurtador) — o CRM
        não mexe em link curto.
      </p>
      <Input
        value={page}
        onChange={(e) => setPage(e.target.value)}
        placeholder="https://kakauma.com.br/produto"
        className="mt-2 h-8 text-xs"
      />
      {problem ? (
        <p className="mt-2 text-[11px] text-destructive">{problem}</p>
      ) : (
        <div className="mt-2 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 text-[11px]">
            {url}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={() => copy(url)}
          >
            <Copy className="size-3.5" /> Copiar
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 text-xs"
            disabled={busy}
            onClick={() => void shorten()}
          >
            <Link2 className="size-3.5" /> {busy ? "Encurtando…" : "Encurtar"}
          </Button>
        </div>
      )}
      {!problem && short?.long === url && (
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-primary-soft px-2 py-1.5 text-xs font-medium text-primary">
            {short.url}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={() => copy(short.url)}
          >
            <Copy className="size-3.5" /> Copiar curto
          </Button>
        </div>
      )}
      {noFlow && (
        <p className="mt-2 text-[11px] text-warning-foreground">
          Esta mensagem ainda não está em nenhum fluxo: coloque-a no fluxo e volte aqui para o link
          sair com o nome dele (ou escolha o fluxo em “Ver links como no fluxo”, ao lado).
        </p>
      )}
    </div>
  );
}

/** SMS size as sent: store links with their UTMs, or as CRM click links when tracking is on. */
function SentSmsMeter({ text, utm }: { text: string; utm?: UtmContext | undefined }) {
  const { data: ch } = useChannels();
  const tracking = ch?.link_tracking?.base;
  const sent = tracking
    ? mapText(text, (u) => {
        try {
          return ownDomain(new URL(u).hostname.toLowerCase()) ? `${tracking}/l/XXXXXXX` : u;
        } catch {
          return u;
        }
      })
    : utm
      ? tagText(text, utm)
      : text;
  const extra = sent.length - text.length;
  return (
    <>
      <SmsMeter info={smsInfo(sent)} />
      {tracking && sent !== text && (
        <p className="text-[11px] text-muted-foreground">
          No envio, o link do site vira um link curto do CRM ({tracking}/l/…) que conta o clique e
          leva à página com os UTMs — o contador já considera esse tamanho.
        </p>
      )}
      {!tracking && extra > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Já conta +{extra} caracteres dos UTMs que o envio coloca no link do site (o nome do fluxo
          pode mudar um pouco o tamanho). Para economizar, use um link curto já com os UTMs.
        </p>
      )}
    </>
  );
}

function SmsEditor({
  c,
  set,
  utm,
}: {
  c: SmsContent;
  set: (c: SmsContent) => void;
  utm?: UtmContext | undefined;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Texto"
        hint="Comece com o nome da marca (ex.: “Kakauma:”). Links curtos ajudam. Evite acentos para caber 160 caracteres por SMS."
      >
        <TextArea value={c.text} onChange={(v) => set({ text: v })} rows={6} />
      </Field>
      <SentSmsMeter text={c.text} utm={utm} />
      <UtmLinkBuilder utm={utm} />
    </div>
  );
}

// ------------------------------------------------------------------ WhatsApp

function useWaTemplates(enabled: boolean) {
  return useQuery({
    queryKey: ["crm-wa-templates"],
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch("/api/crm/whatsapp/templates", { credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as {
        templates?: MetaTemplate[];
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      return body.templates ?? [];
    },
  });
}

/** Link to a template approved in the Meta panel: its texts come from there. */
function WaTemplateLink({ c, set }: { c: WhatsappContent; set: (c: WhatsappContent) => void }) {
  const { data: ch } = useChannels();
  const wa = ch?.whatsapp;
  const evolution = wa?.provider === "evolution";
  const q = useWaTemplates(!evolution && !!wa?.configured && !!wa.templates);
  const all = q.data ?? [];
  const usable = usableTemplates(all);
  const id = (t: { name: string; language: string }) => `${t.name}|${t.language}`;
  const current = c.meta ? id(c.meta) : "";
  const pending = all.filter((t) => t.status.toUpperCase() !== "APPROVED").length;
  if (evolution && !c.meta)
    return (
      <p className="rounded-lg bg-primary-soft px-3 py-2 text-xs text-primary">
        WhatsApp conectado pela Evolution API: a mensagem sai como texto (com a imagem do cabeçalho,
        se houver), a qualquer hora, sem modelo da Meta. Botões de link e de código entram no texto;
        respostas rápidas não aparecem.
      </p>
    );
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label>Modelo aprovado na Meta</Label>
        {wa?.configured && wa.templates && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className={cn("size-3.5", q.isFetching && "animate-spin")} /> Atualizar
          </Button>
        )}
      </div>
      {!wa?.configured ? (
        <p className="text-xs text-muted-foreground">
          Conecte a API oficial do WhatsApp (WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID na Vercel)
          para escolher um modelo aprovado. Sem modelo, a mensagem só chega dentro da janela de 24h
          depois que o cliente escreveu.
        </p>
      ) : !wa.templates ? (
        <p className="text-xs text-muted-foreground">
          Coloque WHATSAPP_WABA_ID na Vercel para listar os modelos da conta.
        </p>
      ) : q.error ? (
        <p className="text-xs text-danger">{(q.error as Error).message}</p>
      ) : (
        <>
          <Select
            value={current}
            onValueChange={(v) => {
              const t = usable.find((x) => id(x) === v);
              if (t) set(contentFromTemplate(t, c));
            }}
          >
            <SelectTrigger className="h-9">
              <SelectValue placeholder={q.isLoading ? "Carregando…" : "Escolha um modelo"} />
            </SelectTrigger>
            <SelectContent>
              {usable.map((t) => (
                <SelectItem key={id(t)} value={id(t)}>
                  {t.name} · {t.language} · {t.category.toLowerCase()}
                </SelectItem>
              ))}
              {c.meta && !usable.some((t) => id(t) === current) && (
                <SelectItem value={current}>
                  {c.meta.name} · {c.meta.language} (não aprovado agora)
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {usable.length} aprovado(s)
            {pending ? ` · ${pending} em análise, recusado(s) ou pausado(s) não aparecem` : ""}. Os
            modelos são criados e aprovados no WhatsApp Manager da Meta.
          </p>
        </>
      )}
      {c.meta && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-primary-soft px-2 py-1.5 text-xs text-primary">
          <span>
            Vinculada a <b>{c.meta.name}</b> ({c.meta.language}): os textos são os aprovados na
            Meta; aqui você preenche as variáveis.
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 shrink-0"
            onClick={() => set({ ...c, meta: null })}
          >
            Desvincular
          </Button>
        </div>
      )}
    </div>
  );
}

/** Values of the approved template's variables ({{1}}, {{nome}}…), which may use CRM variables. */
function WaTemplateParams({ c, set }: { c: WhatsappContent; set: (c: WhatsappContent) => void }) {
  const m = c.meta!;
  const header = c.header ?? { type: "none" };
  const upd = (key: "params" | "header_params" | "button_params", k: string, v: string) =>
    set({ ...c, meta: { ...m, [key]: { ...(m[key] ?? {}), [k]: v } } });
  const media = header.type === "image" || header.type === "video" || header.type === "document";
  const hint =
    m.format === "named"
      ? "Vazio = a variável do CRM com o mesmo nome."
      : "Use texto fixo e/ou variáveis do CRM (ex.: {{first_name}}).";
  const bodyKeys = waPlaceholders(c.body);
  const headerKeys = header.type === "text" ? waPlaceholders(header.text) : [];
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/50 p-3 text-xs">
        {header.type === "text" && header.text && <p className="font-semibold">{header.text}</p>}
        <p className="whitespace-pre-wrap">{c.body}</p>
        {c.footer && <p className="mt-1 text-muted-foreground">{c.footer}</p>}
      </div>
      {media && (
        <Field
          label={`Link ${header.type === "image" ? "da imagem" : header.type === "video" ? "do vídeo" : "do documento"} do cabeçalho`}
          hint="Obrigatório: o modelo tem cabeçalho de mídia. Endereço público (https)."
        >
          <TextIn
            value={header.url ?? ""}
            onChange={(v) => set({ ...c, header: { ...header, url: v } })}
            placeholder="https://"
          />
        </Field>
      )}
      {headerKeys.map((k) => (
        <Field key={`h${k}`} label={`Cabeçalho {{${k}}}`} hint={hint}>
          <TextIn value={m.header_params?.[k] ?? ""} onChange={(v) => upd("header_params", k, v)} />
        </Field>
      ))}
      {bodyKeys.length === 0 && (
        <p className="text-xs text-muted-foreground">Este modelo não tem variáveis no texto.</p>
      )}
      {bodyKeys.map((k) => (
        <Field key={`b${k}`} label={`Mensagem {{${k}}}`} hint={hint}>
          <TextIn
            value={m.params?.[k] ?? ""}
            onChange={(v) => upd("params", k, v)}
            placeholder={m.format === "named" ? `{{${k}}}` : "ex.: {{first_name}}"}
          />
        </Field>
      ))}
      {(c.buttons ?? []).map((b, i) =>
        b.type === "url" && waPlaceholders(b.url).length ? (
          <Field
            key={`u${i}`}
            label={`Botão “${b.text}” — final do link`}
            hint={`O link é ${b.url}: escreva o que entra no lugar da variável (ex.: produtos/sleep-drink). Links da loja recebem os UTMs.`}
          >
            <TextIn
              value={m.button_params?.[String(i)] ?? ""}
              onChange={(v) => upd("button_params", String(i), v)}
            />
          </Field>
        ) : b.type === "copy_code" ? (
          <Field key={`c${i}`} label={`Botão “${b.text}” — código do cupom`}>
            <TextIn
              value={m.button_params?.[String(i)] ?? ""}
              onChange={(v) => upd("button_params", String(i), v)}
              placeholder="ex.: VOLTA10"
            />
          </Field>
        ) : null,
      )}
    </div>
  );
}

/** Store links in a WhatsApp message: in the send they become CRM short links that count clicks. */
function WaLinkNote({ texts }: { texts: (string | undefined)[] }) {
  const { data: ch } = useChannels();
  const tracking = ch?.link_tracking?.base;
  let has = false;
  for (const t of texts)
    mapText(t ?? "", (u) => {
      try {
        if (ownDomain(new URL(u).hostname.toLowerCase())) has = true;
      } catch {
        /* not a link */
      }
      return u;
    });
  if (!has) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      {tracking
        ? `No envio, cada link do site vira um link curto do CRM (${tracking}/l/…) que conta o clique por cliente e leva à página com os UTMs.`
        : "No envio, os links do site recebem os UTMs (canal, nome do fluxo e da mensagem)."}
    </p>
  );
}

function WhatsappEditor({
  c,
  set,
  utm,
}: {
  c: WhatsappContent;
  set: (c: WhatsappContent) => void;
  utm?: UtmContext | undefined;
}) {
  const { data: ch } = useChannels();
  const evolution = ch?.whatsapp?.provider === "evolution";
  const upd = (patch: Partial<WhatsappContent>) => set({ ...c, ...patch });
  const header = c.header ?? { type: "none" };
  const buttons = c.buttons ?? [];
  const nUrl = buttons.filter((b) => b.type === "url").length;
  const nPhone = buttons.filter((b) => b.type === "phone").length;
  if (c.meta?.name)
    return (
      <div className="space-y-4">
        <WaTemplateLink c={c} set={set} />
        <WaTemplateParams c={c} set={set} />
        <UtmLinkBuilder utm={utm} />
      </div>
    );
  return (
    <div className="space-y-4">
      <WaTemplateLink c={c} set={set} />
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
      <WaLinkNote texts={[c.body, ...buttons.map((b) => b.url)]} />
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
      <UtmLinkBuilder utm={utm} />
      {!evolution && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
          Fora da janela de 24h de conversa, o WhatsApp só entrega mensagens de modelos aprovados
          pela Meta. Crie o modelo no WhatsApp Manager com este texto e, depois de aprovado,
          vincule-o acima. Sem modelo, esta mensagem vai como texto e só chega a quem escreveu nas
          últimas 24h.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ RCS

function RcsEditor({
  c,
  set,
  utm,
}: {
  c: RcsContent;
  set: (c: RcsContent) => void;
  utm?: UtmContext | undefined;
}) {
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
        <p className="text-[11px] text-muted-foreground">
          {c.kind === "text"
            ? "Pela Pushfy o RCS de texto vai como cartão (RCS Single): o texto é o título e o 1º link do texto vira o botão; sem link, vai com o botão “Ver mais” para a loja."
            : "Pela Pushfy o cartão leva um botão: o primeiro do tipo “Abrir link”. Sem botão de link, vai com o botão “Ver mais” para a loja. Carrossel vai como o primeiro cartão."}
        </p>
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
        hint="Enviado para quem não tem RCS (iPhone, aparelhos antigos) e, automaticamente, quando o RCS falha ou a operadora avisa que não foi entregue. Obrigatório."
      >
        <TextArea value={c.fallback_sms} onChange={(v) => upd({ fallback_sms: v })} rows={3} />
      </Field>
      <SentSmsMeter text={c.fallback_sms} utm={utm} />
      <UtmLinkBuilder utm={utm} />
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
