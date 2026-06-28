/**
 * Datatyper för Pinnacle Odds Dropper-sidan (POD-stil tracking).
 *
 * Vi följer Pinnacle:s odds över tid via polling av
 * /api/odds/pinnacle-normalized var ~60s. Varje snapshot lagras i
 * localStorage som en rolling buffer per (match::market::line::selection)-
 * nyckel. Drop-detector räknar förändring mellan snapshots inom rullande
 * tidsfönster (5 min, 30 min).
 */

/** Backend-respons från /api/odds/pinnacle-normalized */
export interface PinnacleNormalizedRow {
  match: string;
  sport: string;
  league?: string;
  startTime: string;
  market: "moneyline" | "total" | "spread";
  line: number | null;
  selection: "home" | "draw" | "away" | "over" | "under";
  odds: number;
  timestamp: string;
  matchupId: string;
}

export interface PinnacleNormalizedResponse {
  ok: boolean;
  updatedAt: string | null;
  source: "disk" | "github-api" | "github-raw" | "cache" | "empty";
  ageSeconds: number | null;
  count: number;
  rows: PinnacleNormalizedRow[];
}

/** Stable key per outcome. Identisk struktur för båda backend-row och history-entry. */
export type OddsKey = string;

/**
 * En enskild odds-mätning i tiden. Lagras i localStorage history-buffer.
 * Vi behöver inte hela rad-objektet — bara odds + timestamp för att
 * detektera drops.
 */
export interface OddsSample {
  odds: number;
  /** ISO-timestamp när snapshotet togs (från backend response.updatedAt
   *  eller klient-sidan timestamp om backend timestamp saknas). */
  ts: string;
}

/** Rolling buffer per OddsKey. Sparas i localStorage. */
export interface OddsHistoryEntry {
  /** Metadata om matchen + outcome (kopia av senaste sample för UI). */
  match: string;
  sport: string;
  league?: string;
  startTime: string;
  market: "moneyline" | "total" | "spread";
  line: number | null;
  selection: "home" | "draw" | "away" | "over" | "under";
  /** Senast sedda odds = samples[samples.length - 1]. */
  samples: OddsSample[];
}

/** Detekterad drop. Visas i tabellen. */
export interface DropSignal {
  key: OddsKey;
  match: string;
  sport: string;
  league?: string;
  startTime: string;
  market: "moneyline" | "total" | "spread";
  line: number | null;
  selection: "home" | "draw" | "away" | "over" | "under";
  /** Senaste odds (current). */
  currentOdds: number;
  /** Odds från lookback-fönstret. */
  previousOdds: number;
  /** Procent förändring: (current/previous - 1) * 100. Negativ = drop. */
  changePct: number;
  /** Tidsfönster i minuter som detektor använde (5 eller 30). */
  windowMinutes: number;
  /** ISO-timestamp för senaste sample. */
  detectedAt: string;
  /** ISO-timestamp för previous-sample. */
  previousAt: string;
  /** Antal samples i bufferten — för UI-confidence. */
  sampleCount: number;
}

/** Default drop-tröskel i procent (absolut värde). Vi flaggar drops där
 *  odds har sjunkit minst så här mycket. */
export const DEFAULT_DROP_THRESHOLD_PCT = 2;

/** Tidsfönster (minuter) som POD-sidan jämför nuvarande odds mot. */
export const DEFAULT_DROP_WINDOWS = [5, 30] as const;

/** Hur länge en sample behålls i bufferten (24h). Äldre samples trimmas. */
export const MAX_HISTORY_AGE_MS = 24 * 60 * 60 * 1000;

/** Max samples per key (även om de är yngre än MAX_HISTORY_AGE_MS).
 *  Skydd mot localStorage-quota om polling pågår länge. */
export const MAX_SAMPLES_PER_KEY = 200;

/** localStorage-nyckel för historik-bufferten. */
export const ODDS_HISTORY_STORAGE_KEY = "parlay-pilot-pinnacle-odds-history";
