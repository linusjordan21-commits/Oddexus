/**
 * sbobetAdapter.ts — normaliserar SBOBET-marknader (SbobetMarket) till vårt
 * interna SourceQuote-format för consensus-mellanlagret.
 *
 * SBOBET är en SKARP bok (inte en börs): ingen order book / likviditetsfilter
 * som Betfair, utan ett vasst no-vig-pris som devig:as direkt ur de visade
 * decimal-oddsen. SBO korrelerar starkt med IBC/ISN (samma asiatiska linje) →
 * consensus får INTE räkna dem som två oberoende källor (hanteras av
 * korrelations-nedräkningen i consensus.ts, inte här).
 *
 * v1-marknader: fotboll 1X2 (ML_1X2) + Asian Handicap (AH, via lineMatching).
 */

import type { Selection } from "./types.ts";
import type { SourceQuote } from "./consensusTypes.ts";
import { devigTwoWay, devigThreeWay } from "./consensus.ts";
import {
  matchLine,
  type LineMatchResult,
  type LineMatchTarget,
  type SourceLadder,
} from "./lineMatching.ts";
import { SBOBET_SOURCE_ID, type SbobetMarket } from "./sbobetScrapeParse.ts";

export { SBOBET_SOURCE_ID };

function oddsBySelection(market: SbobetMarket): Map<Selection, number> {
  const m = new Map<Selection, number>();
  for (const r of market.runners) m.set(r.selection, r.decimalOdds);
  return m;
}

/**
 * 1X2-quote: no-vig fairProb för EN selection via 3-vägs-devig. Ofullständig
 * marknad → fairProb 0 + lineComparable false (consensus ignorerar).
 */
export function sbobetMoneylineQuote(market: SbobetMarket, selection: Selection): SourceQuote {
  const odds = oddsBySelection(market);
  const h = odds.get("HOME"), d = odds.get("DRAW"), a = odds.get("AWAY");
  const complete = market.marketType === "ML_1X2" && h != null && d != null && a != null && h > 1 && d > 1 && a > 1;
  const pick = selection === "HOME" ? h : selection === "DRAW" ? d : a;
  const fairProb = complete && pick != null ? devigThreeWay(h!, d!, a!, selection as "HOME" | "DRAW" | "AWAY") : 0;
  return {
    sourceId: SBOBET_SOURCE_ID,
    fairProb,
    rawOdds: pick,
    isExchange: false,
    lineComparable: complete,
    lineMatchConfidence: 1, // ingen lina att matcha för 1X2
  };
}

/**
 * Bygg en AH-SourceLadder (canonical = HOME no-vig-prob per linje) ur flera
 * AH-marknader för SAMMA event. Tecknet på linjen är ur HEMMA-perspektiv.
 */
export function buildAhLadder(markets: SbobetMarket[], scope = "full"): SourceLadder {
  const points: { line: number; prob: number }[] = [];
  for (const m of markets) {
    if (m.marketType !== "AH" || m.line == null) continue;
    const odds = oddsBySelection(m);
    const h = odds.get("HOME"), a = odds.get("AWAY");
    if (h == null || a == null || h <= 1 || a <= 1) continue;
    points.push({ line: m.line, prob: devigTwoWay(h, a) }); // canonical = HOME
  }
  return { sourceId: SBOBET_SOURCE_ID, marketType: "AH", scope, points };
}

export interface SbobetAhQuoteResult {
  quote: SourceQuote;
  lineMatch: LineMatchResult;
}

/**
 * AH-quote: line-matcha target mot SBOBET:s AH-steg (exact först). rejected →
 * lineComparable false → consensus ignorerar SBOBET för den linjen.
 */
export function sbobetAhQuote(target: LineMatchTarget, markets: SbobetMarket[]): SbobetAhQuoteResult {
  const ladder = buildAhLadder(markets, target.scope);
  const m = matchLine(target, ladder);
  return {
    quote: {
      sourceId: SBOBET_SOURCE_ID,
      fairProb: m.fairProb ?? 0,
      isExchange: false,
      lineComparable: m.comparable,
      lineMatchConfidence: m.lineMatchConfidence,
    },
    lineMatch: m,
  };
}
