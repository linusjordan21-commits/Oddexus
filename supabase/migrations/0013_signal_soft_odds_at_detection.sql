-- 0013_signal_soft_odds_at_detection.sql — CLV-fix: populera soft_odds_at_detection.
-- ============================================================================
-- BUGG (rotorsak till settled=0 på ALLA marknader): settle-tracking-clv.mjs läser
--   const betOdds = num(s.soft_odds_at_detection)
-- och grindar settle på `betOdds != null`. Men upsert_valuebet_signal (0012) skrev
-- ALDRIG kolumnen soft_odds_at_detection → den var alltid NULL → betOdds null →
-- ingen signal kunde någonsin settlas (bara no_closing efter 30 min). Closing-capture
-- fungerar; det enda som saknades var "vilket pris vi tog".
--
-- Denna migration speglar 0012:s upsert OFÖRÄNDRAD + ETT nytt fält:
--   INSERT: soft_odds_at_detection = soft_odds_at_detection (faller tillbaka på
--           current_soft_odds — vid första sikt är de identiska).
--   UPDATE: BEVARA värdet (coalesce) — bet odds vid detektion ska aldrig skrivas
--           över. Rader som saknar värde (redan aktiva signaler) backfillas med
--           nästa ticks odds, så CLV kan börja settlas direkt även för dem.
-- Ändrar INGEN prissättning, EV, eller lifecycle. sweep_signal_lifecycle rörs ej.
-- ============================================================================

create or replace function public.upsert_valuebet_signal(s jsonb)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  arr text[];
  v_dq text := nullif(s->>'data_quality_flag', '');
  v_status text;
begin
  select coalesce(array_agg(value::text), '{}') into arr
  from jsonb_array_elements_text(coalesce(s->'sharp_sources_available', '[]'::jsonb)) as value;

  -- Hårt dålig flagga → data_quality_issue direkt. clean/uncertain/null → active.
  v_status := case
    when v_dq is not null and v_dq not in ('ok', 'clean', 'uncertain') then 'data_quality_issue'
    else coalesce(s->>'status', 'active')
  end;

  insert into public.valuebet_signals (
    signal_id, market_key, event_id, sport, league, match, start_time, start_time_sweden,
    soft_bookmaker, market_type, selection, line, status,
    first_detected_at, first_detected_at_sweden, last_seen_at, duration_sec,
    soft_odds_at_detection, current_soft_odds, sharp_fair_odds, ev_at_detection, current_ev, max_ev,
    sharp_sources_available, market_mismatch_risk, reason_summary, data_quality_flag,
    timing_bucket_sweden, hour_of_day_sweden, weekday_sweden,
    time_to_start_sec, time_to_start_bucket, extra, updated_at
  ) values (
    s->>'signal_id', s->>'market_key', nullif(s->>'event_id',''), s->>'sport', s->>'league',
    s->>'match', (nullif(s->>'start_time',''))::timestamptz, s->>'start_time_sweden',
    s->>'soft_bookmaker', s->>'market_type', s->>'selection', (nullif(s->>'line',''))::numeric,
    v_status,
    now(), s->>'first_detected_at_sweden', now(), 0,
    coalesce((nullif(s->>'soft_odds_at_detection',''))::numeric, (nullif(s->>'current_soft_odds',''))::numeric),
    (nullif(s->>'current_soft_odds',''))::numeric, (nullif(s->>'sharp_fair_odds',''))::numeric,
    (nullif(s->>'current_ev',''))::numeric, (nullif(s->>'current_ev',''))::numeric, (nullif(s->>'current_ev',''))::numeric,
    arr, nullif(s->>'market_mismatch_risk',''), s->>'reason_summary', v_dq,
    s->>'timing_bucket_sweden', (nullif(s->>'hour_of_day_sweden',''))::int, (nullif(s->>'weekday_sweden',''))::int,
    (nullif(s->>'time_to_start_sec',''))::int, s->>'time_to_start_bucket', coalesce(s->'extra','{}'::jsonb), now()
  )
  on conflict (signal_id) do update set
    last_seen_at         = now(),
    status               = v_status,
    soft_bookmaker       = excluded.soft_bookmaker,
    -- BEVARA detektionsoddset; backfill rader som saknar det (gamla aktiva signaler).
    soft_odds_at_detection = coalesce(public.valuebet_signals.soft_odds_at_detection, excluded.soft_odds_at_detection),
    current_soft_odds    = excluded.current_soft_odds,
    sharp_fair_odds      = excluded.sharp_fair_odds,
    current_ev           = excluded.current_ev,
    max_ev               = greatest(coalesce(public.valuebet_signals.max_ev, excluded.current_ev), excluded.current_ev),
    sharp_sources_available = excluded.sharp_sources_available,
    market_mismatch_risk = excluded.market_mismatch_risk,
    reason_summary       = excluded.reason_summary,
    data_quality_flag    = excluded.data_quality_flag,
    time_to_start_sec    = excluded.time_to_start_sec,
    time_to_start_bucket = excluded.time_to_start_bucket,
    extra                = excluded.extra,
    duration_sec         = greatest(0, extract(epoch from (now() - public.valuebet_signals.first_detected_at))::int),
    updated_at           = now();
end;
$$;

revoke all on function public.upsert_valuebet_signal(jsonb) from public, anon, authenticated;
