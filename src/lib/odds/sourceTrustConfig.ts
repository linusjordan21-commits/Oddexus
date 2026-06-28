/**
 * source_trust_config — baseTrust per cell (källa × sport × market × tier)
 * samt korrelationsgrupper för asiatiska books.
 *
 * baseTrust ∈ [0,1]; 0 = får ALDRIG vara benchmark i cellen. Detta är en
 * MÄNSKLIG prior. Runtime-justeringar (likviditet, CLV, tts) läggs ovanpå
 * i confidence.ts/consensus.ts och rör inte dessa tal.
 *
 * Designregler (från SHARP-SOURCES-DESIGN.md):
 *   - Pinnacle = 1.0 överallt (default primary när marknaden finns).
 *   - SBOBET/IBC = starkast på fotboll AH/Asian totals.
 *   - Singbet = svagast → mest confirmation.
 *   - Betfair = hög bara T1 (likviditet avgör i runtime).
 *   - Player props → 0 för ALLA (hanteras i propEngine.ts).
 */

import type { BenchMarketType, BenchSport, LeagueTier, Phase } from "./consensusTypes.ts";

type Cell = Partial<Record<BenchMarketType, number>>;
type SportTrust = Partial<Record<BenchSport, Partial<Record<LeagueTier, Cell>>>>;

interface SourceTrustEntry {
  /** Statisk roll-hint (informativ; faktisk roll härleds i runtime). */
  role: "primary" | "independent_sharp" | "asian_sharp" | "asian_confirm";
  /** Kräver likviditetsbedömning innan hög trust (Betfair). */
  requiresLiquidity?: boolean;
  trust: SportTrust;
}

export const SOURCE_TRUST_CONFIG: Record<string, SourceTrustEntry> = {
  pinnacle: {
    role: "primary",
    trust: {
      football: { T1: { ML_1X2: 1, TOTAL: 1, AH: 1, ASIAN_TOTAL: 1 }, T2: { ML_1X2: 1, AH: 1, ASIAN_TOTAL: 1 }, T3: { ML_1X2: 1, AH: 1 } },
      tennis: { T1: { ML_2WAY: 1, AH: 1, TOTAL: 1 }, T2: { ML_2WAY: 1 }, T3: { ML_2WAY: 1 } },
      basketball: { T1: { SPREAD: 1, TOTAL: 1, ASIAN_TOTAL: 1, ML_2WAY: 1 }, T2: { SPREAD: 1, TOTAL: 1 } },
    },
  },

  betfair: {
    role: "independent_sharp",
    requiresLiquidity: true,
    trust: {
      football: { T1: { AH: 0.85, ASIAN_TOTAL: 0.8, ML_1X2: 0.8, TOTAL: 0.8 }, T2: { AH: 0.5, ML_1X2: 0.5 }, T3: { AH: 0.2 } },
      tennis: { T1: { ML_2WAY: 0.9, AH: 0.7, TOTAL: 0.6 }, T2: { ML_2WAY: 0.5 }, T3: { ML_2WAY: 0.25 } },
      basketball: { T1: { SPREAD: 0.7, TOTAL: 0.7, ASIAN_TOTAL: 0.7, ML_2WAY: 0.7 }, T2: { SPREAD: 0.4 } },
    },
  },

  sbobet: {
    role: "asian_sharp",
    trust: {
      football: { T1: { AH: 0.95, ASIAN_TOTAL: 0.95, ML_1X2: 0.7, TOTAL: 0.75 }, T2: { AH: 0.8, ASIAN_TOTAL: 0.8 }, T3: { AH: 0.55 } },
      tennis: { T1: { ML_2WAY: 0.6, AH: 0.6 }, T2: { ML_2WAY: 0.4 }, T3: { ML_2WAY: 0.2 } },
      basketball: { T1: { SPREAD: 0.75, ASIAN_TOTAL: 0.75, TOTAL: 0.7, ML_2WAY: 0.7 }, T2: { SPREAD: 0.5 } },
    },
  },

  ibc: {
    role: "asian_sharp",
    trust: {
      football: { T1: { AH: 0.9, ASIAN_TOTAL: 0.9, ML_1X2: 0.65, TOTAL: 0.7 }, T2: { AH: 0.75, ASIAN_TOTAL: 0.75 }, T3: { AH: 0.5 } },
      tennis: { T1: { ML_2WAY: 0.55, AH: 0.55 }, T2: { ML_2WAY: 0.35 }, T3: { ML_2WAY: 0.2 } },
      basketball: { T1: { SPREAD: 0.7, ASIAN_TOTAL: 0.7, TOTAL: 0.65, ML_2WAY: 0.65 }, T2: { SPREAD: 0.45 } },
    },
  },

  singbet: {
    role: "asian_confirm",
    trust: {
      football: { T1: { AH: 0.7, ASIAN_TOTAL: 0.7, ML_1X2: 0.4, TOTAL: 0.45 }, T2: { AH: 0.5 }, T3: { AH: 0.3 } },
      tennis: { T1: { ML_2WAY: 0.4 }, T2: { ML_2WAY: 0.25 } },
      basketball: { T1: { SPREAD: 0.55, ASIAN_TOTAL: 0.55, TOTAL: 0.5, ML_2WAY: 0.45 } },
    },
  },

  // Smarkets — börs (back/lay). Vår rows-fil saknar per-linje-djup, så vi behandlar
  // den som en SKARP confirmer (ej exchange-likviditetsgrindad) med KONSERVATIV trust:
  // den nudgar konsensus men kan aldrig ensam sätta priset. Oberoende orderbok från
  // Betfair → ingen korrelationsgrupp.
  smarkets: {
    role: "independent_sharp",
    trust: {
      football: { T1: { AH: 0.6, ASIAN_TOTAL: 0.55, ML_1X2: 0.55, TOTAL: 0.55 }, T2: { AH: 0.4, ML_1X2: 0.4 }, T3: { AH: 0.2 } },
      tennis: { T1: { ML_2WAY: 0.55, AH: 0.45 }, T2: { ML_2WAY: 0.35 } },
      basketball: { T1: { SPREAD: 0.5, TOTAL: 0.5, ML_2WAY: 0.5 } },
    },
  },
};

/**
 * Korrelationsgrupper. Källor i samma grupp räknas INTE som oberoende —
 * se effectiveIndependentCount i confidence.ts. SBOBET/IBC/Singbet kommer
 * ofta från samma asiatiska prismotor/feed.
 */
export interface CorrelationGroup {
  id: string;
  members: string[];
  rho: number; // 0..1, högre = mer korrelerade = mindre extra information
}

export const CORRELATION_GROUPS: CorrelationGroup[] = [
  { id: "asian_bti", members: ["sbobet", "ibc", "singbet"], rho: 0.7 },
];

/** Slå upp baseTrust för en cell. 0 om saknas (= ignore). */
export function getBaseTrust(
  sourceId: string,
  sport: BenchSport,
  market: BenchMarketType,
  tier: LeagueTier,
): number {
  if (market === "PLAYER_PROP") return 0; // props hanteras separat
  const entry = SOURCE_TRUST_CONFIG[sourceId];
  if (!entry) return 0;
  return entry.trust[sport]?.[tier]?.[market] ?? 0;
}

/** Returnerar korrelationsgruppen källan tillhör, eller null (= oberoende). */
export function getCorrelationGroup(sourceId: string): CorrelationGroup | null {
  return CORRELATION_GROUPS.find((g) => g.members.includes(sourceId)) ?? null;
}

export function isPinnacle(sourceId: string): boolean {
  return sourceId === "pinnacle";
}

export function requiresLiquidity(sourceId: string): boolean {
  return SOURCE_TRUST_CONFIG[sourceId]?.requiresLiquidity === true;
}

/** Phase-multiplikator: live = snabbare/brusigare → lägre trust. */
export function phaseMultiplier(phase: Phase): number {
  return phase === "live" ? 0.8 : 1.0;
}
