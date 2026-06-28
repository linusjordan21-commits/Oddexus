/**
 * consensus.ts — sharp_consensus_engine. Mellanlagret som avgör:
 *   1. vad fair price är            (buildConsensus → ConsensusResult)
 *   2. hur stark benchmarken är     (benchmarkConfidence)
 *   3. om källorna håller med        (dispersion + disagreementFlags)
 *   4. AUTO_BET / MANUAL_REVIEW / NO_BET   (decideValue → ValueDecision)
 *
 * Feed-agnostiskt: källor kommer in som SourceQuote[] (redan devig:ade).
 * Pinnacle/Betfair/SBOBET/IBC/Singbet kopplas på via adaptrar SENARE — de
 * behöver bara producera SourceQuote { sourceId, fairProb }.
 *
 * VIKTIGT: fair price (steg 1) beräknas HELT utan att titta på candidate-
 * oddset. Value-beslutet (steg 2) är en separat funktion. De blandas aldrig.
 */

import type { Selection } from "./types.ts";
import type {
  BenchMarketType,
  BenchSport,
  BenchmarkResult,
  ConsensusResult,
  Decision,
  DecisionLog,
  LeagueTier,
  Phase,
  ReasonCode,
  Scenario,
  SourceQuote,
  SourceRole,
  TtsBucket,
  ValueDecision,
} from "./consensusTypes.ts";
import { getBaseTrust, isPinnacle, phaseMultiplier, requiresLiquidity } from "./sourceTrustConfig.ts";
import { getSourceWeight } from "./sourceWeights.ts";
import {
  C_AUTO,
  C_REVIEW,
  getMinEdgeConfig,
  requiredEdge,
} from "./marketTypeConfig.ts";
import {
  benchmarkConfidence,
  deriveSourceRole,
  effectiveIndependentCount,
  ttsFactor,
} from "./confidence.ts";

// Pinnacle-dominans i PINNACLE_ANCHOR-blandningen: Pinnacle väger detta × sin
// råvikt när skarpa komplement (SBOBET/Betfair) nudgar fair price. 2.5 ger
// Pinnacle ~72% / SBOBET ~28% på AH (sbobet-vikt 0.95) och ~78/22 på 1X2
// (0.7) vid T1 prematch — Pinnacle alltid dominant, komplement störst där de
// är skarpast. Höj för mer Pinnacle-dominans, sänk för mer komplement-inflytande.
const PINNACLE_DOMINANCE = 2.5;

// ── Devig-hjälpare (samma princip som edge.ts) ─────────────────────────
/** No-vig prob för 2-vägsmarknad (AH, asian total, tennis ML, basket spread). */
export function devigTwoWay(oddsSide: number, oddsOther: number): number {
  const a = 1 / oddsSide;
  const b = 1 / oddsOther;
  return a / (a + b);
}

/** No-vig prob för EN selection i 3-vägs 1X2. */
export function devigThreeWay(oddsHome: number, oddsDraw: number, oddsAway: number, sel: "HOME" | "DRAW" | "AWAY"): number {
  const ph = 1 / oddsHome, pd = 1 / oddsDraw, pa = 1 / oddsAway;
  const over = ph + pd + pa;
  const pick = sel === "HOME" ? ph : sel === "DRAW" ? pd : pa;
  return pick / over;
}

// ── Kontext + input ────────────────────────────────────────────────────
export interface MarketContext {
  sport: BenchSport;
  market: BenchMarketType;
  tier: LeagueTier;
  phase: Phase;
  ttsBucket: TtsBucket;
  line: number | null;
  selection: Selection;
  /** Stabil event-id (för CLV-join mot closing line). */
  eventId?: string;
  league?: string;
  /** Avspark (ISO) — används av dedupe för "närmast kickoff". */
  startTime?: string;
  homeTeam?: string;
  awayTeam?: string;
}

export interface EvaluateInput {
  context: MarketContext;
  candidate: { bookmaker: string; odds: number };
  /** Benchmark-källor, var och en med fairProb för SAMMA selection. */
  sources: SourceQuote[];
  /** CLV-multiplikatorer per källa från historik (default 1). */
  clvMultipliers?: Record<string, number>;
  /** Shadow mode: beräkna och logga, men exekvera ALDRIG. Default true. */
  shadowMode?: boolean;
}

export interface EvaluateOutput {
  consensus: ConsensusResult;
  decision: ValueDecision;
  log: DecisionLog;
}

// ── STEG 1: fair price + benchmark-styrka ──────────────────────────────
export function buildConsensus(
  context: MarketContext,
  sources: SourceQuote[],
  clvMultipliers: Record<string, number> = {},
): ConsensusResult {
  const { sport, market, tier, phase, ttsBucket } = context;
  const ttf = ttsFactor(ttsBucket);

  // 1) Bedöm varje källa: baseTrust → effectiveTrust → roll + vikt.
  const results: BenchmarkResult[] = [];
  for (const q of sources) {
    const present = q.fairProb != null && Number.isFinite(q.fairProb) && q.lineComparable !== false;
    const baseTrust = getBaseTrust(q.sourceId, sport, market, tier);
    const liq = q.isExchange ? (q.liquidityFactor ?? 0) : 1;
    const clv = clvMultipliers[q.sourceId] ?? 1;
    // Linjematch-faktor: rejected (lineComparable===false) → present=false →
    // effectiveTrust 0; interpolated (<1) drar ner trust + vikt.
    const lmc = q.lineMatchConfidence ?? 1;
    // Exchange-källa som underkänts på likviditet → effectiveTrust 0.
    const effectiveTrust = present && baseTrust > 0
      ? baseTrust * liq * clv * lmc * ttf * phaseMultiplier(phase)
      : 0;
    const pin = isPinnacle(q.sourceId);
    const role: SourceRole = effectiveTrust > 0 || (pin && present)
      ? deriveSourceRole(effectiveTrust, pin, present)
      : "ignore";
    const weight = role === "ignore" ? 0 : getSourceWeight(q.sourceId, sport, market, tier, phase) * liq * clv * lmc;
    results.push({
      sourceId: q.sourceId,
      present,
      role,
      baseTrust,
      effectiveTrust,
      weight,
      fairProb: present ? q.fairProb : null,
      isPinnacle: pin,
      isExchange: q.isExchange === true,
    });
  }

  const contributing = results.filter((r) => r.role !== "ignore" && r.fairProb != null);
  const sourceRoles: Record<string, SourceRole> = {};
  for (const r of results) sourceRoles[r.sourceId] = r.role;

  // 2) Scenario.
  const pinnacle = contributing.find((r) => r.isPinnacle);
  const betfair = contributing.find((r) => r.isExchange);
  const contributingIds = contributing.map((r) => r.sourceId);
  const nEff = effectiveIndependentCount(contributingIds);

  let scenario: Scenario;
  let benchmarkSource: string;
  let fairProb: number | null;

  if (pinnacle) {
    scenario = "PINNACLE_ANCHOR";
    // Pinnacle SÄTTER fair price men skarpa komplement (SBOBET — störst på AH/
    // Asian totals; Betfair) NUDGAR priset efter sin marknadsvikt. Pinnacle får
    // en dominansvikt (PINNACLE_DOMINANCE×) så den alltid väger tyngst — komplement
    // kan aldrig ta över. Inget komplement närvarande → ren Pinnacle (oförändrat).
    const confirmers = contributing.filter((r) => !r.isPinnacle && r.weight > 0 && r.fairProb != null);
    if (confirmers.length > 0) {
      const pinAnchorWeight = getSourceWeight("pinnacle", sport, market, tier, phase) * PINNACLE_DOMINANCE;
      const blendInputs = [{ ...pinnacle, weight: pinAnchorWeight }, ...confirmers];
      fairProb = weightedConsensus(blendInputs) ?? pinnacle.fairProb;
      benchmarkSource = `pinnacle+${confirmers.map((r) => r.sourceId).join("+")}`;
    } else {
      benchmarkSource = "pinnacle";
      fairProb = pinnacle.fairProb;
    }
  } else if (betfair && betfair.role === "primary") {
    scenario = "BETFAIR_LIQUID_PRIMARY";
    benchmarkSource = `betfair${contributing.length > 1 ? "+confirm" : ""}`;
    fairProb = weightedConsensus(contributing);
  } else if (contributing.length >= 2) {
    // ≥2 råa sharp-källor → consensus-scenario. Att nEff<2 (korrelerade
    // asiatiska books) stoppas i decideValue (→ MANUAL_REVIEW/NO_BET),
    // inte här — annars förlorar vi loggningen av att vi HADE consensus.
    scenario = "SHARP_CONSENSUS_NO_PINNACLE";
    benchmarkSource = `consensus(${contributingIds.join(",")})`;
    fairProb = weightedConsensus(contributing);
  } else {
    // 0 eller 1 källa → ingen tillförlitlig benchmark.
    scenario = "NO_RELIABLE_BENCHMARK";
    benchmarkSource = "none";
    fairProb = contributing.length === 1 ? contributing[0].fairProb : null;
  }

  // 3) Spridning + agreement → confidence.
  const cfg = getMinEdgeConfig(sport, market, tier);
  // För anchor: mät om confirmers håller med Pinnacle (alla bidragande).
  const probsForDispersion = contributing.map((r) => r.fairProb as number);
  const dominant = pinnacle ?? betfair ?? contributing[0];
  const liquidityFactor = betfair ? (sources.find((s) => s.sourceId === betfair.sourceId)?.liquidityFactor ?? 1) : 1;

  // Aggregerad linjematch-faktor: viktat medel av lineMatchConfidence över
  // bidragande källor (interpolerade källor sänker confidence).
  const lmcById = new Map(sources.map((s) => [s.sourceId, s.lineMatchConfidence ?? 1]));
  let lmcNum = 0, lmcDen = 0;
  for (const r of contributing) {
    const w = Math.max(r.weight, 1e-9);
    lmcNum += w * (lmcById.get(r.sourceId) ?? 1);
    lmcDen += w;
  }
  const lineMatchFactor = lmcDen > 0 ? lmcNum / lmcDen : 1;

  const conf = benchmarkConfidence({
    scenario,
    contributingProbs: probsForDispersion,
    nEff,
    dispersionRef: cfg.dispersionRef,
    tts: ttsBucket,
    clvMultiplier: dominant ? (clvMultipliers[dominant.sourceId] ?? 1) : 1,
    liquidityFactor,
    lineMatchFactor,
    isAnchor: scenario === "PINNACLE_ANCHOR",
  });

  // 4) Disagreement-flaggor.
  const disagreementFlags: string[] = [];
  if (conf.dispersion > cfg.dispersionKill) {
    disagreementFlags.push(`DISPERSION_${conf.dispersion.toFixed(4)}_OVER_KILL_${cfg.dispersionKill}`);
  }
  if (pinnacle) {
    for (const r of contributing) {
      if (r.isPinnacle || r.fairProb == null || pinnacle.fairProb == null) continue;
      if (Math.abs(r.fairProb - pinnacle.fairProb) > cfg.dispersionKill) {
        disagreementFlags.push(`${r.sourceId}_DIVERGES_FROM_PINNACLE`);
      }
    }
  }

  return {
    scenario,
    fairProb,
    fairOdds: fairProb && fairProb > 0 ? 1 / fairProb : null,
    benchmarkSource,
    benchmarkConfidence: conf.confidence,
    nEff,
    dispersion: conf.dispersion,
    sources: results,
    sourceRoles,
    disagreementFlags,
  };
}

/** Viktat consensus-medelvärde av fairProb (oberoende-delad vikt). */
function weightedConsensus(contributing: BenchmarkResult[]): number | null {
  // Dela vikt inom korrelationsgrupp så SBO/IBC/Singbet inte tredubblar.
  const groupCounts = new Map<string, number>();
  for (const r of contributing) {
    const g = groupKey(r.sourceId);
    if (g) groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }
  let num = 0, den = 0;
  for (const r of contributing) {
    if (r.fairProb == null || r.weight <= 0) continue;
    const g = groupKey(r.sourceId);
    const indep = g ? 1 / (groupCounts.get(g) ?? 1) : 1;
    const w = r.weight * indep;
    num += w * r.fairProb;
    den += w;
  }
  return den > 0 ? num / den : null;
}

function groupKey(sourceId: string): string | null {
  // Lokalt utan import-cykel: asiatiska books delar grupp.
  if (sourceId === "sbobet" || sourceId === "ibc" || sourceId === "singbet") return "asian_bti";
  return null;
}

// ── STEG 2: value-beslut ───────────────────────────────────────────────
export function decideValue(
  context: MarketContext,
  candidateOdds: number,
  consensus: ConsensusResult,
  shadowMode: boolean,
): ValueDecision {
  const reasonCodes: ReasonCode[] = [];
  const cfg = getMinEdgeConfig(context.sport, context.market, context.tier);

  // Ingen tillförlitlig benchmark → alltid NO_BET.
  if (consensus.scenario === "NO_RELIABLE_BENCHMARK" || consensus.fairProb == null) {
    reasonCodes.push("NO_BENCHMARK");
    return { decision: "NO_BET", executed: false, calculatedEdgePct: null, requiredEdgePct: null, reasonCodes };
  }

  // Scenario-reason.
  if (consensus.scenario === "PINNACLE_ANCHOR") reasonCodes.push("PINNACLE_PRIMARY");
  else if (consensus.scenario === "BETFAIR_LIQUID_PRIMARY") reasonCodes.push("BETFAIR_LIQUID");
  else if (consensus.scenario === "SHARP_CONSENSUS_NO_PINNACLE") reasonCodes.push("SHARP_CONSENSUS");

  const edgePct = (candidateOdds * consensus.fairProb - 1) * 100;
  const reqEdge = requiredEdge(cfg, consensus.benchmarkConfidence, consensus.scenario);

  // Disagreement-kill override.
  if (consensus.disagreementFlags.length > 0) {
    reasonCodes.push("SHARP_DISAGREEMENT");
    return { decision: "NO_BET", executed: false, calculatedEdgePct: edgePct, requiredEdgePct: reqEdge, reasonCodes };
  }

  // Confidence-golv.
  if (consensus.benchmarkConfidence < C_REVIEW) {
    reasonCodes.push("BENCHMARK_TOO_WEAK");
    return { decision: "NO_BET", executed: false, calculatedEdgePct: edgePct, requiredEdgePct: reqEdge, reasonCodes };
  }

  // Edge-krav.
  if (edgePct < reqEdge) {
    reasonCodes.push("BELOW_REQUIRED_EDGE");
    return { decision: "NO_BET", executed: false, calculatedEdgePct: edgePct, requiredEdgePct: reqEdge, reasonCodes };
  }
  reasonCodes.push("ABOVE_REQUIRED_EDGE");

  // Härifrån: minst MANUAL_REVIEW. Avgör om AUTO är tillåtet.
  let decision: Decision = "AUTO_BET";
  if (consensus.benchmarkConfidence < C_AUTO) { decision = "MANUAL_REVIEW"; reasonCodes.push("CONFIDENCE_BELOW_AUTO"); }
  if (!cfg.autoAllowed) { decision = "MANUAL_REVIEW"; reasonCodes.push("MARKET_NOT_AUTO_ALLOWED"); }
  if (consensus.scenario !== "PINNACLE_ANCHOR" && consensus.nEff < 2) {
    decision = "MANUAL_REVIEW";
    reasonCodes.push("INSUFFICIENT_INDEPENDENT_SOURCES");
  }

  // Shadow mode: aldrig exekvera, men behåll beslutet i loggen.
  const executed = decision === "AUTO_BET" && !shadowMode;
  if (shadowMode) reasonCodes.push("SHADOW_MODE");

  return { decision, executed, calculatedEdgePct: edgePct, requiredEdgePct: reqEdge, reasonCodes };
}

// ── Orchestrator + logg ────────────────────────────────────────────────
export function evaluateMarket(input: EvaluateInput): EvaluateOutput {
  const shadowMode = input.shadowMode !== false; // default ON
  const consensus = buildConsensus(input.context, input.sources, input.clvMultipliers ?? {});
  const decision = decideValue(input.context, input.candidate.odds, consensus, shadowMode);

  const log: DecisionLog = {
    ts: new Date().toISOString(),
    context: {
      sport: input.context.sport,
      market: input.context.market,
      tier: input.context.tier,
      phase: input.context.phase,
      ttsBucket: input.context.ttsBucket,
      line: input.context.line,
      selection: input.context.selection,
      eventId: input.context.eventId,
      league: input.context.league,
      startTime: input.context.startTime,
      homeTeam: input.context.homeTeam,
      awayTeam: input.context.awayTeam,
    },
    candidateBook: input.candidate.bookmaker,
    candidateOdds: input.candidate.odds,
    fairPrice: consensus.fairOdds,
    fairProb: consensus.fairProb,
    benchmarkSource: consensus.benchmarkSource,
    benchmarkConfidence: consensus.benchmarkConfidence,
    scenario: consensus.scenario,
    sourcesUsed: consensus.sources.filter((s) => s.role !== "ignore").map((s) => s.sourceId),
    sourceRoles: consensus.sourceRoles,
    disagreementFlags: consensus.disagreementFlags,
    requiredEdge: decision.requiredEdgePct,
    calculatedEdge: decision.calculatedEdgePct,
    decision: decision.decision,
    executed: decision.executed,
    shadowMode,
    reasonCodes: decision.reasonCodes,
  };

  return { consensus, decision, log };
}
