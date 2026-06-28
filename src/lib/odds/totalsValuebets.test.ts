/**
 * Tester för backend totals-valuebets-motorn (football Over/Under mot Pinnacle-
 * stege + ev. Betfair). Deterministisk syntetisk data.
 */

import { describe, it, expect } from "vitest";
import { computeTotalsValuebets } from "./totalsValuebets.ts";
import { parsePinnacleSoccer } from "./shadowConsensus.ts";
import { parsePinnacleLineLadders } from "./pinnacleLines.ts";

const START = "2026-06-20T21:00:00.000Z";
const NOW = Date.parse(START) - 3 * 3_600_000; // 3h innan avspark

// Pinnacle: 1X2 (identitet) + total 2.5 @ -105/-105 → OVER no-vig = 0.50.
const pinnacleJson = {
  updatedAt: START,
  bySport: {
    soccer: {
      matchups: [
        { id: 7, startTime: START, league: { name: "La Liga" }, participants: [{ alignment: "home", name: "Real Madrid" }, { alignment: "away", name: "Sevilla" }] },
      ],
      markets: [
        { matchupId: 7, type: "moneyline", period: 0, limit: 5000, prices: [{ designation: "home", price: -110 }, { designation: "draw", price: 260 }, { designation: "away", price: 320 }] },
        { matchupId: 7, type: "total", period: 0, limit: 4000, prices: [{ designation: "over", price: -105, points: 2.5 }, { designation: "under", price: -105, points: 2.5 }] },
      ],
    },
  },
};

// Soft-bok (events-layout) med samma match + ett O/U-erbjudande där OVER ger +EV.
const softJson = {
  events: [
    {
      eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START,
      odds: { home: 2.1, draw: 3.5, away: 3.5 },
      totals: [{ line: 2.5, over: 2.15, under: 1.75 }], // OVER @2.15, fair 0.50 → EV +7.5%
    },
  ],
};

describe("computeTotalsValuebets", () => {
  it("hittar +EV OVER mot Pinnacle-stege; UNDER (−EV) utesluts", () => {
    const vbs = computeTotalsValuebets({
      pinnacleJson, softBooks: [{ id: "comeon", json: softJson }],
      evThreshold: 0.02, rejectThreshold: 0.25, now: NOW,
    });
    const over = vbs.find((v) => v.selection === "OVER" && v.line === 2.5);
    expect(over).toBeDefined();
    expect(over!.bookmaker).toBe("comeon");
    expect(over!.fairProb).toBeCloseTo(0.5, 2);
    expect(over!.ev).toBeCloseTo(0.075, 2); // 0.5×2.15 − 1
    expect(over!.sources).toContain("pinnacle");
    // eventId = Pinnacle matchupId (String) → bär CLV-join + market_key (får ej droppas).
    expect(over!.eventId).toBe("7");
    // UNDER @1.75 → 0.5×1.75−1 = −0.125 < tröskel → ej valuebet.
    expect(vbs.find((v) => v.selection === "UNDER")).toBeUndefined();
  });

  it("avvisar EV över reject-tröskeln (datafel-skydd)", () => {
    // OVER @5.0 → 0.5×5−1 = 1.5 (150%) → orealistiskt → avvisas.
    const wild = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 2, draw: 3, away: 4 }, totals: [{ line: 2.5, over: 5.0, under: 1.2 }] }] };
    const vbs = computeTotalsValuebets({ pinnacleJson, softBooks: [{ id: "x", json: wild }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    expect(vbs.find((v) => v.selection === "OVER")).toBeUndefined();
  });

  it("förparsad Pinnacle (delad mellan motorer) ger IDENTISKT resultat som self-parse", () => {
    const base = { pinnacleJson, softBooks: [{ id: "comeon", json: softJson }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW };
    const selfParse = computeTotalsValuebets(base);
    const preParsed = computeTotalsValuebets({
      ...base,
      pinnacleEvents: parsePinnacleSoccer(pinnacleJson),
      pinnacleLadders: parsePinnacleLineLadders(pinnacleJson, "soccer"),
    });
    expect(preParsed).toEqual(selfParse);
  });

  it("ingen Pinnacle → tom lista", () => {
    expect(computeTotalsValuebets({ pinnacleJson: {}, softBooks: [{ id: "x", json: softJson }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW })).toEqual([]);
  });

  it("linje Pinnacle inte täcker → hoppas (ingen valuebet)", () => {
    const offLine = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 2, draw: 3, away: 4 }, totals: [{ line: 8.5, over: 2.15, under: 1.2 }] }] };
    const vbs = computeTotalsValuebets({ pinnacleJson, softBooks: [{ id: "x", json: offLine }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    expect(vbs).toHaveLength(0); // 8.5 ligger utanför Pinnacles 2.5-stege (interpolering ej jämförbar)
  });
});
