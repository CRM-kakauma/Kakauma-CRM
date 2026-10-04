#!/usr/bin/env bash
# Creates a disposable Postgres database that mimics Supabase (anon /
# authenticated / service_role roles, pgcrypto in the "extensions" schema)
# and applies every migration in drizzle/migrations.
#
# Usage (uses the standard PGHOST/PGPORT/PGUSER/PGPASSWORD variables):
#   scripts/crm-test-db.sh crm_test
#   CRM_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/crm_test node --test tests/crm/*.test.ts
set -euo pipefail
DB="${1:-crm_test}"
cd "$(dirname "$0")/.."

psql -q -d postgres -c "drop database if exists $DB" >/dev/null
psql -q -d postgres -c "create database $DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema extensions;
create extension pgcrypto with schema extensions;
SQL
psql -q -d postgres -c "alter database $DB set search_path = public, extensions"
for f in drizzle/migrations/0*.sql; do
  psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || {
    echo "migration failed: $f" >&2
    psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
    exit 1
  }
done
echo "database $DB ready ($(ls drizzle/migrations/0*.sql | wc -l) migrations)"
