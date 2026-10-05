import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ApiErrorBox, Loading, Pill, RequireAuth } from "@/components/crm/ui";
import { count } from "@/lib/crm-format";
import { Button } from "@/components/ui/button";
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
import { RuleBuilder, type Rule } from "@/components/crm/rule-builder";
import { crmCall, useCrm, type Me } from "@/lib/crm-api";

export const Route = createFileRoute("/segments")({
  head: () => ({ meta: [{ title: "Segmentos — Kakauma CRM" }] }),
  component: () => <RequireAuth>{(me) => <Segments me={me} />}</RequireAuth>,
});

interface Segment {
  key: string;
  name: string;
  category: string | null;
  description: string | null;
  active: boolean;
  is_system: boolean;
  definition: unknown;
  members: number;
}

const CATEGORY: Record<string, string> = {
  customer: "Cliente",
  revenue: "Valor",
  subscription: "Assinatura",
  product: "Produto",
  acquisition: "Aquisição",
  behavior: "Comportamento",
  custom: "Personalizado",
};

function Segments({ me }: { me: Me }) {
  const { data, isLoading, error } = useCrm<Segment[]>("crm_list_segments");
  const [editing, setEditing] = useState<Segment | "new" | null>(null);
  const groups = Object.entries(
    (data ?? []).reduce<Record<string, Segment[]>>((acc, s) => {
      (acc[s.category ?? "custom"] ??= []).push(s);
      return acc;
    }, {}),
  );

  return (
    <>
      <PageHeader
        title="Segmentos"
        description="Grupos dinâmicos: a participação é recalculada a cada evento e periodicamente."
      >
        {me.role !== "viewer" && (
          <Button onClick={() => setEditing("new")}>
            <Plus className="size-4" /> Novo segmento
          </Button>
        )}
      </PageHeader>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading rows={6} />
      ) : (
        <div className="space-y-6">
          {groups.map(([cat, segs]) => (
            <section key={cat}>
              <h2 className="label-eyebrow mb-2">{CATEGORY[cat] ?? cat}</h2>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {segs.map((s) => (
                  <div key={s.key} className="surface flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {s.key}
                      </p>
                      {!s.active && <Pill>inativo</Pill>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Link to="/customers" search={{ segment: s.key }} className="text-right">
                        <p className="text-lg font-semibold text-primary num hover:underline">
                          {count(s.members)}
                        </p>
                        <p className="text-[11px] text-muted-foreground">clientes</p>
                      </Link>
                      {!s.is_system && me.role !== "viewer" && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                          Editar
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {editing && (
        <SegmentDialog
          segment={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function SegmentDialog({ segment, onClose }: { segment: Segment | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(segment?.name ?? "");
  const [key, setKey] = useState(segment?.key ?? "");
  const [definition, setDefinition] = useState<Rule>((segment?.definition as Rule) ?? {});
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      crmCall<number>("crm_upsert_segment", {
        p_key: key,
        p_name: name,
        p_definition: definition,
        p_category: "custom",
      }),
    onSuccess: (members) => {
      toast.success("Segmento salvo", { description: `${members} cliente(s) no segmento agora.` });
      void qc.invalidateQueries({ queryKey: ["crm"] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => crmCall("crm_delete_segment", { p_key: key }),
    onSuccess: () => {
      toast.success("Segmento excluído");
      void qc.invalidateQueries({ queryKey: ["crm"] });
      onClose();
    },
    onError: (e) => setErr((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{segment ? "Editar segmento" : "Novo segmento"}</DialogTitle>
          <DialogDescription>
            Monte a regra; a contagem abaixo mostra quantos clientes entram agora.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Nome</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alto valor em SP/RJ"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Chave</Label>
            <Input
              value={key}
              disabled={!!segment}
              onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="alto_valor_sudeste"
            />
          </div>
        </div>
        <RuleBuilder value={definition} onChange={setDefinition} />
        {err && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
        <DialogFooter className="gap-2">
          {segment && (
            <Button
              variant="ghost"
              className="mr-auto text-danger hover:text-danger"
              disabled={remove.isPending}
              onClick={() =>
                window.confirm(`Excluir o segmento "${segment.name}"?`) && remove.mutate()
              }
            >
              Excluir
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!name || !key || save.isPending}
            onClick={() => {
              setErr(null);
              save.mutate();
            }}
          >
            {save.isPending ? "Salvando…" : "Salvar e calcular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
