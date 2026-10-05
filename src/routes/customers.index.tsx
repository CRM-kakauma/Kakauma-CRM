import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { FilterSelect } from "@/components/crm/filter-select";
import {
  ApiErrorBox,
  Empty,
  LifecyclePill,
  Loading,
  RequireAuth,
  RiskPill,
  TypePill,
} from "@/components/crm/ui";
import { date, money } from "@/lib/crm-format";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LIFECYCLE_LABEL, RISK_LABEL, TYPE_LABEL, useCrm } from "@/lib/crm-api";

interface CustomersSearch {
  segment?: string | undefined;
}

export const Route = createFileRoute("/customers/")({
  head: () => ({ meta: [{ title: "Clientes — Kakauma CRM" }] }),
  validateSearch: (s: Record<string, unknown>): CustomersSearch => ({
    segment: typeof s["segment"] === "string" ? s["segment"] : undefined,
  }),
  component: () => <RequireAuth>{() => <Customers />}</RequireAuth>,
});

interface Row {
  customer_id: string;
  full_name: string | null;
  email: string | null;
  whatsapp: string | null;
  customer_type: string;
  lifecycle: string | null;
  risk: string | null;
  net_ltv: number;
  last_purchase_at: string | null;
}

const options = (m: Record<string, string>) =>
  Object.entries(m).map(([value, label]) => ({ value, label }));

function Customers() {
  const { segment } = Route.useSearch();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [lifecycle, setLifecycle] = useState("all");
  const [risk, setRisk] = useState("all");
  const [type, setType] = useState("all");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading, error } = useCrm<Row[]>("crm_search_customers", {
    p_query: debounced || null,
    p_lifecycle: lifecycle === "all" ? null : lifecycle,
    p_risk: risk === "all" ? null : risk,
    p_type: type === "all" ? null : type,
    p_segment: segment ?? null,
    p_limit: 200,
  });

  return (
    <>
      <PageHeader
        title="Clientes"
        description={
          segment
            ? `Membros do segmento "${segment}"`
            : "Todos os clientes identificados a partir dos eventos."
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nome, e-mail, WhatsApp, CPF, id da venda…"
            className="pl-9"
          />
        </div>
        <FilterSelect
          value={lifecycle}
          onChange={setLifecycle}
          all="Todas as etapas"
          options={options(LIFECYCLE_LABEL)}
        />
        <FilterSelect
          value={risk}
          onChange={setRisk}
          all="Todos os riscos"
          options={options(RISK_LABEL)}
        />
        <FilterSelect
          value={type}
          onChange={setType}
          all="Todos os tipos"
          options={options(TYPE_LABEL)}
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading rows={6} />
      ) : !data?.length ? (
        <Empty>
          Nenhum cliente encontrado. Os clientes aparecem conforme os webhooks da B4you chegam.
        </Empty>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Etapa</TableHead>
                <TableHead>Risco</TableHead>
                <TableHead className="text-right">LTV líquido</TableHead>
                <TableHead className="hidden text-right md:table-cell">Última compra</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((c) => (
                <TableRow key={c.customer_id}>
                  <TableCell>
                    <Link
                      to="/customers/$customerId"
                      params={{ customerId: c.customer_id }}
                      className="block"
                    >
                      <p className="font-medium text-primary hover:underline">
                        {c.full_name ?? c.email ?? "Sem nome"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {c.email ?? c.whatsapp ?? "—"}
                      </p>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <TypePill type={c.customer_type} />
                  </TableCell>
                  <TableCell>
                    <LifecyclePill stage={c.lifecycle} />
                  </TableCell>
                  <TableCell>
                    <RiskPill risk={c.risk} />
                  </TableCell>
                  <TableCell className="text-right num">{money(c.net_ltv)}</TableCell>
                  <TableCell className="hidden text-right text-muted-foreground md:table-cell">
                    {date(c.last_purchase_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.length === 200 && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              Mostrando os 200 mais recentes. Refine a busca.
            </p>
          )}
        </div>
      )}
    </>
  );
}
