-- 0012_data_quality.sql — datakvalitetsflaggor på signaler (steg 6).
-- ============================================================================
-- Workern klassar varje signal: clean | uncertain | suspicious_ev | mismatch.
--   clean        = ser legit ut (eller okänd: null = ingen känd brist)
--   uncertain    = gula flaggor (förhöjd EV, ingen event_id, ensam bok) → STANNAR
--                  active och spåras, bara MÄRKT (web visar, Strategy Lab kan exkl.)
--   suspicious_ev= EV osannolikt hög (>= tröskel) → nästan alltid stale/mismatch/
--                  formatfel → data_quality_issue (ut ur active, exkl. ur lärande).
--   mismatch     = marknads-mismatch-risk (needsReview) → data_quality_issue.
--
-- Två ändringar:
--   1) upsert_valuebet_signal sätter data_quality_flag OCH härleder status ur den
--      (suspicious_ev/mismatch → data_quality_issue direkt, ingen flicker).
--   2) sweep_signal_lifecycle låter 'uncertain' (och clean/ok) STANNA active —
--      bara hårt dåliga flaggor flyttas till data_quality_issue.
-- ============================================================================

create index if not exists idx_signals_data_quality on public.valuebet_signals (data_quality_flag);

-- 1) upsert: sätt data_quality_flag + status-från-flagga ------------------------
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
    current_soft_odds, sharp_fair_odds, ev_at_detection, current_ev, max_ev,
    sharp_sources_available, market_mismatch_risk, reason_summary, data_quality_flag,
    timing_bucket_sweden, hour_of_day_sweden, weekday_sweden,
    time_to_start_sec, time_to_start_bucket, extra, updated_at
  ) values (
    s->>'signal_id', s->>'market_key', nullif(s->>'event_id',''), s->>'sport', s->>'league',
    s->>'match', (nullif(s->>'start_time',''))::timestamptz, s->>'start_time_sweden',
    s->>'soft_bookmaker', s->>'market_type', s->>'selection', (nullif(s->>'line',''))::numeric,
    v_status,
    now(), s->>'first_detected_at_sweden', now(), 0,
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

-- 2) sweep: låt 'uncertain' stanna active (bara hårt dåliga flyttas) -------------
create or replace function public.sweep_signal_lifecycle(grace_sec int default null)
returns jsonb
language plpgsql
as $$
declare
  n_dq int; n_clv int; n_noclosing int; n_expired int; n_upgraded int;
  eff_grace int;
  cutoff timestamptz;
begin
  if grace_sec is null then
    select coalesce((value #>> '{}')::int, 120) into eff_grace
      from public.system_config where key = 'lifecycle_grace_sec';
    eff_grace := coalesce(eff_grace, 120);
  else
    eff_grace := grace_sec;
  end if;
  cutoff := now() - make_interval(secs => eff_grace);

  -- 1) Hårt dålig datakvalitet vinner alltid. 'uncertain' (gul) STANNAR active.
  update public.valuebet_signals
     set status = 'data_quality_issue', updated_at = now()
   where status not in ('data_quality_issue')
     and data_quality_flag is not null
     and data_quality_flag not in ('', 'ok', 'clean', 'uncertain');
  get diagnostics n_dq = row_count;

  -- 2) Avspark passerat + CLV settlad → closed_with_clv (täcker active OCH expired).
  update public.valuebet_signals
     set status = 'closed_with_clv', updated_at = now()
   where status in ('active', 'expired')
     and start_time < cutoff
     and clv_status = 'settled';
  get diagnostics n_clv = row_count;

  -- 3) Avspark passerat + ingen closing → closed_no_closing.
  update public.valuebet_signals
     set status = 'closed_no_closing', updated_at = now()
   where status in ('active', 'expired')
     and start_time < cutoff
     and clv_status = 'no_closing';
  get diagnostics n_noclosing = row_count;

  -- 4) Avspark passerat, CLV ännu ej avgjord → expired (övergångsläge).
  update public.valuebet_signals
     set status = 'expired', updated_at = now()
   where status = 'active'
     and start_time < cutoff
     and clv_status is null;
  get diagnostics n_expired = row_count;

  -- 5) Säkerhetsnät: expired som FÅTT clv (race) — uppgradera till closed_*.
  update public.valuebet_signals
     set status = case when clv_status = 'settled' then 'closed_with_clv' else 'closed_no_closing' end,
         updated_at = now()
   where status = 'expired' and clv_status in ('settled', 'no_closing');
  get diagnostics n_upgraded = row_count;

  return jsonb_build_object(
    'grace_sec', eff_grace,
    'data_quality_issue', n_dq,
    'closed_with_clv', n_clv,
    'closed_no_closing', n_noclosing,
    'expired', n_expired,
    'upgraded', n_upgraded,
    'swept_at', now()
  );
end;
$$;
