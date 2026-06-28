export type Outcome = '1' | 'X' | '2';

export const OUTCOMES: Outcome[] = ['1', 'X', '2'];

export type OutcomeOdds = Record<Outcome, number>;
export type OutcomeProfits = Record<Outcome, number>;

export function calcEqualizedLayPlan(profits: OutcomeProfits, exchangeOdds: OutcomeOdds) {
  const minProfit = Math.min(...OUTCOMES.map((outcome) => profits[outcome]));

  const layStakes: OutcomeOdds = { '1': 0, 'X': 0, '2': 0 };
  const liabilities: OutcomeOdds = { '1': 0, 'X': 0, '2': 0 };

  OUTCOMES.forEach((outcome) => {
    const odds = exchangeOdds[outcome];
    const profitGap = profits[outcome] - minProfit;

    if (odds > 0 && profitGap > 0) {
      const stake = profitGap / odds;
      layStakes[outcome] = stake;
      liabilities[outcome] = stake * (odds - 1);
    }
  });

  const totalLayStake = OUTCOMES.reduce((sum, outcome) => sum + layStakes[outcome], 0);
  const equalProfit = minProfit + totalLayStake;

  const verifiedProfits: OutcomeProfits = { '1': 0, 'X': 0, '2': 0 };
  OUTCOMES.forEach((outcome) => {
    verifiedProfits[outcome] = profits[outcome] - layStakes[outcome] * exchangeOdds[outcome] + totalLayStake;
  });

  return {
    layStakes,
    liabilities,
    equalProfit,
    verifiedProfits,
  };
}
