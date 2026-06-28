/**
 * Tester för SBOBET-DOM-parsern (rå onPrice-rader → SbobetMarket/event).
 * Exempeldata speglar de faktiska onPrice-värdena vi extraherade i probe-
 * körningen (Argentina–Österrike: 1X2 1.47/4.20/7.40).
 */

import { describe, it, expect } from "vitest";
import {
  parseOneSbobetMarket,
  parseSbobetMarkets,
  toSbobetRowsFile,
  type SbobetRawOdds,
} from "./sbobetScrapeParse.ts";

const ctx = { homeTeam: "Argentina", awayTeam: "Austria", league: "Friendly", startTime: "2026-06-25T19:00:00.000Z", eventId: "EV1" };

const oneXtwo: SbobetRawOdds[] = [
  { oddsId: "572125529", market: "1", price: 1.47, ...ctx },
  { oddsId: "572125529", market: "x", price: 4.2, ...ctx },
  { oddsId: "572125529", market: "2", price: 7.4, ...ctx },
];
const ah: SbobetRawOdds[] = [
  { oddsId: "693904577", market: "h", price: 1.49, handicapLine: -1.5, ...ctx },
  { oddsId: "693904577", market: "a", price: 2.35, handicapLine: -1.5, ...ctx },
];

describe("parseOneSbobetMarket — 1X2", () => {
  it("bygger komplett 1X2", () => {
    const m = parseOneSbobetMarket("572125529", oneXtwo);
    expect(m).not.toBeNull();
    expect(m!.marketType).toBe("ML_1X2");
    expect(m!.runners).toHaveLength(3);
    expect(m!.runners.find((r) => r.selection === "HOME")!.decimalOdds).toBe(1.47);
    expect(m!.runners.find((r) => r.selection === "AWAY")!.decimalOdds).toBe(7.4);
  });

  it("släpper ofullständig 1X2 (saknar draw)", () => {
    expect(parseOneSbobetMarket("572125529", oneXtwo.slice(0, 2))).toBeNull();
  });

  it("släpper pris ≤ 1", () => {
    const bad = oneXtwo.map((r) => (r.market === "1" ? { ...r, price: 1 } : r));
    expect(parseOneSbobetMarket("572125529", bad)).toBeNull();
  });
});

describe("parseOneSbobetMarket — AH", () => {
  it("bygger AH med linje ur hemma-perspektiv", () => {
    const m = parseOneSbobetMarket("693904577", ah);
    expect(m!.marketType).toBe("AH");
    expect(m!.line).toBe(-1.5);
    expect(m!.runners).toHaveLength(2);
    expect(m!.runners.find((r) => r.selection === "HOME")!.decimalOdds).toBe(1.49);
  });

  it("släpper AH utan linje (ingen halvdata)", () => {
    const noLine = ah.map(({ handicapLine, ...rest }) => rest);
    expect(parseOneSbobetMarket("693904577", noLine)).toBeNull();
  });

  it("släpper AH som saknar ena sidan", () => {
    expect(parseOneSbobetMarket("693904577", ah.slice(0, 1))).toBeNull();
  });
});

describe("parseSbobetMarkets — gruppering per event", () => {
  it("slår ihop 1X2 + AH till ETT event", () => {
    const events = parseSbobetMarkets([...oneXtwo, ...ah]);
    expect(events).toHaveLength(1);
    expect(events[0].homeTeam).toBe("Argentina");
    expect(events[0].markets).toHaveLength(2);
    expect(events[0].markets.map((m) => m.marketType).sort()).toEqual(["AH", "ML_1X2"]);
  });

  it("separerar två olika matcher", () => {
    const other: SbobetRawOdds[] = [
      { oddsId: "999", market: "1", price: 2.1, homeTeam: "Spain", awayTeam: "Italy", startTime: "2026-06-26T19:00:00.000Z", eventId: "EV2" },
      { oddsId: "999", market: "x", price: 3.3, homeTeam: "Spain", awayTeam: "Italy", startTime: "2026-06-26T19:00:00.000Z", eventId: "EV2" },
      { oddsId: "999", market: "2", price: 3.5, homeTeam: "Spain", awayTeam: "Italy", startTime: "2026-06-26T19:00:00.000Z", eventId: "EV2" },
    ];
    const events = parseSbobetMarkets([...oneXtwo, ...other]);
    expect(events).toHaveLength(2);
  });

  it("släpper rader utan identitet", () => {
    const noIdentity: SbobetRawOdds[] = [
      { oddsId: "555", market: "1", price: 1.8 },
      { oddsId: "555", market: "x", price: 3.4 },
      { oddsId: "555", market: "2", price: 4.0 },
    ];
    expect(parseSbobetMarkets(noIdentity)).toHaveLength(0);
  });

  it("toSbobetRowsFile nycklar per sbobetEventId", () => {
    const events = parseSbobetMarkets([...oneXtwo, ...ah]);
    const file = toSbobetRowsFile(events);
    expect(Object.keys(file.events)).toContain("EV1");
    expect(file.source).toContain("scrape");
  });
});
