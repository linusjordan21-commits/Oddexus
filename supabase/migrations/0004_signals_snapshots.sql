-- 0004_signals_snapshots.sql — kärnan i learning-systemet (fas 1)
-- ============================================================================
-- valuebet_signals     : en rad per valuebet-möjlighet (case), uppdateras över tid.
-- decision_snapshots   : point-in-time-bild vid beslutsögonblick (LOOK-AHEAD-SÄKER).
-- market_mismatch_warnings : sparade mismatch-flaggor (se src/lib/markets/marketKey.ts).
-- Allt länkas via market_key + signal_id. Idempotent.
-- ============================================================================

create table if not exists public.valuebet_signals (
  signal_id                 text primary key,
  market_key                text not null,
  event_id                  text,
  sport                     text,
  league                    text,
  match                     text,
  start_time                timestamptz,
  start_time_sweden         text,
  soft_bookmaker            text,
  market_type               text,
  selection                 text,
  line                      numeric,
  status                    text not null default 'active',  -- active | expired | closed
  first_detected_at         timestamptz not null default now(),
  first_detected_at_sweden  text,
  last_seen_at              timestamptz not null default now(),
  duration_sec              integer,
  -- odds / fair price
  soft_odds_at_detection    numeric,
  current_soft_odds         numeric,
  sharp_fair_odds           numeric,
  sharp_consensus_fair_odds numeric,
  no_vig_fair_odds          numeric,
  ev_at_detection           numeric,
  max_ev                    numeric,
  current_ev                numeric,
  average_ev                numeric,
  -- sharp / kvalitet
  sharp_source_used         text,
  sharp_sources_available   text[],
  sharp_consensus_score     numeric,
  sharp_disagreement_score  numeric,
  liquidity_score           numeric,
  stability_score           numeric,
  volatility_score          numeric,
  stale_duration_sec        integer,
  soft_lag_sec              integer,
  reversal_score            numeric,
  market_quality_score      numeric,
  market_mismatch_risk      text,
  data_quality_flag         text,
  classification            text,
  confidence_grade          text,
  quality_score             numeric,
  reason_summary            text,
  risk_warnings             text[],
  strategy_tags             text[],
  -- timing (svensk tid)
  timing_bucket_sweden      text,
  hour_of_day_sweden        integer,
  weekday_sweden            integer,
  time_to_start_sec         integer,
  time_to_start_bucket      text,
  linked_movement_ids       text[],
  extra                     jsonb,
  updated_at                timestamptz not null default now()
);

alter table public.valuebet_signals enable row level security;
create index if not exists idx_signals_market_key on public.valuebet_signals (market_key);
create index if not exists idx_signals_event      on public.valuebet_signals (event_id);
create index if not exists idx_signals_sport      on public.valuebet_signals (sport);
create index if not exists idx_signals_status     on public.valuebet_signals (status);
create index if not exists idx_signals_detected   on public.valuebet_signals (first_detected_at);
create index if not exists idx_signals_book       on public.valuebet_signals (soft_bookmaker);
create index if not exists idx_signals_grade      on public.valuebet_signals (confidence_grade);
create index if not exists idx_signals_ttsbucket  on public.valuebet_signals (time_to_start_bucket);

-- ── decision_snapshots: BARA data som fanns vid tidpunkten (ingen closing/CLV/resultat) ──
create table if not exists public.decision_snapshots (
  snapshot_id                 text primary key,
  signal_id                   text not null,
  market_key                  text,
  taken_at                    timestamptz not null default now(),
  taken_at_sweden             text,
  trigger                     text,  -- first_seen | ev_change | sharp_change | stale_threshold | reversal | disappeared | user_action
  hour_of_day_sweden          integer,
  weekday_sweden              integer,
  time_bucket_sweden          text,
  time_to_start_sec           integer,
  time_to_start_bucket        text,
  soft_odds                   numeric,
  sharp_fair_odds             numeric,
  sharp_consensus_fair_odds   numeric,
  ev                          numeric,
  sharp_consensus_score       numeric,
  sharp_disagreement_score    numeric,
  liquidity_score             numeric,
  betfair_spread_score        numeric,
  betfair_liquidity           numeric,
  stale_duration_so_far_sec   integer,
  volatility_score            numeric,
  reversal_score_so_far       numeric,
  market_mismatch_risk        text,
  confidence_grade_at_time    text,
  classification_at_time      text,
  risk_warnings_at_time       text[],
  recommended_action_at_time  text,  -- bet | watch | avoid | manual_review
  strategy_eligibility_tags   text[],
  extra                       jsonb,
  created_at                  timestamptz not null default now()
);

alter table public.decision_snapshots enable row level security;
create index if not exists idx_snap_signal     on public.decision_snapshots (signal_id);
create index if not exists idx_snap_market_key  on public.decision_snapshots (market_key);
create index if not exists idx_snap_taken       on public.decision_snapshots (taken_at);
create index if not exists idx_snap_ttsbucket   on public.decision_snapshots (time_to_start_bucket);
create index if not exists idx_snap_timebucket  on public.decision_snapshots (time_bucket_sweden);

-- ── market_mismatch_warnings ─────────────────────────────────────────────────
create table if not exists public.market_mismatch_warnings (
  warning_id      text primary key,
  market_key      text,
  signal_id       text,
  event_id        text,
  detected_at     timestamptz not null default now(),
  codes           text[],          -- MARKET_TYPE_DIFF | LINE_DIFF | ASIAN_VS_DECIMAL_TOTAL | ...
  soft_bookmaker  text,
  sharp_source    text,
  severity        text,            -- low | medium | high
  detail          text,
  extra           jsonb
);

alter table public.market_mismatch_warnings enable row level security;
create index if not exists idx_mismatch_market_key on public.market_mismatch_warnings (market_key);
create index if not exists idx_mismatch_signal     on public.market_mismatch_warnings (signal_id);
create index if not exists idx_mismatch_detected   on public.market_mismatch_warnings (detected_at);
