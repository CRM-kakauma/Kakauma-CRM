import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Result {
  applied: boolean;
  changes: {
    key: string;
    name: string;
    links: { from: string; to: string }[];
    saved: boolean;
    error: string | null;
  }[];
  other: { url: string; to: string | null }[];
}

async function run(apply: boolean): Promise<Result> {
  const res = await fetch("/api/crm/messages/expand-links", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply }),
  });
  const b = (await res.json().catch(() => ({}))) as Result & { message?: string; error?: string };
  if (!res.ok) throw new Error(b.message ?? b.error ?? `HTTP ${res.status}`);
  return b;
}

/** "Trocar links curtos": short links in e-mails go back to the store address, so UTMs apply. */
export function ExpandLinksButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const go = async (apply: boolean) => {
    setBusy(true);
    try {
      const r = await run(apply);
      setRes(r);
      if (apply) {
        const ok = r.changes.filter((c) => c.saved).length;
        toast.success(`${ok} e-mail(s) atualizados`, {
          description: "Os links agora levam direto ao site e recebem os UTMs no envio.",
        });
        void qc.invalidateQueries({ queryKey: ["crm"] });
      }
    } catch (e) {
      toast.error("Não foi possível verificar os links", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const total = res?.changes.reduce((n, c) => n + c.links.length, 0) ?? 0;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setRes(null);
          setOpen(true);
          void go(false);
        }}
      >
        <Link2 className="size-4" /> Trocar links curtos dos e-mails
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Links curtos nos e-mails</DialogTitle>
            <DialogDescription>
              Links encurtados (bit.ly e parecidos) escondem o endereço do site, e o CRM não
              consegue colocar os UTMs neles. Aqui cada link é aberto para ver onde termina; os que
              levam ao kakauma.com.br voltam a ser o endereço do site, sem os UTMs antigos. Links de
              outros sites ficam como estão.
            </DialogDescription>
          </DialogHeader>
          {busy && !res ? (
            <p className="text-sm text-muted-foreground">Verificando os links…</p>
          ) : res ? (
            <div className="space-y-4 text-sm">
              {res.changes.length === 0 ? (
                <p className="text-muted-foreground">
                  Nenhum link curto levando ao site foi encontrado nos e-mails.
                </p>
              ) : (
                res.changes.map((c) => (
                  <div key={c.key} className="rounded-lg border border-border p-3">
                    <p className="font-medium">
                      {c.name}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{c.key}</span>
                      {res.applied && (
                        <span
                          className={c.saved ? "ml-2 text-emerald-600" : "ml-2 text-destructive"}
                        >
                          {c.saved ? "✓ atualizado" : `não salvou: ${c.error}`}
                        </span>
                      )}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {c.links.map((l) => (
                        <li key={l.from} className="break-all text-xs">
                          <span className="text-muted-foreground">{l.from}</span> →{" "}
                          <span>{l.to}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
              {res.other.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    {res.other.length} link(s) de outros sites ou que não abriram (ficam como estão)
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {res.other.map((o) => (
                      <li key={o.url} className="break-all">
                        {o.url} → {o.to ?? "não abriu"}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Fechar
            </Button>
            {res && !res.applied && res.changes.length > 0 && (
              <Button onClick={() => void go(true)} disabled={busy}>
                {busy ? "Trocando…" : `Trocar ${total} link(s) em ${res.changes.length} e-mail(s)`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
