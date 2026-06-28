/**
 * eh3Valuebets.ts — backend-MOTOR för EUROPEISKT 3-vägs-handikapp (1/X/2 med oavgjort).
 *
 * SÄKER fair price (v2): Pinnacle exponerar inte europeiskt 3-vägs-HC som marknad,
 * men det är en EXAKT funktion av målmarginalen M = hemmamål − bortamål. Vi läser
 * AH-hemma-sannolikheten vid halvlinjerna H±0.5 ur en MULTI-SKARP KONSENSUS (samma
 * motor som AH-valuebets): Pinnacle (ankare) + Betfair-börs + SBOBET + Smarkets,
 * viktad på trust/likviditet/CLV. Aldrig Pinnacle ensam.
 *
 *   AH_hemma(linje L) = P(M > −L)
 *   P(hemma|H) = AH_hemma(H − 0.5)
 *   P(oavgjort|H) = AH_hemma(H + 0.5) − AH_hemma(H − 0.5)
 *   P(borta|H) = 1 − AH_hemma(H + 0.5)
 *
 * GRINDAR (mot falska valuebets): (1) båda halvlinjerna måste vara jämförbara i
 * konsensus, (2) minst `minConfirmers` skarpa confirmers utöver Pinnacle vid BÅDA
 * linjerna, (3) inga disagreement-flaggor (spridning/divergens), (4) monotonicitet
 * + positiv oavgjort-massa, (5) EV-/reject-grindar. Allt prissätts i Pinnacle-native
 * ordning; kastade kandidater reorienteras (H → −H, hemma↔borta, oavgjort stilla).
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
import { smarketsAhQuote, type SmarketsAhOffer } from "./smarketsAdapter.ts";
import { evaluateMarket, type MarketContext } from "./consensus.ts";
import type { SourceQuote } from "./consensusTypes.ts";

export type Eh3Selection = "HOME" | "DRAW" | "AWAY";

export interface Eh3Valuebet {
  /** Pinnacle matchup-id (String(matchupId)) — stabil match-referens för CLV/market_key. */
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  league: string | null;
  bookmaker: string;
  /** Handikapp-linje ur HEMMA-perspektiv (heltal, t.ex. -1). */
  line: number;
  selection: Eh3Selection;
  bookmakerOdds: number;
  fairProb: number;
  fairOdds: number;
  ev: number;
  sources: string[];
}

export interface Eh3ValuebetInput {
  pinnacleJson: unknown;
  /** Förparsad Pinnacle (delas mellan motorerna → slipper om-parsning). */
  pinnacleEvents?: PinnacleEvent[];
  pinnacleLadders?: Map<string, PinnacleLineLadders>;
  /** Betfair TOTALS+AH per team-bucket (parseBetfairLineRowsMap) — om FÄRSK. */
  betfairLines?: Map<string, BetfairMarket[]>;
  /** SBOBET AH-stegar per team-bucket (parseSbobetAhRowsMap) — om FÄRSK. */
  sbobetAh?: Map<string, SbobetMarket[]>;
  /** Smarkets AH-erbjudanden per team-bucket (parseSmarketsAhRowsMap) — om FÄRSK. */
  smarketsAh?: Map<string, SmarketsAhOffer[]>;
  softBooks: Array<{ id: string; json: unknown; franchise?: string }>;
  clvMultipliers?: Record<string, number>;
  evThreshold: number;
  rejectThreshold: number;
  /** Min antal skarpa confirmers (utöver Pinnacle) som krävs vid BÅDA halvlinjerna. Default 1. */
  minConfirmers?: number;
  now?: number;
}

function key(h: string, a: string, startTime: string): string | null {
  const b = startTimeBucket(startTime);
  return b === null ? null : `${normalizeTeamName(h)}::${normalizeTeamName(a)}::${b}`;
}

export function computeEh3Valuebets(input: Eh3ValuebetInput): Eh3Valuebet[] {
  const now = input.now ?? Date.now();
  const minConfirmers = input.minConfirmers ?? 1;
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

  const out: Eh3Valuebet[] = [];
  const seen = new Set<string>();

  for (const sb of input.softBooks) {
    let candidates: CandidateEvent[] = [];
    try { candidates = parseSoftBook(sb.json, sb.id, sb.franchise); } catch { continue; }
    for (const c of candidates) {
      if (!c.eh3?.length) continue;
      const m = lookupPin(c);
      if (!m) continue;
      const pin = m.pin;
      const ladders = pinLines.get(pin.identity.eventId);
      if (!ladders || ladders.ah.points.length === 0) continue;

      // Skarpa AH-källor → Pinnacle-ordning.
      const bfHit = lookupSource(input.betfairLines, pin);
      let bfAh: BetfairMarket[] = [];
      if (bfHit) {
        const ahMk = bfHit.markets.filter((x) => x.marketType === "AH");
        bfAh = bfHit.swapped ? swapBetfairLineOrientation(ahMk) : ahMk;
      }
      const sboHit = lookupSource(input.sbobetAh, pin);
      let sboAh: SbobetMarket[] = [];
      if (sboHit) sboAh = sboHit.swapped ? swapSbobetAhOrientation(sboHit.markets) : sboHit.markets;

      const smHit = lookupSource(input.smarketsAh, pin);
      let smAh: SmarketsAhOffer[] = [];
      if (smHit) smAh = smHit.swapped ? smHit.markets.map((o) => ({ line: -o.line, home: o.away, away: o.home })) : smHit.markets;

      const tier = deriveTier(pin.identity.league);
      const ttsBucket = ttsBucketFrom(pin.identity.startTime, now);

      // Konsensus-AH-hemma vid linje L (Pinnacle-ankare + Betfair + SBOBET + Smarkets).
      // Returnerar fair prob + antal skarpa confirmers + disagreement-flaggor.
      const consensusAhHome = (L: number): { fairProb: number; confirmers: number; flags: string[] } | null => {
        const pq = lineMatchedQuote({ marketType: "AH", scope: "full", line: L, selection: "HOME" }, ladders.ah);
        if (!pq.lineComparable || pq.fairProb == null) return null; // kräver Pinnacle-ankare
        const sources: SourceQuote[] = [pq];
        if (bfAh.length) { const q = betfairAhQuote({ marketType: "AH", scope: "full", line: L, selection: "HOME" }, bfAh).quote; if (q.lineComparable) sources.push(q); }
        if (sboAh.length) { const q = sbobetAhQuote({ marketType: "AH", scope: "full", line: L, selection: "HOME" }, sboAh).quote; if (q.lineComparable) sources.push(q); }
        if (smAh.length) { const q = smarketsAhQuote({ marketType: "AH", scope: "full", line: L, selection: "HOME" }, smAh).quote; if (q.lineComparable) sources.push(q); }
        const ctx: MarketContext = {
          sport: "football", market: "AH", tier, phase: "prematch", ttsBucket,
          line: L, selection: "HOME",
          eventId: pin.identity.eventId, league: pin.identity.league,
          startTime: pin.identity.startTime, homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam,
        };
        const res = evaluateMarket({ context: ctx, candidate: { bookmaker: "_eh3", odds: 2 }, sources, clvMultipliers: input.clvMultipliers, shadowMode: true });
        const fp = res.consensus.fairProb;
        if (fp == null || !(fp > 0) || !(fp < 1)) return null;
        const confirmers = res.consensus.sources.filter((r) => r.role !== "ignore" && !r.isPinnacle && r.fairProb != null).length;
        return { fairProb: fp, confirmers, flags: res.consensus.disagreementFlags };
      };

      // Kandidatens EH3 → Pinnacle-ordning (negera linje + byt hemma/borta om kastad; oavgjort stilla).
      const offers = m.swapped
        ? c.eh3.map((o) => ({ line: -o.line, home: o.away, draw: o.draw, away: o.home }))
        : c.eh3;

      for (const o of offers) {
        const H = o.line;
        if (!Number.isFinite(H)) continue;
        const cLow = consensusAhHome(H - 0.5); // P(M ≥ 1−H)
        const cHigh = consensusAhHome(H + 0.5); // P(M ≥ −H)
        if (!cLow || !cHigh) continue;
        // GRIND: tvinga fler-källskonfirmation vid BÅDA linjerna + inga disagreement-flaggor.
        if (cLow.confirmers < minConfirmers || cHigh.confirmers < minConfirmers) continue;
        if (cLow.flags.length > 0 || cHigh.flags.length > 0) continue;

        let pH = cLow.fairProb;
        let pD = cHigh.fairProb - cLow.fairProb; // P(M = −H)
        let pA = 1 - cHigh.fairProb;
        // Monotonicitet + positiv oavgjort-massa (litet brus tolereras, grovt inkonsistent förkastas).
        if (pD < -0.02 || pH <= 0 || pA <= 0) continue;
        if (pD < 0) pD = 0.0001;
        const sum = pH + pD + pA;
        if (!(sum > 0)) continue;
        pH /= sum; pD /= sum; pA /= sum;

        const triples: Array<{ sel: Eh3Selection; prob: number; odds: number }> = [
          { sel: "HOME", prob: pH, odds: o.home },
          { sel: "DRAW", prob: pD, odds: o.draw },
          { sel: "AWAY", prob: pA, odds: o.away },
        ];
        for (const t of triples) {
          if (!Number.isFinite(t.odds) || t.odds <= 1) continue;
          if (!(t.prob > 0)) continue;
          const ev = t.prob * t.odds - 1;
          if (ev <= input.evThreshold || ev > input.rejectThreshold) continue;
          const dk = `${sb.id}|${pin.identity.eventId}|${H}|${t.sel}`;
          if (seen.has(dk)) continue;
          seen.add(dk);
          out.push({
            eventId: pin.identity.eventId,
            homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam,
            startTime: pin.identity.startTime, league: pin.identity.league,
            bookmaker: sb.id, line: H, selection: t.sel, bookmakerOdds: t.odds,
            fairProb: t.prob, fairOdds: 1 / t.prob, ev,
            sources: ["pinnacle-ah-consensus", `c${Math.min(cLow.confirmers, cHigh.confirmers)}`],
          });
        }
      }
    }
  }
  out.sort((a, b) => b.ev - a.ev);
  return out;
}
