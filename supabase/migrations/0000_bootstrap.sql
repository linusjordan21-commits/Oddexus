-- 0000_bootstrap.sql — ONE-TIME MANUAL BOOTSTRAP
-- ============================================================================
-- Detta är den ENDA SQL du behöver klistra in manuellt i Supabase-dashboarden
-- (SQL Editor → kör en gång). Allt därefter sköts av scripts/db/apply-migrations.mjs
-- via CI (.github/workflows/db-migrate.yml) med din befintliga SUPABASE_SERVICE_KEY.
--
-- VARFÖR manuellt just detta: PostgREST (service-key-API:t) kan inte köra DDL
-- (schemaändringar) — bara läsa/skriva rader i tabeller. För att apply-scriptet
-- ska kunna köra migrationer behövs (a) en `schema_migrations`-tabell att
-- bokföra i, och (b) en `exec_sql`-funktion som tar emot DDL och kör den.
-- Funktionen är SECURITY DEFINER men REVOKE:ad från alla utom service-rollen —
-- och service-nyckeln har ändå redan full DB-access (bypassar RLS), så detta
-- utökar inte angreppsytan.
-- ============================================================================

-- (a) Migrations-bokföring: vilka migrationer som körts.
create table if not exists public.schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);
-- Service-key-API:t (PostgREST) måste kunna läsa/skriva denna för bokföring.
-- RLS av → endast service-rollen når den (anon/authenticated har ingen policy).
alter table public.schema_migrations enable row level security;

-- (b) exec_sql: kör godtycklig DDL. Endast service-rollen får anropa den.
create or replace function public.exec_sql(query text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  execute query;
end;
$$;

revoke all on function public.exec_sql(text) from public;
revoke all on function public.exec_sql(text) from anon;
revoke all on function public.exec_sql(text) from authenticated;

-- Bokför att bootstrapen körts.
insert into public.schema_migrations (version)
values ('0000_bootstrap')
on conflict (version) do nothing;
