/**
 * Tester för CLV-kalibrering: per-källa-skicklighet mot stängningslinjen →
 * clvMultipliers (mätt trust i stället för gissat).
 */

import { describe, it, expect } from "vitest";
import { computeSourceSkill, deriveClvMultipliers } from "./clvCalibration.ts";
import type { MergedClvRecord, SourceSnapshot } from "./clvLogger.ts";

function rec(closing: number, sources: Array<{ id: string; p: number }>, clvPct = 1): MergedClvRecord {
  const sourceSnapshot: SourceSnapshot[] = sources.map((s) => ({
    sourceId: s.id, role: "independent_sharp", fairProb: s.p, weight: 1, isPinnacle: s.id === "pinnacle", isExchange: s.id === "betfair",
  }));
  return {
    type: "open", decisionId: Math.random().toString(36), ts: "", eventId: "e", sport: "football", league: null,
    marketType: "ML_1X2", tier: "T1", phase: "prematch", ttsBucket: "1-6h", startTime: null, line: null,
    selection: "HOME", scenario: "PINNACLE_ANCHOR", candidateBook: "x", candidateOdds: 2, fairPrice: 2, fairProb: 0.5,
    benchmarkSource: "pinnacle", benchmarkConfidence: 0.8, decision: "NO_BET", reasonCodes: [], shadowMode: true, executed: false,
    sourceSnapshot,
    closingFairProb: closing, closingSource: "pinnacle", clvPct, won: null, settledAt: "x", settled: true,
  } as unknown as MergedClvRecord;
}

describe("computeSourceSkill", () => {
  it("mäter RMSE mot closing per källa", () => {
    // pinnacle träffar closing exakt (rmse 0), noisy ligger 0.1 fel.
    const records = [
      rec(0.5, [{ id: "pinnacle", p: 0.5 }, { id: "noisy", p: 0.6 }]),
      rec(0.4, [{ id: "pinnacle", p: 0.4 }, { id: "noisy", p: 0.5 }]),
    ];
    const skill = computeSourceSkill(records);
    expect(skill.pinnacle.samples).toBe(2);
    expect(skill.pinnacle.rmse).toBeCloseTo(0, 6);
    expect(skill.noisy.rmse).toBeCloseTo(0.1, 6);
  });

  it("hoppar över osettlade / saknad closing / saknad källprob", () => {
    const r = rec(0.5, [{ id: "pinnacle", p: 0.5 }]);
    (r as { settled: boolean }).settled = false;
    expect(Object.keys(computeSourceSkill([r]))).toHaveLength(0);
  });
});

describe("deriveClvMultipliers", () => {
  it("bättre predikt (lägre RMSE) → högre multiplikator, clampat", () => {
    // 50 beslut: sharp träffar closing, weak ligger 0.12 fel.
    const records: MergedClvRecord[] = [];
    for (let i = 0; i < 50; i++) {
      const close = 0.45 + (i % 5) * 0.02;
      const jitter = (i % 2 ? 1 : -1) * 0.02; // sharp: litet fel (~0.02 rmse)
      records.push(rec(close, [{ id: "sharp", p: close + jitter }, { id: "weak", p: close + 0.12 }]));
    }
    const res = deriveClvMultipliers(records, { minSamples: 40 });
    expect(res.qualifiedSources).toBe(2);
    expect(res.multipliers.sharp).toBeGreaterThan(res.multipliers.weak);
    expect(res.multipliers.sharp).toBeLessThanOrEqual(1.3); // clampad
    expect(res.multipliers.weak).toBeGreaterThanOrEqual(0.7);
  });

  it("för få samples → multiplikator 1.0 (ingen justering)", () => {
    const records = [rec(0.5, [{ id: "x", p: 0.7 }])];
    const res = deriveClvMultipliers(records, { minSamples: 40 });
    expect(res.multipliers.x).toBe(1.0);
    expect(res.baselineRmse).toBeNull();
  });
});
