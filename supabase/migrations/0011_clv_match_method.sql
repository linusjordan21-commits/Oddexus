-- 0011_clv_match_method.sql — spårbarhet för CLV-matchning (steg 3).
-- ============================================================================
-- Hur closing matchades till signalen vid CLV-settling:
--   exact              = exakt event_id (huvudväg, högst confidence)
--   fallback_team_time = event_id saknades → matchad på normaliserade lag +
--                        avspark ± tolerans (unik träff). LÄGRE confidence.
-- Egen kolumn (INTE data_quality_flag) så lifecycle-sweepen inte felaktigt
-- markerar fallback-CLV som 'data_quality_issue'. Null = ej settlad ännu.
-- ============================================================================

alter table public.valuebet_signals
  add column if not exists clv_match_method text;

create index if not exists idx_signals_clv_method on public.valuebet_signals (clv_match_method);
