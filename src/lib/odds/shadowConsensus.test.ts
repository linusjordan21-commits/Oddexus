/**
 * Tester för shadow-wiring: Pinnacle-parsning, soft-book-parsning, Betfair-
 * mock, matchning och end-to-end runShadow. Deterministisk syntetisk data.
 */

import { describe, it, expect } from "vitest";
import {
  americanToDecimal,
  buildMockBetfairMap,
  deriveTier,
  mockBetfairFromPinnacle,
  parseBetfairRowsMap,
  parseSbobetRowsMap,
  parseSbobetAhRowsMap,
  parsePinnacleSoccer,
  parseSoftBook,
  runShadow,
  ttsBucketFrom,
  type CandidateEvent,
  type PinnacleEvent,
} from "./shadowConsensus.ts";

const START = "2026-06-20T21:00:00.000Z";

const pinnacleJson = {
  updatedAt: START,
  bySport: {
    soccer: {
      matchups: [
        { id: 1001, startTime: START, league: { name: "La Liga" }, participants: [{ alignment: "home", name: "Real Madrid" }, { alignment: "away", name: "Sevilla" }] },
      ],
      markets: [
        { matchupId: 1001, type: "moneyline", period: 0, limit: 5000, prices: [{ designation: "home", price: -110 }, { designation: "draw", price: 260 }, { designation: "away", price: 320 }] },
        { matchupId: 1001, type: "moneyline", period: 1, prices: [{ designation: "home", price: 100 }] }, // fel period → ignoreras
      ],
    },
  },
};

const comeonJson = {
  byFranchise: {
    SWEDEN_COMEON: {
      bookmaker: "comeon",
      events: [
        { eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, odds: { home: 2.15, draw: 3.6, away: 4.2 } },
        { eventId: "10", homeTeam: "Okänd A", awayTeam: "Okänd B", startTime: START, odds: { home: 2.0, draw: 3.0, away: 3.5 } },
      ],
    },
  },
};

describe("odds-hjälpare", () => {
  it("americanToDecimal", () => {
    expect(americanToDecimal(100)).toBeCloseTo(2.0, 6);
    expect(americanToDecimal(-110)).toBeCloseTo(1.909, 3);
  });
  it("ttsBucketFrom", () => {
    const now = Date.parse(START) - 3 * 3_600_000; // 3h innan
    expect(ttsBucketFrom(START, now)).toBe("1-6h");
  });
  it("deriveTier nedgraderar Challenger/ITF", () => {
    expect(deriveTier("ATP Challenger Prague")).toBe("T3");
    expect(deriveTier("La Liga")).toBe("T1");
    expect(deriveTier(null)).toBe("T2");
  });
});

describe("parsePinnacleSoccer", () => {
  it("parsar 1X2 moneyline period 0 och devig:ar", () => {
    const evs = parsePinnacleSoccer(pinnacleJson);
    expect(evs).toHaveLength(1);
    const e = evs[0];
    expect(e.identity.homeTeam).toBe("Real Madrid");
    const sum = e.fairProb.HOME + e.fairProb.DRAW + e.fairProb.AWAY;
    expect(sum).toBeCloseTo(1, 6);
    expect(e.limit).toBe(5000);
  });
  it("tom input → []", () => {
    expect(parsePinnacleSoccer({})).toEqual([]);
    expect(parsePinnacleSoccer(null)).toEqual([]);
  });
});

describe("parseSoftBook", () => {
  it("byFranchise-layout (comeon)", () => {
    const cs = parseSoftBook(comeonJson, "comeon", "SWEDEN_COMEON");
    expect(cs).toHaveLength(2);
    expect(cs[0].bookmaker).toBe("comeon");
    expect(cs[0].odds.HOME).toBe(2.15);
  });
  it("events-layout (betsson)", () => {
    const betsson = { events: [{ eventId: "x", homeTeam: "A", awayTeam: "B", startTime: START, odds: { home: 2, draw: 3, away: 4 } }] };
    const cs = parseSoftBook(betsson, "betsson");
    expect(cs).toHaveLength(1);
  });
  it("hoppar över event utan kompletta odds", () => {
    const bad = { events: [{ homeTeam: "A", awayTeam: "B", startTime: START, odds: { home: 2 } }] };
    expect(parseSoftBook(bad, "x")).toHaveLength(0);
  });
  it("events-layout med totals+ah (atg, Kambi-form)", () => {
    // ATG kör Kambi → samma events[]-form med odds/totals/ah som Unibet/Kambi.
    const atg = { events: [{ eventId: "a1", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, league: "La Liga", odds: { home: 1.7, draw: 3.8, away: 5.5 }, totals: [{ line: 2.5, over: 1.95, under: 1.85 }], ah: [{ line: -0.5, home: 2.05, away: 1.78 }] }] };
    const cs = parseSoftBook(atg, "atg");
    expect(cs).toHaveLength(1);
    expect(cs[0].bookmaker).toBe("atg");
    expect(cs[0].odds.HOME).toBe(1.7);
    expect(cs[0].totals?.[0]).toMatchObject({ line: 2.5, over: 1.95, under: 1.85 });
    expect(cs[0].ah?.[0]).toMatchObject({ line: -0.5, home: 2.05, away: 1.78 });
  });
});

describe("mockBetfairFromPinnacle", () => {
  it("bygger likvid MATCH_ODDS-mock med 3 runners", () => {
    const ev = parsePinnacleSoccer(pinnacleJson)[0];
    const m = mockBetfairFromPinnacle(ev);
    expect(m.marketType).toBe("MATCH_ODDS");
    expect(m.runners).toHaveLength(3);
    expect(m.matchedVolume).toBeGreaterThan(10000);
  });
});

describe("runShadow — end-to-end", () => {
  const pinnacle: PinnacleEvent[] = parsePinnacleSoccer(pinnacleJson);
  const candidates: CandidateEvent[] = parseSoftBook(comeonJson, "comeon", "SWEDEN_COMEON");
  const now = Date.parse(START) - 3 * 3_600_000;

  it("matchar Real Madrid–Sevilla, skippar omatchat event", () => {
    const r = runShadow({ pinnacle, candidates, now });
    expect(r.stats.matched).toBe(1); // bara Real Madrid–Sevilla matchar
    expect(r.stats.bySkipReason.NO_PINNACLE_MATCH).toBe(1); // Okänd A/B
    expect(r.entries.length).toBe(3); // HOME/DRAW/AWAY för matchat event
  });

  it("default = PINNACLE-ONLY (ingen betfair utan källa)", () => {
    const r = runShadow({ pinnacle, candidates, now });
    const e = r.entries[0];
    expect(e.type).toBe("open");
    expect(e.shadowMode).toBe(true);
    expect(e.executed).toBe(false); // aldrig exekvering i shadow
    expect(e.benchmarkSource).toBe("pinnacle");
    expect(e.sourceSnapshot.map((s) => s.sourceId)).toContain("pinnacle");
    expect(e.sourceSnapshot.map((s) => s.sourceId)).not.toContain("betfair");
    expect(e.reasonCodes.length).toBeGreaterThan(0);
  });

  it("med betfairMarkets → betfair läggs in med order book-snapshot", () => {
    const r = runShadow({ pinnacle, candidates, now, betfairMarkets: buildMockBetfairMap(pinnacle) });
    const e = r.entries[0];
    expect(e.sourceSnapshot.map((s) => s.sourceId)).toContain("betfair");
    const bf = e.sourceSnapshot.find((s) => s.sourceId === "betfair");
    expect(bf?.meta).toBeDefined();
  });

  it("kraschar inte på tom candidate-lista", () => {
    const r = runShadow({ pinnacle, candidates: [], now });
    expect(r.entries).toHaveLength(0);
    expect(r.stats.matched).toBe(0);
  });

  it("parseBetfairRowsMap tom/saknad → tom map", () => {
    expect(parseBetfairRowsMap({}).size).toBe(0);
    expect(parseBetfairRowsMap(null).size).toBe(0);
  });

  it("parseBetfairRowsMap läser riktig skrap-form (ParsedBetfairEvent) → team-bucket-nyckel", () => {
    const bfJson = {
      events: {
        "35506808": {
          betfairEventId: "35506808", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, competition: null,
          markets: [
            { marketId: "1.25", sport: "football", marketType: "MATCH_ODDS", scope: "full", matchedVolume: 94723, runners: [
              { selection: "HOME", backOdds: 2.0, layOdds: 2.02, backDepth: 5000, layDepth: 4800 },
              { selection: "DRAW", backOdds: 3.5, layOdds: 3.55, backDepth: 3000, layDepth: 2900 },
              { selection: "AWAY", backOdds: 3.9, layOdds: 3.95, backDepth: 2500, layDepth: 2400 },
            ] },
          ],
        },
      },
    };
    const map = parseBetfairRowsMap(bfJson);
    expect(map.size).toBe(1);
    const m = [...map.values()][0];
    expect(m.marketType).toBe("MATCH_ODDS");
    expect(m.runners).toHaveLength(3);
  });

  it("Betfair matchar Pinnacle order-oberoende (lag i omvänd ordning)", () => {
    // Betfair listar "Sevilla v Real Madrid" (omvänt mot Pinnacle) → måste ändå
    // matcha + reorienteras så Pinnacle-HOME jämförs mot Betfair-samma-lag.
    const bfJson = {
      events: {
        E: {
          betfairEventId: "E", homeTeam: "Sevilla", awayTeam: "Real Madrid", startTime: START, competition: null,
          markets: [
            { marketId: "1.9", sport: "football", marketType: "MATCH_ODDS", scope: "full", matchedVolume: 120000, runners: [
              { selection: "HOME", backOdds: 3.9, layOdds: 3.95, backDepth: 2500, layDepth: 2400 },
              { selection: "DRAW", backOdds: 3.5, layOdds: 3.55, backDepth: 3000, layDepth: 2900 },
              { selection: "AWAY", backOdds: 2.0, layOdds: 2.02, backDepth: 5000, layDepth: 4800 },
            ] },
          ],
        },
      },
    };
    const betfairMarkets = parseBetfairRowsMap(bfJson);
    const r = runShadow({ pinnacle, candidates, now, betfairMarkets });
    const e = r.entries[0];
    expect(e.sourceSnapshot.map((s) => s.sourceId)).toContain("betfair");
  });

  it("med sbobet → sbobet läggs in som andra sharp-källa", () => {
    const sbobetJson = {
      events: {
        EV1: {
          sbobetEventId: "EV1", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, competition: "La Liga",
          markets: [
            { oddsId: "57", marketType: "ML_1X2", scope: "full", runners: [
              { selection: "HOME", decimalOdds: 1.9 }, { selection: "DRAW", decimalOdds: 3.6 }, { selection: "AWAY", decimalOdds: 4.1 },
            ] },
          ],
        },
      },
    };
    const sbobet = parseSbobetRowsMap(sbobetJson);
    expect(sbobet.size).toBe(1);
    const r = runShadow({ pinnacle, candidates, now, sbobet });
    const e = r.entries[0];
    expect(e.sourceSnapshot.map((s) => s.sourceId)).toContain("sbobet");
  });

  it("totals/AH-kandidater prissätts mot Pinnacle-stegen (line-matching)", async () => {
    const { parsePinnacleLineLadders } = await import("./pinnacleLines.ts");
    const americanToDecimal = (a: number) => (a > 0 ? a / 100 + 1 : 100 / Math.abs(a) + 1);
    // Pinnacle med soccer total 2.5 + spread -0.5 för matchupId 1001 (Real Madrid–Sevilla).
    const pinLinesJson = {
      bySport: { soccer: { markets: [
        { matchupId: 1001, type: "total", period: 0, limit: 5000, prices: [{ designation: "over", price: -105, points: 2.5 }, { designation: "under", price: -105, points: 2.5 }] },
        { matchupId: 1001, type: "spread", period: 0, limit: 5000, prices: [{ designation: "home", price: -110, points: -0.5 }, { designation: "away", price: -110, points: 0.5 }] },
      ] } },
    };
    const pinnacleLines = parsePinnacleLineLadders(pinLinesJson, "soccer");
    // Candidate (comeon) med ETT totals- och ETT AH-erbjudande på samma linjer.
    const cand = parseSoftBook({ byFranchise: { S: { bookmaker: "comeon", events: [
      { eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START,
        odds: { home: 2.15, draw: 3.6, away: 4.2 },
        totals: [{ line: 2.5, over: 2.10, under: 1.80 }],
        ah: [{ line: -0.5, home: 2.05, away: 1.85 }] }] } } }, "comeon", "S");
    expect(cand[0].totals).toHaveLength(1);
    expect(cand[0].ah).toHaveLength(1);
    const r = runShadow({ pinnacle, candidates: cand, now, pinnacleLines });
    // 3 (1X2) + 2 (totals over/under) + 2 (AH home/away) = 7 beslut.
    expect(r.entries.length).toBe(7);
    const totalsEntry = r.entries.find((e) => e.marketType === "TOTAL" && e.selection === "OVER");
    expect(totalsEntry).toBeDefined();
    expect(totalsEntry!.line).toBe(2.5);
    const ahEntry = r.entries.find((e) => e.marketType === "AH" && e.selection === "HOME");
    expect(ahEntry!.line).toBe(-0.5);
    // Sanity: Pinnacle 2.5-linjen är ~50% → Over @2.10 ger positiv edge.
    void americanToDecimal;
  });

  it("SBOBET AH-stege blandas in i AH-fair-price (pinnacle+sbobet)", async () => {
    const { parsePinnacleLineLadders } = await import("./pinnacleLines.ts");
    // Pinnacle med AH spread -0.5 för matchupId 1001 (Real Madrid–Sevilla).
    const pinLinesJson = { bySport: { soccer: { markets: [
      { matchupId: 1001, type: "spread", period: 0, limit: 5000, prices: [{ designation: "home", price: -110, points: -0.5 }, { designation: "away", price: -110, points: 0.5 }] },
    ] } } };
    const pinnacleLines = parsePinnacleLineLadders(pinLinesJson, "soccer");
    // Candidate (comeon) med ETT AH-erbjudande på -0.5.
    const cand = parseSoftBook({ byFranchise: { S: { bookmaker: "comeon", events: [
      { eventId: "9", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START,
        odds: { home: 2.15, draw: 3.6, away: 4.2 }, ah: [{ line: -0.5, home: 2.05, away: 1.85 }] }] } } }, "comeon", "S");
    // SBOBET AH-stege på samma event (-0.5-linjen).
    const sbobetAh = parseSbobetAhRowsMap({ events: { E: {
      sbobetEventId: "E", homeTeam: "Real Madrid", awayTeam: "Sevilla", startTime: START, competition: null,
      markets: [{ oddsId: "1", marketType: "AH", scope: "full", line: -0.5, runners: [{ selection: "HOME", decimalOdds: 2.0 }, { selection: "AWAY", decimalOdds: 1.9 }] }] } } });
    expect(sbobetAh.size).toBe(1);
    const r = runShadow({ pinnacle, candidates: cand, now, pinnacleLines, sbobetAh });
    const ahEntry = r.entries.find((e) => e.marketType === "AH" && e.selection === "HOME");
    expect(ahEntry).toBeDefined();
    // Pinnacle förblir ankaret men SBOBET blandas in → källan namnges pinnacle+sbobet.
    expect(ahEntry!.benchmarkSource).toContain("sbobet");
  });

  it("kastad lag-ordning: candidaten reorienteras → rätt lag jämförs (1X2)", () => {
    // Pinnacle: Real Madrid (hemma) v Sevilla (borta). Candidate listar KASTAT.
    const swapped = parseSoftBook({ events: [
      { eventId: "s1", homeTeam: "Sevilla", awayTeam: "Real Madrid", startTime: START, odds: { home: 4.0, draw: 3.6, away: 1.95 } },
    ] }, "comeon");
    const r = runShadow({ pinnacle, candidates: swapped, now });
    expect(r.stats.matched).toBe(1); // matchar trots kastad ordning
    const homeEntry = r.entries.find((e) => e.marketType === "ML_1X2" && e.selection === "HOME");
    // Pinnacle-HOME = Real Madrid = candidatens BORTA-odds (1.95) efter reorientering.
    expect(homeEntry!.candidateOdds).toBe(1.95);
    const awayEntry = r.entries.find((e) => e.marketType === "ML_1X2" && e.selection === "AWAY");
    expect(awayEntry!.candidateOdds).toBe(4.0); // Pinnacle-AWAY = Sevilla = candidatens HEMMA
  });

  it("kastad lag-ordning: AH-linjen negeras + home/away byts (samma alternativ)", async () => {
    const { parsePinnacleLineLadders } = await import("./pinnacleLines.ts");
    const pinLinesJson = { bySport: { soccer: { markets: [
      { matchupId: 1001, type: "spread", period: 0, limit: 5000, prices: [{ designation: "home", price: -110, points: -0.5 }, { designation: "away", price: -110, points: 0.5 }] },
    ] } } };
    const pinnacleLines = parsePinnacleLineLadders(pinLinesJson, "soccer");
    // Candidate KASTAT: Sevilla (hemma) v Real Madrid; Sevilla +0.5 = Real Madrid -0.5.
    const swapped = parseSoftBook({ events: [
      { eventId: "s1", homeTeam: "Sevilla", awayTeam: "Real Madrid", startTime: START,
        odds: { home: 4.0, draw: 3.6, away: 1.95 }, ah: [{ line: 0.5, home: 1.85, away: 2.05 }] },
    ] }, "comeon");
    const r = runShadow({ pinnacle, candidates: swapped, now, pinnacleLines });
    const ahHome = r.entries.find((e) => e.marketType === "AH" && e.selection === "HOME");
    expect(ahHome).toBeDefined();
    expect(ahHome!.line).toBe(-0.5); // reorienterat till Pinnacle-hemma (Real Madrid) -0.5
    expect(ahHome!.candidateOdds).toBe(2.05); // Real Madrid-odds (candidatens AH-borta)
  });

  it("parseSbobetRowsMap hoppar över event utan komplett 1X2", () => {
    const partial = { events: { E: { sbobetEventId: "E", homeTeam: "A", awayTeam: "B", startTime: START, competition: null,
      markets: [{ oddsId: "1", marketType: "ML_1X2", scope: "full", runners: [{ selection: "HOME", decimalOdds: 2 }] }] } } };
    expect(parseSbobetRowsMap(partial).size).toBe(0);
    expect(parseSbobetRowsMap({}).size).toBe(0);
  });
});
