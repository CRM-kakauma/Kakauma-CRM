import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { HELP, type HelpArticle } from "@/lib/crm-help";

export const Route = createFileRoute("/help/")({
  head: () => ({ meta: [{ title: "Ajuda — Kakauma CRM" }] }),
  component: Help,
});

const CATEGORIES: HelpArticle["category"][] = [
  "Comece aqui",
  "Relacionamento",
  "Dados e análises",
  "Administração",
];

/** Plain text of an article, for search. */
const text = (a: HelpArticle) =>
  [
    a.title,
    a.summary,
    ...a.sections.flatMap((s) => [s.heading ?? "", ...s.blocks.map((b) => JSON.stringify(b))]),
  ]
    .join(" ")
    .toLowerCase();

function Help() {
  const [q, setQ] = useState("");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const found = HELP.filter((a) => terms.every((t) => text(a).includes(t)));
  return (
    <>
      <PageHeader
        title="Ajuda"
        description="Para que serve cada parte do CRM, como as métricas são calculadas e como montar fluxos e mensagens."
      />
      <div className="relative mb-6 max-w-xl">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar (ex.: LTV, opt-out, teste A/B, SMS)…"
          className="pl-9"
        />
      </div>
      {CATEGORIES.map((cat) => {
        const list = found.filter((a) => a.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat} className="mb-8">
            <h2 className="label-eyebrow mb-3">{cat}</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((a) => (
                <Link
                  key={a.slug}
                  to="/help/$slug"
                  params={{ slug: a.slug }}
                  className="surface block p-4 transition-colors hover:border-primary/40"
                >
                  <p className="flex items-center gap-2 font-medium">
                    <BookOpen className="size-4 text-primary" /> {a.title}
                  </p>
                  <p className="mt-1.5 text-sm text-muted-foreground">{a.summary}</p>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
      {!found.length && (
        <p className="text-sm text-muted-foreground">Nada encontrado para “{q}”.</p>
      )}
    </>
  );
}
