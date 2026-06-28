import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronUp, Info, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BrandHeader } from "@/components/BrandHeader";
import { BONUS_BOOKMAKER_NAMES, type BonusBookmakerId } from "@/lib/bonusOptimizer";

/**
 * Bonus Finder — generisk admin-sida för att analysera oddsdata.
 *
 * Två routes pekar in hit:
 *   - /bonus-finder?bookmaker=unibet     (primär — visad från Home)
 *   - /bonus/:bookmaker                  (legacy — backward compat)
 *
 * Sidan har en bookmaker-dropdown så admin kan byta utan att lämna sidan.
 * Vid byte: URL uppdateras till /bonus-finder?bookmaker=<slug> (replace),
 * och tabellen hämtar nya odds från /api/bonus-finder/:slug.
 *
 * UI:
 *   - input-formulär (stake, min/max odds, hours, exclude)
 *   - sorterad tabell med opportunities (lägst worst-case loss först)
 *   - expanderbar detaljvy per rad
 *   - tydliga disclaimers (ingen garanti)
 */

interface HedgeLeg {
  outcome: "home" | "draw" | "away";
  bookmakerId: string;
  bookmaker: string;
  odds: number;
  stake: number;
  grossReturn: number;
}

interface PinnacleComparison {
  pinnacleOdds: number;
  pinnacleFairOdds: number;
  pinnacleFairProb: number;
  edge: number;
  pinnacleEdgePct: number;
}

type MarketType = "1X2" | "ML2";

interface BonusOpportunity {
  id: string;
  matchTitle: string;
  startTs?: string;
  league?: string;
  sport: string;
  marketType: MarketType;
  bonusOutcome: "home" | "draw" | "away";
  bonusOutcomeLabel: string;
  bonusBookmaker: string;
  bonusBookmakerId: string;
  bonusOdds: number;
  bonusStake: number;
  bonusGrossReturn: number;
  hedgeLegs: HedgeLeg[];
  totalStake: number;
  totalHedgeStake: number;
  worstCasePnl: number;
  worstCasePnlPct: number;
  /** Pengar-retur i % i sämsta fall (100% = allt tillbaka, >100% = arbitrage). */
  moneyReturnPct: number;
  /** True om all täckning ligger på Pinnacle/Smarkets (uttagbar sida). */
  coversOnSharp: boolean;
  bestCasePnl: number;
  averagePnl: number;
  pinnacle?: PinnacleComparison;
  hedgeBookmakerCount: number;
}

interface BonusFinderDebug {
  matchesLoaded: number;
  hoursAhead: number;
  requestedBookmakerId: string;
  requestedBookmakerName: string;
  rowsPerBookmaker: Record<string, number>;
}

interface BonusFinderResult {
  ok: boolean;
  bonusBookmakerId: string;
  bonusBookmaker: string;
  stake: number;
  matchesScanned: number;
  matchesWithBonusBookmaker: number;
  opportunitiesFound: number;
  opportunities: BonusOpportunity[];
  disclaimer: string;
  error?: string;
  diag?: {
    bonusOutcomesInRange: number;
    dutchNull: number;
    produced: number;
    coverMissing: { home: number; draw: number; away: number };
    matchesMultiBook: number;
    avgBooksPerMatch: number;
  };
  _debug?: BonusFinderDebug;
}

/**
 * Bookmaker-val i dropdown. Slug måste matcha BONUS_FINDER_BOOKMAKER_MAP i
 * src/server/bonusFinder.ts — annars returnerar /api/bonus-finder 404.
 *
 * Ordning: svenska huvudsajter först, sedan övriga i alfabetisk ordning.
 */
const BOOKMAKER_OPTIONS: ReadonlyArray<{ slug: string; label: string }> = (
  Object.entries(BONUS_BOOKMAKER_NAMES) as Array<[BonusBookmakerId, string]>
)
  // Endast bookmakers du faktiskt har bonus på (samma som i Bonus Optimizer).
  // Utländska/cover-only källor (Pinnacle, Smarkets samt Altenar-brands som
  // Lucky/Quick/HappyCasino/Betinia) går ENBART att MATCHA mot — inte välja som
  // bonus-sida, eftersom de inte har några bonusar.
  .map(([id, label]) => ({ slug: id, label }));

const DEFAULT_SLUG = "unibet";

/** Visningsnamn för cover-källor som inte finns i BONUS_BOOKMAKER_NAMES. */
const COVER_LABEL_EXTRA: Record<string, string> = {
  pinnacle: "Pinnacle",
  ps3838: "Pinnacle",
  smarkets: "Smarkets",
  betfair: "Betfair",
  matchbook: "Matchbook",
  lucky: "Lucky",
  quick: "Quick",
  happycasino: "Happy Casino",
  betinia: "Betinia",
  betsafe: "Betsafe",
  nordicbet: "NordicBet",
  bet365: "Bet365",
};

/** Sharp/exchange-källor visas först (vassast + uttagbar täckning). */
const SHARP_COVER_IDS = new Set(["pinnacle", "ps3838", "smarkets", "betfair", "matchbook"]);

function coverLabel(id: string): string {
  return (
    (BONUS_BOOKMAKER_NAMES as Record<string, string>)[id] ??
    COVER_LABEL_EXTRA[id] ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}

function fmtCurrency(n: number): string {
  return `${n.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} kr`;
}

function fmtSignedCurrency(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toLocaleString("sv-SE", { maximumFractionDigits: 0 })} kr`;
}

function fmtOdds(n: number): string {
  return n.toFixed(2);
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtStartTime(ts?: string): string {
  if (!ts) return "—";
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return d.toLocaleString("sv-SE", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function BonusFinder() {
  // Stöd både /bonus/:bookmaker (legacy) och /bonus-finder?bookmaker=xxx.
  // URL-param vinner om båda finns; annars query; annars default.
  const params = useParams<{ bookmaker?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const urlSlug = (params.bookmaker ?? searchParams.get("bookmaker") ?? DEFAULT_SLUG).toLowerCase();
  const isLegacyRoute = Boolean(params.bookmaker);

  // Normalisera mot listan (om någon skickar in okänd slug → default unibet).
  const initialSlug = useMemo(() => {
    const known = BOOKMAKER_OPTIONS.find((b) => b.slug === urlSlug);
    return known ? known.slug : DEFAULT_SLUG;
  }, [urlSlug]);

  const [slug, setSlug] = useState(initialSlug);

  // Håll state synkad om URL ändras externt (t.ex. browser back/forward).
  useEffect(() => {
    setSlug(initialSlug);
  }, [initialSlug]);

  const selectedOption = useMemo(
    () => BOOKMAKER_OPTIONS.find((b) => b.slug === slug) ?? BOOKMAKER_OPTIONS[0],
    [slug],
  );

  const [stake, setStake] = useState("500");
  const [minOdds, setMinOdds] = useState("1.5");
  const [maxOdds, setMaxOdds] = useState("");
  const [hours, setHours] = useState("48");
  const [excludeIds, setExcludeIds] = useState("");
  const [limit, setLimit] = useState("20");
  // Cover-bookmakers att matcha MOT. Tom = alla (default bästa odds). Satt =
  // täckningen byggs ENBART från dessa bookmakers.
  const [coverIds, setCoverIds] = useState<string[]>([]);
  const coverKey = coverIds.join(",");

  const [data, setData] = useState<BonusFinderResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleBookmakerChange = useCallback(
    (newSlug: string) => {
      setSlug(newSlug);
      // Legacy /bonus/:bookmaker → navigera över till nya canonical URL:n.
      // Annars uppdatera bara query-stringen (replace för att inte spamma historiken).
      if (isLegacyRoute) {
        navigate(`/bonus-finder?bookmaker=${newSlug}`, { replace: false });
      } else {
        setSearchParams({ bookmaker: newSlug }, { replace: true });
      }
    },
    [isLegacyRoute, navigate, setSearchParams],
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        stake: String(Number(stake) || 500),
        minOdds: String(Number(minOdds) || 1.5),
        hours: String(Number(hours) || 48),
        limit: String(Number(limit) || 20),
      });
      if (maxOdds) qs.set("maxOdds", String(Number(maxOdds)));
      if (excludeIds.trim()) qs.set("exclude", excludeIds.trim());
      if (coverIds.length > 0) qs.set("covers", coverIds.join(","));
      const res = await fetch(`/api/bonus-finder/${slug}?${qs.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 403) {
        setError("Du måste vara admin för att använda Bonus Finder.");
        setData(null);
        return;
      }
      if (!res.ok) {
        const body = await res.text();
        setError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        setData(null);
        return;
      }
      const json = (await res.json()) as BonusFinderResult;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug, stake, minOdds, maxOdds, hours, excludeIds, limit, coverIds]);

  // Reload när bookmaker ELLER cover-val ändras. Övriga fält (stake/odds/timmar)
  // triggar inte auto-reload — admin klickar "Sök" manuellt efter justering.
  useEffect(() => {
    void fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, coverKey]);

  // Tillgängliga cover-bookmakers härleds ur senaste svaret (alla källor med
  // rader i indexet, minus bonus-bookmakern). Sharp/exchange visas först.
  const coverOptions = useMemo(() => {
    const rows = data?._debug?.rowsPerBookmaker ?? {};
    return Object.keys(rows)
      .filter((id) => id !== slug)
      .sort((a, b) => {
        const aSharp = SHARP_COVER_IDS.has(a) ? 0 : 1;
        const bSharp = SHARP_COVER_IDS.has(b) ? 0 : 1;
        if (aSharp !== bSharp) return aSharp - bSharp;
        return coverLabel(a).localeCompare(coverLabel(b), "sv");
      });
  }, [data, slug]);

  const toggleCover = useCallback((id: string) => {
    setCoverIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-7xl px-3 py-6 sm:px-4 md:px-6">
        <BrandHeader className="mb-4" />

        <div className="mb-4">
          <h1 className="text-2xl font-bold tracking-tight">Outis</h1>
        </div>

        {/* Bookmaker-väljare + inputs */}
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="mb-3">
              <Label htmlFor="bookmaker" className="text-xs">Bookmaker med bonus</Label>
              <Select value={slug} onValueChange={handleBookmakerChange}>
                <SelectTrigger id="bookmaker" className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOOKMAKER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.slug} value={opt.slug}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Cover-väljare: vilka bookmakers ska täckningen byggas av? */}
            <div className="mb-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Matcha mot (täckning)</Label>
                {coverIds.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">{coverIds.length} valda</span>
                )}
              </div>
              <p className="mb-1.5 text-[10px] text-muted-foreground">
                Tom = alla källor (bästa odds per utfall). Välj en eller flera för att bygga täckningen
                ENBART från dem (t.ex. bara Pinnacle).
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setCoverIds([])}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    coverIds.length === 0
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                  }`}
                >
                  Alla
                </button>
                {coverOptions.map((id) => {
                  const active = coverIds.includes(id);
                  const sharp = SHARP_COVER_IDS.has(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleCover(id)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        active
                          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : sharp
                            ? "border-sky-500/40 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                            : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                      }`}
                      title={sharp ? "Sharp/exchange — uttagbar täckning" : undefined}
                    >
                      {coverLabel(id)}
                    </button>
                  );
                })}
                {coverOptions.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    Källor visas när odds laddats…
                  </span>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-6">
              <div>
                <Label htmlFor="stake" className="text-xs">Stake (kr)</Label>
                <Input
                  id="stake"
                  type="number"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor="minOdds" className="text-xs">Min odds</Label>
                <Input
                  id="minOdds"
                  type="number"
                  step="0.01"
                  value={minOdds}
                  onChange={(e) => setMinOdds(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor="maxOdds" className="text-xs">Max odds (valfritt)</Label>
                <Input
                  id="maxOdds"
                  type="number"
                  step="0.01"
                  value={maxOdds}
                  onChange={(e) => setMaxOdds(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor="hours" className="text-xs">Timmar framåt</Label>
                <Select value={hours} onValueChange={setHours}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24">24 h</SelectItem>
                    <SelectItem value="48">48 h</SelectItem>
                    <SelectItem value="72">72 h</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="limit" className="text-xs">Visa max</Label>
                <Input
                  id="limit"
                  type="number"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="flex items-end">
                <Button onClick={() => void fetchData()} disabled={loading} className="h-9 w-full">
                  <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  {loading ? "Hämtar…" : "Sök"}
                </Button>
              </div>
            </div>
            <div className="mt-3">
              <Label htmlFor="exclude" className="text-xs">Exkludera bookmakers (kommaseparerade ids, valfritt)</Label>
              <Input
                id="exclude"
                placeholder="t.ex. betsson,vbet"
                value={excludeIds}
                onChange={(e) => setExcludeIds(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
          </CardContent>
        </Card>

        {/* Error */}
        {error && (
          <Card className="mb-4 border-red-500/40 bg-red-500/[0.05]">
            <CardContent className="p-4 text-sm text-red-600 dark:text-red-300">{error}</CardContent>
          </Card>
        )}

        {/* Summary */}
        {data && (
          <Card className="mb-4">
            <CardContent className="flex flex-wrap items-center gap-3 p-4 text-xs">
              <Badge variant="outline">Bonusbookmaker: {data.bonusBookmaker}</Badge>
              {coverIds.length > 0 && (
                <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  Täckning endast: {coverIds.map(coverLabel).join(", ")}
                </Badge>
              )}
              <span className="text-muted-foreground">Matcher: <strong className="text-foreground">{data.matchesScanned}</strong></span>
              <span className="text-muted-foreground">{data.bonusBookmaker} har odds: <strong className="text-foreground">{data.matchesWithBonusBookmaker}</strong></span>
              <span className="text-muted-foreground">Möjligheter: <strong className="text-foreground">{data.opportunitiesFound}</strong></span>
              {data.matchesWithBonusBookmaker === 0 && (
                <Badge variant="destructive" className="text-[10px]">Inga odds från {data.bonusBookmaker}</Badge>
              )}
            </CardContent>
          </Card>
        )}

        {/* Debug-panel — visas när 0 matcher har bookmakerens odds. Hjälper
          * admin att förstå om problemet är empty index vs missing rows för
          * just den valda bookmakeren. */}
        {data && data.matchesWithBonusBookmaker === 0 && data._debug && (
          <Card className="mb-4 border-sky-500/30 bg-sky-500/[0.04]">
            <CardContent className="p-4 text-xs">
              <div className="mb-2 font-semibold">Debug — varför 0 odds?</div>
              <div className="mb-2 text-muted-foreground">
                Indexet har {data._debug.matchesLoaded} matcher laddade ({data._debug.hoursAhead}h fönster).
                Antal matcher med odds per bookmaker:
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
                {Object.entries(data._debug.rowsPerBookmaker)
                  .sort(([, a], [, b]) => b - a)
                  .map(([bookmakerId, count]) => (
                    <div
                      key={bookmakerId}
                      className={`flex justify-between font-mono ${
                        bookmakerId === data._debug?.requestedBookmakerId
                          ? "text-amber-600 dark:text-amber-300"
                          : "text-muted-foreground"
                      }`}
                    >
                      <span>{bookmakerId}</span>
                      <span>{count}</span>
                    </div>
                  ))}
                {Object.keys(data._debug.rowsPerBookmaker).length === 0 && (
                  <div className="col-span-full text-red-600 dark:text-red-300">
                    Indexet är tomt. Workflow-pipelines har inte producerat någon data ännu, eller bonus-odds-indexet har inte hunnit prewarmas.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Opportunities-tabell */}
        {data && data.opportunities.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-6"></TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead>Tid</TableHead>
                      <TableHead>Bet</TableHead>
                      <TableHead className="text-right">{data.bonusBookmaker} odds</TableHead>
                      <TableHead className="text-right">Total stake</TableHead>
                      <TableHead className="text-right">Pengar-retur</TableHead>
                      <TableHead className="text-right">Worst-case</TableHead>
                      <TableHead className="text-right">Loss %</TableHead>
                      <TableHead className="text-right">Best-case</TableHead>
                      <TableHead className="text-right">Pinnacle</TableHead>
                      <TableHead className="text-right">Edge</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.opportunities.map((opp, idx) => {
                      const isExpanded = expandedId === opp.id;
                      const isBest = idx === 0;
                      const isPinnacleBest =
                        opp.pinnacle && data.opportunities.every((o) => !o.pinnacle || o.pinnacle.edge <= opp.pinnacle!.edge);
                      const pnlColor = opp.worstCasePnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : opp.worstCasePnlPct >= -2
                          ? "text-foreground"
                          : "text-red-600 dark:text-red-400";
                      return (
                        <>
                          <TableRow
                            key={opp.id}
                            className="cursor-pointer hover:bg-muted/30"
                            onClick={() => setExpandedId(isExpanded ? null : opp.id)}
                          >
                            <TableCell className="px-2">
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </TableCell>
                            <TableCell className="max-w-[280px]">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate font-medium">{opp.matchTitle}</span>
                                {opp.marketType === "ML2" && (
                                  <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300 text-[9px]">
                                    2-vägs
                                  </Badge>
                                )}
                                {isBest && <Badge variant="default" className="text-[9px]">lägst förlust</Badge>}
                                {opp.coversOnSharp && (
                                  <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[9px]">
                                    täckning Pinnacle/Smarkets
                                  </Badge>
                                )}
                                {isPinnacleBest && opp.pinnacle && (
                                  <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300 text-[9px]">
                                    bäst mot Pinnacle
                                  </Badge>
                                )}
                              </div>
                              {opp.league && <div className="text-[10px] text-muted-foreground">{opp.league}</div>}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{fmtStartTime(opp.startTs)}</TableCell>
                            <TableCell className="text-xs font-medium">{opp.bonusOutcomeLabel}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{fmtOdds(opp.bonusOdds)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{fmtCurrency(opp.totalStake)}</TableCell>
                            <TableCell
                              className={`text-right font-mono text-xs font-semibold ${
                                opp.moneyReturnPct >= 100
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : opp.moneyReturnPct >= 98
                                    ? "text-foreground"
                                    : "text-red-600 dark:text-red-400"
                              }`}
                              title="Andel av allt du satsat som kommer tillbaka i sämsta fall. 100% = allt åter, >100% = arbitrage."
                            >
                              {opp.moneyReturnPct.toFixed(1)}%
                            </TableCell>
                            <TableCell className={`text-right font-mono text-xs ${pnlColor}`}>
                              {fmtSignedCurrency(opp.worstCasePnl)}
                            </TableCell>
                            <TableCell className={`text-right font-mono text-xs ${pnlColor}`}>
                              {fmtPct(opp.worstCasePnlPct)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">
                              {fmtSignedCurrency(opp.bestCasePnl)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {opp.pinnacle ? fmtOdds(opp.pinnacle.pinnacleOdds) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {opp.pinnacle ? (
                                <span className={opp.pinnacle.edge > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                                  {fmtPct(opp.pinnacle.pinnacleEdgePct)}
                                </span>
                              ) : "—"}
                            </TableCell>
                          </TableRow>
                          {isExpanded && (
                            <TableRow className="bg-muted/20">
                              <TableCell colSpan={12} className="p-4">
                                <div className="space-y-3 text-xs">
                                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    <div>
                                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Bonus-bet</div>
                                      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] p-2">
                                        <div className="flex justify-between">
                                          <span>{opp.bonusBookmaker} på <strong>{opp.bonusOutcomeLabel}</strong></span>
                                          <span className="font-mono">@ {fmtOdds(opp.bonusOdds)}</span>
                                        </div>
                                        <div className="mt-1 flex justify-between text-muted-foreground">
                                          <span>Stake</span>
                                          <span className="font-mono">{fmtCurrency(opp.bonusStake)}</span>
                                        </div>
                                        <div className="flex justify-between text-muted-foreground">
                                          <span>Return vid vinst</span>
                                          <span className="font-mono">{fmtCurrency(opp.bonusGrossReturn)}</span>
                                        </div>
                                      </div>
                                    </div>
                                    <div>
                                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Hedge-bets ({opp.hedgeBookmakerCount} bookmakers)</div>
                                      <div className="space-y-1.5">
                                        {opp.hedgeLegs.map((leg, i) => (
                                          <div key={i} className="rounded-md border border-sky-500/30 bg-sky-500/[0.04] p-2">
                                            <div className="flex justify-between">
                                              <span>{leg.bookmaker} på <strong>{leg.outcome === "home" ? "Hemma" : leg.outcome === "draw" ? "Oavgjort" : "Borta"}</strong></span>
                                              <span className="font-mono">@ {fmtOdds(leg.odds)}</span>
                                            </div>
                                            <div className="mt-1 flex justify-between text-muted-foreground">
                                              <span>Stake</span>
                                              <span className="font-mono">{fmtCurrency(leg.stake)}</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>

                                  <div>
                                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Resultat per utfall</div>
                                    {/* 2-vägs marknader (tennis, hockey moneyline) har bara home/away. */}
                                    <div className={opp.marketType === "ML2" ? "grid grid-cols-2 gap-2" : "grid grid-cols-3 gap-2"}>
                                      {(opp.marketType === "ML2" ? (["home", "away"] as const) : (["home", "draw", "away"] as const)).map((o) => {
                                        // Räkna ut P&L för detta utfall från legs+bonus
                                        let totalReturn = 0;
                                        if (o === opp.bonusOutcome) totalReturn += opp.bonusGrossReturn;
                                        for (const leg of opp.hedgeLegs) {
                                          if (leg.outcome === o) totalReturn += leg.grossReturn;
                                        }
                                        const pnl = totalReturn - opp.totalStake;
                                        const color = pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
                                        return (
                                          <div key={o} className="rounded-md border bg-background/40 p-2">
                                            <div className="text-[10px] text-muted-foreground">{o === "home" ? "Hemma vinner" : o === "draw" ? "Oavgjort" : "Borta vinner"}</div>
                                            <div className={`mt-1 font-mono text-sm font-semibold ${color}`}>{fmtSignedCurrency(pnl)}</div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>

                                  {opp.pinnacle && (
                                    <div>
                                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pinnacle-referens på {opp.bonusOutcomeLabel}</div>
                                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        <div className="rounded border bg-background/40 p-2">
                                          <div className="text-[10px] text-muted-foreground">Pinnacle odds</div>
                                          <div className="font-mono">{fmtOdds(opp.pinnacle.pinnacleOdds)}</div>
                                        </div>
                                        <div className="rounded border bg-background/40 p-2">
                                          <div className="text-[10px] text-muted-foreground">Fair odds (no-vig)</div>
                                          <div className="font-mono">{fmtOdds(opp.pinnacle.pinnacleFairOdds)}</div>
                                        </div>
                                        <div className="rounded border bg-background/40 p-2">
                                          <div className="text-[10px] text-muted-foreground">Implied prob</div>
                                          <div className="font-mono">{(opp.pinnacle.pinnacleFairProb * 100).toFixed(1)}%</div>
                                        </div>
                                        <div className="rounded border bg-background/40 p-2">
                                          <div className="text-[10px] text-muted-foreground">Edge mot Pinnacle</div>
                                          <div className={`font-mono ${opp.pinnacle.edge > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                                            {fmtPct(opp.pinnacle.pinnacleEdgePct)}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {data && data.opportunities.length === 0 && !loading && (
          <Card>
            <CardContent className="flex items-center gap-3 p-6 text-sm text-muted-foreground">
              <Info className="h-4 w-4 shrink-0" />
              <div>
                Inga möjligheter hittades med dina filter för {selectedOption.label}.{" "}
                {data.matchesWithBonusBookmaker === 0
                  ? `Just nu finns inga ${data.bonusBookmaker}-odds i cachen.`
                  : "Prova att sänka min odds eller bredda tidsfönstret."}
                {data.diag && data.matchesWithBonusBookmaker > 0 && (
                  <div className="mt-2 font-mono text-[11px] text-foreground/80">
                    Diagnostik: utfall i oddsspann {data.diag.bonusOutcomesInRange}, dutch misslyckades {data.diag.dutchNull},
                    skapade {data.diag.produced}. Snitt bookmakers/match {data.diag.avgBooksPerMatch.toFixed(1)},
                    matcher med ≥2 bookmakers {data.diag.matchesMultiBook}.
                    Saknad täckning per utfall — 1:{data.diag.coverMissing.home}, X:{data.diag.coverMissing.draw}, 2:{data.diag.coverMissing.away}.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
