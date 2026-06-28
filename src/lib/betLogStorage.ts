/**
 * localStorage-CRUD för Oddexus Bet Log.
 *
 * Storage-key: `parlay-pilot-value-bet-log` (behålls oförändrad trots
 * Oddexus-rebrandet — att byta nyckel skulle radera alla användares loggade
 * bets. Separat från
 * `matched-betting-logs` som används av Index.tsx för välkomst-bonus-loggar
 * — vi rör inte den nyckeln).
 *
 * Format: BetLogExport (version + bets[]) → JSON-stringified.
 *
 * Fel-hantering: alla parse/write-fel sväljs och loggas till console; UI:t
 * får tom lista. Quota-fel signaleras genom att setItem kastar — caller
 * kan visa toast vid behov.
 */

import {
  BET_LOG_FORMAT_VERSION,
  type BetLogExport,
  type LoggedBet,
} from "./betLogTypes";

export const BET_LOG_STORAGE_KEY = "parlay-pilot-value-bet-log";
export const LAST_STAKE_STORAGE_KEY = "parlay-pilot-last-stake";

function safeParse(raw: string): BetLogExport | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const obj = data as Partial<BetLogExport>;
    if (!Array.isArray(obj.bets)) return null;
    return {
      version: typeof obj.version === "number" ? obj.version : 0,
      exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
      bets: obj.bets.filter(isValidBet),
    };
  } catch {
    return null;
  }
}

function isValidBet(raw: unknown): raw is LoggedBet {
  if (!raw || typeof raw !== "object") return false;
  const b = raw as Partial<LoggedBet>;
  return (
    typeof b.id === "string" &&
    typeof b.match === "string" &&
    typeof b.bookmakerId === "string" &&
    typeof b.bookOdds === "number" &&
    typeof b.stake === "number" &&
    typeof b.status === "string"
  );
}

/** Hämta alla loggade bets från localStorage. Tom array om ingen data. */
export function loadBets(): LoggedBet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(BET_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = safeParse(raw);
    return parsed?.bets ?? [];
  } catch (error) {
    console.warn("[bet-log] loadBets failed:", error);
    return [];
  }
}

/**
 * Skriver hela bets-arrayen till localStorage. Anropare ska normalt använda
 * `saveBet`/`updateBet`/`deleteBet` istället för att skriva direkt.
 *
 * Kastar vid quota exceeded — caller kan visa toast.
 */
export function persistAllBets(bets: LoggedBet[]): void {
  if (typeof window === "undefined") return;
  const payload: BetLogExport = {
    version: BET_LOG_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    bets,
  };
  localStorage.setItem(BET_LOG_STORAGE_KEY, JSON.stringify(payload));
}

/** Lägg till ett nytt bet (eller update om id finns). */
export function saveBet(bet: LoggedBet): LoggedBet[] {
  const all = loadBets();
  const idx = all.findIndex((b) => b.id === bet.id);
  if (idx >= 0) all[idx] = bet;
  else all.unshift(bet);
  persistAllBets(all);
  return all;
}

/** Uppdatera ett befintligt bet. Returnerar uppdaterad lista, eller
 *  oförändrad om id inte fanns. */
export function updateBet(id: string, updates: Partial<LoggedBet>): LoggedBet[] {
  const all = loadBets();
  const idx = all.findIndex((b) => b.id === id);
  if (idx < 0) return all;
  all[idx] = { ...all[idx], ...updates };
  persistAllBets(all);
  return all;
}

/** Ta bort ett bet via id. */
export function deleteBet(id: string): LoggedBet[] {
  const all = loadBets().filter((b) => b.id !== id);
  persistAllBets(all);
  return all;
}

/** Rensa hela loggen. Caller bör ha bekräftelse-modal innan. */
export function clearAllBets(): void {
  persistAllBets([]);
}

// ── Default stake-minne ───────────────────────────────────────────────

export function loadLastStake(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_STAKE_STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveLastStake(stake: number): void {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(stake) || stake <= 0) return;
  try {
    localStorage.setItem(LAST_STAKE_STORAGE_KEY, String(stake));
  } catch {
    // ignore quota errors — det är bara en QoL-feature
  }
}

// ── Import/export ─────────────────────────────────────────────────────

export function exportBetsAsJson(): string {
  const bets = loadBets();
  const payload: BetLogExport = {
    version: BET_LOG_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    bets,
  };
  return JSON.stringify(payload, null, 2);
}

export interface ImportResult {
  added: number;
  skipped: number;
  errors: string[];
}

/**
 * Importerar bets från JSON-sträng. Sammanfogar med befintliga (id-dedupe).
 * Sätter inte över existerande bets — om id krockar hoppas det skipped.
 */
export function importBetsFromJson(json: string): ImportResult {
  const result: ImportResult = { added: 0, skipped: 0, errors: [] };
  let parsed: BetLogExport | null;
  try {
    parsed = safeParse(json);
  } catch (error) {
    result.errors.push(`Kunde inte parsa JSON: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  if (!parsed) {
    result.errors.push("Ogiltigt format — förväntar { version, bets: [...] }");
    return result;
  }
  const existing = loadBets();
  const existingIds = new Set(existing.map((b) => b.id));
  const merged = [...existing];
  for (const bet of parsed.bets) {
    if (existingIds.has(bet.id)) {
      result.skipped += 1;
      continue;
    }
    merged.unshift(bet);
    existingIds.add(bet.id);
    result.added += 1;
  }
  try {
    persistAllBets(merged);
  } catch (error) {
    result.errors.push(`Kunde inte spara: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

/** CSV-export. Kommatecken inom fält escape:as med dubbla citationstecken. */
export function exportBetsAsCsv(): string {
  const bets = loadBets();
  const headers = [
    "loggedAt",
    "match",
    "league",
    "startTs",
    "bookmakerId",
    "bookmakerName",
    "outcome",
    "outcomeLabel",
    "bookOdds",
    "stake",
    "pinnacleOddsAtBet",
    "pinnacleFairOddsAtBet",
    "pinnacleFairProbAtBet",
    "evPctAtBet",
    "closingFairOdds",
    "status",
    "settledAt",
    "notes",
    "source",
  ];
  const escape = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(",")];
  for (const b of bets) {
    lines.push(
      headers
        .map((h) => escape((b as unknown as Record<string, unknown>)[h]))
        .join(","),
    );
  }
  return lines.join("\n");
}
