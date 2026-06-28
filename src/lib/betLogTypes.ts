/**
 * Datatyper för Oddexus Bet Log (separat från `matched-betting-logs`-
 * loggarna i Index.tsx). Lagras i localStorage under nyckeln
 * `parlay-pilot-value-bet-log`.
 *
 * Designprincip: bara råa fält lagras. Beräknade värden (EV i kr, CLV%,
 * actual profit) räknas ut live i `betLogCalculations.ts` så att gamla
 * rader automatiskt blir korrekta om vi förbättrar formler senare.
 */

export type BetStatus = "open" | "won" | "lost" | "void" | "half-won" | "half-lost";

export type BetOutcome = "1" | "X" | "2";

/** Source-fältet säger om bettet skapades via "Log bet" från en live valuebet
 *  eller manuellt via Bet Log-tabbens "Add bet"-knapp. */
export type BetSource = "live-valuebet" | "manual";

export interface LoggedBet {
  /** Unik ID, genereras med crypto.randomUUID() vid skapelse. */
  id: string;
  /** ISO-timestamp när raden skapades i loggen. */
  loggedAt: string;

  // ── Match-info ─────────────────────────────────────────────────────
  match: string;
  league?: string;
  /** Kickoff i ISO-format (ej sekunder behövs). */
  startTs?: string;
  /** "soccer" | "basketball" | "tennis". Används för Pinnacle-matchning
   *  (auto-CLV) + auto-resultat. Saknas på äldre rader → antas "soccer". */
  sport?: string;

  // ── Bet-info ───────────────────────────────────────────────────────
  bookmakerId: string;
  bookmakerName: string;
  outcome: BetOutcome;
  /** Etikett som "Hemma", "Borta", "Oavgjort" eller lagnamn — för läsbarhet. */
  outcomeLabel?: string;
  /** Det odds vi tog (decimal). */
  bookOdds: number;
  /** Insats i kr. */
  stake: number;

  // ── EV-snapshot vid bet-tillfället ────────────────────────────────
  /** Pinnacle raw odds för vår outcome vid bet-tillfället. */
  pinnacleOddsAtBet?: number;
  /** Pinnacle no-vig fair odds för vår outcome vid bet-tillfället. */
  pinnacleFairOddsAtBet?: number;
  /** Pinnacle no-vig fair sannolikhet för vår outcome vid bet-tillfället. */
  pinnacleFairProbAtBet?: number;
  /** Pinnacle max-insats (likviditet) vid bet-tillfället. Hög = vass linje, låg =
   *  tunn → edge svänger. Loggas för CLV-per-likviditet-analysen. null = okänd. */
  pinnacleLimitAtBet?: number | null;
  /** EV i procent vid bet-tillfället. EV-kr beräknas live = stake * evPct/100. */
  evPctAtBet?: number;

  // ── CLV ────────────────────────────────────────────────────────────
  /** Pinnacle no-vig fair odds vid match-start (closing). Fylls automatiskt
   *  vid avspark av useClvCapture, eller manuellt via "Update CLV". */
  closingFairOdds?: number;
  /** True om closingFairOdds fångades automatiskt (vs manuell inmatning). */
  clvAuto?: boolean;

  // ── Settlement ─────────────────────────────────────────────────────
  status: BetStatus;
  /** Faktiskt matchresultat (vinnande outcome) — för auto-settle. */
  result?: BetOutcome;
  /** Slutställning i bettets match-orientering (hemma-borta), t.ex. "2-1".
   *  Fångas automatiskt från TheSportsDB vid settle. Saknas på äldre rader. */
  finalScore?: string;
  /** ISO när status sattes till annat än "open". */
  settledAt?: string;

  // ── Extras ─────────────────────────────────────────────────────────
  notes?: string;
  source: BetSource;
}

/** Aggregerade siffror för Results-dashboard. Allt i kr eller procent. */
export interface BetLogSummary {
  totalBets: number;
  openBets: number;
  settledBets: number;
  wonBets: number;
  lostBets: number;
  voidBets: number;
  halfWonBets: number;
  halfLostBets: number;

  totalStake: number;
  /** Summa stake för settled bets — används som nämnare i ROI. */
  settledStake: number;

  /** Summerad EV i kr över alla loggade bets. */
  totalEvKr: number;
  /** Genomsnittlig EV% per bet (oviktat). */
  avgEvPct: number | null;

  /** Genomsnittlig CLV% per bet med ifyllt closing fair odds. */
  avgClvPct: number | null;
  /** Antal bets med CLV registrerad. */
  betsWithClv: number;

  /** Faktisk profit summerad över settled bets. */
  totalActualProfit: number;
  /** ROI = totalActualProfit / settledStake. Null om inga settled. */
  roiPct: number | null;
  /** Förväntad ROI = totalEvKr / totalStake. Null om totalStake = 0. */
  expectedRoiPct: number | null;

  /** Hit rate = wonBets / (wonBets + lostBets). Excluderar void/half. */
  hitRatePct: number | null;
}

/** Format-version för export/import. Bumpa vid breaking change i typdefinitionen. */
export const BET_LOG_FORMAT_VERSION = 1;

export interface BetLogExport {
  version: number;
  exportedAt: string;
  bets: LoggedBet[];
}
