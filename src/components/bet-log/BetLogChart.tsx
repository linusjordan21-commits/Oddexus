/**
 * Profit and Bets-chart i Pinnacle Odds Dropper-stil. Visar två kumulativa
 * serier över loggade bets:
 *   - Actual Profit (grön area + linje, settled bets bidrar)
 *   - Expected Profit (ljus tunn linje, alla bets med EV bidrar)
 *
 * X-axel: bet-nummer (1-baserat) i kronologisk ordning.
 * Y-axel: profit i kr.
 *
 * Använder befintlig `recharts` (2.15.x). Om listan är tom visas en
 * empty-state-ruta istället för chart.
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChartPoint } from "@/lib/betLogCalculations";
import { useUserSettings } from "@/hooks/useUserSettings";
import { CURRENCY_SYMBOL, formatCurrency } from "@/lib/settings/currency";
import type { CurrencyCode } from "@/lib/settings/types";

interface BetLogChartProps {
  data: ChartPoint[];
  onAddManually?: () => void;
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

/**
 * ChartTooltip stängs över `currency` så att Recharts kan rendera den utan
 * att vi behöver context inuti tooltip-renderingen. Y-axel-tickFormatter
 * gör samma sak (closure-baserad currency-aware formatering).
 */
function makeChartTooltip(currency: CurrencyCode) {
  const fmtMoney = (n: number | null | undefined): string =>
    formatCurrency(n, currency, { fractionDigits: 2, showSign: true });

  return function ChartTooltip({ active, payload }: TooltipProps<number, string>) {
    if (!active || !payload || payload.length === 0) return null;
    const point = payload[0]?.payload as ChartPoint | undefined;
    if (!point) return null;
    return (
      <div className="rounded-md border border-border/80 bg-popover/95 p-3 text-xs shadow-lg backdrop-blur">
        <div className="font-semibold text-foreground">Bet #{point.index}</div>
        <div className="mt-0.5 text-muted-foreground truncate max-w-[260px]" title={point.match}>
          {point.match}
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {fmtDate(point.loggedAt)}
        </div>
        <div className="mt-2 space-y-1 font-mono">
          <div className="flex justify-between gap-4">
            <span className="text-emerald-500">● Actual Profit</span>
            <span className={point.cumulativeActual > 0 ? "text-emerald-500" : point.cumulativeActual < 0 ? "text-rose-500" : "text-muted-foreground"}>
              {fmtMoney(point.cumulativeActual)}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-sky-400/90">○ CLV ({CURRENCY_SYMBOL[currency]})</span>
            <span className={point.cumulativeClv > 0 ? "text-sky-400" : point.cumulativeClv < 0 ? "text-rose-500" : "text-muted-foreground"}>
              {fmtMoney(point.cumulativeClv)}
            </span>
          </div>
          <div className="flex justify-between gap-4 border-t border-border/40 pt-1 text-[10px]">
            <span className="text-muted-foreground">This bet (P/L)</span>
            <span className={point.betActual > 0 ? "text-emerald-500" : point.betActual < 0 ? "text-rose-500" : "text-muted-foreground"}>
              {fmtMoney(point.betActual)}
            </span>
          </div>
          {point.betClv !== null && (
            <div className="flex justify-between gap-4 text-[10px]">
              <span className="text-muted-foreground">This bet (CLV)</span>
              <span className={point.betClv > 0 ? "text-sky-400" : point.betClv < 0 ? "text-rose-500" : "text-muted-foreground"}>
                {fmtMoney(point.betClv)}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };
}

export function BetLogChart({ data, onAddManually }: BetLogChartProps) {
  const { settings, t } = useUserSettings();
  const currency = settings.currency;
  const ChartTooltip = makeChartTooltip(currency);
  const sym = CURRENCY_SYMBOL[currency];

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-4">
          <h3 className="text-base font-bold tracking-tight text-foreground">
            {t("betLog.profitAndClv")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("betLog.profitChartHint")} ({sym})
          </p>
        </div>

        {data.length === 0 ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/60 px-4 py-10 text-center">
            <div className="text-sm font-semibold text-foreground">
              {t("betLog.noSettledYet")}
            </div>
            <div className="max-w-md text-xs text-muted-foreground">
              {t("betLog.noSettledHint")}
            </div>
          </div>
        ) : (
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(16,185,129)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="rgb(16,185,129)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  strokeOpacity={0.4}
                  vertical={false}
                />
                <XAxis
                  dataKey="index"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))", strokeOpacity: 0.5 }}
                  tickFormatter={(v) => `#${v}`}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: "hsl(var(--border))", strokeOpacity: 0.5 }}
                  tickFormatter={(v) => `${v} ${sym}`}
                  width={70}
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend
                  iconType="circle"
                  wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
                />
                <Area
                  type="monotone"
                  dataKey="cumulativeActual"
                  name="Actual Profit"
                  stroke="rgb(16,185,129)"
                  strokeWidth={2}
                  fill="url(#actualFill)"
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="cumulativeClv"
                  name={`CLV (${sym})`}
                  stroke="rgb(56,189,248)"
                  strokeWidth={1.75}
                  strokeDasharray="4 4"
                  strokeOpacity={0.9}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
