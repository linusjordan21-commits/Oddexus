/**
 * Tester för CLV-loggern, analysen och trust-feedback. Inkluderar en
 * disk-roundtrip (skriv → läs → merge) mot en temporär jsonl-fil.
 */

import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClvEntry,
  buildSettlement,
  computeClvPct,
  logDecision,
  mergeClvLines,
  parseClvLines,
  readClvLog,
  serializeLine,
  settleClv,
  type MergedClvRecord,
} from "./clvLogger.ts";
import {
  analyzePerSource,
  buildClvReport,
  computeCellStats,
  keyByBenchmarkSource,
  analyzeByCell,
} from "./clvAnalysis.ts";
import { recommendForCell, recommendTrustChanges } from "./trustFeedback.ts";
import { devigTwoWay, evaluateMarket, type MarketContext } from "./consensus.ts";

const ctx: MarketContext = {
  sport: "football",
  market: "AH",
  tier: "T1",
  phase: "prematch",
  ttsBucket: "1-6h",
  line: -0.5,
  selection: "HOME",
  eventId: "evt-123",
  league: "La Liga",
};
const sources = [
  { sourceId: "pinnacle", fairProb: devigTwoWay(1.9, 2.0) },
  { sourceId: "sbobet", fairProb: devigTwoWay(1.91, 1.99) },
];

describe("clvLogger — bygg & serialisera", () => {
  it("buildClvEntry plockar alla obligatoriska fält + source snapshot", () => {
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "unibet", odds: 2.02 }, sources });
    const entry = buildClvEntry(out, { decisionId: "d1" });
    expect(entry.type).toBe("open");
    expect(entry.eventId).toBe("evt-123");
    expect(entry.league).toBe("La Liga");
    expect(entry.marketType).toBe("AH");
    // Pinnacle förblir ankaret men SBOBET (skarp på AH) blandas in viktat → källan
    // namnges "pinnacle+sbobet" och fair price nudgas något mot SBOBET.
    expect(entry.benchmarkSource).toBe("pinnacle+sbobet");
    expect(entry.sourceSnapshot.map((s) => s.sourceId)).toContain("pinnacle");
    expect(entry.sourceSnapshot.map((s) => s.sourceId)).toContain("sbobet");
    expect(entry.reasonCodes.length).toBeGreaterThan(0);
  });

  it("computeClvPct: ourOdds × closingFairProb − 1", () => {
    expect(computeClvPct(2.0, 0.55)).toBeCloseTo(10, 6); // 2.0×0.55−1 = 0.10 → 10%
    expect(computeClvPct(1.9, 0.5)).toBeCloseTo(-5, 6);
  });

  it("serializeLine ↔ parseClvLines roundtrip", () => {
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "unibet", odds: 2.02 }, sources });
    const open = buildClvEntry(out, { decisionId: "d1" });
    const settle = buildSettlement({ decisionId: "d1", ourOdds: 2.02, closingFairProb: 0.5, closingSource: "pinnacle", won: true });
    const text = serializeLine(open) + serializeLine(settle);
    const parsed = parseClvLines(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("open");
    expect(parsed[1].type).toBe("settle");
  });

  it("parseClvLines hoppar över trasiga rader", () => {
    const parsed = parseClvLines('{"type":"open"}\n{bad json}\n\n{"type":"settle"}\n');
    expect(parsed).toHaveLength(2);
  });
});

describe("clvLogger — disk roundtrip", () => {
  const path = join(tmpdir(), `clv-test-${Date.now()}.jsonl`);
  afterEach(async () => {
    await rm(path, { force: true });
  });

  it("logDecision + settleClv → readClvLog → mergeClvLines", async () => {
    const out = evaluateMarket({ context: ctx, candidate: { bookmaker: "unibet", odds: 2.02 }, sources });
    const id = await logDecision(out, { path, decisionId: "dX" });
    await settleClv({ decisionId: id, ourOdds: 2.02, closingFairProb: 0.5, closingSource: "pinnacle", won: false }, { path });

    const lines = await readClvLog(path);
    expect(lines).toHaveLength(2);
    const merged = mergeClvLines(lines);
    expect(merged).toHaveLength(1);
    expect(merged[0].settled).toBe(true);
    expect(merged[0].clvPct).toBeCloseTo((2.02 * 0.5 - 1) * 100, 6);
    expect(merged[0].won).toBe(false);
  });

  it("readClvLog returnerar [] om filen saknas", async () => {
    const missing = await readClvLog(join(tmpdir(), "does-not-exist-xyz.jsonl"));
    expect(missing).toEqual([]);
  });
});

// ── Hjälpare för analys-tester: bygg syntetiska merged records ──────────
function rec(over: Partial<MergedClvRecord>): MergedClvRecord {
  return {
    type: "open",
    decisionId: Math.random().toString(36),
    ts: new Date().toISOString(),
    eventId: null,
    sport: "football",
    league: "La Liga",
    marketType: "AH",
    tier: "T1",
    phase: "prematch",
    ttsBucket: "1-6h",
    line: -0.5,
    selection: "HOME",
    scenario: "PINNACLE_ANCHOR",
    candidateBook: "unibet",
    candidateOdds: 2.0,
    fairPrice: 1.95,
    fairProb: 0.512,
    benchmarkSource: "pinnacle",
    benchmarkConfidence: 0.9,
    requiredEdge: 1.8,
    calculatedEdge: 3.0,
    decision: "AUTO_BET",
    executed: false,
    shadowMode: true,
    reasonCodes: [],
    sourceSnapshot: [
      { sourceId: "pinnacle", role: "primary", fairProb: 0.512, weight: 1, isPinnacle: true, isExchange: false },
      { sourceId: "sbobet", role: "confirmation", fairProb: 0.51, weight: 0.95, isPinnacle: false, isExchange: false },
    ],
    closingFairProb: null,
    closingSource: null,
    clvPct: null,
    won: null,
    settledAt: null,
    settled: false,
    ...over,
  };
}

function settled(clvPct: number, decision = "AUTO_BET", won: boolean | null = null): MergedClvRecord {
  return rec({ decision, clvPct, settled: true, closingFairProb: 0.5, closingSource: "pinnacle", won });
}

describe("clvAnalysis — cell-statistik", () => {
  it("räknar avg/median CLV, hitRate och falsePositiveRate", () => {
    const records = [settled(4), settled(2), settled(-1), settled(-3), rec({ decision: "NO_BET" })];
    const stats = computeCellStats("test", records);
    expect(stats.samples).toBe(5);
    expect(stats.settledSamples).toBe(4);
    expect(stats.avgClvPct).toBeCloseTo(0.5, 6); // (4+2-1-3)/4
    expect(stats.medianClvPct).toBeCloseTo(0.5, 6); // (2 + -1)/2
    expect(stats.hitRate).toBeCloseTo(0.5, 6); // 2 av 4 > 0
    expect(stats.falsePositiveRate).toBeCloseTo(0.5, 6); // 2 av 4 flaggade ≤ 0
    expect(stats.autoCount).toBe(4);
    expect(stats.noBetCount).toBe(1);
  });

  it("winRate räknas bara på flaggade med känt utfall", () => {
    const records = [settled(3, "AUTO_BET", true), settled(1, "AUTO_BET", false), settled(2, "AUTO_BET", null)];
    const stats = computeCellStats("w", records);
    expect(stats.winRate).toBeCloseTo(0.5, 6); // 1 vinst av 2 med utfall
  });

  it("analyzeByCell grupperar per benchmarkSource", () => {
    const records = [settled(2), rec({ benchmarkSource: "consensus(sbobet,ibc)", decision: "NO_BET" })];
    const by = analyzeByCell(records, keyByBenchmarkSource);
    expect(Object.keys(by)).toContain("pinnacle");
    expect(Object.keys(by)).toContain("consensus(sbobet,ibc)");
  });

  it("analyzePerSource exploderar till en delpost per bidragande källa", () => {
    const per = analyzePerSource([settled(2), settled(4)]);
    // varje record har pinnacle + sbobet i snapshot
    expect(per["pinnacle|football|AH"].samples).toBe(2);
    expect(per["sbobet|football|AH"].samples).toBe(2);
  });

  it("buildClvReport ger alla standard-dimensioner", () => {
    const report = buildClvReport([settled(2), settled(-1)]);
    expect(report.totalDecisions).toBe(2);
    expect(report.settledDecisions).toBe(2);
    expect(report.bySource).toBeDefined();
    expect(report.perSource).toBeDefined();
  });
});

describe("trustFeedback — rekommendationer (ingen auto-ändring)", () => {
  it("INSUFFICIENT_DATA under minSettledSamples", () => {
    const stats = computeCellStats("c", [settled(5), settled(4)]);
    const rec1 = recommendForCell(stats); // default minSettled 100
    expect(rec1.recommendation).toBe("INSUFFICIENT_DATA");
  });

  it("UPGRADE_CANDIDATE vid bevisat positiv CLV", () => {
    const records = Array.from({ length: 120 }, () => settled(2, "AUTO_BET"));
    const stats = computeCellStats("up", records);
    const rec1 = recommendForCell(stats);
    expect(rec1.recommendation).toBe("UPGRADE_CANDIDATE");
  });

  it("DOWNGRADE_CANDIDATE vid negativ CLV", () => {
    const records = Array.from({ length: 120 }, () => settled(-2, "AUTO_BET"));
    const stats = computeCellStats("down", records);
    const rec1 = recommendForCell(stats);
    expect(rec1.recommendation).toBe("DOWNGRADE_CANDIDATE");
  });

  it("recommendTrustChanges sorterar downgrade först", () => {
    const upStats = computeCellStats("up", Array.from({ length: 120 }, () => settled(2)));
    const downStats = computeCellStats("down", Array.from({ length: 120 }, () => settled(-2)));
    const recs = recommendTrustChanges({ up: upStats, down: downStats });
    expect(recs[0].recommendation).toBe("DOWNGRADE_CANDIDATE");
  });
});
