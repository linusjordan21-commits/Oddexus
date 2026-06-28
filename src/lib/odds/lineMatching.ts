/**
 * lineMatching.ts — matchar en KÄLLAS prislinjer mot en TARGET-lina för
 * totals (Over/Under) och Asian Handicap. Konservativt: hellre reject än
 * felaktig interpolation.
 *
 * Prioritering:
 *   1. EXACT          — källan har exakt target-linan → använd den, ingen interpolation.
 *   2. QUARTER_SPLIT  — target är kvartslina (x.25/x.75) → halva på varje
 *                       angränsande halv-/heltalslina (2.25 = ½·2.0 + ½·2.5).
 *                       Endast om BÅDA komponenterna finns exakt. Exakt matte → hög conf.
 *   3. INTERPOLATED   — target saknas men källan har närliggande linor som
 *                       OMGÄRDAR target tätt (≤0.5 på var sida, gap ≤1.0).
 *                       Logit-interpolation. Lägre conf.
 *   4. REJECTED       — för stort gap, saknar bracket, icke-monoton stege,
 *                       eller marknadstyp/scope skiljer sig → källan ignoreras.
 *
 * Får ALDRIG jämföra olika marknader som samma: Over 2.25 ≠ Over 2.5,
 * AH -0.25 ≠ AH -0.5, match total ≠ team total. Player props hanteras
 * separat i propEngine.ts (denna modul är bara totals/AH).
 *
 * Stegen lagrar canonical-sidans no-vig-prob per lina:
 *   - TOTAL / ASIAN_TOTAL → canonical = OVER
 *   - AH / SPREAD         → canonical = HOME
 */

import type { Selection } from "./types.ts";

export type LineMarketType = "TOTAL" | "ASIAN_TOTAL" | "AH" | "SPREAD";

export type LineMatchType = "exact" | "quarter_split" | "interpolated" | "rejected";

export type LineReasonCode =
  | "LINE_EXACT"
  | "LINE_QUARTER_SPLIT"
  | "LINE_INTERPOLATED"
  | "LINE_REJECTED_GAP_TOO_LARGE"
  | "LINE_REJECTED_NO_BRACKET"
  | "LINE_REJECTED_NON_MONOTONIC"
  | "LINE_REJECTED_QUARTER_COMPONENTS_MISSING"
  | "LINE_REJECTED_EMPTY_LADDER"
  | "MARKET_TYPE_MISMATCH";

/** En prispunkt i källans stege. prob = canonical-sidans no-vig-prob. */
export interface LinePoint {
  line: number;
  prob: number; // OVER (totals) eller HOME (AH), no-vig
}

/** Källans stege för EN marknad. marketType + scope måste matcha target. */
export interface SourceLadder {
  sourceId: string;
  marketType: LineMarketType;
  /** "match_total" | "team_total" | "full" osv. Match-total ≠ team-total. */
  scope: string;
  points: LinePoint[];
}

export interface LineMatchTarget {
  marketType: LineMarketType;
  scope: string;
  line: number;
  selection: Selection;
}

export interface InterpolationDetails {
  lowerLine?: number;
  lowerProb?: number;
  upperLine?: number;
  upperProb?: number;
  gap?: number;
  /** För quarter_split: de två komponentlinorna. */
  componentLines?: number[];
  componentProbs?: number[];
  method?: "logit" | "average";
}

export interface LineMatchResult {
  lineMatchType: LineMatchType;
  lineMatchConfidence: number; // 0..1
  /** Den/de källinor som användes. */
  sourceLineUsed: number | number[] | null;
  targetLine: number;
  /** No-vig-prob för REQUESTED selection vid target (null om rejected). */
  fairProb: number | null;
  /** True om källan får bidra i consensus. */
  comparable: boolean;
  interpolationDetails: InterpolationDetails | null;
  reasonCodes: LineReasonCode[];
}

// ── Konfiguration (konservativa startvärden) ───────────────────────────
const EPS = 1e-6;
const MAX_BRACKET_DISTANCE = 0.5; // varje bracket-lina måste ligga ≤0.5 från target
const MAX_INTERP_GAP = 1.0; // bracket-spannet får vara ≤1.0
const MONO_TOL = 0.015; // tillåten lokal inversion i stegen innan non-monotonic
const EXACT_CONFIDENCE = 1.0;
const QUARTER_SPLIT_CONFIDENCE = 0.9;
const INTERP_CONF_MAX = 0.75;
const INTERP_CONF_MIN = 0.45;

// ── Linje-typ-hjälpare ─────────────────────────────────────────────────
function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
/** Halv- eller heltalslina (x.0 eller x.5). */
function isHalfOrInteger(line: number): boolean {
  return Math.abs(2 * line - Math.round(2 * line)) < EPS;
}
/** Kvartslina (x.25 eller x.75). */
function isQuarter(line: number): boolean {
  const onQuarterGrid = Math.abs(4 * line - Math.round(4 * line)) < EPS;
  return onQuarterGrid && !isHalfOrInteger(line);
}

/** Är denna selection canonical-sidan för marknaden? */
function isCanonicalSide(marketType: LineMarketType, selection: Selection): boolean {
  if (marketType === "TOTAL" || marketType === "ASIAN_TOTAL") return selection === "OVER";
  return selection === "HOME"; // AH / SPREAD
}

function findExact(points: LinePoint[], line: number): LinePoint | undefined {
  return points.find((p) => approxEq(p.line, line));
}

/** Kontrollera att stegen är (svagt) monoton i prob vs line. */
function isMonotonic(points: LinePoint[]): boolean {
  if (points.length < 3) return true;
  const sorted = [...points].sort((a, b) => a.line - b.line);
  const overall = sorted[sorted.length - 1].prob - sorted[0].prob;
  const dir = Math.sign(overall) || 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const d = sorted[i + 1].prob - sorted[i].prob;
    if (d * dir < -MONO_TOL) return false; // inversion mot huvudriktningen
  }
  return true;
}

function logit(p: number): number {
  const c = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(c / (1 - c));
}
function invLogit(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Resultat-helper: flippa canonical-prob till requested selection. */
function toSelectionProb(marketType: LineMarketType, selection: Selection, canonicalProb: number): number {
  return isCanonicalSide(marketType, selection) ? canonicalProb : 1 - canonicalProb;
}

function rejected(target: number, reasons: LineReasonCode[]): LineMatchResult {
  return {
    lineMatchType: "rejected",
    lineMatchConfidence: 0,
    sourceLineUsed: null,
    targetLine: target,
    fairProb: null,
    comparable: false,
    interpolationDetails: null,
    reasonCodes: reasons,
  };
}

/**
 * Matcha en target-lina mot en källas stege. Returnerar fairProb för
 * target.selection samt match-metadata.
 */
export function matchLine(target: LineMatchTarget, ladder: SourceLadder): LineMatchResult {
  // 0) Marknadstyp + scope MÅSTE matcha — annars är det olika marknader.
  if (ladder.marketType !== target.marketType || ladder.scope !== target.scope) {
    return rejected(target.line, ["MARKET_TYPE_MISMATCH"]);
  }
  if (ladder.points.length === 0) {
    return rejected(target.line, ["LINE_REJECTED_EMPTY_LADDER"]);
  }
  if (!isMonotonic(ladder.points)) {
    return rejected(target.line, ["LINE_REJECTED_NON_MONOTONIC"]);
  }

  const tline = target.line;

  // 1) EXACT — högsta prioritet, ingen interpolation.
  const exact = findExact(ladder.points, tline);
  if (exact) {
    return {
      lineMatchType: "exact",
      lineMatchConfidence: EXACT_CONFIDENCE,
      sourceLineUsed: exact.line,
      targetLine: tline,
      fairProb: toSelectionProb(target.marketType, target.selection, exact.prob),
      comparable: true,
      interpolationDetails: null,
      reasonCodes: ["LINE_EXACT"],
    };
  }

  // 2) QUARTER_SPLIT — target är kvartslina, kräver BÅDA komponenterna exakt.
  if (isQuarter(tline)) {
    const lo = tline - 0.25;
    const hi = tline + 0.25;
    const pLo = findExact(ladder.points, lo);
    const pHi = findExact(ladder.points, hi);
    if (pLo && pHi) {
      const canonical = 0.5 * pLo.prob + 0.5 * pHi.prob;
      return {
        lineMatchType: "quarter_split",
        lineMatchConfidence: QUARTER_SPLIT_CONFIDENCE,
        sourceLineUsed: [lo, hi],
        targetLine: tline,
        fairProb: toSelectionProb(target.marketType, target.selection, canonical),
        comparable: true,
        interpolationDetails: { componentLines: [lo, hi], componentProbs: [pLo.prob, pHi.prob], method: "average" },
        reasonCodes: ["LINE_QUARTER_SPLIT"],
      };
    }
    // Kvartslina utan båda komponenterna → reject (ej interpolera kvartslinor).
    return rejected(tline, ["LINE_REJECTED_QUARTER_COMPONENTS_MISSING"]);
  }

  // 3) INTERPOLATED — endast halv-/heltalslinor med täta bracketing-linor.
  const lower = ladder.points
    .filter((p) => p.line < tline - EPS)
    .sort((a, b) => b.line - a.line)[0];
  const upper = ladder.points
    .filter((p) => p.line > tline + EPS)
    .sort((a, b) => a.line - b.line)[0];

  if (!lower || !upper) {
    return rejected(tline, ["LINE_REJECTED_NO_BRACKET"]);
  }

  const gap = upper.line - lower.line;
  const lowerDist = tline - lower.line;
  const upperDist = upper.line - tline;
  if (gap > MAX_INTERP_GAP + EPS || lowerDist > MAX_BRACKET_DISTANCE + EPS || upperDist > MAX_BRACKET_DISTANCE + EPS) {
    return rejected(tline, ["LINE_REJECTED_GAP_TOO_LARGE"]);
  }

  // Logit-interpolation av canonical-prob.
  const w = (tline - lower.line) / gap;
  const canonical = invLogit(logit(lower.prob) + w * (logit(upper.prob) - logit(lower.prob)));

  // Confidence sjunker med gap: tätt bracket → nära MAX, brett → mot MIN.
  const conf = INTERP_CONF_MAX - (INTERP_CONF_MAX - INTERP_CONF_MIN) * (gap / MAX_INTERP_GAP);

  return {
    lineMatchType: "interpolated",
    lineMatchConfidence: Math.max(INTERP_CONF_MIN, Math.min(INTERP_CONF_MAX, conf)),
    sourceLineUsed: [lower.line, upper.line],
    targetLine: tline,
    fairProb: toSelectionProb(target.marketType, target.selection, canonical),
    comparable: true,
    interpolationDetails: {
      lowerLine: lower.line, lowerProb: lower.prob,
      upperLine: upper.line, upperProb: upper.prob,
      gap, method: "logit",
    },
    reasonCodes: ["LINE_INTERPOLATED"],
  };
}

/**
 * Bekvämlighet: bygg en SourceQuote-kompatibel post (fairProb + flaggor)
 * direkt från en stege + target. consensus.ts respekterar lineComparable
 * och lineMatchConfidence.
 */
export function lineMatchedQuote(
  target: LineMatchTarget,
  ladder: SourceLadder,
  extra?: { isExchange?: boolean; liquidityFactor?: number },
): {
  sourceId: string;
  fairProb: number;
  isExchange?: boolean;
  liquidityFactor?: number;
  lineComparable: boolean;
  lineMatchConfidence: number;
  lineMatch: LineMatchResult;
} {
  const m = matchLine(target, ladder);
  return {
    sourceId: ladder.sourceId,
    fairProb: m.fairProb ?? 0,
    isExchange: extra?.isExchange,
    liquidityFactor: extra?.liquidityFactor,
    lineComparable: m.comparable,
    lineMatchConfidence: m.lineMatchConfidence,
    lineMatch: m,
  };
}
