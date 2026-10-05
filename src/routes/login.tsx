import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "@/lib/crm-api";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Entrar — Kakauma CRM" }] }),
  component: LoginPage,
});

const ERRORS: Record<string, string> = {
  invalid_credentials: "E-mail ou senha incorretos.",
  no_access: "Este usuário não tem acesso ao CRM. Rode npm run crm:create-admin para liberar.",
  invalid_request: "Preencha e-mail e senha.",
};

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  useEffect(() => {
    if (me?.login === false) void navigate({ to: "/crm" });
  }, [me, navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/crm/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        setError(ERRORS[body.error ?? ""] ?? body.message ?? "Não foi possível entrar.");
        return;
      }
      await qc.invalidateQueries({ queryKey: ["crm-me"] });
      void navigate({ to: "/crm" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="surface w-full max-w-sm space-y-5 p-6">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary-soft p-2 text-primary">
            <Lock className="size-4" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Kakauma CRM</h1>
            <p className="text-xs text-muted-foreground">Entre com seu e-mail e senha</p>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="password">Senha</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </div>
  );
}
