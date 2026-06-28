/**
 * propEngine.ts — SEPARAT logik för player props & gold boosts. Detta är
 * INTE consensus.ts: props körs aldrig genom sharp-consensus-matrisen och
 * når aldrig AUTO_BET i v1.
 *
 * Exempel: "Alexander Isak över 0.5 skott" boostad till 2.25 på Unibet/
 * Bet365 medan andra books ligger ~1.45 och Pinnacle saknar marknaden.
 * → klassas SOFT_CONSENSUS_PROP, boost → NEEDS_VALIDATION, aldrig auto.
 *
 * Regler:
 *   - Sharp source med EXAKT samma prop får vara benchmark.
 *   - Annars soft consensus från ≥5 soft books, exakt regelmatch.
 *   - median/trimmed median (ej average), outliers bort.
 *   - devig over/under om båda sidor finns.
 *   - related sharp markets (AH/team total) får BARA justera confidence.
 *   - oklara regler → MANUAL_REVIEW eller NO_BET.
 */

import type { Decision, ReasonCode, Scenario } from "./consensusTypes.ts";
import { devigTwoWay } from "./consensus.ts";

/**
 * Regel-tuple. Två props är "samma marknad" bara om ALLA fält matchar.
 * shots ≠ shots_on_target; 90 min ≠ inkl. övertid; bet builder-leg ≠ singel.
 */
export interface PropRule {
  statType: "shots" | "shots_on_target" | "goals" | "assists" | "tackles" | "passes" | "points" | "rebounds" | "threes";
  line: number; // 0.5, 1.5, ...
  side: "OVER" | "UNDER";
  starterRequired: boolean; // void om spelaren inte startar?
  includesOT: boolean; // räknas övertid/förlängning?
  voidIfNotStart: boolean;
  periodScope: "full" | "1H" | "2H";
  betBuilder: boolean; // del av bet builder/combo → annan marknad
}

export interface PropQuote {
  bookmaker: string;
  odds: number;
  /** Motsatt sida (för devig) om boken erbjuder båda. */
  oppositeOdds?: number;
  rule: PropRule;
}

export interface SharpPropQuote {
  sourceId: string; // "pinnacle" om den undantagsvis har proppen
  odds: number;
  oppositeOdds?: number;
  rule: PropRule;
}

export interface PropEvaluateInput {
  candidate: { bookmaker: string; odds: number; rule: PropRule; isBoosted: boolean };
  /** Soft books med (förhoppningsvis) samma marknad. */
  softBooks: PropQuote[];
  /** Sharp source med EXAKT samma prop, om någon (sällsynt). */
  sharpProp?: SharpPropQuote;
  /** Related sharp markets — får BARA justera confidence ±, ej sätta fair. */
  relatedSharpConfidenceAdj?: number; // t.ex. -0.05..+0.05
  shadowMode?: boolean;
}

export interface PropDecisionLog {
  ts: string;
  scenario: Scenario;
  candidateBook: string;
  candidateOdds: number;
  isBoosted: boolean;
  rule: PropRule;
  benchmarkSource: string;
  fairProb: number | null;
  fairPrice: number | null;
  booksUsed: string[];
  outliersRemoved: string[];
  calculatedEdge: number | null;
  requiredEdge: number;
  benchmarkConfidence: number;
  decision: Decision;
  executed: boolean;
  shadowMode: boolean;
  reasonCodes: ReasonCode[];
}

const MIN_SOFT_BOOKS = 5;
const MIN_EDGE_PROP_PCT = 6.0; // högre än main markets
const BASE_PROP_CONFIDENCE = 0.35;

function rulesEqual(a: PropRule, b: PropRule): boolean {
  return (
    a.statType === b.statType &&
    a.line === b.line &&
    a.side === b.side &&
    a.starterRequired === b.starterRequired &&
    a.includesOT === b.includesOT &&
    a.voidIfNotStart === b.voidIfNotStart &&
    a.periodScope === b.periodScope &&
    a.betBuilder === b.betBuilder
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** IQR-baserad outlier-gallring. Returnerar {kept, removedIdx}. */
function removeOutliers(probs: number[]): { keptIdx: number[]; removedIdx: number[] } {
  if (probs.length < 4) return { keptIdx: probs.map((_, i) => i), removedIdx: [] };
  const sorted = [...probs].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const keptIdx: number[] = [];
  const removedIdx: number[] = [];
  probs.forEach((p, i) => (p >= lo && p <= hi ? keptIdx : removedIdx).push(i));
  return { keptIdx, removedIdx };
}

/** Devigga en quote: om båda sidor finns, no-vig; annars rå implied prob. */
function quoteFairProb(odds: number, oppositeOdds?: number): number {
  return oppositeOdds && oppositeOdds > 1 ? devigTwoWay(odds, oppositeOdds) : 1 / odds;
}

export function evaluateProp(input: PropEvaluateInput): PropDecisionLog {
  const shadowMode = input.shadowMode !== false;
  const reasonCodes: ReasonCode[] = [];
  const { candidate } = input;

  const base = (decision: Decision, fairProb: number | null, scenario: Scenario, benchmarkSource: string, booksUsed: string[], outliers: string[], conf: number): PropDecisionLog => {
    const edge = fairProb != null ? (candidate.odds * fairProb - 1) * 100 : null;
    return {
      ts: new Date().toISOString(),
      scenario,
      candidateBook: candidate.bookmaker,
      candidateOdds: candidate.odds,
      isBoosted: candidate.isBoosted,
      rule: candidate.rule,
      benchmarkSource,
      fairProb,
      fairPrice: fairProb && fairProb > 0 ? 1 / fairProb : null,
      booksUsed,
      outliersRemoved: outliers,
      calculatedEdge: edge,
      requiredEdge: MIN_EDGE_PROP_PCT,
      benchmarkConfidence: conf,
      decision,
      executed: false, // props exekveras ALDRIG automatiskt i v1
      shadowMode,
      reasonCodes,
    };
  };

  // 1) Sharp source med EXAKT samma prop → använd den som benchmark.
  if (input.sharpProp && rulesEqual(input.sharpProp.rule, candidate.rule)) {
    const fairProb = quoteFairProb(input.sharpProp.odds, input.sharpProp.oppositeOdds);
    const edge = (candidate.odds * fairProb - 1) * 100;
    reasonCodes.push("PROP_SOFT_CONSENSUS"); // (sharp men ändå prop → aldrig auto)
    const conf = 0.6 + (input.relatedSharpConfidenceAdj ?? 0);
    if (candidate.isBoosted) { reasonCodes.push("PROP_BOOSTED_NEEDS_VALIDATION"); return base("NEEDS_VALIDATION", fairProb, "SOFT_CONSENSUS_PROP", input.sharpProp.sourceId, [input.sharpProp.sourceId], [], conf); }
    if (edge < MIN_EDGE_PROP_PCT) { reasonCodes.push("BELOW_REQUIRED_EDGE"); return base("NO_BET", fairProb, "SOFT_CONSENSUS_PROP", input.sharpProp.sourceId, [input.sharpProp.sourceId], [], conf); }
    return base("MANUAL_REVIEW", fairProb, "SOFT_CONSENSUS_PROP", input.sharpProp.sourceId, [input.sharpProp.sourceId], [], conf);
  }

  // 2) Soft consensus. Kräver EXAKT regelmatch mot candidate.
  const exactMatch = input.softBooks.filter((b) => rulesEqual(b.rule, candidate.rule));
  const mismatched = input.softBooks.length - exactMatch.length;
  if (mismatched > 0 && exactMatch.length < input.softBooks.length) {
    // Vissa böcker hade annan regel-tuple → flagga men fortsätt på de matchande.
    reasonCodes.push("PROP_RULE_MISMATCH");
  }
  if (exactMatch.length < MIN_SOFT_BOOKS) {
    reasonCodes.push("PROP_INSUFFICIENT_BOOKS");
    return base("NO_BET", null, "SOFT_CONSENSUS_PROP", "soft_consensus", exactMatch.map((b) => b.bookmaker), [], BASE_PROP_CONFIDENCE);
  }

  // 3) Devig + outlier-gallring + median.
  const probs = exactMatch.map((b) => quoteFairProb(b.odds, b.oppositeOdds));
  const { keptIdx, removedIdx } = removeOutliers(probs);
  const keptProbs = keptIdx.map((i) => probs[i]);
  const fairProb = median(keptProbs);
  const booksUsed = keptIdx.map((i) => exactMatch[i].bookmaker);
  const outliers = removedIdx.map((i) => exactMatch[i].bookmaker);

  // Confidence: fler böcker + tät spridning → högre. Related sharp justerar ±.
  let conf = BASE_PROP_CONFIDENCE + Math.min(0.2, (keptProbs.length - MIN_SOFT_BOOKS) * 0.03);
  conf += input.relatedSharpConfidenceAdj ?? 0;
  conf = Math.max(0, Math.min(0.7, conf)); // props takas lågt

  reasonCodes.push("PROP_SOFT_CONSENSUS");
  const edge = (candidate.odds * fairProb - 1) * 100;

  // 4) Beslut — boost → NEEDS_VALIDATION; annars aldrig mer än MANUAL_REVIEW.
  if (candidate.isBoosted) {
    reasonCodes.push("PROP_BOOSTED_NEEDS_VALIDATION");
    return base("NEEDS_VALIDATION", fairProb, "SOFT_CONSENSUS_PROP", "soft_consensus", booksUsed, outliers, conf);
  }
  if (edge < MIN_EDGE_PROP_PCT) {
    reasonCodes.push("BELOW_REQUIRED_EDGE");
    return base("NO_BET", fairProb, "SOFT_CONSENSUS_PROP", "soft_consensus", booksUsed, outliers, conf);
  }
  reasonCodes.push("ABOVE_REQUIRED_EDGE");
  return base("MANUAL_REVIEW", fairProb, "SOFT_CONSENSUS_PROP", "soft_consensus", booksUsed, outliers, conf);
}
