export type Outcome = "1" | "X" | "2";

export const BONUS_OUTCOMES: Outcome[] = ["1", "X", "2"];
const TARGET_AVERAGE_LOSS_EDGE_PCT = 5;
const SOFT_SPREAD_PENALTY_WEIGHT = 0.05;

export type OddsTriple = Record<Outcome, number>;

export type BonusBookmakerId =
  | "unibet"
  | "hajper"
  | "dbet"
  | "mrvegas"
  | "megariches"
  | "x3000"
  | "goldenbull"
  | "1x2"
  | "vbet"
  | "speedybet"
  | "snabbare"
  | "comeon"
  | "bethard"
  | "spelklubben"
  | "coolbet"
  | "leovegas"
  | "expekt"
  | "betmgm"
  | "megafortune"
  | "888sport"
  | "prontosport"
  | "tipwin"
  | "10bet"
  | "nordicbet"
  | "betsafe"
  | "lucky"
  | "quick"
  | "videoslots"
  | "kungaslottet"
  | "svenskaspel"
  | "campobet";

export const BONUS_BOOKMAKER_NAMES: Record<BonusBookmakerId, string> = {
  unibet: "Unibet",
  hajper: "Hajper",
  dbet: "DBET",
  mrvegas: "MrVegas",
  megariches: "MegaRiches",
  x3000: "X3000",
  goldenbull: "Golden Bull",
  "1x2": "1x2",
  vbet: "VBET",
  speedybet: "Speedybet",
  snabbare: "Snabbare",
  comeon: "ComeOn",
  bethard: "Bethard",
  spelklubben: "Spelklubben",
  coolbet: "Coolbet",
  leovegas: "LeoVegas",
  expekt: "Expekt",
  betmgm: "BetMGM",
  megafortune: "MegaFortune",
  "888sport": "888sport",
  prontosport: "ProntoSport",
  tipwin: "Tipwin",
  "10bet": "10bet",
  nordicbet: "NordicBet",
  betsafe: "Betsafe",
  lucky: "LuckyCasino",
  quick: "QuickCasino",
  videoslots: "Videoslots",
  kungaslottet: "Kungaslottet",
  svenskaspel: "Svenska Spel (Oddset)",
  campobet: "CampoBet",
};

export type MatchedBonus = {
  id: BonusBookmakerId;
  deposit: number;
  minOdds: number;
  wagerMultiplier: number;
  enabled: boolean;
};

export type FreebetBonus = {
  id: BonusBookmakerId;
  amount: number;
  minOdds: number;
  enabled: boolean;
};

export type BonusPortfolio = {
  matched: MatchedBonus[];
  freebets: FreebetBonus[];
};

export const DEFAULT_BONUS_PORTFOLIO: BonusPortfolio = {
  matched: [
    // Coolbet (svensk licens): 100 % upp till 1000 kr, omsättning 6× @ min-odds 1.80,
    // 60 dagar. Lägst omsättningskrav i portföljen → bästa matched-bonusen.
    { id: "coolbet", deposit: 1000, minOdds: 1.8, wagerMultiplier: 6, enabled: true },
    // Kambi-systerbrands (samma odds som Unibet, men egna välkomstbonusar):
    { id: "leovegas", deposit: 600, minOdds: 1.8, wagerMultiplier: 6, enabled: true },  // 100% upp till 600 kr, 6×, 60d
    { id: "betmgm", deposit: 1000, minOdds: 1.8, wagerMultiplier: 10, enabled: true },  // 1000 kr, 10×, 60d
    { id: "expekt", deposit: 1500, minOdds: 1.8, wagerMultiplier: 15, enabled: true },  // 1500 kr, 15×, 90d
    // MegaFortune (Altenar, Immense-grupp): sport-villkor ej offentligt bekräftade —
    // konservativ proxy (verifiera inloggad). Odds är genuint egna (Altenar-marginal).
    { id: "megafortune", deposit: 1000, minOdds: 1.8, wagerMultiplier: 10, enabled: true },
    // 888sport (Spectate): 100% upp till 500 kr. Omsättning varierar i källor
    // (8× repo / 30× affiliate) — konservativ proxy, verifiera inloggad.
    { id: "888sport", deposit: 500, minOdds: 1.8, wagerMultiplier: 8, enabled: true },
    // ProntoSport (ABM): 50 kr ins → 200 kr bonus, 1× omsättning — exceptionellt lågt.
    { id: "prontosport", deposit: 200, minOdds: 1.8, wagerMultiplier: 1, enabled: true },
    // OBS: tipwin/quick (QuickCasino) är ENDAST bonus-finder (ej optimizer) per önskemål
    // 2026-06-26 → de finns i BONUS_BOOKMAKER_NAMES + BONUS_FINDER_BOOKMAKER_MAP men har
    // ingen portfolio-post här.
    // 10bet (Playtech Vision): egna odds (Playtech-marginal). Välkomstvillkor ej offentligt
    // bekräftade — konservativ proxy, verifiera inloggad.
    { id: "10bet", deposit: 500, minOdds: 1.8, wagerMultiplier: 10, enabled: true },
    { id: "x3000", deposit: 500, minOdds: 1.8, wagerMultiplier: 12, enabled: true },
    { id: "goldenbull", deposit: 500, minOdds: 1.8, wagerMultiplier: 12, enabled: true },
    { id: "1x2", deposit: 500, minOdds: 1.8, wagerMultiplier: 12, enabled: true },
    { id: "speedybet", deposit: 500, minOdds: 1.8, wagerMultiplier: 12, enabled: true },
    { id: "comeon", deposit: 500, minOdds: 1.8, wagerMultiplier: 12, enabled: true },
    { id: "snabbare", deposit: 600, minOdds: 1.8, wagerMultiplier: 16, enabled: true },
    { id: "vbet", deposit: 800, minOdds: 1.8, wagerMultiplier: 20, enabled: true },
    { id: "spelklubben", deposit: 500, minOdds: 1.9, wagerMultiplier: 30, enabled: true },
  ],
  freebets: [
    { id: "unibet", amount: 1000, minOdds: 1.8, enabled: true },
    { id: "hajper", amount: 500, minOdds: 1.8, enabled: true },
    { id: "dbet", amount: 500, minOdds: 1.8, enabled: true },
    { id: "mrvegas", amount: 500, minOdds: 1.8, enabled: true },
    { id: "megariches", amount: 500, minOdds: 1.8, enabled: true },
    // Bethard har bytt från matched-bonus till en freebet på 250 kr. Freebets
    // får spelas på LÅGA odds (du vinner vinsten på den sidan) → lågt min-odds.
    { id: "bethard", amount: 250, minOdds: 1.5, enabled: true },
    // Nya freebet-sajter (2026-06-26). Betsson-syskon (nordicbet/betsafe) = samma odds
    // som betsson (nu med totals+AH); LuckyCasino = Altenar (totals).
    { id: "nordicbet", amount: 100, minOdds: 1.8, enabled: true },
    { id: "betsafe", amount: 100, minOdds: 1.8, enabled: true },
    { id: "lucky", amount: 500, minOdds: 1.8, enabled: true },
    // Nya freebet-sajter (2026-06-26, omgång 2). Egna sportböcker (odds-källa under
    // uppbyggnad) → posterna är inerta i optimizern tills respektive scraper matar
    // odds, men finns med så de syns i optimizer + finder enligt önskemål.
    // Videoslots/Kungaslottet = samma grupp (Videoslots Ltd, Betradar-trading).
    { id: "videoslots", amount: 500, minOdds: 1.8, enabled: true },
    { id: "kungaslottet", amount: 500, minOdds: 1.8, enabled: true },
    // Svenska Spel/Oddset: svensk statlig licens, egen plattform.
    { id: "svenskaspel", amount: 100, minOdds: 1.8, enabled: true },
    // OBS: campobet (Soft2Bet) är ENDAST bonus-finder (ej optimizer) per önskemål
    // 2026-06-26 → finns i NAMES + BONUS_FINDER_BOOKMAKER_MAP men ingen portfolio-post.
  ],
};

export type BonusMatch = {
  title: string;
  startTs?: string;
  league?: string;
  odds: Partial<Record<BonusBookmakerId, OddsTriple>>;
};

export type MatchedBetPlan = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  matchIndex?: number;
  matchTitle?: string;
  matchStartTs?: string;
  matchLeague?: string;
  outcome: Outcome;
  deposit: number;
  stake: number;
  odds: number;
  grossReturn: number;
  wagerRequired: number;
  wageringContribution: number;
  wagerRemainingAfterBet: number;
};

export type FreebetPlan = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  matchIndex?: number;
  matchTitle?: string;
  matchStartTs?: string;
  matchLeague?: string;
  outcome: Outcome;
  amount: number;
  odds: number;
  profitOnWin: number;
};

export type OptimizationMethod = "strict-balance" | "min-variance" | "max-average" | "sharpe";

/**
 * Hur tolerant fördelningen av matched-bonusar mellan 1/X/2 får vara.
 * 0 = strikt jämn (idag t.ex. 3/3/3 vid 9 bonusar).
 * 1 = max ±1 från jämn (4/3/2, 3/4/2 etc.).
 * 2 = max ±2 från jämn (5/3/1, 5/2/2 etc.).
 * "free" = vilken fördelning som helst, men minst 1 bonus per utfall.
 */
export type DistributionTolerance = 0 | 1 | 2 | "free";

export const DEFAULT_DISTRIBUTION_TOLERANCE: DistributionTolerance = 1;
const MATCHED_ASSIGNMENT_BEAM_LIMIT = 160;

export type BonusOptimizationPlan = {
  method: OptimizationMethod;
  strategy?: "single-match" | "split-match";
  splitMatches?: Array<{ title: string; startTs?: string; league?: string }>;
  matched: MatchedBetPlan[];
  freebets: FreebetPlan[];
  /** Netto per utfall: vad kontona betalar tillbaka minus all nominell insats. */
  paybackPerOutcome: Record<Outcome, number>;
  /** Vid split: netto per resultatkombination, t.ex. "1/X". */
  scenarioPaybackPerOutcome?: Record<string, number>;
  /** Vid split: kontoutbetalning per resultatkombination, t.ex. "1/X". */
  scenarioAccountReturnPerOutcome?: Record<string, number>;
  /** Kontoutbetalning per utfall innan all insats dras bort. */
  accountReturnPerOutcome: Record<Outcome, number>;
  /** All nominell insats: matched stakes + freebet-belopp. */
  totalStakePlaced: number;
  /** Satsat - kontoutbetalning per utfall. Positivt tal = minus, negativt tal = plus. */
  stakeMinusReturnPerOutcome: Record<Outcome, number>;
  minPayback: number;
  averagePayback: number;
  variance: number;
  stdDev: number;
  outcomeSpread: number;
  score: number;
  /** Antal matched-bets per utfall (t.ex. {1:4, X:3, 2:2}). */
  matchedDistribution: Record<Outcome, number>;
  /** Summa matched-insats (2× deposit per bonus) — underlag för edge. */
  totalMatchedStake: number;
  /** Summa bonusbelopp (deposit) för matched — modellen för netto/jämförelse. */
  totalMatchedDeposit: number;
  /** Nominerade freebet-belopp (ingen kontant insats). */
  totalFreebetFaceValue: number;
  /** Netto vid sämsta utfall som andel av totalMatchedStake (typiskt negativt vid bonus). */
  worstCaseEdgePct: number;
  /** Snittnetto som andel av all nominell insats. Högre = bättre edge. */
  averageEdgePct: number;
};

export type BonusOptimizationResult = {
  best: BonusOptimizationPlan;
  methods: Record<OptimizationMethod, BonusOptimizationPlan>;
};

export type WageringAccount = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  balance: number;
  minOdds: number;
  wageringRemaining: number;
  sourceRound?: number;
};

export type FreebetVoucher = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  amount: number;
  minOdds: number;
};

export type ContinuationWageringBet = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  outcome: Outcome;
  stake: number;
  reserve: number;
  odds: number;
  grossReturn: number;
  wageringContribution: number;
  wageringRemainingAfterBet: number;
};

export type ContinuationFreebetBet = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  outcome: Outcome;
  amount: number;
  odds: number;
  profitOnWin: number;
};

export type ContinuationCashComplementBet = {
  outcome: Outcome;
  bookmakerId: string;
  bookmaker: string;
  stake: number;
  odds: number;
  grossReturn: number;
};

export type ContinuationPlan = {
  strategy: "same-match" | "split-match";
  matchTitle: string;
  startTs?: string;
  league?: string;
  wageringBets: ContinuationWageringBet[];
  freebetBets: ContinuationFreebetBet[];
  cashComplements: ContinuationCashComplementBet[];
  paybackPerOutcome: Record<Outcome, number>;
  accountReturnPerOutcome: Record<Outcome, number>;
  stakeMinusReturnPerOutcome: Record<Outcome, number>;
  totalStakePlaced: number;
  totalCashComplementStake: number;
  minPayback: number;
  averagePayback: number;
  worstCaseEdgePct: number;
  averageEdgePct: number;
  outcomeSpread: number;
};

export type ContinuationResult = {
  best: ContinuationPlan;
  candidates: ContinuationPlan[];
};

function variance(values: number[]) {
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

function evaluatePlan(
  method: OptimizationMethod,
  matched: MatchedBetPlan[],
  freebets: FreebetPlan[],
): BonusOptimizationPlan {
  const totalMatchedStake = matched.reduce((sum, bet) => sum + bet.stake, 0);
  const totalMatchedDeposit = matched.reduce((sum, bet) => sum + bet.deposit, 0);
  const totalFreebetFaceValue = freebets.reduce((sum, bet) => sum + bet.amount, 0);
  const totalStakePlaced = totalMatchedStake + totalFreebetFaceValue;
  // Kontant kapital du faktiskt RISKERAR = bara dina insättningar (deposits).
  // Varken bonus-pengar (andra halvan av en matched-stake) eller freebets är
  // dina pengar — de är gratis från bookmakern. Du satsar t.ex. 1000 kr (500
  // insättning + 500 bonus) men förlorar bara 500 om bettet går fel, och vinner
  // 1000×odds − 500 om det vinner. Netto-profit per utfall drar därför av summan
  // av INSÄTTNINGAR, inte hela staken (och inte freebet-face-value).
  const totalCashStakePlaced = totalMatchedDeposit;

  const accountReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => {
      const matchedReturn = matched
        .filter((bet) => bet.outcome === outcome)
        .reduce((sum, bet) => sum + bet.grossReturn, 0);
      const freebetReturn = freebets
        .filter((bet) => bet.outcome === outcome)
        .reduce((sum, bet) => sum + bet.profitOnWin, 0);
      return [outcome, matchedReturn + freebetReturn];
    }),
  ) as Record<Outcome, number>;
  const paybackPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, accountReturnPerOutcome[outcome] - totalCashStakePlaced]),
  ) as Record<Outcome, number>;
  const stakeMinusReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, totalCashStakePlaced - accountReturnPerOutcome[outcome]]),
  ) as Record<Outcome, number>;
  const values = BONUS_OUTCOMES.map((outcome) => paybackPerOutcome[outcome]);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const varValue = variance(values);
  const std = Math.sqrt(varValue);
  const minPayback = Math.min(...values);
  const outcomeSpread = Math.max(...values) - minPayback;
  const worstCaseEdgePct = totalStakePlaced > 0 ? (minPayback / totalStakePlaced) * 100 : 0;
  const averageEdgePct = totalStakePlaced > 0 ? (avg / totalStakePlaced) * 100 : 0;

  const score =
    method === "strict-balance"
      ? avg * 1000 - std
      : method === "min-variance"
        ? -varValue + avg / 1000
        : method === "max-average"
          ? avg * 1000 - std
          : std > 0
            ? avg / std
            : avg * 1000;

  const matchedDistribution = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, matched.filter((bet) => bet.outcome === outcome).length]),
  ) as Record<Outcome, number>;

  return {
    method,
    matched: matched.map((bet) => ({ ...bet })),
    freebets: freebets.map((bet) => ({ ...bet })),
    paybackPerOutcome,
    accountReturnPerOutcome,
    totalStakePlaced,
    stakeMinusReturnPerOutcome,
    minPayback,
    averagePayback: avg,
    variance: varValue,
    stdDev: std,
    outcomeSpread,
    score,
    matchedDistribution,
    totalMatchedStake,
    totalMatchedDeposit,
    totalFreebetFaceValue,
    worstCaseEdgePct,
    averageEdgePct,
  };
}

export function softSpreadPenaltyPct(outcomeSpread: number, totalStakePlaced: number) {
  if (totalStakePlaced <= 0) return 0;
  return (outcomeSpread / totalStakePlaced) * 100 * SOFT_SPREAD_PENALTY_WEIGHT;
}

function spreadAdjustedWorstEdgePct(plan: BonusOptimizationPlan) {
  return plan.worstCaseEdgePct - softSpreadPenaltyPct(plan.outcomeSpread, plan.totalStakePlaced);
}

function spreadAdjustedAverageEdgePct(plan: BonusOptimizationPlan) {
  return plan.averageEdgePct - softSpreadPenaltyPct(plan.outcomeSpread, plan.totalStakePlaced);
}

function meetsAverageEdgeTarget(plan: BonusOptimizationPlan) {
  return plan.averageEdgePct >= -TARGET_AVERAGE_LOSS_EDGE_PCT;
}

function meetsWorstCaseEdgeTarget(plan: BonusOptimizationPlan) {
  return plan.worstCaseEdgePct >= -TARGET_AVERAGE_LOSS_EDGE_PCT;
}

/** Prio 1: bästa sämsta förlustedge i procent. Snittedge är andraprio. */
function isBetterCandidate(candidate: BonusOptimizationPlan, current?: BonusOptimizationPlan) {
  if (!current) return true;
  const eps = 1e-4;

  const candidateMeetsEdge = meetsAverageEdgeTarget(candidate);
  const currentMeetsEdge = meetsAverageEdgeTarget(current);
  const candidateMeetsWorst = meetsWorstCaseEdgeTarget(candidate);
  const currentMeetsWorst = meetsWorstCaseEdgeTarget(current);
  if (candidateMeetsWorst !== currentMeetsWorst) return candidateMeetsWorst;

  const candidateSoftWorst = spreadAdjustedWorstEdgePct(candidate);
  const currentSoftWorst = spreadAdjustedWorstEdgePct(current);
  if (Math.abs(candidateSoftWorst - currentSoftWorst) > eps) {
    return candidateSoftWorst > currentSoftWorst;
  }
  if (Math.abs(candidate.worstCaseEdgePct - current.worstCaseEdgePct) > eps) {
    return candidate.worstCaseEdgePct > current.worstCaseEdgePct;
  }

  if (candidateMeetsEdge !== currentMeetsEdge) return candidateMeetsEdge;

  const candidateSoftAverage = spreadAdjustedAverageEdgePct(candidate);
  const currentSoftAverage = spreadAdjustedAverageEdgePct(current);
  if (Math.abs(candidateSoftAverage - currentSoftAverage) > eps) {
    return candidateSoftAverage > currentSoftAverage;
  }
  if (Math.abs(candidate.averageEdgePct - current.averageEdgePct) > eps) {
    return candidate.averageEdgePct > current.averageEdgePct;
  }

  if (Math.abs(candidate.averagePayback - current.averagePayback) > eps) {
    return candidate.averagePayback > current.averagePayback;
  }
  if (Math.abs(candidate.outcomeSpread - current.outcomeSpread) > eps) {
    return candidate.outcomeSpread < current.outcomeSpread;
  }
  if (Math.abs(candidate.stdDev - current.stdDev) > eps) return candidate.stdDev < current.stdDev;
  return candidate.minPayback > current.minPayback;
}

function maxWinningMatchedAccounts(count: number, tolerance: DistributionTolerance) {
  if (tolerance === "free") return count;
  return Math.min(count, Math.ceil(count / 3) + tolerance);
}

function buildMatchedBet(
  bonus: MatchedBonus,
  outcome: Outcome,
  odds: number,
  matchInfo?: { matchIndex: number; matchTitle: string; matchStartTs?: string; matchLeague?: string },
): MatchedBetPlan {
  const stake = bonus.deposit * 2;
  const wagerRequired = bonus.deposit * bonus.wagerMultiplier;
  return {
    bookmakerId: bonus.id,
    bookmaker: BONUS_BOOKMAKER_NAMES[bonus.id],
    ...matchInfo,
    outcome,
    deposit: bonus.deposit,
    stake,
    odds,
    grossReturn: stake * odds,
    wagerRequired,
    wageringContribution: stake,
    wagerRemainingAfterBet: Math.max(0, wagerRequired - stake),
  };
}

function buildFreebet(
  bonus: FreebetBonus,
  outcome: Outcome,
  odds: number,
  matchInfo?: { matchIndex: number; matchTitle: string; matchStartTs?: string; matchLeague?: string },
): FreebetPlan {
  return {
    bookmakerId: bonus.id,
    bookmaker: BONUS_BOOKMAKER_NAMES[bonus.id],
    ...matchInfo,
    outcome,
    amount: bonus.amount,
    odds,
    profitOnWin: bonus.amount * (odds - 1),
  };
}

function buildContinuationWageringBet(
  account: WageringAccount,
  outcome: Outcome,
  odds: number,
): ContinuationWageringBet {
  const meaningfulStake = account.wageringRemaining > 0 ? Math.min(account.balance, account.wageringRemaining) : 0;
  const stake = Math.max(0, Math.round(meaningfulStake));
  const reserve = Math.max(0, account.balance - stake);
  return {
    bookmakerId: account.bookmakerId,
    bookmaker: account.bookmaker,
    outcome,
    stake,
    reserve,
    odds,
    grossReturn: stake * odds,
    wageringContribution: stake,
    wageringRemainingAfterBet: Math.max(0, account.wageringRemaining - stake),
  };
}

function buildContinuationFreebetBet(
  voucher: FreebetVoucher,
  outcome: Outcome,
  odds: number,
): ContinuationFreebetBet {
  return {
    bookmakerId: voucher.bookmakerId,
    bookmaker: voucher.bookmaker,
    outcome,
    amount: voucher.amount,
    odds,
    profitOnWin: voucher.amount * (odds - 1),
  };
}

function evaluateContinuationPlan(
  strategy: ContinuationPlan["strategy"],
  match: BonusMatch,
  wageringBets: ContinuationWageringBet[],
  freebetBets: ContinuationFreebetBet[],
  cashComplements: ContinuationCashComplementBet[] = [],
): ContinuationPlan {
  const totalWageringStake = wageringBets.reduce((sum, bet) => sum + bet.stake, 0);
  const totalFreebetFaceValue = freebetBets.reduce((sum, bet) => sum + bet.amount, 0);
  const totalCashComplementStake = cashComplements.reduce((sum, bet) => sum + bet.stake, 0);
  const totalStakePlaced = totalWageringStake + totalFreebetFaceValue + totalCashComplementStake;
  const reserveTotal = wageringBets.reduce((sum, bet) => sum + bet.reserve, 0);

  const accountReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => {
      const wageringReturn = wageringBets
        .filter((bet) => bet.outcome === outcome)
        .reduce((sum, bet) => sum + bet.grossReturn, 0);
      const freebetReturn = freebetBets
        .filter((bet) => bet.outcome === outcome)
        .reduce((sum, bet) => sum + bet.profitOnWin, 0);
      const cashReturn = cashComplements
        .filter((bet) => bet.outcome === outcome)
        .reduce((sum, bet) => sum + bet.grossReturn, 0);
      return [outcome, reserveTotal + wageringReturn + freebetReturn + cashReturn];
    }),
  ) as Record<Outcome, number>;

  // Netto = (slutligt saldo) − (start-saldo: reserveTotal + wagering-stake) − (kontant cash-komplement-stake).
  // Freebet-stake räknas inte som kontant insats (förlust = 0 kr förlorat).
  const paybackPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [
      outcome,
      accountReturnPerOutcome[outcome] - reserveTotal - totalWageringStake - totalCashComplementStake,
    ]),
  ) as Record<Outcome, number>;
  const stakeMinusReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, -paybackPerOutcome[outcome]]),
  ) as Record<Outcome, number>;
  const values = BONUS_OUTCOMES.map((outcome) => paybackPerOutcome[outcome]);
  const minPayback = Math.min(...values);
  const averagePayback = values.reduce((sum, value) => sum + value, 0) / values.length;
  const outcomeSpread = Math.max(...values) - minPayback;

  return {
    strategy,
    matchTitle: match.title,
    startTs: match.startTs,
    league: match.league,
    wageringBets: wageringBets.map((bet) => ({ ...bet })),
    freebetBets: freebetBets.map((bet) => ({ ...bet })),
    cashComplements: cashComplements.map((bet) => ({ ...bet })),
    paybackPerOutcome,
    accountReturnPerOutcome,
    stakeMinusReturnPerOutcome,
    totalStakePlaced,
    totalCashComplementStake,
    minPayback,
    averagePayback,
    worstCaseEdgePct: totalStakePlaced > 0 ? (minPayback / totalStakePlaced) * 100 : 0,
    averageEdgePct: totalStakePlaced > 0 ? (averagePayback / totalStakePlaced) * 100 : 0,
    outcomeSpread,
  };
}

/** Snitt-odds på bonus-/wagering-sidan (för "gärna ännu högre"-preferensen). */
function avgWageringOdds(plan: ContinuationPlan): number {
  const bets = plan.wageringBets ?? [];
  if (bets.length === 0) return 0;
  return bets.reduce((sum, bet) => sum + bet.odds, 0) / bets.length;
}

function isBetterContinuationCandidate(candidate: ContinuationPlan, current?: ContinuationPlan) {
  if (!current) return true;
  const eps = 1e-4;
  if (Math.abs(candidate.worstCaseEdgePct - current.worstCaseEdgePct) > eps) {
    return candidate.worstCaseEdgePct > current.worstCaseEdgePct;
  }
  if (Math.abs(candidate.averageEdgePct - current.averageEdgePct) > eps) {
    return candidate.averageEdgePct > current.averageEdgePct;
  }
  // "Tappa matched": vid ekonomiskt likvärdiga planer, föredra HÖGRE odds på
  // bonus-sidan — då är bonus-betten mer sannolik att FÖRLORA (snabbare exit ur
  // omsättning), och Pinnacle/Smarkets-komplementet hamnar på de låga oddsen.
  const candOdds = avgWageringOdds(candidate);
  const curOdds = avgWageringOdds(current);
  if (Math.abs(candOdds - curOdds) > 0.05) {
    return candOdds > curOdds;
  }
  if (Math.abs(candidate.outcomeSpread - current.outcomeSpread) > eps) {
    return candidate.outcomeSpread < current.outcomeSpread;
  }
  return candidate.averagePayback > current.averagePayback;
}

export function addContinuationCashComplements(
  plan: ContinuationPlan,
  bestOdds: Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>>,
  maxStake = Math.min(Math.max(1000, plan.totalStakePlaced * 0.6), 8000),
): ContinuationPlan {
  if (!BONUS_OUTCOMES.every((outcome) => (bestOdds[outcome]?.odds ?? 0) > 1)) return plan;

  const minBase = Math.min(...BONUS_OUTCOMES.map((outcome) => plan.paybackPerOutcome[outcome]));
  const maxBase = Math.max(...BONUS_OUTCOMES.map((outcome) => plan.paybackPerOutcome[outcome]));
  let bestPlan = plan;

  for (let target = minBase + 100; target <= maxBase + 1000; target += 100) {
    let totalStakeGuess = 0;
    let bets: ContinuationCashComplementBet[] = [];

    for (let iter = 0; iter < 8; iter++) {
      bets = [];
      for (const outcome of BONUS_OUTCOMES) {
        const odds = bestOdds[outcome];
        if (!odds || odds.odds <= 1) continue;
        const required = target + totalStakeGuess - plan.paybackPerOutcome[outcome];
        if (required <= 0) continue;
        const stake = Math.ceil((required / odds.odds) / 10) * 10;
        if (stake > 0) {
          bets.push({
            outcome,
            bookmakerId: odds.bookmakerId,
            bookmaker: odds.bookmaker,
            stake,
            odds: odds.odds,
            grossReturn: stake * odds.odds,
          });
        }
      }
      const nextStake = bets.reduce((sum, bet) => sum + bet.stake, 0);
      if (Math.abs(nextStake - totalStakeGuess) < 1) break;
      totalStakeGuess = nextStake;
      if (totalStakeGuess > maxStake) break;
    }

    const complementStake = bets.reduce((sum, bet) => sum + bet.stake, 0);
    if (bets.length === 0 || complementStake > maxStake) continue;

    const candidate = evaluateContinuationPlan(
      plan.strategy,
      {
        title: plan.matchTitle,
        startTs: plan.startTs,
        league: plan.league,
        odds: {},
      },
      plan.wageringBets,
      plan.freebetBets,
      bets,
    );
    if (isBetterContinuationCandidate(candidate, bestPlan)) bestPlan = candidate;
  }

  return bestPlan;
}

export function optimizeContinuationMatch(
  match: BonusMatch,
  wageringAccounts: WageringAccount[],
  freebetVouchers: FreebetVoucher[],
  options: {
    strategy?: ContinuationPlan["strategy"];
    bestExternalOdds?: Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>>;
    /**
     * "Tappa-matched"-strategi: tvinga matched bets till ≥ wageringMinOdds.
     * Användning: när användaren vill BLI AV med matched-pengarna (förlora dem)
     * snabbare än bara köra omsättningskravet, placera på hög odds (typiskt 3.3+)
     * så förväntad förlust per runda är högre men exit blir snabbare.
     *
     * Override:ar account.minOdds upp till detta värde. Freebets påverkas EJ —
     * de använder fortfarande voucher.minOdds.
     *
     * Värdet 0 eller undefined → ingen override (standard wagering-flöde).
     */
    wageringMinOdds?: number;
  } = {},
): ContinuationResult | null {
  const activeAccounts = wageringAccounts.filter((account) => account.balance > 0 && account.wageringRemaining > 0 && match.odds[account.bookmakerId]);
  const activeFreebets = freebetVouchers.filter((voucher) => voucher.amount > 0 && match.odds[voucher.bookmakerId]);
  if (activeAccounts.length === 0 && activeFreebets.length === 0) return null;

  // Tappa-matched-override: lyft account.minOdds till den hårda gränsen om satt.
  // Detta påverkar bara filtrering här i den här funktionen — original-accounts
  // är orörda så framtida rundor är default.
  const effectiveMinOddsForAccount = (account: WageringAccount): number =>
    options.wageringMinOdds && options.wageringMinOdds > 0
      ? Math.max(account.minOdds, options.wageringMinOdds)
      : account.minOdds;

  const accountAssignments = enumerateOutcomeAssignments(activeAccounts.length);
  const candidates: ContinuationPlan[] = [];

  for (const accountAssignment of accountAssignments) {
    const wageringBets: ContinuationWageringBet[] = [];
    let valid = true;

    for (let i = 0; i < activeAccounts.length; i++) {
      const account = activeAccounts[i];
      const outcome = accountAssignment[i];
      const odds = match.odds[account.bookmakerId]?.[outcome];
      if (!odds || odds < effectiveMinOddsForAccount(account)) {
        valid = false;
        break;
      }
      wageringBets.push(buildContinuationWageringBet(account, outcome, odds));
    }
    if (!valid) continue;

    const freebetOptions = activeFreebets.map((voucher) => {
      const odds = match.odds[voucher.bookmakerId];
      const outcomes = BONUS_OUTCOMES.filter((outcome) => (odds?.[outcome] ?? 0) >= voucher.minOdds);
      return { voucher, outcomes };
    });

    const recurseFreebets = (index: number, selected: ContinuationFreebetBet[]) => {
      if (index >= freebetOptions.length) {
        let candidate = evaluateContinuationPlan(options.strategy ?? "same-match", match, wageringBets, selected);
        if (options.bestExternalOdds) {
          candidate = addContinuationCashComplements(candidate, options.bestExternalOdds);
        }
        candidates.push(candidate);
        return;
      }

      const option = freebetOptions[index];
      if (option.outcomes.length === 0) {
        recurseFreebets(index + 1, selected);
        return;
      }
      for (const outcome of option.outcomes) {
        const odds = match.odds[option.voucher.bookmakerId]?.[outcome];
        if (!odds) continue;
        selected.push(buildContinuationFreebetBet(option.voucher, outcome, odds));
        recurseFreebets(index + 1, selected);
        selected.pop();
      }
    };

    recurseFreebets(0, []);
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (isBetterContinuationCandidate(a, b) ? -1 : isBetterContinuationCandidate(b, a) ? 1 : 0));
  return {
    best: candidates[0],
    candidates: candidates.slice(0, 20),
  };
}

/** Varje aktiverad matched bonus får ett utfall (1/X/2); flera bonusar kan ligga på samma utfall (t.ex. 9 bets totalt). */
function enumerateOutcomeAssignments(count: number): Outcome[][] {
  const labels = BONUS_OUTCOMES;
  const total = 3 ** count;
  const result: Outcome[][] = [];
  for (let k = 0; k < total; k++) {
    const assignment: Outcome[] = new Array(count);
    let x = k;
    for (let i = 0; i < count; i++) {
      assignment[i] = labels[x % 3];
      x = Math.floor(x / 3);
    }
    result.push(assignment);
  }
  return result;
}

/**
 * Tillåter fördelningar som ligger inom `tolerance` steg från en jämn fördelning.
 * - tolerance = 0 låser till ungefär N/3 per utfall (3/3/3 vid N=9, {3,3,2} vid N=8)
 * - tolerance = 1 tillåter t.ex. 4/3/2, 4/2/3 vid N=9
 * - tolerance = "free" tillåter alla fördelningar som täcker alla tre utfallen
 *
 * Värsta fall för Dag 2-arbete: max(antal per utfall) konton vinner och behöver omsättas.
 */
function isWithinToleranceAssignment(
  assignment: Outcome[],
  n: number,
  tolerance: DistributionTolerance,
): boolean {
  if (n < 3) return true;
  let c1 = 0;
  let cX = 0;
  let c2 = 0;
  for (const o of assignment) {
    if (o === "1") c1++;
    else if (o === "X") cX++;
    else c2++;
  }
  if (tolerance === "free") {
    return c1 >= 1 && cX >= 1 && c2 >= 1;
  }
  const lo = Math.max(1, Math.floor(n / 3) - tolerance);
  const hi = Math.ceil(n / 3) + tolerance;
  return c1 >= lo && c1 <= hi && cX >= lo && cX <= hi && c2 >= lo && c2 <= hi;
}

export function optimizeBonusMatch(
  match: BonusMatch,
  portfolio: BonusPortfolio,
  finalMethod: OptimizationMethod = "strict-balance",
  tolerance: DistributionTolerance = DEFAULT_DISTRIBUTION_TOLERANCE,
): BonusOptimizationResult | null {
  const matchedBonuses = portfolio.matched.filter((bonus) => bonus.enabled && match.odds[bonus.id]);
  const freebetBonuses = portfolio.freebets.filter((bonus) => bonus.enabled && match.odds[bonus.id]);
  if (matchedBonuses.length === 0) return null;

  const bestByMethod: Partial<Record<OptimizationMethod, BonusOptimizationPlan>> = {};
  const methods: OptimizationMethod[] = ["strict-balance", "min-variance", "max-average", "sharpe"];

  const assignments = enumerateOutcomeAssignments(matchedBonuses.length);
  const matchedAssignmentCandidates: Array<{ matched: MatchedBetPlan[]; seed: BonusOptimizationPlan }> = [];

  for (const assignment of assignments) {
    if (!isWithinToleranceAssignment(assignment, matchedBonuses.length, tolerance)) continue;

    const matched: MatchedBetPlan[] = [];
    let valid = true;
    for (let i = 0; i < matchedBonuses.length; i++) {
      const bonus = matchedBonuses[i];
      const outcome = assignment[i];
      const odds = match.odds[bonus.id]?.[outcome];
      if (!odds || odds < bonus.minOdds) {
        valid = false;
        break;
      }
      matched.push(buildMatchedBet(bonus, outcome, odds));
    }
    if (!valid) continue;
    matchedAssignmentCandidates.push({
      matched,
      seed: evaluatePlan("strict-balance", matched, []),
    });
  }

  const matchedAssignments = matchedAssignmentCandidates
    .sort((a, b) => (isBetterCandidate(a.seed, b.seed) ? -1 : isBetterCandidate(b.seed, a.seed) ? 1 : 0))
    .slice(0, MATCHED_ASSIGNMENT_BEAM_LIMIT);

  for (const { matched } of matchedAssignments) {

    const freebetOptions = freebetBonuses.map((bonus) => {
      const odds = match.odds[bonus.id];
      const eligibleOutcomes = BONUS_OUTCOMES.filter((outcome) => (odds?.[outcome] ?? 0) >= bonus.minOdds);
      return { bonus, outcomes: eligibleOutcomes };
    });

    const recurse = (index: number, selected: FreebetPlan[]) => {
      if (index >= freebetOptions.length) {
        for (const method of methods) {
          const candidate = {
            ...evaluatePlan(method, matched, selected),
            strategy: "single-match" as const,
          };
          if (isBetterCandidate(candidate, bestByMethod[method])) bestByMethod[method] = candidate;
        }
        return;
      }

      const option = freebetOptions[index];
      if (option.outcomes.length === 0) {
        recurse(index + 1, selected);
        return;
      }
      for (const outcome of option.outcomes) {
        const odds = match.odds[option.bonus.id]?.[outcome];
        if (!odds) continue;
        selected.push(buildFreebet(option.bonus, outcome, odds));
        recurse(index + 1, selected);
        selected.pop();
      }
    };

    recurse(0, []);
  }

  if (!bestByMethod[finalMethod]) return null;
  return {
    best: bestByMethod[finalMethod]!,
    methods: bestByMethod as Record<OptimizationMethod, BonusOptimizationPlan>,
  };
}

const SPLIT_BEAM_LIMIT = 1800;

function splitScenarioKeys() {
  return BONUS_OUTCOMES.flatMap((a) => BONUS_OUTCOMES.map((b) => `${a}/${b}`));
}

function scenarioOutcomeForMatch(key: string, matchIndex: number): Outcome {
  return key.split("/")[matchIndex] as Outcome;
}

function evaluateSplitPlan(
  method: OptimizationMethod,
  matches: [BonusMatch, BonusMatch],
  matched: MatchedBetPlan[],
  freebets: FreebetPlan[],
): BonusOptimizationPlan {
  const totalMatchedStake = matched.reduce((sum, bet) => sum + bet.stake, 0);
  const totalMatchedDeposit = matched.reduce((sum, bet) => sum + bet.deposit, 0);
  const totalFreebetFaceValue = freebets.reduce((sum, bet) => sum + bet.amount, 0);
  const totalStakePlaced = totalMatchedStake + totalFreebetFaceValue;
  // Se kommentar i evaluatePlan: freebet-stake är inte kontant insats.
  const totalCashStakePlaced = totalMatchedStake;
  const keys = splitScenarioKeys();
  const scenarioAccountReturnPerOutcome = Object.fromEntries(
    keys.map((key) => {
      const matchedReturn = matched
        .filter((bet) => scenarioOutcomeForMatch(key, bet.matchIndex ?? 0) === bet.outcome)
        .reduce((sum, bet) => sum + bet.grossReturn, 0);
      const freebetReturn = freebets
        .filter((bet) => scenarioOutcomeForMatch(key, bet.matchIndex ?? 0) === bet.outcome)
        .reduce((sum, bet) => sum + bet.profitOnWin, 0);
      return [key, matchedReturn + freebetReturn];
    }),
  ) as Record<string, number>;
  const scenarioPaybackPerOutcome = Object.fromEntries(
    keys.map((key) => [key, scenarioAccountReturnPerOutcome[key] - totalCashStakePlaced]),
  ) as Record<string, number>;

  const values = keys.map((key) => scenarioPaybackPerOutcome[key]);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const varValue = variance(values);
  const std = Math.sqrt(varValue);
  const minPayback = Math.min(...values);
  const outcomeSpread = Math.max(...values) - minPayback;
  const worstCaseEdgePct = totalStakePlaced > 0 ? (minPayback / totalStakePlaced) * 100 : 0;
  const averageEdgePct = totalStakePlaced > 0 ? (avg / totalStakePlaced) * 100 : 0;
  const score =
    method === "strict-balance"
      ? avg * 1000 - std
      : method === "min-variance"
        ? -varValue + avg / 1000
        : method === "max-average"
          ? avg * 1000 - std
          : std > 0
            ? avg / std
            : avg * 1000;

  const accountReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => {
      const matchingKeys = keys.filter((key) => scenarioOutcomeForMatch(key, 0) === outcome);
      return [
        outcome,
        matchingKeys.reduce((sum, key) => sum + scenarioAccountReturnPerOutcome[key], 0) / matchingKeys.length,
      ];
    }),
  ) as Record<Outcome, number>;
  const paybackPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, accountReturnPerOutcome[outcome] - totalCashStakePlaced]),
  ) as Record<Outcome, number>;
  const stakeMinusReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, totalCashStakePlaced - accountReturnPerOutcome[outcome]]),
  ) as Record<Outcome, number>;
  const matchedDistribution = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, matched.filter((bet) => bet.outcome === outcome).length]),
  ) as Record<Outcome, number>;

  return {
    method,
    strategy: "split-match",
    splitMatches: matches.map(({ title, startTs, league }) => ({ title, startTs, league })),
    matched: matched.map((bet) => ({ ...bet })),
    freebets: freebets.map((bet) => ({ ...bet })),
    paybackPerOutcome,
    scenarioPaybackPerOutcome,
    scenarioAccountReturnPerOutcome,
    accountReturnPerOutcome,
    totalStakePlaced,
    stakeMinusReturnPerOutcome,
    minPayback,
    averagePayback: avg,
    variance: varValue,
    stdDev: std,
    outcomeSpread,
    score,
    matchedDistribution,
    totalMatchedStake,
    totalMatchedDeposit,
    totalFreebetFaceValue,
    worstCaseEdgePct,
    averageEdgePct,
  };
}

function splitPlanSortValue(state: { returns: Record<string, number>; matched: MatchedBetPlan[]; freebets: FreebetPlan[] }) {
  const totalStake =
    state.matched.reduce((sum, bet) => sum + bet.stake, 0) + state.freebets.reduce((sum, bet) => sum + bet.amount, 0);
  const values = splitScenarioKeys().map((key) => state.returns[key] - totalStake);
  const min = Math.min(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = Math.max(...values) - min;
  return min * 4 + avg - spread * 0.15;
}

function splitMatchInfo(match: BonusMatch, matchIndex: number) {
  return {
    matchIndex,
    matchTitle: match.title,
    matchStartTs: match.startTs,
    matchLeague: match.league,
  };
}

export function optimizeBonusMatchSplit(
  matches: [BonusMatch, BonusMatch],
  portfolio: BonusPortfolio,
  finalMethod: OptimizationMethod = "strict-balance",
  tolerance: DistributionTolerance = DEFAULT_DISTRIBUTION_TOLERANCE,
): BonusOptimizationResult | null {
  const matchedBonuses = portfolio.matched.filter((bonus) => bonus.enabled);
  const freebetBonuses = portfolio.freebets.filter((bonus) => bonus.enabled);
  if (matchedBonuses.length === 0) return null;

  const keys = splitScenarioKeys();
  const emptyReturns = Object.fromEntries(keys.map((key) => [key, 0])) as Record<string, number>;
  const emptyWins = Object.fromEntries(keys.map((key) => [key, 0])) as Record<string, number>;
  const maxWinners = maxWinningMatchedAccounts(matchedBonuses.length, tolerance);

  let matchedStates: Array<{
    matched: MatchedBetPlan[];
    freebets: FreebetPlan[];
    returns: Record<string, number>;
    wins: Record<string, number>;
  }> = [{ matched: [], freebets: [], returns: emptyReturns, wins: emptyWins }];

  for (const bonus of matchedBonuses) {
    const options = matches.flatMap((match, matchIndex) => {
      const odds = match.odds[bonus.id];
      if (!odds) return [] as MatchedBetPlan[];
      return BONUS_OUTCOMES
        .filter((outcome) => odds[outcome] >= bonus.minOdds)
        .map((outcome) => buildMatchedBet(bonus, outcome, odds[outcome], splitMatchInfo(match, matchIndex)));
    });
    if (options.length === 0) return null;
    const nextStates: typeof matchedStates = [];
    for (const state of matchedStates) {
      for (const option of options) {
        const returns = { ...state.returns };
        const wins = { ...state.wins };
        let valid = true;
        for (const key of keys) {
          if (scenarioOutcomeForMatch(key, option.matchIndex ?? 0) !== option.outcome) continue;
          wins[key] += 1;
          if (wins[key] > maxWinners) {
            valid = false;
            break;
          }
          returns[key] += option.grossReturn;
        }
        if (!valid) continue;
        nextStates.push({
          matched: [...state.matched, option],
          freebets: [],
          returns,
          wins,
        });
      }
    }
    matchedStates = nextStates
      .sort((a, b) => splitPlanSortValue(b) - splitPlanSortValue(a))
      .slice(0, SPLIT_BEAM_LIMIT);
    if (matchedStates.length === 0) return null;
  }

  let states = matchedStates;
  for (const bonus of freebetBonuses) {
    const options = matches.flatMap((match, matchIndex) => {
      const odds = match.odds[bonus.id];
      if (!odds) return [] as FreebetPlan[];
      return BONUS_OUTCOMES
        .filter((outcome) => odds[outcome] >= bonus.minOdds)
        .map((outcome) => buildFreebet(bonus, outcome, odds[outcome], splitMatchInfo(match, matchIndex)));
    });
    if (options.length === 0) continue;
    const nextStates: typeof states = [];
    for (const state of states) {
      for (const option of options) {
        const returns = { ...state.returns };
        for (const key of keys) {
          if (scenarioOutcomeForMatch(key, option.matchIndex ?? 0) === option.outcome) {
            returns[key] += option.profitOnWin;
          }
        }
        nextStates.push({
          ...state,
          freebets: [...state.freebets, option],
          returns,
        });
      }
    }
    states = nextStates.sort((a, b) => splitPlanSortValue(b) - splitPlanSortValue(a)).slice(0, SPLIT_BEAM_LIMIT);
  }

  const bestByMethod: Partial<Record<OptimizationMethod, BonusOptimizationPlan>> = {};
  const methods: OptimizationMethod[] = ["strict-balance", "min-variance", "max-average", "sharpe"];
  for (const state of states) {
    for (const method of methods) {
      const candidate = evaluateSplitPlan(method, matches, state.matched, state.freebets);
      if (isBetterCandidate(candidate, bestByMethod[method])) bestByMethod[method] = candidate;
    }
  }

  if (!bestByMethod[finalMethod]) return null;
  return {
    best: bestByMethod[finalMethod]!,
    methods: bestByMethod as Record<OptimizationMethod, BonusOptimizationPlan>,
  };
}

/* ===========================================================================
 * Omsättningstracking för matched-bonusar
 * ---------------------------------------------------------------------------
 * Två distinkta bonus-typer i appen:
 *
 *   MATCHED:  Pengarna måste omsättas X ggr (wagerMultiplier) innan saldot
 *             kan tas ut. Vinst på en matched-bet återger HELA insatsen + vinst
 *             (`stake * odds`). Vid förlust förlorar man hela stake (deposit + bonus).
 *             Per-bonus target: `wagerMultiplier * deposit` (= bonus-belopp × multiplier
 *             när bookmakerns bonus = depositens storlek vilket är typiskt i SE).
 *
 *   FREEBET:  Inga omsättningskrav — freebeten "förbrukas" på ett spel.
 *             Vinst = (odds − 1) × stake (BARA profit; insatsen återges aldrig).
 *             Förlust = 0 kr förlorat (inget eget kapital riskeras).
 *
 * `computeWageringProgress` aggregerar för en hel ronds-kedja vad som är omsatt
 * per bookmaker så UI:t kan visa progress-bar + status-badge.
 * =========================================================================== */

export type WageringStatus = "pending" | "in-progress" | "cleared" | "lost";

export type WageringProgress = {
  bookmakerId: BonusBookmakerId;
  bookmaker: string;
  /** Totala omsättningskravet i kronor (bonus-belopp × wagerMultiplier). */
  target: number;
  /** Hittills omsatt belopp (summerar alla matched-stakes som faktiskt placerats). */
  placed: number;
  /** Aktuellt saldo på det matched-kontot (efter senaste avgjorda rond). */
  currentBalance: number;
  /** Hur mycket som återstår innan kontot är fritt. 0 = klart. */
  remaining: number;
  /** Status-flagga för UI: "Pågår" / "Klar att ta ut" / "Förlorat". */
  status: WageringStatus;
};

/**
 * Beräknar omsättnings-progress per bookmaker för en bonus-rondskedja.
 * Itererar genom Runda 1 → fortsättningsronder och summerar `wageringContribution`
 * (faktiska placerade insatser) tills `target` är uppnådd, kontot förlorat, eller
 * vi når en runda utan resultat.
 */
export function computeWageringProgress(
  rounds: Array<{
    type: "day1" | "wagering" | "continuation";
    round: number;
    result?: Outcome;
    plan?: unknown;
    matched?: unknown[];
  }>,
  day1Plan: BonusOptimizationPlan | undefined,
  day1Result: Outcome | undefined,
): WageringProgress[] {
  if (!day1Plan) return [];
  const progressMap = new Map<BonusBookmakerId, WageringProgress>();
  for (const bet of day1Plan.matched) {
    progressMap.set(bet.bookmakerId, {
      bookmakerId: bet.bookmakerId,
      bookmaker: bet.bookmaker,
      target: bet.wagerRequired,
      placed: 0,
      currentBalance: 0,
      remaining: bet.wagerRequired,
      status: "pending",
    });
  }

  if (!day1Result) {
    return Array.from(progressMap.values()).sort((a, b) =>
      a.bookmaker.localeCompare(b.bookmaker, "sv"),
    );
  }

  // Runda 1: alla matched-bets har placerats (= wageringContribution).
  for (const bet of day1Plan.matched) {
    const p = progressMap.get(bet.bookmakerId);
    if (!p) continue;
    p.placed += bet.wageringContribution;
    if (bet.outcome === day1Result) {
      p.currentBalance = bet.grossReturn;
      p.status = p.placed >= p.target ? "cleared" : "in-progress";
    } else {
      p.currentBalance = 0;
      p.status = "lost";
    }
    p.remaining = Math.max(0, p.target - p.placed);
  }

  // Fortsättningsronder: för varje placerad wagering-bet, addera till `placed`.
  const continuationRounds = rounds
    .filter((r) => r.type === "continuation")
    .sort((a, b) => a.round - b.round);
  for (const round of continuationRounds) {
    const cplan = round.plan as ContinuationPlan | undefined;
    if (!cplan) continue;
    for (const bet of cplan.wageringBets) {
      const p = progressMap.get(bet.bookmakerId);
      if (!p || p.status === "lost") continue;
      // En insats räknas som omsatt så fort vi lägger den, oavsett resultat.
      p.placed += bet.wageringContribution;
      if (round.result) {
        if (bet.outcome === round.result) {
          p.currentBalance = bet.reserve + bet.grossReturn;
        } else {
          p.currentBalance = bet.reserve;
        }
      }
      p.remaining = Math.max(0, p.target - p.placed);
      if (p.currentBalance <= 0 && round.result) {
        p.status = "lost";
      } else if (p.placed >= p.target) {
        p.status = "cleared";
      } else {
        p.status = "in-progress";
      }
    }
  }

  return Array.from(progressMap.values()).sort((a, b) =>
    a.bookmaker.localeCompare(b.bookmaker, "sv"),
  );
}

/** Returnerar omsättningsmålet (i kronor) för en konfigurerad matched-bonus. */
export function getWageringTarget(bonus: MatchedBonus): number {
  return Math.max(0, bonus.deposit * bonus.wagerMultiplier);
}
