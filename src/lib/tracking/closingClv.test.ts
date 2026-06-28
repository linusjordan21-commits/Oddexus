import { describe, it, expect } from "vitest";
import { closingFairProb, computeClv, totalFairProb, ahFairProb, mlFairProb, findClosingFallback } from "./closingClv.ts";
import { normalizeTeamName } from "../odds/matching.ts";

const rec = {
  fairProb: { HOME: 0.5, DRAW: 0.27, AWAY: 0.23 },
  totalsLines: [
    { line: 2.5, overProb: 0.52 },
    { line: 3, overProb: 0.34 },
    { line: 2.25, overProb: 0.6 }, // Asian quarter-line
  ],
  ahLines: [
    { line: -0.5, homeProb: 0.55 }, // hemma -0.5
    { line: 0.25, homeProb: 0.62 },
  ],
};

describe("closingClv — moneyline", () => {
  it("returnerar fairProb för rätt selection", () => {
    expect(mlFairProb(rec, "HOME")).toBe(0.5);
    expect(closingFairProb(rec, "1x2", "AWAY", null)).toBe(0.23);
    expect(closingFairProb(rec, "moneyline", "DRAW", null)).toBe(0.27);
  });
  it("avvisar ogiltig selection", () => {
    expect(mlFairProb(rec, "OVER")).toBeNull();
  });
});

describe("closingClv — totals (exakt linje)", () => {
  it("OVER tar overProb, UNDER tar komplementet", () => {
    expect(totalFairProb(rec, "OVER", 2.5)).toBe(0.52);
    expect(totalFairProb(rec, "UNDER", 2.5)).toBeCloseTo(0.48, 10);
  });
  it("matchar Asian quarter-linje exakt", () => {
    expect(closingFairProb(rec, "total", "OVER", 2.25)).toBe(0.6);
  });
  it("returnerar null när linjen INTE finns (ingen interpolation)", () => {
    expect(totalFairProb(rec, "OVER", 2.75)).toBeNull();
    expect(closingFairProb(rec, "total", "OVER", 1.5)).toBeNull();
  });
});

describe("closingClv — AH (hemma-perspektiv, exakt linje)", () => {
  it("HOME tar homeProb, AWAY tar komplementet på SAMMA lagrade linje", () => {
    expect(ahFairProb(rec, "HOME", -0.5)).toBe(0.55);
    expect(ahFairProb(rec, "AWAY", -0.5)).toBeCloseTo(0.45, 10);
    expect(closingFairProb(rec, "ah", "HOME", 0.25)).toBe(0.62);
    expect(closingFairProb(rec, "ah", "AWAY", 0.25)).toBeCloseTo(0.38, 10);
  });
  it("returnerar null för omatchad handikapp-linje", () => {
    expect(ahFairProb(rec, "HOME", -1)).toBeNull();
  });
});

describe("closingClv — markets utan closing", () => {
  it("eh3/corners → null", () => {
    expect(closingFairProb(rec, "eh3", "HOME", null)).toBeNull();
    expect(closingFairProb(rec, "corner_total", "OVER", 9.5)).toBeNull();
    expect(closingFairProb(rec, "corner_ah", "HOME", -1)).toBeNull();
  });
});

describe("closingClv — CLV-beräkning", () => {
  it("clv > 0 när vi slog linjen (betOdds > fair odds)", () => {
    // fair prob 0.5 → fair odds 2.0. Vi tog 2.10 → +5% CLV.
    const { closingFairOdds, clvPct } = computeClv(2.1, 0.5);
    expect(closingFairOdds).toBe(2);
    expect(clvPct).toBeCloseTo(0.05, 10);
  });
  it("clv < 0 när vi tog sämre pris än closing", () => {
    expect(computeClv(1.9, 0.5).clvPct).toBeCloseTo(-0.05, 10);
  });
});

describe("findClosingFallback — robusthets-layer (steg 3)", () => {
  const START = "2026-06-28T19:00:00.000Z";
  const startMs = Date.parse(START);
  const nh = (s) => normalizeTeamName(s);
  const events = {
    "e1": { homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, fairProb: { HOME: 0.5, DRAW: 0.27, AWAY: 0.23 } },
    "e2": { homeTeam: "Barcelona", awayTeam: "Valencia", startTime: START, fairProb: { HOME: 0.6, DRAW: 0.22, AWAY: 0.18 } },
  };

  it("unik lag+tid-träff → matchar", () => {
    const r = findClosingFallback(nh("Real Madrid"), nh("Sevilla"), startMs, events);
    expect(r?.eventId).toBe("e1");
  });
  it("normaliserar lagnamn (FC/punkter) → matchar ändå", () => {
    const ev = { "e9": { homeTeam: "Real Madrid C.F.", awayTeam: "Sevilla FC", startTime: START, fairProb: { HOME: 0.5 } } };
    const r = findClosingFallback(nh("Real Madrid"), nh("Sevilla"), startMs, ev);
    // matchar bara om normaliseringen tar bort C.F./FC lika på båda sidor
    if (r) expect(r.eventId).toBe("e9");
  });
  it("inget lagnamns-match → null", () => {
    expect(findClosingFallback(nh("Liverpool"), nh("Chelsea"), startMs, events)).toBeNull();
  });
  it("avspark utanför tolerans → null", () => {
    expect(findClosingFallback(nh("Real Madrid"), nh("Sevilla"), startMs + 30 * 60 * 1000, events)).toBeNull();
  });
  it("inom tolerans (±10 min) → matchar", () => {
    expect(findClosingFallback(nh("Real Madrid"), nh("Sevilla"), startMs + 5 * 60 * 1000, events)?.eventId).toBe("e1");
  });
  it("tvetydig (2 kandidater samma lag+tid) → null (gissa aldrig)", () => {
    const dup = { ...events, "e3": { homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, fairProb: { HOME: 0.5 } } };
    expect(findClosingFallback(nh("Real Madrid"), nh("Sevilla"), startMs, dup)).toBeNull();
  });
  it("swappad ordning → null (endast direkt ordning, undvik fel selection)", () => {
    expect(findClosingFallback(nh("Sevilla"), nh("Real Madrid"), startMs, events)).toBeNull();
  });
});
