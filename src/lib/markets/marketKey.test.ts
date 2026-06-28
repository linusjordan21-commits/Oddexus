import { describe, it, expect } from "vitest";
import {
  buildMarketKey,
  canonicalMarketType,
  marketMismatchRisk,
  normalizeLeague,
  normalizeSport,
  type MarketKeyParts,
} from "./marketKey.ts";

const base: MarketKeyParts = {
  sport: "football",
  league: "Premier League",
  eventId: null,
  homeTeam: "Manchester City FC",
  awayTeam: "Liverpool F.C.",
  startTime: "2026-07-01T18:00:00.000Z",
  marketType: "1x2",
  period: "ft",
  line: null,
  selection: "HOME",
};

const key = (p: Partial<MarketKeyParts>) => buildMarketKey({ ...base, ...p });

describe("market_key — stabilitet (samma marknad → samma key)", () => {
  it("identiska delar ger identisk key", () => {
    expect(key({})).toBe(key({}));
  });
  it("lagnamns-varianter (FC-suffix/diakritiker) normaliseras till samma key", () => {
    const a = key({ homeTeam: "Manchester City", awayTeam: "Liverpool" });
    const b = key({ homeTeam: "Manchester City FC", awayTeam: "Liverpool FC" });
    expect(a).toBe(b);
  });
  it("sport-alias soccer/fotboll → football (samma key, ingen fragmentering)", () => {
    expect(normalizeSport("soccer")).toBe("football");
    expect(normalizeSport("Fotboll")).toBe("football");
    expect(normalizeSport("tennis")).toBe("tennis");
    expect(key({ sport: "soccer" })).toBe(key({ sport: "football" }));
    expect(key({ sport: "tennis" })).not.toBe(key({ sport: "football" }));
  });
  // Steg 4-FIX: punkterade akronymer dras ihop i normalizeTeamName (acronym-collapse)
  // → "Liverpool F.C." normaliseras nu till samma som "Liverpool".
  it("punkterad akronym (F.C./A.F.C.) normaliseras nu till samma key", () => {
    expect(key({ awayTeam: "Liverpool" })).toBe(key({ awayTeam: "Liverpool F.C." }));
    expect(key({ homeTeam: "Bournemouth" })).toBe(key({ homeTeam: "A.F.C. Bournemouth" }));
  });
  it("starttid inom samma 30-min-bucket ger samma key", () => {
    const a = key({ startTime: "2026-07-01T18:00:00.000Z" });
    const b = key({ startTime: "2026-07-01T18:05:00.000Z" });
    expect(a).toBe(b);
  });
  it("råa marknadssträngar mappas kanoniskt (match_odds == 1x2)", () => {
    expect(canonicalMarketType("MATCH_ODDS")).toBe("1x2");
    expect(canonicalMarketType("Asian_Handicap")).toBe("ah");
    expect(canonicalMarketType("over_under")).toBe("total");
    expect(normalizeLeague("Première Ligue")).toBe("premiere ligue");
  });
});

describe("market_key — QA: olika marknader får ALDRIG samma key", () => {
  it("AH -0.5 ≠ 1X2", () => {
    expect(key({ marketType: "ah", line: -0.5, selection: "HOME" })).not.toBe(key({ marketType: "1x2", selection: "HOME" }));
  });
  it("moneyline ≠ draw-no-bet", () => {
    expect(key({ marketType: "moneyline", selection: "HOME" })).not.toBe(key({ marketType: "dnb", selection: "HOME" }));
  });
  it("totals 2.5 ≠ Asian totals 2.25 ≠ 2.75", () => {
    const t25 = key({ marketType: "total", line: 2.5, selection: "OVER" });
    const at225 = key({ marketType: "asian_total", line: 2.25, selection: "OVER" });
    const at275 = key({ marketType: "asian_total", line: 2.75, selection: "OVER" });
    expect(t25).not.toBe(at225);
    expect(t25).not.toBe(at275);
    expect(at225).not.toBe(at275);
  });
  it("corner totals ≠ goal totals (samma linje)", () => {
    expect(key({ marketType: "corner_total", line: 9.5, selection: "OVER" })).not.toBe(
      key({ marketType: "total", line: 9.5, selection: "OVER" }),
    );
  });
  it("full time ≠ first half", () => {
    expect(key({ period: "ft" })).not.toBe(key({ period: "fh" }));
  });
  it("home ≠ away ≠ draw", () => {
    const h = key({ selection: "HOME" });
    const a = key({ selection: "AWAY" });
    const d = key({ selection: "DRAW" });
    expect(new Set([h, a, d]).size).toBe(3);
  });
  it("olika starttider (>30 min, annan bucket) ≠ samma key", () => {
    expect(key({ startTime: "2026-07-01T18:00:00.000Z" })).not.toBe(key({ startTime: "2026-07-01T20:00:00.000Z" }));
  });
  it("olika lag ≠ samma key", () => {
    expect(key({ homeTeam: "Arsenal", awayTeam: "Chelsea" })).not.toBe(key({ homeTeam: "Manchester City", awayTeam: "Liverpool" }));
  });
  it("OVER ≠ UNDER på samma total", () => {
    expect(key({ marketType: "total", line: 2.5, selection: "OVER" })).not.toBe(key({ marketType: "total", line: 2.5, selection: "UNDER" }));
  });
});

describe("marketMismatchRisk — flaggar lömska felmatchningar", () => {
  const ah: MarketKeyParts = { ...base, marketType: "ah", line: -0.5, selection: "HOME" };
  const x2: MarketKeyParts = { ...base, marketType: "1x2", line: null, selection: "HOME" };

  it("AH vs 1X2 → MARKET_TYPE_DIFF", () => {
    expect(marketMismatchRisk(ah, x2)).toContain("MARKET_TYPE_DIFF");
  });
  it("moneyline vs DNB → DNB_VS_ML", () => {
    const ml: MarketKeyParts = { ...base, marketType: "moneyline" };
    const dnb: MarketKeyParts = { ...base, marketType: "dnb" };
    expect(marketMismatchRisk(ml, dnb)).toContain("DNB_VS_ML");
  });
  it("total vs asian_total → ASIAN_VS_DECIMAL_TOTAL", () => {
    const t: MarketKeyParts = { ...base, marketType: "total", line: 2.5, selection: "OVER" };
    const at: MarketKeyParts = { ...base, marketType: "asian_total", line: 2.25, selection: "OVER" };
    expect(marketMismatchRisk(t, at)).toContain("ASIAN_VS_DECIMAL_TOTAL");
  });
  it("ft vs fh → PERIOD_DIFF", () => {
    expect(marketMismatchRisk({ ...base, period: "ft" }, { ...base, period: "fh" })).toContain("PERIOD_DIFF");
  });
  it("olika linje → LINE_DIFF", () => {
    const a: MarketKeyParts = { ...base, marketType: "total", line: 2.5, selection: "OVER" };
    const b: MarketKeyParts = { ...base, marketType: "total", line: 3.0, selection: "OVER" };
    expect(marketMismatchRisk(a, b)).toContain("LINE_DIFF");
  });
  it("home/away-byte → SELECTION_SIDE_DIFF", () => {
    expect(marketMismatchRisk({ ...base, selection: "HOME" }, { ...base, selection: "AWAY" })).toContain("SELECTION_SIDE_DIFF");
  });
  it("olika lag → TEAMS_DIFF", () => {
    const a: MarketKeyParts = { ...base, homeTeam: "Arsenal", awayTeam: "Chelsea" };
    expect(marketMismatchRisk(a, base)).toContain("TEAMS_DIFF");
  });
  it("olika starttid (>1h) → START_TIME_DIFF", () => {
    const a: MarketKeyParts = { ...base, startTime: "2026-07-01T18:00:00.000Z" };
    const b: MarketKeyParts = { ...base, startTime: "2026-07-01T21:00:00.000Z" };
    expect(marketMismatchRisk(a, b)).toContain("START_TIME_DIFF");
  });
  it("identiska marknader → ingen risk", () => {
    expect(marketMismatchRisk(base, { ...base })).toEqual([]);
  });
});
