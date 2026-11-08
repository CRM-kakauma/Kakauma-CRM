import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  BellOff,
  History,
  Loader2,
  MessageCirclePlus,
  Mic,
  Paperclip,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings2,
  Smile,
  Square,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { RequireAuth } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { LIFECYCLE_LABEL, type Me } from "@/lib/crm-api";
import {
  fileToBase64,
  useWaChats,
  useWaInstances,
  useWaMessages,
  waFetch,
  type WaChat,
  type WaInstance,
  type WaMessage,
} from "@/components/crm/wa/api";
import {
  Avatar,
  Bubble,
  chatTitle,
  dayLabel,
  formatPhone,
  listTime,
  messageSummary,
  StateDot,
  STATE_LABEL,
  Ticks,
} from "@/components/crm/wa/parts";
import { ContactTags, SalesTip, TierMedal, TiersDialog } from "@/components/crm/wa/badges";

export const Route = createFileRoute("/whatsapp")({
  head: () => ({ meta: [{ title: "WhatsApp — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Inbox me={me} />}</RequireAuth>,
});

const COLORS = [
  "#25D366",
  "#075DA8",
  "#7C3AED",
  "#E11D48",
  "#F59E0B",
  "#0EA5E9",
  "#10B981",
  "#6B7280",
];
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`wa:${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`wa:${k}`, v);
    } catch {
      /* private window */
    }
  },
};

/** A short "ding" for new messages (no audio file needed). */
function ding() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch {
    /* no sound available */
  }
}

// =================================================================== page

function Inbox({ me }: { me: Me }) {
  const qc = useQueryClient();
  const inst = useWaInstances();
  const instances = useMemo(() => inst.data?.instances ?? [], [inst.data]);
  const [current, setCurrent] = useState<string | null>(() => store.get("instance"));
  const [chat, setChat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "archived">("all");
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<WaInstance | null>(null);
  const [newChat, setNewChat] = useState(false);
  const [sound, setSound] = useState(() => store.get("sound") !== "off");

  // the number shown: the last one used, else the first
  useEffect(() => {
    if (!instances.length) return;
    if (!current || !instances.some((i) => i.name === current)) setCurrent(instances[0]!.name);
  }, [instances, current]);
  useEffect(() => {
    if (current) store.set("instance", current);
  }, [current]);

  const active = instances.find((i) => i.name === current) ?? null;
  const chats = useWaChats(current, q.trim(), filter);

  // total unread in the tab title, and a sound when a new message arrives
  const totalUnread = instances.reduce((s, i) => s + Number(i.unread || 0), 0);
  const listUnread = (chats.data?.chats ?? []).reduce((s, c) => s + c.unread, 0);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const n = Math.max(totalUnread, listUnread);
    document.title = n > 0 ? `(${n}) WhatsApp — Kakauma CRM` : "WhatsApp — Kakauma CRM";
    if (seen.current !== null && n > seen.current && sound) ding();
    seen.current = n;
  }, [totalUnread, listUnread, sound]);
  useEffect(() => () => void (document.title = "Kakauma CRM"), []);

  const canSend = inst.data?.can_manage ?? me.role !== "viewer";
  const refreshAll = () => qc.invalidateQueries({ queryKey: ["wa"] });

  if (inst.error)
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 text-center">
        <p className="text-lg font-semibold">WhatsApp indisponível</p>
        <p className="mt-2 text-sm text-muted-foreground">{(inst.error as Error).message}</p>
      </div>
    );

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-my-8">
      <div className="flex h-[calc(100dvh-4.25rem)] overflow-hidden border-border bg-card sm:m-3 sm:h-[calc(100dvh-5.75rem)] sm:rounded-2xl sm:border sm:shadow-sm lg:m-4 lg:h-[calc(100dvh-6.25rem)]">
        {/* numbers */}
        <aside
          className={cn(
            "flex w-[68px] shrink-0 flex-col items-center gap-2 bg-[#0b141a] py-3",
            chat && "hidden md:flex",
          )}
        >
          {inst.isLoading && <Loader2 className="mt-2 size-5 animate-spin text-white/60" />}
          {instances.map((i) => (
            <button
              key={i.name}
              type="button"
              onClick={() => {
                setCurrent(i.name);
                setChat(null);
              }}
              title={`${i.label}${i.number ? ` · ${formatPhone(i.number)}` : ""} — ${STATE_LABEL[i.state ?? ""] ?? i.state ?? ""}`}
              className={cn(
                "relative rounded-full p-0.5 transition",
                i.name === current ? "ring-2 ring-[#25D366]" : "opacity-70 hover:opacity-100",
              )}
            >
              <Avatar name={i.label} color={i.color} size={42} />
              <StateDot state={i.state} className="absolute bottom-0 right-0 ring-[#0b141a]" />
              {i.unread > 0 && (
                <span className="absolute -right-1.5 -top-1 min-w-5 rounded-full bg-[#25D366] px-1 text-center text-[10.5px] font-bold leading-5 text-[#0b141a]">
                  {i.unread > 99 ? "99+" : i.unread}
                </span>
              )}
            </button>
          ))}
          {canSend && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              title="Conectar outro WhatsApp"
              className="mt-1 flex size-[46px] items-center justify-center rounded-full border border-dashed border-white/30 text-white/70 transition hover:border-[#25D366] hover:text-[#25D366]"
            >
              <Plus className="size-5" />
            </button>
          )}
          <div className="mt-auto flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => {
                const v = !sound;
                setSound(v);
                store.set("sound", v ? "on" : "off");
                if (v) ding();
              }}
              title={sound ? "Som de nova mensagem: ligado" : "Som de nova mensagem: desligado"}
              className="rounded-full p-2 text-white/60 hover:bg-white/10 hover:text-white"
            >
              {sound ? <Bell className="size-5" /> : <BellOff className="size-5" />}
            </button>
            {active && canSend && (
              <button
                type="button"
                onClick={() => setManaging(active)}
                title="Configurar este número"
                className="rounded-full p-2 text-white/60 hover:bg-white/10 hover:text-white"
              >
                <Settings2 className="size-5" />
              </button>
            )}
          </div>
        </aside>

        {!inst.isLoading && !instances.length ? (
          <EmptyState onAdd={canSend ? () => setAdding(true) : undefined} />
        ) : (
          <>
            {/* conversations */}
            <section
              className={cn(
                "flex w-full flex-col border-r border-border bg-white md:w-[340px] md:shrink-0 xl:w-[380px]",
                chat && "hidden md:flex",
              )}
            >
              <header className="flex items-center gap-3 bg-[#f0f2f5] px-4 py-3">
                {active && <Avatar name={active.label} color={active.color} size={40} />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-[#111b21]">
                    {active?.label ?? "WhatsApp"}
                  </p>
                  <p className="flex items-center gap-1.5 truncate text-xs text-[#667781]">
                    <StateDot state={active?.state ?? null} className="size-2 ring-0" />
                    {active?.number
                      ? formatPhone(active.number)
                      : (STATE_LABEL[active?.state ?? ""] ?? "—")}
                  </p>
                </div>
                {active && active.state !== "open" && canSend && (
                  <Button size="sm" variant="outline" onClick={() => setManaging(active)}>
                    <QrCode className="size-4" /> Conectar
                  </Button>
                )}
                {canSend && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-9 text-[#54656f]"
                    onClick={() => setNewChat(true)}
                    title="Nova conversa"
                  >
                    <MessageCirclePlus className="size-5" />
                  </Button>
                )}
              </header>
              <div className="space-y-2 border-b border-border px-3 py-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#667781]" />
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Pesquisar nome ou número"
                    className="h-9 rounded-lg border-0 bg-[#f0f2f5] pl-9 text-sm shadow-none focus-visible:ring-1"
                  />
                </div>
                <div className="flex gap-1.5">
                  {(
                    [
                      ["all", "Todas"],
                      ["unread", "Não lidas"],
                      ["archived", "Arquivadas"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setFilter(k)}
                      className={cn(
                        "rounded-full px-3 py-1 text-[13px] transition",
                        filter === k
                          ? "bg-[#d9fdd3] font-medium text-[#008069]"
                          : "bg-[#f0f2f5] text-[#54656f] hover:bg-[#e9edef]",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <ChatList
                chats={chats.data?.chats ?? []}
                loading={chats.isLoading}
                selected={chat}
                onSelect={setChat}
                emptyText={
                  q
                    ? "Nada encontrado."
                    : filter === "unread"
                      ? "Nenhuma conversa não lida. 🎉"
                      : filter === "archived"
                        ? "Nenhuma conversa arquivada."
                        : "Nenhuma conversa ainda. As mensagens que chegarem neste número aparecem aqui."
                }
              />
            </section>

            {/* conversation */}
            <section className={cn("min-w-0 flex-1", !chat && "hidden md:flex")}>
              {chat ? (
                <ChatPane
                  key={chat}
                  chatId={chat}
                  me={me}
                  canSend={canSend}
                  onBack={() => setChat(null)}
                  onChanged={refreshAll}
                />
              ) : (
                <Welcome />
              )}
            </section>
          </>
        )}
      </div>

      <AddNumberDialog
        open={adding}
        onOpenChange={setAdding}
        onDone={(name) => {
          setCurrent(name);
          void refreshAll();
        }}
      />
      {managing && (
        <ManageDialog
          instance={managing}
          canDelete={!!inst.data?.can_delete}
          onClose={() => setManaging(null)}
          onChanged={refreshAll}
        />
      )}
      {current && (
        <NewChatDialog
          open={newChat}
          onOpenChange={setNewChat}
          instance={current}
          onOpened={(id) => {
            setFilter("all");
            setChat(id);
            void refreshAll();
          }}
        />
      )}
    </div>
  );
}

// =================================================================== list

function ChatList({
  chats,
  loading,
  selected,
  onSelect,
  emptyText,
}: {
  chats: WaChat[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  emptyText: string;
}) {
  if (loading)
    return (
      <div className="flex-1 space-y-1 p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex animate-pulse items-center gap-3 px-2 py-3">
            <div className="size-11 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/2 rounded bg-muted" />
              <div className="h-3 w-3/4 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  if (!chats.length)
    return <p className="flex-1 px-8 py-12 text-center text-sm text-[#667781]">{emptyText}</p>;
  return (
    <ul className="flex-1 overflow-y-auto">
      {chats.map((c) => {
        const title = chatTitle(c);
        return (
          <li key={c.chat_id}>
            <button
              type="button"
              onClick={() => onSelect(c.chat_id)}
              className={cn(
                "flex w-full items-center gap-3 px-3 text-left transition hover:bg-[#f5f6f6]",
                selected === c.chat_id && "bg-[#f0f2f5] hover:bg-[#f0f2f5]",
              )}
            >
              <Avatar name={title} size={46} />
              <div className="min-w-0 flex-1 border-b border-[#e9edef] py-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[15.5px] text-[#111b21]">
                    {title}
                    <TierMedal tier={c.tier} className="ml-1.5" />
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      c.unread > 0 ? "font-medium text-[#25a35a]" : "text-[#667781]",
                    )}
                  >
                    {listTime(c.last_message_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1">
                  {c.last_from_me && (
                    <Ticks status={c.last_status} className="shrink-0 text-[#667781]" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-[#667781]">
                    {c.last_preview ?? ""}
                  </span>
                  {c.unread > 0 && (
                    <span className="min-w-5 shrink-0 rounded-full bg-[#25D366] px-1.5 text-center text-[11px] font-semibold leading-5 text-white">
                      {c.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// =================================================================== conversation

function ChatPane({
  chatId,
  me,
  canSend,
  onBack,
  onChanged,
}: {
  chatId: string;
  me: Me;
  canSend: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const msgs = useWaMessages(chatId);
  const [older, setOlder] = useState<WaMessage[]>([]);
  const [noMore, setNoMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reply, setReply] = useState<WaMessage | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [tiersOpen, setTiersOpen] = useState(false);
  const [tipHidden, setTipHidden] = useState(() => store.get(`tip:${chatId}`) === "hidden");
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(0);
  const historyPage = useRef(1);

  const chat = msgs.data?.chat ?? null;
  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...older, ...(msgs.data?.messages ?? [])].filter((m) =>
      seen.has(m.wa_id) ? false : (seen.add(m.wa_id), true),
    );
  }, [older, msgs.data]);

  // reading it here marks it read (also blue ticks on the customer's phone)
  useEffect(() => {
    if (chat && chat.unread > 0 && canSend)
      void waFetch("messages", { chat: chatId, action: "read" })
        .then(onChanged)
        .catch(() => null);
  }, [chat, chatId, canSend, onChanged]);

  // stay at the bottom while new messages arrive (unless reading older ones)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (all.length !== lastCount.current && atBottom.current) el.scrollTop = el.scrollHeight;
    lastCount.current = all.length;
  }, [all.length]);

  // images and audio load after the text: stay at the bottom while they grow the list
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [msgs.isLoading]);

  async function loadOlder() {
    const first = all[0];
    setLoadingOlder(true);
    try {
      const el = scroller.current;
      const before = el?.scrollHeight ?? 0;
      let r = await waFetch<{ messages: WaMessage[] }>(
        `messages?${new URLSearchParams({ chat: chatId, ...(first ? { before: first.at } : {}) })}`,
      );
      if (!r.messages.length) {
        // nothing more in the CRM: ask Evolution for what the phone has
        const h = await waFetch<{ received: number; pages: number }>("messages", {
          chat: chatId,
          action: "history",
          page: historyPage.current,
        }).catch(() => ({ received: 0, pages: 0 }));
        historyPage.current += 1;
        if (h.received)
          r = await waFetch<{ messages: WaMessage[] }>(
            `messages?${new URLSearchParams({ chat: chatId, ...(first ? { before: first.at } : {}) })}`,
          );
        if (!r.messages.length || historyPage.current > h.pages) setNoMore(!r.messages.length);
      }
      setOlder((o) => [...r.messages, ...o]);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function archive(v: boolean) {
    await waFetch("messages", { chat: chatId, action: v ? "archive" : "unarchive" });
    toast.success(v ? "Conversa arquivada" : "Conversa desarquivada");
    onChanged();
    if (v) onBack();
  }

  const title = chat ? chatTitle(chat) : "";
  return (
    <div className="flex h-full w-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-l border-border bg-[#f0f2f5] px-3 py-2.5">
          <Button size="icon" variant="ghost" className="size-9 md:hidden" onClick={onBack}>
            <ArrowLeft className="size-5" />
          </Button>
          {chat && (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              onClick={() => setShowInfo((v) => !v)}
            >
              <Avatar name={title} size={40} />
              <span className="min-w-0">
                <span className="block truncate text-[15.5px] font-medium text-[#111b21]">
                  {title}
                </span>
                <span className="block truncate text-xs text-[#667781]">
                  {formatPhone(chat.phone)}
                  {chat.name && chat.customer_name && chat.name !== chat.customer_name
                    ? ` · ~${chat.name}`
                    : ""}
                </span>
              </span>
            </button>
          )}
          {!chat && <div className="flex-1" />}
          {chat?.customer_id && (
            <Link
              to="/customers/$customerId"
              params={{ customerId: chat.customer_id }}
              className="hidden items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[13px] font-medium text-[#008069] shadow-sm ring-1 ring-black/5 transition hover:bg-[#d9fdd3] sm:inline-flex"
            >
              <UserRound className="size-4" /> Ver cliente
            </Link>
          )}
          {chat && canSend && (
            <Button
              size="icon"
              variant="ghost"
              className="size-9 text-[#54656f]"
              title={chat.archived ? "Desarquivar" : "Arquivar"}
              onClick={() => void archive(!chat.archived)}
            >
              {chat.archived ? (
                <ArchiveRestore className="size-5" />
              ) : (
                <Archive className="size-5" />
              )}
            </Button>
          )}
        </header>
        {chat?.badges && <ContactTags chatId={chatId} badges={chat.badges} canEdit={canSend} />}
        {chat?.badges && !tipHidden && (
          <div className="border-l border-border bg-[#efeae2] px-[4%] pt-2">
            <SalesTip
              badges={chat.badges}
              onHide={() => {
                setTipHidden(true);
                store.set(`tip:${chatId}`, "hidden");
              }}
            />
          </div>
        )}

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex-1 overflow-y-auto bg-[#efeae2] px-[4%] py-3"
          style={{
            backgroundImage:
              "radial-gradient(rgba(11,20,26,0.06) 1px, transparent 1px), radial-gradient(rgba(11,20,26,0.04) 1px, transparent 1px)",
            backgroundSize: "22px 22px, 22px 22px",
            backgroundPosition: "0 0, 11px 11px",
          }}
        >
          {msgs.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-6 animate-spin text-[#667781]" />
            </div>
          ) : (
            <div>
              <div className="mb-2 flex justify-center">
                {!noMore ? (
                  <button
                    type="button"
                    onClick={() => void loadOlder()}
                    disabled={loadingOlder}
                    className="flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1 text-xs text-[#54656f] shadow-sm hover:bg-white"
                  >
                    {loadingOlder ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <History className="size-3.5" />
                    )}
                    Carregar mensagens anteriores
                  </button>
                ) : (
                  <span className="rounded-lg bg-[#ffeecd] px-3 py-1 text-xs text-[#54656f] shadow-sm">
                    Início da conversa
                  </span>
                )}
              </div>
              {all.map((m, i) => {
                const prev = all[i - 1];
                const newDay =
                  !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
                const first = newDay || !prev || prev.from_me !== m.from_me;
                return (
                  <div key={m.wa_id}>
                    {newDay && (
                      <div className="my-3 flex justify-center">
                        <span className="rounded-lg bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-[#54656f] shadow-sm">
                          {dayLabel(m.at)}
                        </span>
                      </div>
                    )}
                    <Bubble
                      m={m}
                      chat={chatId}
                      first={first}
                      onReply={setReply}
                      canReply={canSend}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {canSend ? (
          <Composer
            chatId={chatId}
            reply={reply}
            onClearReply={() => setReply(null)}
            onSent={(m) => {
              atBottom.current = true;
              qc.setQueryData(
                ["wa", "messages", chatId],
                (old: { chat: unknown; messages: WaMessage[] } | undefined) =>
                  old ? { ...old, messages: [...old.messages, m] } : old,
              );
              onChanged();
            }}
          />
        ) : (
          <p className="bg-[#f0f2f5] px-4 py-3 text-center text-sm text-[#667781]">
            Seu acesso ({me.role}) só permite ler as conversas.
          </p>
        )}
      </div>

      {showInfo && chat && (
        <aside className="hidden w-[300px] shrink-0 flex-col border-l border-border bg-white xl:flex">
          <header className="flex items-center gap-2 bg-[#f0f2f5] px-4 py-3.5">
            <button type="button" onClick={() => setShowInfo(false)} className="text-[#54656f]">
              <X className="size-5" />
            </button>
            <span className="text-sm font-medium">Dados do contato</span>
          </header>
          <div className="flex flex-col items-center gap-2 px-5 py-6 text-center">
            <Avatar name={title} size={96} />
            <p className="mt-2 text-lg font-medium">{title}</p>
            <p className="text-sm text-[#667781]">{formatPhone(chat.phone)}</p>
          </div>
          {chat.badges && (
            <div className="space-y-2 border-t border-border px-5 py-4 text-sm">
              <div className="flex items-center justify-between">
                <TierMedal tier={chat.badges.tier} />
                {me.role === "admin" && (
                  <button
                    type="button"
                    onClick={() => setTiersOpen(true)}
                    className="text-xs text-[#008069] hover:underline"
                  >
                    Ajustar níveis
                  </button>
                )}
              </div>
              {chat.badges.tip && (
                <p className="text-[13px] text-[#41525d]">💡 {chat.badges.tip}</p>
              )}
              {chat.badges.auto.map((t) => (
                <p key={t.key} className="text-[13px] text-[#41525d]">
                  <strong>{t.label}:</strong> {t.hint}
                </p>
              ))}
              {tipHidden && (
                <button
                  type="button"
                  className="text-xs text-[#008069] hover:underline"
                  onClick={() => {
                    setTipHidden(false);
                    store.set(`tip:${chatId}`, "shown");
                  }}
                >
                  Mostrar a dica de venda na conversa
                </button>
              )}
            </div>
          )}
          <div className="space-y-3 border-t border-border px-5 py-4 text-sm">
            {chat.customer_id ? (
              <>
                <Info label="E-mail" value={chat.customer_email} />
                <Info
                  label="Etapa"
                  value={
                    chat.lifecycle_stage
                      ? (LIFECYCLE_LABEL[chat.lifecycle_stage] ?? chat.lifecycle_stage)
                      : null
                  }
                />
                <Info
                  label="Pedidos pagos"
                  value={chat.total_paid_orders != null ? String(chat.total_paid_orders) : null}
                />
                <Info
                  label="Total comprado"
                  value={
                    chat.total_net_revenue != null
                      ? Number(chat.total_net_revenue).toLocaleString("pt-BR", {
                          style: "currency",
                          currency: "BRL",
                        })
                      : null
                  }
                />
                <Info
                  label="Última compra"
                  value={
                    chat.last_purchase_at
                      ? new Date(chat.last_purchase_at).toLocaleDateString("pt-BR")
                      : null
                  }
                />
                <Button asChild size="sm" className="mt-2 w-full">
                  <Link to="/customers/$customerId" params={{ customerId: chat.customer_id }}>
                    Abrir ficha do cliente
                  </Link>
                </Button>
              </>
            ) : (
              <p className="text-[#667781]">
                Este número não está ligado a nenhum cliente da B4you (procuramos pelo WhatsApp do
                cadastro).
              </p>
            )}
          </div>
        </aside>
      )}
      {me.role === "admin" && <TiersDialog open={tiersOpen} onOpenChange={setTiersOpen} />}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-[#667781]">{label}</p>
      <p className="text-[#111b21]">{value || "—"}</p>
    </div>
  );
}

// =================================================================== composer

const EMOJIS =
  "😀 😁 😂 🤣 😊 😍 🥰 😘 😉 😎 🤩 🥳 😅 😇 🙂 🙃 😌 🤗 🤔 😴 😢 😭 😤 😡 🙏 👍 👎 👏 🙌 💪 👋 🤝 ✌️ 🤞 👌 ❤️ 💚 💙 💜 🧡 💛 🖤 💖 ✨ 🔥 🌟 ⭐ 🎉 🎁 ✅ ❌ ⚠️ 📦 🚚 💰 💳 📞 📷 🕒 🌙 ☀️ 🍫 🍵 😋".split(
    " ",
  );

function Composer({
  chatId,
  reply,
  onClearReply,
  onSent,
}: {
  chatId: string;
  reply: WaMessage | null;
  onClearReply: () => void;
  onSent: (m: WaMessage) => void;
}) {
  const [text, setText] = useState(() => store.get(`draft:${chatId}`) ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<{ rec: MediaRecorder; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelRec = useRef(false);

  useEffect(() => store.set(`draft:${chatId}`, text), [chatId, text]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) return setPreview(null);
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - recording.started) / 1000)),
      250,
    );
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => area.current?.focus(), [reply, chatId]);

  async function send(media?: { blob: Blob; mimetype: string; fileName?: string }) {
    const t = text.trim();
    const f =
      media ??
      (file
        ? { blob: file, mimetype: file.type || "application/octet-stream", fileName: file.name }
        : null);
    if (!t && !f) return;
    if (f && f.blob.size > 16 * 1024 * 1024) {
      toast.error("Arquivo maior que 16 MB.");
      return;
    }
    setSending(true);
    try {
      const r = await waFetch<{ message: Omit<WaMessage, "id"> }>("send", {
        chat: chatId,
        text: media ? "" : t,
        media: f
          ? { data: await fileToBase64(f.blob), mimetype: f.mimetype, fileName: f.fileName ?? null }
          : null,
        quoted: reply ? { id: reply.wa_id, text: messageSummary(reply) } : null,
      });
      onSent({ ...r.message, id: Date.now() } as WaMessage);
      if (!media) setText("");
      setFile(null);
      onClearReply();
    } catch (e) {
      toast.error("Não foi enviada", { description: (e as Error).message });
    } finally {
      setSending(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      cancelRec.current = false;
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (cancelRec.current || !chunks.current.length) return;
        const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
        void send({ blob, mimetype: blob.type.split(";")[0]!, fileName: "audio" });
      };
      rec.start();
      setElapsed(0);
      setRecording({ rec, started: Date.now() });
    } catch {
      toast.error("Não foi possível usar o microfone", {
        description: "Permita o microfone para este site no navegador.",
      });
    }
  }
  function stopRecording(cancel: boolean) {
    cancelRec.current = cancel;
    recording?.rec.stop();
    setRecording(null);
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-l border-border bg-[#f0f2f5]">
      {reply && (
        <div className="flex items-center gap-2 px-4 pt-2">
          <div className="min-w-0 flex-1 rounded-lg border-l-4 border-[#06cf9c] bg-white px-3 py-1.5 text-[13px]">
            <p className="text-xs font-medium text-[#06cf9c]">
              {reply.from_me ? "Você" : "Cliente"}
            </p>
            <p className="truncate text-[#667781]">{messageSummary(reply)}</p>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            className="rounded-full p-1 text-[#54656f] hover:bg-black/5"
          >
            <X className="size-5" />
          </button>
        </div>
      )}
      {file && (
        <div className="flex items-center gap-3 px-4 pt-2">
          {preview ? (
            <img src={preview} alt="" className="size-16 rounded-lg object-cover" />
          ) : (
            <div className="flex size-16 items-center justify-center rounded-lg bg-white text-[10px] uppercase text-[#667781]">
              {file.name.split(".").pop()}
            </div>
          )}
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-xs text-[#667781]">
              {(file.size / 1024 / 1024).toFixed(1)} MB · o texto vai como legenda
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFile(null)}
            className="rounded-full p-1 text-[#54656f] hover:bg-black/5"
          >
            <X className="size-5" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5 px-3 py-2.5">
        {recording ? (
          <div className="flex flex-1 items-center gap-3 rounded-full bg-white px-4 py-2.5">
            <button
              type="button"
              onClick={() => stopRecording(true)}
              className="text-[#54656f]"
              title="Descartar"
            >
              <Trash2 className="size-5" />
            </button>
            <span className="relative flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-rose-500" />
            </span>
            <span className="font-mono text-sm tabular-nums text-[#111b21]">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
            <span className="text-sm text-[#667781]">Gravando áudio…</span>
          </div>
        ) : (
          <>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-10 shrink-0 text-[#54656f]"
                  title="Emojis"
                >
                  <Smile className="size-6" />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="w-[300px] p-2">
                <div className="grid grid-cols-8 gap-0.5">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="rounded-md p-1 text-xl hover:bg-muted"
                      onClick={() => {
                        setText((t) => t + e);
                        area.current?.focus();
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Button
              size="icon"
              variant="ghost"
              className="size-10 shrink-0 text-[#54656f]"
              title="Anexar foto, vídeo ou documento"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip className="size-5" />
            </Button>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
            <textarea
              ref={area}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              onPaste={(e) => {
                const f = Array.from(e.clipboardData.files)[0];
                if (f) {
                  e.preventDefault();
                  setFile(f);
                }
              }}
              placeholder={file ? "Legenda (opcional)" : "Digite uma mensagem"}
              className="max-h-40 min-h-[42px] flex-1 resize-none rounded-[21px] border-0 bg-white px-4 py-2.5 text-[15px] leading-snug text-[#111b21] outline-none placeholder:text-[#8696a0]"
            />
          </>
        )}
        {recording ? (
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-full bg-[#00a884] hover:bg-[#008f72]"
            onClick={() => stopRecording(false)}
            title="Enviar áudio"
          >
            <Square className="size-4 fill-current" />
          </Button>
        ) : text.trim() || file ? (
          <Button
            size="icon"
            className="size-11 shrink-0 rounded-full bg-[#00a884] hover:bg-[#008f72]"
            disabled={sending}
            onClick={() => void send()}
            title="Enviar (Enter)"
          >
            {sending ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <SendHorizontal className="size-5" />
            )}
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-11 shrink-0 rounded-full text-[#54656f]"
            disabled={sending}
            onClick={() => void startRecording()}
            title="Gravar áudio"
          >
            {sending ? <Loader2 className="size-5 animate-spin" /> : <Mic className="size-6" />}
          </Button>
        )}
      </div>
    </div>
  );
}

// =================================================================== empty states

function Welcome() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 border-l border-border bg-[#f8f9fa] px-8 text-center">
      <div className="flex size-24 items-center justify-center rounded-full bg-[#d9fdd3]">
        <svg viewBox="0 0 32 32" className="size-12 fill-[#25D366]" aria-hidden>
          <path d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8C29 8.7 23.2 3 16 3zm0 23.4c-2.1 0-4.1-.6-5.9-1.6l-.4-.3-3.8 1.2 1.2-3.7-.3-.4a10.5 10.5 0 0 1-1.7-5.8C5.1 9.9 10 5.2 16 5.2s10.9 4.7 10.9 10.6S22 26.4 16 26.4zm6-7.9c-.3-.2-1.9-1-2.2-1.1-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.7s1.2 3.1 1.4 3.4c.2.2 2.4 3.6 5.7 5 .8.3 1.4.5 1.9.7.8.2 1.5.2 2.1.1.6-.1 1.9-.8 2.2-1.5.3-.7.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z" />
        </svg>
      </div>
      <div>
        <p className="text-2xl font-light text-[#41525d]">WhatsApp Kakauma</p>
        <p className="mt-2 max-w-md text-sm text-[#667781]">
          Escolha uma conversa à esquerda. Todos os números conectados ficam na barra escura: troque
          de número com um clique e conecte quantos quiser no <strong>+</strong>.
        </p>
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd?: (() => void) | undefined }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <QrCode className="size-14 text-[#25D366]" />
      <p className="text-xl font-medium">Nenhum WhatsApp conectado</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Conecte um número lendo o QR code com o celular. Dá para conectar quantos números quiser.
      </p>
      {onAdd && (
        <Button onClick={onAdd} className="bg-[#00a884] hover:bg-[#008f72]">
          <Plus className="size-4" /> Conectar WhatsApp
        </Button>
      )}
    </div>
  );
}

// =================================================================== dialogs

/** QR code shown until the phone connects (checks every 3 s). */
function QrBox({
  name,
  initialQr,
  onConnected,
}: {
  name: string;
  initialQr: string | null;
  onConnected: () => void;
}) {
  const [qr, setQr] = useState(initialQr);
  const [state, setState] = useState<string>("connecting");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let ticks = 0;
    const run = async () => {
      if (stop) return;
      ticks++;
      try {
        const s = await waFetch<{ state?: string }>("instances", { action: "state", name });
        if (s.state === "open") {
          setState("open");
          onConnected();
          return;
        }
        // a QR lasts about a minute: a new one every 30 s
        if (!qr || ticks % 10 === 0) {
          const c = await waFetch<{ qr: string | null; state: string | null }>("instances", {
            action: "connect",
            name,
          });
          if (c.state === "open") {
            setState("open");
            onConnected();
            return;
          }
          if (c.qr) setQr(c.qr);
        }
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
      setTimeout(() => void run(), 3000);
    };
    void run();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- polling loop started once per number
  }, [name]);

  if (state === "open")
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-[#d9fdd3] text-3xl">
          ✓
        </div>
        <p className="font-medium">WhatsApp conectado!</p>
        <p className="text-sm text-muted-foreground">Buscando as conversas do celular…</p>
      </div>
    );
  return (
    <div className="grid gap-5 sm:grid-cols-[1fr_240px]">
      <ol className="space-y-2.5 text-sm text-[#41525d]">
        <li>
          1. Abra o <strong>WhatsApp</strong> no celular desse número.
        </li>
        <li>
          2. Toque em <strong>Mais opções ⋮</strong> (Android) ou <strong>Configurações</strong>{" "}
          (iPhone).
        </li>
        <li>
          3. Toque em <strong>Aparelhos conectados</strong> → <strong>Conectar um aparelho</strong>.
        </li>
        <li>4. Aponte a câmera para o QR code ao lado.</li>
        {err && <li className="rounded-md bg-danger-soft px-2 py-1 text-xs text-danger">{err}</li>}
      </ol>
      <div className="flex size-60 items-center justify-center rounded-xl border border-border bg-white p-2">
        {qr ? (
          <img
            src={qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`}
            alt="QR code"
            className="size-full"
          />
        ) : (
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

function AddNumberDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: (name: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; qr: string | null } | null>(null);
  useEffect(() => {
    if (!open) {
      setLabel("");
      setCreated(null);
      setBusy(false);
    }
  }, [open]);

  async function create() {
    setBusy(true);
    try {
      const r = await waFetch<{ name: string; qr: string | null }>("instances", {
        action: "create",
        label: label.trim() || "WhatsApp",
        color,
      });
      setCreated(r);
      onDone(r.name);
    } catch (e) {
      toast.error("Não foi possível criar", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Conectar um WhatsApp</DialogTitle>
          <DialogDescription>
            Cada número fica na barra da esquerda, com as suas conversas. Conecte quantos quiser.
          </DialogDescription>
        </DialogHeader>
        {!created ? (
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Nome do número</span>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ex.: Atendimento 2, Suporte, Vendas Ana"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && !busy && void create()}
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <span className="font-medium">Cor</span>
              <div className="flex gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      "size-8 rounded-full transition",
                      color === c && "ring-2 ring-offset-2",
                    )}
                    style={{ background: c, ["--tw-ring-color" as string]: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => void create()}
                disabled={busy}
                className="bg-[#00a884] hover:bg-[#008f72]"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <QrCode className="size-4" />}{" "}
                Gerar QR code
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <QrBox
            name={created.name}
            initialQr={created.qr}
            onConnected={() => {
              void waFetch("instances", { action: "sync", name: created.name })
                .catch(() => null)
                .finally(() => {
                  onDone(created.name);
                  setTimeout(() => onOpenChange(false), 1200);
                });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ManageDialog({
  instance,
  canDelete,
  onClose,
  onChanged,
}: {
  instance: WaInstance;
  canDelete: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState(instance.label);
  const [color, setColor] = useState(instance.color);
  const [qr, setQr] = useState(instance.state !== "open");
  const [busy, setBusy] = useState<string | null>(null);

  async function act(action: string, extra: Record<string, unknown> = {}, ok?: string) {
    setBusy(action);
    try {
      const r = await waFetch<{ chats?: number }>("instances", {
        action,
        name: instance.name,
        ...extra,
      });
      if (ok)
        toast.success(
          ok,
          action === "sync"
            ? { description: `${r.chats ?? 0} conversa(s) atualizadas.` }
            : undefined,
        );
      onChanged();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Avatar name={label || instance.label} color={color} size={32} />
            {instance.label}
          </DialogTitle>
          <DialogDescription>
            {instance.number ? formatPhone(instance.number) : "Sem número ainda"} ·{" "}
            {STATE_LABEL[instance.state ?? ""] ?? instance.state}
            {instance.flows && " · número usado pelos fluxos"}
          </DialogDescription>
        </DialogHeader>
        {qr ? (
          <>
            <QrBox
              name={instance.name}
              initialQr={null}
              onConnected={() => {
                void act("sync", {}, "WhatsApp conectado").then(() => setQr(false));
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setQr(false)}>
                Voltar
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Nome do número"
              />
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void act("rename", { label, color }, "Salvo")}
              >
                Salvar nome e cor
              </Button>
            </div>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn("size-7 rounded-full", color === c && "ring-2 ring-offset-2")}
                  style={{ background: c, ["--tw-ring-color" as string]: c }}
                  aria-label={c}
                />
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" onClick={() => setQr(true)}>
                <QrCode className="size-4" />{" "}
                {instance.state === "open" ? "Reconectar (QR code)" : "Conectar (QR code)"}
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null || instance.state !== "open"}
                onClick={() => void act("sync", {}, "Conversas do celular buscadas")}
              >
                {busy === "sync" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Buscar conversas do celular
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null || instance.state !== "open"}
                onClick={() => {
                  if (
                    confirm(
                      `Desconectar ${instance.label}? O celular sai dos aparelhos conectados.`,
                    )
                  )
                    void act("logout", {}, "Desconectado");
                }}
              >
                Desconectar
              </Button>
              {canDelete && !instance.flows && (
                <Button
                  variant="outline"
                  className="border-danger/40 text-danger hover:bg-danger-soft hover:text-danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (
                      confirm(
                        `Excluir ${instance.label}? O número é removido da Evolution e as conversas dele somem do CRM.`,
                      )
                    )
                      void act("delete", {}, "Número excluído").then((ok) => ok && onClose());
                  }}
                >
                  <Trash2 className="size-4" /> Excluir número
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewChatDialog({
  open,
  onOpenChange,
  instance,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  instance: string;
  onOpened: (chatId: string) => void;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function open_() {
    setBusy(true);
    try {
      const r = await waFetch<{ chat_id: string }>("chats", { instance, phone, name });
      onOpened(r.chat_id);
      onOpenChange(false);
      setPhone("");
      setName("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova conversa</DialogTitle>
          <DialogDescription>
            Digite o número com DDD. Se for cliente da B4you, a ficha aparece junto.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(31) 99999-9999"
            inputMode="tel"
            autoFocus
          />
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome (opcional)"
          />
        </div>
        <DialogFooter>
          <Button
            onClick={() => void open_()}
            disabled={busy || phone.replace(/\D/g, "").length < 10}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageCirclePlus className="size-4" />
            )}{" "}
            Abrir conversa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
