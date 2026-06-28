/**
 * Pinnacle Odds Dropper-stil dashboard-cards. 8 kompakta cards i grid,
 * responsivt: 2/4/4 kolumner (mobile/sm/lg+).
 *
 * Värdena kommer från en redan beräknad BetLogSummary (parent kallar
 * `summarizeBets` + `yieldPct`). Inga sido-effekter eller fetch här.
 */

import { Card, CardContent } from "@/components/ui/card";
import type { BetLogSummary } from "@/lib/betLogTypes";
import { useUserSettings } from "@/hooks/useUserSettings";
import { formatCurrency } from "@/lib/settings/currency";

interface BetLogStatsCardsProps {
  summary: BetLogSummary;
  /** yieldPct = totalActualProfit / totalStake. Beräknad i parent. */
  yieldPct: number | null;
}

type Tone = "neutral" | "positive" | "negative" | "accent";

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}

function toneClass(tone: Tone): string {
  if (tone === "positive") return "text-emerald-600 dark:text-emerald-400";
  if (tone === "negative") return "text-rose-600 dark:text-rose-400";
  if (tone === "accent") return "text-emerald-600 dark:text-emerald-400";
  return "text-foreground";
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function StatCard({ label, value, hint, tone = "neutral" }: StatCardProps) {
  return (
    <Card className="border-border/60 bg-card/60">
      <CardContent className="p-3 sm:p-4">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
          {label}
        </div>
        <div className={`mt-1.5 font-mono text-xl sm:text-2xl font-bold tabular-nums leading-none ${toneClass(tone)}`}>
          {value}
        </div>
        {hint && (
          <div className="mt-1.5 text-[11px] text-muted-foreground truncate" title={hint}>
            {hint}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BetLogStatsCards({ summary, yieldPct }: BetLogStatsCardsProps) {
  const { settings, t } = useUserSettings();
  const currency = settings.currency;

  const profitTone: Tone = summary.totalActualProfit > 0 ? "positive"
    : summary.totalActualProfit < 0 ? "negative" : "neutral";
  const yieldTone: Tone = yieldPct == null ? "neutral"
    : yieldPct > 0 ? "positive" : yieldPct < 0 ? "negative" : "neutral";
  const roiTone: Tone = summary.roiPct == null ? "neutral"
    : summary.roiPct > 0 ? "positive" : summary.roiPct < 0 ? "negative" : "neutral";
  const clvTone: Tone = summary.avgClvPct == null ? "neutral"
    : summary.avgClvPct > 0 ? "positive" : summary.avgClvPct < 0 ? "negative" : "neutral";

  // Helper: ersätter lokala fmtKr(). 0 decimaler för dashboard-stil (kompakta cards).
  const fmtMoney = (n: number | null | undefined, withSign = false): string =>
    formatCurrency(n, currency, { fractionDigits: 0, showSign: withSign });

  // Förenklat: 6 kärnkort (Turnover + Yield borttagna — ROI täcker avkastning).
  void yieldTone;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard
        label={t("betLog.profit")}
        value={fmtMoney(summary.totalActualProfit, true)}
        hint={`${summary.settledBets} ${t("betLog.settled")}`}
        tone={profitTone}
      />
      <StatCard
        label={t("betLog.roi")}
        value={fmtPct(summary.roiPct)}
        tone={roiTone}
      />
      <StatCard
        label={t("betLog.clv")}
        value={fmtPct(summary.avgClvPct)}
        hint={`${summary.betsWithClv}/${summary.totalBets}`}
        tone={clvTone}
      />
      <StatCard
        label={t("betLog.expectedValue")}
        value={fmtMoney(summary.totalEvKr, true)}
        hint={`${fmtPct(summary.avgEvPct)}`}
        tone="accent"
      />
      <StatCard
        label={t("betLog.hitRate")}
        value={fmtPct(summary.hitRatePct, 1)}
        hint={`${summary.wonBets} / ${summary.lostBets}`}
      />
      <StatCard
        label={t("betLog.bets")}
        value={summary.totalBets.toString()}
        hint={`${summary.openBets} ${t("betLog.open").toLowerCase()} · ${summary.settledBets} ${t("betLog.settled")}`}
      />
    </div>
  );
}
