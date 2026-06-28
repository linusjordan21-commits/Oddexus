/**
 * Tester för AH-valuebets-motorn (football Asian Handicap mot Pinnacle-stege
 * + ev. Betfair/SBOBET AH). Deterministisk syntetisk data.
 */

import { describe, it, expect } from "vitest";
import { computeAhValuebets } from "./ahValuebets.ts";

const START = "2026-06-20T21:00:00.000Z";
const NOW = Date.parse(START) - 3 * 3_600_000;

// Pinnacle: 1X2 (identitet) + spread (AH) home -0.5 @ -110/-110 → HOME -0.5 = 0.50.
const pinnacleJson = {
  bySport: {
    soccer: {
      matchups: [
        { id: 7, startTime: START, league: { name: "La Liga" }, participants: [{ alignment: "home", name: "Real Madrid" }, { alignment: "away", name: "Sevilla" }] },
      ],
      markets: [
        { matchupId: 7, type: "moneyline", period: 0, limit: 5000, prices: [{ designation: "home", price: -150 }, { designation: "draw", price: 280 }, { designation: "away", price: 380 }] },
        { matchupId: 7, type: "spread", period: 0, limit: 3000, prices: [{ designation: "home", price: -110, points: -0.5 }, { designation: "away", price: -110, points: 0.5 }] },
      ],
    },
  },
};

describe("computeAhValuebets", () => {
  it("hittar +EV HOME -0.5 mot Pinnacle-AH-stege", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, ah: [{ line: -0.5, home: 2.15, away: 1.75 }] }] };
    const vbs = computeAhValuebets({ pinnacleJson, softBooks: [{ id: "comeon", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    const home = vbs.find((v) => v.selection === "HOME" && v.line === -0.5);
    expect(home).toBeDefined();
    expect(home!.fairProb).toBeCloseTo(0.5, 2);
    expect(home!.ev).toBeCloseTo(0.075, 2);
    expect(home!.sources).toContain("pinnacle");
    expect(vbs.find((v) => v.selection === "AWAY")).toBeUndefined(); // AWAY @1.75, 0.5×1.75−1<0
  });

  it("order-oberoende: omvänd lag-ordning reorienteras (linje negeras, sida byts)", () => {
    // Soft listar Sevilla (home) v Real Madrid (away), AH Sevilla +0.5 @1.75 / Real -0.5 @2.15.
    // Pinnacle har Real (home) -0.5 = 0.50. Real -0.5 @2.15 (away-sidan i soft) → +EV.
    const soft = { events: [{ eventId: "9", homeTeam: "Sevilla", awayTeam: "Real Madrid", startTime: START, odds: { home: 5.5, draw: 3.8, away: 1.7 }, ah: [{ line: 0.5, home: 1.75, away: 2.15 }] }] };
    const vbs = computeAhValuebets({ pinnacleJson, softBooks: [{ id: "x", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    // Efter reorientering till Pinnacle-ordning: Real Madrid (HOME) -0.5 @2.15 → +7.5%.
    const home = vbs.find((v) => v.selection === "HOME" && v.line === -0.5);
    expect(home).toBeDefined();
    expect(home!.bookmakerOdds).toBe(2.15);
    expect(home!.ev).toBeCloseTo(0.075, 2);
  });

  it("ingen Pinnacle → tom; otäckt linje → hoppas", () => {
    expect(computeAhValuebets({ pinnacleJson: {}, softBooks: [], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW })).toEqual([]);
    const off = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 2, draw: 3, away: 4 }, ah: [{ line: -3.5, home: 2.15, away: 1.2 }] }] };
    expect(computeAhValuebets({ pinnacleJson, softBooks: [{ id: "x", json: off }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW })).toHaveLength(0);
  });
});
