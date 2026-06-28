import { describe, it, expect } from "vitest";
import {
  splitMatch,
  mapMarket,
  groupByMarketKey,
  deriveSignalId,
  buildSignalRecord,
  buildSnapshotRecord,
  valueBetToMarketKeyParts,
  classifyDataQuality,
  computeTrustFlags,
  computeLiquidityScore,
  computeSharpConsensus,
  computeRecommendation,
  type ValueBetLike,
} from "./signalMapping.ts";
import { buildMarketKey } from "../markets/marketKey.ts";

const vb = (over: Partial<ValueBetLike>): ValueBetLike => ({
  match: "Liverpool - Arsenal",
  startTs: "2026-07-01T18:00:00.000Z",
  league: "Premier League",
  sport: "football",
  market: "moneyline",
  outcome: "1",
  line: null,
  bookmakerName: "Coolbet",
  bookmakerOdds: 2.1,
  fairProb: 0.5,
  fairOdds: 2.0,
  ev: 0.05,
  evPct: 5,
  ...over,
});

describe("signalMapping — parsing", () => {
  it("splitMatch hanterar olika separatorer", () => {
    expect(splitMatch("Liverpool - Arsenal")).toEqual({ home: "Liverpool", away: "Arsenal" });
    expect(splitMatch("Liverpool vs Arsenal")).toEqual({ home: "Liverpool", away: "Arsenal" });
  });
  it("mapMarket: football moneyline → 1x2 + HOME/DRAW/AWAY", () => {
    expect(mapMarket(vb({ market: "moneyline", outcome: "1" }))).toEqual({ marketType: "1x2", selection: "HOME" });
    expect(mapMarket(vb({ market: "moneyline", outcome: "x" }))).toEqual({ marketType: "1x2", selection: "DRAW" });
    expect(mapMarket(vb({ market: "total", outcome: "over" }))).toEqual({ marketType: "total", selection: "OVER" });
    expect(mapMarket(vb({ market: "ah", outcome: "ah_away" }))).toEqual({ marketType: "ah", selection: "AWAY" });
  });
  it("basket moneyline → moneyline (ej 1x2)", () => {
    expect(mapMarket(vb({ sport: "basketball", market: "moneyline", outcome: "2" }))).toEqual({ marketType: "moneyline", selection: "AWAY" });
  });
});

describe("signalMapping — sport-normalisering (football/soccer-fragmentering)", () => {
  // KRAV: inget får hamna i fel market_type pga sportnamn, och samma match får
  // aldrig två sport-prefix (football|… vs soccer|…).
  it("football/soccer/utelämnad sport 3-way → 1x2", () => {
    expect(mapMarket(vb({ sport: "football", market: "moneyline", outcome: "1" })).marketType).toBe("1x2");
    expect(mapMarket(vb({ sport: "soccer", market: "moneyline", outcome: "1" })).marketType).toBe("1x2");
    expect(mapMarket(vb({ sport: undefined, market: "moneyline", outcome: "1" })).marketType).toBe("1x2");
  });
  it("äkta 2-way-sporter → moneyline", () => {
    expect(mapMarket(vb({ sport: "tennis", market: "moneyline", outcome: "2" })).marketType).toBe("moneyline");
    expect(mapMarket(vb({ sport: "basketball", market: "moneyline", outcome: "2" })).marketType).toBe("moneyline");
  });
  it("AH för football/soccer → ah", () => {
    expect(mapMarket(vb({ sport: "football", market: "ah", outcome: "ah_home" })).marketType).toBe("ah");
    expect(mapMarket(vb({ sport: "soccer", market: "ah", outcome: "ah_home" })).marketType).toBe("ah");
  });
  it("totals för football/soccer → total", () => {
    expect(mapMarket(vb({ sport: "football", market: "total", outcome: "over" })).marketType).toBe("total");
    expect(mapMarket(vb({ sport: "soccer", market: "total", outcome: "over" })).marketType).toBe("total");
  });
  it("samma match: 1x2 (sport saknas) + total (sport=soccer) får SAMMA prefix → ingen fragmentering", () => {
    const ml = buildMarketKey(valueBetToMarketKeyParts(vb({ sport: undefined, market: "moneyline", outcome: "1" })));
    const tot = buildMarketKey(valueBetToMarketKeyParts(vb({ sport: "soccer", market: "total", outcome: "over", line: 2.5 })));
    expect(ml.split("|")[0]).toBe("football");
    expect(tot.split("|")[0]).toBe("football");
  });
});

describe("signalMapping — event_id bevaras + saknad event_id flaggas", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("event_id från pinnacle.eventId bevaras → market_key använder e:ref", () => {
    const g = [...groupByMarketKey([vb({ pinnacle: { eventId: "1599123" } })]).values()][0];
    const rec = buildSignalRecord(g, now);
    expect(rec.event_id).toBe("1599123");
    expect(rec.market_key).toContain("e:1599123");
  });
  it("saknad event_id → event_id null + data_quality 'uncertain' (no_event_id)", () => {
    const dq = classifyDataQuality({ ev: 0.05, eventId: null });
    expect(dq.flag).toBe("uncertain");
    expect(dq.reasons).toContain("no_event_id");
    const rec = buildSignalRecord([...groupByMarketKey([vb({ pinnacle: null })]).values()][0], now);
    expect(rec.event_id).toBeNull();
  });
  it("event_id present + låg EV + flera böcker → clean", () => {
    expect(classifyDataQuality({ ev: 0.03, eventId: "x", bookCount: 2 }).flag).toBe("clean");
  });
});

describe("signalMapping — Market Trust Layer steg 1: pinnacle_limit i extra", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("buildSnapshotRecord lägger pinnacle.limit i extra.pinnacle_limit", () => {
    const g = [...groupByMarketKey([vb({ pinnacle: { eventId: "1", limit: 2500 } })]).values()][0];
    const snap = buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick");
    expect(snap.extra.pinnacle_limit).toBe(2500);
  });
  it("saknad limit → ingen pinnacle_limit-nyckel (Unknown, inte 0)", () => {
    const g = [...groupByMarketKey([vb({ pinnacle: { eventId: "1" } })]).values()][0];
    const snap = buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick");
    expect(snap.extra).not.toHaveProperty("pinnacle_limit");
  });
  it("buildSignalRecord lägger pinnacle.limit i extra", () => {
    const g = [...groupByMarketKey([vb({ pinnacle: { eventId: "1", limit: 1800 } })]).values()][0];
    const rec = buildSignalRecord(g, now);
    expect(rec.extra.pinnacle_limit).toBe(1800);
  });
  it("fas 2: buildSnapshotRecord mappar Betfair → kolumner + extra.betfair", () => {
    const g = [...groupByMarketKey([vb({ betfair: { liquidityFactor: 0.8, spreadPct: 1.2, matchedVolume: 250000 } })]).values()][0];
    const snap = buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick");
    expect(snap.betfair_liquidity).toBe(250000);
    expect(snap.betfair_spread_score).toBe(1.2);
    expect(snap.extra.betfair).toEqual({ liquidity_factor: 0.8, spread_pct: 1.2, matched_volume: 250000, back: null, lay: null, mid: null });
  });
  it("fas 2: ingen betfair → kolumner null, ingen extra.betfair (Unknown ≠ 0)", () => {
    const g = [...groupByMarketKey([vb({})]).values()][0];
    const snap = buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick");
    expect(snap.betfair_liquidity).toBeNull();
    expect(snap.betfair_spread_score).toBeNull();
    expect(snap.extra).not.toHaveProperty("betfair");
  });
  it("fas 2: buildSignalRecord lägger betfair i extra", () => {
    const g = [...groupByMarketKey([vb({ betfair: { liquidityFactor: 0.7, spreadPct: 2.0, matchedVolume: 12345 } })]).values()][0];
    const rec = buildSignalRecord(g, now);
    expect((rec.extra.betfair as { matched_volume: number }).matched_volume).toBe(12345);
  });
  it("§2: rå Betfair back/lay/mid för utfallet persisteras i extra.betfair", () => {
    const g = [...groupByMarketKey([vb({ betfair: { liquidityFactor: 0.9, spreadPct: 1.0, matchedVolume: 300000, back: 2.02, lay: 2.06, mid: 2.04 } })]).values()][0];
    const rec = buildSignalRecord(g, now);
    const b = rec.extra.betfair as { back: number; lay: number; mid: number };
    expect([b.back, b.lay, b.mid]).toEqual([2.02, 2.06, 2.04]);
  });
  it("§3/§10: stale betfair-feed → stale_betfair_feed-flagga + extra.source_freshness", () => {
    const v = vb({ sourceFreshness: { betfair: { age_sec: 400, fresh: false }, sbobet: { age_sec: 30, fresh: true } } });
    expect(computeTrustFlags(v)).toContain("stale_betfair_feed");
    expect(computeTrustFlags(v)).not.toContain("stale_sbobet_feed");
    const rec = buildSignalRecord([...groupByMarketKey([v]).values()][0], now);
    expect((rec.extra.source_freshness as { betfair: { fresh: boolean } }).betfair.fresh).toBe(false);
  });
});

describe("signalMapping — trust-flaggor (Market Trust Layer fas 3)", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("hög limit + betfair-bekräftelse + ≥2 sharps → inga flaggor (clean)", () => {
    expect(
      computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.9, spreadPct: 1.0, matchedVolume: 300000 }, sharpSources: ["betfair", "sbobet"] })),
    ).toEqual([]);
  });
  it("låg limit + ingen betfair + ingen sharp → flaggas", () => {
    const f = computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 200 }, betfair: null, sharpSources: [] }));
    expect(f).toContain("low_pinnacle_limit");
    expect(f).toContain("no_betfair_confirmation");
    expect(f).toContain("pinnacle_only");
  });
  it("hög EV + svag likviditet → high_ev_weak_liquidity", () => {
    expect(computeTrustFlags(vb({ ev: 0.12, pinnacle: { limit: 200 }, betfair: null, sharpSources: [] }))).toContain("high_ev_weak_liquidity");
  });
  it("okänd limit → unknown_pinnacle_limit (inte low)", () => {
    const f = computeTrustFlags(vb({ ev: 0.05, pinnacle: { eventId: "1" }, betfair: { liquidityFactor: 0.8, spreadPct: 1.0, matchedVolume: 300000 }, sharpSources: ["betfair"] }));
    expect(f).toContain("unknown_pinnacle_limit");
    expect(f).not.toContain("low_pinnacle_limit");
  });
  it("vid betfair-spread / tunn volym → flaggas", () => {
    const f = computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.5, spreadPct: 2.4, matchedVolume: 12000 }, sharpSources: ["betfair"] }));
    expect(f).toContain("wide_betfair_spread");
    expect(f).toContain("thin_betfair_volume");
  });
  it("buildSignalRecord persisterar trust_flags i extra", () => {
    const g = [...groupByMarketKey([vb({ ev: 0.05, pinnacle: { limit: 200 }, betfair: null, sharpSources: [] })]).values()][0];
    const rec = buildSignalRecord(g, now);
    expect(Array.isArray(rec.extra.trust_flags)).toBe(true);
    expect(rec.extra.trust_flags as string[]).toContain("low_pinnacle_limit");
  });
  // Cursor Bugbot (#11): icke-1X2-motorer sätter inte sharpSources → undefined =
  // Unknown, INTE tom → får ej falsk pinnacle_only / high_ev_weak_liquidity.
  it("fas 3: okänd sharpSources (icke-1X2-motor) → ingen falsk pinnacle_only", () => {
    const f = computeTrustFlags(vb({ ev: 0.12, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.9, spreadPct: 1.0, matchedVolume: 300000 } }));
    expect(f).not.toContain("pinnacle_only");
    expect(f).not.toContain("high_ev_weak_liquidity"); // stark marknad + okänd sharp ⇒ ej svag
    expect(f).toEqual([]);
  });
  it("sharp_conflict: ≥2 sharps oense (>5%) → flaggas", () => {
    expect(computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.9, spreadPct: 1, matchedVolume: 300000 }, sharpSources: ["betfair"], sharpPrices: { pinnacle: 2.0, betfair: 2.2 } }))).toContain("sharp_conflict");
  });
  it("sharp_conflict INTE när sharps är tajta", () => {
    expect(computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.9, spreadPct: 1, matchedVolume: 300000 }, sharpSources: ["betfair"], sharpPrices: { pinnacle: 2.0, betfair: 2.01 } }))).not.toContain("sharp_conflict");
  });
  it("fas 3: känd tom sharpSources ([]) → pinnacle_only (1X2-vägen)", () => {
    expect(computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.9, spreadPct: 1.0, matchedVolume: 300000 }, sharpSources: [] }))).toContain("pinnacle_only");
  });
});

describe("signalMapping — liquidity_score/grade (fas 4, PRIOR)", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("hög limit + stark betfair → hög score, grade A", () => {
    const r = computeLiquidityScore(vb({ pinnacle: { limit: 5000 }, betfair: { liquidityFactor: 1.0, spreadPct: 0.5, matchedVolume: 400000 } }));
    expect(r.score!).toBeGreaterThan(0.85);
    expect(r.grade).toBe("A");
  });
  it("låg limit + ingen betfair → låg score, grade D", () => {
    const r = computeLiquidityScore(vb({ pinnacle: { limit: 100 }, betfair: null }));
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeLessThan(0.55);
    expect(r.grade).toBe("D");
  });
  it("ingen likviditetssignal alls → null/unknown (Unknown ≠ dålig)", () => {
    const r = computeLiquidityScore(vb({ pinnacle: { eventId: "1" }, betfair: null }));
    expect(r.score).toBeNull();
    expect(r.grade).toBe("unknown");
  });
  it("buildSnapshotRecord skriver liquidity_score-kolumnen + grade i extra", () => {
    const g = [...groupByMarketKey([vb({ pinnacle: { limit: 5000 }, betfair: { liquidityFactor: 1.0, spreadPct: 0.5, matchedVolume: 400000 } })]).values()][0];
    const snap = buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick");
    expect(snap.liquidity_score!).toBeGreaterThan(0.85);
    expect(snap.extra.liquidity_grade).toBe("A");
  });
});

describe("signalMapping — individuella sharp-priser + consensus (sharp price persistence)", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("3 källor tajt → hög consensus, primary pinnacle, liten spread", () => {
    const r = computeSharpConsensus(vb({ fairOdds: 2.0, sharpPrices: { pinnacle: 2.0, sbobet: 2.01, betfair: 1.99 } }));
    expect(r.sources_count).toBe(3);
    expect(r.primary_source).toBe("pinnacle");
    expect(r.consensus_fair_odds).toBe(2.0);
    expect(r.price_spread_pct!).toBeLessThan(2);
    expect(r.consensus_score!).toBeGreaterThan(0.8);
  });
  it("2 källor oense → disagreement upp, consensus ner", () => {
    const r = computeSharpConsensus(vb({ fairOdds: 2.0, sharpPrices: { pinnacle: 2.0, betfair: 2.2 } }));
    expect(r.sources_count).toBe(2);
    expect(r.disagreement_score!).toBeGreaterThan(0);
    expect(r.consensus_score!).toBeLessThan(0.7);
  });
  it("bara pinnacle → 1 källa, ingen spread/agreement, score 0.4", () => {
    const r = computeSharpConsensus(vb({ fairOdds: 2.0, sharpPrices: { pinnacle: 2.0 } }));
    expect(r.sources_count).toBe(1);
    expect(r.price_spread_pct).toBeNull();
    expect(r.agreement_score).toBeNull();
    expect(r.consensus_score).toBe(0.4);
  });
  it("inga sharp-priser → allt null/0 (Unknown)", () => {
    const r = computeSharpConsensus(vb({ sharpPrices: null }));
    expect(r.sources_count).toBe(0);
    expect(r.consensus_score).toBeNull();
    expect(r.price_spread_pct).toBeNull();
  });
  it("buildSnapshotRecord fyller consensus-kolumner + extra.sharp_prices/sharp_consensus", () => {
    const g = [...groupByMarketKey([vb({ fairOdds: 2.0, sharpPrices: { pinnacle: 2.0, sbobet: 2.01, betfair: 1.99 } })]).values()][0];
    const snap = buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick");
    expect(snap.sharp_consensus_fair_odds).toBe(2.0);
    expect(snap.sharp_consensus_score!).toBeGreaterThan(0.8);
    expect((snap.extra.sharp_prices as { betfair: number }).betfair).toBe(1.99);
    expect((snap.extra.sharp_consensus as { sources_count: number }).sources_count).toBe(3);
  });
});

describe("signalMapping — recommendation (§7, PRIOR) + single_sharp_source (§10)", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("market-mismatch → manual_review", () => {
    expect(computeRecommendation(vb({ needsReview: true })).action).toBe("manual_review");
  });
  it("hög EV + svag likviditet → avoid", () => {
    expect(computeRecommendation(vb({ ev: 0.2, pinnacle: { limit: 100 }, betfair: null, sharpSources: [] })).action).toBe("avoid");
  });
  it("svag likviditet (måttlig EV) → stake_reduce", () => {
    expect(computeRecommendation(vb({ ev: 0.05, pinnacle: { limit: 100 }, betfair: null, sharpSources: ["betfair"], sharpPrices: { pinnacle: 2, betfair: 2 } })).action).toBe("stake_reduce");
  });
  it("solid likviditet + flera sharps → bet", () => {
    expect(computeRecommendation(vb({ ev: 0.05, pinnacle: { limit: 5000 }, betfair: { liquidityFactor: 1, spreadPct: 0.5, matchedVolume: 400000 }, sharpSources: ["betfair", "sbobet"], sharpPrices: { pinnacle: 2.0, sbobet: 2.0, betfair: 2.0 } })).action).toBe("bet");
  });
  it("okänd likviditet, ej svag/ensam → watch", () => {
    expect(computeRecommendation(vb({ ev: 0.05, pinnacle: { eventId: "1" }, betfair: null, sharpSources: ["sbobet", "betfair"], sharpPrices: { pinnacle: 2, sbobet: 2, betfair: 2 } })).action).toBe("watch");
  });
  it("single_sharp_source-flagga när exakt 1 sharp bekräftar", () => {
    expect(computeTrustFlags(vb({ ev: 0.05, pinnacle: { limit: 3000 }, betfair: { liquidityFactor: 0.9, spreadPct: 1, matchedVolume: 300000 }, sharpSources: ["betfair"] }))).toContain("single_sharp_source");
  });
  it("buildSnapshotRecord sätter recommended_action_at_time från rekommendationen", () => {
    const g = [...groupByMarketKey([vb({ ev: 0.2, pinnacle: { limit: 100 }, betfair: null, sharpSources: [] })]).values()][0];
    expect(buildSnapshotRecord(deriveSignalId(g.marketKey), g, now, "worker_tick").recommended_action_at_time).toBe("avoid");
  });
});

describe("signalMapping — DEDUP över böcker (kärnkravet)", () => {
  it("samma marknad hos 3 böcker → EN signal, bästa boken vald", () => {
    const a = vb({ bookmakerName: "Coolbet", bookmakerOdds: 2.1, ev: 0.04 });
    const b = vb({ bookmakerName: "Betsson", bookmakerOdds: 2.2, ev: 0.08 });
    const c = vb({ bookmakerName: "ATG", bookmakerOdds: 2.05, ev: 0.02 });
    const groups = groupByMarketKey([a, b, c]);
    expect(groups.size).toBe(1);
    const g = [...groups.values()][0];
    expect(g.best.bookmakerName).toBe("Betsson"); // högst EV
    expect(g.all).toHaveLength(3);
  });
  it("olika selection (HOME vs AWAY) → två signaler", () => {
    const home = vb({ outcome: "1" });
    const away = vb({ outcome: "2" });
    expect(groupByMarketKey([home, away]).size).toBe(2);
  });
  it("olika linje på total → två signaler", () => {
    const t25 = vb({ market: "total", outcome: "over", line: 2.5 });
    const t35 = vb({ market: "total", outcome: "over", line: 3.5 });
    expect(groupByMarketKey([t25, t35]).size).toBe(2);
  });
  it("signal_id är stabilt = härlett ur market_key (oberoende av bok)", () => {
    const mk = buildMarketKey(valueBetToMarketKeyParts(vb({})));
    expect(deriveSignalId(mk)).toBe(deriveSignalId(mk));
    const idCoolbet = deriveSignalId(buildMarketKey(valueBetToMarketKeyParts(vb({ bookmakerName: "Coolbet" }))));
    const idBetsson = deriveSignalId(buildMarketKey(valueBetToMarketKeyParts(vb({ bookmakerName: "Betsson" }))));
    expect(idCoolbet).toBe(idBetsson); // boken påverkar INTE signal_id
  });
});

describe("signalMapping — record-bygge", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("buildSignalRecord fyller timing + dedup-books", () => {
    const groups = groupByMarketKey([vb({ bookmakerName: "Coolbet", ev: 0.04 }), vb({ bookmakerName: "Betsson", ev: 0.08, bookmakerOdds: 2.2 })]);
    const g = [...groups.values()][0];
    const rec = buildSignalRecord(g, now);
    expect(rec.signal_id).toMatch(/^sig_/);
    expect(rec.soft_bookmaker).toBe("Betsson");
    expect(rec.current_ev).toBe(0.08);
    expect(rec.time_to_start_bucket).toBe("6-12h"); // 18:00 - 12:00 = 6h
    expect(rec.hour_of_day_sweden).toBe(14); // 12:00Z = 14:00 svensk sommartid
    expect((rec.extra.books as unknown[]).length).toBe(2);
  });
  it("buildSignalRecord sätter soft_odds_at_detection = bästa bokens odds (bet odds för CLV)", () => {
    const g = [...groupByMarketKey([vb({ bookmakerName: "Betsson", bookmakerOdds: 2.2, ev: 0.08 })]).values()][0];
    const rec = buildSignalRecord(g, now);
    expect(rec.soft_odds_at_detection).toBe(2.2);
    expect(rec.soft_odds_at_detection).toBe(rec.current_soft_odds); // identiska vid detektion
  });
  it("buildSnapshotRecord länkar signal + är look-ahead-säker (ingen closing/resultat)", () => {
    const g = [...groupByMarketKey([vb({})]).values()][0];
    const sid = deriveSignalId(g.marketKey);
    const snap = buildSnapshotRecord(sid, g, now, "first_seen");
    expect(snap.signal_id).toBe(sid);
    expect(snap.trigger).toBe("first_seen");
    expect(snap).not.toHaveProperty("closing_odds");
    expect(snap).not.toHaveProperty("result");
    expect(["bet", "watch", "stake_reduce", "avoid", "manual_review"]).toContain(snap.recommended_action_at_time);
  });
});
