#!/usr/bin/env node
// Applies the CRM migrations (0008+) to the CRM Supabase project.
//
//   npm run crm:migrate
//
// Needs CRM_DATABASE_URL in .env (Supabase → Project Settings → Database →
// Connection string → "Session pooler" URI, with your database password).
// Each file runs once, inside a transaction; applied files are recorded in
// public.crm_schema_migrations.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const FIRST_CRM_MIGRATION = 8; // 0000–0007 belong to the legacy analytics project
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "migrations");
const url = process.env.CRM_DATABASE_URL;
if (!url) {
  console.error("CRM_DATABASE_URL não definido no .env");
  process.exit(1);
}

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const sql = postgres(url, { max: 1, onnotice: () => {}, ssl: local ? false : "require", prepare: false });

try {
  await sql`create table if not exists public.crm_schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  await sql`revoke all on public.crm_schema_migrations from anon, authenticated`.catch(() => {});
  const applied = new Set((await sql`select name from public.crm_schema_migrations`).map((r) => r.name));
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= FIRST_CRM_MIGRATION)
    .sort();
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    process.stdout.write(`aplicando ${f} ... `);
    await sql.begin(async (tx) => {
      await tx.unsafe("set local search_path = public, extensions");
      await tx.unsafe(readFileSync(join(dir, f), "utf8"));
      await tx`insert into public.crm_schema_migrations (name) values (${f})`;
    });
    console.log("ok");
    count++;
  }
  console.log(count ? `${count} migração(ões) aplicada(s).` : "Banco já está atualizado.");
} catch (e) {
  console.error("\nfalhou:", e.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
