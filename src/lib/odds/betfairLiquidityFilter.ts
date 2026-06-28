/**
 * betfair_liquidity_filter — Betfair får bara hög trust om likviditeten
 * är tillräcklig. Vi använder INTE bästa back-odds blint; vi räknar en
 * weighted midpoint (fair) ur back/lay och bedömer:
 *   - matched volume (omsatt belopp på marknaden)
 *   - back/lay-spread (tight = sharp)
 *   - order book depth (pengar tillgängliga på bästa nivåerna)
 *
 * Output: pass-flagga + liquidityFactor (0..1) som multipliceras in i
 * trust/vikt/confidence. 0 = underkänd → Betfair degraderas till weak/ignore.
 *
 * Trösklar är STARTVÄRDEN (per sport/tier) och kalibreras via CLV.
 */

import type { BenchSport } from "./consensusTypes.ts";

export interface BetfairOrderBook {
  /** Bästa back-odds (det du kan backa på). */
  backOdds: number;
  /** Bästa lay-odds (det du kan laya på). */
  layOdds: number;
  /** Tillgängligt belopp (valutaenhet) på bästa back. */
  backDepth: number;
  /** Tillgängligt belopp på bästa lay. */
  layDepth: number;
  /** Totalt matchat belopp på HELA marknaden (likviditetsmått). */
  matchedVolume: number;
}

export interface LiquidityThresholds {
  minMatchedVolume: number;
  maxSpreadPct: number; // (lay−back)/mid i %
  minSideDepth: number;
}

/** Default-trösklar per sport. Football T1 mest likvid → strängast nytta. */
const THRESHOLDS: Record<BenchSport, LiquidityThresholds> = {
  football: { minMatchedVolume: 10000, maxSpreadPct: 2.5, minSideDepth: 500 },
  tennis: { minMatchedVolume: 8000, maxSpreadPct: 3.0, minSideDepth: 400 },
  basketball: { minMatchedVolume: 6000, maxSpreadPct: 3.5, minSideDepth: 300 },
};

export interface LiquidityResult {
  pass: boolean;
  liquidityFactor: number; // 0..1
  /** Weighted midpoint som fair odds (depth-viktad mellan back och lay). */
  midpointOdds: number | null;
  /** No-vig-prob ur midpoint (för selection-sidan i boken). */
  midpointProb: number | null;
  spreadPct: number | null;
  reasons: string[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Bedöm Betfair-likviditet och returnera fair midpoint + liquidityFactor.
 * Midpoint-prob = depth-viktat medel av implied prob för back och lay
 * (börs ≈ ingen vig, så midpoint ≈ fair).
 */
export function evaluateBetfairLiquidity(
  book: BetfairOrderBook,
  sport: BenchSport,
): LiquidityResult {
  const reasons: string[] = [];
  const th = THRESHOLDS[sport];

  if (!(book.backOdds > 1) || !(book.layOdds > 1)) {
    return { pass: false, liquidityFactor: 0, midpointOdds: null, midpointProb: null, spreadPct: null, reasons: ["INVALID_ODDS"] };
  }

  const pBack = 1 / book.backOdds;
  const pLay = 1 / book.layOdds;
  const totalDepth = Math.max(1e-9, book.backDepth + book.layDepth);
  // Depth-viktad midpoint: tyngre sida drar fair priset mot sig.
  const midProb = (pBack * book.backDepth + pLay * book.layDepth) / totalDepth;
  const midpointOdds = midProb > 0 ? 1 / midProb : null;

  const mid = (book.backOdds + book.layOdds) / 2;
  const spreadPct = ((book.layOdds - book.backOdds) / mid) * 100;
  const minSideDepth = Math.min(book.backDepth, book.layDepth);

  let pass = true;
  if (book.matchedVolume < th.minMatchedVolume) { pass = false; reasons.push("LOW_MATCHED_VOLUME"); }
  if (spreadPct > th.maxSpreadPct) { pass = false; reasons.push("WIDE_SPREAD"); }
  if (minSideDepth < th.minSideDepth) { pass = false; reasons.push("THIN_DEPTH"); }

  if (!pass) {
    return { pass: false, liquidityFactor: 0, midpointOdds, midpointProb: midProb, spreadPct, reasons };
  }

  // liquidityFactor: graderad belöning över trösklarna (mer volym + tightare
  // spread + djupare bok → närmare 1.0). Aldrig under 0.5 när pass===true.
  const volScore = clamp(book.matchedVolume / (th.minMatchedVolume * 4), 0, 1);
  const spreadScore = clamp(1 - spreadPct / th.maxSpreadPct, 0, 1);
  const depthScore = clamp(minSideDepth / (th.minSideDepth * 4), 0, 1);
  const liquidityFactor = clamp(0.5 + 0.5 * (0.4 * volScore + 0.35 * spreadScore + 0.25 * depthScore), 0.5, 1);

  return { pass: true, liquidityFactor, midpointOdds, midpointProb: midProb, spreadPct, reasons: ["LIQUID_OK"] };
}
