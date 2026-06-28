/**
 * closingClv.ts — pure CLV-matchning mot Pinnacle closing (steg 2).
 *
 * Mappar en spårad signal (market_type + selection + line) till rätt no-vig
 * closing-fairProb ur en closing-record. EXAKT linje-/selection-matchning; live
 * odds blandas aldrig in (callern läser bara closing-snapshotfilen).
 *
 *   moneyline/1x2 → rec.fairProb[HOME|DRAW|AWAY]
 *   total         → rec.totalsLines (overProb per linje); UNDER = 1 - overProb
 *   ah            → rec.ahLines (homeProb per HEMMA-perspektiv-linje); AWAY = 1 - homeProb
 *
 * eh3/corners → null (ingen Pinnacle-closing fångad ännu).
 *
 * Steg 3: findClosingFallback — när exakt event_id saknas, matcha på normaliserade
 * lag + avspark ± tolerans (unik träff krävs → gissa aldrig → ingen falsk CLV).
 */

import { normalizeTeamName } from "../odds/matching.ts";

export interface ClosingRecordLike {
  fairProb?: { HOME?: number; DRAW?: number; AWAY?: number } | null;
  totalsLines?: { line: number; overProb: number }[] | null;
  ahLines?: { line: number; homeProb: number }[] | null;
}

/** Closing-record med identitetsfält för fallback-matchning. */
export interface ClosingEventLike extends ClosingRecordLike {
  startTime?: string;
  homeTeam?: string;
  awayTeam?: string;
}

/**
 * Fallback-matchning av closing när exakt event_id saknas (steg 3, robusthets-layer):
 * exakt normaliserade lagnamn i SAMMA ordning + avspark inom tolerans. Kräver EXAKT
 * EN unik träff — 0 eller flera kandidater → null (gissa aldrig → ingen falsk CLV).
 * Endast direkt ordning (ej swappad) så selection-orienteringen garanterat stämmer.
 */
export function findClosingFallback(
  homeNorm: string,
  awayNorm: string,
  startMs: number,
  events: Record<string, ClosingEventLike>,
  toleranceMs = 10 * 60 * 1000,
): { eventId: string; rec: ClosingEventLike } | null {
  if (!homeNorm || !awayNorm || !Number.isFinite(startMs)) return null;
  const hits: { eventId: string; rec: ClosingEventLike }[] = [];
  for (const [eventId, rec] of Object.entries(events)) {
    if (!rec || typeof rec !== "object") continue;
    if (normalizeTeamName(rec.homeTeam ?? "") !== homeNorm) continue;
    if (normalizeTeamName(rec.awayTeam ?? "") !== awayNorm) continue;
    const rms = rec.startTime ? Date.parse(rec.startTime) : NaN;
    if (!Number.isFinite(rms) || Math.abs(rms - startMs) > toleranceMs) continue;
    hits.push({ eventId, rec });
  }
  return hits.length === 1 ? hits[0] : null; // unik träff → matcha, annars hoppa
}

const LINE_EPS = 1e-6;
const prob = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1 ? v : null;

export function mlFairProb(rec: ClosingRecordLike, sel: string): number | null {
  if (!["HOME", "DRAW", "AWAY"].includes(sel)) return null;
  return prob(rec.fairProb?.[sel as "HOME" | "DRAW" | "AWAY"]);
}

export function totalFairProb(rec: ClosingRecordLike, sel: string, line: number | null): number | null {
  if (line == null || !Array.isArray(rec.totalsLines)) return null;
  if (sel !== "OVER" && sel !== "UNDER") return null;
  const pt = rec.totalsLines.find((p) => Math.abs(p.line - line) < LINE_EPS);
  const over = pt ? prob(pt.overProb) : null;
  if (over == null) return null;
  return sel === "OVER" ? over : 1 - over;
}

export function ahFairProb(rec: ClosingRecordLike, sel: string, line: number | null): number | null {
  if (line == null || !Array.isArray(rec.ahLines)) return null;
  if (sel !== "HOME" && sel !== "AWAY") return null;
  const pt = rec.ahLines.find((p) => Math.abs(p.line - line) < LINE_EPS);
  const home = pt ? prob(pt.homeProb) : null;
  if (home == null) return null;
  return sel === "HOME" ? home : 1 - home;
}

/** Dispatcha på market_type → no-vig closing fairProb (eller null om ej matchbar). */
export function closingFairProb(
  rec: ClosingRecordLike,
  marketType: string,
  selection: string,
  line: number | null,
): number | null {
  const mt = String(marketType || "").toLowerCase();
  const sel = String(selection || "").toUpperCase();
  if (mt === "moneyline" || mt === "1x2") return mlFairProb(rec, sel);
  if (mt === "total") return totalFairProb(rec, sel, line);
  if (mt === "ah") return ahFairProb(rec, sel, line);
  return null; // eh3/corners: ingen closing ännu
}

/** CLV = betOdds * fairProb_close - 1 (>0 = slog closing-linjen). Returnerar odds + clv. */
export function computeClv(betOdds: number, fairProb: number): { closingFairOdds: number; clvPct: number } {
  return { closingFairOdds: 1 / fairProb, clvPct: betOdds * fairProb - 1 };
}
