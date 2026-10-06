import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Landing page of Supabase Auth e-mails (invite and password recovery).
 * The link brings #access_token=…&type=invite|recovery; the person chooses a
 * password here and is logged in.
 */
export const Route = createFileRoute("/definir-senha")({
  head: () => ({ meta: [{ title: "Definir senha — Kakauma CRM" }] }),
  component: SetPassword,
});

type Link =
  | { state: "reading" }
  | { state: "ok"; token: string; type: string }
  | { state: "error"; message: string };

function SetPassword() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [link, setLink] = useState<Link>({ state: "reading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    const q = new URLSearchParams(window.location.search);
    const err = h.get("error_description") ?? q.get("error_description");
    const token = h.get("access_token");
    // keep the token out of the address bar and history
    window.history.replaceState(null, "", window.location.pathname);
    if (err) setLink({ state: "error", message: err.replace(/\+/g, " ") });
    else if (token) setLink({ state: "ok", token, type: h.get("type") ?? "invite" });
    else
      setLink({
        state: "error",
        message: "Abra esta página pelo link do e-mail de convite ou de troca de senha.",
      });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (link.state !== "ok") return;
    if (password.length < 10) return setError("Use pelo menos 10 caracteres.");
    if (password !== confirm) return setError("As duas senhas não são iguais.");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/crm/auth/set-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ access_token: link.token, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (res.ok) {
        await qc.invalidateQueries({ queryKey: ["crm-me"] });
        void navigate({ to: "/crm" });
      } else if (body.error === "no_access") {
        setDone(
          "Senha criada! Seu acesso ao CRM ainda não foi liberado — avise o administrador e depois entre pela tela de login.",
        );
      } else if (body.error === "invalid_link") {
        setError(
          "Este link expirou ou já foi usado. Peça um novo convite (ou um novo e-mail de troca de senha).",
        );
      } else {
        setError(body.message ?? "Não foi possível salvar a senha.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface w-full max-w-sm space-y-5 p-6">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary-soft p-2 text-primary">
            <KeyRound className="size-4" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Kakauma CRM</h1>
            <p className="text-xs text-muted-foreground">
              {link.state === "ok" && link.type === "recovery"
                ? "Escolha uma nova senha"
                : "Crie sua senha para entrar"}
            </p>
          </div>
        </div>
        {link.state === "error" ? (
          <>
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {link.message}
            </p>
            <Link to="/login" className="block text-center text-sm text-primary hover:underline">
              Ir para o login
            </Link>
          </>
        ) : done ? (
          <>
            <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">{done}</p>
            <Link to="/login" className="block text-center text-sm text-primary hover:underline">
              Ir para o login
            </Link>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="pw">Nova senha (10+ caracteres)</Label>
              <Input
                id="pw"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pw2">Repita a senha</Label>
              <Input
                id="pw2"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading || link.state !== "ok"}>
              {loading ? "Salvando…" : "Salvar e entrar"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
