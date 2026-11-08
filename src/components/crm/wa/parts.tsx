/** WhatsApp inbox: avatars, message bubbles, ticks, dates and phone formatting. */
import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock3,
  Download,
  FileText,
  MapPin,
  Reply,
  UserRound,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { mediaUrl, type WaMessage } from "./api";

// ------------------------------------------------------------------ text helpers

export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  const d = digits.replace(/\D/g, "");
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}

export function chatTitle(c: {
  customer_name?: string | null;
  name?: string | null;
  phone?: string | null;
  remote_jid?: string;
}) {
  return (
    c.customer_name || c.name || formatPhone(c.phone) || c.remote_jid?.split("@")[0] || "Contato"
  );
}

export function initials(name: string): string {
  const w = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!w.length) return "?";
  if (/^\d/.test(w[0]!)) return "#";
  return ((w[0]![0] ?? "") + (w.length > 1 ? (w[w.length - 1]![0] ?? "") : "")).toUpperCase();
}

const PALETTE = [
  "#0E7C66",
  "#075DA8",
  "#7C3AED",
  "#C2410C",
  "#BE185D",
  "#0369A1",
  "#4D7C0F",
  "#B45309",
];
export function colorFor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export function listTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Ontem";
  if (now.getTime() - d.getTime() < 6 * 86_400_000)
    return d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return "Hoje";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Ontem";
  return d.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** WhatsApp formatting: *bold* _italic_ ~strike~ ```mono``` and clickable links. */
export function waText(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s]+)/g).flatMap((chunk, j): ReactNode[] =>
    /^https?:\/\//.test(chunk)
      ? [
          <a
            key={`l${j}`}
            href={chunk}
            target="_blank"
            rel="noreferrer noopener"
            className="break-all text-[#027eb5] underline-offset-2 hover:underline"
          >
            {chunk}
          </a>,
        ]
      : chunk.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g).map((p, n) => {
          const k = `${j}-${n}`;
          if (/^\*[^*]+\*$/.test(p)) return <strong key={k}>{p.slice(1, -1)}</strong>;
          if (/^_[^_]+_$/.test(p)) return <em key={k}>{p.slice(1, -1)}</em>;
          if (/^~[^~]+~$/.test(p)) return <s key={k}>{p.slice(1, -1)}</s>;
          if (/^```[^`]+```$/.test(p))
            return (
              <code key={k} className="rounded bg-black/5 px-1 font-mono text-[0.92em]">
                {p.slice(3, -3)}
              </code>
            );
          return <span key={k}>{p}</span>;
        }),
  );
}

// ------------------------------------------------------------------ small pieces

export function Avatar({
  name,
  color,
  size = 44,
  className,
}: {
  name: string;
  color?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white shadow-sm",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `linear-gradient(135deg, ${color ?? colorFor(name)}, ${color ?? colorFor(name)}cc)`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Ticks({ status, className }: { status: string | null; className?: string }) {
  if (status === "failed")
    return <AlertCircle className={cn("size-3.5 text-danger", className)} aria-label="Falhou" />;
  if (status === "pending" || !status)
    return (
      <Clock3 className={cn("size-3 text-current opacity-60", className)} aria-label="Enviando" />
    );
  if (status === "sent")
    return <Check className={cn("size-3.5 opacity-70", className)} aria-label="Enviada" />;
  return (
    <CheckCheck
      className={cn("size-3.5", status === "read" ? "text-[#53bdeb]" : "opacity-70", className)}
      aria-label={status === "read" ? "Lida" : "Entregue"}
    />
  );
}

export function StateDot({ state, className }: { state: string | null; className?: string }) {
  const tone =
    state === "open"
      ? "bg-emerald-500"
      : state === "connecting"
        ? "bg-amber-400"
        : state === "missing"
          ? "bg-zinc-400"
          : "bg-rose-500";
  return <span className={cn("block size-2.5 rounded-full ring-2 ring-white", tone, className)} />;
}

export const STATE_LABEL: Record<string, string> = {
  open: "Conectado",
  connecting: "Aguardando QR code",
  close: "Desconectado",
  missing: "Não encontrado na Evolution",
};

// ------------------------------------------------------------------ bubbles

function AudioPlayer({ src, seconds }: { src: string; seconds?: number | undefined }) {
  return (
    <div className="flex min-w-[220px] flex-col gap-1 py-1">
      <audio controls preload="none" src={src} className="h-9 w-full max-w-[280px]" />
      {seconds ? (
        <span className="text-[11px] opacity-60">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      ) : null}
    </div>
  );
}

function ImageMedia({ src, sticker }: { src: string; sticker?: boolean }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="flex h-24 w-56 items-center justify-center rounded-lg bg-black/5 text-xs opacity-70">
        Imagem indisponível
      </div>
    );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block">
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className={cn(
            "rounded-lg object-cover",
            sticker
              ? "size-36 bg-transparent object-contain"
              : "max-h-80 w-full min-w-[180px] max-w-[300px] bg-black/5",
          )}
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl border-0 bg-black/90 p-2">
          <DialogTitle className="sr-only">Imagem</DialogTitle>
          <img src={src} alt="" className="max-h-[85vh] w-full rounded object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function MediaBody({ m, chat }: { m: WaMessage; chat: string }) {
  const src = mediaUrl(chat, m.wa_id);
  switch (m.type) {
    case "image":
      return <ImageMedia src={src} />;
    case "sticker":
      return <ImageMedia src={src} sticker />;
    case "video":
      return (
        <video
          controls
          preload="none"
          src={src}
          className="max-h-80 w-full min-w-[220px] max-w-[300px] rounded-lg bg-black"
        />
      );
    case "audio":
      return <AudioPlayer src={src} seconds={m.media?.seconds} />;
    case "document":
      return (
        <a
          href={src}
          download={m.media?.file_name ?? "arquivo"}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-[220px] items-center gap-3 rounded-lg bg-black/5 px-3 py-2.5 hover:bg-black/10"
        >
          <FileText className="size-8 shrink-0 text-[#e5534b]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {m.media?.file_name ?? "Documento"}
            </span>
            <span className="text-[11px] uppercase opacity-60">
              {(m.media?.mimetype ?? "").split("/")[1] ?? "arquivo"}
            </span>
          </span>
          <Download className="size-4 opacity-60" />
        </a>
      );
    case "location":
      return (
        <a
          href={`https://www.google.com/maps?q=${m.media?.lat},${m.media?.lng}`}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-[200px] items-center gap-2 rounded-lg bg-black/5 px-3 py-2.5 text-sm hover:bg-black/10"
        >
          <MapPin className="size-5 text-[#e5534b]" /> Abrir localização no mapa
        </a>
      );
    case "contact":
      return (
        <div className="flex min-w-[200px] items-center gap-2 rounded-lg bg-black/5 px-3 py-2.5 text-sm">
          <UserRound className="size-5 opacity-70" />
          <span>
            <span className="block font-medium">{m.body ?? "Contato"}</span>
            {m.media?.phone && <span className="text-xs opacity-70">{m.media.phone}</span>}
          </span>
        </div>
      );
    default:
      return null;
  }
}

export function Bubble({
  m,
  chat,
  first,
  onReply,
  canReply,
}: {
  m: WaMessage;
  chat: string;
  first: boolean;
  onReply: (m: WaMessage) => void;
  canReply: boolean;
}) {
  const mine = m.from_me;
  const sticker = m.type === "sticker";
  const caption = m.type === "contact" || m.type === "location" ? null : m.body;
  return (
    <div
      className={cn(
        "group flex w-full",
        mine ? "justify-end" : "justify-start",
        first ? "mt-2" : "mt-0.5",
      )}
    >
      <div className={cn("flex max-w-[78%] items-end gap-1.5", mine && "flex-row-reverse")}>
        <div
          className={cn(
            "relative rounded-2xl px-2.5 pb-1.5 pt-1.5 text-[14.2px] leading-snug shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
            sticker && "bg-transparent px-0 shadow-none",
            !sticker && (mine ? "bg-[#d9fdd3] text-[#111b21]" : "bg-white text-[#111b21]"),
            !sticker && first && (mine ? "rounded-tr-md" : "rounded-tl-md"),
          )}
        >
          {m.media?.quoted && (
            <div
              className={cn(
                "mb-1 rounded-lg border-l-4 px-2 py-1 text-[12.5px] opacity-80",
                mine ? "border-[#06cf9c] bg-[#c7f0c0]" : "border-[#53bdeb] bg-[#f0f2f5]",
              )}
            >
              <span className="line-clamp-3 whitespace-pre-wrap">{m.media.quoted}</span>
            </div>
          )}
          {m.type !== "text" && m.type !== "other" && (
            <div className={cn(caption && "mb-1")}>
              <MediaBody m={m} chat={chat} />
            </div>
          )}
          {m.type === "other" && <span className="italic opacity-60">Mensagem não suportada</span>}
          {caption && (
            <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {waText(caption)}
            </span>
          )}
          <span
            className={cn(
              "float-right ml-2 mt-1.5 flex translate-y-0.5 items-center gap-1 text-[11px] leading-none text-[#667781]",
              sticker && "rounded-full bg-black/40 px-1.5 py-0.5 text-white",
            )}
          >
            {m.sent_by && mine && (
              <span
                className="max-w-[90px] truncate opacity-80"
                title={`Enviada pelo CRM por ${m.sent_by}`}
              >
                {m.sent_by.split("@")[0]}
              </span>
            )}
            {clock(m.at)}
            {mine && <Ticks status={m.status} />}
          </span>
        </div>
        {canReply && (
          <button
            type="button"
            onClick={() => onReply(m)}
            className="mb-1 rounded-full p-1 text-[#667781] opacity-0 transition hover:bg-black/5 group-hover:opacity-100"
            aria-label="Responder"
            title="Responder"
          >
            <Reply className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** One-line description of a message (reply bar, previews). */
export function messageSummary(m: WaMessage): string {
  if (m.body) return m.body;
  return (
    {
      image: "📷 Foto",
      video: "🎥 Vídeo",
      audio: "🎤 Áudio",
      document: `📄 ${m.media?.file_name ?? "Documento"}`,
      sticker: "Figurinha",
      location: "📍 Localização",
      contact: "👤 Contato",
    }[m.type] ?? "Mensagem"
  );
}
