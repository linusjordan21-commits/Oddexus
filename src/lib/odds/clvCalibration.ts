/**
 * clvCalibration.ts — gör "hur mycket vi litar på var källa" MÄTT i stället för
 * gissat. Mäter per källa hur väl dess fair-prob vid besluts-ögonblicket förutspår
 * STÄNGNINGSLINJEN (closingFairProb = Pinnacles stängnings-no-vig), och härleder
 * en `clvMultiplier` per källa som matas tillbaka i consensus-vikterna.
 *
 * Logik: stängningslinjen är marknadens bästa skattning. Källan vars öppnings-
 * pris ligger NÄRMAST stängningen "leder" marknaden ⇒ är sharpast ⇒ förtjänar
 * högre vikt. RMSE(source.fairProb − closingFairProb) per källa; lägre = bättre.
 *   multiplier = clamp(median_rmse / source_rmse, MIN, MAX)
 * Otillräckligt urval (< minSamples settled) ⇒ 1.0 (ingen justering, säkert).
 *
 * Rent + testbart. scripts/clv-calibrate.ts kör detta mot data/clv-log.jsonl och
 * skriver data/clv-multipliers.json som consensus/sharpBlend läser.
 */

import type { MergedClvRecord } from "./clvLogger.ts";

export interface SourceSkill {
  sourceId: string;
  /** Antal settled beslut där källan bidrog med en fairProb. */
  samples: number;
  /** Root mean squared error mot closingFairProb (lägre = bättre predikt). */
  rmse: number | null;
  /** Mean absolute error (robust komplement). */
  mae: number | null;
  /** Genomsnittlig CLV% för besluten källan deltog i (kontext, ej vikt-grund). */
  avgClvPct: number | null;
}

/** Mät per-källa-prediktiv skicklighet mot stängningslinjen (pure). */
export function computeSourceSkill(records: MergedClvRecord[]): Record<string, SourceSkill> {
  const acc = new Map<string, { se: number; ae: number; n: number; clv: number; clvN: number }>();
  for (const r of records) {
    if (!r.settled || r.closingFairProb == null || !(r.closingFairProb > 0)) continue;
    const close = r.closingFairProb;
    for (const s of r.sourceSnapshot) {
      if (s.fairProb == null || !(s.fairProb >= 0)) continue;
      const a = acc.get(s.sourceId) ?? { se: 0, ae: 0, n: 0, clv: 0, clvN: 0 };
      const err = s.fairProb - close;
      a.se += err * err;
      a.ae += Math.abs(err);
      a.n += 1;
      if (r.clvPct != null) { a.clv += r.clvPct; a.clvN += 1; }
      acc.set(s.sourceId, a);
    }
  }
  const out: Record<string, SourceSkill> = {};
  for (const [sourceId, a] of acc) {
    out[sourceId] = {
      sourceId,
      samples: a.n,
      rmse: a.n > 0 ? Math.sqrt(a.se / a.n) : null,
      mae: a.n > 0 ? a.ae / a.n : null,
      avgClvPct: a.clvN > 0 ? a.clv / a.clvN : null,
    };
  }
  return out;
}

export interface CalibrationOptions {
  /** Min settled-samples per källa för att justera vikten. Default 40. */
  minSamples?: number;
  /** Clamp-intervall för multiplikatorn. Default [0.7, 1.3]. */
  min?: number;
  max?: number;
}

export interface CalibrationResult {
  generatedAt: string;
  /** clvMultiplier per sourceId (1.0 = ingen justering). */
  multipliers: Record<string, number>;
  /** Underliggande skicklighet per källa (för transparens/rapport). */
  skill: Record<string, SourceSkill>;
  /** Median-RMSE som användes som baslinje (null om för få kvalificerade källor). */
  baselineRmse: number | null;
  qualifiedSources: number;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Härled clvMultipliers per källa. Endast källor med tillräckligt urval OCH giltig
 * RMSE kvalificerar; baslinjen är medianen av de kvalificerades RMSE. En källa med
 * lägre RMSE än median (bättre predikt) får multiplikator > 1, högre RMSE < 1.
 * Okvalificerade ⇒ 1.0 (säkert default — påverkar inte vikten).
 */
export function deriveClvMultipliers(records: MergedClvRecord[], opts: CalibrationOptions = {}): CalibrationResult {
  const minSamples = opts.minSamples ?? 40;
  const min = opts.min ?? 0.7;
  const max = opts.max ?? 1.3;
  const skill = computeSourceSkill(records);

  const qualified = Object.values(skill).filter((s) => s.samples >= minSamples && s.rmse != null && (s.rmse as number) > 0);
  const baselineRmse = median(qualified.map((s) => s.rmse as number));

  const multipliers: Record<string, number> = {};
  for (const s of Object.values(skill)) {
    if (baselineRmse == null || s.samples < minSamples || s.rmse == null || !(s.rmse > 0)) {
      multipliers[s.sourceId] = 1.0;
      continue;
    }
    const raw = baselineRmse / s.rmse; // < median-fel ⇒ > 1
    multipliers[s.sourceId] = Math.max(min, Math.min(max, raw));
  }

  return {
    generatedAt: new Date().toISOString(),
    multipliers,
    skill,
    baselineRmse,
    qualifiedSources: qualified.length,
  };
}
