import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArrowLeft, CircleAlert, CircleCheck } from "lucide-react";
import { ApiErrorBox, Empty, Loading, RequireAuth } from "@/components/crm/ui";
import { ChannelEditor, PreviewAs, VariableBar } from "@/components/crm/message-editor";
import { Simulator } from "@/components/crm/simulators";
import { TestSend } from "@/components/crm/channels";
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
import { crmCall, useCrm, type Me } from "@/lib/crm-api";
import {
  CHANNEL_LABEL,
  SAMPLE_CUSTOMER,
  defaultContent,
  type Channel,
  type Content,
  type Purpose,
} from "@/lib/crm-messages";
import type { TemplateRow } from "./messages.index";

const CHANNELS = ["email", "sms", "whatsapp", "rcs"] as const;

export const Route = createFileRoute("/messages/$key")({
  head: () => ({ meta: [{ title: "Editar mensagem — Kakauma CRM" }] }),
  validateSearch: (s: Record<string, unknown>): { channel?: Channel | undefined } => ({
    channel: CHANNELS.includes(s["channel"] as Channel) ? (s["channel"] as Channel) : undefined,
  }),
  component: () => <RequireAuth>{(me) => <Loader me={me} />}</RequireAuth>,
});

function Loader({ me }: { me: Me }) {
  const { key } = Route.useParams();
  const { channel } = Route.useSearch();
  const isNew = key === "new";
  const { data, isLoading, error } = useCrm<TemplateRow[]>(
    "crm_list_templates",
    { p_include_archived: true },
    { enabled: !isNew },
  );
  if (isNew) {
    const c = channel ?? "whatsapp";
    return (
      <Editor
        me={me}
        initial={{
          key: "",
          name: "",
          channel: c,
          purpose: "marketing",
          description: null,
          content: defaultContent(c),
          archived: false,
        }}
        isNew
      />
    );
  }
  if (isLoading) return <Loading rows={6} />;
  if (error) return <ApiErrorBox error={error} />;
  const t = data?.find((x) => x.key === key);
  if (!t) return <Empty>Mensagem não encontrada.</Empty>;
  return <Editor me={me} initial={t} isNew={false} />;
}

type Draft = Pick<
  TemplateRow,
  "key" | "name" | "channel" | "purpose" | "description" | "content" | "archived"
>;

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 50);

function Editor({ me, initial, isNew }: { me: Me; initial: Draft; isNew: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canEdit = me.role !== "viewer";
  const [d, setD] = useState<Draft>(initial);
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [vars, setVars] = useState<{ v: Record<string, unknown>; label: string }>({
    v: SAMPLE_CUSTOMER,
    label: "Cliente de exemplo",
  });
  const [errors, setErrors] = useState<string[] | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);

  // Live check with the same rules the server applies on save.
  useEffect(() => {
    const t = setTimeout(() => {
      crmCall<string[]>("crm_template_errors", { p_channel: d.channel, p_content: d.content })
        .then(setErrors)
        .catch(() => setErrors(null));
    }, 400);
    return () => clearTimeout(t);
  }, [d.channel, d.content]);

  const save = useMutation({
    mutationFn: () =>
      crmCall<string>("crm_upsert_template", {
        p_key: d.key,
        p_name: d.name,
        p_channel: d.channel,
        p_content: d.content,
        p_purpose: d.purpose,
        p_description: d.description,
      }),
    onSuccess: (key) => {
      toast.success("Mensagem salva");
      void qc.invalidateQueries({ queryKey: ["crm"] });
      if (isNew) void navigate({ to: "/messages/$key", params: { key } });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      crmCall("crm_archive_template", { p_key: d.key, p_archived: archived }),
    onSuccess: (_, archived) => {
      toast.success(archived ? "Mensagem arquivada" : "Mensagem restaurada");
      void qc.invalidateQueries({ queryKey: ["crm"] });
      if (archived) void navigate({ to: "/messages" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <>
      <Link
        to="/messages"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="size-4" /> Mensagens
      </Link>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-eyebrow">{CHANNEL_LABEL[d.channel]}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {d.name || (isNew ? "Nova mensagem" : d.key)}
          </h1>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => archive.mutate(!d.archived)}
                disabled={archive.isPending}
              >
                <Archive className="size-4" /> {d.archived ? "Restaurar" : "Arquivar"}
              </Button>
            )}
            <Button
              onClick={() => save.mutate()}
              disabled={
                !d.name || !d.key || save.isPending || !!errors?.length || (!dirty && !isNew)
              }
            >
              {save.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <div className="surface grid gap-4 p-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Nome</Label>
              <Input
                value={d.name}
                disabled={!canEdit}
                onChange={(e) =>
                  setD((x) => ({
                    ...x,
                    name: e.target.value,
                    key: keyTouched ? x.key : slug(e.target.value),
                  }))
                }
                placeholder="Ex.: Lembrete de PIX"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Chave</Label>
              <Input
                value={d.key}
                disabled={!isNew || !canEdit}
                onChange={(e) => {
                  setKeyTouched(true);
                  setD((x) => ({
                    ...x,
                    key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
                  }));
                }}
              />
              <p className="text-[11px] text-muted-foreground">
                Identificador usado pelos fluxos. Não muda depois de criada.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label>Finalidade</Label>
              <Select
                value={d.purpose}
                onValueChange={(v) => setD((x) => ({ ...x, purpose: v as Purpose }))}
                disabled={!canEdit}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="marketing">Marketing</SelectItem>
                  <SelectItem value="transactional">Transacional</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {d.purpose === "marketing"
                  ? "Respeita descadastro (opt-out), horário de envio e limite diário por cliente."
                  : "Sobre algo que o cliente fez (pagamento, entrega). Vai mesmo com opt-out de marketing."}
              </p>
            </div>
            {isNew && (
              <div className="grid gap-1.5">
                <Label>Canal</Label>
                <Select
                  value={d.channel}
                  onValueChange={(v) =>
                    setD((x) => ({
                      ...x,
                      channel: v as Channel,
                      content: defaultContent(v as Channel),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {CHANNEL_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <fieldset disabled={!canEdit} className="surface space-y-4 p-4">
            <VariableBar />
            <ChannelEditor
              channel={d.channel}
              content={d.content}
              onChange={(c: Content) => setD((x) => ({ ...x, content: c }))}
            />
          </fieldset>
        </div>

        <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Simulador</p>
            <span className="text-xs text-muted-foreground">vendo como: {vars.label}</span>
          </div>
          <PreviewAs onVars={(v, label) => setVars({ v, label })} />
          {errors === null ? null : errors.length ? (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              <p className="mb-1 flex items-center gap-1 font-medium">
                <CircleAlert className="size-3.5" /> Antes de salvar
              </p>
              <ul className="list-disc pl-5">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-1 rounded-lg bg-success-soft px-3 py-2 text-xs text-success">
              <CircleCheck className="size-3.5" /> Pronta para usar nos fluxos.
            </p>
          )}
          <Simulator channel={d.channel} content={d.content} vars={vars.v} />
          {!isNew && canEdit && (d.channel === "sms" || d.channel === "rcs") && (
            <TestSend
              templateKey={d.key}
              disabledReason={
                dirty
                  ? "Salve as alterações antes de testar (o teste usa a versão salva)."
                  : d.channel === "rcs" && (d.content as { kind?: string }).kind !== "text"
                    ? "Por enquanto só RCS de texto é enviado (cartão/carrossel aguardam a documentação da Pushfy)."
                    : undefined
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
