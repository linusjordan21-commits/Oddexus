/**
 * Tester för Pinnacle totals/AH-ladder-parsern (utökade marknader → stegar).
 */

import { describe, it, expect } from "vitest";
import { devigTwoWay } from "./consensus.ts";
import { matchLine } from "./lineMatching.ts";
import { parsePinnacleLineLadders } from "./pinnacleLines.ts";

const americanToDecimal = (a: number) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);

const json = {
  bySport: {
    soccer: {
      markets: [
        // moneyline (ska ignoreras av denna parser)
        { matchupId: 7, type: "moneyline", period: 0, prices: [{ designation: "home", price: -120 }, { designation: "draw", price: 250 }, { designation: "away", price: 320 }] },
        // total huvudlinje 2.5 + alternate 3.0
        { matchupId: 7, type: "total", period: 0, limit: 4000, prices: [{ designation: "over", price: -105, points: 2.5 }, { designation: "under", price: -105, points: 2.5 }] },
        { matchupId: 7, type: "total", period: 0, isAlternate: true, limit: 1500, prices: [{ designation: "over", price: 150, points: 3.0 }, { designation: "under", price: -180, points: 3.0 }] },
        // spread (AH) home -0.5
        { matchupId: 7, type: "spread", period: 0, limit: 3000, prices: [{ designation: "home", price: -110, points: -0.5 }, { designation: "away", price: -110, points: 0.5 }] },
      ],
    },
  },
};

describe("parsePinnacleLineLadders", () => {
  const map = parsePinnacleLineLadders(json, "soccer");

  it("bygger totals-stege med canonical OVER no-vig per linje", () => {
    const l = map.get("7")!;
    expect(l.totals.marketType).toBe("TOTAL");
    expect(l.totals.points.map((p) => p.line)).toEqual([2.5, 3.0]); // sorterad
    const over25 = l.totals.points.find((p) => p.line === 2.5)!;
    expect(over25.prob).toBeCloseTo(devigTwoWay(americanToDecimal(-105), americanToDecimal(-105)), 10);
  });

  it("bygger AH-stege med canonical HOME ur hemma-perspektiv", () => {
    const l = map.get("7")!;
    expect(l.ah.marketType).toBe("AH");
    const ah = l.ah.points.find((p) => p.line === -0.5)!;
    expect(ah.prob).toBeCloseTo(devigTwoWay(americanToDecimal(-110), americanToDecimal(-110)), 10);
    expect(ah.prob).toBeCloseTo(0.5, 10); // symmetriskt pris → 50%
  });

  it("plockar högsta limit över marknaderna", () => {
    expect(map.get("7")!.limit).toBe(4000);
  });

  it("stegen kan line-matchas (exact) av lineMatching", () => {
    const l = map.get("7")!;
    const r = matchLine({ marketType: "TOTAL", scope: "match_total", line: 2.5, selection: "OVER" }, l.totals);
    expect(r.lineMatchType).toBe("exact");
    expect(r.comparable).toBe(true);
  });

  it("tom/saknad input → tom map", () => {
    expect(parsePinnacleLineLadders({}, "soccer").size).toBe(0);
    expect(parsePinnacleLineLadders(null, "soccer").size).toBe(0);
  });
});
