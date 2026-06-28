/**
 * source_weights — råvikter för consensus-medelvärdet (consensus.ts §5.2).
 *
 * Runtime-vikt = source_weights[cell] × tierMultiplier × phaseMultiplier
 *                × independenceWeight × liquidityFactor × clvMultiplier.
 *
 * Skiljt från baseTrust (sourceTrustConfig.ts) som styr ROLL/confidence;
 * dessa tal styr hur mycket varje källa väger när fair price medelvärdas
 * i scenarier utan Pinnacle. Pinnacle = 1.0 (men används som anchor, inte
 * medelvärde, när den finns).
 */

import type { BenchMarketType, BenchSport, LeagueTier, Phase } from "./consensusTypes.ts";

type WeightRow = Partial<Record<string, number>>;
type SportWeights = Partial<Record<string, WeightRow>>;

const WEIGHTS: Record<BenchSport, SportWeights> = {
  football: {
    AH: { pinnacle: 1.0, betfair: 0.85, sbobet: 0.95, ibc: 0.9, singbet: 0.7 },
    ASIAN_TOTAL: { pinnacle: 1.0, betfair: 0.8, sbobet: 0.95, ibc: 0.9, singbet: 0.7 },
    ML_1X2: { pinnacle: 1.0, betfair: 0.8, sbobet: 0.7, ibc: 0.65, singbet: 0.4 },
    TOTAL: { pinnacle: 1.0, betfair: 0.8, sbobet: 0.75, ibc: 0.7, singbet: 0.45 },
  },
  tennis: {
    ML_2WAY: { pinnacle: 1.0, betfair: 0.9, sbobet: 0.6, ibc: 0.55, singbet: 0.4 },
    AH: { pinnacle: 1.0, betfair: 0.7, sbobet: 0.6, ibc: 0.55, singbet: 0.35 },
    TOTAL: { pinnacle: 1.0, betfair: 0.6, sbobet: 0.55, ibc: 0.5, singbet: 0.3 },
  },
  basketball: {
    SPREAD: { pinnacle: 1.0, betfair: 0.7, sbobet: 0.75, ibc: 0.7, singbet: 0.55 },
    ASIAN_TOTAL: { pinnacle: 1.0, betfair: 0.7, sbobet: 0.75, ibc: 0.7, singbet: 0.55 },
    TOTAL: { pinnacle: 1.0, betfair: 0.7, sbobet: 0.7, ibc: 0.65, singbet: 0.5 },
    ML_2WAY: { pinnacle: 1.0, betfair: 0.7, sbobet: 0.7, ibc: 0.65, singbet: 0.45 },
  },
};

const TIER_MULTIPLIER: Record<LeagueTier, number> = { T1: 1.0, T2: 0.7, T3: 0.4 };

function phaseMul(phase: Phase): number {
  return phase === "live" ? 0.8 : 1.0;
}

/** Råvikt för en källa i en cell (innan oberoende/likviditet/CLV). 0 = ej med. */
export function getSourceWeight(
  sourceId: string,
  sport: BenchSport,
  market: BenchMarketType,
  tier: LeagueTier,
  phase: Phase,
): number {
  const row = WEIGHTS[sport]?.[market];
  const base = row?.[sourceId] ?? 0;
  return base * TIER_MULTIPLIER[tier] * phaseMul(phase);
}
