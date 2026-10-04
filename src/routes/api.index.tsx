import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EVENT_TYPES } from "@/lib/events";

export const Route = createFileRoute("/api/")({
  head: () => ({
    meta: [
      { title: "Event API — Kakauma Analytics" },
      {
        name: "description",
        content:
          "Documentação do endpoint de ingestão de eventos da Kakauma Analytics, com idempotência por event_id.",
      },
      { property: "og:title", content: "Event API — Kakauma Analytics" },
      {
        property: "og:description",
        content: "Envie eventos de compra, pagamento e assinatura para a Kakauma Analytics.",
      },
    ],
  }),
  component: ApiPage,
});

const SAMPLE = `{
  "event_id": "evt_123",
  "event_type": "PIX_GENERATED",
  "user_id": "usr_123",
  "transaction_id": "trx_123",
  "subscription_id": null,
  "product_id": "prod_123",
  "value": 197,
  "currency": "BRL",
  "timestamp": "${new Date().toISOString()}",
  "source": "checkout",
  "metadata": {}
}`;

function ApiPage() {
  const [body, setBody] = useState(SAMPLE);
  const [response, setResponse] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();

  async function send() {
    setSending(true);
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await res.json();
      setResponse(JSON.stringify(json, null, 2));
      if (json.duplicate) {
        toast.info("Evento duplicado ignorado", {
          description: "O event_id já existia — nada foi contado duas vezes.",
        });
      } else if (res.ok) {
        toast.success("Evento registrado", { description: "KPIs e jornada já refletem o evento." });
        await queryClient.invalidateQueries();
      } else {
        toast.error("Evento recusado", { description: json.error ?? "Payload inválido." });
      }
    } catch (e) {
      toast.error("Falha ao enviar evento", { description: (e as Error).message });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Event API"
        description="Envie eventos reais de checkout, pagamento e assinatura para a plataforma."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="surface p-5">
          <p className="label-eyebrow">Endpoint</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-navy px-4 py-3 text-xs text-navy-foreground">
            POST /api/events{"\n"}POST /api/public/events
          </pre>
          <p className="mt-4 text-sm text-muted-foreground">
            O endpoint valida o payload, valida o tipo de evento, cria o cliente se necessário, salva
            o evento e atualiza a transação ou assinatura relacionada.
          </p>
          <p className="mt-3 rounded-lg bg-primary-soft px-3 py-2 text-xs text-primary">
            <strong>Idempotência:</strong> event_id é único. Reenviar o mesmo event_id não duplica
            evento, receita, cliente, transação nem conversão.
          </p>

          <p className="label-eyebrow mt-6">Tipos de evento aceitos</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EVENT_TYPES.map((t) => (
              <span
                key={t}
                className="rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        </section>

        <section className="surface p-5">
          <p className="label-eyebrow">Testar envio</p>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={16}
            className="mt-2 w-full rounded-lg border border-input bg-muted/40 p-3 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
          <Button onClick={send} disabled={sending} className="mt-3 gap-2">
            <Send className="size-4" />
            {sending ? "Enviando…" : "Enviar evento"}
          </Button>
          {response && (
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-navy px-4 py-3 text-xs text-navy-foreground">
              {response}
            </pre>
          )}
        </section>
      </div>
    </>
  );
}
