/**
 * OddsDrops — Pinnacle Odds Dropper-sida i Oddexus.
 *
 * Följer hela Pinnacle-marknaden (via /api/odds/pinnacle-normalized) och
 * detekterar sharp drops över rullande tidsfönster (5/30 min). Localstorage-
 * baserad historik — samlar bara när sidan är öppen.
 *
 * UI:
 *   - Status-bar: snapshots samlade, källa, ålder, sample-count
 *   - Filter: sport, market, threshold, time window
 *   - Tabell: sorterad största drops först, med sparkline per rad
 *   - In-page toast vid nya drops (via sonner)
 *   - Empty state: "Samlar snapshots — drops visas efter några intervall"
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw, TrendingDown, Trash2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BrandHeader } from "@/components/BrandHeader";
import { usePinnacleHistory } from "@/hooks/usePinnacleHistory";
import { detectDrops, buildSparkline } from "@/lib/oddsHistory/detector";
import { DEFAULT_DROP_THRESHOLD_PCT, type DropSignal } from "@/lib/oddsHistory/types";
import { useUserSettings } from "@/hooks/useUserSettings";

const WINDOW_OPTIONS = [5, 15, 30, 60] as const;

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s sedan`;
  if (sec < 3600) return `${Math.round(sec / 60)} min sedan`;
  return `${Math.round(sec / 3600)} h sedan`;
}

function formatStart(iso: string): string {
  try {
    return new Date(iso).toLocaleString("sv-SE", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Selection-label byggs runtime via injicerad `tFn` så att språkbytet i
 * Settings propagerar direkt. Internal market/selection-koder är oförändrade.
 */
function buildSelectionLabel(
  market: DropSignal["market"],
  selection: DropSignal["selection"],
  line: number | null,
  tFn: (key: import("@/lib/settings/i18n").TranslationKey) => string,
): string {
  if (market === "moneyline") {
    if (selection === "home") return tFn("outcome.homeWithCode");
    if (selection === "draw") return tFn("outcome.drawWithCode");
    if (selection === "away") return tFn("outcome.awayWithCode");
  }
  if (market === "total") {
    return `${selection === "over" ? tFn("common.over") : tFn("common.under")} ${line ?? ""}`;
  }
  if (market === "spread") {
    const sign = line != null && line > 0 ? "+" : "";
    const sideLabel = selection === "home" ? tFn("outcome.home") : tFn("outcome.away");
    return `${sideLabel} ${sign}${line ?? ""}`;
  }
  return selection;
}

function marketLabel(market: DropSignal["market"]): string {
  if (market === "moneyline") return "1X2";
  if (market === "total") return "O/U";
  return "AH";
}

/** Mini-sparkline som SVG. Enkelt — ingen recharts behövs här eftersom
 *  det är väldigt få punkter och vi vill ha kompakt rendering per rad. */
function Sparkline({ points }: { points: Array<{ ts: number; odds: number }> }) {
  if (points.length < 2) {
    return <span className="text-[10px] text-muted-foreground">—</span>;
  }
  const width = 80;
  const height = 24;
  const oddsValues = points.map((p) => p.odds);
  const minOdds = Math.min(...oddsValues);
  const maxOdds = Math.max(...oddsValues);
  const range = maxOdds - minOdds || 1;
  const stepX = width / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((p.odds - minOdds) / range) * height;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  // Trend: negativ = drop = rött (= vad vi vill highlighta)
  const trendDown = points[points.length - 1].odds < points[0].odds;
  const stroke = trendDown ? "rgb(244,63,94)" : "rgb(16,185,129)";
  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={path} stroke={stroke} strokeWidth={1.5} fill="none" />
      <circle cx={width} cy={height - ((points[points.length - 1].odds - minOdds) / range) * height} r={2} fill={stroke} />
    </svg>
  );
}

export default function OddsDrops() {
  const { t } = useUserSettings();
  const state = usePinnacleHistory();
  const [windowMinutes, setWindowMinutes] = useState<number>(5);
  const [thresholdPct, setThresholdPct] = useState<number>(DEFAULT_DROP_THRESHOLD_PCT);
  const [sportFilter, setSportFilter] = useState<string>("all");
  const [marketFilter, setMarketFilter] = useState<"all" | "moneyline" | "total" | "spread">("all");
  // Source-filter: Pinnacle / All (Football.com borttagen).
  const [sourceFilter, setSourceFilter] = useState<"all" | "pinnacle">("all");

  // Beräkna drops varje gång history ändras
  const drops = useMemo<DropSignal[]>(() => {
    return detectDrops(state.history, {
      windowMinutes,
      thresholdPct,
      dropsOnly: true,
      minSamples: 2,
    });
  }, [state.history, windowMinutes, thresholdPct]);

  // Filter
  const filteredDrops = useMemo(() => {
    return drops.filter((d) => {
      if (sportFilter !== "all" && d.sport !== sportFilter) return false;
      if (marketFilter !== "all" && d.market !== marketFilter) return false;
      return true;
    });
  }, [drops, sportFilter, marketFilter]);

  // Lista av tillgängliga sporter (från history)
  const availableSports = useMemo(() => {
    const set = new Set<string>();
    for (const entry of state.history.values()) set.add(entry.sport);
    return [...set].sort();
  }, [state.history]);

  // Toast vid nya drops (jämför mellan renders)
  const previousKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentKeys = new Set(filteredDrops.map((d) => `${d.key}::${d.detectedAt}`));
    const newDrops = filteredDrops.filter((d) => !previousKeysRef.current.has(`${d.key}::${d.detectedAt}`));
    // Bara toasta när vi har historik (inte vid första render som har snapshotCount 0 → 1)
    if (state.snapshotCount > 1 && previousKeysRef.current.size > 0) {
      for (const d of newDrops.slice(0, 3)) {
        toast(`Drop: ${d.match}`, {
          description: `${marketLabel(d.market)} ${buildSelectionLabel(d.market, d.selection, d.line, t)} · ${d.previousOdds.toFixed(2)} → ${d.currentOdds.toFixed(2)} (${d.changePct.toFixed(2)} %)`,
          duration: 6000,
        });
      }
    }
    previousKeysRef.current = currentKeys;
  }, [filteredDrops, state.snapshotCount]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <BrandHeader className="mb-4" />
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-1 h-4 w-4" />
                {t("common.back")}
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <TrendingDown className="h-6 w-6 text-rose-500" />
                {t("oddsDrops.title")}
              </h1>
              <p className="text-xs text-muted-foreground">{t("oddsDrops.subtitle")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={state.refresh} disabled={state.isLoading}>
              <RefreshCw className={`mr-1 h-4 w-4 ${state.isLoading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t("oddsDrops.clearHistory") + "?")) {
                  state.clear();
                }
              }}
              title={t("oddsDrops.clearHistory")}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              {t("oddsDrops.clearHistory")}
            </Button>
          </div>
        </div>

        {/* Status-bar */}
        <Card className="mb-4 border-border/60">
          <CardContent className="p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div>
              <span className="text-muted-foreground">{t("oddsDrops.source")}: </span>
              <Badge variant="secondary" className="text-[10px] font-mono">
                {state.sourceMeta.source}
              </Badge>
            </div>
            <div>
              <span className="text-muted-foreground">{t("common.lastUpdated")}: </span>
              <span className="font-mono">{formatRelative(state.sourceMeta.updatedAt)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t("oddsDrops.lastSnapshot")}: </span>
              <span className="font-mono font-semibold">{state.sourceMeta.rowCount}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t("oddsDrops.snapshots")}: </span>
              <span className="font-mono font-semibold">{state.snapshotCount}</span>
            </div>
            {state.error && (
              <div className="flex items-center gap-1 text-rose-500">
                <AlertCircle className="h-3 w-3" />
                <span>{state.error}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Filter */}
        <Card className="mb-4">
          <CardContent className="p-4 flex flex-wrap items-end gap-3">
            <div>
              <Label className="text-xs">{t("oddsDrops.window")}</Label>
              <Select value={String(windowMinutes)} onValueChange={(v) => setWindowMinutes(Number(v))}>
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WINDOW_OPTIONS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("oddsDrops.threshold")} (%)</Label>
              <Input
                type="number"
                step="0.1"
                value={thresholdPct}
                onChange={(e) => setThresholdPct(Number(e.target.value) || 0)}
                className="h-9 w-24"
              />
            </div>
            <div>
              <Label className="text-xs">{t("oddsDrops.sport")}</Label>
              <Select value={sportFilter} onValueChange={setSportFilter}>
                <SelectTrigger className="h-9 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("common.all")}</SelectItem>
                  {availableSports.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("oddsDrops.market")}</Label>
              <Select
                value={marketFilter}
                onValueChange={(v) => setMarketFilter(v as typeof marketFilter)}
              >
                <SelectTrigger className="h-9 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("common.all")}</SelectItem>
                  <SelectItem value="moneyline">1X2</SelectItem>
                  <SelectItem value="total">O/U</SelectItem>
                  <SelectItem value="spread">AH</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("oddsDrops.source")}</Label>
              <Select
                value={sourceFilter}
                onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}
              >
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("common.all")}</SelectItem>
                  <SelectItem value="pinnacle">Pinnacle</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto text-xs text-muted-foreground self-end">
              <span className="font-semibold text-foreground">{filteredDrops.length}</span> · &gt; {thresholdPct} % · {windowMinutes} min
            </div>
          </CardContent>
        </Card>

        {/* === PINNACLE-SEKTIONEN ===
            Visas när sourceFilter är "all" eller "pinnacle". Detta är vår
            EGNA drop-detection (browser-side snapshot history). */}

        {(sourceFilter === "all" || sourceFilter === "pinnacle") && (
          <>
            <div className="mb-2 flex items-baseline gap-2">
              <Badge className="bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40">
                Pinnacle
              </Badge>
              <span className="text-xs text-muted-foreground">{filteredDrops.length} drops</span>
            </div>

            {/* Empty state */}
            {state.snapshotCount < 2 && state.history.size === 0 && (
              <Card className="mb-4">
                <CardContent className="p-8 text-center">
                  <RefreshCw className="mx-auto mb-3 h-8 w-8 text-muted-foreground animate-spin" />
                  <div className="text-sm font-semibold">{t("oddsDrops.noDropsYet")}</div>
                  <p className="mt-1 text-xs text-muted-foreground max-w-md mx-auto">
                    {t("oddsDrops.collectingSnapshots")}
                  </p>
                </CardContent>
              </Card>
            )}

            {state.snapshotCount >= 2 && filteredDrops.length === 0 && state.history.size > 0 && (
              <Card className="mb-4">
                <CardContent className="p-6 text-center text-sm text-muted-foreground">
                  {t("oddsDrops.noDropsYet")} (&gt; {thresholdPct} %, {windowMinutes} min)
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Tabell */}
        {(sourceFilter === "all" || sourceFilter === "pinnacle") && filteredDrops.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border/60 mb-6">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">{t("valuebets.match")}</th>
                  <th className="px-3 py-2 text-left font-semibold">{t("valuebets.time")}</th>
                  <th className="px-3 py-2 text-left font-semibold">{t("oddsDrops.market")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("oddsDrops.oldOdds")}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("oddsDrops.newOdds")}</th>
                  <th className="px-3 py-2 text-right font-semibold">Δ %</th>
                  <th className="px-3 py-2 text-center font-semibold">—</th>
                  <th className="px-3 py-2 text-right font-semibold">{t("oddsDrops.snapshots")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filteredDrops.slice(0, 200).map((d) => {
                  const entry = state.history.get(d.key);
                  const spark = entry ? buildSparkline(entry, 20) : [];
                  const startMs = Date.parse(d.startTime);
                  const startsIn = Number.isFinite(startMs) ? startMs - Date.now() : NaN;
                  const isLive = startsIn < 0;
                  return (
                    <tr key={d.key} className="hover:bg-muted/20">
                      <td className="px-3 py-2">
                        <div className="font-medium truncate max-w-[280px]" title={d.match}>{d.match}</div>
                        <div className="text-[10px] text-muted-foreground truncate max-w-[280px]">
                          {d.league ?? "—"} · {d.sport}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div className={isLive ? "text-rose-500 font-semibold" : "text-muted-foreground"}>
                          {isLive ? "LIVE" : formatStart(d.startTime)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatRelative(d.detectedAt)}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-[10px] font-mono mr-1">{marketLabel(d.market)}</Badge>
                        <span className="text-xs">{buildSelectionLabel(d.market, d.selection, d.line, t)}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                        {d.previousOdds.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums font-bold">
                        {d.currentOdds.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-rose-600 dark:text-rose-400">
                        {d.changePct.toFixed(2)} %
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Sparkline points={spark} />
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
                        {d.sampleCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredDrops.length > 200 && (
              <div className="bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Showing 200 of {filteredDrops.length} drops (sorted by biggest first).
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
