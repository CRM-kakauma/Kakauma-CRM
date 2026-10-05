import { useState, type ReactNode } from "react";
import {
  BatteryFull,
  CheckCheck,
  ChevronLeft,
  ExternalLink,
  Monitor,
  Phone as PhoneIcon,
  Reply,
  ShieldCheck,
  Signal,
  Smartphone,
  Wifi,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  renderMessage,
  smsInfo,
  type Channel,
  type Content,
  type EmailContent,
  type RcsContent,
  type SmsContent,
  type WhatsappContent,
} from "@/lib/crm-messages";

/**
 * Device simulators: they render exactly what the worker sends (same
 * renderMessage), inside a phone or inbox frame, so the person editing sees
 * the message the way the customer will.
 */

type Vars = Record<string, unknown>;

export function Simulator({
  channel,
  content,
  vars,
}: {
  channel: Channel;
  content: Content;
  vars: Vars;
}) {
  switch (channel) {
    case "email":
      return <EmailSimulator content={content as EmailContent} vars={vars} />;
    case "sms":
      return <SmsSimulator content={content as SmsContent} vars={vars} />;
    case "whatsapp":
      return <WhatsappSimulator content={content as WhatsappContent} vars={vars} />;
    case "rcs":
      return <RcsSimulator content={content as RcsContent} vars={vars} />;
  }
}

const now = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function Device({ children, bar, dark }: { children: ReactNode; bar?: ReactNode; dark?: boolean }) {
  return (
    <div className="mx-auto w-[320px] rounded-[2.6rem] border-[10px] border-neutral-900 bg-neutral-900 shadow-xl">
      <div className={cn("overflow-hidden rounded-[1.9rem]", dark ? "bg-neutral-900" : "bg-white")}>
        <div
          className={cn(
            "flex items-center justify-between px-6 pb-1 pt-2 text-[11px] font-semibold",
            dark ? "text-white" : "text-neutral-900",
          )}
        >
          <span>{now()}</span>
          <span className="flex items-center gap-1">
            <Signal className="size-3" />
            <Wifi className="size-3" />
            <BatteryFull className="size-3.5" />
          </span>
        </div>
        {bar}
        <div className="h-[540px] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ e-mail

function EmailSimulator({ content, vars }: { content: EmailContent; vars: Vars }) {
  const [mode, setMode] = useState<"desktop" | "mobile">("desktop");
  const r = renderMessage("email", content, vars) as {
    subject: string;
    preheader: string;
    from_name: string;
    html: string;
  };
  const inbox = (
    <div className="border-b border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
          {(r.from_name || "K").slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex justify-between gap-2 text-sm">
            <span className="truncate font-semibold text-neutral-900">
              {r.from_name || "Remetente"}
            </span>
            <span className="shrink-0 text-xs text-neutral-500">{now()}</span>
          </div>
          <p className="truncate text-sm font-medium text-neutral-900">
            {r.subject || "(sem assunto)"}
          </p>
          <p className="truncate text-xs text-neutral-500">
            {r.preheader || "Pré-cabeçalho: o resumo que aparece aqui na caixa de entrada"}
          </p>
        </div>
      </div>
    </div>
  );
  return (
    <div>
      <div className="mb-3 flex justify-center gap-1">
        {(["desktop", "mobile"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs",
              mode === m
                ? "bg-primary-soft font-medium text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {m === "desktop" ? (
              <Monitor className="size-3.5" />
            ) : (
              <Smartphone className="size-3.5" />
            )}
            {m === "desktop" ? "Computador" : "Celular"}
          </button>
        ))}
      </div>
      {mode === "desktop" ? (
        <div className="overflow-hidden rounded-xl border border-border bg-white shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-neutral-200 bg-neutral-100 px-3 py-2">
            <span className="size-2.5 rounded-full bg-red-400" />
            <span className="size-2.5 rounded-full bg-amber-400" />
            <span className="size-2.5 rounded-full bg-green-400" />
            <span className="ml-3 text-xs text-neutral-500">Caixa de entrada</span>
          </div>
          {inbox}
          <iframe
            title="Prévia do e-mail"
            sandbox=""
            srcDoc={r.html}
            className="h-[520px] w-full bg-neutral-100"
          />
        </div>
      ) : (
        <Device>
          {inbox}
          <iframe
            title="Prévia do e-mail no celular"
            sandbox=""
            srcDoc={r.html}
            className="h-[470px] w-full"
          />
        </Device>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ SMS

function SmsSimulator({ content, vars }: { content: SmsContent; vars: Vars }) {
  const r = renderMessage("sms", content, vars) as { text: string };
  const info = smsInfo(r.text);
  return (
    <div>
      <Device
        bar={
          <div className="flex flex-col items-center border-b border-neutral-200 pb-2">
            <div className="flex size-10 items-center justify-center rounded-full bg-neutral-300 text-sm font-semibold text-white">
              K
            </div>
            <span className="mt-1 text-xs text-neutral-700">Kakauma</span>
          </div>
        }
      >
        <div className="p-3">
          <p className="mb-2 text-center text-[10px] text-neutral-400">
            Mensagem de texto · Hoje {now()}
          </p>
          {r.text ? (
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-neutral-200 px-3 py-2 text-[13px] text-neutral-900">
              {r.text}
            </div>
          ) : null}
        </div>
      </Device>
      <SmsMeter info={info} />
    </div>
  );
}

export function SmsMeter({ info }: { info: ReturnType<typeof smsInfo> }) {
  return (
    <div className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs">
      <span className="font-medium">{info.length}</span> caracteres · {info.encoding} ·{" "}
      <span className={cn("font-medium", info.segments > 1 && "text-warning-foreground")}>
        {info.segments} SMS {info.segments > 1 ? `(cobrado ${info.segments}×)` : ""}
      </span>
      {info.nonGsm.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          Acentos/emoji ({info.nonGsm.slice(0, 6).join(" ")}) mudam para Unicode: cada SMS cabe 70
          caracteres em vez de 160.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ WhatsApp

/** WhatsApp formatting: *bold* _italic_ ~strike~ ```mono``` */
function waFormat(text: string): ReactNode[] {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g);
  return parts.map((p, i) => {
    if (/^\*[^*]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
    if (/^_[^_]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
    if (/^```[^`]+```$/.test(p))
      return (
        <code key={i} className="font-mono">
          {p.slice(3, -3)}
        </code>
      );
    return <span key={i}>{p}</span>;
  });
}

function WhatsappSimulator({ content, vars }: { content: WhatsappContent; vars: Vars }) {
  const r = renderMessage("whatsapp", content, vars) as {
    header: { type: string; text?: string; url?: string | null } | null;
    body: string;
    footer: string | null;
    buttons: { type: string; text: string }[];
  };
  return (
    <Device
      bar={
        <div className="flex items-center gap-2 bg-[#008069] px-3 py-2 text-white">
          <ChevronLeft className="size-5" />
          <div className="flex size-8 items-center justify-center rounded-full bg-white/90 text-xs font-bold text-[#008069]">
            K
          </div>
          <div className="leading-tight">
            <p className="flex items-center gap-1 text-sm font-semibold">
              Kakauma <ShieldCheck className="size-3.5 text-[#25D366]" />
            </p>
            <p className="text-[10px] opacity-80">Conta comercial</p>
          </div>
        </div>
      }
    >
      <div
        className="min-h-full p-3"
        style={{
          background: "#efeae2 radial-gradient(#d9d2c6 1px, transparent 1px) 0 0/14px 14px",
        }}
      >
        <p className="mx-auto mb-3 w-fit rounded-md bg-white/90 px-2 py-0.5 text-[10px] uppercase text-neutral-500">
          Hoje
        </p>
        <div className="max-w-[88%]">
          <div className="rounded-lg rounded-tl-none bg-white p-1 shadow-sm">
            {r.header?.type === "image" &&
              (r.header.url ? (
                <img
                  src={r.header.url}
                  alt=""
                  className="mb-1 max-h-40 w-full rounded-md object-cover"
                />
              ) : (
                <div className="mb-1 flex h-28 items-center justify-center rounded-md bg-neutral-200 text-xs text-neutral-500">
                  imagem
                </div>
              ))}
            <div className="px-1.5 pb-1 pt-0.5">
              {r.header?.type === "text" && (
                <p className="mb-1 text-[13px] font-bold text-neutral-900">{r.header.text}</p>
              )}
              <p className="whitespace-pre-wrap break-words text-[13px] text-neutral-900">
                {waFormat(r.body)}
              </p>
              {r.footer && <p className="mt-1 text-[11px] text-neutral-500">{r.footer}</p>}
              <p className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] text-neutral-400">
                {now()} <CheckCheck className="size-3 text-[#53bdeb]" />
              </p>
            </div>
          </div>
          {r.buttons.map((b, i) => (
            <div
              key={i}
              className="mt-0.5 flex items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-[13px] font-medium text-[#00a5f4] shadow-sm"
            >
              {b.type === "url" ? (
                <ExternalLink className="size-3.5" />
              ) : b.type === "phone" ? (
                <PhoneIcon className="size-3.5" />
              ) : (
                <Reply className="size-3.5" />
              )}
              {b.text}
            </div>
          ))}
        </div>
      </div>
    </Device>
  );
}

// ------------------------------------------------------------------ RCS

function RcsSimulator({ content, vars }: { content: RcsContent; vars: Vars }) {
  const [fallback, setFallback] = useState(false);
  const r = renderMessage("rcs", content, vars) as {
    kind: string;
    text: string | null;
    cards: { title: string; description: string; media_url: string | null; media_height: string }[];
    suggestions: { type: string; text: string }[];
    fallback_sms: string;
  };
  const media = (h: string) => (h === "short" ? "h-24" : h === "tall" ? "h-48" : "h-36");
  return (
    <div>
      <div className="mb-3 flex justify-center gap-1">
        {[false, true].map((f) => (
          <button
            key={String(f)}
            type="button"
            onClick={() => setFallback(f)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs",
              fallback === f
                ? "bg-primary-soft font-medium text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {f ? "Sem RCS (vira SMS)" : "Com RCS"}
          </button>
        ))}
      </div>
      {fallback ? (
        <SmsSimulator content={{ text: content.fallback_sms }} vars={vars} />
      ) : (
        <Device
          bar={
            <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
              <ChevronLeft className="size-5 text-neutral-600" />
              <div className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                K
              </div>
              <div className="leading-tight">
                <p className="flex items-center gap-1 text-sm font-medium text-neutral-900">
                  Kakauma <ShieldCheck className="size-3.5 text-[#1a73e8]" />
                </p>
                <p className="text-[10px] text-neutral-500">Empresa verificada · RCS</p>
              </div>
            </div>
          }
        >
          <div className="space-y-2 bg-white p-3">
            {r.kind === "text" ? (
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-[#e8eef7] px-3 py-2 text-[13px] text-neutral-900">
                {r.text}
              </div>
            ) : (
              <div
                className={cn(
                  "flex gap-2",
                  r.kind === "carousel" && "-mx-3 overflow-x-auto px-3 pb-1",
                )}
              >
                {r.cards.map((k, i) => (
                  <div
                    key={i}
                    className={cn(
                      "shrink-0 overflow-hidden rounded-2xl border border-neutral-200 bg-white",
                      r.kind === "carousel" ? "w-[200px]" : "w-[250px]",
                    )}
                  >
                    {k.media_url ? (
                      <img
                        src={k.media_url}
                        alt=""
                        className={cn(
                          "w-full bg-neutral-100 object-contain",
                          media(k.media_height),
                        )}
                      />
                    ) : (
                      <div
                        className={cn(
                          "flex w-full items-center justify-center bg-neutral-100 text-xs text-neutral-400",
                          media(k.media_height),
                        )}
                      >
                        sem imagem
                      </div>
                    )}
                    <div className="p-3">
                      <p className="text-[13px] font-semibold text-neutral-900">{k.title}</p>
                      {k.description && (
                        <p className="mt-1 whitespace-pre-wrap text-[12px] text-neutral-600">
                          {k.description}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-neutral-400">{now()} · RCS</p>
            {r.suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {r.suggestions.map((s, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded-full border border-[#1a73e8]/40 px-3 py-1.5 text-[12px] font-medium text-[#1a73e8]"
                  >
                    {s.type === "url" && <ExternalLink className="size-3" />}
                    {s.type === "dial" && <PhoneIcon className="size-3" />}
                    {s.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Device>
      )}
    </div>
  );
}
