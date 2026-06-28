import { apiUrl } from "@/lib/apiUrl";

export type BonusType = 'freebet' | 'matched';

/**
 * Två bonus-typer:
 *  - `matched`: insättningsbonus med omsättningskrav. `wagering`/`wageringMultiplier`
 *    anger hur många gånger bonus-beloppet måste omsättas innan saldot kan tas ut.
 *    `wageringTarget` (kr) = bonus-belopp × multiplier (= depositAmount × multiplier
 *    när bookmakern matchar 100%, vilket är typiskt i SE-marknaden).
 *  - `freebet`: ingen omsättning. Vinsten räknas som `(odds − 1) × stake` (insatsen
 *    återges inte) och förlust kostar inget eget kapital.
 */
export interface Bookmaker {
  id: string;
  name: string;
  bonusType: BonusType;
  depositAmount: number;
  betAmount: number;
  freebetValue?: number;
  /** Omsättningsmultipel på bonusbeloppet (samma som `wageringMultiplier`). */
  wagering?: number;
  /** Alias för `wagering`. Default 1 om inget anges. */
  wageringMultiplier?: number;
  /** Total summa som måste omsättas innan saldot frigörs (kr). Default = bonus × multiplier. */
  wageringTarget?: number;
  oddsHome?: number;
  oddsDraw?: number;
  oddsAway?: number;
  assignedOutcome?: '1' | 'X' | '2' | 'used';
  status: 'pending' | 'qualifying' | 'freebet' | 'wagering' | 'done';
}

export interface BetLog {
  id: string;
  date: string;
  matchName: string;
  person: string;
  bookmakers: Bookmaker[];
  worstCase: number;
  bestCase: number;
  totalStake: number;
  notes?: string;
  result?: '1' | 'X' | '2';
  pinnacleOdds?: Record<string, number>;
  complementBookmaker?: string;
  complementAccountOwner?: string;
  complementPlaced?: Partial<Record<'1' | 'X' | '2', boolean>>;
  fbMatchName?: string;
  /** Kompletteringssida i Dag 2 freebet-match (motspel i MatchCalculator). */
  fbHedgeComplementSite?: string;
  fbSites?: any[];
  mwMatchName?: string;
  mwSites?: any[];
  mwCandidateSites?: any[];
  day2StrategyNote?: string;
  day2Saved?: boolean;
  d3MatchName?: string;
  d3Sites?: any[];
  d3Result?: '1' | 'X' | '2';
  d3FbResult?: '1' | 'X' | '2';
  day3Saved?: boolean;
  /** Sparad plan från Bonus optimering. Används för att fortsätta omsättning över flera rundor. */
  bonusOptimizer?: {
    version: 1;
    status: 'open' | 'settled' | 'continued' | 'done';
    result?: '1' | 'X' | '2';
    startTs?: string;
    league?: string;
    odds?: unknown;
    oddsOverrides?: Record<string, number>;
    plan: unknown;
    /**
     * Freebets som tjänats in under flerronds-spelet (t.ex. "vinst 4 → freebet 200 kr"
     * eller wagering-mål). De rullas automatiskt in i nästa runds optimering tills de
     * markerats som använda i `usedInRound`.
     */
    earnedFreebets?: Array<{
      id: string;
      bookmakerId: string;
      amount: number;
      minOdds: number;
      sourceRound: number;
      addedAt: string;
      usedInRound?: number;
      note?: string;
    }>;
    rounds: Array<{
      id: string;
      round: number;
      type: 'day1' | 'wagering' | 'continuation';
      sourceRound?: number;
      matchName: string;
      startTs?: string;
      league?: string;
      result?: '1' | 'X' | '2';
      createdAt: string;
      matched?: unknown[];
      freebets?: unknown[];
      matchedAccounts?: unknown[];
      freebetVouchers?: unknown[];
      cashComplements?: unknown[];
      plan?: unknown;
      remainingAccountsAfterResult?: unknown[];
      notes?: string;
    }>;
  };
}

export const defaultBookmakers: Bookmaker[] = [
  { id: 'bet365', name: 'Bet365', bonusType: 'freebet', depositAmount: 1500, betAmount: 0, freebetValue: 1500, status: 'pending' },
  { id: 'unibet', name: 'Unibet', bonusType: 'freebet', depositAmount: 1000, betAmount: 0, freebetValue: 1000, status: 'pending' },
  { id: 'hajper', name: 'Hajper', bonusType: 'freebet', depositAmount: 500, betAmount: 0, freebetValue: 500, status: 'pending' },
  { id: 'dbet', name: 'DBET', bonusType: 'freebet', depositAmount: 500, betAmount: 0, freebetValue: 500, status: 'pending' },
  { id: 'mrvegas', name: 'MrVegas', bonusType: 'freebet', depositAmount: 500, betAmount: 0, freebetValue: 500, status: 'pending' },
  { id: 'megariches', name: 'Megariches', bonusType: 'freebet', depositAmount: 500, betAmount: 0, freebetValue: 500, status: 'pending' },
  { id: 'betsson', name: 'Betsson', bonusType: 'freebet', depositAmount: 250, betAmount: 0, freebetValue: 250, status: 'pending' },
  { id: 'x3000', name: 'X3000', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 12, status: 'pending' },
  { id: 'goldenbull', name: 'Golden Bull', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 12, status: 'pending' },
  { id: '1x2', name: '1x2', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 12, status: 'pending' },
  { id: 'vbet', name: 'VBET', bonusType: 'matched', depositAmount: 800, betAmount: 1600, wagering: 20, status: 'pending' },
  { id: 'speedybet', name: 'SpeedyBet', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 12, status: 'pending' },
  { id: 'snabbare', name: 'Snabbare', bonusType: 'matched', depositAmount: 600, betAmount: 1200, wagering: 16, status: 'pending' },
  { id: 'comeon', name: 'ComeOn', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 12, status: 'pending' },
  { id: 'bethard', name: 'Bethard', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 30, status: 'pending' },
  { id: 'spelklubben', name: 'Spel Klubben', bonusType: 'matched', depositAmount: 500, betAmount: 1000, wagering: 30, status: 'pending' },
];

export function calcMatchedBonusEV(
  bonusAmount: number,
  wagering: number,
  houseEdge: number = 0.03
): number {
  const totalWager = bonusAmount * wagering;
  const expectedLoss = totalWager * houseEdge;
  return bonusAmount - expectedLoss;
}

// localStorage helpers — same key name must be used for the `storage` event in Index.tsx
export const BET_LOGS_STORAGE_KEY = 'matched-betting-logs';
const LOGS_MIRROR_KEY = `${BET_LOGS_STORAGE_KEY}-session-mirror`;

function parseLogArray(raw: string | null): BetLog[] | null {
  if (raw == null) return null;
  if (raw === '') return [];
  const trimmed = raw.trim();
  try {
    const v = JSON.parse(trimmed) as unknown;
    return Array.isArray(v) ? (v as BetLog[]) : null;
  } catch {
    return null;
  }
}

function parseImportedLogArray(text: string): BetLog[] {
  const data = JSON.parse(text) as unknown;
  if (Array.isArray(data)) return data as BetLog[];
  if (data && typeof data === 'object' && Array.isArray((data as { logs?: unknown }).logs)) {
    return (data as { logs: BetLog[] }).logs;
  }
  throw new Error('Ogiltig fil: förväntade en JSON-array (eller { logs: [...] }).');
}

/** Ladda ner som JSON (backup). */
export function serializeBetLogsForExport(): string {
  return JSON.stringify(getBetLogs(), null, 2);
}

/** Importera backup: slår ihop med befintliga (samma `id` skrivs över). */
export function importBetLogsMergeJson(text: string): BetLog[] {
  const incoming = parseImportedLogArray(text);
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || typeof item.matchName !== 'string' || typeof item.person !== 'string') {
      throw new Error('Ogiltigt spel i filen (saknar id, match eller person).');
    }
  }
  const byId = new Map<string, BetLog>();
  for (const l of getBetLogs()) byId.set(l.id, l);
  for (const l of incoming) byId.set(l.id, l);
  const out = Array.from(byId.values()).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  persistBetLogs(out);
  return out;
}

function mergeBetLogsByNewest(local: BetLog[], server: BetLog[]): BetLog[] {
  const byId = new Map<string, BetLog>();
  for (const l of local) {
    byId.set(l.id, l);
  }
  for (const l of server) {
    const ex = byId.get(l.id);
    if (!ex || new Date(l.date).getTime() >= new Date(ex.date).getTime()) {
      byId.set(l.id, l);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

async function pushBetLogsToDevFile(logs: BetLog[]): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    await fetch(apiUrl("/api/bet-logs"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(logs),
    });
  } catch {
    /* dev-server ej igång */
  }
}

/** Endast webbläsarlagring (används internt så vi inte PUT:ar i onödan). */
function writeLocalAndMirror(logs: BetLog[]): void {
  const json = JSON.stringify(logs);
  try {
    localStorage.setItem(BET_LOGS_STORAGE_KEY, json);
  } catch (e) {
    console.error("matched-betting: kunde inte skriva till localStorage (fullt eller blockerat?)", e);
  }
  try {
    sessionStorage.setItem(LOGS_MIRROR_KEY, json);
  } catch {
    /* ignore */
  }
}

/**
 * Utvecklingsläge (`npm run dev`): hämtar/synkar med projektfilen `.matched-betting-logs.json`
 * samma data oavsett om du öppnar localhost, 127.0.0.1 eller LAN-IP (samma port).
 * Produktion: bara localStorage.
 */
export async function syncBetLogsOnLoad(): Promise<BetLog[]> {
  const local = getBetLogs();
  if (!import.meta.env.DEV) return local;
  try {
    const r = await fetch(apiUrl("/api/bet-logs"));
    if (!r.ok) return local;
    const j: unknown = await r.json();
    if (!Array.isArray(j)) return local;
    const server = j as BetLog[];
    const merged = mergeBetLogsByNewest(local, server);
    writeLocalAndMirror(merged);
    if (JSON.stringify(merged) !== JSON.stringify(server)) {
      await pushBetLogsToDevFile(merged);
    }
    return merged;
  } catch {
    return getBetLogs();
  }
}

/** Skriver till localStorage + speglar till dev-fil vid `npm run dev`. */
function persistBetLogs(logs: BetLog[]): void {
  writeLocalAndMirror(logs);
  void pushBetLogsToDevFile(logs);
}

export function saveBetLog(log: BetLog): void {
  let logs = getBetLogs();
  // Replace existing log with same person + match
  const existingIndex = logs.findIndex(l => l.person === log.person && l.matchName === log.matchName);
  if (existingIndex !== -1) {
    logs[existingIndex] = log;
  } else {
    logs.unshift(log);
  }
  persistBetLogs(logs);
}

export function getBetLogs(): BetLog[] {
  const fromLocal = parseLogArray(localStorage.getItem(BET_LOGS_STORAGE_KEY));
  if (fromLocal !== null) return fromLocal;

  const fromMirror = parseLogArray(sessionStorage.getItem(LOGS_MIRROR_KEY));
  if (fromMirror !== null && fromMirror.length > 0) {
    try {
      localStorage.setItem(BET_LOGS_STORAGE_KEY, JSON.stringify(fromMirror));
    } catch {
      /* keep returning mirror data at least this session */
    }
    return fromMirror;
  }

  return [];
}

export function deleteBetLog(id: string): void {
  const logs = getBetLogs().filter(l => l.id !== id);
  persistBetLogs(logs);
}

export function updateBetLogResult(id: string, result: '1' | 'X' | '2'): void {
  const logs = getBetLogs();
  const log = logs.find(l => l.id === id);
  if (log) {
    log.result = result;
    persistBetLogs(logs);
  }
}
