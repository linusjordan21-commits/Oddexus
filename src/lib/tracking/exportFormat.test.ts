import { describe, it, expect } from "vitest";
import { toCsv, computeSummary, buildClaudeAnalysisPrompt, flattenTrustFields } from "./exportFormat.ts";

describe("exportFormat — CSV", () => {
  it("escapar kommatecken, citattecken och radbrytningar (RFC4180)", () => {
    const csv = toCsv([{ a: "x,y", b: 'he said "hi"', c: "line1\nline2" }]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"he said ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });
  it("serialiserar arrayer/objekt som JSON", () => {
    const csv = toCsv([{ tags: ["a", "b"], meta: { k: 1 } }]);
    expect(csv).toContain('"[""a"",""b""]"');
    expect(csv).toContain('"{""k"":1}"');
  });
  it("tom input → bara header", () => {
    expect(toCsv([], ["x", "y"])).toBe("x,y\n");
  });
});

describe("exportFormat — flattenTrustFields (§11)", () => {
  it("lyfter liquidity/sharp-fält ur extra till egna kolumner", () => {
    const row = {
      signal_id: "sig_1",
      extra: {
        pinnacle_limit: 3000,
        liquidity_score: 0.9,
        liquidity_grade: "A",
        betfair: { matched_volume: 250000, spread_pct: 1.2, liquidity_factor: 0.9 },
        sharp_consensus: { consensus_score: 0.81, disagreement_score: 0.1, sources_count: 3, price_spread_pct: 1, primary_source: "pinnacle" },
        sharp_prices: { pinnacle: 2.0, sbobet: 2.01, betfair: 1.99 },
        trust_flags: ["low_pinnacle_limit", "sharp_conflict"],
      },
    };
    const f = flattenTrustFields(row);
    expect(f.lq_liquidity_grade).toBe("A");
    expect(f.lq_pinnacle_limit).toBe(3000);
    expect(f.bf_matched_volume).toBe(250000);
    expect(f.sharp_consensus_score).toBe(0.81);
    expect(f.sharp_sources_count).toBe(3);
    expect(f.pinnacle_fair_odds).toBe(2.0);
    expect(f.betfair_fair_odds).toBe(1.99);
    expect(f.trust_flags).toBe("low_pinnacle_limit|sharp_conflict");
    // visas som kolumner i CSV:n
    expect(toCsv([f])).toContain("lq_liquidity_grade");
  });
  it("rad utan trust-extra returneras oförändrad (no-op)", () => {
    const row = { signal_id: "x", market_key: "k" };
    expect(flattenTrustFields(row)).toEqual(row);
    expect(flattenTrustFields({ signal_id: "y", extra: { books: [1] } })).toEqual({ signal_id: "y", extra: { books: [1] } });
  });
});

describe("exportFormat — summary", () => {
  const signals = [
    { ev_at_detection: 0.05, soft_bookmaker: "Coolbet", timing_bucket_sweden: "18-21" },
    { ev_at_detection: 0.03, soft_bookmaker: "Coolbet", timing_bucket_sweden: "18-21" },
    { ev_at_detection: 0.07, soft_bookmaker: "Betsson", timing_bucket_sweden: "21-24" },
  ];
  const outcomes = [{ clv_pct: 2 }, { clv_pct: -1 }, { clv_pct: 3 }];
  it("beräknar avg EV/CLV, success rate och topplistor", () => {
    const s = computeSummary({ signals, snapshots: [], decisions: [{ decision_type: "skipped" }], loggedBets: [], outcomes });
    expect(s.num_signals).toBe(3);
    expect(s.num_skipped).toBe(1);
    expect(s.avg_ev).toBeCloseTo(0.05, 5);
    expect(s.avg_clv).toBeCloseTo(4 / 3, 5);
    expect(s.median_clv).toBe(2);
    expect(s.clv_success_rate).toBeCloseTo(2 / 3, 5);
    expect(s.top_books_by_signals[0]).toEqual({ book: "Coolbet", n: 2 });
    expect(s.not_enough_data).toBe(true); // < 20
  });
  it("prompt innehåller period + volym + sample-varning", () => {
    const s = computeSummary({ signals, snapshots: [], decisions: [], loggedBets: [], outcomes, dateFrom: "2026-07-01", dateTo: "2026-07-14" });
    const p = buildClaudeAnalysisPrompt(s);
    expect(p).toContain("2026-07-01");
    expect(p).toContain("CLV");
    expect(p).toContain("liten datamängd");
  });
});
