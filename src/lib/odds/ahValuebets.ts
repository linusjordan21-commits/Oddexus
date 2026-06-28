/**
 * ahValuebets.ts — backend-MOTOR för football Asian Handicap-valuebets.
 *
 * Syskon till totalsValuebets.ts men för AH. Skillnaden mot totals: AH-linjen är
 * HEMMA-perspektiv (inte symmetrisk) → kandidatens + källornas AH måste reorienteras
 * till Pinnacles hemma/borta-ordning innan prissättning. SBOBET är dessutom
 * marknadsledande på AH → SBOBET AH blandas in (utöver Pinnacle-stege + Betfair AH).
 *
 * Allt prissätts i PINNACLE-native ordning (HOME = Pinnacles hemmalag). Ren funktion.
 */

import { normalizeTeamName, startTimeBucket } from "./matching.ts";
import {
  parsePinnacleSoccer,
  parseSoftBook,
  ttsBucketFrom,
  deriveTier,
  swapBetfairLineOrientation,
  swapSbobetAhOrientation,
  type PinnacleEvent,
  type CandidateEvent,
} from "./shadowConsensus.ts";
import { parsePinnacleLineLadders, type PinnacleLineLadders } from "./pinnacleLines.ts";
import { lineMatchedQuote } from "./lineMatching.ts";
import { betfairAhQuote, type BetfairMarket } from "./betfairAdapter.ts";
import { sbobetAhQuote } from "./sbobetAdapter.ts";
import type { SbobetMarket } from "./sbobetScrapeParse.ts";
import { evaluateMarket, type MarketContext } from "./consensus.ts";
import type { Selection } from "./types.ts";

export interface AhValuebet {
  /** Pinnacle matchup-id (String(matchupId)) — stabil match-referens för CLV/market_key. */
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  league: string | null;
  bookmaker: string;
  /** Handikapp-linje ur HEMMA-perspektiv (t.ex. -0.5). */
  line: number;
  selection: "HOME" | "AWAY";
  bookmakerOdds: number;
  fairProb: number;
  fairOdds: number;
  ev: number;
  sources: string[];
}

export interface AhValuebetInput {
  pinnacleJson: unknown;
  /** Förparsad Pinnacle (delas mellan motorerna → slipper om-parsning). */
  pinnacleEvents?: PinnacleEvent[];
  pinnacleLadders?: Map<string, PinnacleLineLadders>;
  /** Betfair TOTALS+AH per team-bucket (parseBetfairLineRowsMap) — om FÄRSK. */
  betfairLines?: Map<string, BetfairMarket[]>;
  /** SBOBET AH-stegar per team-bucket (parseSbobetAhRowsMap) — om FÄRSK. */
  sbobetAh?: Map<string, SbobetMarket[]>;
  softBooks: Array<{ id: string; json: unknown; franchise?: string }>;
  clvMultipliers?: Record<string, number>;
  evThreshold: number;
  rejectThreshold: number;
  now?: number;
}

function key(h: string, a: string, startTime: string): string | null {
  const b = startTimeBucket(startTime);
  return b === null ? null : `${normalizeTeamName(h)}::${normalizeTeamName(a)}::${b}`;
}

export function computeAhValuebets(input: AhValuebetInput): AhValuebet[] {
  const now = input.now ?? Date.now();
  const pinnacle = input.pinnacleEvents ?? parsePinnacleSoccer(input.pinnacleJson);
  if (pinnacle.length === 0) return [];
  const pinLines = input.pinnacleLadders ?? parsePinnacleLineLadders(input.pinnacleJson, "soccer");

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

  // Källa-AH-uppslag relativt PIN: swapped = källan listar lagen omvänt mot Pinnacle.
  function lookupSource<T>(map: Map<string, T[]> | undefined, pin: PinnacleEvent): { markets: T[]; swapped: boolean } | undefined {
    if (!map) return undefined;
    const b = startTimeBucket(pin.identity.startTime);
    if (b === null) return undefined;
    const h = normalizeTeamName(pin.identity.homeTeam);
    const a = normalizeTeamName(pin.identity.awayTeam);
    for (const bb of [b - 1, b, b + 1]) { const hit = map.get(`${h}::${a}::${bb}`); if (hit) return { markets: hit, swapped: false }; }
    for (const bb of [b - 1, b, b + 1]) { const hit = map.get(`${a}::${h}::${bb}`); if (hit) return { markets: hit, swapped: true }; }
    return undefined;
  }

  const out: AhValuebet[] = [];
  const seen = new Set<string>();

  for (const sb of input.softBooks) {
    let candidates: CandidateEvent[] = [];
    try { candidates = parseSoftBook(sb.json, sb.id, sb.franchise); } catch { continue; }
    for (const c of candidates) {
      if (!c.ah?.length) continue;
      const m = lookupPin(c);
      if (!m) continue;
      const pin = m.pin;
      const ladders = pinLines.get(pin.identity.eventId);
      if (!ladders || ladders.ah.points.length === 0) continue;

      // Kandidatens AH → Pinnacle-ordning (negera linje + byt home/away om kastad).
      const ahOffers = m.swapped ? c.ah.map((o) => ({ line: -o.line, home: o.away, away: o.home })) : c.ah;

      // Betfair AH (ur TOTALS+AH-mappen) → Pinnacle-ordning.
      const bfHit = lookupSource(input.betfairLines, pin);
      let bfAh: BetfairMarket[] = [];
      if (bfHit) {
        const ahMk = bfHit.markets.filter((x) => x.marketType === "AH");
        bfAh = bfHit.swapped ? swapBetfairLineOrientation(ahMk) : ahMk;
      }
      // SBOBET AH → Pinnacle-ordning.
      const sboHit = lookupSource(input.sbobetAh, pin);
      let sboAh: SbobetMarket[] = [];
      if (sboHit) sboAh = sboHit.swapped ? swapSbobetAhOrientation(sboHit.markets) : sboHit.markets;

      const tier = deriveTier(pin.identity.league);
      const ttsBucket = ttsBucketFrom(pin.identity.startTime, now);

      for (const o of ahOffers) {
        if (!Number.isFinite(o.line)) continue;
        for (const sel of ["HOME", "AWAY"] as Selection[]) {
          const odds = sel === "HOME" ? o.home : o.away;
          if (!Number.isFinite(odds) || odds <= 1) continue;

          const pq = lineMatchedQuote({ marketType: "AH", scope: "full", line: o.line, selection: sel }, ladders.ah);
          if (!pq.lineComparable) continue;
          const sources = [pq];
          if (bfAh.length) {
            const bq = betfairAhQuote({ marketType: "AH", scope: "full", line: o.line, selection: sel }, bfAh).quote;
            if (bq.lineComparable) sources.push(bq);
          }
          if (sboAh.length) {
            const sq = sbobetAhQuote({ marketType: "AH", scope: "full", line: o.line, selection: sel }, sboAh).quote;
            if (sq.lineComparable) sources.push(sq);
          }

          const ctx: MarketContext = {
            sport: "football", market: "AH", tier, phase: "prematch", ttsBucket,
            line: o.line, selection: sel,
            eventId: pin.identity.eventId, league: pin.identity.league,
            startTime: pin.identity.startTime, homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam,
          };
          const res = evaluateMarket({ context: ctx, candidate: { bookmaker: sb.id, odds }, sources, clvMultipliers: input.clvMultipliers, shadowMode: true });
          const fairProb = res.consensus.fairProb;
          if (fairProb == null || !(fairProb > 0)) continue;
          const ev = fairProb * odds - 1;
          if (ev <= input.evThreshold || ev > input.rejectThreshold) continue;

          const dk = `${sb.id}|${pin.identity.eventId}|${o.line}|${sel}`;
          if (seen.has(dk)) continue;
          seen.add(dk);
          out.push({
            eventId: pin.identity.eventId,
            homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam, startTime: pin.identity.startTime, league: pin.identity.league,
            bookmaker: sb.id, line: o.line, selection: sel as "HOME" | "AWAY", bookmakerOdds: odds,
            fairProb, fairOdds: 1 / fairProb, ev, sources: sources.map((s) => s.sourceId),
          });
        }
      }
    }
  }
  out.sort((a, b) => b.ev - a.ev);
  return out;
}
