/**
 * "Value Adjusted % Bankroll" — staking-modell för valuebets.
 *
 * Rekommenderad insats räknas ut från (1) användarens aktuella bankroll och
 * (2) bettets edge i PROCENT (samma skala som `evPct` i valuebet-objektet, dvs
 * 5 = 5 %). Insatsen trappas upp i tiers efter edge, men aldrig över 2,5 % av
 * bankroll. Formel: recommendedStake = bankroll * stakePercentage (avrundat till
 * närmaste hela krona/valutaenhet).
 */

export type StakingStatus = "Bet" | "No bet" | "Invalid bankroll";

export interface ValueAdjustedStakeResult {
  stakingModel: "Value Adjusted % Bankroll";
  /** Bankroll som användes (0 om ogiltig). */
  bankroll: number;
  /** Edge i procent (t.ex. 5 = 5 %). */
  edge: number;
  /** Andel av bankroll som FRAKTION (0.005 = 0,5 %). recommendedStake = bankroll * stakePercentage. */
  stakePercentage: number;
  /** bankroll * stakePercentage, avrundat till närmaste hela enhet. */
  recommendedStake: number;
  riskLevel: string;
  status: StakingStatus;
}

const MODEL_NAME = "Value Adjusted % Bankroll" as const;

/** Hård tak: insatsen får ALDRIG överstiga 2,5 % av bankroll. */
export const MAX_STAKE_FRACTION = 0.025;

/**
 * Tiers efter edge (procent). Övre gräns är exklusiv (`edge < hiExclusive`).
 * Sorterad stigande; sista tiern (Extreme) har inget tak.
 */
const TIERS: ReadonlyArray<{ minEdge: number; fraction: number; risk: string }> = [
  { minEdge: 15, fraction: 0.025, risk: "Extreme" },
  { minEdge: 10, fraction: 0.02, risk: "Very High" },
  { minEdge: 6, fraction: 0.015, risk: "High" },
  { minEdge: 3, fraction: 0.01, risk: "Medium" },
  { minEdge: 1, fraction: 0.005, risk: "Low" },
];

/**
 * Beräknar rekommenderad insats enligt "Value Adjusted % Bankroll".
 *
 * @param bankroll Aktuell bankroll (samma valuta som appen visar).
 * @param edge     Bettets edge i PROCENT (5 = 5 %).
 */
export function computeValueAdjustedStake(
  bankroll: number,
  edge: number,
): ValueAdjustedStakeResult {
  const safeEdge = Number.isFinite(edge) ? edge : 0;

  // Ogiltig bankroll → inget förslag.
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    return {
      stakingModel: MODEL_NAME,
      bankroll: 0,
      edge: safeEdge,
      stakePercentage: 0,
      recommendedStake: 0,
      riskLevel: "No bet",
      status: "Invalid bankroll",
    };
  }

  // Edge under 1 % → aldrig något stakeförslag.
  if (safeEdge < 1) {
    return {
      stakingModel: MODEL_NAME,
      bankroll,
      edge: safeEdge,
      stakePercentage: 0,
      recommendedStake: 0,
      riskLevel: "No bet",
      status: "No bet",
    };
  }

  // Hitta matchande tier (högsta minEdge som edge når upp till).
  const tier = TIERS.find((tt) => safeEdge >= tt.minEdge) ?? TIERS[TIERS.length - 1];

  // Säkerhetstak: aldrig över 2,5 % (tiers håller redan detta, men var explicit).
  const stakePercentage = Math.min(tier.fraction, MAX_STAKE_FRACTION);
  const recommendedStake = Math.round(bankroll * stakePercentage);

  return {
    stakingModel: MODEL_NAME,
    bankroll,
    edge: safeEdge,
    stakePercentage,
    recommendedStake,
    riskLevel: tier.risk,
    status: "Bet",
  };
}
