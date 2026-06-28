/**
 * Lay-matchning mot börs (Smarkets) — matematiken för matchad betting.
 *
 * Du BACKAR ett utfall på bookmakern (insats S, odds B) och LAYAR samma utfall
 * på börsen (odds L) som tar kommission c på lay-vinsten. Med rätt lay-insats
 * blir nettot LIKA oavsett om utfallet vinner eller förlorar → "matchat".
 *
 * Två lägen:
 *   - stakeReturned = true  (SR): vanligt bet med pengar/bonus-saldo. Insatsen
 *     kommer tillbaka vid vinst. lay-insats = (B·S) / (L − c).
 *   - stakeReturned = false (SNR): FREEBET — insatsen kommer EJ tillbaka, bara
 *     vinsten. lay-insats = ((B−1)·S) / (L − c).
 *
 * Härledning (SR): sätt backWin-netto = backLose-netto:
 *   S(B−1) − layStake(L−1) = layStake(1−c) − S   ⇒   layStake = S·B/(L−c).
 * (SNR): S(B−1) − layStake(L−1) = layStake(1−c)   ⇒   layStake = S(B−1)/(L−c).
 */

export interface LayMatchInput {
  /** Back-insats på bookmakern (kr). För freebet: freebet-beloppet. */
  backStake: number;
  /** Back-odds (decimal) på bookmakern. */
  backOdds: number;
  /** Lay-odds (decimal) på börsen. */
  layOdds: number;
  /** Börs-kommission på lay-vinst (Smarkets standard 0.02 = 2%). */
  commission?: number;
  /** true = vanligt bet (insats återbetalas). false = freebet (SNR). Default true. */
  stakeReturned?: boolean;
}

export interface LayMatchResult {
  /** Hur mycket att LAYA på börsen (kr). */
  layStake: number;
  /** Liability = det du riskerar på börsen om utfallet vinner (kr). */
  liability: number;
  /** Netto om det backade utfallet VINNER (kr). */
  profitIfBackWins: number;
  /** Netto om det backade utfallet FÖRLORAR (kr). */
  profitIfBackLoses: number;
  /**
   * Garanterad matchad nettovinst (kr) — min av de två utfallen. Vid korrekt
   * lay-insats är de praktiskt taget lika; min skyddar mot avrundning.
   */
  matchedProfit: number;
  /** matchedProfit som andel av back-insatsen (negativ = kostnad). */
  retentionPct: number;
}

const DEFAULT_COMMISSION = 0.02;

/** Lay-insats (kr) som matchar back-bettet. */
export function layStake(input: LayMatchInput): number {
  const { backStake: S, backOdds: B, layOdds: L } = input;
  const c = input.commission ?? DEFAULT_COMMISSION;
  const stakeReturned = input.stakeReturned ?? true;
  if (!(L > c)) return 0; // ogiltiga lay-odds
  const numerator = stakeReturned ? B * S : (B - 1) * S;
  return numerator / (L - c);
}

/** Full lay-matchnings-beräkning. */
export function computeLayMatch(input: LayMatchInput): LayMatchResult {
  const { backStake: S, backOdds: B, layOdds: L } = input;
  const c = input.commission ?? DEFAULT_COMMISSION;
  const stakeReturned = input.stakeReturned ?? true;

  const ls = layStake(input);
  const liability = ls * (L - 1);

  // Back vinner: bookmaker-vinst S(B−1); börsen förlorar liability.
  const profitIfBackWins = S * (B - 1) - liability;
  // Back förlorar: börs-vinst layStake·(1−c); bookmaker-förlust = insatsen
  // (SR) eller 0 (SNR/freebet, insatsen var gratis).
  const profitIfBackLoses = ls * (1 - c) - (stakeReturned ? S : 0);

  const matchedProfit = Math.min(profitIfBackWins, profitIfBackLoses);
  return {
    layStake: ls,
    liability,
    profitIfBackWins,
    profitIfBackLoses,
    matchedProfit,
    retentionPct: S > 0 ? (matchedProfit / S) * 100 : 0,
  };
}

/**
 * Avrunda lay-insats till närmaste 0.01 (börsen tillåter decimaler). Praktiskt
 * vid presentation; matchningen är robust mot små avrundningar.
 */
export function roundLayStake(value: number): number {
  return Math.round(value * 100) / 100;
}
