import { DEFAULT_BONUS_PORTFOLIO, type BonusPortfolio } from "@/lib/bonusOptimizer";

export const BONUS_PORTFOLIO_STORAGE_KEY = "bonus-optimizer-portfolio";

function normalizePortfolio(value: Partial<BonusPortfolio> | null | undefined): BonusPortfolio {
  return {
    matched: DEFAULT_BONUS_PORTFOLIO.matched.map((defaultBonus) => {
      const saved = value?.matched?.find((bonus) => bonus.id === defaultBonus.id);
      return { ...defaultBonus, ...saved };
    }),
    freebets: DEFAULT_BONUS_PORTFOLIO.freebets.map((defaultBonus) => {
      const saved = value?.freebets?.find((bonus) => bonus.id === defaultBonus.id);
      return { ...defaultBonus, ...saved };
    }),
  };
}

export function loadBonusPortfolio(): BonusPortfolio {
  if (typeof window === "undefined") return DEFAULT_BONUS_PORTFOLIO;
  try {
    const raw = window.localStorage.getItem(BONUS_PORTFOLIO_STORAGE_KEY);
    if (!raw) return DEFAULT_BONUS_PORTFOLIO;
    return normalizePortfolio(JSON.parse(raw) as Partial<BonusPortfolio>);
  } catch {
    return DEFAULT_BONUS_PORTFOLIO;
  }
}

export function saveBonusPortfolio(portfolio: BonusPortfolio) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(BONUS_PORTFOLIO_STORAGE_KEY, JSON.stringify(portfolio));
}
