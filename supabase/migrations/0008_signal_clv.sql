-- 0008_signal_clv.sql — CLV (closing line value) på spårade signaler (fas 3a).
-- ============================================================================
-- Settle-jobbet (scripts/settle-tracking-clv.mjs) körs i shadow-clv-loopen där
-- Pinnacle closing-line redan finns på disk. För varje moneyline-signal vars
-- avspark passerat matchas closing via event_id, no-vig fair odds beräknas, och
-- CLV skrivs tillbaka hit. CLV = du slog (eller missade) den sanna closing-linjen
-- = det enda kvalitetsmåttet som inte kräver matchresultat. Idempotent.
-- ============================================================================

alter table public.valuebet_signals
  add column if not exists clv_status          text,        -- null | settled | no_closing
  add column if not exists clv_settled_at       timestamptz,
  add column if not exists closing_captured_at   timestamptz,
  add column if not exists closing_fair_odds      numeric,    -- no-vig Pinnacle closing för selectionen
  add column if not exists clv_pct                numeric,    -- soft_odds / closing_fair_odds - 1 (slog linjen?)
  add column if not exists clv_bet_odds           numeric;    -- odds CLV mättes på (soft_odds_at_detection)

create index if not exists idx_signals_clv_status on public.valuebet_signals (clv_status);
