/**
 * "WhatsApp" on the customer page: opens the conversation with the customer in the CRM's WhatsApp
 * screen. With more than one number connected, asks which one to talk from. Outside the CRM
 * (WhatsApp Web) stays as an option.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ExternalLink, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { waFetch, type WaInstance } from "./api";
import { Avatar, formatPhone, StateDot, STATE_LABEL } from "./parts";

export function OpenWhatsappButton({ phone, name }: { phone: string; name?: string | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<WaInstance[] | null>(null);
  const digits = phone.replace(/\D/g, "");
  const waMe = `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`;

  async function go(instance: string) {
    setBusy(instance);
    try {
      const r = await waFetch<{ chat_id: string }>("chats", {
        instance,
        phone: digits,
        name: name ?? null,
      });
      setOpen(false);
      void navigate({ to: "/whatsapp", search: { n: instance, c: r.chat_id } });
    } catch (e) {
      toast.error("Não foi possível abrir a conversa", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy("list");
    try {
      const r = await waFetch<{ instances: WaInstance[]; can_manage: boolean }>("instances");
      if (!r.can_manage) {
        window.open(waMe, "_blank", "noopener");
        return;
      }
      const connected = r.instances.filter((i) => i.state === "open");
      if (connected.length === 1) {
        await go(connected[0]!.name);
        return;
      }
      // none connected or several: the person chooses (or opens WhatsApp Web)
      setNumbers(connected.length ? connected : r.instances);
      setOpen(true);
    } catch {
      // the WhatsApp screen is not set up: WhatsApp Web, as before
      window.open(waMe, "_blank", "noopener");
    } finally {
      setBusy((b) => (b === "list" ? null : b));
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={(e) => {
            e.preventDefault();
            if (!open) void start();
          }}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MessageCircle className="size-4" />
          )}{" "}
          WhatsApp
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">
          Conversar por qual número?
        </p>
        <div className="space-y-1">
          {(numbers ?? []).map((i) => (
            <button
              key={i.name}
              type="button"
              disabled={busy !== null || i.state !== "open"}
              onClick={() => void go(i.name)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-muted disabled:opacity-50"
            >
              <span className="relative">
                <Avatar name={i.label} color={i.color} size={34} />
                <StateDot state={i.state} className="absolute -bottom-0.5 -right-0.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{i.label}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {i.number ? formatPhone(i.number) : (STATE_LABEL[i.state ?? ""] ?? "—")}
                  {i.state !== "open" && i.number
                    ? ` · ${STATE_LABEL[i.state ?? ""] ?? i.state}`
                    : ""}
                </span>
              </span>
              {busy === i.name && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </button>
          ))}
          {numbers && !numbers.some((i) => i.state === "open") && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Nenhum número conectado agora. Conecte em WhatsApp → +.
            </p>
          )}
        </div>
        <a
          href={waMe}
          target="_blank"
          rel="noreferrer"
          className="mt-1 flex items-center gap-2 border-t border-border px-2 pb-1 pt-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" /> Abrir no WhatsApp Web
        </a>
      </PopoverContent>
    </Popover>
  );
}
