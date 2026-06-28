/**
 * sharpBlend.ts — blandar in SKARPA komplement-källor (SBOBET, Betfair) i den
 * Pinnacle-baserade fair-price som /api/valuebets använder.
 *
 * Designprinciper (säkerhet före allt — detta påverkar riktiga valuebets):
 *   - PINNACLE DOMINERAR. Sharparna NUDGAR bara fair price; de kan aldrig ensamma
 *     skapa en valuebet. Vikt: pinnacle 2.5, sbobet 0.7, betfair 0.8×likviditet.
 *   - HÅRD FÄRSKHETSGRIND. En källa äldre än `freshnessMs` exkluderas HELT ur
 *     blandningen (buildSharpIndex släpper då dess karta). Stale sharp ⇒ ingen
 *     påverkan ⇒ inga falska valuebets från gammal data.
 *   - ORDER-OBEROENDE matchning mot Pinnacle (samma team-bucket-nyckel + ±1
 *     bucket + home/away-swap som shadowConsensus).
 *   - Allt sker i PINNACLES native HOME/DRAW/AWAY-rum. Anroparen mappar tillbaka
 *     till bonus-matchens 1/X/2-ordning.
 *   - Felsäker: saknad/trasig sharp-data ⇒ returnera Pinnacle oförändrad.
 */

import { normalizeTeamName, startTimeBucket } from "./matching.ts";
import { parseSbobetRowsMap, parseBetfairRowsMap } from "./shadowConsensus.ts";
import { sbobetMoneylineQuote } from "./sbobetAdapter.ts";
import { betfairMoneylineQuote, normalizeMarket, type BetfairMarket } from "./betfairAdapter.ts";
import type { SbobetMarket } from "./sbobetScrapeParse.ts";
import type { Selection } from "./types.ts";

export type Triple = { HOME: number; DRAW: number; AWAY: number };

const OUTCOME_SELECTIONS: Selection[] = ["HOME", "DRAW", "AWAY"];
const OPP: Record<Selection, Selection> = { HOME: "AWAY", DRAW: "DRAW", AWAY: "HOME" };

export const DEFAULT_SHARP_WEIGHTS = { pinnacle: 2.5, sbobet: 0.7, betfair: 0.8 };

/**
 * Pinnacle-LIKVIDITET via bet-limit (max-insats). Pinnacle höjer limit i takt med
 * att marknaden skärps → hög limit = likvid/skarp marknad (full vikt); låg/tidig
 * limit = tunn marknad där vi bör luta oss RELATIVT mer på övriga sharps. Okänd
 * limit ⇒ 1.0 (neutralt, ingen bestraffning). $2500+ ⇒ full vikt.
 */
export function pinnacleLiquidityFactor(limit: number | null | undefined): number {
  if (limit == null || !(limit > 0)) return 1.0;
  return Math.max(0.4, Math.min(1.0, 0.4 + 0.6 * Math.min(1, limit / 2500)));
}

export interface SharpIndex {
  sbobet: Map<string, SbobetMarket> | null;
  betfair: Map<string, BetfairMarket> | null;
  sbobetFresh: boolean;
  betfairFresh: boolean;
  ageSec: { sbobet: number | null; betfair: number | null };
  /** Empiriska CLV-multiplikatorer per källa (clv-calibrate). {} = alla 1.0. */
  clvMultipliers: Record<string, number>;
}

function ageMs(updatedAt: string | null | undefined, now: number): number | null {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) && ms > 0 ? now - ms : null;
}

/**
 * Bygg ett sharp-index ur råa payloads. En källa parsas BARA om den är färsk
 * (<= freshnessMs); annars släpps den (null) så den aldrig blandas in stale.
 */
export function buildSharpIndex(opts: {
  sbobetJson: unknown;
  sbobetUpdatedAt: string | null | undefined;
  betfairJson: unknown;
  betfairUpdatedAt: string | null | undefined;
  freshnessMs: number;
  /** Empiriska CLV-multiplikatorer per källa (clv-calibrate → data/clv-multipliers.json). */
  clvMultipliers?: Record<string, number>;
  now?: number;
}): SharpIndex {
  const now = opts.now ?? Date.now();
  const sboAge = ageMs(opts.sbobetUpdatedAt, now);
  const bfAge = ageMs(opts.betfairUpdatedAt, now);
  const sbobetFresh = sboAge !== null && sboAge <= opts.freshnessMs;
  const betfairFresh = bfAge !== null && bfAge <= opts.freshnessMs;
  return {
    sbobet: sbobetFresh ? safeParse(() => parseSbobetRowsMap(opts.sbobetJson)) : null,
    betfair: betfairFresh ? safeParse(() => parseBetfairRowsMap(opts.betfairJson)) : null,
    sbobetFresh,
    betfairFresh,
    ageSec: {
      sbobet: sboAge !== null ? Math.floor(sboAge / 1000) : null,
      betfair: bfAge !== null ? Math.floor(bfAge / 1000) : null,
    },
    clvMultipliers: opts.clvMultipliers ?? {},
  };
}

function safeParse<T>(fn: () => Map<string, T>): Map<string, T> | null {
  try {
    const m = fn();
    return m.size > 0 ? m : null;
  } catch {
    return null;
  }
}

function lookup<T>(map: Map<string, T> | null, h: string, a: string, bucket: number): { v: T; swapped: boolean } | undefined {
  if (!map) return undefined;
  for (const b of [bucket - 1, bucket, bucket + 1]) {
    const hit = map.get(`${h}::${a}::${b}`);
    if (hit) return { v: hit, swapped: false };
  }
  for (const b of [bucket - 1, bucket, bucket + 1]) {
    const hit = map.get(`${a}::${h}::${b}`);
    if (hit) return { v: hit, swapped: true };
  }
  return undefined;
}

/**
 * SBOBET-LIKVIDITET via marginal (overround). SBOBET är en tight asiatisk bok; en
 * SMAL marginal (~2-4%) = skarp/likvid marknad (full vikt), en VID marginal = tunn/
 * mindre tillförlitlig marknad (nedvägd). Detta är SBOBET:s data-drivna likviditets-
 * proxy (ingen orderbok finns). Okänd/ogiltig ⇒ 1.0.
 */
export function sbobetMarginFactor(market: SbobetMarket): number {
  let inv = 0, n = 0;
  for (const r of market.runners) {
    if (r.decimalOdds > 1) { inv += 1 / r.decimalOdds; n++; }
  }
  if (n < 3) return 1.0;
  const overround = inv - 1; // t.ex. 0.03 = 3% marginal
  return Math.max(0.5, Math.min(1.0, 1.0 - Math.max(0, overround - 0.04) * 8));
}

/** SBOBET no-vig 1X2-probs i Pinnacle-native ordning (null om ofullständig). */
function sbobetTriple(market: SbobetMarket, swapped: boolean): Triple | null {
  const probOf = (sel: Selection) => sbobetMoneylineQuote(market, swapped ? OPP[sel] : sel);
  const q = { HOME: probOf("HOME"), DRAW: probOf("DRAW"), AWAY: probOf("AWAY") };
  if (!q.HOME.lineComparable || !q.DRAW.lineComparable || !q.AWAY.lineComparable) return null;
  return { HOME: q.HOME.fairProb, DRAW: q.DRAW.fairProb, AWAY: q.AWAY.fairProb };
}

/** Betfair no-vig 1X2-probs (Pinnacle-native) + min-likviditet (null om ofullständig). */
/** Rå börspris för ETT utfall (§2): bästa back, bästa lay, mid (decimal-odds). */
export type ExchangeBook = { back: number; lay: number; mid: number | null };

function betfairTriple(
  market: BetfairMarket,
  swapped: boolean,
): { triple: Triple; liq: number; spreadPct: number | null; matchedVolume: number; book: Partial<Record<Selection, ExchangeBook>> } | null {
  const qOf = (sel: Selection) => betfairMoneylineQuote(market, swapped ? OPP[sel] : sel).quote;
  const q = { HOME: qOf("HOME"), DRAW: qOf("DRAW"), AWAY: qOf("AWAY") };
  if (!q.HOME.lineComparable || !q.DRAW.lineComparable || !q.AWAY.lineComparable) return null;
  const liq = Math.min(q.HOME.liquidityFactor ?? 0, q.DRAW.liquidityFactor ?? 0, q.AWAY.liquidityFactor ?? 0);
  if (!(liq > 0)) return null;
  // Likviditets-metrik + RÅ ORDERBOK för Market Trust Layer — PÅVERKAR INTE blandningen,
  // bara observerbarhet: värsta back/lay-spread + total matchad volym + per-utfall back/lay/mid.
  const snap = normalizeMarket(market).snapshot;
  const spreads = snap.runners.map((r) => r.spreadPct).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const spreadPct = spreads.length ? Math.max(...spreads) : null;
  const runnerBy = new Map(snap.runners.map((r) => [r.selection, r] as const));
  const book: Partial<Record<Selection, ExchangeBook>> = {};
  for (const o of OUTCOME_SELECTIONS) {
    const r = runnerBy.get(swapped ? OPP[o] : o); // native → Betfair-selection (swap-medveten)
    if (r && r.backOdds > 0 && r.layOdds > 0) {
      book[o] = { back: r.backOdds, lay: r.layOdds, mid: r.midpointProb != null && r.midpointProb > 0 ? 1 / r.midpointProb : null };
    }
  }
  return {
    triple: { HOME: q.HOME.fairProb, DRAW: q.DRAW.fairProb, AWAY: q.AWAY.fairProb },
    liq,
    spreadPct,
    matchedVolume: market.matchedVolume,
    book,
  };
}

/** Betfair-likviditet för en matchad marknad (Market Trust Layer, fas 2). */
export interface BetfairLiquidityInfo {
  liquidityFactor: number; // 0..1 (depth/spread/volym-vägd, min över utfallen)
  spreadPct: number | null; // värsta utfallets back/lay-spread i %
  matchedVolume: number; // total matchad volym på marknaden
}

export interface BlendResult {
  blended: Triple;
  sources: string[];
  /** Betfair-likviditet om en färsk Betfair-marknad matchade (annars null/utelämnad). */
  betfairLiquidity?: BetfairLiquidityInfo | null;
  /** §2: rå Betfair-orderbok (back/lay/mid) per utfall (Pinnacle-native) om matchad. */
  betfairBook?: Partial<Record<Selection, ExchangeBook>> | null;
  /**
   * Market Trust Layer: VARJE källas individuella no-vig fairProb-triple (Pinnacle-native
   * HOME/DRAW/AWAY) — INNAN viktningen. För tracking/analys (per-sharp pris + consensus-
   * spridning). Påverkar INTE blandningen. pinnacle finns alltid; sbobet/betfair om matchade.
   */
  perSource?: { pinnacle: Triple; sbobet?: Triple; betfair?: Triple };
}

/**
 * Blanda Pinnacles native fair-probs med färska sharp-komplement (Pinnacle-dominant
 * viktat medel). Returnerar Pinnacle oförändrad om inga sharps matchar/är färska.
 * pinnacleFair måste summera till ~1 (no-vig). Resultatet summerar till 1.
 */
export function blendNativeFair(
  pinnacleFair: Triple,
  homeName: string,
  awayName: string,
  startTimeMs: number,
  idx: SharpIndex,
  weights = DEFAULT_SHARP_WEIGHTS,
  pinnacleLimit?: number | null,
): BlendResult {
  if (!homeName || !awayName || !Number.isFinite(startTimeMs)) return { blended: pinnacleFair, sources: [] };
  const bucket = startTimeBucket(new Date(startTimeMs).toISOString());
  if (bucket === null) return { blended: pinnacleFair, sources: [] };
  const h = normalizeTeamName(homeName);
  const a = normalizeTeamName(awayName);

  // Empirisk trust × Pinnacle-likviditet: skala varje källas vikt med dess CLV-
  // multiplikator; Pinnacle-vikten skalas dessutom med limit-baserad likviditet
  // (tunn Pinnacle-marknad → övriga sharps väger relativt tyngre). Saknas ⇒ 1.0.
  const cm = idx.clvMultipliers ?? {};
  const wPin = weights.pinnacle * (cm.pinnacle ?? 1) * pinnacleLiquidityFactor(pinnacleLimit);
  const acc: Triple = {
    HOME: pinnacleFair.HOME * wPin,
    DRAW: pinnacleFair.DRAW * wPin,
    AWAY: pinnacleFair.AWAY * wPin,
  };
  let wsum = wPin;
  const sources: string[] = [];
  let betfairLiquidity: BetfairLiquidityInfo | null = null;
  let betfairBook: Partial<Record<Selection, ExchangeBook>> | null = null;
  const perSource: { pinnacle: Triple; sbobet?: Triple; betfair?: Triple } = { pinnacle: pinnacleFair };

  const sbo = lookup(idx.sbobet, h, a, bucket);
  if (sbo) {
    const t = sbobetTriple(sbo.v, sbo.swapped);
    if (t) {
      // SBOBET-likviditet via marginal (smal bok → full vikt, vid bok → nedvägd).
      const w = weights.sbobet * (cm.sbobet ?? 1) * sbobetMarginFactor(sbo.v);
      for (const o of OUTCOME_SELECTIONS) acc[o] += t[o] * w;
      wsum += w;
      sources.push("sbobet");
      perSource.sbobet = t; // individuellt pris för tracking (ändrar ej blandningen)
    }
  }

  const bf = lookup(idx.betfair, h, a, bucket);
  if (bf) {
    const r = betfairTriple(bf.v, bf.swapped);
    if (r) {
      const w = weights.betfair * (cm.betfair ?? 1) * r.liq; // likviditets- + trust-vägd
      for (const o of OUTCOME_SELECTIONS) acc[o] += r.triple[o] * w;
      wsum += w;
      sources.push("betfair");
      // Surfa likviditeten + rå orderbok för Market Trust Layer (ändrar inte blandningen ovan).
      betfairLiquidity = { liquidityFactor: r.liq, spreadPct: r.spreadPct, matchedVolume: r.matchedVolume };
      betfairBook = r.book;
      perSource.betfair = r.triple; // individuellt pris för tracking
    }
  }

  if (sources.length === 0 || wsum <= 0) return { blended: pinnacleFair, sources: [], perSource, betfairBook };
  // Viktat medel: acc[o]/wsum summerar redan till 1 (alla källor summerar till 1).
  return {
    blended: { HOME: acc.HOME / wsum, DRAW: acc.DRAW / wsum, AWAY: acc.AWAY / wsum },
    sources,
    betfairLiquidity,
    betfairBook,
    perSource,
  };
}
