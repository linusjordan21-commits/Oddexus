/**
 * Edge-beräkningar för cross-book-jämförelse.
 *
 * Vi använder Pinnacle som fair-value-referens eftersom deras marknads-
 * making är skarpare än kommersiella books (samma princip som ValueBets-
 * sidan). För varje (event, market, line) hos Pinnacle:
 *
 *   1. impliedProb_sel = 1 / pinnacleOdds_sel
 *   2. overround = Σ impliedProb över alla selections inom samma market
 *   3. fairProb_sel = impliedProb_sel / overround        (no-vig)
 *   4. edge = candidateOdds × fairProb_sel − 1
 *   5. isValue = edge × 100 > VALUE_EDGE_THRESHOLD_PCT
 *
 * Steg 1-3 görs en gång per market i `indexReferenceOdds`. Steg 4-5 görs
 * per matchad par i `computeOpportunity`.
 */

import {
  VALUE_EDGE_THRESHOLD_PCT,
  type MarketType,
  type MatchedOpportunity,
  type NormalizedOdds,
} from "./types.ts";
import { normalizeTeamName, startTimeBucket } from "./matching.ts";

/**
 * Bygg market-key för fair-prob-beräkning. En market = (event, market-typ,
 * line). Alla selections inom samma key delar samma overround.
 */
function makeMarketKey(o: NormalizedOdds, bucket: number): string {
  const home = normalizeTeamName(o.homeTeam);
  const away = normalizeTeamName(o.awayTeam);
  const line = o.line != null ? o.line.toFixed(2) : "-";
  return `${home}::${away}::${bucket}::${o.market}::${line}`;
}

/**
 * Antal selections som förväntas i en market. Används som sanity check
 * när vi räknar fair prob — vi vill bara dela på overround när vi har
 * komplett market (annars blir no-vig fair prob systematiskt fel).
 */
function expectedSelectionCount(market: MarketType): number {
  switch (market) {
    case "1X2":
      return 3; // HOME, DRAW, AWAY
    case "OVER_UNDER":
    case "ASIAN_HANDICAP":
    case "BTTS":
      return 2;
  }
}

export interface IndexedReference {
  odds: NormalizedOdds;
  impliedProb: number;
  fairProb: number;
}

/**
 * Bygg ett index över reference-odds per matching-key. Beräknar samtidigt
 * no-vig fair prob per selection genom att gruppera per market och dela
 * med overround.
 *
 * Returnerar Map<key, IndexedReference>. Key matchar `makeOddsKey` i
 * matching.ts (samma signatur).
 */
export function indexReferenceOdds(reference: NormalizedOdds[]): Map<string, IndexedReference> {
  // Steg A: gruppera per market-key och beräkna overround.
  const marketGroups = new Map<string, NormalizedOdds[]>();
  for (const o of reference) {
    const bucket = startTimeBucket(o.startTime);
    if (bucket === null) continue;
    const mkey = makeMarketKey(o, bucket);
    const arr = marketGroups.get(mkey);
    if (arr) arr.push(o);
    else marketGroups.set(mkey, [o]);
  }

  // Steg B: räkna fair prob för varje selection och bygg index.
  const index = new Map<string, IndexedReference>();
  for (const [, odds] of marketGroups) {
    if (odds.length === 0) continue;
    const market = odds[0].market;
    const expected = expectedSelectionCount(market);
    // Räkna overround. Om vi saknar selections (t.ex. bara HOME utan AWAY)
    // skip:ar vi marketen — fair prob går inte att beräkna korrekt.
    if (odds.length < expected) continue;

    let overround = 0;
    for (const o of odds) overround += 1 / o.odds;
    if (overround <= 0 || !Number.isFinite(overround)) continue;

    for (const o of odds) {
      const bucket = startTimeBucket(o.startTime)!;
      const keyHome = normalizeTeamName(o.homeTeam);
      const keyAway = normalizeTeamName(o.awayTeam);
      const lineStr = o.line != null ? o.line.toFixed(2) : "-";
      const fullKey = `${keyHome}::${keyAway}::${bucket}::${o.market}::${lineStr}::${o.selection}`;
      const impliedProb = 1 / o.odds;
      const fairProb = impliedProb / overround;
      index.set(fullKey, { odds: o, impliedProb, fairProb });
    }
  }

  return index;
}

/**
 * Computa edge för ett matchat par. Pure function — caller skickar redan
 * indexerade reference-värden från indexReferenceOdds.
 */
export function computeOpportunity(args: {
  reference: NormalizedOdds;
  referenceImpliedProb: number;
  referenceFairProb: number;
  candidate: NormalizedOdds;
  matchedAt: string;
}): MatchedOpportunity {
  const { reference, referenceImpliedProb, referenceFairProb, candidate, matchedAt } = args;
  const edge = candidate.odds * referenceFairProb - 1;
  const edgePct = edge * 100;
  const homeKey = normalizeTeamName(reference.homeTeam);
  const awayKey = normalizeTeamName(reference.awayTeam);
  const bucket = startTimeBucket(reference.startTime) ?? 0;
  const lineStr = reference.line != null ? reference.line.toFixed(2) : "-";
  const matchKey = `${homeKey}::${awayKey}::${bucket}::${reference.market}::${lineStr}::${reference.selection}`;

  return {
    matchKey,
    reference,
    candidate,
    referenceImpliedProb,
    referenceFairProb,
    edge,
    edgePct,
    isValue: edgePct > VALUE_EDGE_THRESHOLD_PCT,
    matchedAt,
  };
}

/**
 * Bekvämlighetshjälpare: räkna implied prob direkt från ett odds.
 * Används av UI när vi vill visa "Pinnacle implied 47.6%" på ett kort.
 */
export function impliedProbabilityFromOdds(odds: number): number | null {
  if (!Number.isFinite(odds) || odds <= 1) return null;
  return 1 / odds;
}

/**
 * Sortera MatchedOpportunity[] DESC efter edgePct. Stable — bibehåller
 * input-ordning vid lika edge.
 */
export function sortByEdgeDesc(opportunities: MatchedOpportunity[]): MatchedOpportunity[] {
  return [...opportunities].sort((a, b) => b.edgePct - a.edgePct);
}
