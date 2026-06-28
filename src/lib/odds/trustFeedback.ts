/**
 * trustFeedback.ts — översätter CLV-statistik till REKOMMENDATIONER om
 * trust per cell. INGA automatiska ändringar görs i sourceTrustConfig.ts;
 * detta producerar bara förslag som en människa granskar.
 *
 *   UPGRADE_CANDIDATE   — cellen visar bevisat positiv CLV → kandidat för
 *                         högre trust / att slås på från shadow till live.
 *   DOWNGRADE_CANDIDATE — negativ CLV eller hög false-positive → sänk trust.
 *   KEEP_SHADOW         — neutralt; fortsätt mäta i shadow mode.
 *   INSUFFICIENT_DATA   — för få settled samples för att uttala sig.
 */

import type { CellStats } from "./clvAnalysis.ts";

export type TrustRecommendation =
  | "UPGRADE_CANDIDATE"
  | "DOWNGRADE_CANDIDATE"
  | "KEEP_SHADOW"
  | "INSUFFICIENT_DATA";

export interface TrustFeedbackConfig {
  /** Minsta antal settled samples innan en rekommendation ges. */
  minSettledSamples: number;
  /** avgCLV(%) över detta + bra hit/fp → UPGRADE-kandidat. */
  upgradeAvgClvPct: number;
  upgradeMinHitRate: number;
  upgradeMaxFalsePositiveRate: number;
  /** avgCLV(%) under detta ELLER dålig hit/fp → DOWNGRADE-kandidat. */
  downgradeAvgClvPct: number;
  downgradeMaxHitRate: number;
  downgradeMinFalsePositiveRate: number;
}

/** Konservativa startvärden — hellre KEEP_SHADOW än för tidig uppgradering. */
export const DEFAULT_TRUST_FEEDBACK_CONFIG: TrustFeedbackConfig = {
  minSettledSamples: 100,
  upgradeAvgClvPct: 1.0,
  upgradeMinHitRate: 0.55,
  upgradeMaxFalsePositiveRate: 0.45,
  downgradeAvgClvPct: -0.5,
  downgradeMaxHitRate: 0.45,
  downgradeMinFalsePositiveRate: 0.55,
};

export interface TrustFeedbackItem {
  cell: string;
  recommendation: TrustRecommendation;
  reasons: string[];
  stats: Pick<CellStats, "settledSamples" | "avgClvPct" | "medianClvPct" | "hitRate" | "falsePositiveRate" | "valueFlagged">;
}

/** Bedöm EN cell (pure). */
export function recommendForCell(
  stats: CellStats,
  config: TrustFeedbackConfig = DEFAULT_TRUST_FEEDBACK_CONFIG,
): TrustFeedbackItem {
  const reasons: string[] = [];
  const snap = {
    settledSamples: stats.settledSamples,
    avgClvPct: stats.avgClvPct,
    medianClvPct: stats.medianClvPct,
    hitRate: stats.hitRate,
    falsePositiveRate: stats.falsePositiveRate,
    valueFlagged: stats.valueFlagged,
  };

  if (stats.settledSamples < config.minSettledSamples || stats.avgClvPct == null) {
    reasons.push(`endast ${stats.settledSamples} settled (kräver ${config.minSettledSamples})`);
    return { cell: stats.cell, recommendation: "INSUFFICIENT_DATA", reasons, stats: snap };
  }

  const hit = stats.hitRate ?? 0;
  const fp = stats.falsePositiveRate ?? 1;

  // DOWNGRADE har företräde (snabb nedgradering — hellre missa än falskt).
  const downgrade =
    stats.avgClvPct <= config.downgradeAvgClvPct ||
    hit < config.downgradeMaxHitRate ||
    fp >= config.downgradeMinFalsePositiveRate;
  if (downgrade) {
    if (stats.avgClvPct <= config.downgradeAvgClvPct) reasons.push(`avgCLV ${stats.avgClvPct.toFixed(2)}% ≤ ${config.downgradeAvgClvPct}%`);
    if (hit < config.downgradeMaxHitRate) reasons.push(`hitRate ${(hit * 100).toFixed(0)}% < ${config.downgradeMaxHitRate * 100}%`);
    if (fp >= config.downgradeMinFalsePositiveRate) reasons.push(`falsePositive ${(fp * 100).toFixed(0)}% ≥ ${config.downgradeMinFalsePositiveRate * 100}%`);
    return { cell: stats.cell, recommendation: "DOWNGRADE_CANDIDATE", reasons, stats: snap };
  }

  const upgrade =
    stats.avgClvPct >= config.upgradeAvgClvPct &&
    hit >= config.upgradeMinHitRate &&
    fp <= config.upgradeMaxFalsePositiveRate;
  if (upgrade) {
    reasons.push(`avgCLV ${stats.avgClvPct.toFixed(2)}% ≥ ${config.upgradeAvgClvPct}%`);
    reasons.push(`hitRate ${(hit * 100).toFixed(0)}% ≥ ${config.upgradeMinHitRate * 100}%`);
    reasons.push(`falsePositive ${(fp * 100).toFixed(0)}% ≤ ${config.upgradeMaxFalsePositiveRate * 100}%`);
    return { cell: stats.cell, recommendation: "UPGRADE_CANDIDATE", reasons, stats: snap };
  }

  reasons.push("inom neutrala gränser — fortsätt mäta");
  return { cell: stats.cell, recommendation: "KEEP_SHADOW", reasons, stats: snap };
}

/** Bedöm alla celler i en stats-map (t.ex. perSource). Sorteras: down→up→keep. */
export function recommendTrustChanges(
  statsByCell: Record<string, CellStats>,
  config: TrustFeedbackConfig = DEFAULT_TRUST_FEEDBACK_CONFIG,
): TrustFeedbackItem[] {
  const order: Record<TrustRecommendation, number> = {
    DOWNGRADE_CANDIDATE: 0,
    UPGRADE_CANDIDATE: 1,
    KEEP_SHADOW: 2,
    INSUFFICIENT_DATA: 3,
  };
  return Object.values(statsByCell)
    .map((s) => recommendForCell(s, config))
    .sort((a, b) => order[a.recommendation] - order[b.recommendation]);
}
