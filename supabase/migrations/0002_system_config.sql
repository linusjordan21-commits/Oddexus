-- 0002_system_config.sql — config-driven thresholds (analytics/scoring/timing)
-- ============================================================================
-- Key-value-config så viktiga trösklar inte är hårdkodade. Backend läser denna
-- (cachad, fallback till kod-defaults) → Strategy Lab/scoring/timing kan tunas
-- utan kodändring. Seed = EXAKT nuvarande hårdkodade värden (befintligt beteende
-- oförändrat) + förberedda analytics-knappar för fas 1/2.
--
-- `on conflict do nothing` → re-apply skriver ALDRIG över ett värde du ändrat.
-- ============================================================================

create table if not exists public.system_config (
  key         text primary key,
  value       jsonb not null,
  category    text,
  description text,
  updated_at  timestamptz not null default now()
);

alter table public.system_config enable row level security;

-- ── Befintliga valuebet-trösklar (nuvarande exakta värden) ──────────────────
insert into public.system_config (key, value, category, description) values
  ('value_bet_ev_threshold',          '0.02',   'valuebet', 'Min EV (decimal) för att räknas som valuebet'),
  ('value_bet_review_threshold',      '0.10',   'valuebet', 'EV över denna flaggas needsReview'),
  ('value_bet_reject_threshold',      '0.25',   'valuebet', 'EV över denna avvisas som dataerror'),
  ('value_bet_time_tolerance_ms',     '300000', 'valuebet', 'Tids-tolerans matchstart mellan böcker (ms)'),
  ('pinnacle_freshness_threshold_ms', '180000', 'freshness','Pinnacle äldre än detta → 0 valuebets (ms)'),
  ('sharp_freshness_threshold_ms',    '180000', 'freshness','Sekundära sharps äldre än detta utesluts (ms)')
on conflict (key) do nothing;

-- ── Scoring (fas 1+: valuebet quality score → A+/A/B/C/D) ────────────────────
insert into public.system_config (key, value, category, description) values
  ('score_grade_thresholds',  '{"A_plus":85,"A":70,"B":55,"C":40,"avoid":25}', 'scoring', 'Score (0-100) → grade-trösklar'),
  ('min_liquidity_score',     '0.3',  'scoring', 'Min likviditetsscore innan low-liquidity-penalty'),
  ('market_mismatch_penalty', '20',   'scoring', 'Poängavdrag vid market mismatch risk'),
  ('low_liquidity_penalty',   '15',   'scoring', 'Poängavdrag vid låg likviditet'),
  ('live_market_penalty',     '25',   'scoring', 'Poängavdrag för live-marknad'),
  ('fake_drop_penalty',       '25',   'scoring', 'Poängavdrag vid fake-drop-risk'),
  ('data_quality_penalty',    '15',   'scoring', 'Poängavdrag vid låg datakvalitet'),
  ('sharp_agreement_threshold','0.6', 'scoring', 'Min sharp-agreement för "sharp confirmed"')
on conflict (key) do nothing;

-- ── Stale / fake-drop (fas 2) ───────────────────────────────────────────────
insert into public.system_config (key, value, category, description) values
  ('stale_duration_thresholds_sec', '[60,180,300,600]', 'movement', 'Stale-trösklar (1/3/5/10 min) för snapshots'),
  ('fake_drop_reversal_window_sec', '300',              'movement', 'Fönster för att räkna en rörelse som reversal')
on conflict (key) do nothing;

-- ── Timing (fas 1+: svensk tid) ─────────────────────────────────────────────
insert into public.system_config (key, value, category, description) values
  ('timing_buckets_sweden',  '["00-03","03-06","06-09","09-12","12-15","15-18","18-21","21-24"]', 'timing', 'Tidsfönster (svensk klocktid)'),
  ('time_to_start_buckets',  '["48h+","24-48h","12-24h","6-12h","3-6h","1-3h","30-60m","0-30m"]', 'timing', 'Time-to-start-buckets'),
  ('timezone_display',       '"Europe/Stockholm"', 'timing', 'Tidszon för all UI/analys-tid')
on conflict (key) do nothing;

-- ── Sample-size / reliability (fas 1+) ──────────────────────────────────────
insert into public.system_config (key, value, category, description) values
  ('clv_success_threshold',         '0.0', 'reliability', 'CLV%% över detta = slog closing line'),
  ('min_observations_timing',       '30',  'reliability', 'Min observationer för timing-rekommendation'),
  ('min_observations_strategy',     '40',  'reliability', 'Min signaler för pålitligt strategi-resultat'),
  ('sample_size_warning_threshold', '20',  'reliability', 'Under detta visas "not enough data yet"')
on conflict (key) do nothing;
