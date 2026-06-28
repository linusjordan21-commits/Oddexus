/**
 * clvSettle.ts — fyller på closing line och räknar CLV på gamla shadow-beslut.
 *
 * Closing source (v1): Pinnacle. Vi matchar open decisions mot en Pinnacle
 * closing-snapshot via eventId (= Pinnacle matchupId, exakt — samma id-system
 * som shadow-jobbet loggade). INGEN gissning/interpolation: saknas exakt
 * closing → lämna unsettled med reason-kod.
 *
 * CLV = ourOdds × closingFairProb − 1 (closingFairProb = devigged fair prob).
 *
 * Pure (ingen IO) → testbart. CLI:n (scripts/settle-clv.ts) sköter fil-läsning
 * och append. Allt shadow-only; rör inga live-beslut.
 *
 * DATAFÖRUTSÄTTNING: Pinnacle-feeden är "future-only", så en avslutad matchs
 * linje försvinner ur pinnacle-rows.json. För äkta closing behövs en snapshot
 * tagen nära avspark (data/pinnacle-closing.json), skriven av ett separat
 * kickoff-capture-jobb. Detta jobb läser den snapshoten om den finns, annars
 * pinnacle-rows.json (då settlas bara matcher som ännu råkar ligga kvar).
 */

import type { MergedClvRecord, ClvSettleEntry } from "./clvLogger.ts";
import { buildSettlement } from "./clvLogger.ts";
import type { PinnacleEvent } from "./shadowConsensus.ts";

export type SettleSkipReason =
  | "ALREADY_SETTLED"
  | "NO_EVENT_ID"
  | "UNSUPPORTED_MARKET"
  | "CLOSING_NOT_AVAILABLE"
  | "MATCH_NOT_CLOSED"
  | "SELECTION_NOT_IN_CLOSING";

export interface SettleSkip {
  decisionId: string;
  reason: SettleSkipReason;
}

export interface SettlePlan {
  settlements: ClvSettleEntry[];
  skipped: SettleSkip[];
  stats: {
    open: number;
    settled: number;
    skipped: number;
    bySkipReason: Record<string, number>;
    avgClvPct: number | null;
    medianClvPct: number | null;
  };
}

/** Bygg closing-index ur Pinnacle-events (eventId → event). */
export function buildClosingIndex(pinnacle: PinnacleEvent[]): Map<string, PinnacleEvent> {
  const idx = new Map<string, PinnacleEvent>();
  for (const p of pinnacle) idx.set(p.identity.eventId, p);
  return idx;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

type OneXTwo = "HOME" | "DRAW" | "AWAY";
function is1x2Selection(sel: string): sel is OneXTwo {
  return sel === "HOME" || sel === "DRAW" || sel === "AWAY";
}

/**
 * Planera settlements för open decisions. Endast ML_1X2 i v1 (closing source
 * är 1X2). Matchen måste ha startat (closing.startTime ≤ now) för att settlas.
 *
 * @param merged  mergeClvLines(...) — open-rader (ev. redan settlade)
 * @param closing buildClosingIndex(...)
 * @param now     epoch ms (injicerbart för test)
 */
export function planSettlements(
  merged: MergedClvRecord[],
  closing: Map<string, PinnacleEvent>,
  now: number = Date.now(),
): SettlePlan {
  const settlements: ClvSettleEntry[] = [];
  const skipped: SettleSkip[] = [];
  const bySkipReason: Record<string, number> = {};
  const clvs: number[] = [];

  const skip = (decisionId: string, reason: SettleSkipReason) => {
    skipped.push({ decisionId, reason });
    bySkipReason[reason] = (bySkipReason[reason] ?? 0) + 1;
  };

  for (const r of merged) {
    if (r.settled) { skip(r.decisionId, "ALREADY_SETTLED"); continue; }
    if (!r.eventId) { skip(r.decisionId, "NO_EVENT_ID"); continue; }
    if (r.marketType !== "ML_1X2") { skip(r.decisionId, "UNSUPPORTED_MARKET"); continue; }

    const close = closing.get(r.eventId);
    if (!close) { skip(r.decisionId, "CLOSING_NOT_AVAILABLE"); continue; }

    const startMs = Date.parse(close.identity.startTime);
    if (!Number.isFinite(startMs) || startMs > now) { skip(r.decisionId, "MATCH_NOT_CLOSED"); continue; }

    if (!is1x2Selection(r.selection)) { skip(r.decisionId, "SELECTION_NOT_IN_CLOSING"); continue; }
    const closingFairProb = close.fairProb[r.selection];
    if (closingFairProb == null || !Number.isFinite(closingFairProb)) { skip(r.decisionId, "SELECTION_NOT_IN_CLOSING"); continue; }

    const settlement = buildSettlement({
      decisionId: r.decisionId,
      ourOdds: r.candidateOdds,
      closingFairProb,
      closingSource: "pinnacle",
      won: null,
    });
    settlements.push(settlement);
    clvs.push(settlement.clvPct);
  }

  return {
    settlements,
    skipped,
    stats: {
      open: merged.length,
      settled: settlements.length,
      skipped: skipped.length,
      bySkipReason,
      avgClvPct: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
      medianClvPct: median(clvs),
    },
  };
}
