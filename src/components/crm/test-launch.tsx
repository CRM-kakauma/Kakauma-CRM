import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical, Send, Trash2, UserPlus } from "lucide-react";
import { ApiErrorBox, Empty, Loading, Pill } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { crmCall, useCrm } from "@/lib/crm-api";
import { CHANNEL_LABEL } from "@/lib/crm-messages";
import { dateTime } from "@/lib/crm-format";

/**
 * Test contacts (manual segments such as "Teste") and "Disparar teste":
 * fire a flow now for those contacts to check that the messages arrive.
 */

export interface SegmentContact {
  customer_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  is_test: boolean;
  since: string;
}

interface SegmentLite {
  key: string;
  name: string;
  kind?: string;
  members: number;
}

const formatPhone = (p: string | null) => {
  const d = (p ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return p ?? "—";
};

/** Who is in a manual segment, add / remove people. */
export function ManualSegmentDialog({
  segment,
  canEdit,
  onClose,
}: {
  segment: { key: string; name: string; description: string | null };
  canEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const contacts = useCrm<SegmentContact[]>("crm_segment_contacts", { p_segment: segment.key });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      crmCall<{ customer_id: string; created: boolean }>("crm_add_test_contact", {
        p_name: name || null,
        p_email: email || null,
        p_phone: phone || null,
        p_segment: segment.key,
      }),
    onSuccess: (r) => {
      toast.success(
        r.created ? "Contato de teste criado" : "Cliente já existia: adicionado à lista",
      );
      setName("");
      setEmail("");
      setPhone("");
      setErr(null);
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      crmCall("crm_remove_segment_contact", { p_segment: segment.key, p_customer_id: id }),
    onSuccess: () => {
      toast.success("Removido da lista");
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{segment.name}</DialogTitle>
          <DialogDescription>
            {segment.description ??
              "Lista manual: só entra quem for adicionado aqui. Use para testar fluxos e mensagens."}
          </DialogDescription>
        </DialogHeader>

        {contacts.error ? (
          <ApiErrorBox error={contacts.error} />
        ) : contacts.isLoading ? (
          <Loading rows={3} />
        ) : !contacts.data?.length ? (
          <Empty>Nenhum contato ainda.</Empty>
        ) : (
          <div className="surface overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Celular</TableHead>
                  {canEdit && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.data.map((c) => (
                  <TableRow key={c.customer_id}>
                    <TableCell>
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: c.customer_id }}
                        className="font-medium hover:text-primary"
                      >
                        {c.full_name ?? "—"}
                      </Link>
                      {!c.is_test && (
                        <span className="ml-1.5">
                          <Pill tone="warning" title="Cliente real (veio da B4you)">
                            cliente
                          </Pill>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.email ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatPhone(c.phone)}
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Remover da lista"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(c.customer_id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {canEdit && (
          <form
            className="surface grid gap-3 p-4 sm:grid-cols-[1fr_1fr_160px_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Felipe" />
            </div>
            <div className="grid gap-1.5">
              <Label>E-mail</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@gmail.com"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Celular com DDD</Label>
              <Input
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="11 91234-5678"
              />
            </div>
            <Button type="submit" disabled={add.isPending || (!email && !phone)}>
              <UserPlus className="size-4" /> Adicionar
            </Button>
            {err && (
              <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger sm:col-span-4">
                {err}
              </p>
            )}
          </form>
        )}
        <p className="text-xs text-muted-foreground">
          Quem já é cliente (mesmo e-mail ou celular) entra na lista sem ser alterado. Os demais
          viram contatos de teste e não vêm da B4you.
        </p>
      </DialogContent>
    </Dialog>
  );
}

interface LaunchResult {
  ok: boolean;
  launch: { enrolled: number; already_in_flow: number; version: number };
  run: { advanced: number; messages: { channel: string; status: string; error?: string }[] };
}

/** "Disparar teste": everyone in a manual segment goes through the flow now. */
export function TestLaunchDialog({
  flowKey,
  blockedReason,
  onClose,
  onLaunched,
}: {
  flowKey: string;
  /** e.g. unsaved changes or problems in the graph */
  blockedReason?: string | undefined;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const qc = useQueryClient();
  const segments = useCrm<SegmentLite[]>("crm_list_segments");
  const manual = (segments.data ?? []).filter((s) => s.kind === "manual");
  const [segment, setSegment] = useState("teste");
  const [skipWaits, setSkipWaits] = useState(true);
  const contacts = useCrm<SegmentContact[]>("crm_segment_contacts", { p_segment: segment });

  const launch = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/flows/test-launch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: flowKey, segment, skip_waits: skipWaits }),
      });
      const body = (await res.json().catch(() => ({}))) as LaunchResult & {
        message?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      return body;
    },
    onSuccess: (r) => {
      const sent = r.run.messages.filter((m) => m.status === "SENT").length;
      const sim = r.run.messages.filter((m) => m.status === "DRY_RUN").length;
      toast.success(`Teste disparado para ${r.launch.enrolled} contato(s)`, {
        description:
          `${sent} mensagem(ns) enviada(s)` +
          (sim ? `, ${sim} em simulação (canal ainda sem envio real)` : "") +
          (r.launch.already_in_flow
            ? `. ${r.launch.already_in_flow} já estava(m) no fluxo de verdade e foi(ram) pulado(s).`
            : "."),
      });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      onLaunched();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-5 text-primary" /> Disparar teste
          </DialogTitle>
          <DialogDescription>
            Coloca agora no fluxo os contatos da lista escolhida, como se o gatilho tivesse
            acontecido, e envia as mensagens na hora. Clientes reais não são afetados.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Para quem</Label>
            <Select value={segment} onValueChange={setSegment}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(manual.length ? manual : [{ key: "teste", name: "Teste", members: 0 }]).map(
                  (s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.name} ({s.members})
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground">
              {contacts.isLoading ? (
                "Carregando…"
              ) : contacts.data?.length ? (
                contacts.data.map((c) => c.full_name ?? c.email ?? formatPhone(c.phone)).join(", ")
              ) : (
                <>
                  Lista vazia.{" "}
                  <Link to="/segments" className="text-primary hover:underline">
                    Adicione contatos em Segmentos → Teste
                  </Link>
                  .
                </>
              )}
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={skipWaits}
              onCheckedChange={(v) => setSkipWaits(v === true)}
              className="mt-0.5"
            />
            <span>
              Pular as esperas
              <span className="block text-xs text-muted-foreground">
                Recomendado: o fluxo inteiro roda agora. Em “Esperar evento” segue pelo caminho de
                quando o evento não acontece.
              </span>
            </span>
          </label>

          <ul className="space-y-1 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <li>
              <strong className="text-foreground">SMS e RCS</strong> saem de verdade pela Pushfy
              (mesmo antes de ligar o envio real). RCS em cartão vai com imagem e botão; carrossel
              vai como o primeiro cartão.
            </li>
            <li>
              <strong className="text-foreground">E-mail</strong> sai pelo Resend quando ele está
              configurado. <strong className="text-foreground">WhatsApp</strong> fica em simulação
              até o canal ser conectado: dá para ver o texto final na aba Testes.
            </li>
            <li>
              Horário de envio e limite diário não valem no teste; descadastro (opt-out) vale.
            </li>
          </ul>
          {blockedReason && (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
              {blockedReason}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => launch.mutate()}
            disabled={!!blockedReason || launch.isPending || !contacts.data?.length}
          >
            <Send className="size-4" /> {launch.isPending ? "Disparando…" : "Disparar agora"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Tone = "success" | "primary" | "warning" | "danger" | "muted";
const MSG: Record<string, { label: string; tone: Tone }> = {
  QUEUED: { label: "Na fila", tone: "muted" },
  PROCESSING: { label: "Enviando", tone: "muted" },
  SENT: { label: "Enviada", tone: "success" },
  DRY_RUN: { label: "Simulação", tone: "primary" },
  SKIPPED: { label: "Não enviada", tone: "warning" },
  FAILED: { label: "Falhou", tone: "danger" },
};

/** The last test launches of a flow and what happened to each message. */
export function TestRuns({
  tests,
  skipReason,
  flowKey,
}: {
  tests: TestRun[] | undefined;
  skipReason: Record<string, string>;
  flowKey: string;
}) {
  // message ids (to ask Pushfy about each one) come from the messages list of the flow
  const list = useCrm<
    { message_id: string; channel: string; recipient: string | null; at: string }[]
  >("crm_list_messages", { p_flow_key: flowKey, p_limit: 500 });
  const idOf = (m: { channel: string; recipient: string | null; at?: string | null }) =>
    list.data?.find(
      (x) =>
        x.channel === m.channel &&
        x.recipient === m.recipient &&
        !!m.at &&
        Date.parse(x.at) === Date.parse(m.at),
    )?.message_id;
  if (!tests) return <Loading />;
  if (!tests.length)
    return <Empty>Nenhum teste ainda. Use “Disparar teste” para ver as mensagens chegando.</Empty>;
  return (
    <div className="surface overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quando</TableHead>
            <TableHead>Contato</TableHead>
            <TableHead>Mensagens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tests.map((t) => (
            <TableRow key={t.enrollment_id}>
              <TableCell className="whitespace-nowrap align-top text-muted-foreground">
                {dateTime(t.entered_at)}
                {t.status === "EXITED" && t.exit_reason === "test_relaunched" && (
                  <span className="block text-[11px]">substituído por um novo teste</span>
                )}
                {(t.status === "ACTIVE" || t.status === "WAITING") && (
                  <span className="block text-[11px]">esperando (sem pular esperas)</span>
                )}
              </TableCell>
              <TableCell className="align-top">
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: t.customer_id }}
                  className="font-medium hover:text-primary"
                >
                  {t.full_name ?? "—"}
                </Link>
              </TableCell>
              <TableCell>
                {t.messages.length ? (
                  <ul className="space-y-1">
                    {t.messages.map((m, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="w-20 shrink-0 font-medium">
                          {CHANNEL_LABEL[m.channel as keyof typeof CHANNEL_LABEL] ??
                            (m.channel === "team" ? "Equipe" : m.channel)}
                        </span>
                        <Pill tone={MSG[m.status]?.tone ?? "muted"}>
                          {MSG[m.status]?.label ?? m.status}
                        </Pill>
                        {m.recipient && m.channel !== "team" && (
                          <span className="text-muted-foreground">
                            para {m.channel === "email" ? m.recipient : formatPhone(m.recipient)}
                          </span>
                        )}
                        {m.skip_reason && (
                          <span className="text-muted-foreground">
                            {skipReason[m.skip_reason] ?? m.skip_reason}
                          </span>
                        )}
                        {m.error && !m.skip_reason && (
                          <span className="text-danger">{m.error}</span>
                        )}
                        <ProviderStatus status={m.provider_status} sentAs={m.sent_as} />
                        {m.status === "SENT" && (m.channel === "sms" || m.channel === "rcs") && (
                          <CheckAtPushfy id={idOf(m)} />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    nenhuma mensagem neste caminho
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export interface TestRun {
  enrollment_id: string;
  customer_id: string;
  full_name: string | null;
  status: string;
  exit_reason: string | null;
  entered_at: string;
  messages: {
    channel: string;
    template: string | null;
    status: string;
    skip_reason: string | null;
    recipient: string | null;
    error: string | null;
    at?: string | null;
    provider_status?: string | null;
    sent_as?: string | null;
  }[];
}

/** What the operator reported back (Pushfy webhooks). */
export const PROVIDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  Sent: { label: "na operadora", tone: "muted" },
  Delivered: { label: "entregue", tone: "success" },
  Clicked: { label: "clicou", tone: "success" },
  Undelivered: { label: "não entregue", tone: "danger" },
  Rejected: { label: "recusada pela operadora", tone: "danger" },
  Invalid: { label: "número inválido", tone: "danger" },
  Blocked: { label: "bloqueada", tone: "danger" },
  Expired: { label: "expirou", tone: "warning" },
  "No credits": { label: "sem saldo na Pushfy", tone: "danger" },
  Opened: { label: "abriu", tone: "success" },
  Bounced: { label: "e-mail voltou (bounce)", tone: "danger" },
  Complained: { label: "marcou como spam", tone: "danger" },
  Delayed: { label: "entrega atrasada", tone: "warning" },
};
export const SENT_AS: Record<string, string> = {
  rcs_single_first_card: "carrossel enviado como 1º cartão",
  rcs_basic_no_button: "cartão sem botão de link: foi como texto",
  sms_fallback: "enviado como SMS alternativo",
};

export function ProviderStatus({
  status,
  sentAs,
}: {
  status?: string | null | undefined;
  sentAs?: string | null | undefined;
}) {
  return (
    <>
      {status && (
        <Pill
          tone={PROVIDER_STATUS[status]?.tone ?? "muted"}
          title="Retorno do provedor (Pushfy ou Resend)"
        >
          {PROVIDER_STATUS[status]?.label ?? status}
        </Pill>
      )}
      {sentAs && <span className="text-muted-foreground">{SENT_AS[sentAs] ?? sentAs}</span>}
    </>
  );
}

/** Asks Pushfy what happened to one message (GET /getstatus by our message id). */
function CheckAtPushfy({ id }: { id: string | undefined }) {
  const [res, setRes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!id) return null;
  return (
    <>
      <button
        type="button"
        className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          fetch(`/api/crm/messages/provider-status?id=${id}`, { credentials: "same-origin" })
            .then((r) => r.json())
            .then((b: { pushfy?: unknown; message?: string; error?: string }) =>
              setRes(
                b.pushfy !== undefined ? describePushfy(b.pushfy) : (b.message ?? b.error ?? "?"),
              ),
            )
            .catch((e: Error) => setRes(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "consultando…" : "ver na Pushfy"}
      </button>
      {res && (
        <span className="basis-full rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {res}
        </span>
      )}
    </>
  );
}

function describePushfy(body: unknown): string {
  const first = Array.isArray(body) ? body[0] : body;
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    const st = o["status"] ?? o["Status"];
    if (typeof st === "string")
      return `${PROVIDER_STATUS[st]?.label ?? st} · ${JSON.stringify(first).slice(0, 300)}`;
  }
  if (Array.isArray(body) && body.length === 0) return "a Pushfy não encontrou esta mensagem";
  return (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 400);
}
