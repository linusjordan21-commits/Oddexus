/**
 * confidence.ts — benchmark-confidence (0..1), oberoende-räkning,
 * spridning och roll-härledning. Detta är STEG 1b: "hur stark är
 * benchmarken" — helt skilt från value-beslutet.
 *
 * benchmarkConfidence = scenariobas
 *   + agreement-bonus (tät spridning mellan källor)
 *   + oberoende-bonus (fler oberoende röster)
 *   × tts-faktor × clv-multiplikator × liquidity-faktor (Betfair)
 * cap [0,1] (eller NON_ANCHOR_CONFIDENCE_CAP utan Pinnacle).
 */

import type { Scenario, SourceRole, TtsBucket } from "./consensusTypes.ts";
import { CORRELATION_GROUPS, getCorrelationGroup } from "./sourceTrustConfig.ts";
import {
  NON_ANCHOR_CONFIDENCE_CAP,
  SCENARIO_BASE_CONFIDENCE,
} from "./marketTypeConfig.ts";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Effektivt antal OBEROENDE källor efter korrelations-nedräkning.
 * k korrelerade källor i en grupp (rho) ≈ 1 + (k−1)(1−rho) röster.
 * Källor utanför alla grupper (pinnacle, betfair) räknas som 1 var.
 *
 * Ex: sbobet+ibc+singbet (rho 0.7) → 1 + 2·0.3 = 1.6, INTE 3.
 */
export function effectiveIndependentCount(sourceIds: string[]): number {
  let nEff = 0;
  const counted = new Set<string>();

  for (const group of CORRELATION_GROUPS) {
    const k = sourceIds.filter((s) => group.members.includes(s)).length;
    if (k > 0) {
      nEff += 1 + (k - 1) * (1 - group.rho);
      for (const s of sourceIds) if (group.members.includes(s)) counted.add(s);
    }
  }
  for (const s of sourceIds) {
    if (!counted.has(s) && getCorrelationGroup(s) === null) nEff += 1;
  }
  return nEff;
}

/** Population-stდev av en lista sannolikheter (spridning mellan källor). */
export function computeDispersion(probs: number[]): number {
  const xs = probs.filter((p) => Number.isFinite(p));
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Tts-faktor: närmare matchstart = sharpare linjer = högre confidence. */
export function ttsFactor(tts: TtsBucket): number {
  switch (tts) {
    case "<1h": return 1.05;
    case "1-6h": return 1.0;
    case "6-24h": return 0.95;
    case ">24h": return 0.9;
  }
}

/**
 * Härled roll ur effektiv trust. Pinnacle (när marknaden finns) är alltid
 * primary. Annars trösklar: ≥0.80 primary, ≥0.55 confirmation, ≥0.30 weak.
 */
export function deriveSourceRole(
  effectiveTrust: number,
  isPinnacle: boolean,
  marketExists: boolean,
): SourceRole {
  if (isPinnacle && marketExists) return "primary";
  if (effectiveTrust >= 0.8) return "primary";
  if (effectiveTrust >= 0.55) return "confirmation";
  if (effectiveTrust >= 0.3) return "weak";
  return "ignore";
}

export interface ConfidenceInput {
  scenario: Scenario;
  /** fairProb för selection per BIDRAGANDE källa (för spridning). */
  contributingProbs: number[];
  nEff: number;
  dispersionRef: number;
  tts: TtsBucket;
  /** CLV-multiplikator för den dominerande källan (default 1). */
  clvMultiplier: number;
  /** Betfair-likviditetsfaktor om Betfair bidrar (annars 1). */
  liquidityFactor: number;
  /** Aggregerad linjematch-faktor (1=exakt, lägre vid interpolation). */
  lineMatchFactor: number;
  isAnchor: boolean;
}

export interface ConfidenceOutput {
  confidence: number;
  dispersion: number;
  agreement: number;
}

/** Beräkna benchmark-confidence enligt formeln i SHARP-SOURCES-DESIGN.md §5.3. */
export function benchmarkConfidence(input: ConfidenceInput): ConfidenceOutput {
  const dispersion = computeDispersion(input.contributingProbs);
  const agreement = clamp(1 - dispersion / input.dispersionRef, 0, 1);

  let conf = SCENARIO_BASE_CONFIDENCE[input.scenario];
  conf += 0.25 * agreement;
  conf += 0.1 * clamp((input.nEff - 1) / 2, 0, 1);
  conf *= ttsFactor(input.tts);
  conf *= input.clvMultiplier;
  conf *= input.liquidityFactor;
  conf *= input.lineMatchFactor; // interpolerad linjematch sänker confidence

  const cap = input.isAnchor ? 1 : NON_ANCHOR_CONFIDENCE_CAP;
  return { confidence: clamp(conf, 0, cap), dispersion, agreement };
}
