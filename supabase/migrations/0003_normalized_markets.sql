-- 0003_normalized_markets.sql — stabil market-registry (market_key)
-- ============================================================================
-- Kanonisk marknad per stabil `market_key` (se src/lib/markets/marketKey.ts).
-- Alla fas-1-tabeller (signals, snapshots, observations, movement_events,
-- decisions, outcomes) länkar hit via market_key. Detta gör att en match-marknad
-- har EN identitet oavsett vilken bok/källa som rapporterar den.
-- Idempotent. Inga rader seedas (fylls av workern i fas 1).
-- ============================================================================

create table if not exists public.normalized_markets (
  market_key        text primary key,
  sport             text not null,
  league            text,
  event_id          text,
  home_team         text,
  away_team         text,
  start_time        timestamptz,
  market_type       text not null,          -- 1x2 | moneyline | ah | eh3 | total | asian_total | corner_total | corner_ah | team_total ...
  period            text not null default 'ft', -- ft | fh | sh
  line              numeric,                 -- null för 1x2/moneyline
  selection         text,                    -- HOME/DRAW/AWAY/OVER/UNDER/...
  data_quality_flag text,                    -- null | 'low' | 'mismatch_risk' ...
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

alter table public.normalized_markets enable row level security;

create index if not exists idx_norm_markets_event   on public.normalized_markets (event_id);
create index if not exists idx_norm_markets_sport   on public.normalized_markets (sport);
create index if not exists idx_norm_markets_start   on public.normalized_markets (start_time);
create index if not exists idx_norm_markets_type    on public.normalized_markets (market_type);
create index if not exists idx_norm_markets_lastsee on public.normalized_markets (last_seen_at);
