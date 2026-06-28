-- 0005_decisions_outcomes.sql — beslut + utfall/CLV (fas 1)
-- ============================================================================
-- user_decisions : logged/skipped/watched/rejected (lika lärorikt som spelade).
-- logged_bets    : professionell bet-journal i Supabase, länkad till signal.
-- bet_outcomes   : closing line + CLV + result + process quality (efteråt).
-- Allt länkas via signal_id / snapshot_id / decision_id / bet_id. Idempotent.
-- ============================================================================

create table if not exists public.user_decisions (
  decision_id               text primary key,
  signal_id                 text,
  snapshot_id               text,
  decided_at                timestamptz not null default now(),
  decided_at_sweden         text,
  decision_type             text not null,  -- placed | skipped | watched | manually_confirmed |
                                            -- rejected_market_mismatch | rejected_low_liquidity |
                                            -- rejected_fake_drop | rejected_odds_gone |
                                            -- rejected_too_close_to_start | rejected_data_quality |
                                            -- rejected_bonus_terms | other
  reason                    text,
  manual_note               text,
  stake                     numeric,
  odds_taken                numeric,
  bookmaker                 text,
  strategy_tags_at_decision text[],
  confidence_at_decision    text,
  timing_bucket_sweden      text,
  time_to_start_bucket      text,
  graph_reference           text,
  extra                     jsonb
);

alter table public.user_decisions enable row level security;
create index if not exists idx_dec_signal on public.user_decisions (signal_id);
create index if not exists idx_dec_type   on public.user_decisions (decision_type);
create index if not exists idx_dec_at     on public.user_decisions (decided_at);

-- ── logged_bets ──────────────────────────────────────────────────────────────
create table if not exists public.logged_bets (
  bet_id                     text primary key,
  signal_id                  text,
  snapshot_id                text,
  decision_id                text,
  username                   text,
  match                      text,
  league                     text,
  market                     text,
  line                       numeric,
  selection                  text,
  bookmaker                  text,
  odds_taken                 numeric,
  stake                      numeric,
  bankroll_at_time           numeric,
  ev_at_time                 numeric,
  confidence_grade_at_time   text,
  classification_at_time     text,
  reason_for_bet             text,
  warnings_at_time           text[],
  sharp_fair_odds_at_time    numeric,
  closing_fair_odds          numeric,
  clv_pct                    numeric,
  result                     text,      -- won | lost | push | void | unknown
  profit_loss                numeric,
  notes                      text,
  lesson_learned             text,
  graph_reference            text,
  placed_at                  timestamptz,
  settled_at                 timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  extra                      jsonb
);

alter table public.logged_bets enable row level security;
create index if not exists idx_bets_signal on public.logged_bets (signal_id);
create index if not exists idx_bets_user   on public.logged_bets (username);
create index if not exists idx_bets_book    on public.logged_bets (bookmaker);
create index if not exists idx_bets_placed  on public.logged_bets (placed_at);

-- ── bet_outcomes (closing line + CLV + process quality) ──────────────────────
create table if not exists public.bet_outcomes (
  outcome_id                    text primary key,
  signal_id                     text,
  decision_id                   text,
  bet_id                        text,
  closing_odds                  numeric,
  closing_fair_odds             numeric,
  closing_at                    timestamptz,
  closing_at_sweden             text,
  clv_pct                       numeric,
  clv_absolute                  numeric,
  result                        text,    -- won | lost | push | void | unknown
  profit_loss                   numeric,
  roi                           numeric,
  signal_confirmed_by_closing   text,    -- yes | no | unclear
  final_classification          text,
  process_quality               text,    -- good_process | bad_process | unclear | data_quality_issue
  lesson_learned                text,
  created_at                    timestamptz not null default now(),
  extra                         jsonb
);

alter table public.bet_outcomes enable row level security;
create index if not exists idx_out_signal   on public.bet_outcomes (signal_id);
create index if not exists idx_out_decision on public.bet_outcomes (decision_id);
create index if not exists idx_out_bet      on public.bet_outcomes (bet_id);
create index if not exists idx_out_created  on public.bet_outcomes (created_at);
