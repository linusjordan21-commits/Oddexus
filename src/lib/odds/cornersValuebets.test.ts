/**
 * Tester för hörn-valuebets-motorn (corner totals + corner AH mot Pinnacles
 * hörn-stege). Syntetisk Pinnacle-data med corner-special-matchup + parent.
 */

import { describe, it, expect } from "vitest";
import { computeCornersValuebets } from "./cornersValuebets.ts";

const START = "2026-06-20T21:00:00.000Z";
const NOW = Date.parse(START) - 3 * 3_600_000;

const pinnacleJson = {
  bySport: {
    soccer: {
      matchups: [
        { id: 100, startTime: START, league: { name: "La Liga" }, participants: [{ alignment: "home", name: "Real Madrid" }, { alignment: "away", name: "Sevilla" }] },
      ],
      markets: [
        { matchupId: 100, type: "moneyline", period: 0, limit: 5000, prices: [{ designation: "home", price: -150 }, { designation: "draw", price: 280 }, { designation: "away", price: 380 }] },
      ],
      // Corner special-matchup → parent 100.
      cornerMatchups: [{ id: 200, parentId: 100, startTime: START }],
      cornerMarkets: [
        // Hörn-total O/U 9.5 @ -110/-110 → P(OVER)=0.50.
        { matchupId: 200, type: "total", period: 0, limit: 250, prices: [{ designation: "over", price: -110, points: 9.5 }, { designation: "under", price: -110, points: 9.5 }] },
        // Hörn-AH home -1.5 @ -110/-110 → P(HOME)=0.50.
        { matchupId: 200, type: "spread", period: 0, limit: 250, prices: [{ designation: "home", price: -110, points: -1.5 }, { designation: "away", price: -110, points: 1.5 }] },
      ],
    },
  },
};

describe("computeCornersValuebets", () => {
  it("hittar +EV hörn-total OVER 9.5 mot Pinnacles hörn-stege", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, corners: { totals: [{ line: 9.5, over: 2.2, under: 1.7 }] } }] };
    const vbs = computeCornersValuebets({ pinnacleJson, softBooks: [{ id: "svenskaspel", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    const over = vbs.find((v) => v.market === "corner_total" && v.selection === "OVER" && v.line === 9.5);
    expect(over).toBeDefined();
    expect(over!.fairProb).toBeCloseTo(0.5, 2);
    expect(over!.ev).toBeCloseTo(0.1, 2);
    expect(over!.pinnacleLimit).toBe(250);
    expect(vbs.find((v) => v.selection === "UNDER")).toBeUndefined(); // 0.5*1.7−1 < 0
  });

  it("hittar +EV hörn-AH HOME -1.5 + reorienterar omvänd lag-ordning", () => {
    // Soft listar Sevilla (home) v Real Madrid (away), hörn-AH Real -1.5 @2.15 (away-sidan).
    const soft = { events: [{ eventId: "9", homeTeam: "Sevilla", awayTeam: "Real Madrid", startTime: START, odds: { home: 5.5, draw: 3.8, away: 1.7 }, corners: { ah: [{ line: 1.5, home: 1.75, away: 2.15 }] } }] };
    const vbs = computeCornersValuebets({ pinnacleJson, softBooks: [{ id: "x", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    const home = vbs.find((v) => v.market === "corner_ah" && v.selection === "HOME" && v.line === -1.5);
    expect(home).toBeDefined();
    expect(home!.bookmakerOdds).toBe(2.15);
    expect(home!.ev).toBeCloseTo(0.075, 2);
  });

  it("min-limit-grind: hörn-linje under min-limit hoppas", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, corners: { totals: [{ line: 9.5, over: 2.2, under: 1.7 }] } }] };
    // limit 250 < minLimit 500 → ingen valuebet.
    const vbs = computeCornersValuebets({ pinnacleJson, minLimit: 500, softBooks: [{ id: "x", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    expect(vbs).toHaveLength(0);
  });

  it("ingen corner-data hos Pinnacle → tom", () => {
    const noCorner = { bySport: { soccer: { matchups: pinnacleJson.bySport.soccer.matchups, markets: pinnacleJson.bySport.soccer.markets } } };
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, corners: { totals: [{ line: 9.5, over: 2.2, under: 1.7 }] } }] };
    expect(computeCornersValuebets({ pinnacleJson: noCorner, softBooks: [{ id: "x", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW })).toHaveLength(0);
  });
});
