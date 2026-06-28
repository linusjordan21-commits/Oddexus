/**
 * Tester för EH3-valuebets-motorn v2 (europeiskt 3-vägs-handikapp härlett ur en
 * MULTI-SKARP konsensus av AH-stegen). Deterministisk syntetisk data.
 *
 * Pinnacle-stege: AH home -0.5 @ -110/-110 → P(M≥1)=0.50; AH home -1.5 @ dec 3.0 /
 * 1.3333 → P(M≥2)=0.3077. För EH3-linje H=-1 (hemma -1):
 *   P(hemma)=P(M≥2)=0.3077, P(oavgjort)=P(M=1)=0.50−0.3077=0.1923, P(borta)=0.50.
 *
 * Smarkets-confirmer (samma sannolikheter) → uppfyller minConfirmers-grinden.
 */

import { describe, it, expect } from "vitest";
import { computeEh3Valuebets } from "./eh3Valuebets.ts";
import { parseSmarketsAhRowsMap } from "./smarketsAdapter.ts";

const START = "2026-06-20T21:00:00.000Z";
const NOW = Date.parse(START) - 3 * 3_600_000;

const pinnacleJson = {
  bySport: {
    soccer: {
      matchups: [
        { id: 7, startTime: START, league: { name: "La Liga" }, participants: [{ alignment: "home", name: "Real Madrid" }, { alignment: "away", name: "Sevilla" }] },
      ],
      markets: [
        { matchupId: 7, type: "moneyline", period: 0, limit: 5000, prices: [{ designation: "home", price: -150 }, { designation: "draw", price: 280 }, { designation: "away", price: 380 }] },
        { matchupId: 7, type: "spread", period: 0, limit: 3000, prices: [{ designation: "home", price: -110, points: -0.5 }, { designation: "away", price: -110, points: 0.5 }] },
        { matchupId: 7, type: "spread", period: 0, limit: 3000, prices: [{ designation: "home", price: 200, points: -1.5 }, { designation: "away", price: -300, points: 1.5 }] },
      ],
    },
  },
};

// Smarkets-confirmer som HÅLLER MED Pinnacle: AH home -0.5 → 0.50, -1.5 → 0.3077.
const smarketsAgree = parseSmarketsAhRowsMap({
  footballRows: [
    { eventId: "s9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 },
      ah: [{ line: -0.5, home: 2.0, away: 2.0 }, { line: -1.5, home: 3.25, away: 1.444 }] },
  ],
});

describe("computeEh3Valuebets v2 (multi-sharp consensus)", () => {
  it("härleder hemma -1 ur konsensus + hittar +EV (med Smarkets-confirmer)", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, eh3: [{ line: -1, home: 3.6, draw: 5.0, away: 1.9 }] }] };
    const vbs = computeEh3Valuebets({ pinnacleJson, smarketsAh: smarketsAgree, softBooks: [{ id: "tipwin", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    const home = vbs.find((v) => v.selection === "HOME" && v.line === -1);
    expect(home).toBeDefined();
    expect(home!.fairProb).toBeCloseTo(0.3077, 2);
    expect(home!.ev).toBeCloseTo(0.3077 * 3.6 - 1, 2);
    expect(home!.sources).toContain("pinnacle-ah-consensus");
    expect(vbs.find((v) => v.selection === "DRAW")).toBeUndefined(); // 0.1923*5−1 < 0
    expect(vbs.find((v) => v.selection === "AWAY")).toBeUndefined(); // 0.50*1.9−1 < 0
  });

  it("SÄKERHET: utan confirmer (Pinnacle ensam) → INGEN valuebet (default minConfirmers=1)", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, eh3: [{ line: -1, home: 3.6, draw: 5.0, away: 1.9 }] }] };
    const vbs = computeEh3Valuebets({ pinnacleJson, softBooks: [{ id: "tipwin", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    expect(vbs).toHaveLength(0); // ingen skarp confirmer → grinden stoppar (skydd mot falsk fair price)
  });

  it("minConfirmers=0 tillåter Pinnacle-ensam-härledning (för validering)", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 1.7, draw: 3.8, away: 5.5 }, eh3: [{ line: -1, home: 3.6, draw: 5.0, away: 1.9 }] }] };
    const vbs = computeEh3Valuebets({ pinnacleJson, minConfirmers: 0, softBooks: [{ id: "tipwin", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    const home = vbs.find((v) => v.selection === "HOME" && v.line === -1);
    expect(home).toBeDefined();
    expect(home!.fairProb).toBeCloseTo(0.3077, 2);
  });

  it("order-oberoende: omvänd lag-ordning reorienteras (linje negeras, hemma↔borta)", () => {
    const soft = { events: [{ eventId: "9", homeTeam: "Sevilla", awayTeam: "Real Madrid", startTime: START, odds: { home: 5.5, draw: 3.8, away: 1.7 }, eh3: [{ line: 1, home: 1.9, draw: 5.0, away: 3.6 }] }] };
    const vbs = computeEh3Valuebets({ pinnacleJson, smarketsAh: smarketsAgree, softBooks: [{ id: "x", json: soft }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW });
    const home = vbs.find((v) => v.selection === "HOME" && v.line === -1);
    expect(home).toBeDefined();
    expect(home!.bookmakerOdds).toBe(3.6);
    expect(home!.fairProb).toBeCloseTo(0.3077, 2);
  });

  it("ingen Pinnacle → tom; otäckt linje → hoppas", () => {
    expect(computeEh3Valuebets({ pinnacleJson: {}, softBooks: [], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW })).toEqual([]);
    const off = { events: [{ eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 2, draw: 3, away: 4 }, eh3: [{ line: -4, home: 9, draw: 7, away: 1.1 }] }] };
    expect(computeEh3Valuebets({ pinnacleJson, minConfirmers: 0, softBooks: [{ id: "x", json: off }], evThreshold: 0.02, rejectThreshold: 0.25, now: NOW })).toHaveLength(0);
  });
});
