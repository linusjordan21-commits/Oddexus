/**
 * analyticsConfig.ts — config-driven trösklar (single source of defaults).
 *
 * DEFAULT_ANALYTICS_CONFIG = EXAKT nuvarande hårdkodade värden → att läsa config
 * kan aldrig ändra befintligt beteende förrän du medvetet ändrar ett värde i
 * system_config-tabellen (migration 0002). Modulen är dependency-fri och kastar
 * aldrig: servern läser system_config (cachad, var ~5 min) och mergar via
 * mergeConfigRows(); vid fel/saknad tabell behålls defaults.
 *
 * Webben DRIVER inte analysen — detta är bara lättviktiga trösklar som läses.
 */

export interface ScoreGradeThresholds {
  A_plus: number;
  A: number;
  B: number;
  C: number;
  avoid: number;
}

export interface AnalyticsConfig {
  // ── Befintliga valuebet-trösklar (wired i vite.config.ts) ──
  valueBetEvThreshold: number;
  valueBetReviewThreshold: number;
  valueBetRejectThreshold: number;
  valueBetTimeToleranceMs: number;
  pinnacleFreshnessThresholdMs: number;
  sharpFreshnessThresholdMs: number;
  // ── Scoring (fas 1+) ──
  scoreGradeThresholds: ScoreGradeThresholds;
  minLiquidityScore: number;
  sharpAgreementThreshold: number;
  // ── Timing (fas 1+) ──
  timezoneDisplay: string;
  timingBucketsSweden: string[];
  timeToStartBuckets: string[];
  // ── Reliability / sample-size (fas 1+) ──
  clvSuccessThreshold: number;
  minObservationsTiming: number;
  minObservationsStrategy: number;
  sampleSizeWarningThreshold: number;
  // ── Allt övrigt från system_config bevaras (penalties, stale-trösklar, ...) ──
  raw: Record<string, unknown>;
}

export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  valueBetEvThreshold: 0.02,
  valueBetReviewThreshold: 0.1,
  valueBetRejectThreshold: 0.25,
  valueBetTimeToleranceMs: 5 * 60 * 1000,
  pinnacleFreshnessThresholdMs: 3 * 60 * 1000,
  sharpFreshnessThresholdMs: 3 * 60 * 1000,
  scoreGradeThresholds: { A_plus: 85, A: 70, B: 55, C: 40, avoid: 25 },
  minLiquidityScore: 0.3,
  sharpAgreementThreshold: 0.6,
  timezoneDisplay: "Europe/Stockholm",
  timingBucketsSweden: ["00-03", "03-06", "06-09", "09-12", "12-15", "15-18", "18-21", "21-24"],
  timeToStartBuckets: ["48h+", "24-48h", "12-24h", "6-12h", "3-6h", "1-3h", "30-60m", "0-30m"],
  clvSuccessThreshold: 0,
  minObservationsTiming: 30,
  minObservationsStrategy: 40,
  sampleSizeWarningThreshold: 20,
  raw: {},
};

/** DB-nyckel (snake_case) → typad config-väg. Okända nycklar hamnar i `raw`. */
type Row = { key: string; value: unknown };

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Slå ihop system_config-rader ovanpå defaults. Aldrig kasta — okänt/ogiltigt
 * värde behåller default. Returnerar en NY config (muterar inte defaults).
 */
export function mergeConfigRows(rows: Row[] | null | undefined): AnalyticsConfig {
  const out: AnalyticsConfig = {
    ...DEFAULT_ANALYTICS_CONFIG,
    scoreGradeThresholds: { ...DEFAULT_ANALYTICS_CONFIG.scoreGradeThresholds },
    timingBucketsSweden: [...DEFAULT_ANALYTICS_CONFIG.timingBucketsSweden],
    timeToStartBuckets: [...DEFAULT_ANALYTICS_CONFIG.timeToStartBuckets],
    raw: {},
  };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || typeof r.key !== "string") continue;
    out.raw[r.key] = r.value;
    switch (r.key) {
      case "value_bet_ev_threshold": out.valueBetEvThreshold = num(r.value, out.valueBetEvThreshold); break;
      case "value_bet_review_threshold": out.valueBetReviewThreshold = num(r.value, out.valueBetReviewThreshold); break;
      case "value_bet_reject_threshold": out.valueBetRejectThreshold = num(r.value, out.valueBetRejectThreshold); break;
      case "value_bet_time_tolerance_ms": out.valueBetTimeToleranceMs = num(r.value, out.valueBetTimeToleranceMs); break;
      case "pinnacle_freshness_threshold_ms": out.pinnacleFreshnessThresholdMs = num(r.value, out.pinnacleFreshnessThresholdMs); break;
      case "sharp_freshness_threshold_ms": out.sharpFreshnessThresholdMs = num(r.value, out.sharpFreshnessThresholdMs); break;
      case "min_liquidity_score": out.minLiquidityScore = num(r.value, out.minLiquidityScore); break;
      case "sharp_agreement_threshold": out.sharpAgreementThreshold = num(r.value, out.sharpAgreementThreshold); break;
      case "clv_success_threshold": out.clvSuccessThreshold = num(r.value, out.clvSuccessThreshold); break;
      case "min_observations_timing": out.minObservationsTiming = num(r.value, out.minObservationsTiming); break;
      case "min_observations_strategy": out.minObservationsStrategy = num(r.value, out.minObservationsStrategy); break;
      case "sample_size_warning_threshold": out.sampleSizeWarningThreshold = num(r.value, out.sampleSizeWarningThreshold); break;
      case "score_grade_thresholds":
        if (r.value && typeof r.value === "object") {
          const g = r.value as Partial<ScoreGradeThresholds>;
          out.scoreGradeThresholds = {
            A_plus: num(g.A_plus, out.scoreGradeThresholds.A_plus),
            A: num(g.A, out.scoreGradeThresholds.A),
            B: num(g.B, out.scoreGradeThresholds.B),
            C: num(g.C, out.scoreGradeThresholds.C),
            avoid: num(g.avoid, out.scoreGradeThresholds.avoid),
          };
        }
        break;
      case "timezone_display": if (typeof r.value === "string") out.timezoneDisplay = r.value; break;
      case "timing_buckets_sweden": if (Array.isArray(r.value)) out.timingBucketsSweden = r.value.map(String); break;
      case "time_to_start_buckets": if (Array.isArray(r.value)) out.timeToStartBuckets = r.value.map(String); break;
      default: break; // bevaras i raw
    }
  }
  return out;
}

// ── Process-global cache (init = defaults; servern uppdaterar via setAnalyticsConfig) ──
let cached: AnalyticsConfig = DEFAULT_ANALYTICS_CONFIG;

/** Synkron, kastar aldrig — hot path får alltid en giltig config. */
export function getAnalyticsConfig(): AnalyticsConfig {
  return cached;
}

/** Sätt aktiv config (anropas av serverns periodiska refresh). */
export function setAnalyticsConfig(cfg: AnalyticsConfig): void {
  cached = cfg;
}
