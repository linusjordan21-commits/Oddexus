-- 0006_observations_runs.sql — rå odds-tidsserie + scrape-runs + export-jobb (fas 1)
-- ============================================================================
-- raw_odds_observations : movement-filtrerad tidsserie (graf + backtest-grund).
--                         Skrivs av scraper-mirror (separat från signal-workern).
-- scrape_runs           : ett ID per skrap-pass (kopplar observationer ihop).
-- export_jobs           : spårar genererade Claude Analysis Packages.
-- Retention för raw_odds_observations redovisas separat innan auto-radering.
-- Idempotent.
-- ============================================================================

create table if not exists public.scrape_runs (
  scrape_run_id  text primary key,
  source_id      text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  observations   integer,
  duration_ms    integer,
  status         text,           -- ok | partial | failed
  extra          jsonb
);
alter table public.scrape_runs enable row level security;
create index if not exists idx_runs_source on public.scrape_runs (source_id);
create index if not exists idx_runs_started on public.scrape_runs (started_at);

create table if not exists public.raw_odds_observations (
  observation_id      text primary key,
  scrape_run_id       text,
  observed_at         timestamptz not null default now(),
  observed_at_sweden  text,
  sport               text,
  league              text,
  event_id            text,
  match               text,
  start_time          timestamptz,
  start_time_sweden   text,
  bookmaker           text,
  source_type         text,        -- sharp | soft | exchange
  market_type         text,
  market_key          text,
  period              text,
  selection           text,
  line                numeric,
  odds                numeric,
  implied_probability numeric,
  no_vig_probability  numeric,
  fair_odds           numeric,
  betfair_back        numeric,
  betfair_lay         numeric,
  betfair_spread      numeric,
  betfair_liquidity   numeric,
  market_status       text,        -- prematch | live | suspended | reopened | closed
  scrape_delay_ms     integer,
  data_quality_flag   text,
  extra               jsonb
);
alter table public.raw_odds_observations enable row level security;
create index if not exists idx_obs_market_key on public.raw_odds_observations (market_key);
create index if not exists idx_obs_event      on public.raw_odds_observations (event_id);
create index if not exists idx_obs_book       on public.raw_odds_observations (bookmaker);
create index if not exists idx_obs_observed   on public.raw_odds_observations (observed_at);
create index if not exists idx_obs_source     on public.raw_odds_observations (source_type);
create index if not exists idx_obs_run        on public.raw_odds_observations (scrape_run_id);

create table if not exists public.export_jobs (
  export_id     text primary key,
  requested_at  timestamptz not null default now(),
  date_from     timestamptz,
  date_to       timestamptz,
  status        text,           -- pending | building | done | failed
  files         jsonb,          -- lista över genererade filer/storlekar
  summary       jsonb,          -- summary_metrics
  notes         text,
  extra         jsonb
);
alter table public.export_jobs enable row level security;
create index if not exists idx_export_requested on public.export_jobs (requested_at);
