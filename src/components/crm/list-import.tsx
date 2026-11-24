import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, FileSpreadsheet, Megaphone, Upload } from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import {
  Table as T,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { crmCall } from "@/lib/crm-api";
import { count } from "@/lib/crm-format";
import {
  detectColumns,
  readSpreadsheet,
  rowProblem,
  toRows,
  type ColumnMap,
  type Table,
} from "@/lib/crm-list-import";

interface ImportResult {
  total: number;
  added: number;
  already_in_list: number;
  created: number;
  matched: number;
  invalid: number;
  invalid_rows: { line: number; reason: string }[];
}

const CHUNK = 500;
const NONE = "__none";

/** Spreadsheet (CSV / Excel) → a list (manual segment) that a Disparo can target. */
export function ListImportDialog({
  lists,
  initialList,
  onClose,
}: {
  lists: { key: string; name: string }[];
  initialList?: string | undefined;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<string>(initialList ?? "new");
  const [newName, setNewName] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [map, setMap] = useState<ColumnMap>({ name: null, email: null, phone: null });
  const [hasHeader, setHasHeader] = useState(true);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<(ImportResult & { key: string; name: string }) | null>(null);

  const rows = useMemo(() => (table ? toRows(table, map, hasHeader) : []), [table, map, hasHeader]);
  const bad = useMemo(() => rows.filter((r) => rowProblem(r)).length, [rows]);
  const width = table ? Math.max(0, ...table.slice(0, 50).map((r) => r.length)) : 0;
  const header = table && hasHeader ? (table[0] ?? []) : [];
  const colLabel = (i: number) =>
    `Coluna ${String.fromCharCode(65 + (i % 26))}${header[i] ? ` · ${header[i]}` : ""}`;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setReadErr(null);
    setTable(null);
    setFileName(file.name);
    try {
      const t = await readSpreadsheet(file);
      if (!t.length) throw new Error("A planilha está vazia");
      const d = detectColumns(t);
      setTable(t);
      setMap(d.map);
      setHasHeader(d.hasHeader);
      if (target === "new" && !newName)
        setNewName(file.name.replace(/\.(csv|xlsx|txt)$/i, "").replace(/[_-]+/g, " "));
    } catch (e) {
      setReadErr((e as Error).message);
    }
  };

  const run = async () => {
    setBusy(true);
    setErr(null);
    setProgress(0);
    try {
      let key = target;
      let name = lists.find((l) => l.key === target)?.name ?? "";
      if (target === "new") {
        const r = await crmCall<{ key: string; name: string }>("crm_create_list", {
          p_name: newName,
        });
        key = r.key;
        name = r.name;
        setTarget(key); // a retry after an error goes to the same list
      }
      const total: ImportResult = {
        total: 0,
        added: 0,
        already_in_list: 0,
        created: 0,
        matched: 0,
        invalid: 0,
        invalid_rows: [],
      };
      for (let i = 0; i < rows.length; i += CHUNK) {
        const r = await crmCall<ImportResult>("crm_import_list_contacts", {
          p_segment: key,
          p_rows: rows.slice(i, i + CHUNK),
        });
        total.total += r.total;
        total.added += r.added;
        total.already_in_list += r.already_in_list;
        total.created += r.created;
        total.matched += r.matched;
        total.invalid += r.invalid;
        total.invalid_rows.push(...r.invalid_rows);
        setProgress(Math.min(100, Math.round(((i + CHUNK) / rows.length) * 100)));
      }
      setDone({ ...total, key, name });
      void qc.invalidateQueries({ queryKey: ["crm"] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ColumnSelect = ({ k, title }: { k: keyof ColumnMap; title: string }) => (
    <div className="grid gap-1.5">
      <Label>{title}</Label>
      <Select
        value={map[k] === null ? NONE : String(map[k])}
        onValueChange={(v) => setMap((m) => ({ ...m, [k]: v === NONE ? null : Number(v) }))}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Não tem</SelectItem>
          {Array.from({ length: width }, (_, i) => (
            <SelectItem key={i} value={String(i)}>
              {colLabel(i)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  if (done)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Lista “{done.name}” importada</DialogTitle>
            <DialogDescription>
              Agora é só criar um disparo escolhendo esta lista como segmento.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat v={count(done.added)} l="entraram na lista" />
            <Stat v={count(done.created)} l="contatos novos" />
            <Stat v={count(done.matched)} l="já eram clientes" />
          </div>
          {done.already_in_list > 0 && (
            <p className="text-xs text-muted-foreground">
              {count(done.already_in_list)} já estavam na lista (não duplicou).
            </p>
          )}
          {done.invalid > 0 && (
            <div className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning-foreground">
              <p className="mb-1 font-medium">{count(done.invalid)} linha(s) ficaram de fora:</p>
              <ul className="max-h-32 list-disc overflow-y-auto pl-5">
                {done.invalid_rows.slice(0, 50).map((r) => (
                  <li key={r.line}>
                    linha {r.line}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Fechar
            </Button>
            <Button asChild>
              <Link
                to="/flows/$key"
                params={{ key: "new" }}
                search={{ tipo: "disparo", segmento: done.key }}
              >
                <Megaphone className="size-4" /> Criar disparo para esta lista
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar lista de contatos</DialogTitle>
          <DialogDescription>
            Planilha do Excel (.xlsx) ou CSV com nome, e-mail e/ou telefone. A lista vira um
            segmento que você escolhe num disparo.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Para qual lista</Label>
            <Select value={target} onValueChange={setTarget} disabled={busy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">Nova lista</SelectItem>
                {lists.map((l) => (
                  <SelectItem key={l.key} value={l.key}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {target === "new" && (
            <div className="grid gap-1.5">
              <Label>Nome da nova lista</Label>
              <Input
                value={newName}
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Ex.: Leads evento novembro"
              />
            </div>
          )}
        </div>

        <label className="surface flex cursor-pointer flex-col items-center gap-2 border-dashed p-6 text-center hover:border-primary/40">
          <FileSpreadsheet className="size-8 text-primary" />
          <span className="text-sm font-medium">
            {fileName ?? "Clique para escolher a planilha"}
          </span>
          <span className="text-xs text-muted-foreground">
            .xlsx ou .csv · a primeira aba é lida · pode ter cabeçalho (Nome, E-mail, Telefone)
          </span>
          <input
            type="file"
            accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            disabled={busy}
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </label>
        {readErr && (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{readErr}</p>
        )}

        {table && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <ColumnSelect k="name" title="Nome" />
              <ColumnSelect k="email" title="E-mail" />
              <ColumnSelect k="phone" title="Telefone / WhatsApp" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => setHasHeader(e.target.checked)}
              />
              A primeira linha é o cabeçalho (não é contato)
            </label>
            <div className="surface overflow-x-auto">
              <T>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Linha</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>E-mail</TableHead>
                    <TableHead>Telefone</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 6).map((r) => {
                    const p = rowProblem(r);
                    return (
                      <TableRow key={r.line}>
                        <TableCell className="text-muted-foreground">{r.line}</TableCell>
                        <TableCell>{r.name ?? "—"}</TableCell>
                        <TableCell>{r.email ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.phone ?? "—"}
                          {p && <span className="ml-1.5 text-xs text-danger">({p})</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </T>
            </div>
            <p className="text-sm">
              <strong>{count(rows.length - bad)}</strong> contato(s) para importar
              {bad > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  · {count(bad)} linha(s) sem e-mail ou telefone válido ficam de fora
                </span>
              )}
            </p>
            {map.email === null && map.phone === null && (
              <p className="flex items-center gap-1.5 text-xs text-danger">
                <CircleAlert className="size-3.5" /> Escolha a coluna do e-mail ou do telefone.
              </p>
            )}
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Quem já é cliente (mesmo e-mail ou WhatsApp) entra na lista sem ter os dados trocados; os
          demais viram contatos novos. Quem pediu para não receber (descadastro) ou pediu exclusão
          dos dados continua sem receber. Importe só contatos que autorizaram receber mensagens da
          Kakauma.
        </p>

        {busy && <Progress value={progress} />}
        {err && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={() => void run()}
            disabled={
              busy || !table || rows.length - bad === 0 || (target === "new" && !newName.trim())
            }
          >
            <Upload className="size-4" />
            {busy ? `Importando… ${progress}%` : `Importar ${count(rows.length - bad)} contato(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return (
    <div className="surface p-3">
      <p className="text-xl font-semibold tabular-nums">{v}</p>
      <p className="text-[11px] text-muted-foreground">{l}</p>
    </div>
  );
}
