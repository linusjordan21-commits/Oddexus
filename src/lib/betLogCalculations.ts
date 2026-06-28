/**
 * Rena beräkningar för Bet Log. Inga sido-effekter — gör dem trivialt
 * testbara och säkra att importera överallt. All data läses från LoggedBet
 * och avledda värden räknas ut här istället för att lagras (så vi kan
 * förbättra formlerna utan att rörda gamla rader).
 */

import type { BetLogSummary, BetStatus, LoggedBet } from "./betLogTypes";

/**
 * EV i kronor från en bets stake och EV-procent.
 * Formel: EV-kr = stake * (EV% / 100).
 */
export function evKr(stake: number, evPct: number | null | undefined): number {
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (evPct == null || !Number.isFinite(evPct)) return 0;
  return stake * (evPct / 100);
}

/**
 * CLV-procent mot Pinnacle no-vig fair line.
 *
 *   CLV% = (bookOdds / closingFairOdds - 1) * 100
 *
 * Tolkning: positivt CLV = vi tog ett odds som var skarpare än vad
 * Pinnacles fair-line stängde på. Det är industristandarden för
 * sharp-validering. Vi använder fair-odds (no-vig) snarare än rå
 * Pinnacle-odds, eftersom rå pris innehåller deras overround och då
 * skulle CLV bli systematiskt understäld.
 *
 * Returnerar null om closingFairOdds saknas eller är ogiltigt.
 */
export function clvPct(bookOdds: number, closingFairOdds: number | null | undefined): number | null {
  if (!Number.isFinite(bookOdds) || bookOdds <= 1) return null;
  if (closingFairOdds == null || !Number.isFinite(closingFairOdds) || closingFairOdds <= 1) return null;
  return (bookOdds / closingFairOdds - 1) * 100;
}

/**
 * Faktisk profit i kronor utifrån status. För open-bets returneras null
 * (ingen siffra ska visas i tabellen för open).
 */
export function actualProfit(bet: LoggedBet): number | null {
  const { status, stake, bookOdds } = bet;
  if (!Number.isFinite(stake) || !Number.isFinite(bookOdds)) return null;
  switch (status) {
    case "open":
      return null;
    case "won":
      return stake * (bookOdds - 1);
    case "lost":
      return -stake;
    case "void":
      return 0;
    case "half-won":
      return (stake * (bookOdds - 1)) / 2;
    case "half-lost":
      return -stake / 2;
    default:
      return null;
  }
}

/** True om status räknas som "settled" (vi har ett resultat). */
export function isSettled(status: BetStatus): boolean {
  return status !== "open";
}

/** Aggregera dashboard-siffror över en lista av loggade bets. */
export function summarizeBets(bets: LoggedBet[]): BetLogSummary {
  const summary: BetLogSummary = {
    totalBets: bets.length,
    openBets: 0,
    settledBets: 0,
    wonBets: 0,
    lostBets: 0,
    voidBets: 0,
    halfWonBets: 0,
    halfLostBets: 0,
    totalStake: 0,
    settledStake: 0,
    totalEvKr: 0,
    avgEvPct: null,
    avgClvPct: null,
    betsWithClv: 0,
    totalActualProfit: 0,
    roiPct: null,
    expectedRoiPct: null,
    hitRatePct: null,
  };

  let evPctSum = 0;
  let evPctCount = 0;
  let clvPctSum = 0;

  for (const bet of bets) {
    summary.totalStake += bet.stake;
    summary.totalEvKr += evKr(bet.stake, bet.evPctAtBet);

    if (bet.evPctAtBet != null && Number.isFinite(bet.evPctAtBet)) {
      evPctSum += bet.evPctAtBet;
      evPctCount += 1;
    }

    const clv = clvPct(bet.bookOdds, bet.closingFairOdds);
    if (clv !== null) {
      clvPctSum += clv;
      summary.betsWithClv += 1;
    }

    switch (bet.status) {
      case "open":
        summary.openBets += 1;
        break;
      case "won":
        summary.wonBets += 1;
        break;
      case "lost":
        summary.lostBets += 1;
        break;
      case "void":
        summary.voidBets += 1;
        break;
      case "half-won":
        summary.halfWonBets += 1;
        break;
      case "half-lost":
        summary.halfLostBets += 1;
        break;
    }

    if (isSettled(bet.status)) {
      summary.settledBets += 1;
      summary.settledStake += bet.stake;
      const ap = actualProfit(bet);
      if (ap !== null) summary.totalActualProfit += ap;
    }
  }

  summary.avgEvPct = evPctCount > 0 ? evPctSum / evPctCount : null;
  summary.avgClvPct = summary.betsWithClv > 0 ? clvPctSum / summary.betsWithClv : null;

  if (summary.settledStake > 0) {
    summary.roiPct = (summary.totalActualProfit / summary.settledStake) * 100;
  }
  if (summary.totalStake > 0) {
    summary.expectedRoiPct = (summary.totalEvKr / summary.totalStake) * 100;
  }

  // Hit rate = won / (won + lost). Void/half räknas inte (för/emot är inte 100% binärt).
  const hitNumerator = summary.wonBets;
  const hitDenominator = summary.wonBets + summary.lostBets;
  if (hitDenominator > 0) {
    summary.hitRatePct = (hitNumerator / hitDenominator) * 100;
  }

  return summary;
}

/**
 * Yield = total actual profit / total turnover (over all bets, settled
 * eller ej). Skiljer sig från `roiPct` som använder settled stake. Yield
 * är industristandarden i sportsbetting för att mäta "edge per kr satsat".
 *
 * Returnerar null om totalStake = 0.
 */
export function yieldPct(totalActualProfit: number, totalStake: number): number | null {
  if (!Number.isFinite(totalStake) || totalStake <= 0) return null;
  return (totalActualProfit / totalStake) * 100;
}

/** En punkt i kumulativ profit-chart. Endast settled bets ingår. */
export interface ChartPoint {
  /** 1-baserat bet-nummer (bland settled bets) i kronologisk ordning. */
  index: number;
  /** ISO-timestamp när bettet loggades — för tooltip. */
  loggedAt: string;
  /** Match-titel — för tooltip. */
  match: string;
  /** Status — för tooltip-färgning (alltid != "open" här). */
  status: BetStatus;
  /** Detta bets enskilda actual profit. */
  betActual: number;
  /** Detta bets CLV-bidrag i kr: stake * (bookOdds/closingFairOdds - 1).
   *  Null om closingFairOdds saknas. */
  betClv: number | null;
  /** Kumulativ actual profit till och med detta bet. */
  cumulativeActual: number;
  /** Kumulativ CLV i kr (bets utan closing fair odds bidrar 0). */
  cumulativeClv: number;
}

/**
 * Bygger data-punkter för Profit and Bets-chart. Filtrerar bort öppna
 * bets — endast settled (won/lost/void/half-won/half-lost) inkluderas.
 *
 * Två serier ackumuleras:
 *   - cumulativeActual: faktisk profit per settled bet
 *   - cumulativeClv:    stake * (bookOdds/closingFairOdds − 1), kr.
 *                       Bets utan closing fair odds bidrar 0 men räknas
 *                       fortfarande in i index.
 */
export function buildCumulativeChartData(bets: LoggedBet[]): ChartPoint[] {
  const settled = bets.filter((b) => b.status !== "open");

  const sorted = [...settled].sort((a, b) => {
    const ta = Date.parse(a.loggedAt);
    const tb = Date.parse(b.loggedAt);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return a.loggedAt.localeCompare(b.loggedAt);
  });

  const points: ChartPoint[] = [];
  let cumulativeActual = 0;
  let cumulativeClv = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const bet = sorted[i];
    const betActual = actualProfit(bet) ?? 0;

    const clvFraction =
      bet.closingFairOdds != null &&
      Number.isFinite(bet.closingFairOdds) &&
      bet.closingFairOdds > 1
        ? bet.bookOdds / bet.closingFairOdds - 1
        : null;
    const betClv = clvFraction != null ? bet.stake * clvFraction : null;

    cumulativeActual += betActual;
    if (betClv != null) cumulativeClv += betClv;

    points.push({
      index: i + 1,
      loggedAt: bet.loggedAt,
      match: bet.match,
      status: bet.status,
      betActual,
      betClv,
      cumulativeActual,
      cumulativeClv,
    });
  }

  return points;
}

/** Status-etikett som visas i UI (svenska). */
export const STATUS_LABEL: Record<BetStatus, string> = {
  open: "Öppen",
  won: "Vunnen",
  lost: "Förlorad",
  void: "Återbetald",
  "half-won": "Halvvunnen",
  "half-lost": "Halvförlorad",
};

/** Status-färgklasser för Badge-komponenten. */
export const STATUS_BADGE_VARIANT: Record<BetStatus, "default" | "secondary" | "destructive" | "outline"> = {
  open: "outline",
  won: "default",
  lost: "destructive",
  void: "secondary",
  "half-won": "secondary",
  "half-lost": "destructive",
};
