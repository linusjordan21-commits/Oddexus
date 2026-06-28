-- 0009_signal_lifecycle.sql — signal lifecycle sweep (steg 1).
-- ============================================================================
-- Signaler får ALDRIG ligga kvar som 'active' efter avspark. En set-baserad
-- sweep (en RPC, körs av persist-signals var ~5 min) flyttar dem:
--
--   active            → matchen är framtida ELLER syns fortfarande live
--   expired           → avspark passerat, CLV ej avgjord ännu (övergångsläge)
--   closed_with_clv   → avspark passerat + CLV settlad
--   closed_no_closing → avspark passerat + ingen closing fångades
--   data_quality_issue→ datakvalitetsflagga satt (steg 6) — vinner över allt
--
-- 'expired' är ett ÖVERGÅNGSLÄGE: settle-tracking-clv kan fortfarande sätta
-- clv_status senare, och nästa sweep uppgraderar då expired → closed_*.
-- Idempotent + set-baserad (inga per-rad-anrop). grace_sec = marginal efter
-- avspark innan vi expirar (matchar closing-fönstrets maxAfter).
-- ============================================================================

create index if not exists idx_signals_start_time on public.valuebet_signals (start_time);

create or replace function public.sweep_signal_lifecycle(grace_sec int default 120)
returns jsonb
language plpgsql
as $$
declare
  n_dq int; n_clv int; n_noclosing int; n_expired int; n_upgraded int;
  cutoff timestamptz := now() - make_interval(secs => grace_sec);
begin
  -- 1) Datakvalitetsproblem vinner alltid (sätts av steg 6 via data_quality_flag).
  update public.valuebet_signals
     set status = 'data_quality_issue', updated_at = now()
   where status not in ('data_quality_issue')
     and data_quality_flag is not null
     and data_quality_flag not in ('', 'ok', 'clean');
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

  -- 5) Säkerhetsnät: expired som FÅTT clv men missades ovan (race) — uppgradera.
  update public.valuebet_signals
     set status = case when clv_status = 'settled' then 'closed_with_clv' else 'closed_no_closing' end,
         updated_at = now()
   where status = 'expired' and clv_status in ('settled', 'no_closing');
  get diagnostics n_upgraded = row_count;

  return jsonb_build_object(
    'data_quality_issue', n_dq,
    'closed_with_clv', n_clv,
    'closed_no_closing', n_noclosing,
    'expired', n_expired,
    'upgraded', n_upgraded,
    'swept_at', now()
  );
end;
$$;
