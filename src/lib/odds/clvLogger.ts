/**
 * clvLogger.ts — skriver ett DecisionLog (från evaluateMarket) till
 * data/clv-log.jsonl, en rad per beslut. Detta är fundamentet för shadow
 * mode: vi loggar VAD systemet HADE beslutat, mäter sedan mot closing line.
 *
 * CLV (Closing Line Value) = ourOdds × closingFairProb − 1. Ett positivt CLV
 * betyder att vi tog ett pris bättre än marknadens stängning → våra besluts-
 * källor var sharpa. Closing line finns inte vid besluts-ögonblicket, så:
 *   - logDecision() skriver en ÖPPEN rad (type:"open") med decisionId.
 *   - settleClv()   skriver en SETTLE-rad (type:"settle") när matchen stänger.
 *   - clvAnalysis.ts joinar open+settle på decisionId.
 *
 * Server-side only (fs). Påverkar INGA live-beslut — ren loggning.
 */

import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BenchmarkResult } from "./consensusTypes.ts";
import type { EvaluateOutput } from "./consensus.ts";

export const DEFAULT_CLV_LOG_PATH = "data/clv-log.jsonl";

/** Kompakt ögonblicksbild av en källas bidrag (för per-källa-CLV). */
export interface SourceSnapshot {
  sourceId: string;
  role: BenchmarkResult["role"];
  fairProb: number | null;
  weight: number;
  isPinnacle: boolean;
  isExchange: boolean;
  /**
   * Extra källspecifik metadata — t.ex. Betfair order book-snapshot
   * (back/lay, depth, matchad volym, liquidityFactor). Loggas alltid.
   */
  meta?: unknown;
}

/** Öppen CLV-rad — skrivs vid besluts-ögonblicket. */
export interface ClvOpenEntry {
  type: "open";
  decisionId: string;
  ts: string;
  eventId: string | null;
  sport: string;
  league: string | null;
  marketType: string;
  tier: string;
  phase: string;
  ttsBucket: string;
  /** Avspark (ISO) om känd — för dedupe "närmast kickoff". */
  startTime: string | null;
  line: number | null;
  selection: string;
  scenario: string;
  candidateBook: string;
  candidateOdds: number;
  fairPrice: number | null;
  fairProb: number | null;
  benchmarkSource: string;
  benchmarkConfidence: number;
  requiredEdge: number | null;
  calculatedEdge: number | null;
  decision: string;
  executed: boolean;
  shadowMode: boolean;
  reasonCodes: string[];
  sourceSnapshot: SourceSnapshot[];
}

/** Settle-rad — skrivs när matchens closing line är känd. */
export interface ClvSettleEntry {
  type: "settle";
  decisionId: string;
  settledAt: string;
  /** No-vig fair prob vid stängning (helst Pinnacle, annars consensus). */
  closingFairProb: number;
  closingSource: string;
  /** ourOdds × closingFairProb − 1, i procent. */
  clvPct: number;
  /** Faktiskt utfall om känt (true=vann), annars null. */
  won: boolean | null;
}

export type ClvLine = ClvOpenEntry | ClvSettleEntry;

/** Bygg en öppen CLV-rad från ett evaluateMarket-resultat (pure).
 *
 * `sourceMeta` kopplar källspecifik metadata (per sourceId) till respektive
 * source snapshot — t.ex. `{ betfair: orderBookSnapshot }`. Loggas alltid.
 */
export function buildClvEntry(
  out: EvaluateOutput,
  opts?: { decisionId?: string; sourceMeta?: Record<string, unknown> },
): ClvOpenEntry {
  const { log, consensus } = out;
  return {
    type: "open",
    decisionId: opts?.decisionId ?? randomUUID(),
    ts: log.ts,
    eventId: log.context.eventId ?? null,
    sport: log.context.sport,
    league: log.context.league ?? null,
    marketType: log.context.market,
    tier: log.context.tier,
    phase: log.context.phase,
    ttsBucket: log.context.ttsBucket,
    startTime: log.context.startTime ?? null,
    line: log.context.line,
    selection: log.context.selection,
    scenario: log.scenario,
    candidateBook: log.candidateBook,
    candidateOdds: log.candidateOdds,
    fairPrice: log.fairPrice,
    fairProb: log.fairProb,
    benchmarkSource: log.benchmarkSource,
    benchmarkConfidence: log.benchmarkConfidence,
    requiredEdge: log.requiredEdge,
    calculatedEdge: log.calculatedEdge,
    decision: log.decision,
    executed: log.executed,
    shadowMode: log.shadowMode,
    reasonCodes: log.reasonCodes,
    sourceSnapshot: consensus.sources
      .filter((s) => s.role !== "ignore")
      .map((s) => ({
        sourceId: s.sourceId,
        role: s.role,
        fairProb: s.fairProb,
        weight: s.weight,
        isPinnacle: s.isPinnacle,
        isExchange: s.isExchange,
        meta: opts?.sourceMeta?.[s.sourceId],
      })),
  };
}

/** CLV i procent (pure). */
export function computeClvPct(ourOdds: number, closingFairProb: number): number {
  return (ourOdds * closingFairProb - 1) * 100;
}

/** Bygg en settle-rad (pure). */
export function buildSettlement(args: {
  decisionId: string;
  ourOdds: number;
  closingFairProb: number;
  closingSource: string;
  won?: boolean | null;
}): ClvSettleEntry {
  return {
    type: "settle",
    decisionId: args.decisionId,
    settledAt: new Date().toISOString(),
    closingFairProb: args.closingFairProb,
    closingSource: args.closingSource,
    clvPct: computeClvPct(args.ourOdds, args.closingFairProb),
    won: args.won ?? null,
  };
}

/** Serialisera en rad till JSONL-format (pure). */
export function serializeLine(line: ClvLine): string {
  return JSON.stringify(line) + "\n";
}

/** Logga ett beslut (öppen rad) → append till jsonl. Returnerar decisionId. */
export async function logDecision(
  out: EvaluateOutput,
  opts?: { path?: string; decisionId?: string; sourceMeta?: Record<string, unknown> },
): Promise<string> {
  const entry = buildClvEntry(out, { decisionId: opts?.decisionId, sourceMeta: opts?.sourceMeta });
  await appendFile(opts?.path ?? DEFAULT_CLV_LOG_PATH, serializeLine(entry), "utf8");
  return entry.decisionId;
}

/** Logga en settlement (settle-rad) → append till jsonl. */
export async function settleClv(
  args: { decisionId: string; ourOdds: number; closingFairProb: number; closingSource: string; won?: boolean | null },
  opts?: { path?: string },
): Promise<void> {
  const entry = buildSettlement(args);
  await appendFile(opts?.path ?? DEFAULT_CLV_LOG_PATH, serializeLine(entry), "utf8");
}

/** Parsa jsonl-text till rader (pure, hoppar över trasiga rader). */
export function parseClvLines(text: string): ClvLine[] {
  const out: ClvLine[] = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && (obj.type === "open" || obj.type === "settle")) out.push(obj as ClvLine);
    } catch {
      // ignorera trasig rad
    }
  }
  return out;
}

/** Läs hela loggen från disk → rader. Tom array om filen saknas. */
export async function readClvLog(path: string = DEFAULT_CLV_LOG_PATH): Promise<ClvLine[]> {
  try {
    const text = await readFile(path, "utf8");
    return parseClvLines(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** En öppen rad sammanslagen med sin settlement (om den finns). */
export interface MergedClvRecord extends ClvOpenEntry {
  closingFairProb: number | null;
  closingSource: string | null;
  clvPct: number | null;
  won: boolean | null;
  settledAt: string | null;
  settled: boolean;
}

/** Joina open+settle på decisionId (pure). Senaste settle vinner. */
export function mergeClvLines(lines: ClvLine[]): MergedClvRecord[] {
  const opens = new Map<string, ClvOpenEntry>();
  const settles = new Map<string, ClvSettleEntry>();
  for (const l of lines) {
    if (l.type === "open") opens.set(l.decisionId, l);
    else settles.set(l.decisionId, l);
  }
  const out: MergedClvRecord[] = [];
  for (const [id, open] of opens) {
    const s = settles.get(id);
    out.push({
      ...open,
      closingFairProb: s?.closingFairProb ?? null,
      closingSource: s?.closingSource ?? null,
      clvPct: s?.clvPct ?? null,
      won: s?.won ?? null,
      settledAt: s?.settledAt ?? null,
      settled: s != null,
    });
  }
  return out;
}
