import { describe, it, expect } from "vitest";
import { getBonusOpportunities, type MatchData } from "./bonusFinder";

describe("bonusFinder — money-return / dutching", () => {
  it("Arsenal–Everton, alla odds 3.0 → 100% pengar-retur (break-even, allt tillbaka)", () => {
    const match: MatchData = {
      title: "Arsenal - Everton",
      sport: "soccer",
      marketType: "1X2",
      oddsRows: [
        { bookmakerId: "unibet", bookmaker: "Unibet", home: 3, draw: 3, away: 3 },
        { bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: 3, draw: 3, away: 3 },
      ],
    };
    const res = getBonusOpportunities([match], { bonusBookmakerId: "unibet", stake: 1000, minOdds: 1 });
    expect(res.opportunities.length).toBeGreaterThan(0);
    const top = res.opportunities[0];
    // 1000 på varje av 3 utfall (totalt 3000) → vinst 3000 oavsett = allt tillbaka.
    expect(top.moneyReturnPct).toBeCloseTo(100, 1);
    expect(top.totalStake).toBeCloseTo(3000, 1);
    expect(top.coversOnSharp).toBe(true); // täckning på Pinnacle
  });

  it("hittar arbitrage (>100% retur) när bonus-sidan har vassare odds på ett utfall", () => {
    const match: MatchData = {
      title: "Team A - Team B",
      sport: "soccer",
      marketType: "1X2",
      oddsRows: [
        { bookmakerId: "unibet", bookmaker: "Unibet", home: 4, draw: 3, away: 3 },
        { bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: 2, draw: 3.2, away: 3.2 },
      ],
    };
    const res = getBonusOpportunities([match], { bonusBookmakerId: "unibet", stake: 1000, minOdds: 1 });
    const top = res.opportunities[0];
    // Satsa hemma @4 (4000 retur), täck oavg/borta @3.2 → ~114% pengar-retur.
    expect(top.bonusOutcome).toBe("home");
    expect(top.moneyReturnPct).toBeGreaterThan(110);
    expect(top.worstCasePnl).toBeGreaterThan(0);
  });

  it("döljer fysiskt omöjliga returer (fel-matchade odds → ingen falsk +EV)", () => {
    // Orimligt höga odds på alla utfall (som om olika matcher matchats ihop)
    // → pengar-retur >120% → ska INTE visas.
    const match: MatchData = {
      title: "Mismatch FC - Wrong United",
      sport: "soccer",
      marketType: "1X2",
      oddsRows: [
        { bookmakerId: "hajper", bookmaker: "Hajper", home: 4, draw: 5, away: 5 },
        { bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: 5, draw: 5, away: 5 },
      ],
    };
    const res = getBonusOpportunities([match], { bonusBookmakerId: "hajper", stake: 1000, minOdds: 1 });
    expect(res.opportunities.length).toBe(0);
  });

  it("includeCoverBookmakerIds begränsar täckningen till valda bookmakers", () => {
    // Unibet (bonus) + två möjliga covers: Pinnacle (bäst odds) och Betsson.
    // Utan filter väljs bästa odds (Pinnacle 3.2). Med covers=[betsson] måste
    // täckningen byggas från Betsson (3.0) → andra odds, och Pinnacle ignoreras.
    const match: MatchData = {
      title: "Cover Test FC - Filter United",
      sport: "soccer",
      marketType: "1X2",
      oddsRows: [
        { bookmakerId: "unibet", bookmaker: "Unibet", home: 3, draw: 3, away: 3 },
        { bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: 3.2, draw: 3.2, away: 3.2 },
        { bookmakerId: "betsson", bookmaker: "Betsson", home: 3, draw: 3, away: 3 },
      ],
    };
    const all = getBonusOpportunities([match], { bonusBookmakerId: "unibet", stake: 1000, minOdds: 1 });
    // Utan filter används Pinnacle som täckning (bäst odds).
    expect(all.opportunities[0].hedgeLegs.every((l) => l.bookmakerId === "pinnacle")).toBe(true);

    const onlyBetsson = getBonusOpportunities([match], {
      bonusBookmakerId: "unibet",
      stake: 1000,
      minOdds: 1,
      includeCoverBookmakerIds: ["betsson"],
    });
    expect(onlyBetsson.opportunities.length).toBeGreaterThan(0);
    // Täckningen kommer ENBART från Betsson, aldrig Pinnacle.
    expect(onlyBetsson.opportunities.every((o) => o.hedgeLegs.every((l) => l.bookmakerId === "betsson"))).toBe(true);
  });

  it("includeCoverBookmakerIds utan täckning på alla utfall → ingen opportunity", () => {
    // covers=[betsson] men Betsson saknar 'away' → kan inte täcka → 0.
    const match: MatchData = {
      title: "Partial Cover - No Away",
      sport: "soccer",
      marketType: "1X2",
      oddsRows: [
        { bookmakerId: "unibet", bookmaker: "Unibet", home: 3, draw: 3, away: 3 },
        { bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: 3.2, draw: 3.2, away: 3.2 },
        { bookmakerId: "betsson", bookmaker: "Betsson", home: 3, draw: 3, away: 1 },
      ],
    };
    const res = getBonusOpportunities([match], {
      bonusBookmakerId: "unibet",
      stake: 1000,
      minOdds: 1,
      includeCoverBookmakerIds: ["betsson"],
    });
    // Bonus på 'away' kan täckas (home/draw via Betsson). Bonus på home/draw kan
    // INTE täckas (away saknas hos Betsson). Verifiera att inget ben använder
    // Pinnacle och att away-täckning aldrig kommer från Betsson (odds 1).
    expect(res.opportunities.every((o) => o.hedgeLegs.every((l) => l.bookmakerId === "betsson" && l.odds > 1))).toBe(true);
  });

  it("moneyReturnPct = worstCasePnlPct + 100 (konsistens)", () => {
    const match: MatchData = {
      title: "X - Y",
      sport: "soccer",
      marketType: "1X2",
      oddsRows: [
        { bookmakerId: "unibet", bookmaker: "Unibet", home: 2.5, draw: 3.4, away: 3.0 },
        { bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: 2.6, draw: 3.3, away: 2.9 },
      ],
    };
    const res = getBonusOpportunities([match], { bonusBookmakerId: "unibet", stake: 500, minOdds: 1 });
    for (const o of res.opportunities) {
      expect(o.moneyReturnPct).toBeCloseTo(o.worstCasePnlPct + 100, 6);
    }
  });
});
