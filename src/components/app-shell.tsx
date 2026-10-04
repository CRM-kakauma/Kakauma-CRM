import { useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, BarChart3, Code2, Filter, Menu, Route as RouteIcon, Settings, ShoppingBag } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { PeriodSelector } from "@/components/period-selector";
import { cn } from "@/lib/utils";

const LOGO = "https://kakauma.com.br/assets/kakauma-logo-CFkJSghB.png";

const NAV: { to: string; label: string; icon: typeof BarChart3 }[] = [
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
    <nav className="flex flex-1 flex-col gap-1">
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
      <Link to="/" onClick={onNavigate} className="flex items-center gap-2 px-2 pt-1">
        <img src={LOGO} alt="Kakauma" className="h-7 w-auto" />
      </Link>
      <NavList onNavigate={onNavigate} />
      <div className="rounded-lg bg-muted/60 px-3 py-2.5">
        <p className="text-xs font-medium text-foreground">Analytics MVP</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Toda métrica é derivada dos eventos armazenados.
        </p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

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
            <p className="text-sm font-semibold tracking-tight">Kakauma Analytics</p>
            <p className="hidden text-xs text-muted-foreground sm:block">Período selecionado</p>
          </div>
          <PeriodSelector />
        </header>

        <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
