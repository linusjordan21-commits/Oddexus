/**
 * clvDedupe.ts — analysis-layer dedupe av CLV-beslut.
 *
 * PROBLEM: shadow-jobbet re-loggar samma kommande match varje körning
 * (var ~10 min), så samma bet-tillfälle får dussintals near-dubbletter i
 * råloggen. Det gör CLV-samples icke-oberoende och blåser upp sample-counts.
 *
 * LÖSNING (konservativ): kollapsa per bet-tillfälle till EN sample. Råloggen
 * röras ALDRIG — detta körs på mergeClvLines-output FÖRE clvAnalysis.
 *
 * Dedupe-nyckel: eventId | marketType | line | selection | BOOK-GROUP
 * (+ scenario om byScenario=true). BOOK-GROUP = plattforms-gruppen (systerbrands
 * som delar identiska odds, t.ex. Hajper/Snabbare/Casinostugan/Lyllo → "comeon"),
 * sa SAMMA bet pa flera systersajter raknas som EN — inte N. Saknas eventId →
 * kan ej dedupas → varje rad behålls (nyckel faller tillbaka på decisionId).
 *
 * Vald rad per cell: den open decision som loggats NÄRMAST avspark men FÖRE
 * kickoff (max ts bland ts ≤ startTime). Saknas startTime → senaste ts.
 * Settlement transfereras till den behållna raden (closing line är event-nivå
 * → samma oavsett vilken dubblett som råkade settlas; CLV räknas om med den
 * behållna radens odds).
 */

import type { MergedClvRecord } from "./clvLogger.ts";
import { bookmakerGroup } from "./bookmakerGroups.ts";

export interface DedupeOptions {
  /** Inkludera scenario i nyckeln. Default false. */
  byScenario?: boolean;
}

export interface DedupeResult {
  /** En rad per bet-tillfälle (analysis-ready). */
  kept: MergedClvRecord[];
  /** decisionId:n för de near-dubbletter som föll bort. */
  droppedIds: string[];
  stats: {
    rawOpen: number;
    dedupedSamples: number;
    dropped: number;
    /** Antal celler som hade >1 rådubblett. */
    collapsedCells: number;
  };
}

export function dedupeKey(r: MergedClvRecord, byScenario = false): string {
  // Utan eventId kan vi inte säkert säga att två rader är samma bet-tillfälle.
  if (!r.eventId) return `__nodupe__:${r.decisionId}`;
  const line = r.line == null ? "-" : r.line.toFixed(2);
  // PLATTFORMS-GRUPP, inte enskild bok → systerbrands (delar odds) = EN bet.
  const group = bookmakerGroup(r.candidateBook);
  const base = `${r.eventId}|${r.marketType}|${line}|${r.selection}|${group}`;
  return byScenario ? `${base}|${r.scenario}` : base;
}

function tsMs(r: MergedClvRecord): number {
  const t = Date.parse(r.ts);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Välj representanten i en grupp (= samma bet på flera systersajter och/eller
 * över tid). Systerbrands delar INTE alltid odds (det finns prisnivåer), så vi
 * behåller raden med BÄSTA priset (högst odds = den bet du faktiskt skulle ta),
 * med "närmast avspark men före kickoff" som tiebreak. Saknas startTime → bästa
 * odds, tiebreak senaste ts.
 */
function better(a: MergedClvRecord, b: MergedClvRecord): MergedClvRecord {
  if (b.candidateOdds !== a.candidateOdds) return b.candidateOdds > a.candidateOdds ? b : a;
  return tsMs(b) > tsMs(a) ? b : a; // samma pris → senaste (närmast kickoff)
}
function pickKept(group: MergedClvRecord[]): MergedClvRecord {
  const withStart = group.filter((r) => r.startTime && Number.isFinite(Date.parse(r.startTime)));
  if (withStart.length > 0) {
    const beforeKickoff = withStart.filter((r) => tsMs(r) <= Date.parse(r.startTime as string));
    const pool = beforeKickoff.length > 0 ? beforeKickoff : withStart;
    return pool.reduce(better);
  }
  return group.reduce(better);
}

/**
 * Transferera en settlement från en settlad syskonrad till den behållna raden
 * om den behållna saknar settlement. CLV räknas om med DEN BEHÅLLNA radens
 * odds (closing line är event-nivå och delas).
 */
function withTransferredSettlement(kept: MergedClvRecord, group: MergedClvRecord[]): MergedClvRecord {
  if (kept.settled && kept.clvPct != null) return kept;
  const sib = group.find((r) => r.settled && r.closingFairProb != null);
  if (!sib || sib.closingFairProb == null) return kept;
  return {
    ...kept,
    settled: true,
    closingFairProb: sib.closingFairProb,
    closingSource: sib.closingSource,
    clvPct: (kept.candidateOdds * sib.closingFairProb - 1) * 100,
    won: sib.won,
    settledAt: sib.settledAt,
  };
}

/** Dedupa merged CLV-records till en sample per bet-tillfälle. Pure. */
export function dedupeForAnalysis(
  merged: MergedClvRecord[],
  opts: DedupeOptions = {},
): DedupeResult {
  const groups = new Map<string, MergedClvRecord[]>();
  for (const r of merged) {
    const k = dedupeKey(r, opts.byScenario);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const kept: MergedClvRecord[] = [];
  const droppedIds: string[] = [];
  let collapsedCells = 0;

  for (const group of groups.values()) {
    const chosen = withTransferredSettlement(pickKept(group), group);
    kept.push(chosen);
    if (group.length > 1) {
      collapsedCells++;
      for (const r of group) if (r.decisionId !== chosen.decisionId) droppedIds.push(r.decisionId);
    }
  }

  return {
    kept,
    droppedIds,
    stats: { rawOpen: merged.length, dedupedSamples: kept.length, dropped: droppedIds.length, collapsedCells },
  };
}
