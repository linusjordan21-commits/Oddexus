/**
 * Matching av två adapters odds till MatchedOpportunity[].
 *
 * Algoritm:
 *   1. Bygg en index över "reference"-odds (Pinnacle) per (matchKey, market,
 *      line, selection). matchKey = normalizedHome + normalizedAway +
 *      startBucket.
 *   2. Iterera "candidate"-odds (Bet365). För varje rad, slå upp samma key
 *      i indexet. Om träff → skapa MatchedOpportunity.
 *   3. Beräkna implied/fair prob + edge i edge.ts.
 *
 * Bucket-strategi: vi gruppar startTime i 30-minuters buckets. Två events
 * inom ±15 min av varandra kan därmed hamna i samma bucket. Strikt nog
 * att undvika false merges men tolerant nog mot timezone-jitter mellan
 * providers.
 *
 * Team-normalisering är medvetet enkel i Fas A — lowercase + NFD-strip
 * + remove common suffixes/prefixes. Räcker för stora klubbar. Kan
 * utökas till fuzzy matching (Levenshtein) i fas B om vi ser missade
 * matchningar i live-data.
 */

import {
  SAME_EVENT_TIME_TOLERANCE_MS,
  type MatchedOpportunity,
  type NormalizedOdds,
} from "./types.ts";
import { computeOpportunity, indexReferenceOdds } from "./edge.ts";

/**
 * Normalisera lagnamn till canonical form för matching:
 *   "Real Madrid CF"       → "real madrid"
 *   "Manchester City FC"   → "manchester city"
 *   "FC Bayern München"    → "bayern munchen"   (FC strippat + diacritics)
 *   "Liverpool F.C."       → "liverpool"
 *
 * Steg:
 *   1. lowercase
 *   2. NFD + strip diacritics
 *   3. ta bort vanliga klubbsuffix/prefix (FC, AFC, CF, SC, etc.)
 *   4. ta bort parenteser och innehåll
 *   5. ta bort punkter, kommatecken
 *   6. collapse whitespace
 */
export function normalizeTeamName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")           // diacritics
    .replace(/\([^)]*\)/g, " ")                 // parens + content
    // Punkterade akronymer → ihopdragna FÖRE dot→space, så suffix-regexen nedan
    // fångar dem: "f.c." → "fc", "a.f.c." → "afc", "u.s." → "us". Kräver minst
    // bokstav.bokstav → rör inte "st. pauli" (st. är bokstav-bokstav-punkt).
    .replace(/\b([a-z](?:\.[a-z])+)\.?/g, (m) => m.replace(/\./g, ""))
    .replace(/[.,]/g, " ")                      // kvarvarande punkter/komman → space
    .replace(/\b(fc|afc|cf|sc|sk|fk|bk|if|ff|ac|cd|rc|sv|as|us|ssc|vfb|vfl|aif|gif|club|club\.?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Konvertera startTime till en bucket-nyckel. 30 min-buckets — två events
 * som rapporteras med 15 min skillnad fångas i samma bucket eller en
 * intilliggande (vi accepterar båda i matchEvents nedan).
 */
const BUCKET_MS = 30 * 60 * 1000;

export function startTimeBucket(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / BUCKET_MS);
}

/**
 * Bygg en composite key för matching. Innehåller market/line/selection
 * så vi kan slå upp exakt samma odds-rad i båda adapter-listorna.
 */
function makeOddsKey(odds: NormalizedOdds, bucket: number): string {
  const home = normalizeTeamName(odds.homeTeam);
  const away = normalizeTeamName(odds.awayTeam);
  const line = odds.line != null ? odds.line.toFixed(2) : "-";
  return `${home}::${away}::${bucket}::${odds.market}::${line}::${odds.selection}`;
}

/**
 * Bucket-tolerans: prova primary bucket + ±1 (totalt 3 möjliga buckets).
 * Med 30-min buckets täcker det events inom ±45 min start-skillnad.
 * I praktiken behövs inte mer — Pinnacle och de flesta providers
 * rapporterar startTime exakt eller med några minuters jitter.
 *
 * Time-tolerance trimmas av SAME_EVENT_TIME_TOLERANCE_MS i types.ts (1h).
 */
function bucketCandidates(bucket: number): number[] {
  return [bucket - 1, bucket, bucket + 1];
}

/**
 * Verifiera att två odds-rader har startTime inom 1h. Bucket-matching kan
 * råka hitta events som ligger nära bucket-gränsen men ändå >1h isär.
 */
function withinTimeTolerance(a: NormalizedOdds, b: NormalizedOdds): boolean {
  const ma = Date.parse(a.startTime);
  const mb = Date.parse(b.startTime);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return false;
  return Math.abs(ma - mb) <= SAME_EVENT_TIME_TOLERANCE_MS;
}

/**
 * Bygg MatchedOpportunity[] genom att joina reference-odds (Pinnacle) med
 * candidate-odds (t.ex. Bet365). Bara rader där samma (match, market, line,
 * selection) finns i båda källorna inkluderas.
 *
 * @param reference Lista från PinnacleAdapter
 * @param candidate Lista från Bet365Adapter eller annan
 */
export function matchEvents(
  reference: NormalizedOdds[],
  candidate: NormalizedOdds[],
): MatchedOpportunity[] {
  // Bygg index av reference per bucket → key → odds. Använder edge.ts:
  // indexReferenceOdds som även förbereder no-vig fair prob per market.
  const refIndex = indexReferenceOdds(reference);

  const matchedAt = new Date().toISOString();
  const out: MatchedOpportunity[] = [];

  for (const cand of candidate) {
    const candBucket = startTimeBucket(cand.startTime);
    if (candBucket === null) continue;

    // Prova primary bucket + ±1 så vi tolererar bucket-gränsfall.
    for (const bucket of bucketCandidates(candBucket)) {
      const key = makeOddsKey(cand, bucket);
      const refEntry = refIndex.get(key);
      if (!refEntry) continue;
      if (!withinTimeTolerance(refEntry.odds, cand)) continue;

      const opportunity = computeOpportunity({
        reference: refEntry.odds,
        referenceFairProb: refEntry.fairProb,
        referenceImpliedProb: refEntry.impliedProb,
        candidate: cand,
        matchedAt,
      });
      out.push(opportunity);
      break; // hittade match, gå till nästa cand
    }
  }

  return out;
}
