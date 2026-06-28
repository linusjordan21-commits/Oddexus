/**
 * market_type_config — minimum_edge_by_market, confidence-trösklar,
 * scenario-tillägg och dispersion-gränser. Driver requiredEdge() och
 * beslutslogiken i consensus.ts.
 *
 * Alla siffror är STARTVÄRDEN. De kalibreras över tid av CLV-feedbacken
 * (se SHARP-SOURCES-DESIGN.md §13) — börja konservativt (hellre missa).
 */

import type { BenchMarketType, BenchSport, LeagueTier, Scenario } from "./consensusTypes.ts";

export interface MinEdgeConfig {
  /** Edge-krav (%) när confidence = 1.0. */
  baseEdge: number;
  /** Tillägg (%) per (1 − confidence). Svag benchmark → högre krav. */
  penaltySlope: number;
  /** Om marknaden över huvud taget får nå AUTO_BET. */
  autoAllowed: boolean;
  /** Referensspridning för agreement-bonus (stდev i prob). */
  dispersionRef: number;
  /** Spridning över detta → SHARP_DISAGREEMENT → NO_BET oavsett edge. */
  dispersionKill: number;
}

/** Nyckel = `${sport}_${market}` + ev. tier-suffix för specialfall. */
function key(sport: BenchSport, market: BenchMarketType): string {
  return `${sport}_${market}`;
}

const DEFAULTS: MinEdgeConfig = {
  baseEdge: 2.0,
  penaltySlope: 4.5,
  autoAllowed: false,
  dispersionRef: 0.02,
  dispersionKill: 0.035,
};

const TABLE: Record<string, Partial<MinEdgeConfig>> = {
  "football_AH": { baseEdge: 1.5, penaltySlope: 4.0, autoAllowed: true },
  "football_ASIAN_TOTAL": { baseEdge: 1.5, penaltySlope: 4.0, autoAllowed: true },
  "football_ML_1X2": { baseEdge: 2.0, penaltySlope: 4.0, autoAllowed: true },
  "football_TOTAL": { baseEdge: 2.0, penaltySlope: 4.0, autoAllowed: true },

  "tennis_ML_2WAY": { baseEdge: 2.0, penaltySlope: 4.5, autoAllowed: true },
  "tennis_AH": { baseEdge: 2.5, penaltySlope: 5.0, autoAllowed: true },
  "tennis_TOTAL": { baseEdge: 2.5, penaltySlope: 5.0, autoAllowed: false },

  "basketball_SPREAD": { baseEdge: 2.0, penaltySlope: 4.5, autoAllowed: true },
  "basketball_TOTAL": { baseEdge: 2.0, penaltySlope: 4.5, autoAllowed: true },
  "basketball_ASIAN_TOTAL": { baseEdge: 2.0, penaltySlope: 4.5, autoAllowed: true },
  "basketball_ML_2WAY": { baseEdge: 2.0, penaltySlope: 4.5, autoAllowed: true },

  "football_PLAYER_PROP": { baseEdge: 6.0, penaltySlope: 8.0, autoAllowed: false },
};

/**
 * Hämta edge-config för en cell. Tier T3 (Challenger/ITF m.m.) höjer kravet
 * och stänger av auto — svaga marknader ska aldrig auto-bet:as.
 */
export function getMinEdgeConfig(
  sport: BenchSport,
  market: BenchMarketType,
  tier: LeagueTier,
): MinEdgeConfig {
  const base: MinEdgeConfig = { ...DEFAULTS, ...(TABLE[key(sport, market)] ?? {}) };
  if (tier === "T3") {
    return { ...base, baseEdge: base.baseEdge + 2.0, penaltySlope: base.penaltySlope + 1.5, autoAllowed: false };
  }
  if (tier === "T2") {
    return { ...base, baseEdge: base.baseEdge + 0.5 };
  }
  return base;
}

/** Confidence-trösklar (delade mellan alla marknader). */
export const C_AUTO = 0.65; // under detta: aldrig AUTO_BET
export const C_REVIEW = 0.4; // under detta: aldrig ens review → NO_BET

/** Edge-tillägg (%) per scenario — hårdare när Pinnacle saknas. */
export const SCENARIO_EDGE_ADD: Record<Scenario, number> = {
  PINNACLE_ANCHOR: 0,
  BETFAIR_LIQUID_PRIMARY: 1.0,
  SHARP_CONSENSUS_NO_PINNACLE: 1.0,
  SOFT_CONSENSUS_PROP: 2.5,
  NO_RELIABLE_BENCHMARK: 999, // i praktiken alltid NO_BET
};

/** Bas-confidence per scenario (innan agreement/oberoende/modifierare). */
export const SCENARIO_BASE_CONFIDENCE: Record<Scenario, number> = {
  PINNACLE_ANCHOR: 0.6,
  BETFAIR_LIQUID_PRIMARY: 0.5,
  SHARP_CONSENSUS_NO_PINNACLE: 0.45,
  SOFT_CONSENSUS_PROP: 0.35,
  NO_RELIABLE_BENCHMARK: 0.12,
};

/** Confidence-tak när Pinnacle SAKNAS — även perfekt agreement kapas. */
export const NON_ANCHOR_CONFIDENCE_CAP = 0.8;

/**
 * requiredEdge(%) = baseEdge + (1−confidence)·penaltySlope + scenario-tillägg.
 */
export function requiredEdge(
  cfg: MinEdgeConfig,
  confidence: number,
  scenario: Scenario,
): number {
  const conf = Math.max(0, Math.min(1, confidence));
  return cfg.baseEdge + (1 - conf) * cfg.penaltySlope + SCENARIO_EDGE_ADD[scenario];
}
