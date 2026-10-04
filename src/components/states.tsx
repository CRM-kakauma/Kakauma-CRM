import { AlertCircle, Inbox } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-card px-6 py-14 text-center">
      <div className="rounded-full bg-muted p-2.5">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function ErrorState({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-6 py-12 text-center">
      <AlertCircle className="size-5 text-danger" />
      <p className="text-sm font-medium text-foreground">Não foi possível carregar os dados</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {message ?? "Tente novamente em alguns instantes."}
      </p>
    </div>
  );
}

export function CardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="surface p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-7 w-32" />
          <Skeleton className="mt-3 h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function BlockSkeleton({ height = 320 }: { height?: number }) {
  return <Skeleton className="w-full rounded-xl" style={{ height }} />;
}
