/**
 * Tester för sharp-blend (Pinnacle-dominant inblandning av SBOBET/Betfair i
 * valuebets-fair-price, med hård färskhetsgrind).
 */

import { describe, it, expect } from "vitest";
import { buildSharpIndex, blendNativeFair, pinnacleLiquidityFactor, sbobetMarginFactor, DEFAULT_SHARP_WEIGHTS, type SharpIndex } from "./sharpBlend.ts";
import type { SbobetMarket } from "./sbobetScrapeParse.ts";

const START = "2026-06-20T21:00:00.000Z";
const START_MS = Date.parse(START);

function freshIso(secAgo: number): string {
  return new Date(Date.now() - secAgo * 1000).toISOString();
}

const sbobetJson = (updatedAt: string) => ({
  updatedAt,
  events: {
    E1: {
      sbobetEventId: "E1", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, competition: "La Liga",
      markets: [{ oddsId: "1", marketType: "ML_1X2", scope: "full", runners: [
        { selection: "HOME", decimalOdds: 1.8 }, { selection: "DRAW", decimalOdds: 3.7 }, { selection: "AWAY", decimalOdds: 4.5 },
      ] }],
    },
  },
});

const betfairJson = (updatedAt: string) => ({
  updatedAt,
  events: {
    B1: {
      betfairEventId: "B1", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, competition: null,
      markets: [{ marketId: "1.9", sport: "football", marketType: "MATCH_ODDS", scope: "full", matchedVolume: 250000, runners: [
        { selection: "HOME", backOdds: 1.82, layOdds: 1.84, backDepth: 6000, layDepth: 5800 },
        { selection: "DRAW", backOdds: 3.7, layOdds: 3.75, backDepth: 3000, layDepth: 2900 },
        { selection: "AWAY", backOdds: 4.4, layOdds: 4.5, backDepth: 2500, layDepth: 2400 },
      ] }],
    },
  },
});

const pinFair = { HOME: 0.5, DRAW: 0.27, AWAY: 0.23 }; // summerar till 1

describe("buildSharpIndex — färskhetsgrind", () => {
  it("släpper färska källor, exkluderar stale", () => {
    const idx = buildSharpIndex({
      sbobetJson: sbobetJson(freshIso(30)), sbobetUpdatedAt: freshIso(30),
      betfairJson: betfairJson(freshIso(600)), betfairUpdatedAt: freshIso(600), // 10 min = stale
      freshnessMs: 3 * 60_000,
    });
    expect(idx.sbobetFresh).toBe(true);
    expect(idx.sbobet).not.toBeNull();
    expect(idx.betfairFresh).toBe(false);
    expect(idx.betfair).toBeNull(); // stale → ej parsad → kan ej blandas in
  });

  it("saknad updatedAt → ej färsk", () => {
    const idx = buildSharpIndex({ sbobetJson: {}, sbobetUpdatedAt: null, betfairJson: {}, betfairUpdatedAt: undefined, freshnessMs: 60_000 });
    expect(idx.sbobetFresh).toBe(false);
    expect(idx.betfair).toBeNull();
  });
});

describe("blendNativeFair", () => {
  it("inga sharps → Pinnacle oförändrad", () => {
    const idx: SharpIndex = { sbobet: null, betfair: null, sbobetFresh: false, betfairFresh: false, ageSec: { sbobet: null, betfair: null }, clvMultipliers: {} };
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.sources).toEqual([]);
    expect(r.blended).toEqual(pinFair);
  });

  it("färsk SBOBET + Betfair → blandas in, Pinnacle dominerar, summa = 1", () => {
    const idx = buildSharpIndex({
      sbobetJson: sbobetJson(freshIso(20)), sbobetUpdatedAt: freshIso(20),
      betfairJson: betfairJson(freshIso(20)), betfairUpdatedAt: freshIso(20),
      freshnessMs: 3 * 60_000,
    });
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.sources.sort()).toEqual(["betfair", "sbobet"]);
    const sum = r.blended.HOME + r.blended.DRAW + r.blended.AWAY;
    expect(sum).toBeCloseTo(1, 6);
    // Pinnacle (vikt 2.5) dominerar: blended HOME ska ligga nära pinnacle 0.5,
    // bara lätt nudgad mot sharparnas något högre HOME-prob.
    expect(r.blended.HOME).toBeGreaterThan(0.49);
    expect(r.blended.HOME).toBeLessThan(0.56);
  });

  it("order-oberoende: Pinnacle-lag i omvänd ordning mot sharparna matchar ändå", () => {
    // Pinnacle listar Sevilla (home) v Real Madrid (away); sharparna har omvänt.
    const pinReversed = { HOME: 0.23, DRAW: 0.27, AWAY: 0.5 };
    const idx = buildSharpIndex({
      sbobetJson: sbobetJson(freshIso(20)), sbobetUpdatedAt: freshIso(20),
      betfairJson: betfairJson(freshIso(20)), betfairUpdatedAt: freshIso(20),
      freshnessMs: 3 * 60_000,
    });
    const r = blendNativeFair(pinReversed, "Sevilla", "Real Madrid", START_MS, idx);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.blended.HOME + r.blended.DRAW + r.blended.AWAY).toBeCloseTo(1, 6);
    // Sevilla är underdog (0.23) — blended HOME ska förbli liten (sharparna håller med).
    expect(r.blended.HOME).toBeLessThan(0.3);
  });

  it("Pinnacle-likviditet (limit): låg limit → sharps väger relativt tyngre", () => {
    const idx = buildSharpIndex({
      sbobetJson: sbobetJson(freshIso(20)), sbobetUpdatedAt: freshIso(20),
      betfairJson: betfairJson(freshIso(20)), betfairUpdatedAt: freshIso(20),
      freshnessMs: 3 * 60_000,
    });
    // Sharparna har högre HOME-prob än Pinnacle (0.5). Med LÅG Pinnacle-limit ska
    // blended HOME dras längre mot sharparna än med HÖG limit.
    const highLimit = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx, DEFAULT_SHARP_WEIGHTS, 5000);
    const lowLimit = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx, DEFAULT_SHARP_WEIGHTS, 80);
    expect(lowLimit.sources.length).toBeGreaterThan(0);
    expect(lowLimit.blended.HOME).toBeGreaterThan(highLimit.blended.HOME); // mer nudge vid låg limit
    expect(lowLimit.blended.HOME + lowLimit.blended.DRAW + lowLimit.blended.AWAY).toBeCloseTo(1, 6);
  });

  it("fas 2: betfairLiquidity surfas (matchedVolume + liquidityFactor + spreadPct)", () => {
    const idx = buildSharpIndex({
      sbobetJson: {}, sbobetUpdatedAt: null, // bara Betfair färsk
      betfairJson: betfairJson(freshIso(20)), betfairUpdatedAt: freshIso(20),
      freshnessMs: 3 * 60_000,
    });
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.sources).toEqual(["betfair"]);
    expect(r.betfairLiquidity).toBeTruthy();
    expect(r.betfairLiquidity!.matchedVolume).toBe(250000);
    expect(r.betfairLiquidity!.liquidityFactor).toBeGreaterThan(0);
    expect(r.betfairLiquidity!.spreadPct).not.toBeNull();
    expect(r.betfairLiquidity!.spreadPct!).toBeGreaterThan(0);
  });

  it("§2: betfairBook surfar rå back/lay/mid per utfall (Pinnacle-native)", () => {
    const idx = buildSharpIndex({
      sbobetJson: {}, sbobetUpdatedAt: null,
      betfairJson: betfairJson(freshIso(20)), betfairUpdatedAt: freshIso(20),
      freshnessMs: 3 * 60_000,
    });
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.betfairBook).toBeTruthy();
    expect(r.betfairBook!.HOME!.back).toBe(1.82); // bästa back ur orderboken
    expect(r.betfairBook!.HOME!.lay).toBe(1.84); // bästa lay
    expect(typeof r.betfairBook!.HOME!.mid).toBe("number"); // mid-odds = 1/midpointProb
    expect(r.betfairBook!.HOME!.mid!).toBeGreaterThan(1);
  });

  it("fas 2: ingen betfair-match → betfairLiquidity null (likviditet bara när källan finns)", () => {
    const idx: SharpIndex = { sbobet: null, betfair: null, sbobetFresh: false, betfairFresh: false, ageSec: { sbobet: null, betfair: null }, clvMultipliers: {} };
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.betfairLiquidity ?? null).toBeNull();
  });

  it("sharp prices: perSource exponerar varje källas individuella triple (summerar ~1)", () => {
    const idx = buildSharpIndex({
      sbobetJson: sbobetJson(freshIso(20)), sbobetUpdatedAt: freshIso(20),
      betfairJson: betfairJson(freshIso(20)), betfairUpdatedAt: freshIso(20),
      freshnessMs: 3 * 60_000,
    });
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.perSource).toBeTruthy();
    expect(r.perSource!.pinnacle).toEqual(pinFair);
    expect(r.perSource!.sbobet).toBeTruthy();
    expect(r.perSource!.betfair).toBeTruthy();
    const sumBf = r.perSource!.betfair!.HOME + r.perSource!.betfair!.DRAW + r.perSource!.betfair!.AWAY;
    expect(sumBf).toBeCloseTo(1, 6);
  });

  it("sharp prices: perSource.pinnacle finns även utan matchade sharps", () => {
    const idx: SharpIndex = { sbobet: null, betfair: null, sbobetFresh: false, betfairFresh: false, ageSec: { sbobet: null, betfair: null }, clvMultipliers: {} };
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.perSource?.pinnacle).toEqual(pinFair);
    expect(r.perSource?.sbobet).toBeUndefined();
  });

  it("sbobetMarginFactor: smal marginal → 1.0, vid marginal → nedvägd", () => {
    const mk = (h: number, d: number, a: number): SbobetMarket => ({
      oddsId: "x", marketType: "ML_1X2", scope: "full",
      runners: [{ selection: "HOME", decimalOdds: h }, { selection: "DRAW", decimalOdds: d }, { selection: "AWAY", decimalOdds: a }],
    });
    // Smal bok (~2-3% marginal) → full vikt.
    expect(sbobetMarginFactor(mk(2.05, 3.5, 3.85))).toBeGreaterThan(0.95);
    // Vid bok (~12% marginal) → klart nedvägd.
    expect(sbobetMarginFactor(mk(1.8, 3.0, 3.2))).toBeLessThan(0.8);
  });

  it("pinnacleLiquidityFactor: okänd → 1.0, låg → ~0.4, hög → 1.0", () => {
    expect(pinnacleLiquidityFactor(null)).toBe(1.0);
    expect(pinnacleLiquidityFactor(0)).toBe(1.0);
    expect(pinnacleLiquidityFactor(80)).toBeLessThan(0.5);
    expect(pinnacleLiquidityFactor(5000)).toBe(1.0);
  });

  it("stale sharp (exkluderad ur index) → ingen påverkan", () => {
    const idx = buildSharpIndex({
      sbobetJson: sbobetJson(freshIso(600)), sbobetUpdatedAt: freshIso(600),
      betfairJson: betfairJson(freshIso(600)), betfairUpdatedAt: freshIso(600),
      freshnessMs: 3 * 60_000,
    });
    const r = blendNativeFair(pinFair, "Real Madrid", "Sevilla", START_MS, idx);
    expect(r.sources).toEqual([]);
    expect(r.blended).toEqual(pinFair);
  });
});
