/**
 * CLV%-per-bet-graf. En stapel per bet (med registrerad closing line):
 *   - Grön stapel = positiv CLV (du slog stängningslinjen)
 *   - Röd stapel = negativ CLV
 * Nollinje + streckad snittlinje. Visar spridningen — hur ofta/mycket du
 * slår stängningslinjen, vilket på sikt korrelerar med vinst.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LoggedBet } from "@/lib/betLogTypes";
import { clvPct } from "@/lib/betLogCalculations";
import { useUserSettings } from "@/hooks/useUserSettings";

interface ClvPoint {
  index: number;
  match: string;
  loggedAt: string;
  clvPct: number;
  bookOdds: number;
  closing: number;
  auto: boolean;
}

export function buildClvPerBetData(bets: LoggedBet[]): ClvPoint[] {
  const sorted = [...bets].sort((a, b) =>
    (a.startTs ?? a.loggedAt).localeCompare(b.startTs ?? b.loggedAt),
  );
  const out: ClvPoint[] = [];
  let i = 0;
  for (const b of sorted) {
    const c = clvPct(b.bookOdds, b.closingFairOdds);
    if (c == null) continue;
    i += 1;
    out.push({
      index: i,
      match: b.match,
      loggedAt: b.loggedAt,
      clvPct: Number(c.toFixed(2)),
      bookOdds: b.bookOdds,
      closing: b.closingFairOdds as number,
      auto: !!b.clvAuto,
    });
  }
  return out;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

function ClvTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0]?.payload as ClvPoint | undefined;
  if (!p) return null;
  const pos = p.clvPct >= 0;
  return (
    <div className="rounded-md border border-border/80 bg-popover/95 p-3 text-xs shadow-lg backdrop-blur">
      <div className="font-semibold text-foreground">Bet #{p.index}</div>
      <div className="mt-0.5 max-w-[240px] truncate text-muted-foreground" title={p.match}>{p.match}</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{fmtDate(p.loggedAt)}</div>
      <div className="mt-2 flex items-baseline justify-between gap-4 font-mono">
        <span className="text-muted-foreground">CLV</span>
        <span className={pos ? "font-bold text-emerald-500" : "font-bold text-rose-500"}>
          {pos ? "+" : ""}{p.clvPct.toFixed(2)}%
        </span>
      </div>
      <div className="mt-1 flex justify-between gap-4 font-mono text-[10px] text-muted-foreground">
        <span>odds {p.bookOdds.toFixed(2)} vs closing {p.closing.toFixed(2)}</span>
        <span>{p.auto ? "auto" : "manuell"}</span>
      </div>
    </div>
  );
}

export function BetLogClvChart({ bets, onAddManually }: { bets: LoggedBet[]; onAddManually?: () => void }) {
  const { t } = useUserSettings();
  const data = buildClvPerBetData(bets);
  const avg = data.length ? data.reduce((s, p) => s + p.clvPct, 0) / data.length : 0;
  const beat = data.filter((p) => p.clvPct > 0).length;

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-base font-bold tracking-tight text-foreground">CLV per bet</h3>
            <p className="text-xs text-muted-foreground">
              Hur mycket du slår Pinnacles stängningslinje, per bet (%).
            </p>
          </div>
          {data.length > 0 && (
            <div className="text-right text-xs">
              <div className={avg >= 0 ? "font-bold text-emerald-500" : "font-bold text-rose-500"}>
                Snitt {avg >= 0 ? "+" : ""}{avg.toFixed(2)}%
              </div>
              <div className="text-[10px] text-muted-foreground">
                slog closing {beat}/{data.length}
              </div>
            </div>
          )}
        </div>

        {data.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border/60 px-4 py-10 text-center">
            <div className="text-sm font-semibold text-foreground">Ingen CLV registrerad än</div>
            <div className="max-w-md text-xs text-muted-foreground">
              CLV fylls automatiskt vid avspark (eller manuellt). Logga en bet och låt
              sidan vara öppen kring matchstart.
            </div>
            {onAddManually && (
              <Button size="sm" onClick={onAddManually} className="mt-1">
                <Plus className="mr-1 h-4 w-4" />
                {t("betLog.addManually")}
              </Button>
            )}
          </div>
        ) : (
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
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
                  tickFormatter={(v) => `${v}%`}
                  width={48}
                />
                <Tooltip content={<ClvTooltip />} cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.25 }} />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeOpacity={0.8} />
                <ReferenceLine y={avg} stroke="rgb(56,189,248)" strokeDasharray="4 4" strokeOpacity={0.8} />
                <Bar dataKey="clvPct" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                  {data.map((p) => (
                    <Cell key={p.index} fill={p.clvPct >= 0 ? "rgb(16,185,129)" : "rgb(244,63,94)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
