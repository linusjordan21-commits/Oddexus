/**
 * Mock-data-tester för sharp-consensus-mellanlagret. Täcker de fem fall
 * användaren bad om + verifierar att loggen innehåller alla obligatoriska
 * fält. Inga nätverksanrop — allt är deterministisk mockdata.
 */

import { describe, it, expect } from "vitest";
import {
  buildConsensus,
  devigThreeWay,
  devigTwoWay,
  evaluateMarket,
  type MarketContext,
} from "./consensus.ts";
import { evaluateBetfairLiquidity } from "./betfairLiquidityFilter.ts";
import { evaluateProp, type PropRule } from "./propEngine.ts";

const baseCtx = {
  tier: "T1" as const,
  phase: "prematch" as const,
  ttsBucket: "1-6h" as const,
};

describe("Exempel 1 — Fotboll AH, Pinnacle finns → AUTO_BET", () => {
  const ctx: MarketContext = {
    ...baseCtx,
    sport: "football",
    market: "AH",
    line: -0.5,
    selection: "HOME",
    homeTeam: "Real Madrid",
    awayTeam: "Sevilla",
  };
  const sources = [
    { sourceId: "pinnacle", fairProb: devigTwoWay(1.9, 2.0) },
    { sourceId: "sbobet", fairProb: devigTwoWay(1.91, 1.99) },
    { sourceId: "ibc", fairProb: devigTwoWay(1.92, 1.98) },
  ];

  it("ankrar på Pinnacle och auto-bettar vid tydlig edge", () => {
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "unibet", odds: 2.02 }, sources, shadowMode: false });
    expect(out.consensus.scenario).toBe("PINNACLE_ANCHOR");
    expect(out.consensus.benchmarkConfidence).toBeGreaterThan(0.8);
    expect(out.consensus.disagreementFlags).toHaveLength(0);
    expect(out.decision.decision).toBe("AUTO_BET");
    expect(out.decision.executed).toBe(true);
    expect(out.decision.calculatedEdgePct!).toBeGreaterThan(out.decision.requiredEdgePct!);
  });

  it("loggar alla obligatoriska fält", () => {
    const { log } = evaluateMarket({ context: ctx, candidate: { bookmaker: "unibet", odds: 2.02 }, sources });
    for (const key of ["fairPrice", "benchmarkSource", "benchmarkConfidence", "sourcesUsed", "sourceRoles", "disagreementFlags", "requiredEdge", "calculatedEdge", "decision", "reasonCodes"]) {
      expect(log).toHaveProperty(key);
    }
    expect(log.shadowMode).toBe(true); // default
    expect(log.executed).toBe(false); // shadow → aldrig exekvering
    expect(log.sourceRoles.pinnacle).toBe("primary");
  });
});

describe("Exempel 2 — Fotboll Asian total, Pinnacle SAKNAS, SBO/IBC/Singbet → NO_BET (säker)", () => {
  const ctx: MarketContext = { ...baseCtx, sport: "football", market: "ASIAN_TOTAL", line: 2.5, selection: "OVER" };
  const sources = [
    { sourceId: "sbobet", fairProb: devigTwoWay(1.95, 1.95) },
    { sourceId: "ibc", fairProb: devigTwoWay(1.93, 1.97) },
    { sourceId: "singbet", fairProb: devigTwoWay(1.96, 1.94) },
  ];

  it("ger consensus-scenario men stoppas av höjt edge-krav utan Pinnacle", () => {
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "comeon", odds: 2.05 }, sources });
    expect(out.consensus.scenario).toBe("SHARP_CONSENSUS_NO_PINNACLE");
    // 3 korrelerade asiatiska books → < 2 oberoende röster.
    expect(out.consensus.nEff).toBeLessThan(2);
    expect(out.consensus.nEff).toBeCloseTo(1.6, 1);
    expect(out.decision.decision).toBe("NO_BET");
    expect(out.decision.reasonCodes).toContain("BELOW_REQUIRED_EDGE");
  });
});

describe("Exempel 3 — Tennis, Betfair likvid → AUTO_BET", () => {
  const ctx: MarketContext = { ...baseCtx, ttsBucket: "<1h", sport: "tennis", market: "ML_2WAY", line: null, selection: "HOME" };
  const liq = evaluateBetfairLiquidity(
    { backOdds: 1.83, layOdds: 1.85, backDepth: 1500, layDepth: 1400, matchedVolume: 60000 },
    "tennis",
  );
  const sources = [
    { sourceId: "betfair", fairProb: liq.midpointProb!, isExchange: true, liquidityFactor: liq.liquidityFactor },
    { sourceId: "sbobet", fairProb: devigTwoWay(1.8, 2.05) },
  ];

  it("godkänner likviditeten och låter Betfair vara primary", () => {
    expect(liq.pass).toBe(true);
    expect(liq.liquidityFactor).toBeGreaterThan(0.8);
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "bet365", odds: 1.95 }, sources, shadowMode: false });
    expect(out.consensus.scenario).toBe("BETFAIR_LIQUID_PRIMARY");
    expect(out.consensus.nEff).toBeCloseTo(2.0, 1);
    expect(out.decision.decision).toBe("AUTO_BET");
  });

  it("illikvid Betfair degraderas (pass=false → ingen primary)", () => {
    const bad = evaluateBetfairLiquidity(
      { backOdds: 1.7, layOdds: 2.0, backDepth: 50, layDepth: 40, matchedVolume: 500 },
      "tennis",
    );
    expect(bad.pass).toBe(false);
    expect(bad.liquidityFactor).toBe(0);
  });
});

describe("Exempel 4 — Basket total, källor oense → NO_BET (disagreement)", () => {
  const ctx: MarketContext = { ...baseCtx, sport: "basketball", market: "TOTAL", line: 215.5, selection: "OVER" };
  const sources = [
    { sourceId: "pinnacle", fairProb: devigTwoWay(1.95, 1.95) }, // 0.50
    { sourceId: "sbobet", fairProb: devigTwoWay(1.5, 2.6) }, // ~0.634 — kraftigt avvikande
  ];

  it("flaggar disagreement och blockar oavsett edge", () => {
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "betsson", odds: 2.1 }, sources });
    expect(out.consensus.disagreementFlags.length).toBeGreaterThan(0);
    expect(out.decision.decision).toBe("NO_BET");
    expect(out.decision.reasonCodes).toContain("SHARP_DISAGREEMENT");
  });
});

describe("Exempel 5 — Gold boost / player prop: Isak över 0.5 skott på mål", () => {
  const rule: PropRule = {
    statType: "shots_on_target",
    line: 0.5,
    side: "OVER",
    starterRequired: true,
    includesOT: false,
    voidIfNotStart: true,
    periodScope: "full",
    betBuilder: false,
  };
  const softBooks = [
    { bookmaker: "leovegas", odds: 1.4, rule },
    { bookmaker: "comeon", odds: 1.44, rule },
    { bookmaker: "betsson", odds: 1.45, rule },
    { bookmaker: "nordicbet", odds: 1.46, rule },
    { bookmaker: "888", odds: 1.48, rule },
    { bookmaker: "outlier", odds: 1.8, rule }, // ska gallras som outlier
  ];

  it("boostad prop → NEEDS_VALIDATION, aldrig auto, outlier borttagen", () => {
    const log = evaluateProp({
      candidate: { bookmaker: "unibet", odds: 2.25, rule, isBoosted: true },
      softBooks,
    });
    expect(log.scenario).toBe("SOFT_CONSENSUS_PROP");
    expect(log.decision).toBe("NEEDS_VALIDATION");
    expect(log.executed).toBe(false);
    expect(log.outliersRemoved).toContain("outlier");
    expect(log.booksUsed.length).toBe(5);
    expect(log.reasonCodes).toContain("PROP_BOOSTED_NEEDS_VALIDATION");
    // soft consensus ≈ 1/0.69 ≈ 1.45, INTE boosten 2.25
    expect(log.fairPrice!).toBeGreaterThan(1.4);
    expect(log.fairPrice!).toBeLessThan(1.5);
  });

  it("regelkrock (skott ≠ skott på mål) + för få böcker → NO_BET", () => {
    const mismatchRule: PropRule = { ...rule, statType: "shots" };
    const log = evaluateProp({
      candidate: { bookmaker: "unibet", odds: 2.25, rule, isBoosted: false },
      softBooks: [{ bookmaker: "bet365", odds: 1.6, rule: mismatchRule }],
    });
    expect(log.decision).toBe("NO_BET");
    expect(log.reasonCodes).toContain("PROP_INSUFFICIENT_BOOKS");
  });
});

describe("devig-hjälpare", () => {
  it("2-vägs devig summerar till 1 över båda sidor", () => {
    const a = devigTwoWay(1.9, 2.0);
    const b = devigTwoWay(2.0, 1.9);
    expect(a + b).toBeCloseTo(1, 6);
  });
  it("3-vägs devig summerar till 1 över H/D/A", () => {
    const h = devigThreeWay(2.1, 3.5, 3.4, "HOME");
    const d = devigThreeWay(2.1, 3.5, 3.4, "DRAW");
    const a = devigThreeWay(2.1, 3.5, 3.4, "AWAY");
    expect(h + d + a).toBeCloseTo(1, 6);
  });
});

describe("buildConsensus är rent steg 1 (rör ej candidate)", () => {
  it("samma fairProb oavsett candidate-odds", () => {
    const ctx: MarketContext = { ...baseCtx, sport: "football", market: "AH", line: -0.5, selection: "HOME" };
    const sources = [
      { sourceId: "pinnacle", fairProb: devigTwoWay(1.9, 2.0) },
      { sourceId: "sbobet", fairProb: devigTwoWay(1.91, 1.99) },
    ];
    const c1 = buildConsensus(ctx, sources);
    const c2 = buildConsensus(ctx, sources);
    expect(c1.fairProb).toBe(c2.fairProb);
  });
});
