import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Configurações — Kakauma Analytics" },
      {
        name: "description",
        content: "Configurações e estado do workspace da Kakauma Analytics.",
      },
      { property: "og:title", content: "Configurações — Kakauma Analytics" },
      { property: "og:description", content: "Estado do workspace e dos dados da plataforma." },
    ],
  }),
  component: SettingsPage,
});

async function counts() {
  const [users, events, transactions, subscriptions] = await Promise.all([
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("events").select("*", { count: "exact", head: true }),
    supabase.from("transactions").select("*", { count: "exact", head: true }),
    supabase.from("subscriptions").select("*", { count: "exact", head: true }),
  ]);
  return {
    users: users.count ?? 0,
    events: events.count ?? 0,
    transactions: transactions.count ?? 0,
    subscriptions: subscriptions.count ?? 0,
  };
}

function SettingsPage() {
  const { data, isLoading } = useQuery({ queryKey: ["counts"], queryFn: counts });
  return (
    <>
      <PageHeader title="Configurações" description="Workspace, moeda e estado atual dos dados." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Usuários", value: data?.users },
          { label: "Eventos", value: data?.events },
          { label: "Transações", value: data?.transactions },
          { label: "Assinaturas", value: data?.subscriptions },
        ].map((item) => (
          <div key={item.label} className="surface p-5">
            <p className="label-eyebrow">{item.label}</p>
            {isLoading ? (
              <Skeleton className="mt-3 h-7 w-20" />
            ) : (
              <p className="mt-3 text-xl font-semibold num">{formatNumber(item.value ?? 0)}</p>
            )}
          </div>
        ))}
      </div>

      <section className="mt-8 surface p-5">
        <h2 className="text-base font-semibold">Workspace</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="label-eyebrow">Nome</dt>
            <dd className="mt-1 text-sm">Kakauma</dd>
          </div>
          <div>
            <dt className="label-eyebrow">Moeda</dt>
            <dd className="mt-1 text-sm">BRL (R$)</dd>
          </div>
          <div>
            <dt className="label-eyebrow">Fuso dos relatórios</dt>
            <dd className="mt-1 text-sm">America/Sao_Paulo</dd>
          </div>
        </dl>
        <p className="mt-5 text-sm text-muted-foreground">
          Neste MVP as métricas são derivadas exclusivamente dos eventos armazenados. Afiliados,
          cohorts, alertas e permissões chegam nas próximas etapas.
        </p>
      </section>
    </>
  );
}
