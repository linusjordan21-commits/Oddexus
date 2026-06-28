-- 0007_upsert_signal_fn.sql — upsert-funktion för valuebet_signals (fas 1b)
-- ============================================================================
-- Workern (scripts/persist-signals.mjs) kör denna var ~5 min per signal. Funktionen
-- bevarar first_detected_at + ev_at_detection (sätts bara vid INSERT) och ackumulerar
-- max_ev = störst hittills. Anropas via rpc/upsert_valuebet_signal. Idempotent.
-- ============================================================================

create or replace function public.upsert_valuebet_signal(s jsonb)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  arr text[];
begin
  -- sharp_sources_available kommer som jsonb-array → text[]
  select coalesce(array_agg(value::text), '{}') into arr
  from jsonb_array_elements_text(coalesce(s->'sharp_sources_available', '[]'::jsonb)) as value;

  insert into public.valuebet_signals (
    signal_id, market_key, event_id, sport, league, match, start_time, start_time_sweden,
    soft_bookmaker, market_type, selection, line, status,
    first_detected_at, first_detected_at_sweden, last_seen_at, duration_sec,
    current_soft_odds, sharp_fair_odds, ev_at_detection, current_ev, max_ev,
    sharp_sources_available, market_mismatch_risk, reason_summary,
    timing_bucket_sweden, hour_of_day_sweden, weekday_sweden,
    time_to_start_sec, time_to_start_bucket, extra, updated_at
  ) values (
    s->>'signal_id', s->>'market_key', nullif(s->>'event_id',''), s->>'sport', s->>'league',
    s->>'match', (nullif(s->>'start_time',''))::timestamptz, s->>'start_time_sweden',
    s->>'soft_bookmaker', s->>'market_type', s->>'selection', (nullif(s->>'line',''))::numeric,
    coalesce(s->>'status','active'),
    now(), s->>'first_detected_at_sweden', now(), 0,
    (nullif(s->>'current_soft_odds',''))::numeric, (nullif(s->>'sharp_fair_odds',''))::numeric,
    (nullif(s->>'current_ev',''))::numeric, (nullif(s->>'current_ev',''))::numeric, (nullif(s->>'current_ev',''))::numeric,
    arr, nullif(s->>'market_mismatch_risk',''), s->>'reason_summary',
    s->>'timing_bucket_sweden', (nullif(s->>'hour_of_day_sweden',''))::int, (nullif(s->>'weekday_sweden',''))::int,
    (nullif(s->>'time_to_start_sec',''))::int, s->>'time_to_start_bucket', coalesce(s->'extra','{}'::jsonb), now()
  )
  on conflict (signal_id) do update set
    last_seen_at         = now(),
    status               = 'active',
    soft_bookmaker       = excluded.soft_bookmaker,
    current_soft_odds    = excluded.current_soft_odds,
    sharp_fair_odds      = excluded.sharp_fair_odds,
    current_ev           = excluded.current_ev,
    max_ev               = greatest(coalesce(public.valuebet_signals.max_ev, excluded.current_ev), excluded.current_ev),
    sharp_sources_available = excluded.sharp_sources_available,
    market_mismatch_risk = excluded.market_mismatch_risk,
    reason_summary       = excluded.reason_summary,
    time_to_start_sec    = excluded.time_to_start_sec,
    time_to_start_bucket = excluded.time_to_start_bucket,
    extra                = excluded.extra,
    duration_sec         = greatest(0, extract(epoch from (now() - public.valuebet_signals.first_detected_at))::int),
    updated_at           = now();
  -- first_detected_at, first_detected_at_sweden, ev_at_detection ej i UPDATE → bevaras.
end;
$$;

revoke all on function public.upsert_valuebet_signal(jsonb) from public, anon, authenticated;
