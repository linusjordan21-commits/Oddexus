/**
 * clvAnalysis.ts — läser CLV-loggen (mergeade open+settle-rader) och räknar
 * per-cell-statistik: average/median CLV, hit rate mot closing line,
 * false-positive rate, antal samples och auto/review/no-bet-fördelning.
 *
 * Syfte: se vilka celler (källa × sport × market × league × tts × scenario)
 * som förtjänar högre/lägre trust. INGA automatiska ändringar görs här —
 * bara mätning (rekommendationer i trustFeedback.ts).
 */

import type { MergedClvRecord } from "./clvLogger.ts";
import { dedupeForAnalysis } from "./clvDedupe.ts";

export interface CellStats {
  cell: string;
  /** Alla beslut i cellen (inkl. NO_BET). */
  samples: number;
  /** Hur många som hunnit få closing line (settled). */
  settledSamples: number;
  /** Beslut som flaggades som value (AUTO_BET eller MANUAL_REVIEW). */
  valueFlagged: number;
  avgClvPct: number | null;
  medianClvPct: number | null;
  /** Andel settled med clvPct > 0 (slog stängningen). */
  hitRate: number | null;
  /** Andel value-flaggade settled med clvPct ≤ 0 (falskt value). */
  falsePositiveRate: number | null;
  /** Andel value-flaggade som faktiskt vann (om utfall känt). */
  winRate: number | null;
  autoCount: number;
  reviewCount: number;
  noBetCount: number;
  needsValidationCount: number;
  avgConfidence: number | null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function isValueFlagged(decision: string): boolean {
  return decision === "AUTO_BET" || decision === "MANUAL_REVIEW";
}

/** Räkna statistik för en grupp records (pure). */
export function computeCellStats(cell: string, records: MergedClvRecord[]): CellStats {
  const settled = records.filter((r) => r.settled && r.clvPct != null);
  const clvs = settled.map((r) => r.clvPct as number);
  const flagged = records.filter((r) => isValueFlagged(r.decision));
  const flaggedSettled = settled.filter((r) => isValueFlagged(r.decision));
  const flaggedWithOutcome = flaggedSettled.filter((r) => r.won != null);

  const hitRate = settled.length ? settled.filter((r) => (r.clvPct as number) > 0).length / settled.length : null;
  const falsePositiveRate = flaggedSettled.length
    ? flaggedSettled.filter((r) => (r.clvPct as number) <= 0).length / flaggedSettled.length
    : null;
  const winRate = flaggedWithOutcome.length
    ? flaggedWithOutcome.filter((r) => r.won === true).length / flaggedWithOutcome.length
    : null;

  return {
    cell,
    samples: records.length,
    settledSamples: settled.length,
    valueFlagged: flagged.length,
    avgClvPct: mean(clvs),
    medianClvPct: median(clvs),
    hitRate,
    falsePositiveRate,
    winRate,
    autoCount: records.filter((r) => r.decision === "AUTO_BET").length,
    reviewCount: records.filter((r) => r.decision === "MANUAL_REVIEW").length,
    noBetCount: records.filter((r) => r.decision === "NO_BET").length,
    needsValidationCount: records.filter((r) => r.decision === "NEEDS_VALIDATION").length,
    avgConfidence: mean(records.map((r) => r.benchmarkConfidence)),
  };
}

/** Gruppera och räkna stats efter valfri nyckelfunktion (pure). */
export function analyzeByCell(
  records: MergedClvRecord[],
  keyFn: (r: MergedClvRecord) => string,
): Record<string, CellStats> {
  const groups = new Map<string, MergedClvRecord[]>();
  for (const r of records) {
    const k = keyFn(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  const out: Record<string, CellStats> = {};
  for (const [k, recs] of groups) out[k] = computeCellStats(k, recs);
  return out;
}

// ── Färdiga nyckelfunktioner ───────────────────────────────────────────
export const keyByBenchmarkSource = (r: MergedClvRecord): string => r.benchmarkSource;
export const keyBySport = (r: MergedClvRecord): string => r.sport;
export const keyByMarketType = (r: MergedClvRecord): string => r.marketType;
export const keyByLeague = (r: MergedClvRecord): string => r.league ?? "(okänd liga)";
export const keyByTts = (r: MergedClvRecord): string => r.ttsBucket;
export const keyByScenario = (r: MergedClvRecord): string => r.scenario;
/** Full cell: sport|market|league|tts|scenario. */
export const keyByFullCell = (r: MergedClvRecord): string =>
  `${r.sport}|${r.marketType}|${r.league ?? "?"}|${r.ttsBucket}|${r.scenario}`;

/**
 * Per-källa-attribuering: varje record exploderas till en delpost per
 * bidragande källa (sourceSnapshot), så att en KÄLLA får statistik för de
 * beslut den deltog i — inte bara den som satte fair price. Detta är det
 * mest relevanta för trust-feedback per källa.
 *
 * Nyckel = `${sourceId}|${sport}|${marketType}`.
 */
export function analyzePerSource(records: MergedClvRecord[]): Record<string, CellStats> {
  const exploded: { key: string; rec: MergedClvRecord }[] = [];
  for (const r of records) {
    for (const s of r.sourceSnapshot) {
      exploded.push({ key: `${s.sourceId}|${r.sport}|${r.marketType}`, rec: r });
    }
  }
  const groups = new Map<string, MergedClvRecord[]>();
  for (const e of exploded) {
    const arr = groups.get(e.key);
    if (arr) arr.push(e.rec);
    else groups.set(e.key, [e.rec]);
  }
  const out: Record<string, CellStats> = {};
  for (const [k, recs] of groups) out[k] = computeCellStats(k, recs);
  return out;
}

/** Bekväm sammanställning över alla standard-dimensioner. */
export interface ClvReport {
  generatedAt: string;
  /** Råa open-decisions (före dedupe). */
  rawDecisions: number;
  /** Analyserade samples (efter dedupe om aktiv). */
  totalDecisions: number;
  settledDecisions: number;
  /** True om dedupe kördes. */
  deduped: boolean;
  bySource: Record<string, CellStats>;
  bySport: Record<string, CellStats>;
  byMarketType: Record<string, CellStats>;
  byLeague: Record<string, CellStats>;
  byTts: Record<string, CellStats>;
  byScenario: Record<string, CellStats>;
  byFullCell: Record<string, CellStats>;
  perSource: Record<string, CellStats>;
}

export interface ClvReportOptions {
  /** Kollapsa near-dubbletter till en sample per bet-tillfälle. Default true. */
  dedupe?: boolean;
  /** Inkludera scenario i dedupe-nyckeln. Default false. */
  byScenario?: boolean;
}

/**
 * Bygg CLV-rapport. Default DEDUPAR (en sample per bet-tillfälle) så
 * trustFeedback inte ser icke-oberoende dubbletter. dedupe:false ger rå analys.
 */
export function buildClvReport(records: MergedClvRecord[], opts: ClvReportOptions = {}): ClvReport {
  const dedupe = opts.dedupe !== false;
  const recs = dedupe ? dedupeForAnalysis(records, { byScenario: opts.byScenario }).kept : records;
  return {
    generatedAt: new Date().toISOString(),
    rawDecisions: records.length,
    totalDecisions: recs.length,
    settledDecisions: recs.filter((r) => r.settled).length,
    deduped: dedupe,
    bySource: analyzeByCell(recs, keyByBenchmarkSource),
    bySport: analyzeByCell(recs, keyBySport),
    byMarketType: analyzeByCell(recs, keyByMarketType),
    byLeague: analyzeByCell(recs, keyByLeague),
    byTts: analyzeByCell(recs, keyByTts),
    byScenario: analyzeByCell(recs, keyByScenario),
    byFullCell: analyzeByCell(recs, keyByFullCell),
    perSource: analyzePerSource(recs),
  };
}
