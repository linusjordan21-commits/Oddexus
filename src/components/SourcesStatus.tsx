import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useUserSettings } from "@/hooks/useUserSettings";

/**
 * Source health card — pollar /api/sources/status var 30:e sekund och visar
 * en kompakt tabell över alla odds-/signal-källor med:
 *   - Rows, Updated age, Fetch interval, Stale threshold, Status
 * Färgkodad status så stale workflows blir omedelbart synliga.
 */

type SourceType =
  | "sharp"
  | "foreign_bookmaker"
  | "foreign_bookmaker_shared"
  | "foreign_bookmaker_group"
  | "external_drop_signal"
  | "on_demand";
type SourceStatus =
  | "active"
  | "empty"
  | "blocked"
  | "error"
  | "stale"
  | "not_configured"
  | "on_demand"
  | "unknown";

interface SourceEntry {
  id: string;
  name: string;
  type: SourceType;
  status: SourceStatus;
  /** Människo-läsbar förklaring till status (visas i expanderad rad). */
  reason?: string;
  /** Coverage-klass — hur fullständigt täcker källan sina events? */
  coverageLevel?: "full" | "partial" | "limited" | "unknown";
  /** Förklaring av coverage-strategin (visas i expanderad rad). */
  coverageReason?: string;
  /** Svensk-fokus-prioritet (high/medium/low/none). */
  swedishPriority?: "high" | "medium" | "low" | "none";
  /** Andra svenska källor med IDENTISKA odds (samma sportsbook-backend). */
  sharedOddsWith?: string[];
  /** Plattforms-grupp (samma odds-backend). Brands i samma grupp delar odds. */
  group?: string;
  /** Alla bookmaker-brands i samma grupp (delar odds-backend). */
  groupBrands?: string[];
  /** Senast uppmätt Pinnacle-coverage (%). */
  matchCoveragePct?: number;
  /** Vilken array vi räknade från: rows / events / byFranchise / signals / initial-empty / unknown. */
  dataShape?: "rows" | "events" | "byFranchise" | "signals" | "initial-empty" | "unknown";
  ageSeconds: number | null;
  updatedAt: string | null;
  rowCount: number;
  /** Antal events specifikt (för shapes där det är den semantiska enheten). */
  events?: number;
  source?: string | null;
  blocked?: boolean;
  lastError?: string | null;
  /** Runtime-partiell: senaste körningen avbröts av hard-deadline (reducerad
   *  täckning just nu) — skilt från den statiska coverageLevel. */
  partial?: boolean;
  workflow?: string;
  cron?: string;
  fetchIntervalSeconds?: number;
  staleAfterSeconds: number;
  backendCacheTtlSeconds: number;
  maxPossibleAgeSeconds?: number;
  note: string;
  warnings: string[];
  footballMoneylineCount?: number;
}

interface SourcesPayload {
  ok: boolean;
  generatedAt: string;
  summary?: {
    total: number;
    active: number;
    stale: number;
    empty: number;
    blocked: number;
    error: number;
    not_configured?: number;
    on_demand?: number;
  };
  sources: SourceEntry[];
}

const REFRESH_MS = 30_000;

function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function fmtInterval(sec: number | undefined): string {
  if (sec == null) return "—";
  if (sec < 3600) return `~${sec / 60} min`;
  return `~${(sec / 3600).toFixed(1)} h`;
}

// Distinkta gruppfärger. UNDVIKER grönt/orange/gult (status-färgerna active/partial)
// och rött (stale/error) — så grupp-färg aldrig förväxlas med status. Tilldelas i tur
// och ordning per grupp (se buildGroupColorMap) så två grupper aldrig får samma färg.
// row = hela radens bakgrundston, bar = vänsterkant, chip = grupp-etikett.
type GroupColor = { row: string; border: string; chip: string };
const GROUP_COLORS: GroupColor[] = [
  { row: "bg-blue-500/15",    border: "border-blue-400",    chip: "border-blue-400/50 bg-blue-500/25 text-blue-100" },
  { row: "bg-fuchsia-500/15", border: "border-fuchsia-400", chip: "border-fuchsia-400/50 bg-fuchsia-500/25 text-fuchsia-100" },
  { row: "bg-cyan-500/15",    border: "border-cyan-400",    chip: "border-cyan-400/50 bg-cyan-500/25 text-cyan-100" },
  { row: "bg-violet-500/15",  border: "border-violet-400",  chip: "border-violet-400/50 bg-violet-500/25 text-violet-100" },
  { row: "bg-pink-500/15",    border: "border-pink-400",    chip: "border-pink-400/50 bg-pink-500/25 text-pink-100" },
  { row: "bg-sky-500/15",     border: "border-sky-400",     chip: "border-sky-400/50 bg-sky-500/25 text-sky-100" },
  { row: "bg-indigo-500/15",  border: "border-indigo-400",  chip: "border-indigo-400/50 bg-indigo-500/25 text-indigo-100" },
  { row: "bg-rose-500/15",    border: "border-rose-400",    chip: "border-rose-400/50 bg-rose-500/25 text-rose-100" },
  { row: "bg-purple-500/15",  border: "border-purple-400",  chip: "border-purple-400/50 bg-purple-500/25 text-purple-100" },
  { row: "bg-teal-500/15",    border: "border-teal-400",    chip: "border-teal-400/50 bg-teal-500/25 text-teal-100" },
  { row: "bg-slate-300/15",   border: "border-slate-200",   chip: "border-slate-300/50 bg-slate-300/25 text-slate-100" }, // "vit"
  { row: "bg-zinc-600/25",    border: "border-zinc-400",    chip: "border-zinc-400/50 bg-zinc-600/40 text-zinc-100" },    // "svart/grå"
  { row: "bg-stone-400/15",   border: "border-stone-300",   chip: "border-stone-300/50 bg-stone-400/25 text-stone-100" },
  { row: "bg-blue-300/15",    border: "border-blue-200",    chip: "border-blue-200/50 bg-blue-300/25 text-blue-50" },     // ljusblå
  { row: "bg-purple-300/15",  border: "border-purple-200",  chip: "border-purple-200/50 bg-purple-300/25 text-purple-50" }, // ljuslila
  { row: "bg-cyan-700/20",    border: "border-cyan-600",    chip: "border-cyan-600/50 bg-cyan-700/30 text-cyan-100" },    // mörk cyan
  { row: "bg-fuchsia-700/20", border: "border-fuchsia-600", chip: "border-fuchsia-600/50 bg-fuchsia-700/30 text-fuchsia-100" }, // mörk magenta
  { row: "bg-indigo-300/15",  border: "border-indigo-200",  chip: "border-indigo-200/50 bg-indigo-300/25 text-indigo-50" }, // ljus indigo
  { row: "bg-rose-300/15",    border: "border-rose-200",    chip: "border-rose-200/50 bg-rose-300/25 text-rose-50" },     // ljusrosa
];
const GROUP_FALLBACK: GroupColor = { row: "", border: "border-muted-foreground", chip: "border-muted-foreground/40 bg-muted/40 text-muted-foreground" };
// Tilldela distinkta färger per grupp i den ordning grupperna dyker upp (sorterad lista)
// → kollisionsfritt upp till palettens längd.
function buildGroupColorMap(groupsInOrder: string[]): Map<string, GroupColor> {
  const map = new Map<string, GroupColor>();
  let i = 0;
  for (const g of groupsInOrder) {
    if (map.has(g)) continue;
    map.set(g, GROUP_COLORS[i % GROUP_COLORS.length]);
    i += 1;
  }
  return map;
}
// Snyggare grupp-etikett (kambi → Kambi, paf-brand → Paf, spectate888 → 888/Spectate).
const GROUP_LABELS: Record<string, string> = {
  kambi: "Kambi", comeon: "ComeOn", betsson: "Betsson", altenar: "Altenar",
  "paf-brand": "Paf", vbet: "VBET", coolbet: "Coolbet", svenskaspel: "Svenska Spel",
  spectate888: "888 (Spectate)", prontosport: "ProntoSport", tipwin: "Tipwin",
  tenbet: "10bet", unsupported: "Ej stödd",
};
function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group.charAt(0).toUpperCase() + group.slice(1);
}

function typeLabel(type: SourceType): string {
  switch (type) {
    case "sharp": return "Sharp";
    case "foreign_bookmaker": return "Bookmaker";
    case "foreign_bookmaker_shared": return "Bookmaker (shared)";
    case "foreign_bookmaker_group": return "Bookmaker (group)";
    case "external_drop_signal": return "Drop signal";
    case "on_demand": return "On-demand";
  }
}

function statusBadgeVariant(status: SourceStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "on_demand": return "secondary"; // egen blå/lila-styling via className
    case "empty": return "secondary";
    case "stale": return "outline";
    case "not_configured": return "outline";
    case "blocked":
    case "error": return "destructive";
    default: return "outline";
  }
}

/** Extra className för badge: on_demand får blå, not_configured grå. */
function statusBadgeClass(status: SourceStatus): string {
  switch (status) {
    case "on_demand":
      return "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300";
    case "not_configured":
      return "border-muted-foreground/40 bg-muted/40 text-muted-foreground";
    default:
      return "";
  }
}

function statusDotClass(status: SourceStatus): string {
  switch (status) {
    case "active": return "bg-emerald-500";
    case "on_demand": return "bg-sky-500";
    case "empty": return "bg-amber-500";
    case "stale": return "bg-amber-500";
    case "not_configured": return "bg-muted-foreground";
    case "blocked":
    case "error": return "bg-red-500";
    default: return "bg-muted-foreground";
  }
}

function statusLabel(s: SourceStatus, t: (key: string) => string): string {
  switch (s) {
    case "active": return t("home.sourcesActive");
    case "empty": return t("home.sourcesEmpty");
    case "blocked": return t("home.sourcesBlocked");
    case "error": return t("home.sourcesError");
    case "stale": return t("home.sourcesStale");
    case "on_demand": return t("home.sourcesOnDemand");
    case "not_configured": return t("home.sourcesNotConfigured");
    default: return s;
  }
}

export function SourcesStatus() {
  const { t } = useUserSettings();
  const [data, setData] = useState<SourcesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchStatus = useCallback(async (silent: boolean) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await fetch("/api/sources/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SourcesPayload;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus(true);
    const id = window.setInterval(() => {
      void fetchStatus(true);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [fetchStatus]);

  const labels = useMemo(
    () => ({
      title: t("home.sourcesTitle"),
      subtitle: t("home.sourcesSubtitle"),
      loading: t("home.sourcesLoading"),
      noData: t("home.sourcesNoData"),
      refresh: t("home.sourcesRefresh"),
      colSource: t("home.sourcesColSource"),
      colType: t("home.sourcesColType"),
      colRows: t("home.sourcesColRows"),
      colUpdated: t("home.sourcesColUpdated"),
      colInterval: t("home.sourcesColInterval"),
      colStaleAfter: t("home.sourcesColStaleAfter"),
      colStatus: t("home.sourcesColStatus"),
    }),
    [t],
  );

  // Gruppera efter plattforms-grupp så brands med SAMMA odds hamnar bredvid varandra
  // (när en blir stale blir oftast hela gruppen det). Sharp-källor (Pinnacle m.fl.)
  // först som referens; därefter klustras allt per grupp, sorterat på namn inom gruppen.
  const ordered = useMemo(() => {
    if (!data?.sources) return [];
    const keyOf = (s: SourceEntry) => {
      const sharp = s.type === "sharp" ? "0" : "1";
      const g = s.group ?? s.id;
      return `${sharp}|${g}|${s.name}`;
    };
    return [...data.sources].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }, [data]);

  // Distinkt färg per grupp, tilldelad i sorterad ordning (kollisionsfritt).
  const groupColors = useMemo(
    () => buildGroupColorMap(ordered.map((s) => s.group ?? s.id)),
    [ordered],
  );

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold">{labels.title}</div>
            <div className="mt-1 text-xs text-muted-foreground">{labels.subtitle}</div>
            {data?.summary && (
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="text-emerald-600">{data.summary.active} active</span>
                {(data.summary.on_demand ?? 0) > 0 && (
                  <span className="text-sky-600">{data.summary.on_demand} on-demand</span>
                )}
                {data.summary.stale > 0 && <span className="text-amber-600">{data.summary.stale} stale</span>}
                {data.summary.empty > 0 && <span className="text-amber-600">{data.summary.empty} empty</span>}
                {(data.summary.not_configured ?? 0) > 0 && (
                  <span className="text-muted-foreground">{data.summary.not_configured} not configured</span>
                )}
                {data.summary.blocked > 0 && <span className="text-red-600">{data.summary.blocked} blocked</span>}
                {data.summary.error > 0 && <span className="text-red-600">{data.summary.error} error</span>}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void fetchStatus(false)}
            disabled={refreshing}
            className="flex h-8 items-center gap-1.5 rounded-md border bg-background/60 px-2.5 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            aria-label={labels.refresh}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            <span>{labels.refresh}</span>
          </button>
        </div>

        {loading && !data ? (
          <div className="mt-4 text-xs text-muted-foreground">{labels.loading}</div>
        ) : error && !data ? (
          <div className="mt-4 text-xs text-red-500">{error}</div>
        ) : !data ? (
          <div className="mt-4 text-xs text-muted-foreground">{labels.noData}</div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">{labels.colSource}</th>
                  <th className="pb-2 pr-3 font-medium">{labels.colType}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{labels.colRows}</th>
                  <th className="pb-2 pr-3 font-medium">{labels.colUpdated}</th>
                  <th className="pb-2 pr-3 font-medium">{labels.colInterval}</th>
                  <th className="pb-2 pr-3 font-medium">{labels.colStaleAfter}</th>
                  <th className="pb-2 pr-3 font-medium">{labels.colStatus}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {ordered.map((s) => {
                  const expanded = expandedId === s.id;
                  const g = s.group ?? s.id;
                  const color = groupColors.get(g) ?? GROUP_FALLBACK;
                  return (
                    <>
                      <tr
                        key={s.id}
                        className={`cursor-pointer ${color.row} hover:brightness-125`}
                        onClick={() => setExpandedId(expanded ? null : s.id)}
                      >
                        {/* Vänster färgkant = gruppens färg (hela raden tonas också i color.row). */}
                        <td className={`py-2 pr-3 border-l-4 ${color.border}`}>
                          <div className="flex items-center gap-2 pl-1">
                            <span
                              className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass(s.status)}`}
                              aria-hidden
                            />
                            <span className="font-medium">{s.name}</span>
                            <span
                              className={`shrink-0 rounded border px-1 text-[9px] font-medium ${color.chip}`}
                              title={`Grupp: ${groupLabel(g)} — samma färg = samma odds`}
                            >
                              {groupLabel(g)}
                            </span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{typeLabel(s.type)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {s.type === "on_demand"
                            ? <span className="italic text-muted-foreground/80">{t("home.sourcesPerMatch")}</span>
                            : s.rowCount.toLocaleString()}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                          {s.type === "on_demand"
                            ? <span className="italic">{t("home.sourcesOnRequest")}</span>
                            : fmtAge(s.ageSeconds)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                          {s.type === "on_demand"
                            ? <span className="italic">{t("home.sourcesIntervalOnDemand")}</span>
                            : fmtInterval(s.fetchIntervalSeconds)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                          {s.type === "on_demand"
                            ? <span className="italic">{t("home.sourcesStaleNa")}</span>
                            : fmtAge(s.staleAfterSeconds)}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge
                              variant={statusBadgeVariant(s.status)}
                              className={`text-[10px] ${statusBadgeClass(s.status)}`}
                            >
                              {statusLabel(s.status, t)}
                            </Badge>
                            {s.coverageLevel && s.coverageLevel !== "full" && (
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${
                                  s.coverageLevel === "partial"
                                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                    : s.coverageLevel === "limited"
                                      ? "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300"
                                      : "border-muted-foreground/40 bg-muted/30 text-muted-foreground"
                                }`}
                                title={s.coverageReason ?? ""}
                              >
                                {s.coverageLevel}
                              </Badge>
                            )}
                            {s.partial && (
                              <Badge
                                variant="outline"
                                className="text-[10px] border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                title={t("home.sourcesPartialRunHint")}
                              >
                                {t("home.sourcesPartialRun")}
                              </Badge>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${s.id}-detail`} className="bg-muted/10">
                          <td colSpan={7} className="px-2 py-3">
                            <div className="space-y-1 text-[11px] text-muted-foreground">
                              {s.reason && (
                                <div className="rounded-md border border-sky-500/20 bg-sky-500/5 px-2 py-1.5 text-foreground">
                                  <span className="font-medium">{t("home.sourcesReason")}:</span> {s.reason}
                                </div>
                              )}
                              {s.coverageLevel && s.coverageLevel !== "full" && s.coverageReason && (
                                <div className={`rounded-md border px-2 py-1.5 ${
                                  s.coverageLevel === "partial"
                                    ? "border-amber-500/30 bg-amber-500/5 text-foreground"
                                    : s.coverageLevel === "limited"
                                      ? "border-orange-500/30 bg-orange-500/5 text-foreground"
                                      : "border-muted-foreground/30 bg-muted/30 text-muted-foreground"
                                }`}>
                                  <span className="font-medium">Coverage:</span>{" "}
                                  <code className="rounded bg-background/60 px-1 text-[10px]">{s.coverageLevel}</code>{" "}
                                  — {s.coverageReason}
                                </div>
                              )}
                              {(s.matchCoveragePct != null || (s.sharedOddsWith && s.sharedOddsWith.length > 0)) && (
                                <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-foreground">
                                  {s.matchCoveragePct != null && (
                                    <>
                                      <span className="font-medium">Pinnacle match:</span>{" "}
                                      <code className="rounded bg-background/60 px-1 text-[10px]">{s.matchCoveragePct}%</code>
                                    </>
                                  )}
                                  {s.sharedOddsWith && s.sharedOddsWith.length > 0 && (
                                    <>
                                      {s.matchCoveragePct != null && <span className="text-muted-foreground"> · </span>}
                                      <span className="font-medium">Shared odds with:</span>{" "}
                                      <code className="text-[10px]">{s.sharedOddsWith.join(", ")}</code>
                                    </>
                                  )}
                                </div>
                              )}
                              {s.type === "on_demand" && (
                                <div className="text-[10px] italic text-muted-foreground">
                                  {t("home.sourcesOnDemandExplainer")}
                                </div>
                              )}
                              {s.workflow && (
                                <div>
                                  <span className="font-medium text-foreground">workflow:</span>{" "}
                                  <code>{s.workflow}</code>
                                  {s.cron && (
                                    <>
                                      {" · "}
                                      <span className="font-medium text-foreground">cron:</span>{" "}
                                      <code>{s.cron}</code>
                                    </>
                                  )}
                                </div>
                              )}
                              {s.updatedAt && (
                                <div>
                                  <span className="font-medium text-foreground">updatedAt:</span>{" "}
                                  <code>{s.updatedAt}</code>
                                </div>
                              )}
                              <div>
                                <span className="font-medium text-foreground">backend cache TTL:</span>{" "}
                                {s.backendCacheTtlSeconds}s
                                {s.maxPossibleAgeSeconds != null && (
                                  <>
                                    {" · "}
                                    <span className="font-medium text-foreground">max possible age:</span>{" "}
                                    {fmtAge(s.maxPossibleAgeSeconds)}
                                  </>
                                )}
                              </div>
                              {s.footballMoneylineCount != null && (
                                <div>
                                  <span className="font-medium text-foreground">football moneyline rows:</span>{" "}
                                  {s.footballMoneylineCount.toLocaleString()}
                                </div>
                              )}
                              <div className="text-[10px] italic">{s.note}</div>
                              {s.warnings.length > 0 && (
                                <div className="pt-1">
                                  <span className="font-medium text-amber-600">warnings:</span>{" "}
                                  {s.warnings.map((w, i) => (
                                    <code key={i} className="mr-1 rounded bg-amber-500/10 px-1 text-amber-700">
                                      {w}
                                    </code>
                                  ))}
                                </div>
                              )}
                              {s.lastError && (
                                <div className="pt-1 text-red-500">
                                  <span className="font-medium">lastError:</span> {s.lastError}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
