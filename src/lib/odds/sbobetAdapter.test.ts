/**
 * Tester för SBOBET-adaptern (SbobetMarket → SourceQuote/AH-ladder).
 */

import { describe, it, expect } from "vitest";
import { devigThreeWay, devigTwoWay } from "./consensus.ts";
import { sbobetMoneylineQuote, buildAhLadder, sbobetAhQuote } from "./sbobetAdapter.ts";
import type { SbobetMarket } from "./sbobetScrapeParse.ts";

const ml: SbobetMarket = {
  oddsId: "572125529",
  marketType: "ML_1X2",
  scope: "full",
  runners: [
    { selection: "HOME", decimalOdds: 1.47 },
    { selection: "DRAW", decimalOdds: 4.2 },
    { selection: "AWAY", decimalOdds: 7.4 },
  ],
};

describe("sbobetMoneylineQuote", () => {
  it("devig:ar 1X2 till no-vig fairProb", () => {
    const q = sbobetMoneylineQuote(ml, "HOME");
    expect(q.sourceId).toBe("sbobet");
    expect(q.isExchange).toBe(false);
    expect(q.lineComparable).toBe(true);
    expect(q.fairProb).toBeCloseTo(devigThreeWay(1.47, 4.2, 7.4, "HOME"), 10);
    // Σ over selections = 1 (devig).
    const sum =
      sbobetMoneylineQuote(ml, "HOME").fairProb +
      sbobetMoneylineQuote(ml, "DRAW").fairProb +
      sbobetMoneylineQuote(ml, "AWAY").fairProb;
    expect(sum).toBeCloseTo(1, 10);
  });

  it("ofullständig marknad → lineComparable false, fairProb 0", () => {
    const partial: SbobetMarket = { ...ml, runners: ml.runners.slice(0, 2) };
    const q = sbobetMoneylineQuote(partial, "HOME");
    expect(q.lineComparable).toBe(false);
    expect(q.fairProb).toBe(0);
  });
});

describe("AH-ladder + quote", () => {
  const ahMarkets: SbobetMarket[] = [
    { oddsId: "a1", marketType: "AH", scope: "full", line: -0.5, runners: [{ selection: "HOME", decimalOdds: 1.8 }, { selection: "AWAY", decimalOdds: 2.05 }] },
    { oddsId: "a2", marketType: "AH", scope: "full", line: -1.0, runners: [{ selection: "HOME", decimalOdds: 2.3 }, { selection: "AWAY", decimalOdds: 1.62 }] },
  ];

  it("ladder canonical = HOME no-vig per linje", () => {
    const ladder = buildAhLadder(ahMarkets);
    expect(ladder.marketType).toBe("AH");
    expect(ladder.points).toHaveLength(2);
    const p = ladder.points.find((x) => x.line === -0.5)!;
    expect(p.prob).toBeCloseTo(devigTwoWay(1.8, 2.05), 10);
  });

  it("exact line-match → comparable HOME-prob", () => {
    const r = sbobetAhQuote({ marketType: "AH", scope: "full", line: -0.5, selection: "HOME" }, ahMarkets);
    expect(r.quote.lineComparable).toBe(true);
    expect(r.lineMatch.lineMatchType).toBe("exact");
    expect(r.quote.fairProb).toBeCloseTo(devigTwoWay(1.8, 2.05), 10);
  });

  it("AWAY selection = 1 − HOME-prob på exakt linje", () => {
    const r = sbobetAhQuote({ marketType: "AH", scope: "full", line: -0.5, selection: "AWAY" }, ahMarkets);
    expect(r.quote.fairProb).toBeCloseTo(1 - devigTwoWay(1.8, 2.05), 10);
  });

  it("linje som saknas helt → rejected (ej comparable)", () => {
    const r = sbobetAhQuote({ marketType: "AH", scope: "full", line: 3.5, selection: "HOME" }, ahMarkets);
    expect(r.quote.lineComparable).toBe(false);
    expect(r.lineMatch.lineMatchType).toBe("rejected");
  });
});
