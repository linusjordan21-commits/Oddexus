/**
 * Tester för clvReport — dedupad omfattande CLV-rapport.
 */

import { describe, it, expect } from "vitest";
import {
  buildFullClvReport,
  edgeBucket,
  confidenceBucket,
  analyzeByReasonCode,
  formatReport,
} from "./clvReport.ts";
import type { MergedClvRecord } from "./clvLogger.ts";

const KICKOFF = "2026-06-20T21:00:00.000Z";
let seq = 0;

function rec(over: Partial<MergedClvRecord>): MergedClvRecord {
  seq += 1;
  return {
    type: "open", decisionId: `d${seq}`, ts: "2026-06-20T18:00:00.000Z",
    eventId: `e${seq}`, sport: "football", league: "La Liga", marketType: "ML_1X2", tier: "T1",
    phase: "prematch", ttsBucket: "1-6h", startTime: KICKOFF, line: null, selection: "HOME",
    scenario: "PINNACLE_ANCHOR", candidateBook: "comeon", candidateOdds: 2.0, fairPrice: 1.96, fairProb: 0.51,
    benchmarkSource: "pinnacle", benchmarkConfidence: 0.9, requiredEdge: 1.8, calculatedEdge: 3.0,
    decision: "AUTO_BET", executed: false, shadowMode: true, reasonCodes: ["PINNACLE_PRIMARY", "ABOVE_REQUIRED_EDGE"],
    sourceSnapshot: [{ sourceId: "pinnacle", role: "primary", fairProb: 0.51, weight: 1, isPinnacle: true, isExchange: false }],
    closingFairProb: null, closingSource: null, clvPct: null, won: null, settledAt: null, settled: false,
    ...over,
  };
}
function settled(over: Partial<MergedClvRecord>): MergedClvRecord {
  return rec({ settled: true, closingFairProb: 0.5, closingSource: "pinnacle", clvPct: 2.0, ...over });
}

describe("edge buckets", () => {
  it("klassificerar korrekt", () => {
    expect(edgeBucket(-1)).toBe("<0%");
    expect(edgeBucket(0.5)).toBe("0–1%");
    expect(edgeBucket(1.5)).toBe("1–2%");
    expect(edgeBucket(2.5)).toBe("2–3%");
    expect(edgeBucket(4)).toBe("3–5%");
    expect(edgeBucket(7)).toBe("5%+");
    expect(edgeBucket(null)).toBe("(okänd)");
  });
});

describe("confidence buckets", () => {
  it("klassificerar korrekt", () => {
    expect(confidenceBucket(0.4)).toBe("<0.50");
    expect(confidenceBucket(0.6)).toBe("0.50–0.65");
    expect(confidenceBucket(0.7)).toBe("0.65–0.80");
    expect(confidenceBucket(0.85)).toBe("0.80+");
  });
});

describe("buildFullClvReport — dedupe överallt", () => {
  it("30 near-dubbletter av samma bet-tillfälle → 1 sample i ALLA breakdowns", () => {
    seq = 0;
    const dupes = Array.from({ length: 30 }, (_, i) =>
      settled({ decisionId: `dup${i}`, eventId: "SAME", ts: new Date(Date.parse("2026-06-20T18:00:00.000Z") + i * 60000).toISOString() }),
    );
    const r = buildFullClvReport(dupes);
    expect(r.rawRows).toBe(30);
    expect(r.dedupedSamples).toBe(1);
    expect(r.deduped).toBe(true);
    // breakdown får INTE räkna råa dubbletter
    expect(r.byDecision.AUTO_BET.samples).toBe(1);
    expect(r.byScenario.PINNACLE_ANCHOR.samples).toBe(1);
    expect(r.bySource.pinnacle.samples).toBe(1);
    expect(r.byBookGroup.comeon.samples).toBe(1);
  });

  it("dedupe=false → rå analys räknar alla 30", () => {
    seq = 0;
    const dupes = Array.from({ length: 30 }, (_, i) => settled({ decisionId: `dup${i}`, eventId: "SAME" }));
    const r = buildFullClvReport(dupes, { dedupe: false });
    expect(r.dedupedSamples).toBe(30);
    expect(r.byDecision.AUTO_BET.samples).toBe(30);
  });
});

describe("buildFullClvReport — separerar decisions", () => {
  it("AUTO_BET och NO_BET hålls isär (NO_BET döljer inte AUTO_BET)", () => {
    seq = 0;
    const recs = [
      ...Array.from({ length: 5 }, () => settled({ decision: "AUTO_BET", clvPct: 4 })),
      ...Array.from({ length: 50 }, () => settled({ decision: "NO_BET", clvPct: -12 })),
      ...Array.from({ length: 3 }, () => settled({ decision: "MANUAL_REVIEW", clvPct: 1 })),
    ];
    const r = buildFullClvReport(recs);
    expect(r.byDecision.AUTO_BET.samples).toBe(5);
    expect(r.byDecision.AUTO_BET.avgClvPct).toBeCloseTo(4, 6);
    expect(r.byDecision.NO_BET.samples).toBe(50);
    expect(r.byDecision.NO_BET.avgClvPct).toBeCloseTo(-12, 6);
    // value-flaggade subset = AUTO_BET + MANUAL_REVIEW = 8, INTE NO_BET
    expect(r.valueFlagged.samples).toBe(8);
    expect(r.valueFlagged.byDecision.AUTO_BET.samples).toBe(5);
    expect(r.valueFlagged.byDecision.NO_BET).toBeUndefined();
  });
});

describe("buildFullClvReport — edge/confidence buckets", () => {
  it("grupperar value-flaggade per edge-bucket", () => {
    seq = 0;
    const recs = [
      settled({ decision: "AUTO_BET", calculatedEdge: 0.5, clvPct: -1 }),
      settled({ decision: "AUTO_BET", calculatedEdge: 2.5, clvPct: 1 }),
      settled({ decision: "AUTO_BET", calculatedEdge: 6, clvPct: 5 }),
    ];
    const r = buildFullClvReport(recs);
    expect(r.valueFlagged.byEdgeBucket["0–1%"].samples).toBe(1);
    expect(r.valueFlagged.byEdgeBucket["2–3%"].samples).toBe(1);
    expect(r.valueFlagged.byEdgeBucket["5%+"].samples).toBe(1);
    expect(r.valueFlagged.byEdgeBucket["5%+"].avgClvPct).toBeCloseTo(5, 6);
  });

  it("grupperar per confidence-bucket", () => {
    seq = 0;
    const recs = [
      settled({ benchmarkConfidence: 0.45 }),
      settled({ benchmarkConfidence: 0.6 }),
      settled({ benchmarkConfidence: 0.7 }),
      settled({ benchmarkConfidence: 0.9 }),
    ];
    const r = buildFullClvReport(recs);
    expect(r.byConfidenceBucket["<0.50"].samples).toBe(1);
    expect(r.byConfidenceBucket["0.50–0.65"].samples).toBe(1);
    expect(r.byConfidenceBucket["0.65–0.80"].samples).toBe(1);
    expect(r.byConfidenceBucket["0.80+"].samples).toBe(1);
  });
});

describe("buildFullClvReport — raw vs deduped + preliminär", () => {
  it("visar raw rows, deduped samples, settled, unsettled", () => {
    seq = 0;
    const recs = [
      settled({ eventId: "A" }),
      rec({ eventId: "B" }), // unsettled
    ];
    const r = buildFullClvReport(recs);
    expect(r.rawRows).toBe(2);
    expect(r.dedupedSamples).toBe(2);
    expect(r.settledSamples).toBe(1);
    expect(r.unsettledSamples).toBe(1);
    expect(r.preliminary).toBe(true); // < 30 settled
  });
});

describe("analyzeByReasonCode", () => {
  it("exploderar per reasonCode", () => {
    seq = 0;
    const recs = [
      settled({ reasonCodes: ["PINNACLE_PRIMARY", "ABOVE_REQUIRED_EDGE"] }),
      settled({ reasonCodes: ["PINNACLE_PRIMARY", "BELOW_REQUIRED_EDGE"] }),
    ];
    const by = analyzeByReasonCode(recs);
    expect(by["PINNACLE_PRIMARY"].samples).toBe(2);
    expect(by["ABOVE_REQUIRED_EDGE"].samples).toBe(1);
    expect(by["BELOW_REQUIRED_EDGE"].samples).toBe(1);
  });
});

describe("formatReport", () => {
  it("renderar utan att krascha + nämner baslinje-noten", () => {
    seq = 0;
    const r = buildFullClvReport([settled({}), settled({ decision: "NO_BET", clvPct: -12 })]);
    const text = formatReport(r);
    expect(text).toContain("CLV-RAPPORT (dedupad)");
    expect(text).toContain("BASLINJE-NOT");
    expect(text).toContain("VALUE-FLAGGADE");
  });
});
