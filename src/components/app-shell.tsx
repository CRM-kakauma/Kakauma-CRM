import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  Code2,
  Filter,
  LayoutDashboard,
  LifeBuoy,
  LineChart,
  LogOut,
  Menu,
  Route as RouteIcon,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Tags,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";
import { useMe } from "@/lib/crm-api";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PeriodSelector } from "@/components/period-selector";
import { cn } from "@/lib/utils";

const LOGO = "https://kakauma.com.br/assets/kakauma-logo-CFkJSghB.png";

type NavItem = { to: string; label: string; icon: typeof BarChart3 };

const NAV_CRM: NavItem[] = [
  { to: "/crm", label: "Painel", icon: LayoutDashboard },
  { to: "/customers", label: "Clientes", icon: Users },
  { to: "/recovery", label: "Recuperação", icon: LifeBuoy },
  { to: "/segments", label: "Segmentos", icon: Tags },
  { to: "/automations", label: "Automações", icon: Workflow },
  { to: "/insights", label: "Insights", icon: LineChart },
  { to: "/operations", label: "Operação", icon: Wrench },
];

// CRM screens without a period filter.
const NO_PERIOD = [
  "/customers",
  "/recovery",
  "/segments",
  "/automations",
  "/operations",
  "/admin",
  "/settings",
  "/api",
  "/events",
  "/journey",
];

const NAV: NavItem[] = [
  { to: "/", label: "Visão Geral", icon: BarChart3 },
  { to: "/funnels", label: "Funis", icon: Filter },
  { to: "/sales", label: "Vendas", icon: ShoppingBag },
  { to: "/journey", label: "Jornada do Cliente", icon: RouteIcon },
];

const NAV_SYSTEM = [
  { to: "/events", label: "Eventos", icon: Activity },
  { to: "/api", label: "API", icon: Code2 },
];

const NAV_FOOTER = [{ to: "/settings", label: "Configurações", icon: Settings }];

function NavList({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useMe();

  const item = (to: string, label: string, Icon: typeof BarChart3) => {
    const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
    return (
      <Link
        key={to}
        to={to}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-primary-soft hover:text-primary",
          active && "bg-primary-soft font-medium text-primary",
        )}
      >
        <Icon className="size-4" />
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
      <p className="label-eyebrow px-3 pb-1">CRM</p>
      {NAV_CRM.map((n) => item(n.to, n.label, n.icon))}
      {me?.role === "admin" && item("/admin", "Administração", ShieldCheck)}
      <p className="label-eyebrow mt-4 px-3 pb-1">Analytics (legado)</p>
      {NAV.map((n) => item(n.to, n.label, n.icon))}
      <div className="my-3 h-px bg-border" />
      {NAV_SYSTEM.map((n) => item(n.to, n.label, n.icon))}
      <div className="my-3 h-px bg-border" />
      {NAV_FOOTER.map((n) => item(n.to, n.label, n.icon))}
    </nav>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link to="/crm" onClick={onNavigate} className="flex items-center gap-2 px-2 pt-1">
        <img src={LOGO} alt="Kakauma" className="h-7 w-auto" />
      </Link>
      <NavList onNavigate={onNavigate} />
      <UserBox />
    </div>
  );
}

function DemoBadge() {
  const { data: me } = useMe();
  if (!me?.demo) return null;
  return (
    <span
      className="rounded-md bg-warning-soft px-2 py-1 text-xs font-medium text-warning-foreground"
      title="Sem Supabase do CRM configurado: o CRM roda num banco em memória com webhooks fictícios, recriados a cada vez que o servidor sobe."
    >
      Dados fictícios · demonstração
    </span>
  );
}

function UserBox() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  if (!me) return null;
  async function logout() {
    await fetch("/api/crm/auth/logout", { method: "POST", credentials: "same-origin" });
    qc.clear();
    void navigate({ to: "/login" });
  }
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{me.email}</p>
        <p className="text-[11px] text-muted-foreground">
          {me.demo
            ? "Demonstração · dados fictícios"
            : me.login === false
              ? "Modo local, sem login"
              : me.role === "admin"
                ? "Administrador"
                : me.role === "operator"
                  ? "Operador"
                  : "Leitura"}
        </p>
      </div>
      {me.login !== false && (
        <Button variant="ghost" size="icon" className="size-8" onClick={logout} aria-label="Sair">
          <LogOut className="size-4" />
        </Button>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const showPeriod = !NO_PERIOD.some((p) => pathname.startsWith(p));

  if (pathname === "/login") {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-sidebar lg:block">
        <SidebarContent />
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur-sm sm:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-0">
              <SidebarContent onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>

          <div className="flex-1">
            <p className="text-sm font-semibold tracking-tight">Kakauma CRM</p>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {showPeriod ? "Período selecionado" : "Relacionamento e vendas"}
            </p>
          </div>
          <DemoBadge />
          {showPeriod && <PeriodSelector />}
        </header>

        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
