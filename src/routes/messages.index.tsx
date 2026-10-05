import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Mail, MessageCircle, MessageSquareText, Plus, Smartphone } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCrm, type Me } from "@/lib/crm-api";
import {
  CHANNEL_LABEL,
  summary,
  type Channel,
  type Content,
  type Purpose,
} from "@/lib/crm-messages";
import { date } from "@/lib/crm-format";

export const Route = createFileRoute("/messages/")({
  head: () => ({ meta: [{ title: "Mensagens — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Messages me={me} />}</RequireAuth>,
});

export const CHANNEL_ICON: Record<Channel, typeof Mail> = {
  email: Mail,
  sms: MessageSquareText,
  whatsapp: MessageCircle,
  rcs: Smartphone,
};

const CHANNEL_HINT: Record<Channel, string> = {
  email: "Conteúdo longo, imagens e links. Barato; ideal para boas-vindas, conteúdo e ofertas.",
  sms: "Chega em qualquer celular, sem internet. Curto (160 caracteres) e pago por parte.",
  whatsapp: "Maior taxa de leitura. Fora de uma conversa aberta, só com modelo aprovado pela Meta.",
  rcs: "SMS rico do Android: marca verificada, imagens, carrossel e botões. Com SMS alternativo.",
};

export interface TemplateRow {
  key: string;
  name: string;
  channel: Channel;
  purpose: Purpose;
  description: string | null;
  content: Content;
  archived: boolean;
  updated_at: string;
  used_in_flows: number;
  sent_30d: number;
}

function Messages({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"all" | Channel>("all");
  const [q, setQ] = useState("");
  const { data, isLoading, error } = useCrm<TemplateRow[]>("crm_list_templates", {
    p_channel: tab === "all" ? null : tab,
  });
  const canEdit = me.role !== "viewer";
  const rows = (data ?? []).filter(
    (t) =>
      !q || `${t.name} ${t.key} ${t.description ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title="Mensagens"
        description="Modelos de e-mail, SMS, WhatsApp e RCS usados pelos fluxos. Cada um tem um simulador que mostra exatamente o que o cliente vai receber."
        help="mensagens"
      />

      {canEdit && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(CHANNEL_ICON) as Channel[]).map((c) => {
            const Icon = CHANNEL_ICON[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() =>
                  navigate({ to: "/messages/$key", params: { key: "new" }, search: { channel: c } })
                }
                className="surface group p-4 text-left transition-colors hover:border-primary/40"
              >
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-medium">
                    <Icon className="size-4 text-primary" /> {CHANNEL_LABEL[c]}
                  </span>
                  <Plus className="size-4 text-muted-foreground group-hover:text-primary" />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{CHANNEL_HINT[c]}</p>
              </button>
            );
          })}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="all">Todas</TabsTrigger>
            {(Object.keys(CHANNEL_ICON) as Channel[]).map((c) => (
              <TabsTrigger key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar…"
          className="h-9 w-56"
        />
      </div>

      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>Nenhuma mensagem {tab === "all" ? "" : `de ${CHANNEL_LABEL[tab]}`} ainda.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((t) => {
            const Icon = CHANNEL_ICON[t.channel];
            return (
              <Link
                key={t.key}
                to="/messages/$key"
                params={{ key: t.key }}
                className="surface block p-4 transition-colors hover:border-primary/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <Icon className="size-4 shrink-0 text-primary" />
                      <span className="truncate">{t.name}</span>
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {summary(t.channel, t.content)}
                    </p>
                  </div>
                  <Pill tone={t.purpose === "transactional" ? "muted" : "primary"}>
                    {t.purpose === "transactional" ? "Transacional" : "Marketing"}
                  </Pill>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {CHANNEL_LABEL[t.channel]} · em {t.used_in_flows} fluxo(s) · {t.sent_30d} envio(s)
                  em 30 dias · editada {date(t.updated_at)}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
