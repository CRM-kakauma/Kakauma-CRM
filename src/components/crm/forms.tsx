import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONTACT_STATUS_LABEL,
  DEAL_STAGES,
  OWNERS,
  TASK_PRIORITY_LABEL,
  TASK_TYPE_LABEL,
  createContact,
  createDeal,
  createTask,
  listContacts,
  type ContactStatus,
  type DealStage,
  type TaskPriority,
  type TaskType,
} from "@/services/crm";
import { PRODUCTS } from "@/services/crm/seed";

export function useInvalidateCrm() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["crm"] });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function SimpleSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: T | "";
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const ownerOptions = OWNERS.map((o) => ({ value: o as string, label: o }));

function ContactPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data = [] } = useQuery({
    queryKey: ["crm", "contacts", {}],
    queryFn: () => listContacts(),
  });
  const options = [...data]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((c) => ({ value: c.id, label: c.name }));
  return (
    <SimpleSelect
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Selecione o contato"
    />
  );
}

// ---------------------------------------------------------------- contact

export function NewContactDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const invalidate = useInvalidateCrm();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    city: "",
    state: "",
    status: "lead" as ContactStatus,
    owner: OWNERS[0] as string,
    tags: "",
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const m = useMutation({
    mutationFn: () =>
      createContact({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim().toUpperCase() || null,
        status: form.status,
        owner: form.owner,
        source: "manual",
        tags: form.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: (c) => {
      toast.success("Contato criado");
      invalidate();
      onOpenChange(false);
      setForm((f) => ({ ...f, name: "", email: "", phone: "", city: "", state: "", tags: "" }));
      onCreated?.(c.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    m.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Novo contato</DialogTitle>
            <DialogDescription>Leads e clientes cadastrados manualmente.</DialogDescription>
          </DialogHeader>
          <Field label="Nome">
            <Input required value={form.name} onChange={(e) => set("name")(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="E-mail">
              <Input
                required
                type="email"
                value={form.email}
                onChange={(e) => set("email")(e.target.value)}
              />
            </Field>
            <Field label="WhatsApp">
              <Input
                placeholder="+55 11 99999-9999"
                value={form.phone}
                onChange={(e) => set("phone")(e.target.value)}
              />
            </Field>
            <Field label="Cidade">
              <Input value={form.city} onChange={(e) => set("city")(e.target.value)} />
            </Field>
            <Field label="UF">
              <Input
                maxLength={2}
                value={form.state}
                onChange={(e) => set("state")(e.target.value)}
              />
            </Field>
            <Field label="Status">
              <SimpleSelect
                value={form.status}
                onChange={set("status")}
                options={(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((k) => ({
                  value: k,
                  label: CONTACT_STATUS_LABEL[k],
                }))}
              />
            </Field>
            <Field label="Responsável">
              <SimpleSelect value={form.owner} onChange={set("owner")} options={ownerOptions} />
            </Field>
          </div>
          <Field label="Tags (separadas por vírgula)">
            <Input
              placeholder="VIP, Indicação"
              value={form.tags}
              onChange={(e) => set("tags")(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={m.isPending}>
              Salvar contato
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- deal

export function NewDealDialog({
  open,
  onOpenChange,
  contactId,
  stage = "novo",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contactId?: string;
  stage?: DealStage;
}) {
  const invalidate = useInvalidateCrm();
  const [contact, setContact] = useState(contactId ?? "");
  const [product, setProduct] = useState(PRODUCTS[0]!.name);
  const [value, setValue] = useState(String(PRODUCTS[0]!.price));
  const [dealStage, setDealStage] = useState<DealStage>(stage);
  const [owner, setOwner] = useState<string>(OWNERS[0]);

  const m = useMutation({
    mutationFn: () =>
      createDeal({
        contact_id: contactId ?? contact,
        product,
        title: product,
        value: Number(value.replace(",", ".")) || 0,
        stage: dealStage,
        owner,
      }),
    onSuccess: () => {
      toast.success("Negócio criado");
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (contactId ?? contact) m.mutate();
            else toast.error("Selecione um contato");
          }}
        >
          <DialogHeader>
            <DialogTitle>Novo negócio</DialogTitle>
            <DialogDescription>Oportunidade de venda no pipeline.</DialogDescription>
          </DialogHeader>
          {!contactId && (
            <Field label="Contato">
              <ContactPicker value={contact} onChange={setContact} />
            </Field>
          )}
          <Field label="Produto">
            <SimpleSelect
              value={product}
              onChange={(p) => {
                setProduct(p);
                const price = PRODUCTS.find((x) => x.name === p)?.price;
                if (price) setValue(String(price));
              }}
              options={PRODUCTS.map((p) => ({ value: p.name, label: p.name }))}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Valor (R$)">
              <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label="Etapa">
              <SimpleSelect
                value={dealStage}
                onChange={setDealStage}
                options={DEAL_STAGES.map((s) => ({ value: s.key, label: s.label }))}
              />
            </Field>
          </div>
          <Field label="Responsável">
            <SimpleSelect value={owner} onChange={setOwner} options={ownerOptions} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={m.isPending}>
              Criar negócio
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- task

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  contactId,
  defaultTitle,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contactId?: string;
  defaultTitle?: string;
}) {
  const invalidate = useInvalidateCrm();
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [type, setType] = useState<TaskType>("whatsapp");
  const [priority, setPriority] = useState<TaskPriority>("media");
  const [contact, setContact] = useState(contactId ?? "");
  const [owner, setOwner] = useState<string>(OWNERS[0]);
  const [due, setDue] = useState(() => {
    const d = new Date(Date.now() + 86_400_000);
    d.setHours(10, 0, 0, 0);
    return toLocalInput(d);
  });

  const m = useMutation({
    mutationFn: () =>
      createTask({
        title: title.trim(),
        type,
        priority,
        contact_id: (contactId ?? contact) || null,
        due_at: new Date(due).toISOString(),
        owner,
      }),
    onSuccess: () => {
      toast.success("Tarefa criada");
      invalidate();
      onOpenChange(false);
      setTitle("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Nova tarefa</DialogTitle>
            <DialogDescription>Lembrete de follow-up para a equipe.</DialogDescription>
          </DialogHeader>
          <Field label="Título">
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {!contactId && (
            <Field label="Contato (opcional)">
              <ContactPicker value={contact} onChange={setContact} />
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tipo">
              <SimpleSelect
                value={type}
                onChange={setType}
                options={(Object.keys(TASK_TYPE_LABEL) as TaskType[]).map((k) => ({
                  value: k,
                  label: TASK_TYPE_LABEL[k],
                }))}
              />
            </Field>
            <Field label="Prioridade">
              <SimpleSelect
                value={priority}
                onChange={setPriority}
                options={(Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((k) => ({
                  value: k,
                  label: TASK_PRIORITY_LABEL[k],
                }))}
              />
            </Field>
            <Field label="Prazo">
              <Input
                required
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </Field>
            <Field label="Responsável">
              <SimpleSelect value={owner} onChange={setOwner} options={ownerOptions} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={m.isPending}>
              Criar tarefa
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
