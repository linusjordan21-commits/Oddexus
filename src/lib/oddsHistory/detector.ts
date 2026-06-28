/**
 * Drop-detector — räknar förändring mellan nuvarande odds och tidigare
 * sample inom rullande tidsfönster (5/30 min).
 *
 * Pure functions. Tar history-Map från storage.ts, returnerar DropSignal[].
 */

import {
  DEFAULT_DROP_THRESHOLD_PCT,
  type DropSignal,
  type OddsHistoryEntry,
  type OddsKey,
} from "./types";

export interface DetectorOptions {
  /** Tidsfönster (minuter). 5 eller 30. */
  windowMinutes: number;
  /** Tröskel i procent (absolut värde). Drops < tröskeln ignoreras.
   *  Standard: 2 %. */
  thresholdPct?: number;
  /** Filter: bara visa drops (negativ change). Default true. */
  dropsOnly?: boolean;
  /** Filter: minst N samples i bufferten innan vi pålitar på detection.
   *  Skydd mot falska larm vid bara 1 sample. Default 2. */
  minSamples?: number;
}

/**
 * Hitta alla drops inom ett tidsfönster. För varje entry i historiken:
 *   1. Tag senaste sample (current)
 *   2. Sök bakåt efter äldsta sample inom windowMinutes
 *   3. Räkna procent-förändring
 *   4. Inkludera om |changePct| >= threshold
 */
export function detectDrops(
  history: Map<OddsKey, OddsHistoryEntry>,
  options: DetectorOptions,
): DropSignal[] {
  const {
    windowMinutes,
    thresholdPct = DEFAULT_DROP_THRESHOLD_PCT,
    dropsOnly = true,
    minSamples = 2,
  } = options;

  const windowMs = windowMinutes * 60 * 1000;
  const out: DropSignal[] = [];

  for (const [key, entry] of history) {
    if (entry.samples.length < minSamples) continue;
    const current = entry.samples[entry.samples.length - 1];
    const currentMs = Date.parse(current.ts);
    if (!Number.isFinite(currentMs)) continue;

    // Hitta äldsta sample inom fönstret (current_ts - windowMs <= ts <= current_ts).
    // Lookback: ta första sample som är "tillräckligt gammal" (>= windowAgo).
    const windowAgoMs = currentMs - windowMs;
    let previous = entry.samples[0];
    for (const s of entry.samples) {
      const sMs = Date.parse(s.ts);
      if (!Number.isFinite(sMs)) continue;
      if (sMs >= windowAgoMs && sMs < currentMs) {
        // Vi vill jämföra mot den ÄLDSTA sample inom fönstret för max-spann
        previous = s;
        break;
      }
    }
    // Om vi inte hittade en sample bakåt → fall tillbaka till första
    if (previous === current) {
      // Bara om vi har minst 2 samples: jämför mot näst-senaste även om
      // den ligger utanför fönstret (visar TOTAL movement)
      if (entry.samples.length >= 2) {
        previous = entry.samples[0];
      } else {
        continue;
      }
    }
    if (previous.ts === current.ts) continue;

    const changePct = ((current.odds / previous.odds) - 1) * 100;

    // dropsOnly = bara negativ (odds sjunker = sharp money kommer in)
    if (dropsOnly && changePct >= 0) continue;
    if (Math.abs(changePct) < thresholdPct) continue;

    out.push({
      key,
      match: entry.match,
      sport: entry.sport,
      league: entry.league,
      startTime: entry.startTime,
      market: entry.market,
      line: entry.line,
      selection: entry.selection,
      currentOdds: current.odds,
      previousOdds: previous.odds,
      changePct,
      windowMinutes,
      detectedAt: current.ts,
      previousAt: previous.ts,
      sampleCount: entry.samples.length,
    });
  }

  // Sortera största drops först (mest negativ changePct)
  out.sort((a, b) => a.changePct - b.changePct);
  return out;
}

/** Sparkline-data per key: senaste N samples som [x, y]-pairs.
 *  Används i UI för mini-grafer per rad. */
export function buildSparkline(
  entry: OddsHistoryEntry,
  maxPoints = 20,
): Array<{ ts: number; odds: number }> {
  const samples = entry.samples.slice(-maxPoints);
  return samples.map((s) => ({
    ts: Date.parse(s.ts),
    odds: s.odds,
  }));
}
