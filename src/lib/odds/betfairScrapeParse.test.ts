/**
 * Tester för Betfair-skrap-parsern (RÅ API-NG → BetfairMarket).
 */

import { describe, it, expect } from "vitest";
import {
  parseEventName,
  parseOneMarket,
  parseBetfairMarkets,
  parseBymarketBodies,
  toBetfairRowsFile,
  type RawMarketCatalogue,
  type RawMarketBook,
} from "./betfairScrapeParse.ts";

describe("parseBymarketBodies — publik readonly-feed (eventTypes-form)", () => {
  const body = {
    currencyCode: "GBP",
    eventTypes: [{ eventTypeId: 1, eventNodes: [{
      eventId: 35506808,
      event: { eventName: "Colombia v DR Congo", openDate: "2026-06-24T02:00:00.000Z" },
      marketNodes: [{
        marketId: "1.256996345",
        state: { status: "OPEN", totalMatched: 94723.1, inplay: false },
        description: { marketName: "Match Odds", marketType: "MATCH_ODDS" },
        runners: [
          { selectionId: 15299, description: { runnerName: "Colombia" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 1.58, size: 1758.58 }], availableToLay: [{ price: 1.59, size: 2944.97 }] } },
          { selectionId: 85303, description: { runnerName: "DR Congo" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 7.6, size: 146.96 }], availableToLay: [{ price: 7.8, size: 1353.33 }] } },
          { selectionId: 58805, description: { runnerName: "The Draw" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 4.2, size: 129.12 }], availableToLay: [{ price: 4.3, size: 4443.98 }] } },
        ],
      }],
    }] }],
  };

  it("mappar runners → HOME/AWAY/DRAW med back/lay + djup + matchad volym", () => {
    const evs = parseBymarketBodies([body]);
    expect(evs).toHaveLength(1);
    const e = evs[0];
    expect(e.betfairEventId).toBe("35506808");
    expect(e.homeTeam).toBe("Colombia");
    expect(e.awayTeam).toBe("DR Congo");
    const m = e.markets[0];
    expect(m.marketType).toBe("MATCH_ODDS");
    expect(m.matchedVolume).toBeCloseTo(94723.1, 1);
    const home = m.runners.find((r) => r.selection === "HOME")!;
    expect(home.backOdds).toBe(1.58);
    expect(home.layOdds).toBe(1.59);
    expect(home.backDepth).toBe(1758.58);
    expect(m.runners.map((r) => r.selection).sort()).toEqual(["AWAY", "DRAW", "HOME"]);
  });

  it("parsar OVER_UNDER → TOTALS (linje ur marketName) + ASIAN_HANDICAP → AH (linje ur handicap)", () => {
    const body2 = {
      eventTypes: [{ eventNodes: [{
        eventId: 9001,
        event: { eventName: "Arsenal v Chelsea", openDate: "2026-06-25T19:00:00.000Z" },
        marketNodes: [
          {
            marketId: "1.111", state: { status: "OPEN", totalMatched: 50000 },
            description: { marketName: "Over/Under 2.5 Goals", marketType: "OVER_UNDER_25" },
            runners: [
              { selectionId: 1, handicap: 0, description: { runnerName: "Under 2.5 Goals" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 1.9, size: 1000 }], availableToLay: [{ price: 1.95, size: 900 }] } },
              { selectionId: 2, handicap: 0, description: { runnerName: "Over 2.5 Goals" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 2.0, size: 1200 }], availableToLay: [{ price: 2.05, size: 1100 }] } },
            ],
          },
          {
            // Mångblinjes AH: samma 2 lag på TVÅ linjer (-0.5 och -1.0) i samma marknad.
            marketId: "1.222", state: { status: "OPEN", totalMatched: 30000 },
            description: { marketName: "Asian Handicap", marketType: "ASIAN_HANDICAP" },
            runners: [
              { selectionId: 3, handicap: -0.5, description: { runnerName: "Arsenal" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 1.8, size: 2000 }], availableToLay: [{ price: 1.82, size: 1900 }] } },
              { selectionId: 4, handicap: 0.5, description: { runnerName: "Chelsea" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 2.1, size: 1500 }], availableToLay: [{ price: 2.14, size: 1400 }] } },
              { selectionId: 5, handicap: -1.0, description: { runnerName: "Arsenal" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 2.4, size: 1000 }], availableToLay: [{ price: 2.46, size: 900 }] } },
              { selectionId: 6, handicap: 1.0, description: { runnerName: "Chelsea" }, state: { status: "ACTIVE" }, exchange: { availableToBack: [{ price: 1.6, size: 1700 }], availableToLay: [{ price: 1.62, size: 1600 }] } },
            ],
          },
        ],
      }] }],
    };
    const evs = parseBymarketBodies([body2]);
    expect(evs).toHaveLength(1);
    const markets = evs[0].markets;
    const tot = markets.find((m) => m.marketType === "TOTALS")!;
    expect(tot.line).toBe(2.5);
    expect(tot.scope).toBe("match_total");
    expect(tot.runners.map((r) => r.selection).sort()).toEqual(["OVER", "UNDER"]);
    const ahs = markets.filter((m) => m.marketType === "AH").sort((a, b) => (b.line ?? 0) - (a.line ?? 0));
    expect(ahs).toHaveLength(2); // två linjer ur EN mångblinjes AH-marknad
    expect(ahs.map((m) => m.line)).toEqual([-0.5, -1.0]); // hemma-perspektiv
    const ah05 = ahs.find((m) => m.line === -0.5)!;
    expect(ah05.runners.find((r) => r.selection === "HOME")!.backOdds).toBe(1.8);
    expect(ah05.runners.find((r) => r.selection === "AWAY")!.backOdds).toBe(2.1);
    const ah10 = ahs.find((m) => m.line === -1.0)!;
    expect(ah10.runners.find((r) => r.selection === "HOME")!.backOdds).toBe(2.4);
  });

  it("hoppar över suspenderade marknader + tomma kroppar", () => {
    const suspended = { eventTypes: [{ eventNodes: [{ eventId: 1, event: { eventName: "A v B", openDate: "x" }, marketNodes: [{ marketId: "1.1", state: { status: "SUSPENDED" }, description: { marketType: "MATCH_ODDS" }, runners: [] }] }] }] };
    expect(parseBymarketBodies([suspended])).toHaveLength(0);
    expect(parseBymarketBodies([{}])).toHaveLength(0);
  });
});

const matchOddsCat: RawMarketCatalogue = {
  marketId: "1.111",
  marketName: "Match Odds",
  totalMatched: 250000,
  event: { id: "30001", name: "Real Madrid v Sevilla", openDate: "2026-06-25T19:00:00.000Z" },
  competition: { name: "La Liga" },
  runners: [
    { selectionId: 1, runnerName: "Real Madrid" },
    { selectionId: 2, runnerName: "Sevilla" },
    { selectionId: 3, runnerName: "The Draw" },
  ],
};
const matchOddsBook: RawMarketBook = {
  marketId: "1.111",
  status: "OPEN",
  totalMatched: 250000,
  runners: [
    { selectionId: 1, status: "ACTIVE", ex: { availableToBack: [{ price: 2.0, size: 5000 }], availableToLay: [{ price: 2.02, size: 4800 }] } },
    { selectionId: 2, status: "ACTIVE", ex: { availableToBack: [{ price: 3.9, size: 2500 }], availableToLay: [{ price: 3.95, size: 2400 }] } },
    { selectionId: 3, status: "ACTIVE", ex: { availableToBack: [{ price: 3.5, size: 3000 }], availableToLay: [{ price: 3.55, size: 2900 }] } },
  ],
};

describe("parseEventName", () => {
  it("'Home v Away' → home/away", () => {
    expect(parseEventName("Real Madrid v Sevilla")).toEqual({ home: "Real Madrid", away: "Sevilla" });
  });
  it("'Away @ Home' → away först", () => {
    expect(parseEventName("Lakers @ Celtics")).toEqual({ home: "Celtics", away: "Lakers" });
  });
  it("okänt format → null", () => {
    expect(parseEventName("nonsense")).toBeNull();
  });
});

describe("parseOneMarket — Match Odds", () => {
  it("parsar komplett 1X2 med djup", () => {
    const r = parseOneMarket(matchOddsCat, matchOddsBook);
    expect(r).not.toBeNull();
    expect(r!.market.marketType).toBe("MATCH_ODDS");
    expect(r!.market.runners).toHaveLength(3);
    expect(r!.market.runners.find((x) => x.selection === "HOME")!.backOdds).toBe(2.0);
    expect(r!.market.runners.find((x) => x.selection === "DRAW")!.layOdds).toBe(3.55);
    expect(r!.identity.homeTeam).toBe("Real Madrid");
    expect(r!.market.matchedVolume).toBe(250000);
  });

  it("släpper marknad om en runner saknar djup (ingen halvdata)", () => {
    const book: RawMarketBook = {
      ...matchOddsBook,
      runners: [
        matchOddsBook.runners[0],
        { selectionId: 2, status: "ACTIVE", ex: { availableToBack: [], availableToLay: [] } }, // tom
        matchOddsBook.runners[2],
      ],
    };
    expect(parseOneMarket(matchOddsCat, book)).toBeNull();
  });
});

describe("parseOneMarket — Over/Under", () => {
  it("parsar totals med line", () => {
    const cat: RawMarketCatalogue = {
      marketId: "1.222", marketName: "Over/Under 2.5 Goals", totalMatched: 80000,
      event: { id: "30001", name: "Real Madrid v Sevilla", openDate: "2026-06-25T19:00:00.000Z" },
      runners: [{ selectionId: 10, runnerName: "Over 2.5 Goals" }, { selectionId: 11, runnerName: "Under 2.5 Goals" }],
    };
    const book: RawMarketBook = {
      marketId: "1.222", status: "OPEN", totalMatched: 80000,
      runners: [
        { selectionId: 10, status: "ACTIVE", ex: { availableToBack: [{ price: 1.95, size: 3000 }], availableToLay: [{ price: 1.97, size: 2900 }] } },
        { selectionId: 11, status: "ACTIVE", ex: { availableToBack: [{ price: 1.95, size: 3000 }], availableToLay: [{ price: 1.97, size: 2900 }] } },
      ],
    };
    const r = parseOneMarket(cat, book);
    expect(r!.market.marketType).toBe("TOTALS");
    expect(r!.market.line).toBe(2.5);
    expect(r!.market.scope).toBe("match_total");
  });
});

describe("parseBetfairMarkets — gruppering", () => {
  it("grupperar marknader per event och hoppar över ej-OPEN", () => {
    const closed: RawMarketBook = { ...matchOddsBook, marketId: "1.999", status: "SUSPENDED" };
    const closedCat: RawMarketCatalogue = { ...matchOddsCat, marketId: "1.999" };
    const events = parseBetfairMarkets([matchOddsCat, closedCat], [matchOddsBook, closed]);
    expect(events).toHaveLength(1);
    expect(events[0].markets).toHaveLength(1);
    expect(events[0].betfairEventId).toBe("30001");
  });

  it("toBetfairRowsFile nycklar per betfairEventId", () => {
    const events = parseBetfairMarkets([matchOddsCat], [matchOddsBook]);
    const file = toBetfairRowsFile(events);
    expect(Object.keys(file.events)).toContain("30001");
    expect(file.source).toContain("scrape");
  });
});
