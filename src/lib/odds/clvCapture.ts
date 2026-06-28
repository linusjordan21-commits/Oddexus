/**
 * clvCapture.ts — kickoff-capture av Pinnacle closing line.
 *
 * Pinnacle-feeden är future-only, så för ÄKTA closing fångar vi en snapshot
 * nära avspark och sparar den i en dedikerad fil (data/pinnacle-closing.json)
 * som settle-jobbet läser. Vi mergear per eventId och behåller den snapshot
 * som är NÄRMAST avspark (inte den senast skrivna).
 *
 * Pure (ingen IO) → testbart. CLI:n (scripts/capture-pinnacle-closing.ts)
 * sköter fil-läsning/skrivning. Allt shadow-only; inga live-beslut/secrets.
 *
 * Filformat (flat per event, eget format — INTE pinnacle-rows.json-formen):
 *   { updatedAt, events: { [eventId]: ClosingEventRecord } }
 */

import type { BenchSport } from "./consensusTypes.ts";
import { devigThreeWay } from "./consensus.ts";
import type { PinnacleEvent } from "./shadowConsensus.ts";

export interface ClosingEventRecord {
  eventId: string;
  capturedAt: string; // ISO — när snapshoten togs
  startTime: string;
  sport: BenchSport;
  league: string | null;
  homeTeam: string;
  awayTeam: string;
  market: "ML_1X2";
  /** Decimal odds (med vig). */
  odds: { home: number; draw: number; away: number };
  /** No-vig fair prob (devig). */
  fairProb: { HOME: number; DRAW: number; AWAY: number };
  /**
   * ADDITIVA closing-stegar för AH + totals (Pinnacle no-vig), fångade vid SAMMA
   * snapshot som ML ovan. Möjliggör CLV på AH/totals utöver moneyline. Lämnas
   * undefined om ladders saknas — ML-prissättningen (settle-clv) rör dem aldrig.
   *   totalsLines: overProb = no-vig P(OVER) per total-linje.
   *   ahLines:     homeProb = no-vig P(HOME täcker) per HEMMA-perspektiv-handikapp.
   */
  totalsLines?: { line: number; overProb: number }[];
  ahLines?: { line: number; homeProb: number }[];
}

/** AH/totals-stegar för EN event (canonical no-vig), från parsePinnacleLineLadders. */
export interface ClosingLadders {
  totals: { line: number; prob: number }[]; // prob = OVER no-vig
  ah: { line: number; prob: number }[]; // prob = HOME no-vig (hemma-perspektiv)
}

export interface ClosingFile {
  updatedAt: string;
  events: Record<string, ClosingEventRecord>;
}

export interface CaptureWindow {
  /** Minuter FÖRE avspark som vi börjar fånga. */
  minBeforeMin: number;
  /** Minuter EFTER avspark som vi fortfarande fångar. */
  maxAfterMin: number;
}

export const DEFAULT_CAPTURE_WINDOW: CaptureWindow = { minBeforeMin: 15, maxAfterMin: 2 };

export type CaptureSkipReason = "OUTSIDE_WINDOW" | "INCOMPLETE_ODDS" | "OLDER_KEPT";

export interface CaptureResult {
  merged: ClosingFile;
  skipped: { eventId: string; reason: CaptureSkipReason }[];
  stats: {
    scanned: number;
    captured: number; // nya events tillagda
    updated: number; // ersatte äldre/längre-från-avspark snapshot
    keptExisting: number; // befintlig var närmare → behölls
    skipped: number;
    bySkipReason: Record<string, number>;
    nearestKickoffDiffMin: number | null;
  };
}

function minutesToStart(startTime: string, now: number): number {
  return (Date.parse(startTime) - now) / 60_000;
}

function distanceToStartMs(startTime: string, capturedAtMs: number): number {
  return Math.abs(Date.parse(startTime) - capturedAtMs);
}

function oddsComplete(ev: PinnacleEvent): boolean {
  const d = ev.decimal;
  return [d.HOME, d.DRAW, d.AWAY].every((x) => Number.isFinite(x) && x > 1)
    && [ev.fairProb.HOME, ev.fairProb.DRAW, ev.fairProb.AWAY].every((x) => Number.isFinite(x) && x > 0);
}

/** Bygg en closing-record ur ett Pinnacle-event + capture-tid (+ ev. AH/totals-stegar). */
export function toClosingRecord(ev: PinnacleEvent, capturedAtMs: number, ladders?: ClosingLadders): ClosingEventRecord {
  const rec: ClosingEventRecord = {
    eventId: ev.identity.eventId,
    capturedAt: new Date(capturedAtMs).toISOString(),
    startTime: ev.identity.startTime,
    sport: ev.identity.sport,
    league: ev.identity.league,
    homeTeam: ev.identity.homeTeam,
    awayTeam: ev.identity.awayTeam,
    market: "ML_1X2",
    odds: { home: ev.decimal.HOME, draw: ev.decimal.DRAW, away: ev.decimal.AWAY },
    fairProb: { ...ev.fairProb },
  };
  if (ladders) {
    const totals = ladders.totals
      .filter((p) => Number.isFinite(p.line) && Number.isFinite(p.prob) && p.prob > 0 && p.prob < 1)
      .map((p) => ({ line: p.line, overProb: p.prob }));
    const ah = ladders.ah
      .filter((p) => Number.isFinite(p.line) && Number.isFinite(p.prob) && p.prob > 0 && p.prob < 1)
      .map((p) => ({ line: p.line, homeProb: p.prob }));
    if (totals.length) rec.totalsLines = totals;
    if (ah.length) rec.ahLines = ah;
  }
  return rec;
}

/**
 * Kör capture: filtrera till capture-fönstret, merge:a in i befintlig
 * closing-fil (behåll den snapshot som är närmast avspark). Pure.
 */
export function runCapture(args: {
  pinnacle: PinnacleEvent[];
  existing: ClosingFile | null;
  now?: number;
  window?: CaptureWindow;
  /** AH/totals-stegar per eventId (från parsePinnacleLineLadders). Valfritt. */
  ladders?: Map<string, ClosingLadders>;
}): CaptureResult {
  const now = args.now ?? Date.now();
  const window = args.window ?? DEFAULT_CAPTURE_WINDOW;
  const events: Record<string, ClosingEventRecord> = { ...(args.existing?.events ?? {}) };

  const skipped: { eventId: string; reason: CaptureSkipReason }[] = [];
  const bySkipReason: Record<string, number> = {};
  let captured = 0, updated = 0, keptExisting = 0;
  let nearest: number | null = null;

  const skip = (eventId: string, reason: CaptureSkipReason) => {
    skipped.push({ eventId, reason });
    bySkipReason[reason] = (bySkipReason[reason] ?? 0) + 1;
  };

  for (const ev of args.pinnacle) {
    const mts = minutesToStart(ev.identity.startTime, now);
    // närmaste kickoff-diff (absolut) bland scannade.
    if (nearest === null || Math.abs(mts) < Math.abs(nearest)) nearest = mts;

    // Utanför fönster: −maxAfter ≤ mts ≤ minBefore.
    if (mts > window.minBeforeMin || mts < -window.maxAfterMin) { skip(ev.identity.eventId, "OUTSIDE_WINDOW"); continue; }
    if (!oddsComplete(ev)) { skip(ev.identity.eventId, "INCOMPLETE_ODDS"); continue; }

    const rec = toClosingRecord(ev, now, args.ladders?.get(ev.identity.eventId));
    const prev = events[ev.identity.eventId];
    if (!prev) {
      events[ev.identity.eventId] = rec;
      captured++;
    } else {
      const prevDist = distanceToStartMs(prev.startTime, Date.parse(prev.capturedAt));
      const newDist = distanceToStartMs(rec.startTime, now);
      if (newDist < prevDist) { events[ev.identity.eventId] = rec; updated++; }
      else { keptExisting++; skip(ev.identity.eventId, "OLDER_KEPT"); }
    }
  }

  return {
    merged: { updatedAt: new Date(now).toISOString(), events },
    skipped,
    stats: {
      scanned: args.pinnacle.length,
      captured,
      updated,
      keptExisting,
      skipped: skipped.length,
      bySkipReason,
      nearestKickoffDiffMin: nearest,
    },
  };
}

/**
 * Parsa closing-snapshot-filen → PinnacleEvent[] för settle. Recomputar
 * fairProb från lagrade decimal-odds (en sanningskälla). Tom/ogiltig → [].
 */
export function parseClosingSnapshotFile(json: unknown): PinnacleEvent[] {
  const file = json as ClosingFile;
  if (!file?.events || typeof file.events !== "object") return [];
  const out: PinnacleEvent[] = [];
  for (const rec of Object.values(file.events)) {
    const { home, draw, away } = rec.odds ?? {};
    if (![home, draw, away].every((x) => Number.isFinite(x) && (x as number) > 1)) continue;
    out.push({
      identity: {
        eventId: rec.eventId, sport: rec.sport, league: rec.league,
        homeTeam: rec.homeTeam, awayTeam: rec.awayTeam, startTime: rec.startTime,
      },
      decimal: { HOME: home, DRAW: draw, AWAY: away },
      fairProb: {
        HOME: devigThreeWay(home, draw, away, "HOME"),
        DRAW: devigThreeWay(home, draw, away, "DRAW"),
        AWAY: devigThreeWay(home, draw, away, "AWAY"),
      },
      limit: null,
    });
  }
  return out;
}
