/**
 * smarketsAdapter.ts — Smarkets-börsens AH-stege → SourceQuote för consensus.
 *
 * Smarkets är en BÖRS (back/lay) men vår rows-fil exponerar bara de visade
 * decimal-oddsen per AH-linje ({line, home, away}, hemma-perspektiv) — ingen
 * matchad volym per linje. Vi devig:ar därför two-way per linje (canonical =
 * HOME) precis som SBOBET och behandlar Smarkets som en SKARP confirmer
 * (isExchange:false → ingen likviditetsgrind som skulle nolla den utan djup-data),
 * med konservativ trust i sourceTrustConfig. Bidrar till fair-price-konsensus
 * (AH + härledd EH3) men kan aldrig ensam sätta priset.
 */

import type { SourceQuote } from "./consensusTypes.ts";
import { devigTwoWay } from "./consensus.ts";
import {
  matchLine,
  type LineMatchResult,
  type LineMatchTarget,
  type SourceLadder,
} from "./lineMatching.ts";
import { normalizeTeamName, startTimeBucket } from "./matching.ts";

export const SMARKETS_SOURCE_ID = "smarkets";

/** Smarkets AH-erbjudande på EN linje (hemma-perspektiv, decimal). */
export interface SmarketsAhOffer { line: number; home: number; away: number }

/** Bygg AH-stege ur Smarkets discrete AH-erbjudanden (canonical prob = HOME). */
export function buildSmarketsAhLadder(offers: SmarketsAhOffer[], scope = "full"): SourceLadder {
  const points: { line: number; prob: number }[] = [];
  for (const o of offers) {
    if (o.line == null || !Number.isFinite(o.line)) continue;
    if (!(o.home > 1) || !(o.away > 1)) continue;
    points.push({ line: o.line, prob: devigTwoWay(o.home, o.away) }); // canonical = HOME
  }
  return { sourceId: SMARKETS_SOURCE_ID, marketType: "AH", scope, points };
}

export interface SmarketsAhQuoteResult {
  quote: SourceQuote;
  lineMatch: LineMatchResult;
}

/**
 * AH-quote: line-matcha target mot Smarkets AH-steg (exact först). rejected →
 * lineComparable false → consensus ignorerar Smarkets för den linjen.
 */
export function smarketsAhQuote(target: LineMatchTarget, offers: SmarketsAhOffer[]): SmarketsAhQuoteResult {
  const ladder = buildSmarketsAhLadder(offers, target.scope);
  const m = matchLine(target, ladder);
  return {
    quote: {
      sourceId: SMARKETS_SOURCE_ID,
      fairProb: m.fairProb ?? 0,
      isExchange: false, // ingen per-linje-volym i rows → behandla som skarp confirmer
      lineComparable: m.comparable,
      lineMatchConfidence: m.lineMatchConfidence,
    },
    lineMatch: m,
  };
}

/**
 * Parsa data/smarkets-rows.json → Map<teamBucketKey, SmarketsAhOffer[]>.
 * Smarkets skriver rader i footballRows[] (subset av rows[]) med ah[]-fältet.
 * Indexeras på samma team+bucket-nyckel som Pinnacle/SBOBET. Tom/saknad → tom map.
 */
export function parseSmarketsAhRowsMap(json: unknown): Map<string, SmarketsAhOffer[]> {
  const out = new Map<string, SmarketsAhOffer[]>();
  const j = json as { footballRows?: SmarketsRow[]; rows?: SmarketsRow[]; events?: SmarketsRow[] };
  const rows = j?.footballRows ?? j?.rows ?? j?.events ?? [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r?.homeTeam || !r?.awayTeam || !r?.startTime) continue;
    const ah = Array.isArray(r.ah)
      ? r.ah.filter((a) => a && Number.isFinite(a.line) && Number(a.home) > 1 && Number(a.away) > 1)
          .map((a) => ({ line: a!.line as number, home: a!.home as number, away: a!.away as number }))
      : [];
    if (ah.length === 0) continue;
    const b = startTimeBucket(r.startTime);
    if (b === null) continue;
    const k = `${normalizeTeamName(r.homeTeam)}::${normalizeTeamName(r.awayTeam)}::${b}`;
    out.set(k, ah);
  }
  return out;
}

interface SmarketsRow {
  homeTeam?: string;
  awayTeam?: string;
  startTime?: string;
  ah?: Array<{ line?: number; home?: number; away?: number }>;
}
