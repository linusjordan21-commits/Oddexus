/**
 * Tester för kickoff-capture + att settle använder closing-filen.
 */

import { describe, it, expect } from "vitest";
import {
  runCapture,
  parseClosingSnapshotFile,
  toClosingRecord,
  type ClosingFile,
  type CaptureWindow,
} from "./clvCapture.ts";
import { buildClosingIndex, planSettlements } from "./clvSettle.ts";
import { mergeClvLines, type ClvOpenEntry } from "./clvLogger.ts";
import type { PinnacleEvent } from "./shadowConsensus.ts";

const WINDOW: CaptureWindow = { minBeforeMin: 15, maxAfterMin: 2 };
const NOW = Date.parse("2026-06-20T20:00:00.000Z");

function pinEvent(eventId: string, minutesToStart: number, odds = { HOME: 2.0, DRAW: 3.4, AWAY: 3.8 }): PinnacleEvent {
  const startTime = new Date(NOW + minutesToStart * 60_000).toISOString();
  const fair = (k: "HOME" | "DRAW" | "AWAY") => {
    const o = odds, over = 1 / o.HOME + 1 / o.DRAW + 1 / o.AWAY;
    return 1 / o[k] / over;
  };
  return {
    identity: { eventId, sport: "football", league: "La Liga", homeTeam: "A" + eventId, awayTeam: "B" + eventId, startTime },
    decimal: odds,
    fairProb: { HOME: fair("HOME"), DRAW: fair("DRAW"), AWAY: fair("AWAY") },
    limit: 5000,
  };
}

describe("runCapture — fönster", () => {
  it("fångar match inom fönstret (10 min före avspark)", () => {
    const r = runCapture({ pinnacle: [pinEvent("1", 10)], existing: null, now: NOW, window: WINDOW });
    expect(r.stats.captured).toBe(1);
    expect(Object.keys(r.merged.events)).toContain("1");
  });

  it("skippar match utanför fönstret (60 min före)", () => {
    const r = runCapture({ pinnacle: [pinEvent("1", 60)], existing: null, now: NOW, window: WINDOW });
    expect(r.stats.captured).toBe(0);
    expect(r.stats.bySkipReason.OUTSIDE_WINDOW).toBe(1);
  });

  it("fångar precis efter avspark (−1 min) men ej för långt efter (−5 min)", () => {
    expect(runCapture({ pinnacle: [pinEvent("1", -1)], existing: null, now: NOW, window: WINDOW }).stats.captured).toBe(1);
    expect(runCapture({ pinnacle: [pinEvent("1", -5)], existing: null, now: NOW, window: WINDOW }).stats.bySkipReason.OUTSIDE_WINDOW).toBe(1);
  });

  it("rapporterar närmaste kickoff-differens", () => {
    const r = runCapture({ pinnacle: [pinEvent("1", 10), pinEvent("2", 3)], existing: null, now: NOW, window: WINDOW });
    expect(r.stats.nearestKickoffDiffMin).toBeCloseTo(3, 5);
  });
});

describe("runCapture — merge", () => {
  it("merge:ar utan att duplicera (samma event två körningar)", () => {
    const first = runCapture({ pinnacle: [pinEvent("1", 10)], existing: null, now: NOW, window: WINDOW });
    const second = runCapture({ pinnacle: [pinEvent("1", 8)], existing: first.merged, now: NOW + 2 * 60_000, window: WINDOW });
    expect(Object.keys(second.merged.events)).toHaveLength(1); // ingen dubblett
  });

  it("uppdaterar om ny snapshot är NÄRMARE avspark", () => {
    // Körning 1: 10 min före (capturedAt = NOW)
    const first = runCapture({ pinnacle: [pinEvent("1", 10)], existing: null, now: NOW, window: WINDOW });
    // Körning 2 vid NOW+8min: nu 2 min före avspark → närmare → ska uppdatera
    const later = NOW + 8 * 60_000;
    const second = runCapture({ pinnacle: [pinEvent("1", 10)], existing: first.merged, now: later, window: WINDOW });
    expect(second.stats.updated).toBe(1);
    expect(second.merged.events["1"].capturedAt).toBe(new Date(later).toISOString());
  });

  it("behåller gammal om gammal är NÄRMARE avspark", () => {
    // Körning 1 vid NOW+13min: 2 min före avspark (mkt nära) capturedAt=NOW+13
    const close = NOW + 13 * 60_000;
    const first = runCapture({ pinnacle: [pinEvent("1", 15)], existing: null, now: close, window: WINDOW });
    // Körning 2 vid NOW+5min för ETT ANNAT event med start senare → simulera längre-från
    // Här: samma event men en (felaktigt) tidigare/längre-bort capture ska behållas-gammal.
    const earlier = NOW + 5 * 60_000; // 10 min före avspark → längre från → behåll gammal
    const second = runCapture({ pinnacle: [pinEvent("1", 15)], existing: first.merged, now: earlier, window: WINDOW });
    expect(second.stats.keptExisting).toBe(1);
    expect(second.stats.bySkipReason.OLDER_KEPT).toBe(1);
    expect(second.merged.events["1"].capturedAt).toBe(new Date(close).toISOString());
  });

  it("skippar ofullständiga odds", () => {
    const bad = pinEvent("1", 10);
    bad.decimal.DRAW = NaN;
    bad.fairProb.DRAW = NaN;
    const r = runCapture({ pinnacle: [bad], existing: null, now: NOW, window: WINDOW });
    expect(r.stats.captured).toBe(0);
    expect(r.stats.bySkipReason.INCOMPLETE_ODDS).toBe(1);
  });
});

describe("parseClosingSnapshotFile + settle", () => {
  it("round-trip: capture-fil → PinnacleEvent[] → settle räknar CLV", () => {
    // Bygg en closing-fil med ett event vars start är i DÅTID (matchen stängd).
    const startPast = new Date(NOW - 60 * 60_000).toISOString();
    const rec = toClosingRecord(
      { ...pinEvent("1001", 0), identity: { ...pinEvent("1001", 0).identity, startTime: startPast } },
      NOW - 60 * 60_000,
    );
    const file: ClosingFile = { updatedAt: new Date(NOW).toISOString(), events: { "1001": rec } };

    const pinEvents = parseClosingSnapshotFile(file);
    expect(pinEvents).toHaveLength(1);
    const closing = buildClosingIndex(pinEvents);

    const open: ClvOpenEntry = {
      type: "open", decisionId: "d1", ts: startPast, eventId: "1001", sport: "football", league: "La Liga",
      marketType: "ML_1X2", tier: "T1", phase: "prematch", ttsBucket: "1-6h", line: null, selection: "HOME",
      scenario: "PINNACLE_ANCHOR", candidateBook: "comeon", candidateOdds: 2.5, fairPrice: 2.0, fairProb: 0.5,
      benchmarkSource: "pinnacle", benchmarkConfidence: 0.9, requiredEdge: 1.8, calculatedEdge: 3,
      decision: "AUTO_BET", executed: false, shadowMode: true, reasonCodes: [], sourceSnapshot: [],
    };
    const plan = planSettlements(mergeClvLines([open]), closing, NOW);
    expect(plan.settlements).toHaveLength(1);
    // closingFairProb(HOME) för odds 2.0/3.4/3.8 ≈ 0.479; CLV = 2.5×0.479−1
    expect(plan.settlements[0].clvPct).toBeCloseTo((2.5 * pinEvents[0].fairProb.HOME - 1) * 100, 6);
  });

  it("tom/ogiltig fil → []", () => {
    expect(parseClosingSnapshotFile({})).toEqual([]);
    expect(parseClosingSnapshotFile(null)).toEqual([]);
  });
});
