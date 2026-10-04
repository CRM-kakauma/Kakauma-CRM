import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BlockSkeleton, EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ContactSheet } from "@/components/crm/contact-sheet";
import { FilterSelect } from "@/components/crm/filter-select";
import { NewContactDialog } from "@/components/crm/forms";
import { Avatar, ContactStatusPill } from "@/components/crm/pills";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import {
  CONTACT_STATUS_LABEL,
  OWNERS,
  listContacts,
  listTags,
  type ContactStatus,
} from "@/services/crm";

export const Route = createFileRoute("/contacts")({
  head: () => ({
    meta: [
      { title: "Contatos — Kakauma CRM" },
      {
        name: "description",
        content: "Base de leads e clientes da Kakauma com tags, responsáveis e histórico.",
      },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<ContactStatus | "all">("all");
  const [tag, setTag] = useState("all");
  const [owner, setOwner] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const filters = { q, status, tag, owner };
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "contacts", filters],
    queryFn: () => listContacts(filters),
  });
  const { data: tags = [] } = useQuery({ queryKey: ["crm", "tags"], queryFn: listTags });

  return (
    <>
      <PageHeader
        title="Contatos"
        description="Leads e clientes, com tags, responsável e histórico de relacionamento."
      >
        <Button className="gap-2" onClick={() => setNewOpen(true)}>
          <Plus className="size-4" /> Novo contato
        </Button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, e-mail, telefone ou cidade"
            className="pl-9"
          />
        </div>
        <FilterSelect
          value={status}
          onChange={(v) => setStatus(v as ContactStatus | "all")}
          all="Todos os status"
          options={(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((k) => ({
            value: k,
            label: CONTACT_STATUS_LABEL[k],
          }))}
        />
        <FilterSelect
          value={tag}
          onChange={setTag}
          all="Todas as tags"
          options={tags.map((t) => ({ value: t, label: t }))}
        />
        <FilterSelect
          value={owner}
          onChange={setOwner}
          all="Todos os responsáveis"
          options={OWNERS.map((o) => ({ value: o, label: o }))}
        />
      </div>

      {isLoading ? (
        <BlockSkeleton height={480} />
      ) : !data?.length ? (
        <EmptyState
          title="Nenhum contato encontrado"
          description="Ajuste os filtros ou cadastre um novo contato."
        />
      ) : (
        <div className="surface overflow-hidden">
          <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
            {formatNumber(data.length)} contatos
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contato</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden md:table-cell">Tags</TableHead>
                  <TableHead className="hidden lg:table-cell">Cidade</TableHead>
                  <TableHead className="hidden sm:table-cell">Responsável</TableHead>
                  <TableHead className="text-right">Total gasto</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Última compra</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => setSelected(c.id)}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar name={c.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {c.name}{" "}
                            <span className="sm:hidden">
                              <ContactStatusPill status={c.status} />
                            </span>
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <ContactStatusPill status={c.status} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.map((t) => (
                          <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                            {t}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {[c.city, c.state].filter(Boolean).join(" / ")}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{c.owner}</TableCell>
                    <TableCell className="text-right num">
                      {formatCurrency(c.total_spent)}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground lg:table-cell">
                      {c.last_purchase_at ? formatDate(c.last_purchase_at) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <ContactSheet contactId={selected} onClose={() => setSelected(null)} />
      <NewContactDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setSelected} />
    </>
  );
}
