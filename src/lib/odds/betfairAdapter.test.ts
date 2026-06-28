/**
 * Tester för Betfair-adaptern med mockad order book-data. Verifierar
 * likviditetsgrind, line-matching-koppling och consensus-integration.
 * Allt shadow-only.
 */

import { describe, it, expect } from "vitest";
import {
  betfairMoneylineQuote,
  betfairTotalsQuote,
  normalizeMarket,
  type BetfairMarket,
} from "./betfairAdapter.ts";
import { buildClvEntry } from "./clvLogger.ts";
import { evaluateMarket, type MarketContext } from "./consensus.ts";

// ── Mock-marknader ─────────────────────────────────────────────────────
function liquidFootballMatchOdds(): BetfairMarket {
  return {
    marketId: "1.1-mo", sport: "football", marketType: "MATCH_ODDS", scope: "full", matchedVolume: 250000,
    runners: [
      { selection: "HOME", backOdds: 2.0, layOdds: 2.02, backDepth: 5000, layDepth: 4800 },
      { selection: "DRAW", backOdds: 3.5, layOdds: 3.55, backDepth: 3000, layDepth: 2900 },
      { selection: "AWAY", backOdds: 3.9, layOdds: 3.95, backDepth: 2500, layDepth: 2400 },
    ],
  };
}
function liquidTennisMatchWinner(): BetfairMarket {
  return {
    marketId: "1.2-tw", sport: "tennis", marketType: "MATCH_WINNER", scope: "full", matchedVolume: 80000,
    runners: [
      { selection: "HOME", backOdds: 1.85, layOdds: 1.87, backDepth: 2000, layDepth: 1900 },
      { selection: "AWAY", backOdds: 2.05, layOdds: 2.08, backDepth: 1800, layDepth: 1700 },
    ],
  };
}
function illiquidFootballMatchOdds(): BetfairMarket {
  return { ...liquidFootballMatchOdds(), marketId: "1.3-illq", matchedVolume: 500 }; // under tröskel
}
function wideSpreadFootballMatchOdds(): BetfairMarket {
  const m = liquidFootballMatchOdds();
  m.marketId = "1.4-wide";
  m.runners[0] = { selection: "HOME", backOdds: 2.0, layOdds: 2.3, backDepth: 5000, layDepth: 4800 }; // ~14% spread
  return m;
}
function totalsMarkets(lines: number[]): BetfairMarket[] {
  // P(Over) faller med line; sätt rimliga back/lay per lina.
  const overByLine: Record<number, [number, number]> = {
    1.5: [1.45, 1.47], 2.0: [1.7, 1.72], 2.5: [1.95, 1.97], 3.0: [2.3, 2.33], 3.5: [2.9, 2.95],
    2.25: [1.82, 1.84], 2.75: [2.1, 2.13],
  };
  return lines.map((line, i) => {
    const [ob, ol] = overByLine[line];
    return {
      marketId: `1.t-${i}`, sport: "football", marketType: "TOTALS", scope: "match_total", line, matchedVolume: 60000,
      runners: [
        { selection: "OVER", backOdds: ob, layOdds: ol, backDepth: 3000, layDepth: 2900 },
        { selection: "UNDER", backOdds: 1 / (1 - 1 / ((ob + ol) / 2)), layOdds: 1 / (1 - 1 / ((ob + ol) / 2)) + 0.02, backDepth: 3000, layDepth: 2900 },
      ],
    };
  });
}

const ctxFootball1x2: MarketContext = { sport: "football", market: "ML_1X2", tier: "T1", phase: "prematch", ttsBucket: "1-6h", line: null, selection: "HOME" };
const ctxTennis: MarketContext = { sport: "tennis", market: "ML_2WAY", tier: "T1", phase: "prematch", ttsBucket: "1-6h", line: null, selection: "HOME" };
const ctxTotals: MarketContext = { sport: "football", market: "ASIAN_TOTAL", tier: "T1", phase: "prematch", ttsBucket: "1-6h", line: 2.5, selection: "OVER" };

describe("normalizeMarket — devig + likviditet", () => {
  it("normaliserar midpoints till Σ fairProb = 1 över runners", () => {
    const n = normalizeMarket(liquidFootballMatchOdds());
    const sum = [...n.perSelection.values()].reduce((a, e) => a + (e.fairProb ?? 0), 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(n.marketPass).toBe(true);
    expect(n.marketLiquidityFactor).toBeGreaterThan(0);
  });
  it("snapshot innehåller back/lay/depth/spread per runner", () => {
    const n = normalizeMarket(liquidFootballMatchOdds());
    expect(n.snapshot.runners).toHaveLength(3);
    expect(n.snapshot.runners[0]).toHaveProperty("backOdds");
    expect(n.snapshot.runners[0]).toHaveProperty("spreadPct");
    expect(n.snapshot.runners[0]).toHaveProperty("liquidityFactor");
  });
});

describe("liquid Betfair → primary (tennis ML, ingen Pinnacle)", () => {
  it("blir BETFAIR_LIQUID_PRIMARY", () => {
    const bf = betfairMoneylineQuote(liquidTennisMatchWinner(), "HOME");
    expect(bf.quote.liquidityFactor).toBeGreaterThan(0.8);
    const out = evaluateMarket({ context: ctxTennis, candidate: { bookmaker: "bet365", odds: 2.1 }, sources: [bf.quote] });
    expect(out.consensus.scenario).toBe("BETFAIR_LIQUID_PRIMARY");
    expect(out.consensus.sourceRoles.betfair).toBe("primary");
  });
});

describe("illiquid Betfair → ignore", () => {
  it("låg matchad volym → liquidityFactor 0 → role ignore", () => {
    const bf = betfairMoneylineQuote(illiquidFootballMatchOdds(), "HOME");
    expect(bf.quote.liquidityFactor).toBe(0);
    expect(bf.quote.lineComparable).toBe(false);
    const out = evaluateMarket({ context: ctxFootball1x2, candidate: { bookmaker: "unibet", odds: 2.1 }, sources: [{ sourceId: "pinnacle", fairProb: 0.48 }, bf.quote] });
    expect(out.consensus.sourceRoles.betfair).toBe("ignore");
    expect(out.consensus.scenario).toBe("PINNACLE_ANCHOR");
  });
});

describe("hög back/lay-spread → ignore", () => {
  it("wide spread på en runner → marknaden underkänns", () => {
    const bf = betfairMoneylineQuote(wideSpreadFootballMatchOdds(), "HOME");
    expect(bf.quote.liquidityFactor).toBe(0);
    const out = evaluateMarket({ context: ctxFootball1x2, candidate: { bookmaker: "unibet", odds: 2.1 }, sources: [{ sourceId: "pinnacle", fairProb: 0.48 }, bf.quote] });
    expect(out.consensus.sourceRoles.betfair).toBe("ignore");
  });
});

describe("Betfair totals — line matching", () => {
  it("exact line match (2.5) → används", () => {
    const bf = betfairTotalsQuote({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, totalsMarkets([2.0, 2.5, 3.0]));
    expect(bf.lineMatch?.lineMatchType).toBe("exact");
    expect(bf.quote.lineComparable).toBe(true);
    expect(bf.quote.lineMatchConfidence).toBe(1);
    expect(bf.quote.liquidityFactor).toBeGreaterThan(0);
  });

  it("rejected line match (bara 1.5 och 3.5) → ignoreras i consensus", () => {
    const bf = betfairTotalsQuote({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, totalsMarkets([1.5, 3.5]));
    expect(bf.lineMatch?.lineMatchType).toBe("rejected");
    expect(bf.quote.lineComparable).toBe(false);
    const out = evaluateMarket({ context: ctxTotals, candidate: { bookmaker: "comeon", odds: 2.05 }, sources: [{ sourceId: "sbobet", fairProb: 0.5 }, { sourceId: "ibc", fairProb: 0.5 }, bf.quote] });
    expect(out.consensus.sourceRoles.betfair).toBe("ignore");
  });
});

describe("Betfair vs Pinnacle", () => {
  it("håller med Pinnacle → confirmation", () => {
    const bf = betfairMoneylineQuote(liquidFootballMatchOdds(), "HOME");
    const out = evaluateMarket({ context: ctxFootball1x2, candidate: { bookmaker: "unibet", odds: 2.1 }, sources: [{ sourceId: "pinnacle", fairProb: bf.quote.fairProb }, bf.quote] });
    expect(out.consensus.scenario).toBe("PINNACLE_ANCHOR");
    expect(out.consensus.sourceRoles.betfair).toBe("confirmation");
    expect(out.consensus.disagreementFlags).toHaveLength(0);
  });

  it("motsäger Pinnacle kraftigt → disagreement → NO_BET", () => {
    const bf = betfairMoneylineQuote(liquidFootballMatchOdds(), "HOME"); // HOME fairProb ~0.48
    const out = evaluateMarket({ context: ctxFootball1x2, candidate: { bookmaker: "unibet", odds: 2.1 }, sources: [{ sourceId: "pinnacle", fairProb: 0.75 }, bf.quote] });
    expect(out.consensus.disagreementFlags.length).toBeGreaterThan(0);
    expect(out.decision.decision).toBe("NO_BET");
    expect(out.decision.reasonCodes).toContain("SHARP_DISAGREEMENT");
  });
});

describe("CLV-logg innehåller liquidityFactor + order book snapshot", () => {
  it("betfair source snapshot bär order book via sourceMeta", () => {
    const bf = betfairMoneylineQuote(liquidFootballMatchOdds(), "HOME");
    const out = evaluateMarket({ context: ctxFootball1x2, candidate: { bookmaker: "unibet", odds: 2.1 }, sources: [{ sourceId: "pinnacle", fairProb: bf.quote.fairProb }, bf.quote] });
    const entry = buildClvEntry(out, { sourceMeta: { betfair: bf.snapshot } });
    const snap = entry.sourceSnapshot.find((s) => s.sourceId === "betfair");
    expect(snap).toBeDefined();
    const meta = snap!.meta as typeof bf.snapshot;
    expect(meta.liquidityFactor).toBeGreaterThan(0);
    expect(meta.runners).toHaveLength(3);
    expect(meta.matchedVolume).toBe(250000);
  });
});
