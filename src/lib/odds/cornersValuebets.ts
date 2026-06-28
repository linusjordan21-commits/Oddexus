/**
 * cornersValuebets.ts — backend-MOTOR för HÖRN-valuebets (corner totals + corner AH).
 *
 * Sharp referens: Pinnacles hörn-stegar (parsePinnacleCornerLadders) — Pinnacle är
 * skarpast på hörn. Soft-boken levererar corners.{totals,ah}; vi line-matchar mot
 * Pinnacles hörn-stege (exact → quarter → interpolated → rejected) och prissätter
 * EV mot devig:ad Pinnacle-prob. SAMMA grind-mönster som totals/AH:
 *   - bara linjer Pinnacle TÄCKER (lineComparable),
 *   - corner-AH reorienteras till Pinnacle-ordning vid kastad lag-ordning,
 *   - EV-/reject-grindar,
 *   - valfri min-limit-grind (hörn-marknader är tunna → låga limits).
 *
 * OBS: i v1 är Pinnacle ENDA hörn-källan (SBOBET/Betfair/Smarkets har inte hörn i
 * vår data ännu) → ren Pinnacle-prissättning. När fler skarpa hörn-källor finns
 * blandas de in via samma consensus-väg som AH/EH3.
 */

import { normalizeTeamName, startTimeBucket } from "./matching.ts";
import {
  parsePinnacleSoccer,
  parseSoftBook,
  ttsBucketFrom,
  type PinnacleEvent,
  type CandidateEvent,
} from "./shadowConsensus.ts";
import { parsePinnacleCornerLadders } from "./pinnacleCorners.ts";
import { lineMatchedQuote } from "./lineMatching.ts";
import type { Selection } from "./types.ts";

export type CornersMarket = "corner_total" | "corner_ah";

export interface CornersValuebet {
  /** Pinnacle matchup-id (String(matchupId)) — stabil match-referens för CLV/market_key. */
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  league: string | null;
  bookmaker: string;
  market: CornersMarket;
  line: number;
  /** totals: OVER/UNDER. ah: HOME/AWAY. */
  selection: "OVER" | "UNDER" | "HOME" | "AWAY";
  bookmakerOdds: number;
  fairProb: number;
  fairOdds: number;
  ev: number;
  pinnacleLimit: number | null;
  sources: string[];
}

export interface CornersValuebetInput {
  pinnacleJson: unknown;
  /** Förparsad Pinnacle (delas mellan motorerna → slipper om-parsning). */
  pinnacleEvents?: PinnacleEvent[];
  softBooks: Array<{ id: string; json: unknown; franchise?: string }>;
  evThreshold: number;
  rejectThreshold: number;
  /** Min Pinnacle-limit för att lita på hörn-linjen (0 = av). Default 0. */
  minLimit?: number;
  now?: number;
}

function key(h: string, a: string, startTime: string): string | null {
  const b = startTimeBucket(startTime);
  return b === null ? null : `${normalizeTeamName(h)}::${normalizeTeamName(a)}::${b}`;
}

export function computeCornersValuebets(input: CornersValuebetInput): CornersValuebet[] {
  const now = input.now ?? Date.now();
  const minLimit = input.minLimit ?? 0;
  const pinnacle = input.pinnacleEvents ?? parsePinnacleSoccer(input.pinnacleJson);
  if (pinnacle.length === 0) return [];
  const cornerLadders = parsePinnacleCornerLadders(input.pinnacleJson);
  if (cornerLadders.size === 0) return [];

  const pinIndex = new Map<string, PinnacleEvent>();
  for (const p of pinnacle) {
    const k = key(p.identity.homeTeam, p.identity.awayTeam, p.identity.startTime);
    if (k) pinIndex.set(k, p);
  }
  const lookupPin = (c: CandidateEvent): { pin: PinnacleEvent; swapped: boolean } | undefined => {
    const b = startTimeBucket(c.identity.startTime);
    if (b === null) return undefined;
    const h = normalizeTeamName(c.identity.homeTeam);
    const a = normalizeTeamName(c.identity.awayTeam);
    for (const bb of [b - 1, b, b + 1]) { const hit = pinIndex.get(`${h}::${a}::${bb}`); if (hit) return { pin: hit, swapped: false }; }
    for (const bb of [b - 1, b, b + 1]) { const hit = pinIndex.get(`${a}::${h}::${bb}`); if (hit) return { pin: hit, swapped: true }; }
    return undefined;
  };

  const out: CornersValuebet[] = [];
  const seen = new Set<string>();

  for (const sb of input.softBooks) {
    let candidates: CandidateEvent[] = [];
    try { candidates = parseSoftBook(sb.json, sb.id, sb.franchise); } catch { continue; }
    for (const c of candidates) {
      const corners = c.corners;
      if (!corners || (!corners.totals.length && !corners.ah.length)) continue;
      const m = lookupPin(c);
      if (!m) continue;
      const pin = m.pin;
      const ladders = cornerLadders.get(pin.identity.eventId);
      if (!ladders) continue;
      if (minLimit > 0 && (ladders.limit == null || ladders.limit < minLimit)) continue;

      // ── Hörn-totals (O/U) ──
      if (ladders.totals.points.length > 0) {
        for (const t of corners.totals) {
          if (!Number.isFinite(t.line)) continue;
          for (const sel of ["OVER", "UNDER"] as Selection[]) {
            const odds = sel === "OVER" ? t.over : t.under;
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const pq = lineMatchedQuote({ marketType: "TOTAL", scope: "corners", line: t.line, selection: sel }, ladders.totals);
            if (!pq.lineComparable || pq.fairProb == null || !(pq.fairProb > 0)) continue;
            const ev = pq.fairProb * odds - 1;
            if (ev <= input.evThreshold || ev > input.rejectThreshold) continue;
            const dk = `${sb.id}|${pin.identity.eventId}|T|${t.line}|${sel}`;
            if (seen.has(dk)) continue;
            seen.add(dk);
            out.push({
              homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam, startTime: pin.identity.startTime, league: pin.identity.league,
              eventId: pin.identity.eventId,
              bookmaker: sb.id, market: "corner_total", line: t.line, selection: sel as "OVER" | "UNDER", bookmakerOdds: odds,
              fairProb: pq.fairProb, fairOdds: 1 / pq.fairProb, ev, pinnacleLimit: ladders.limit, sources: ["pinnacle-corners"],
            });
          }
        }
      }

      // ── Hörn-AH ── (reorientera till Pinnacle-ordning vid kastad lag-ordning)
      if (ladders.ah.points.length > 0) {
        const ahOffers = m.swapped ? corners.ah.map((o) => ({ line: -o.line, home: o.away, away: o.home })) : corners.ah;
        for (const o of ahOffers) {
          if (!Number.isFinite(o.line)) continue;
          for (const sel of ["HOME", "AWAY"] as Selection[]) {
            const odds = sel === "HOME" ? o.home : o.away;
            if (!Number.isFinite(odds) || odds <= 1) continue;
            const pq = lineMatchedQuote({ marketType: "AH", scope: "corners", line: o.line, selection: sel }, ladders.ah);
            if (!pq.lineComparable || pq.fairProb == null || !(pq.fairProb > 0)) continue;
            const ev = pq.fairProb * odds - 1;
            if (ev <= input.evThreshold || ev > input.rejectThreshold) continue;
            const dk = `${sb.id}|${pin.identity.eventId}|A|${o.line}|${sel}`;
            if (seen.has(dk)) continue;
            seen.add(dk);
            out.push({
              homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam, startTime: pin.identity.startTime, league: pin.identity.league,
              eventId: pin.identity.eventId,
              bookmaker: sb.id, market: "corner_ah", line: o.line, selection: sel as "HOME" | "AWAY", bookmakerOdds: odds,
              fairProb: pq.fairProb, fairOdds: 1 / pq.fairProb, ev, pinnacleLimit: ladders.limit, sources: ["pinnacle-corners"],
            });
          }
        }
      }
    }
  }
  out.sort((a, b) => b.ev - a.ev);
  return out;
}
