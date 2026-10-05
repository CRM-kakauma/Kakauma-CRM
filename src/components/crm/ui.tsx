import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, CircleDashed, ShieldAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  LIFECYCLE_LABEL,
  RISK_LABEL,
  TYPE_LABEL,
  label,
  useMe,
  type CrmApiError,
  type Me,
} from "@/lib/crm-api";

// ------------------------------------------------------------------ layout pieces

export function Stat({
  label: l,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: "danger" | "success" | undefined;
}) {
  return (
    <div className="surface p-4">
      <p className="label-eyebrow">{l}</p>
      <p
        className={cn(
          "mt-2 text-xl font-semibold num",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

type Tone = "primary" | "success" | "warning" | "danger" | "muted";
const TONE: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning-foreground",
  danger: "bg-danger-soft text-danger",
  muted: "bg-muted text-muted-foreground",
};

export function Pill({
  tone = "muted",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

const RISK_TONE: Record<string, Tone> = {
  HEALTHY: "success",
  AT_RISK: "warning",
  PAYMENT_RISK: "warning",
  CHURN_RISK: "danger",
  HIGH_VALUE_AT_RISK: "danger",
};

/** Status always has an icon + text, never color alone. */
export function RiskPill({ risk }: { risk: string | null }) {
  if (!risk) return <Pill>sem compras</Pill>;
  const tone = RISK_TONE[risk] ?? "muted";
  const Icon = tone === "success" ? CheckCircle2 : tone === "danger" ? ShieldAlert : AlertCircle;
  return (
    <Pill tone={tone}>
      <Icon className="size-3" /> {label(RISK_LABEL, risk)}
    </Pill>
  );
}

export function LifecyclePill({ stage }: { stage: string | null }) {
  const bad = ["CHURNED", "CANCELLED", "LATE", "CANCELLATION_REQUESTED"].includes(stage ?? "");
  return <Pill tone={bad ? "warning" : "primary"}>{label(LIFECYCLE_LABEL, stage)}</Pill>;
}

export function TypePill({ type }: { type: string | null }) {
  return <Pill>{label(TYPE_LABEL, type)}</Pill>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  const { data: me } = useMe();
  return (
    <div className="space-y-3">
      {me?.demo_state === "loading" && (
        <p className="text-sm text-muted-foreground">
          Preparando os dados fictícios de demonstração (só na primeira vez que o servidor sobe, ~15
          s)…
        </p>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function ApiErrorBox({ error }: { error: CrmApiError | null }) {
  if (!error) return null;
  return (
    <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
      <p className="font-medium">Não foi possível carregar</p>
      <p className="mt-0.5 text-muted-foreground">{error.message}</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-dashed border-border-strong px-4 py-8 text-sm text-muted-foreground">
      <CircleDashed className="size-4" /> {children}
    </div>
  );
}

// ------------------------------------------------------------------ auth guard

export function RequireAuth({ children }: { children: (me: Me) => ReactNode }) {
  const { data: me, isLoading, error } = useMe();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isLoading && me === null) void navigate({ to: "/login" });
  }, [isLoading, me, navigate]);
  if (error) return <ApiErrorBox error={error} />;
  if (isLoading || !me) return <Loading rows={4} />;
  return <>{children(me)}</>;
}
