import { Fragment, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Lightbulb, TriangleAlert } from "lucide-react";
import { Empty } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { HELP, helpBySlug, type HelpBlock } from "@/lib/crm-help";

export const Route = createFileRoute("/help/$slug")({
  head: ({ params }) => ({
    meta: [{ title: `${helpBySlug(params.slug)?.title ?? "Ajuda"} — Kakauma CRM` }],
  }),
  component: Article,
});

/** **bold** and `code` inside help text. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
    p.startsWith("**") ? (
      <strong key={i} className="font-semibold text-foreground">
        {p.slice(2, -2)}
      </strong>
    ) : p.startsWith("`") ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {p.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

function Block({ b }: { b: HelpBlock }) {
  if (typeof b === "string")
    return <p className="leading-relaxed text-muted-foreground">{inline(b)}</p>;
  if ("list" in b)
    return (
      <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
        {b.list.map((x, i) => (
          <li key={i}>{inline(x)}</li>
        ))}
      </ul>
    );
  if ("steps" in b)
    return (
      <ol className="space-y-3">
        {b.steps.map((x, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
              {i + 1}
            </span>
            <span className="pt-0.5 text-muted-foreground">{inline(x)}</span>
          </li>
        ))}
      </ol>
    );
  if ("tip" in b)
    return (
      <p className="flex gap-2 rounded-lg bg-primary-soft px-4 py-3 text-sm">
        <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>{inline(b.tip)}</span>
      </p>
    );
  if ("warn" in b)
    return (
      <p className="flex gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{inline(b.warn)}</span>
      </p>
    );
  if ("table" in b)
    return (
      <div className="surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              {b.head.map((h) => (
                <th key={h} className="px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.table.map((row, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                {row.map((c, j) => (
                  <td
                    key={j}
                    className={
                      j === 0
                        ? "whitespace-nowrap px-4 py-2 font-medium"
                        : "px-4 py-2 text-muted-foreground"
                    }
                  >
                    {inline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {b.links.map((l) => (
        <a key={l.to} href={l.to} className="text-sm font-medium text-primary hover:underline">
          {l.label}
        </a>
      ))}
    </div>
  );
}

function Article() {
  const { slug } = Route.useParams();
  const a = helpBySlug(slug);
  if (!a) return <Empty>Artigo não encontrado.</Empty>;
  const related = HELP.filter((x) => x.category === a.category && x.slug !== a.slug);
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_260px]">
      <article className="max-w-3xl">
        <Link
          to="/help"
          className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
        >
          <ArrowLeft className="size-4" /> Ajuda
        </Link>
        <p className="label-eyebrow">{a.category}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{a.title}</h1>
        <p className="mt-2 text-lg text-muted-foreground">{a.summary}</p>
        {a.screen && (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <a href={a.screen.to}>
              {a.screen.label} <ArrowRight className="size-4" />
            </a>
          </Button>
        )}
        <div className="mt-8 space-y-8">
          {a.sections.map((s, i) => (
            <section key={i} className="space-y-4">
              {s.heading && <h2 className="text-lg font-semibold">{s.heading}</h2>}
              {s.blocks.map((b, j) => (
                <Block key={j} b={b} />
              ))}
            </section>
          ))}
        </div>
      </article>
      <aside className="space-y-2 xl:pt-16">
        <p className="label-eyebrow">Veja também</p>
        {(related.length ? related : HELP.filter((x) => x.slug !== a.slug).slice(0, 4)).map((r) => (
          <Link
            key={r.slug}
            to="/help/$slug"
            params={{ slug: r.slug }}
            className="block rounded-lg px-3 py-2 text-sm hover:bg-muted"
          >
            <span className="font-medium">{r.title}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{r.summary}</span>
          </Link>
        ))}
      </aside>
    </div>
  );
}
