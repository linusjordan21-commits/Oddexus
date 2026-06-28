import { describe, it, expect } from "vitest";
import {
  classifySnapshotTrigger,
  snapshotFromSignalRow,
  classifyDataQuality,
  EV_MATERIAL_DELTA,
  SHARP_MOVE_PCT,
  SUSPICIOUS_EV,
  ELEVATED_EV,
} from "./signalMapping.ts";

describe("classifySnapshotTrigger — varför är denna snapshot intressant?", () => {
  it("ingen tidigare signal → value_appeared (utan delta-extra)", () => {
    const r = classifySnapshotTrigger(null, { ev: 0.05, sharp_fair_odds: 2.0 });
    expect(r.trigger).toBe("value_appeared");
    expect(r.extra).toEqual({});
  });

  it("sharp fair odds kortas ≥3% → sharp_drop (marknaden steam:ar mot oss)", () => {
    const prev = { current_ev: 0.05, sharp_fair_odds: 2.0 };
    const r = classifySnapshotTrigger(prev, { ev: 0.05, sharp_fair_odds: 2.0 * (1 - SHARP_MOVE_PCT - 0.005) });
    expect(r.trigger).toBe("sharp_drop");
    expect(r.extra.sharp_move_pct).toBeLessThan(0);
    expect(r.extra.prev_sharp_fair_odds).toBe(2.0);
  });

  it("sharp fair odds drar ifrån ≥3% → sharp_drift (edge eroderar)", () => {
    const prev = { current_ev: 0.05, sharp_fair_odds: 2.0 };
    const r = classifySnapshotTrigger(prev, { ev: 0.05, sharp_fair_odds: 2.0 * (1 + SHARP_MOVE_PCT + 0.005) });
    expect(r.trigger).toBe("sharp_drift");
    expect(r.extra.sharp_move_pct).toBeGreaterThan(0);
  });

  it("EV-skifte ≥1 pp utan stor sharp-rörelse → ev_changed_materially", () => {
    const prev = { current_ev: 0.02, sharp_fair_odds: 2.0 };
    const r = classifySnapshotTrigger(prev, { ev: 0.02 + EV_MATERIAL_DELTA + 0.002, sharp_fair_odds: 2.0 });
    expect(r.trigger).toBe("ev_changed_materially");
    expect(r.extra.ev_delta).toBeGreaterThanOrEqual(EV_MATERIAL_DELTA);
    expect(r.extra.prev_ev).toBe(0.02);
  });

  it("inga materiella förändringar → worker_tick (heartbeat, tidsserien bevaras)", () => {
    const prev = { current_ev: 0.05, sharp_fair_odds: 2.0 };
    const r = classifySnapshotTrigger(prev, { ev: 0.052, sharp_fair_odds: 2.01 });
    expect(r.trigger).toBe("worker_tick");
  });

  it("sharp-rörelse prioriteras över EV-skifte (mer informativt för bet-now-vs-wait)", () => {
    // Både sharp_drop OCH stort EV-skifte → sharp_drop vinner.
    const prev = { current_ev: 0.02, sharp_fair_odds: 2.0 };
    const r = classifySnapshotTrigger(prev, { ev: 0.10, sharp_fair_odds: 1.8 });
    expect(r.trigger).toBe("sharp_drop");
  });

  it("saknad sharp (null) → faller tillbaka på EV-logik utan att krascha", () => {
    const prev = { current_ev: 0.02, sharp_fair_odds: null };
    const r = classifySnapshotTrigger(prev, { ev: 0.05, sharp_fair_odds: null });
    expect(r.trigger).toBe("ev_changed_materially");
    expect(r.extra.sharp_move_pct).toBeUndefined();
  });
});

describe("classifyDataQuality — flagga suspekt/osäker data", () => {
  const clean = { ev: 0.04, needsReview: false, eventId: "e123", bookCount: 3 };

  it("normal EV + event_id + flera böcker → clean", () => {
    expect(classifyDataQuality(clean).flag).toBe("clean");
  });

  it("EV ≥ tröskel → suspicious_ev (RÖD, → data_quality_issue)", () => {
    const r = classifyDataQuality({ ...clean, ev: SUSPICIOUS_EV + 0.05 });
    expect(r.flag).toBe("suspicious_ev");
    expect(r.reasons[0]).toMatch(/^ev_/);
  });

  it("needsReview → mismatch (RÖD)", () => {
    expect(classifyDataQuality({ ...clean, needsReview: true }).flag).toBe("mismatch");
  });

  it("suspicious_ev prioriteras över mismatch (båda röda)", () => {
    expect(classifyDataQuality({ ...clean, ev: 0.3, needsReview: true }).flag).toBe("suspicious_ev");
  });

  it("förhöjd EV (10–15%) → uncertain (GUL, stannar active)", () => {
    const r = classifyDataQuality({ ...clean, ev: ELEVATED_EV + 0.01 });
    expect(r.flag).toBe("uncertain");
    expect(r.reasons).toContain("elevated_ev");
  });

  it("saknad event_id → uncertain (lägre matchnings-confidence)", () => {
    const r = classifyDataQuality({ ...clean, eventId: null });
    expect(r.flag).toBe("uncertain");
    expect(r.reasons).toContain("no_event_id");
  });

  it("ensam bok med förhöjd EV → uncertain (lone_book_elevated_ev)", () => {
    const r = classifyDataQuality({ ...clean, ev: ELEVATED_EV + 0.02, bookCount: 1 });
    expect(r.flag).toBe("uncertain");
    expect(r.reasons).toContain("lone_book_elevated_ev");
  });

  it("Pinnacle-only normal EV (single sharp) → clean (Pinnacle färsk räcker, ej flaggat)", () => {
    expect(classifyDataQuality({ ev: 0.05, needsReview: false, eventId: "e1", bookCount: 1 }).flag).toBe("clean");
  });
});

describe("snapshotFromSignalRow — händelse-snapshot ur persisterad rad", () => {
  const row = {
    signal_id: "sig_abcd1234",
    market_key: "e:123|1x2|ft|-|HOME",
    start_time: "2030-01-01T18:00:00.000Z",
    current_soft_odds: 2.4,
    sharp_fair_odds: 2.2,
    current_ev: 0.04,
    market_mismatch_risk: null,
  };

  it("value_disappeared bär signalens senast kända värden + trigger", () => {
    const snap = snapshotFromSignalRow(row, "2030-01-01T17:00:00.000Z", "value_disappeared", { last_ev: 0.04 });
    expect(snap.signal_id).toBe("sig_abcd1234");
    expect(snap.trigger).toBe("value_disappeared");
    expect(snap.soft_odds).toBe(2.4);
    expect(snap.sharp_fair_odds).toBe(2.2);
    expect(snap.ev).toBe(0.04);
    expect(snap.extra.last_ev).toBe(0.04);
    expect(snap.time_to_start_sec).toBe(3600); // 1h kvar
  });

  it("samma signal + samma tidpunkt → deterministiskt snapshot_id (idempotent insert)", () => {
    const a = snapshotFromSignalRow(row, "2030-01-01T17:00:00.000Z", "closing_captured", {});
    const b = snapshotFromSignalRow(row, "2030-01-01T17:00:00.000Z", "closing_captured", {});
    expect(a.snapshot_id).toBe(b.snapshot_id);
  });

  it("saknade numeriska fält faller till säkra defaults (kraschar inte)", () => {
    const snap = snapshotFromSignalRow(
      { signal_id: "sig_x", market_key: "k", start_time: null, current_ev: null },
      "2030-01-01T17:00:00.000Z",
      "value_disappeared",
    );
    expect(snap.soft_odds).toBe(0);
    expect(snap.sharp_fair_odds).toBeNull();
    expect(snap.ev).toBe(0);
  });
});
