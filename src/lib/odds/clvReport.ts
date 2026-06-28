/**
 * clvReport.ts — omfattande, DEDUPAD CLV-rapport (shadow-only, ren analys).
 *
 * All breakdown körs på dedupade samples (en per bet-tillfälle) så att
 * NO_BET-majoriteten inte blåser upp counts eller döljer AUTO_BET-subsetet.
 * Råloggen rörs aldrig. Påverkar inga live-beslut.
 *
 * Syftet: kunna LÄSA datan rätt medan den samlas — särskilt:
 *   - separera AUTO_BET / MANUAL_REVIEW / NO_BET / NEEDS_VALIDATION
 *   - se om value-flaggade (AUTO_BET/MANUAL_REVIEW) har BÄTTRE CLV än NO_BET
 *   - se om högre edge / högre confidence ger bättre CLV
 * Baslinjen mot Pinnacle no-vig är NEGATIV för soft books — det är väntat.
 */

import type { MergedClvRecord } from "./clvLogger.ts";
import { dedupeForAnalysis } from "./clvDedupe.ts";
import { bookmakerGroup } from "./bookmakerGroups.ts";
import {
  analyzeByCell,
  analyzePerSource,
  computeCellStats,
  keyByBenchmarkSource,
  keyByLeague,
  keyByMarketType,
  keyByScenario,
  keyBySport,
  type CellStats,
} from "./clvAnalysis.ts";

/** Under detta antal settled samples = preliminärt → visa varning. */
export const MIN_REPORT_SAMPLE_WARN = 30;

// ── Buckets ────────────────────────────────────────────────────────────
export const EDGE_BUCKETS = ["<0%", "0–1%", "1–2%", "2–3%", "3–5%", "5%+"] as const;
export function edgeBucket(edgePct: number | null): string {
  if (edgePct == null || !Number.isFinite(edgePct)) return "(okänd)";
  if (edgePct < 0) return "<0%";
  if (edgePct < 1) return "0–1%";
  if (edgePct < 2) return "1–2%";
  if (edgePct < 3) return "2–3%";
  if (edgePct < 5) return "3–5%";
  return "5%+";
}

export const CONFIDENCE_BUCKETS = ["<0.50", "0.50–0.65", "0.65–0.80", "0.80+"] as const;
export function confidenceBucket(conf: number | null): string {
  if (conf == null || !Number.isFinite(conf)) return "(okänd)";
  if (conf < 0.5) return "<0.50";
  if (conf < 0.65) return "0.50–0.65";
  if (conf < 0.8) return "0.65–0.80";
  return "0.80+";
}

// ── Keyers ─────────────────────────────────────────────────────────────
export const keyByDecision = (r: MergedClvRecord): string => r.decision;
/** Plattforms-grupp (systerbrands = en), inte enskild bok. */
export const keyByBookGroup = (r: MergedClvRecord): string => bookmakerGroup(r.candidateBook);
export const keyByEdgeBucket = (r: MergedClvRecord): string => edgeBucket(r.calculatedEdge);
export const keyByConfidenceBucket = (r: MergedClvRecord): string => confidenceBucket(r.benchmarkConfidence);

/** reasonCodes är en lista → explodera per kod. */
export function analyzeByReasonCode(records: MergedClvRecord[]): Record<string, CellStats> {
  const groups = new Map<string, MergedClvRecord[]>();
  for (const r of records) {
    for (const code of r.reasonCodes) {
      const arr = groups.get(code);
      if (arr) arr.push(r);
      else groups.set(code, [r]);
    }
  }
  const out: Record<string, CellStats> = {};
  for (const [k, recs] of groups) out[k] = computeCellStats(k, recs);
  return out;
}

const VALUE_FLAGGED = new Set(["AUTO_BET", "MANUAL_REVIEW"]);

export interface ValueFlaggedSection {
  samples: number;
  settled: number;
  byDecision: Record<string, CellStats>;
  byEdgeBucket: Record<string, CellStats>;
  byConfidenceBucket: Record<string, CellStats>;
}

export interface FullClvReport {
  generatedAt: string;
  deduped: boolean;
  rawRows: number;
  dedupedSamples: number;
  settledSamples: number;
  unsettledSamples: number;
  /** True om för få settled för säkra slutsatser (visa preliminärt + varning). */
  preliminary: boolean;
  overall: CellStats;
  byDecision: Record<string, CellStats>;
  byScenario: Record<string, CellStats>;
  bySource: Record<string, CellStats>;
  byBookGroup: Record<string, CellStats>;
  bySport: Record<string, CellStats>;
  byLeague: Record<string, CellStats>;
  byMarketType: Record<string, CellStats>;
  byEdgeBucket: Record<string, CellStats>;
  byConfidenceBucket: Record<string, CellStats>;
  byReasonCode: Record<string, CellStats>;
  /** Per-källa-attribuering (exploderad per bidragande källa). */
  perSource: Record<string, CellStats>;
  /** Endast value-flaggade (AUTO_BET + MANUAL_REVIEW) — signalen. */
  valueFlagged: ValueFlaggedSection;
}

export interface ClvReportOptions {
  /** Dedupa (default true). false = rå analys (endast för jämförelse/test). */
  dedupe?: boolean;
  byScenario?: boolean;
}

/** Bygg den omfattande rapporten. DEDUPAR default — överallt. */
export function buildFullClvReport(records: MergedClvRecord[], opts: ClvReportOptions = {}): FullClvReport {
  const deduped = opts.dedupe !== false;
  const recs = deduped ? dedupeForAnalysis(records, { byScenario: opts.byScenario }).kept : records;
  const settled = recs.filter((r) => r.settled).length;
  const valueRecs = recs.filter((r) => VALUE_FLAGGED.has(r.decision));

  return {
    generatedAt: new Date().toISOString(),
    deduped,
    rawRows: records.length,
    dedupedSamples: recs.length,
    settledSamples: settled,
    unsettledSamples: recs.length - settled,
    preliminary: settled < MIN_REPORT_SAMPLE_WARN,
    overall: computeCellStats("ALLA", recs),
    byDecision: analyzeByCell(recs, keyByDecision),
    byScenario: analyzeByCell(recs, keyByScenario),
    bySource: analyzeByCell(recs, keyByBenchmarkSource),
    byBookGroup: analyzeByCell(recs, keyByBookGroup),
    bySport: analyzeByCell(recs, keyBySport),
    byLeague: analyzeByCell(recs, keyByLeague),
    byMarketType: analyzeByCell(recs, keyByMarketType),
    byEdgeBucket: analyzeByCell(recs, keyByEdgeBucket),
    byConfidenceBucket: analyzeByCell(recs, keyByConfidenceBucket),
    byReasonCode: analyzeByReasonCode(recs),
    perSource: analyzePerSource(recs),
    valueFlagged: {
      samples: valueRecs.length,
      settled: valueRecs.filter((r) => r.settled).length,
      byDecision: analyzeByCell(valueRecs, keyByDecision),
      byEdgeBucket: analyzeByCell(valueRecs, keyByEdgeBucket),
      byConfidenceBucket: analyzeByCell(valueRecs, keyByConfidenceBucket),
    },
  };
}

// ── Textformatering (för CLI) ──────────────────────────────────────────
function fmt(x: number | null): string {
  return x == null ? "—" : x.toFixed(2);
}
function pct(x: number | null): string {
  return x == null ? "—" : (x * 100).toFixed(0) + "%";
}

function formatCellTable(title: string, cells: Record<string, CellStats>, order?: readonly string[]): string[] {
  const lines = [`  ${title}:`];
  const keys = order ? order.filter((k) => cells[k]) : Object.keys(cells);
  // Lägg till ev. nycklar utanför ordningslistan.
  if (order) for (const k of Object.keys(cells)) if (!keys.includes(k)) keys.push(k);
  if (keys.length === 0) { lines.push("    (inga)"); return lines; }
  for (const k of keys) {
    const s = cells[k];
    const warn = s.settledSamples > 0 && s.settledSamples < MIN_REPORT_SAMPLE_WARN ? " ⚠prelim" : "";
    lines.push(
      `    ${k.padEnd(18)} n=${String(s.samples).padStart(5)} settled=${String(s.settledSamples).padStart(4)} ` +
      `avgCLV=${fmt(s.avgClvPct).padStart(7)} med=${fmt(s.medianClvPct).padStart(7)} ` +
      `hit=${pct(s.hitRate).padStart(4)} fp=${pct(s.falsePositiveRate).padStart(4)}${warn}`,
    );
  }
  return lines;
}

/** Rendera en läsbar textrapport. */
export function formatReport(r: FullClvReport): string {
  const out: string[] = [];
  out.push("════════════════════ CLV-RAPPORT (dedupad) ════════════════════");
  out.push(`genererad: ${r.generatedAt}`);
  out.push(`raw rows: ${r.rawRows} → deduped samples: ${r.dedupedSamples} · settled: ${r.settledSamples} · unsettled: ${r.unsettledSamples}`);
  if (r.preliminary) out.push(`⚠ PRELIMINÄRT: endast ${r.settledSamples} settled (< ${MIN_REPORT_SAMPLE_WARN}) — tolka försiktigt.`);
  out.push("");
  out.push("BASLINJE-NOT: avgCLV mot Pinnacle no-vig är NEGATIV för soft books (vig) — väntat.");
  out.push("Det intressanta: har value-flaggade (AUTO_BET/MANUAL_REVIEW) BÄTTRE CLV än NO_BET,");
  out.push("och ger högre edge/confidence bättre CLV?");
  out.push("");
  out.push(...formatCellTable("per DECISION", r.byDecision, ["AUTO_BET", "MANUAL_REVIEW", "NO_BET", "NEEDS_VALIDATION"]));
  out.push("");
  out.push("── VALUE-FLAGGADE (AUTO_BET + MANUAL_REVIEW) — signalen ──");
  out.push(`  samples=${r.valueFlagged.samples} settled=${r.valueFlagged.settled}`);
  out.push(...formatCellTable("value per EDGE-bucket", r.valueFlagged.byEdgeBucket, EDGE_BUCKETS));
  out.push(...formatCellTable("value per CONFIDENCE-bucket", r.valueFlagged.byConfidenceBucket, CONFIDENCE_BUCKETS));
  out.push("");
  out.push(...formatCellTable("per SCENARIO", r.byScenario));
  out.push(...formatCellTable("per SOURCE (benchmark)", r.bySource));
  out.push(...formatCellTable("per SOURCE (attribuerad)", r.perSource));
  out.push(...formatCellTable("per BOOK-GROUP (plattform, systerbrands=1)", r.byBookGroup));
  out.push(...formatCellTable("per SPORT", r.bySport));
  out.push(...formatCellTable("per MARKET-TYPE", r.byMarketType));
  out.push(...formatCellTable("per EDGE-bucket (alla)", r.byEdgeBucket, EDGE_BUCKETS));
  out.push(...formatCellTable("per CONFIDENCE-bucket (alla)", r.byConfidenceBucket, CONFIDENCE_BUCKETS));
  out.push(...formatCellTable("per REASON-CODE", r.byReasonCode));
  out.push(...formatCellTable("per LEAGUE", r.byLeague));
  out.push("════════════════════════════════════════════════════════════════");
  return out.join("\n");
}
