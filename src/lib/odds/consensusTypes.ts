/**
 * Delade typer för det sharp-benchmark-mellanlager som ligger MELLAN
 * råa odds-källor och value-beslutet.
 *
 * Pipeline:
 *   råa odds (per källa)
 *     → devig per källa (consensus.ts: devigTwoWay / devigThreeWay)
 *     → ConsensusResult  (consensus.ts: buildConsensus)   ← "vad är fair price + hur stark benchmark"
 *     → ValueDecision    (consensus.ts: decideValue)      ← "AUTO_BET / MANUAL_REVIEW / NO_BET"
 *     → DecisionLog      (loggas alltid, även i shadow mode)
 *
 * Feed-agnostiskt: en källa representeras av en `SourceQuote` med en redan
 * devig:ad `fairProb` för EXAKT samma selection som candidate. Hur datan
 * hämtas (Betfair-API, SBO/IBC/Singbet-feed) spelar ingen roll här.
 */

import type { Selection } from "./types.ts";

/** Sporter mellanlagret hanterar (bredare än NormalizedOdds.sport i v1). */
export type BenchSport = "football" | "tennis" | "basketball";

/** Liga-/tävlingsnivå. T1 = topp, T3 = Challenger/ITF/obskyrt. */
export type LeagueTier = "T1" | "T2" | "T3";

export type Phase = "prematch" | "live";

/** Tid-till-start-hink — närmare start = sharpare linjer. */
export type TtsBucket = "<1h" | "1-6h" | "6-24h" | ">24h";

/** Marknadstyper i benchmark-systemet (mer granulärt än MarketType). */
export type BenchMarketType =
  | "ML_1X2"
  | "ML_2WAY"
  | "AH"
  | "ASIAN_TOTAL"
  | "TOTAL"
  | "SPREAD"
  | "PLAYER_PROP";

/** Vilken roll en källa spelar i EN given cell (sport×market×tier×phase). */
export type SourceRole = "primary" | "confirmation" | "weak" | "ignore";

/** De fem benchmark-scenarierna. */
export type Scenario =
  | "PINNACLE_ANCHOR"
  | "BETFAIR_LIQUID_PRIMARY"
  | "SHARP_CONSENSUS_NO_PINNACLE"
  | "SOFT_CONSENSUS_PROP"
  | "NO_RELIABLE_BENCHMARK";

export type Decision = "AUTO_BET" | "MANUAL_REVIEW" | "NO_BET" | "NEEDS_VALIDATION";

/** Maskinläsbara skäl — loggas i reasonCodes[]. */
export type ReasonCode =
  | "PINNACLE_PRIMARY"
  | "BETFAIR_LIQUID"
  | "BETFAIR_ILLIQUID"
  | "SHARP_CONSENSUS"
  | "NO_BENCHMARK"
  | "BELOW_REQUIRED_EDGE"
  | "ABOVE_REQUIRED_EDGE"
  | "BENCHMARK_TOO_WEAK"
  | "SHARP_DISAGREEMENT"
  | "INSUFFICIENT_INDEPENDENT_SOURCES"
  | "MARKET_NOT_AUTO_ALLOWED"
  | "CONFIDENCE_BELOW_AUTO"
  | "SHADOW_MODE"
  | "PROP_RULE_MISMATCH"
  | "PROP_INSUFFICIENT_BOOKS"
  | "PROP_BOOSTED_NEEDS_VALIDATION"
  | "PROP_SOFT_CONSENSUS";

/**
 * Ett devig:at bidrag från EN källa för selection vi utvärderar.
 * `fairProb` = no-vig sannolikhet för selection (0..1), redan beräknad av
 * adaptern via devig-hjälparna. Engine förblir feed-agnostisk.
 */
export interface SourceQuote {
  sourceId: string; // "pinnacle" | "betfair" | "sbobet" | "ibc" | "singbet"
  fairProb: number; // no-vig prob för SAMMA selection som candidate
  /** Råodds (för loggning), valfritt. */
  rawOdds?: number;
  /** True om källan är en börs (Betfair) — kräver liquidity-bedömning. */
  isExchange?: boolean;
  /** Resultat av betfairLiquidityFilter (endast för exchange-källor). */
  liquidityFactor?: number; // 0..1, 0 = underkänd
  /** False om linjen fick interpoleras utanför säkert intervall → uteslut. */
  lineComparable?: boolean;
  /**
   * Konfidens i linjematchningen (0..1): exact=1, quarter_split≈0.9,
   * interpolated≈0.5–0.75, rejected=0. Multipliceras in i trust + confidence.
   */
  lineMatchConfidence?: number;
}

/** Per-källa-utfall efter roll-/trust-bedömning (loggas). */
export interface BenchmarkResult {
  sourceId: string;
  present: boolean;
  role: SourceRole;
  baseTrust: number;
  effectiveTrust: number;
  weight: number; // vikt i consensus (0 om ignore)
  fairProb: number | null;
  isPinnacle: boolean;
  isExchange: boolean;
}

/** Fair-price-resultatet — STEG 1 (helt skilt från value-beslutet). */
export interface ConsensusResult {
  scenario: Scenario;
  /** Fair no-vig sannolikhet för selection. */
  fairProb: number | null;
  /** Fair odds = 1 / fairProb. */
  fairOdds: number | null;
  /** Källan/källorna som SATTE fair price. */
  benchmarkSource: string; // "pinnacle" | "betfair" | "consensus(sbobet,ibc,...)" | "none"
  benchmarkConfidence: number; // 0..1
  /** Effektivt antal oberoende källor (efter korrelations-nedräkning). */
  nEff: number;
  /** Spridning (stდev) i fairProb mellan källor. */
  dispersion: number;
  sources: BenchmarkResult[];
  sourceRoles: Record<string, SourceRole>;
  disagreementFlags: string[];
}

/** Value-beslutet — STEG 2. */
export interface ValueDecision {
  decision: Decision;
  /** True bara om decision===AUTO_BET OCH inte shadow mode. */
  executed: boolean;
  calculatedEdgePct: number | null;
  requiredEdgePct: number | null;
  reasonCodes: ReasonCode[];
}

/** Allt som ALLTID loggas (även shadow mode). Matchar användarens lista. */
export interface DecisionLog {
  ts: string;
  context: {
    sport: BenchSport;
    market: BenchMarketType;
    tier: LeagueTier;
    phase: Phase;
    ttsBucket: TtsBucket;
    line: number | null;
    selection: Selection;
    eventId?: string;
    league?: string;
    startTime?: string;
    homeTeam?: string;
    awayTeam?: string;
  };
  candidateBook: string;
  candidateOdds: number;
  fairPrice: number | null; // fair odds
  fairProb: number | null;
  benchmarkSource: string;
  benchmarkConfidence: number;
  scenario: Scenario;
  sourcesUsed: string[];
  sourceRoles: Record<string, SourceRole>;
  disagreementFlags: string[];
  requiredEdge: number | null;
  calculatedEdge: number | null;
  decision: Decision;
  executed: boolean;
  shadowMode: boolean;
  reasonCodes: ReasonCode[];
}
