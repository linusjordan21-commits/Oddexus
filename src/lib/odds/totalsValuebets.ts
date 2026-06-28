/**
 * totalsValuebets.ts — backend-MOTOR för football Over/Under-valuebets (steg 1).
 *
 * Live-valuebets-pipelinen är 1X2-only: soft-böckernas totals förs inte genom
 * matchnings-indexet och Pinnacle-totals parsas inte in i live-raderna. Denna
 * modul är en PARALLELL, testbar totals-prissättning som återanvänder den TESTADE
 * consensus-motorn (Pinnacle-stege + Betfair-totals-blend + likviditet + CLV-vikt)
 * och returnerar positiva-EV O/U-erbjudanden. Ren funktion — ingen IO, inga
 * sidoeffekter — så den kan verifieras mot riktig data utan att röra live-svaret.
 *
 * Prissättning per O/U-erbjudande:
 *   fair = evaluateMarket(Pinnacle-stege [+ Betfair-totals om jämförbar/likvid])
 *   EV   = fair.fairProb × bookOdds − 1   (samma som 1X2-pathen)
 * Endast linjer Pinnacle täcker (lineMatchedQuote.lineComparable) prissätts.
 * EV utanför (evThreshold, rejectThreshold] avvisas (samma grindar som 1X2).
 */

import { normalizeTeamName, startTimeBucket } from "./matching.ts";
import {
  parsePinnacleSoccer,
  parseSoftBook,
  ttsBucketFrom,
  deriveTier,
  type PinnacleEvent,
  type CandidateEvent,
} from "./shadowConsensus.ts";
import { parsePinnacleLineLadders, type PinnacleLineLadders } from "./pinnacleLines.ts";
import { lineMatchedQuote } from "./lineMatching.ts";
import { betfairTotalsQuote, type BetfairMarket } from "./betfairAdapter.ts";
import { evaluateMarket, type MarketContext } from "./consensus.ts";
import type { Selection } from "./types.ts";

export interface TotalsValuebet {
  /** Pinnacle matchup-id (String(matchupId)) — stabil match-referens för CLV/market_key. */
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  league: string | null;
  bookmaker: string;
  line: number;
  selection: "OVER" | "UNDER";
  bookmakerOdds: number;
  /** Blandad fair-prob (Pinnacle-dominant + ev. Betfair-totals). */
  fairProb: number;
  fairOdds: number;
  ev: number;
  /** Vilka källor bidrog (pinnacle, betfair). */
  sources: string[];
}

export interface TotalsValuebetInput {
  /** Rå Pinnacle-payload (för parsePinnacleSoccer + parsePinnacleLineLadders). */
  pinnacleJson: unknown;
  /** Förparsad Pinnacle — skickas av callern så de 4 motorerna slipper parsa om
   *  samma 4,7 MB-payload var för sig (minnespik på busy dagar). Faller tillbaka
   *  på pinnacleJson om ej satt. */
  pinnacleEvents?: PinnacleEvent[];
  pinnacleLadders?: Map<string, PinnacleLineLadders>;
  /** Betfair TOTALS+AH per team-bucket (parseBetfairLineRowsMap) — endast om FÄRSK. */
  betfairLines?: Map<string, BetfairMarket[]>;
  /** Soft-böcker: rå rows-payload + id (+ ev. franchise för byFranchise-layout). */
  softBooks: Array<{ id: string; json: unknown; franchise?: string }>;
  /** Empiriska CLV-multiplikatorer per källa (data/clv-multipliers.json). */
  clvMultipliers?: Record<string, number>;
  /** EV-tröskel (t.ex. 0.02 = 2%). */
  evThreshold: number;
  /** Avvisa EV över denna (t.ex. 0.25 = 25% → nästan alltid datafel). */
  rejectThreshold: number;
  now?: number;
}

function key(h: string, a: string, startTime: string): string | null {
  const b = startTimeBucket(startTime);
  return b === null ? null : `${normalizeTeamName(h)}::${normalizeTeamName(a)}::${b}`;
}

/**
 * Beräkna football totals-valuebets ur soft-böckernas O/U mot Pinnacle-stege
 * (+ Betfair-totals). Pure. Tom lista om Pinnacle saknas/0 stegar.
 */
export function computeTotalsValuebets(input: TotalsValuebetInput): TotalsValuebet[] {
  const now = input.now ?? Date.now();
  const pinnacle = input.pinnacleEvents ?? parsePinnacleSoccer(input.pinnacleJson);
  if (pinnacle.length === 0) return [];
  const pinLines = input.pinnacleLadders ?? parsePinnacleLineLadders(input.pinnacleJson, "soccer");

  const pinIndex = new Map<string, PinnacleEvent>();
  for (const p of pinnacle) {
    const k = key(p.identity.homeTeam, p.identity.awayTeam, p.identity.startTime);
    if (k) pinIndex.set(k, p);
  }

  // Totals är symmetriska (oberoende av lag-ordning) → ingen reorientering behövs,
  // bara order-oberoende uppslag (±1 bucket, båda ordningarna).
  const lookupPin = (c: CandidateEvent): PinnacleEvent | undefined => {
    const b = startTimeBucket(c.identity.startTime);
    if (b === null) return undefined;
    const h = normalizeTeamName(c.identity.homeTeam);
    const a = normalizeTeamName(c.identity.awayTeam);
    for (const bb of [b - 1, b, b + 1]) { const hit = pinIndex.get(`${h}::${a}::${bb}`); if (hit) return hit; }
    for (const bb of [b - 1, b, b + 1]) { const hit = pinIndex.get(`${a}::${h}::${bb}`); if (hit) return hit; }
    return undefined;
  };

  const lookupBfTotals = (pin: PinnacleEvent): BetfairMarket[] => {
    if (!input.betfairLines) return [];
    const b = startTimeBucket(pin.identity.startTime);
    if (b === null) return [];
    const h = normalizeTeamName(pin.identity.homeTeam);
    const a = normalizeTeamName(pin.identity.awayTeam);
    for (const bb of [b - 1, b, b + 1]) {
      const hit = input.betfairLines.get(`${h}::${a}::${bb}`) ?? input.betfairLines.get(`${a}::${h}::${bb}`);
      if (hit) return hit.filter((m) => m.marketType === "TOTALS");
    }
    return [];
  };

  const out: TotalsValuebet[] = [];
  const seen = new Set<string>();

  for (const sb of input.softBooks) {
    let candidates: CandidateEvent[] = [];
    try { candidates = parseSoftBook(sb.json, sb.id, sb.franchise); } catch { continue; }
    for (const c of candidates) {
      if (!c.totals?.length) continue;
      const pin = lookupPin(c);
      if (!pin) continue;
      const ladders = pinLines.get(pin.identity.eventId);
      if (!ladders || ladders.totals.points.length === 0) continue;
      const bfTotals = lookupBfTotals(pin);
      const tier = deriveTier(pin.identity.league);
      const ttsBucket = ttsBucketFrom(pin.identity.startTime, now);

      for (const t of c.totals) {
        if (!Number.isFinite(t.line)) continue;
        for (const sel of ["OVER", "UNDER"] as Selection[]) {
          const odds = sel === "OVER" ? t.over : t.under;
          if (!Number.isFinite(odds) || odds <= 1) continue;

          const pq = lineMatchedQuote({ marketType: "TOTAL", scope: "match_total", line: t.line, selection: sel }, ladders.totals);
          if (!pq.lineComparable) continue; // bara linjer Pinnacle täcker
          const sources = [pq];
          if (bfTotals.length) {
            const bq = betfairTotalsQuote({ marketType: "TOTAL", scope: "match_total", line: t.line, selection: sel }, bfTotals).quote;
            if (bq.lineComparable) sources.push(bq);
          }

          const ctx: MarketContext = {
            sport: "football", market: "TOTAL", tier, phase: "prematch", ttsBucket,
            line: t.line, selection: sel,
            eventId: pin.identity.eventId, league: pin.identity.league,
            startTime: pin.identity.startTime, homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam,
          };
          const res = evaluateMarket({ context: ctx, candidate: { bookmaker: sb.id, odds }, sources, clvMultipliers: input.clvMultipliers, shadowMode: true });
          const fairProb = res.consensus.fairProb;
          if (fairProb == null || !(fairProb > 0)) continue;
          const ev = fairProb * odds - 1;
          if (ev <= input.evThreshold || ev > input.rejectThreshold) continue;

          const dk = `${sb.id}|${pin.identity.eventId}|${t.line}|${sel}`;
          if (seen.has(dk)) continue;
          seen.add(dk);
          out.push({
            eventId: pin.identity.eventId,
            homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam, startTime: pin.identity.startTime, league: pin.identity.league,
            bookmaker: sb.id, line: t.line, selection: sel as "OVER" | "UNDER", bookmakerOdds: odds,
            fairProb, fairOdds: 1 / fairProb, ev, sources: sources.map((s) => s.sourceId),
          });
        }
      }
    }
  }
  out.sort((a, b) => b.ev - a.ev);
  return out;
}
