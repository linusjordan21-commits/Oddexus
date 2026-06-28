/**
 * Tester för analysis-layer dedupe av CLV-beslut.
 */

import { describe, it, expect } from "vitest";
import { dedupeForAnalysis, dedupeKey } from "./clvDedupe.ts";
import { buildClvReport } from "./clvAnalysis.ts";
import { recommendTrustChanges } from "./trustFeedback.ts";
import type { MergedClvRecord } from "./clvLogger.ts";

const KICKOFF = "2026-06-20T21:00:00.000Z";

function rec(over: Partial<MergedClvRecord>): MergedClvRecord {
  return {
    type: "open", decisionId: Math.random().toString(36).slice(2), ts: "2026-06-20T18:00:00.000Z",
    eventId: "1001", sport: "football", league: "La Liga", marketType: "ML_1X2", tier: "T1",
    phase: "prematch", ttsBucket: "1-6h", startTime: KICKOFF, line: null, selection: "HOME",
    scenario: "PINNACLE_ANCHOR", candidateBook: "comeon", candidateOdds: 2.0, fairPrice: 1.96, fairProb: 0.51,
    benchmarkSource: "pinnacle", benchmarkConfidence: 0.9, requiredEdge: 1.8, calculatedEdge: 3.0,
    decision: "AUTO_BET", executed: false, shadowMode: true, reasonCodes: [], sourceSnapshot: [
      { sourceId: "pinnacle", role: "primary", fairProb: 0.51, weight: 1, isPinnacle: true, isExchange: false },
    ],
    closingFairProb: null, closingSource: null, clvPct: null, won: null, settledAt: null, settled: false,
    ...over,
  };
}

describe("dedupeKey", () => {
  it("samma cell → samma nyckel; olika selection → olika", () => {
    const base = rec({ candidateBook: "comeon" });
    expect(dedupeKey(base)).toBe(dedupeKey(rec({ candidateBook: "comeon" })));
    expect(dedupeKey(rec({ selection: "AWAY", candidateBook: "comeon" }))).not.toBe(dedupeKey(base));
  });
  it("systerbrands (samma plattform) → SAMMA nyckel; annan plattform → olika", () => {
    const base = rec({ candidateBook: "Hajper" });
    // Hajper/Snabbare/Casinostugan/Lyllo delar plattform → samma nyckel
    expect(dedupeKey(rec({ candidateBook: "Snabbare" }))).toBe(dedupeKey(base));
    expect(dedupeKey(rec({ candidateBook: "Casinostugan" }))).toBe(dedupeKey(base));
    expect(dedupeKey(rec({ candidateBook: "Lyllo" }))).toBe(dedupeKey(base));
    // Betsson = annan plattform → annan nyckel
    expect(dedupeKey(rec({ candidateBook: "betsson" }))).not.toBe(dedupeKey(base));
  });
  it("saknad eventId → unik nyckel (kan ej dedupas)", () => {
    const a = rec({ eventId: null as unknown as string });
    const b = rec({ eventId: null as unknown as string });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });
});

describe("dedupeForAnalysis — val av rad", () => {
  it("två open för samma key → behåll SENASTE före kickoff", () => {
    const early = rec({ decisionId: "early", ts: "2026-06-20T18:00:00.000Z", candidateOdds: 2.0 });
    const late = rec({ decisionId: "late", ts: "2026-06-20T20:50:00.000Z", candidateOdds: 2.1 }); // 10 min före avspark
    const r = dedupeForAnalysis([early, late]);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].decisionId).toBe("late");
    expect(r.droppedIds).toContain("early");
    expect(r.stats.collapsedCells).toBe(1);
  });

  it("rad EFTER kickoff ignoreras om en FÖRE kickoff finns", () => {
    const before = rec({ decisionId: "before", ts: "2026-06-20T20:55:00.000Z" }); // före
    const after = rec({ decisionId: "after", ts: "2026-06-20T21:30:00.000Z" }); // efter avspark
    const r = dedupeForAnalysis([before, after]);
    expect(r.kept[0].decisionId).toBe("before");
  });

  it("saknad startTime → senaste ts vinner", () => {
    const a = rec({ decisionId: "a", ts: "2026-06-20T18:00:00.000Z", startTime: null as unknown as string });
    const b = rec({ decisionId: "b", ts: "2026-06-20T19:00:00.000Z", startTime: null as unknown as string });
    const r = dedupeForAnalysis([a, b]);
    expect(r.kept[0].decisionId).toBe("b");
  });

  it("samma bet på 4 systersajter (2 prisnivåer) → 1 sample, behåller BÄSTA priset", () => {
    // Verkligheten: Hajper/Snabbare = tier A (2.33), Casinostugan/Lyllo = tier B (2.29).
    const sisters = [
      rec({ decisionId: "hajper", candidateBook: "Hajper", candidateOdds: 2.33, ts: "2026-06-20T20:50:00.000Z" }),
      rec({ decisionId: "snabbare", candidateBook: "Snabbare", candidateOdds: 2.33, ts: "2026-06-20T20:50:00.000Z" }),
      rec({ decisionId: "casinostugan", candidateBook: "Casinostugan", candidateOdds: 2.29, ts: "2026-06-20T20:50:00.000Z" }),
      rec({ decisionId: "lyllo", candidateBook: "Lyllo", candidateOdds: 2.29, ts: "2026-06-20T20:50:00.000Z" }),
    ];
    const r = dedupeForAnalysis(sisters);
    expect(r.kept).toHaveLength(1); // INTE 4
    expect(r.stats.dropped).toBe(3);
    expect(r.kept[0].candidateOdds).toBe(2.33); // bästa priset, inte godtyckligt
  });

  it("samma bet på OLIKA plattformar → hålls isär (riktiga alternativ)", () => {
    const comeon = rec({ decisionId: "c", candidateBook: "Hajper" });
    const betsson = rec({ decisionId: "b", candidateBook: "betsson" });
    const r = dedupeForAnalysis([comeon, betsson]);
    expect(r.kept).toHaveLength(2);
  });

  it("olika selections dedupas INTE ihop", () => {
    const home = rec({ selection: "HOME" });
    const away = rec({ selection: "AWAY" });
    const draw = rec({ selection: "DRAW" });
    const r = dedupeForAnalysis([home, away, draw]);
    expect(r.kept).toHaveLength(3);
    expect(r.stats.dropped).toBe(0);
  });
});

describe("dedupeForAnalysis — settlement-transfer", () => {
  it("settlement från dropped syskon transfereras till behållen rad (CLV med behållen odds)", () => {
    const early = rec({ decisionId: "early", ts: "2026-06-20T18:00:00.000Z", candidateOdds: 2.0, settled: true, closingFairProb: 0.5, closingSource: "pinnacle", clvPct: 0, won: true, settledAt: "x" });
    const late = rec({ decisionId: "late", ts: "2026-06-20T20:50:00.000Z", candidateOdds: 2.2, settled: false });
    const r = dedupeForAnalysis([early, late]);
    expect(r.kept[0].decisionId).toBe("late");
    expect(r.kept[0].settled).toBe(true);
    // CLV räknas om med behållna radens odds 2.2 × 0.5 − 1 = 10 %
    expect(r.kept[0].clvPct).toBeCloseTo(10, 6);
    expect(r.kept[0].won).toBe(true);
  });

  it("behållen rad redan settlad → behåll dess egen CLV", () => {
    const late = rec({ decisionId: "late", ts: "2026-06-20T20:50:00.000Z", candidateOdds: 2.2, settled: true, closingFairProb: 0.48, closingSource: "pinnacle", clvPct: 5.6 });
    const early = rec({ decisionId: "early", ts: "2026-06-20T18:00:00.000Z", settled: true, closingFairProb: 0.5, clvPct: 0 });
    const r = dedupeForAnalysis([late, early]);
    expect(r.kept[0].clvPct).toBeCloseTo(5.6, 6);
  });
});

describe("buildClvReport — dedupe-option", () => {
  // 30 near-dubbletter av SAMMA bet-tillfälle (samma event/selection/book)
  const dupes: MergedClvRecord[] = Array.from({ length: 30 }, (_, i) =>
    rec({ decisionId: `d${i}`, ts: new Date(Date.parse("2026-06-20T18:00:00.000Z") + i * 60000).toISOString(), settled: true, closingFairProb: 0.5, closingSource: "pinnacle", clvPct: (2.0 * 0.5 - 1) * 100 }),
  );

  it("default dedupe=true → 30 råa rader blir 1 sample", () => {
    const report = buildClvReport(dupes);
    expect(report.rawDecisions).toBe(30);
    expect(report.totalDecisions).toBe(1);
    expect(report.deduped).toBe(true);
    expect(report.bySource.pinnacle.samples).toBe(1);
  });

  it("dedupe=false → rå analys räknar alla 30", () => {
    const report = buildClvReport(dupes, { dedupe: false });
    expect(report.totalDecisions).toBe(30);
    expect(report.bySource.pinnacle.samples).toBe(30);
  });

  it("trustFeedback använder dedupad sample count (default)", () => {
    // 30 dubbletter med negativ CLV → om de räknades som 30 oberoende skulle
    // de kunna passera minSettledSamples. Dedupad = 1 sample → INSUFFICIENT_DATA.
    const report = buildClvReport(dupes);
    const recs = recommendTrustChanges(report.perSource);
    const pinRec = recs.find((r) => r.cell.startsWith("pinnacle|"));
    expect(pinRec?.stats.settledSamples).toBe(1);
    expect(pinRec?.recommendation).toBe("INSUFFICIENT_DATA");
  });
});
