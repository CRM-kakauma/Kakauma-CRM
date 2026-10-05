import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { FilterSelect } from "@/components/crm/filter-select";
import { ApiErrorBox, Empty, Loading, Pill, RequireAuth, Section } from "@/components/crm/ui";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { crmCall, useCrm, type Me } from "@/lib/crm-api";
import { dateTime } from "@/lib/crm-format";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Administração — Kakauma CRM" }] }),
  component: () => (
    <RequireAuth>
      {(me) => (me.role === "admin" ? <Admin me={me} /> : <Empty>Somente administradores.</Empty>)}
    </RequireAuth>
  ),
});

const ROLE: Record<string, string> = {
  admin: "Administrador",
  operator: "Operador",
  viewer: "Leitura",
};
const ROLE_HINT: Record<string, string> = {
  admin: "tudo: regras, usuários, dados e auditoria",
  operator: "clientes, segmentos e automações",
  viewer: "só consulta",
};

function Admin({ me }: { me: Me }) {
  return (
    <>
      <PageHeader
        title="Administração"
        description="Pessoas com acesso ao CRM e o registro de tudo que foi alterado."
      />
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Usuários</TabsTrigger>
          <TabsTrigger value="audit">Auditoria</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-6">
          <Users me={me} />
        </TabsContent>
        <TabsContent value="audit" className="mt-6">
          <Audit />
        </TabsContent>
      </Tabs>
    </>
  );
}

interface AppUser {
  user_id: string;
  email: string;
  role: string;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

function Users({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useCrm<AppUser[]>("crm_list_app_users");
  const update = useMutation({
    mutationFn: (u: { email: string; role: string; active: boolean }) =>
      crmCall("crm_set_user_access", { p_email: u.email, p_role: u.role, p_active: u.active }),
    onSuccess: () => {
      toast.success("Acesso atualizado");
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <>
      {me.demo || me.login === false ? (
        <p className="surface mb-4 p-4 text-sm text-muted-foreground">
          {me.demo
            ? "Modo demonstração: não há login. Configure o Supabase do CRM para convidar pessoas."
            : "Rodando localmente sem login (ligue com CRM_REQUIRE_LOGIN=true). Os usuários abaixo valem quando o login estiver ativo."}
        </p>
      ) : null}
      {!me.demo && <Invite />}
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !data?.length ? (
        <Empty>Nenhum usuário cadastrado.</Empty>
      ) : (
        <div className="surface mt-4 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>E-mail</TableHead>
                <TableHead>Papel</TableHead>
                <TableHead>Último acesso</TableHead>
                <TableHead className="text-right">Ativo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((u) => (
                <TableRow key={u.user_id}>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell>
                    <Select
                      value={u.role}
                      onValueChange={(role) =>
                        update.mutate({ email: u.email, role, active: u.active })
                      }
                    >
                      <SelectTrigger className="h-8 w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(ROLE).map(([k, v]) => (
                          <SelectItem key={k} value={k}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {dateTime(u.last_login_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={u.active}
                      onCheckedChange={(active) =>
                        update.mutate({ email: u.email, role: u.role, active })
                      }
                      aria-label={`Ativar/desativar ${u.email}`}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
        {Object.entries(ROLE).map(([k, v]) => (
          <li key={k}>
            <strong>{v}</strong>: {ROLE_HINT[k]}
          </li>
        ))}
      </ul>
    </>
  );
}

function Invite() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("operator");
  const invite = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/crm/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password, role }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => {
      toast.success("Usuário criado", {
        description: `Envie a senha para ${email} por um canal seguro.`,
      });
      setEmail("");
      setPassword("");
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Section title="Convidar pessoa" className="mt-0">
      <div className="surface grid gap-3 p-4 sm:grid-cols-[1.5fr_1fr_1fr_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label>E-mail</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label>Senha inicial (10+)</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Papel</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ROLE).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={!email || password.length < 10 || invite.isPending}
          onClick={() => invite.mutate()}
        >
          Criar acesso
        </Button>
      </div>
    </Section>
  );
}

interface AuditRow {
  id: number;
  entity: string;
  entity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
  changed_at: string;
}

const ENTITY: Record<string, string> = {
  subscriptions: "Assinaturas",
  customers: "Clientes",
  orders: "Pedidos",
  refunds: "Reembolsos",
  automations: "Automações",
  automation_runs: "Execuções de automação",
  segments: "Segmentos",
  settings: "Regras e limites",
  app_users: "Usuários",
  events: "Eventos",
};

function actorLabel(a: string) {
  if (a.startsWith("user:")) return <Pill tone="primary">{a.slice(5)}</Pill>;
  if (a.startsWith("event:"))
    return (
      <span className="font-mono text-[11px] text-muted-foreground">evento {a.slice(6, 18)}…</span>
    );
  return (
    <span className="text-xs text-muted-foreground">
      {a === "system:state-refresh" ? "sistema (reavaliação)" : a}
    </span>
  );
}

function Audit() {
  const [entity, setEntity] = useState("people");
  const { data, isLoading, error } = useCrm<AuditRow[]>("crm_list_audit", {
    p_entity: entity === "all" || entity === "people" ? null : entity,
    p_limit: 300,
  });
  const rows = (data ?? []).filter((r) => entity !== "people" || r.actor.startsWith("user:"));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Quem mudou o quê e quando. Mudanças feitas por eventos também são registradas.
        </p>
        <FilterSelect
          value={entity}
          onChange={setEntity}
          all="Tudo (inclui eventos e sistema)"
          options={[
            { value: "people", label: "Só alterações de pessoas" },
            ...Object.entries(ENTITY).map(([value, label]) => ({ value, label })),
          ]}
        />
      </div>
      <ApiErrorBox error={error} />
      {isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>Nada registrado com esse filtro.</Empty>
      ) : (
        <div className="surface overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Quem</TableHead>
                <TableHead>O quê</TableHead>
                <TableHead>Campo</TableHead>
                <TableHead>De → para</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {dateTime(r.changed_at)}
                  </TableCell>
                  <TableCell>{actorLabel(r.actor)}</TableCell>
                  <TableCell>
                    {ENTITY[r.entity] ?? r.entity}{" "}
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {r.entity_id.slice(0, 24)}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.field}</TableCell>
                  <TableCell
                    className="max-w-md truncate text-xs"
                    title={`${r.old_value ?? "—"} → ${r.new_value ?? "—"}`}
                  >
                    {r.old_value ?? "—"} → {r.new_value ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
