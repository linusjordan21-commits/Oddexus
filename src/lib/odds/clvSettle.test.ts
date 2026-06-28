/**
 * Tester för CLV-settle-steget: exakt match, skip-fall, ingen dubbel-settle,
 * korrekt CLV, och att report/trustFeedback kan köras efter settlement.
 */

import { describe, it, expect } from "vitest";
import { buildClosingIndex, planSettlements } from "./clvSettle.ts";
import { mergeClvLines, type ClvLine, type ClvOpenEntry } from "./clvLogger.ts";
import { buildClvReport } from "./clvAnalysis.ts";
import { recommendTrustChanges } from "./trustFeedback.ts";
import type { PinnacleEvent } from "./shadowConsensus.ts";

const START_PAST = "2026-06-20T21:00:00.000Z";
const NOW = Date.parse(START_PAST) + 3 * 3_600_000; // 3h efter avspark

function pinEvent(eventId: string, startTime: string, fair: { HOME: number; DRAW: number; AWAY: number }): PinnacleEvent {
  return {
    identity: { eventId, sport: "football", league: "La Liga", homeTeam: "A", awayTeam: "B", startTime },
    decimal: { HOME: 1 / fair.HOME, DRAW: 1 / fair.DRAW, AWAY: 1 / fair.AWAY },
    fairProb: fair,
    limit: 5000,
  };
}

function openEntry(over: Partial<ClvOpenEntry>): ClvOpenEntry {
  return {
    type: "open", decisionId: "d1", ts: START_PAST, eventId: "1001", sport: "football", league: "La Liga",
    marketType: "ML_1X2", tier: "T1", phase: "prematch", ttsBucket: "1-6h", line: null, selection: "HOME",
    scenario: "PINNACLE_ANCHOR", candidateBook: "comeon", candidateOdds: 2.0, fairPrice: 1.96, fairProb: 0.51,
    benchmarkSource: "pinnacle", benchmarkConfidence: 0.9, requiredEdge: 1.8, calculatedEdge: 3.0,
    decision: "AUTO_BET", executed: false, shadowMode: true, reasonCodes: ["PINNACLE_PRIMARY"], sourceSnapshot: [],
    ...over,
  };
}

const closing = buildClosingIndex([pinEvent("1001", START_PAST, { HOME: 0.5, DRAW: 0.3, AWAY: 0.2 })]);

describe("planSettlements — settle exact match", () => {
  it("settlar och räknar CLV korrekt", () => {
    const merged = mergeClvLines([openEntry({ candidateOdds: 2.2, selection: "HOME" })]);
    const plan = planSettlements(merged, closing, NOW);
    expect(plan.settlements).toHaveLength(1);
    // CLV = 2.2 × 0.5 − 1 = 0.10 → 10 %
    expect(plan.settlements[0].clvPct).toBeCloseTo(10, 6);
    expect(plan.settlements[0].closingSource).toBe("pinnacle");
    expect(plan.stats.avgClvPct).toBeCloseTo(10, 6);
  });
});

describe("planSettlements — skip-fall", () => {
  it("skip om closing saknas (okänt eventId)", () => {
    const merged = mergeClvLines([openEntry({ eventId: "9999" })]);
    const plan = planSettlements(merged, closing, NOW);
    expect(plan.settlements).toHaveLength(0);
    expect(plan.stats.bySkipReason.CLOSING_NOT_AVAILABLE).toBe(1);
  });

  it("skip om matchen inte är stängd (startTime i framtiden)", () => {
    const future = "2099-01-01T00:00:00.000Z";
    const closeFuture = buildClosingIndex([pinEvent("1001", future, { HOME: 0.5, DRAW: 0.3, AWAY: 0.2 })]);
    const merged = mergeClvLines([openEntry({})]);
    const plan = planSettlements(merged, closeFuture, NOW);
    expect(plan.stats.bySkipReason.MATCH_NOT_CLOSED).toBe(1);
  });

  it("skip om selection inte finns i closing", () => {
    // closing saknar t.ex. en selection → vi simulerar via NaN
    const broken = buildClosingIndex([pinEvent("1001", START_PAST, { HOME: NaN, DRAW: 0.3, AWAY: 0.2 })]);
    const merged = mergeClvLines([openEntry({ selection: "HOME" })]);
    const plan = planSettlements(merged, broken, NOW);
    expect(plan.stats.bySkipReason.SELECTION_NOT_IN_CLOSING).toBe(1);
  });

  it("skip om eventId saknas", () => {
    const merged = mergeClvLines([openEntry({ eventId: null as unknown as string })]);
    const plan = planSettlements(merged, closing, NOW);
    expect(plan.stats.bySkipReason.NO_EVENT_ID).toBe(1);
  });

  it("skip ej-stödd marknad (ej ML_1X2 i v1)", () => {
    const merged = mergeClvLines([openEntry({ marketType: "ASIAN_TOTAL", selection: "OVER" })]);
    const plan = planSettlements(merged, closing, NOW);
    expect(plan.stats.bySkipReason.UNSUPPORTED_MARKET).toBe(1);
  });
});

describe("planSettlements — ingen dubbel-settle", () => {
  it("redan settlade hoppar över (ALREADY_SETTLED)", () => {
    const open = openEntry({ decisionId: "dX", candidateOdds: 2.0 });
    // första körningen
    const plan1 = planSettlements(mergeClvLines([open]), closing, NOW);
    expect(plan1.settlements).toHaveLength(1);
    // applicera settlement → merge inkluderar den → andra körningen ska skippa
    const lines: ClvLine[] = [open, plan1.settlements[0]];
    const plan2 = planSettlements(mergeClvLines(lines), closing, NOW);
    expect(plan2.settlements).toHaveLength(0);
    expect(plan2.stats.bySkipReason.ALREADY_SETTLED).toBe(1);
  });
});

describe("efter settlement: report + trustFeedback körbara", () => {
  it("buildClvReport och recommendTrustChanges fungerar på settlad data", () => {
    const open = openEntry({ decisionId: "dR", candidateOdds: 2.2, selection: "HOME" });
    const plan = planSettlements(mergeClvLines([open]), closing, NOW);
    const after = mergeClvLines([open, plan.settlements[0]]);
    const report = buildClvReport(after);
    expect(report.settledDecisions).toBe(1);
    expect(report.bySource.pinnacle.avgClvPct).toBeCloseTo(10, 6);
    const recs = recommendTrustChanges(report.perSource);
    expect(Array.isArray(recs)).toBe(true);
    // för få samples → INSUFFICIENT_DATA, men ska ej krascha
    expect(recs.every((r) => typeof r.recommendation === "string")).toBe(true);
  });
});
