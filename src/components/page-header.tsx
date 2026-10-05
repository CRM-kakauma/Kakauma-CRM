import { Link } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";

export function PageHeader({
  title,
  description,
  help,
  children,
}: {
  title: string;
  description: string;
  /** slug of a help article (/help/<slug>) explaining this screen */
  help?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {description}
          {help && (
            <>
              {" "}
              <Link
                to="/help/$slug"
                params={{ slug: help }}
                className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-primary hover:underline"
              >
                <CircleHelp className="size-3.5" /> Como funciona?
              </Link>
            </>
          )}
        </p>
      </div>
      {children}
    </div>
  );
}
