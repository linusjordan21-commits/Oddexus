-- 0001_odds_cache.sql — baslinje: dokumentera den BEFINTLIGA odds_cache-tabellen
-- ============================================================================
-- odds_cache finns redan i produktion (skapad manuellt enligt docs/database-plan.md).
-- Vi tar in den i migrations-historiken idempotent (create if not exists) så att
-- en färsk databas kan byggas upp helt från repot. Påverkar INTE befintlig data.
-- ============================================================================

create table if not exists public.odds_cache (
  source_id  text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_odds_cache_updated_at on public.odds_cache (updated_at);

alter table public.odds_cache enable row level security;
