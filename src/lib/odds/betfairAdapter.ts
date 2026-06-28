/**
 * betfairAdapter.ts — normaliserar Betfair Exchange-marknader till vårt
 * interna format (SourceLadder / SourceQuote) för consensus-mellanlagret.
 *
 * Feed-agnostiskt: adaptern tar redan parsad order book-data (BetfairMarket)
 * från en provider. En MockBetfairProvider medföljer så allt kan köras utan
 * nätverk. Riktig hämtning (officiellt Exchange-API) implementeras som en
 * separat provider SENARE — adaptern bryr sig inte om hur datan kom in.
 *
 * Konservativa regler (shadow mode):
 *   - ALDRIG best back ensam → weighted midpoint (evaluateBetfairLiquidity).
 *   - Illikvid/wide-spread/tunn bok → liquidityFactor 0 → consensus ignorerar.
 *   - Multi-runner (1X2/match winner) devig:as genom normalisering över runners.
 *   - Totals byggs som SourceLadder per lina → lineMatching (exact först).
 *   - INGA player props i v1. INGA lågvolymsmarknader.
 *   - Order book-snapshot returneras alltid (loggas i CLV).
 *
 * v1-marknader: fotboll 1X2 (MATCH_ODDS), fotboll totals, tennis matchvinnare.
 */

import type { Selection } from "./types.ts";
import type { BenchSport, SourceQuote } from "./consensusTypes.ts";
import { evaluateBetfairLiquidity, type BetfairOrderBook } from "./betfairLiquidityFilter.ts";
import {
  lineMatchedQuote,
  matchLine,
  type LineMatchResult,
  type LineMatchTarget,
  type SourceLadder,
} from "./lineMatching.ts";

export const BETFAIR_SOURCE_ID = "betfair";

export type BetfairMarketType = "MATCH_ODDS" | "MATCH_WINNER" | "TOTALS" | "AH";

/** En runner (utfall) med bästa back/lay + tillgängliga belopp. */
export interface BetfairRunner {
  selection: Selection; // HOME/DRAW/AWAY för match odds; OVER/UNDER för totals
  backOdds: number;
  layOdds: number;
  backDepth: number;
  layDepth: number;
}

/** En Betfair-marknad (1 marknad = 1 lina för totals). */
export interface BetfairMarket {
  marketId: string;
  sport: BenchSport;
  marketType: BetfairMarketType;
  /** "full" för match odds/winner, "match_total" för totals osv. */
  scope: string;
  /** Endast för TOTALS. */
  line?: number;
  /** Totalt matchat belopp på marknaden (likviditetsmått). */
  matchedVolume: number;
  runners: BetfairRunner[];
}

/** Provider-interface — gör adaptern feed-agnostisk. */
export interface BetfairMarketProvider {
  getMarkets(): Promise<BetfairMarket[]>;
}

/** Order book-snapshot som loggas i CLV (per marknad). */
export interface BetfairBookSnapshot {
  marketId: string;
  marketType: BetfairMarketType;
  scope: string;
  line: number | null;
  matchedVolume: number;
  liquidityFactor: number;
  pass: boolean;
  runners: {
    selection: Selection;
    backOdds: number;
    layOdds: number;
    backDepth: number;
    layDepth: number;
    midpointProb: number | null;
    spreadPct: number | null;
    liquidityFactor: number;
    pass: boolean;
  }[];
}

interface RunnerEval {
  selection: Selection;
  midProb: number | null;
  fairProb: number | null; // efter normalisering över runners
  liquidityFactor: number;
  pass: boolean;
  spreadPct: number | null;
  book: BetfairOrderBook;
}

interface NormalizedMarket {
  perSelection: Map<Selection, RunnerEval>;
  /** Min liquidityFactor över alla runners (konservativt). */
  marketLiquidityFactor: number;
  /** True bara om ALLA runners passerar likviditetsfiltret. */
  marketPass: boolean;
  snapshot: BetfairBookSnapshot;
}

function runnerBook(r: BetfairRunner, matchedVolume: number): BetfairOrderBook {
  return { backOdds: r.backOdds, layOdds: r.layOdds, backDepth: r.backDepth, layDepth: r.layDepth, matchedVolume };
}

/**
 * Normalisera en marknad: weighted midpoint per runner + likviditet, sedan
 * devig genom normalisering över runners (Σ fairProb = 1).
 */
export function normalizeMarket(market: BetfairMarket): NormalizedMarket {
  const evals: RunnerEval[] = market.runners.map((r) => {
    const book = runnerBook(r, market.matchedVolume);
    const liq = evaluateBetfairLiquidity(book, market.sport);
    return {
      selection: r.selection,
      midProb: liq.midpointProb,
      fairProb: null,
      liquidityFactor: liq.liquidityFactor,
      pass: liq.pass,
      spreadPct: liq.spreadPct,
      book,
    };
  });

  // Devig: normalisera midpoint-prob över runners (tar bort börs-spread-vig).
  const sumMid = evals.reduce((a, e) => a + (e.midProb ?? 0), 0);
  for (const e of evals) {
    e.fairProb = sumMid > 0 && e.midProb != null ? e.midProb / sumMid : null;
  }

  const marketPass = evals.every((e) => e.pass);
  const marketLiquidityFactor = marketPass ? Math.min(...evals.map((e) => e.liquidityFactor)) : 0;

  const snapshot: BetfairBookSnapshot = {
    marketId: market.marketId,
    marketType: market.marketType,
    scope: market.scope,
    line: market.line ?? null,
    matchedVolume: market.matchedVolume,
    liquidityFactor: marketLiquidityFactor,
    pass: marketPass,
    runners: evals.map((e) => ({
      selection: e.selection,
      backOdds: e.book.backOdds,
      layOdds: e.book.layOdds,
      backDepth: e.book.backDepth,
      layDepth: e.book.layDepth,
      midpointProb: e.midProb,
      spreadPct: e.spreadPct,
      liquidityFactor: e.liquidityFactor,
      pass: e.pass,
    })),
  };

  const perSelection = new Map<Selection, RunnerEval>();
  for (const e of evals) perSelection.set(e.selection, e);
  return { perSelection, marketLiquidityFactor, marketPass, snapshot };
}

export interface BetfairQuoteResult {
  quote: SourceQuote;
  snapshot: BetfairBookSnapshot;
  lineMatch: LineMatchResult | null;
}

/**
 * 1X2 / matchvinnare (ingen lina). Bygg SourceQuote för en selection.
 * Illikvid marknad → liquidityFactor 0 → consensus sätter role=ignore.
 */
export function betfairMoneylineQuote(market: BetfairMarket, selection: Selection): BetfairQuoteResult {
  const norm = normalizeMarket(market);
  const sel = norm.perSelection.get(selection);
  return {
    quote: {
      sourceId: BETFAIR_SOURCE_ID,
      fairProb: sel?.fairProb ?? 0,
      isExchange: true,
      liquidityFactor: norm.marketLiquidityFactor,
      lineComparable: sel?.fairProb != null && norm.marketPass,
      lineMatchConfidence: 1, // ingen lina att matcha
    },
    snapshot: norm.snapshot,
    lineMatch: null,
  };
}

/**
 * Bygg en totals-SourceLadder (canonical = OVER fairProb per lina) + en
 * map lina→liquidityFactor, från flera per-lina-marknader.
 */
export function buildTotalsLadder(
  markets: BetfairMarket[],
  scope: string,
): { ladder: SourceLadder; lineLiquidity: Map<number, number>; snapshots: BetfairBookSnapshot[] } {
  const points: { line: number; prob: number }[] = [];
  const lineLiquidity = new Map<number, number>();
  const snapshots: BetfairBookSnapshot[] = [];
  for (const m of markets) {
    if (m.marketType !== "TOTALS" || m.line == null) continue;
    const norm = normalizeMarket(m);
    const over = norm.perSelection.get("OVER");
    if (over?.fairProb == null) continue;
    points.push({ line: m.line, prob: over.fairProb });
    lineLiquidity.set(m.line, norm.marketLiquidityFactor);
    snapshots.push(norm.snapshot);
  }
  return {
    ladder: { sourceId: BETFAIR_SOURCE_ID, marketType: "TOTAL", scope, points },
    lineLiquidity,
    snapshots,
  };
}

/**
 * Totals-quote: line-matcha target mot Betfair-stegen (exact först), och
 * härled liquidityFactor från de FAKTISKT använda linorna (min, konservativt).
 * rejected line match → lineComparable false → consensus ignorerar Betfair.
 */
export function betfairTotalsQuote(
  target: LineMatchTarget,
  markets: BetfairMarket[],
): BetfairQuoteResult {
  const { ladder, lineLiquidity, snapshots } = buildTotalsLadder(markets, target.scope);
  const m = matchLine(target, ladder);

  let liquidityFactor = 0;
  if (m.comparable && m.sourceLineUsed != null) {
    const used = Array.isArray(m.sourceLineUsed) ? m.sourceLineUsed : [m.sourceLineUsed];
    const factors = used.map((l) => lineLiquidity.get(l) ?? 0);
    liquidityFactor = factors.length ? Math.min(...factors) : 0;
  }

  // Snapshot för de använda linorna (eller alla om rejected, för felsökning).
  const usedLines = m.comparable && m.sourceLineUsed != null
    ? new Set(Array.isArray(m.sourceLineUsed) ? m.sourceLineUsed : [m.sourceLineUsed])
    : null;
  const relevantSnaps = usedLines ? snapshots.filter((s) => s.line != null && usedLines.has(s.line)) : snapshots;

  return {
    quote: {
      sourceId: BETFAIR_SOURCE_ID,
      fairProb: m.fairProb ?? 0,
      isExchange: true,
      liquidityFactor,
      lineComparable: m.comparable && liquidityFactor > 0,
      lineMatchConfidence: m.lineMatchConfidence,
    },
    snapshot: mergeSnapshots(relevantSnaps, target.scope),
    lineMatch: m,
  };
}

/**
 * Bygg en Asian Handicap-SourceLadder (canonical = HOME no-vig-prob per linje) +
 * map lina→liquidityFactor, ur flera AH-marknader (en per linje) för samma event.
 * Tecknet på linjen är ur HEMMA-perspektiv (samma konvention som Pinnacle/SBOBET).
 */
export function buildAhLadder(
  markets: BetfairMarket[],
  scope: string,
): { ladder: SourceLadder; lineLiquidity: Map<number, number>; snapshots: BetfairBookSnapshot[] } {
  const points: { line: number; prob: number }[] = [];
  const lineLiquidity = new Map<number, number>();
  const snapshots: BetfairBookSnapshot[] = [];
  for (const m of markets) {
    if (m.marketType !== "AH" || m.line == null) continue;
    const norm = normalizeMarket(m);
    const home = norm.perSelection.get("HOME");
    if (home?.fairProb == null) continue;
    points.push({ line: m.line, prob: home.fairProb });
    lineLiquidity.set(m.line, norm.marketLiquidityFactor);
    snapshots.push(norm.snapshot);
  }
  return { ladder: { sourceId: BETFAIR_SOURCE_ID, marketType: "AH", scope, points }, lineLiquidity, snapshots };
}

/**
 * AH-quote: line-matcha target mot Betfair-stegen (exact först) och härled
 * liquidityFactor ur de FAKTISKT använda linorna (min, konservativt). Spegelbild
 * av betfairTotalsQuote men för asiatiskt handikapp (HOME/AWAY 2-vägs).
 */
export function betfairAhQuote(
  target: LineMatchTarget,
  markets: BetfairMarket[],
): BetfairQuoteResult {
  const { ladder, lineLiquidity, snapshots } = buildAhLadder(markets, target.scope);
  const m = matchLine(target, ladder);

  let liquidityFactor = 0;
  if (m.comparable && m.sourceLineUsed != null) {
    const used = Array.isArray(m.sourceLineUsed) ? m.sourceLineUsed : [m.sourceLineUsed];
    const factors = used.map((l) => lineLiquidity.get(l) ?? 0);
    liquidityFactor = factors.length ? Math.min(...factors) : 0;
  }
  const usedLines = m.comparable && m.sourceLineUsed != null
    ? new Set(Array.isArray(m.sourceLineUsed) ? m.sourceLineUsed : [m.sourceLineUsed])
    : null;
  const relevantSnaps = usedLines ? snapshots.filter((s) => s.line != null && usedLines.has(s.line)) : snapshots;

  return {
    quote: {
      sourceId: BETFAIR_SOURCE_ID,
      fairProb: m.fairProb ?? 0,
      isExchange: true,
      liquidityFactor,
      lineComparable: m.comparable && liquidityFactor > 0,
      lineMatchConfidence: m.lineMatchConfidence,
    },
    snapshot: mergeSnapshots(relevantSnaps, target.scope),
    lineMatch: m,
  };
}

/** Slå ihop flera per-lina-snapshots till en sammansatt snapshot för loggen. */
function mergeSnapshots(snaps: BetfairBookSnapshot[], scope: string): BetfairBookSnapshot {
  if (snaps.length === 1) return snaps[0];
  return {
    marketId: snaps.map((s) => s.marketId).join("+"),
    marketType: "TOTALS",
    scope,
    line: null,
    matchedVolume: snaps.reduce((a, s) => a + s.matchedVolume, 0),
    liquidityFactor: snaps.length ? Math.min(...snaps.map((s) => s.liquidityFactor)) : 0,
    pass: snaps.every((s) => s.pass),
    runners: snaps.flatMap((s) => s.runners),
  };
}

/** Exporteras för bekvämlighet (samma kontrakt som lineMatching-helpern). */
export { lineMatchedQuote };

// ── Mock-provider (kör utan nätverk) ───────────────────────────────────
export class MockBetfairProvider implements BetfairMarketProvider {
  constructor(private markets: BetfairMarket[]) {}
  async getMarkets(): Promise<BetfairMarket[]> {
    return this.markets;
  }
}

/** Exempeldata för snabb manuell körning/test. */
export function mockLiquidMatchOdds(): BetfairMarket {
  return {
    marketId: "1.234-match-odds",
    sport: "football",
    marketType: "MATCH_ODDS",
    scope: "full",
    matchedVolume: 250000,
    runners: [
      { selection: "HOME", backOdds: 2.0, layOdds: 2.02, backDepth: 5000, layDepth: 4800 },
      { selection: "DRAW", backOdds: 3.5, layOdds: 3.55, backDepth: 3000, layDepth: 2900 },
      { selection: "AWAY", backOdds: 3.9, layOdds: 3.95, backDepth: 2500, layDepth: 2400 },
    ],
  };
}
