-- 0010_lifecycle_config.sql — gör lifecycle-sweepens grace config-driven (steg 2).
-- ============================================================================
-- grace_sec = marginal efter avspark innan en 'active' signal expireras. Nu
-- läsbar ur system_config('lifecycle_grace_sec') så vi kan testa 2/5/10 min
-- utan kodändring. Anropa sweep_signal_lifecycle() utan argument → läser config.
-- Explicit argument (sweep_signal_lifecycle(300)) överstyr fortfarande.
-- ============================================================================

insert into public.system_config (key, value, category, description) values
  ('lifecycle_grace_sec', '120', 'lifecycle', 'Sekunder efter avspark innan signal expireras')
on conflict (key) do nothing;

create or replace function public.sweep_signal_lifecycle(grace_sec int default null)
returns jsonb
language plpgsql
as $$
declare
  n_dq int; n_clv int; n_noclosing int; n_expired int; n_upgraded int;
  eff_grace int;
  cutoff timestamptz;
begin
  -- Config-driven grace om inget argument gavs (fallback 120s).
  if grace_sec is null then
    select coalesce((value #>> '{}')::int, 120) into eff_grace
      from public.system_config where key = 'lifecycle_grace_sec';
    eff_grace := coalesce(eff_grace, 120);
  else
    eff_grace := grace_sec;
  end if;
  cutoff := now() - make_interval(secs => eff_grace);

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
