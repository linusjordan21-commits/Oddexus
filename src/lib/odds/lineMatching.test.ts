/**
 * Tester för line-matching/interpolation + integration mot consensus.
 * Mål: hellre reject/manual review än felaktig interpolation.
 */

import { describe, it, expect } from "vitest";
import {
  matchLine,
  lineMatchedQuote,
  type SourceLadder,
  type LineMatchTarget,
} from "./lineMatching.ts";
import { buildConsensus, evaluateMarket, devigTwoWay, type MarketContext } from "./consensus.ts";

function ladder(marketType: SourceLadder["marketType"], scope: string, points: [number, number][]): SourceLadder {
  return { sourceId: "sbobet", marketType, scope, points: points.map(([line, prob]) => ({ line, prob })) };
}

describe("matchLine — exact", () => {
  it("exakt Over 2.5 prioriteras, ingen interpolation", () => {
    const lad = ladder("TOTAL", "match_total", [[2.0, 0.58], [2.5, 0.52], [3.0, 0.44]]);
    const target: LineMatchTarget = { marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" };
    const m = matchLine(target, lad);
    expect(m.lineMatchType).toBe("exact");
    expect(m.lineMatchConfidence).toBe(1);
    expect(m.fairProb).toBeCloseTo(0.52, 6);
    expect(m.sourceLineUsed).toBe(2.5);
  });

  it("Under flippar canonical-prob", () => {
    const lad = ladder("TOTAL", "match_total", [[2.5, 0.52]]);
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "UNDER" }, lad);
    expect(m.fairProb).toBeCloseTo(0.48, 6);
  });
});

describe("matchLine — quarter split", () => {
  it("totals 2.25 = ½·2.0 + ½·2.5", () => {
    const lad = ladder("ASIAN_TOTAL", "match_total", [[2.0, 0.58], [2.5, 0.50]]);
    const m = matchLine({ marketType: "ASIAN_TOTAL", scope: "match_total", line: 2.25, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("quarter_split");
    expect(m.lineMatchConfidence).toBeCloseTo(0.9, 6);
    expect(m.fairProb).toBeCloseTo(0.54, 6); // (0.58+0.50)/2
    expect(m.sourceLineUsed).toEqual([2.0, 2.5]);
  });

  it("AH -0.25 = ½·0.0 + ½·-0.5", () => {
    const lad = ladder("AH", "full", [[0.0, 0.55], [-0.5, 0.47]]);
    const m = matchLine({ marketType: "AH", scope: "full", line: -0.25, selection: "HOME" }, lad);
    expect(m.lineMatchType).toBe("quarter_split");
    expect(m.fairProb).toBeCloseTo(0.51, 6); // (0.55+0.47)/2
  });

  it("kvartslina utan båda komponenterna → reject (ej interpolera kvartslinor)", () => {
    const lad = ladder("ASIAN_TOTAL", "match_total", [[2.0, 0.58]]); // saknar 2.5
    const m = matchLine({ marketType: "ASIAN_TOTAL", scope: "match_total", line: 2.25, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("rejected");
    expect(m.reasonCodes).toContain("LINE_REJECTED_QUARTER_COMPONENTS_MISSING");
  });
});

describe("matchLine — interpolation", () => {
  it("interpolerar 2.25 och 2.75 till 2.5 (lägre confidence)", () => {
    const lad = ladder("TOTAL", "match_total", [[2.25, 0.55], [2.75, 0.47]]);
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("interpolated");
    expect(m.lineMatchConfidence).toBeLessThan(0.9);
    expect(m.lineMatchConfidence).toBeGreaterThan(0.45);
    expect(m.fairProb).toBeCloseTo(0.51, 2);
    expect(m.interpolationDetails?.method).toBe("logit");
  });
});

describe("matchLine — reject", () => {
  it("för stort gap: target 2.5, källan har bara 1.5 och 3.5", () => {
    const lad = ladder("TOTAL", "match_total", [[1.5, 0.7], [3.5, 0.3]]);
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("rejected");
    expect(m.reasonCodes).toContain("LINE_REJECTED_GAP_TOO_LARGE");
    expect(m.comparable).toBe(false);
  });

  it("ingen bracket på ena sidan → reject", () => {
    const lad = ladder("TOTAL", "match_total", [[2.0, 0.58], [2.25, 0.55]]); // inget över 2.5
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("rejected");
    expect(m.reasonCodes).toContain("LINE_REJECTED_NO_BRACKET");
  });

  it("marknadstyp skiljer sig (AH-stege mot TOTAL-target) → reject", () => {
    const lad = ladder("AH", "full", [[0.0, 0.55], [-0.5, 0.47]]);
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 0.0, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("rejected");
    expect(m.reasonCodes).toContain("MARKET_TYPE_MISMATCH");
  });

  it("scope skiljer sig (match total ≠ team total) → reject", () => {
    const lad = ladder("TOTAL", "team_total", [[2.5, 0.52]]);
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("rejected");
    expect(m.reasonCodes).toContain("MARKET_TYPE_MISMATCH");
  });

  it("icke-monoton stege → reject", () => {
    const lad = ladder("TOTAL", "match_total", [[2.0, 0.50], [2.5, 0.62], [3.0, 0.44]]); // 0.50→0.62 inversion
    const m = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.75, selection: "OVER" }, lad);
    expect(m.lineMatchType).toBe("rejected");
    expect(m.reasonCodes).toContain("LINE_REJECTED_NON_MONOTONIC");
  });
});

describe("integration mot consensus", () => {
  const ctx: MarketContext = {
    sport: "football",
    market: "ASIAN_TOTAL",
    tier: "T1",
    phase: "prematch",
    ttsBucket: "1-6h",
    line: 2.5,
    selection: "OVER",
  };

  it("rejected source ignoreras helt i consensus", () => {
    // sbobet rejected (lineComparable false) + ibc OK → bara 1 bidragande
    const sources = [
      { sourceId: "sbobet", fairProb: 0.5, lineComparable: false, lineMatchConfidence: 0 },
      { sourceId: "ibc", fairProb: 0.51, lineComparable: true, lineMatchConfidence: 1 },
    ];
    const c = buildConsensus(ctx, sources);
    expect(c.sourceRoles.sbobet).toBe("ignore");
    expect(c.sources.find((s) => s.sourceId === "sbobet")!.weight).toBe(0);
    // bara ibc kvar → 1 källa → ingen tillförlitlig benchmark
    expect(c.scenario).toBe("NO_RELIABLE_BENCHMARK");
  });

  it("interpolerad match sänker benchmarkConfidence vs exakt", () => {
    const exact = [
      { sourceId: "sbobet", fairProb: 0.5, lineComparable: true, lineMatchConfidence: 1.0 },
      { sourceId: "ibc", fairProb: 0.5, lineComparable: true, lineMatchConfidence: 1.0 },
    ];
    const interp = [
      { sourceId: "sbobet", fairProb: 0.5, lineComparable: true, lineMatchConfidence: 0.6 },
      { sourceId: "ibc", fairProb: 0.5, lineComparable: true, lineMatchConfidence: 0.6 },
    ];
    const cExact = buildConsensus(ctx, exact);
    const cInterp = buildConsensus(ctx, interp);
    expect(cInterp.benchmarkConfidence).toBeLessThan(cExact.benchmarkConfidence);
  });

  it("lineMatchedQuote → consensus: exakt linje ger normalt value-flöde", () => {
    const lad: SourceLadder = {
      sourceId: "sbobet",
      marketType: "ASIAN_TOTAL",
      scope: "match_total",
      points: [{ line: 2.5, prob: devigTwoWay(1.95, 1.95) }],
    };
    const q = lineMatchedQuote({ marketType: "ASIAN_TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, lad);
    expect(q.lineComparable).toBe(true);
    expect(q.lineMatchConfidence).toBe(1);
    // mata in i consensus tillsammans med Pinnacle-ankare
    const out = evaluateMarket({
      context: ctx,
      candidate: { bookmaker: "comeon", odds: 2.05 },
      sources: [{ sourceId: "pinnacle", fairProb: 0.5 }, q],
    });
    expect(out.consensus.scenario).toBe("PINNACLE_ANCHOR");
    expect(out.consensus.sourceRoles.sbobet).not.toBe("ignore");
  });
});
