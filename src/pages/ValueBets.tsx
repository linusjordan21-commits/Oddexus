import { Link } from "react-router-dom";
import { ArrowLeft, BookmarkPlus, ChevronDown, ChevronUp, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandHeader } from "@/components/BrandHeader";
import { SharpLinesTable } from "@/components/valuebets/SharpLinesTable";
import { DataQualityPanel } from "@/components/valuebets/DataQualityPanel";
import { TrackingDashboard } from "@/components/valuebets/TrackingDashboard";
import { TrackingAnalytics } from "@/components/valuebets/TrackingAnalytics";
import { StrategyLab } from "@/components/valuebets/StrategyLab";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiUrl } from "@/lib/apiUrl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BookmakerName from "@/components/BookmakerName";
import { BetLogPanel } from "@/components/bet-log/BetLogPanel";
import { loadBets, saveBet } from "@/lib/betLogStorage";
import type { BetOutcome, LoggedBet } from "@/lib/betLogTypes";
import { toast } from "sonner";
import { groupValueBets, type GroupedValueBet } from "@/lib/bookmakerGroups";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUserSettings } from "@/hooks/useUserSettings";
import { getCurrencySymbol } from "@/lib/settings/currency";
import { computeValueAdjustedStake } from "@/lib/staking";

type Outcome = "1" | "X" | "2";

type Verification = {
  teamsOk: boolean;
  leagueOk: boolean;
  timeOk: boolean;
  marketOk: boolean;
  startDeltaMs: number | null;
};

type ValueBet = {
  match: string;
  startTs?: string;
  league?: string;
  market: "moneyline" | "total" | "ah";
  /** "soccer" | "basketball". Saknas på äldre fotbolls-entries → faller tillbaka på pinnacle.sport. */
  sport?: string;
  pinnacle: {
    sport: string;
    tournament?: string;
    startTs?: string;
    odds: Record<string, number>;
    impliedProbs: Record<string, number>;
    overround: number;
    vig: number;
    fairProbs: Record<string, number>;
    fairOdds: Record<string, number>;
    /** Pinnacle max-insats (live likviditet). Hög = vass linje, låg = tunn → edge svänger. */
    limit?: number | null;
  };
  bookmakerId: string;
  bookmakerName: string;
  outcome: Outcome | "over" | "under" | "ah_home" | "ah_away";
  outcomeLabel: string;
  /** Totals: linjen (t.ex. 2.5). AH: handikapp-linjen ur HEMMA-perspektiv (t.ex. -0.5). */
  line?: number;
  bookmakerOdds: number;
  fairProb: number;
  fairOdds: number;
  ev: number;
  evPct: number;
  verification: Verification;
  needsReview: boolean;
  comment: string;
  /** Market Trust Layer: likviditets-grade (PRIOR, ej CLV-kalibrerad) + trust-flaggor + rekommendation. */
  trust?: { liquidity_score: number | null; liquidity_grade: string; flags: string[]; recommendation?: string };
  /** Market Trust Layer: varje sharps individuella fair odds för utfallet. */
  sharpPrices?: { pinnacle: number | null; sbobet: number | null; betfair: number | null };
  /** §2: rå Betfair-orderbok (back/lay/mid) för utfallet + likviditet. */
  betfair?: { liquidityFactor: number; spreadPct: number | null; matchedVolume: number; back?: number | null; lay?: number | null; mid?: number | null } | null;
  /** §3: per-källa feed-färskhet vid detektion. */
  sourceFreshness?: { sbobet?: { age_sec: number | null; fresh: boolean }; betfair?: { age_sec: number | null; fresh: boolean } } | null;
  isValueBet: true;
};

type PinnacleStatus = "fresh" | "stale" | "missing" | "fetch_failed" | "cache_used";

type BonusIndexStatusKind = "idle" | "running" | "ready" | "failed" | "stale";
type BonusIndexStatus = {
  status: BonusIndexStatusKind;
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  matchesCount: number;
  windowsLoaded?: number[];
  errorMessage: string | null;
};

type ValueBetsResponse = {
  ok: boolean;
  generatedAt: number;
  hours: number;
  threshold: number;
  reviewThreshold: number;
  rejectThreshold: number;
  timeToleranceMs: number;
  pinnacleFreshnessThresholdMs?: number;
  matchesScanned: number;
  pinnacleSoccerMoneylineCount: number;
  pinnacleUpdatedAt?: string | null;
  pinnacleAgeSeconds?: number | null;
  bonusIndexStatus?: BonusIndexStatus;
  isPinnacleFresh?: boolean;
  pinnacleStatus?: PinnacleStatus;
  pinnacleSource?: "live" | "disk" | "github" | "cache" | "empty";
  gateReason?: string;
  valueBets: ValueBet[];
  diagnostics?: {
    pairsConsidered: number;
    pairsRejectedTeams: number;
    pairsRejectedTime: number;
    pairsRejectedLeague: number;
    pairsRejectedSides: number;
    evRejectedExtreme: number;
  };
};

const HOURS_OPTIONS = [24, 48, 72] as const;

function formatPct(value: number, digits = 2) {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatOdds(value: number | undefined) {
  if (!Number.isFinite(value)) return "—";
  return (value as number).toFixed(2);
}

/**
 * Exakt (kontinuerlig) färg för Pinnacle-likviditet — INTE grova hinkar.
 * Log-skala mellan 50 (röd) och 15000 (grön) så färgen är mest känslig i
 * låg-zonen, där de flesta valuebets faktiskt ligger (50–100 ser tydligt
 * annorlunda ut än 200–500). Returnerar en HSL-sträng för inline style.
 */
/** Färg för likviditets-grade A–D (grön→röd); okänd → dämpad. */
function gradeColor(grade: string): string {
  switch (grade) {
    case "A": return "hsl(142 72% 42%)";
    case "B": return "hsl(90 55% 45%)";
    case "C": return "hsl(40 90% 50%)";
    case "D": return "hsl(0 75% 55%)";
    default: return "hsl(var(--muted-foreground))";
  }
}

/** Färg + svensk etikett för §7-rekommendationen (PRIOR). */
function recColor(rec: string): string {
  switch (rec) {
    case "avoid": case "manual_review": return "hsl(0 75% 55%)";
    case "stake_reduce": return "hsl(35 90% 50%)";
    case "watch": return "hsl(210 80% 60%)";
    default: return "hsl(142 72% 42%)";
  }
}
function recLabel(rec: string): string {
  switch (rec) {
    case "avoid": return "Undvik";
    case "manual_review": return "Granska";
    case "stake_reduce": return "Sänk insats";
    case "watch": return "Vänta";
    default: return "Bet";
  }
}
/** §3: kompakt ålders-format för källfärskhet. */
function fmtSourceAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function liquidityColor(limit: number): string {
  const lo = Math.log(50);
  const hi = Math.log(15000);
  const t = Math.max(0, Math.min(1, (Math.log(Math.max(1, limit)) - lo) / (hi - lo)));
  const hue = Math.round(t * 120); // 0 = röd (tunn), 120 = grön (vass)
  return `hsl(${hue}, 85%, 45%)`;
}

function formatStart(ts?: string) {
  if (!ts) return "—";
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toLocaleString("sv-SE", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TEAM_NOISE_PATTERN =
  /\b(F\.?C\.?|A\.?F\.?C\.?|C\.?F\.?|S\.?C\.?|S\.?K\.?|I\.?F\.?|B\.?K\.?|F\.?K\.?|A\.?C\.?|U\.?S\.?|N\.?K\.?|A\.?S\.?|G\.?K\.?S\.?|VfL|VfB|TSG|TSV|RB|SV|FF|II|U\d{1,2}|U-\d{1,2})\b/gi;

function cleanTeamName(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(TEAM_NOISE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[-–—]\s*$/, "")
    .replace(/^\s*[-–—]\s*/, "")
    .trim();
}

function splitMatchTeams(matchName: string): { home: string; away: string } | null {
  const match = matchName.match(/^(.*?)\s+(?:vs\.?|–|-|—|@)\s+(.*)$/i);
  if (!match) return null;
  return { home: match[1].trim(), away: match[2].trim() };
}

function pickOutcomeLabel(matchName: string, outcome: "1" | "X" | "2" | "over" | "under" | "ah_home" | "ah_away", fallback: string, drawLabel: string): string {
  // Totals (Over/Under) + AH: etiketten är redan färdig ("Över x.x mål", "Lag +0.5") → använd den.
  if (outcome === "over" || outcome === "under" || outcome === "ah_home" || outcome === "ah_away") return fallback;
  if (outcome === "X") return drawLabel;
  const teams = splitMatchTeams(matchName);
  if (!teams) return fallback;
  const raw = outcome === "1" ? teams.home : teams.away;
  const cleaned = cleanTeamName(raw);
  return cleaned || raw;
}

function relativeStart(ts?: string): string {
  if (!ts) return "—";
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return "—";
  const diffMs = ms - Date.now();
  if (diffMs <= 0) return "live";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `om ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `om ${hours} h`;
  const days = Math.floor(hours / 24);
  return `om ${days} d`;
}


export default function ValueBets() {
  const { t, formatMoney, settings } = useUserSettings();
  const settingsLanguage = settings.language;
  const settingsCurrency = settings.currency;
  const [hours, setHours] = useState<number>(24);
  const [minEvPct, setMinEvPct] = useState<number>(2);
  const [minOdds, setMinOdds] = useState<number | null>(null);
  const [maxOdds, setMaxOdds] = useState<number | null>(null);
  const [bookmakers, setBookmakers] = useState<Set<string>>(new Set());
  const [sportFilter, setSportFilter] = useState<"all" | "soccer" | "basketball" | "tennis">("all");
  const [data, setData] = useState<ValueBetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tickande klocka (var 5:e s) så att färskhets-vakten nedan om-utvärderas även
  // när polling slutar leverera (t.ex. Pinnacle nere / nätverksglapp). Utan den
  // skulle ett gammalt lyckat svar ligga kvar och visa value bets mot en gammal
  // linje tills nästa lyckade poll — vilket är exakt det som INTE får hända.
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  // Klient-tid då nuvarande `data` togs emot. Används av färskhets-vakten för
  // att mäta förfluten tid sedan svaret utan att förlita sig på att klientens
  // och serverns absoluta klockor är synkade.
  const [dataReceivedAt, setDataReceivedAt] = useState<number | null>(null);
  const [selectedVb, setSelectedVb] = useState<ValueBet | null>(null);
  // När user öppnar en card kan den representera flera variants (samma odds-
  // grupp). Dialog-dropdownen baseras på den här gruppen.
  const [selectedGroup, setSelectedGroup] = useState<GroupedValueBet<ValueBet> | null>(null);

  // Bet Log-state. Vi använder ingen mellan-modal längre — användaren
  // matar in odds + stake direkt i ValueBetDialog och bettet skrivs till
  // localStorage utan extra steg. betLogCount visas som badge i Tab-triggern.
  const [betLogCount, setBetLogCount] = useState<number>(() => loadBets().length);

  // Logga en valuebet direkt — ingen mellan-modal. odds + stake kommer från
  // ValueBetDialog där användaren tvingas mata in stake innan knappen blir
  // klickbar. Bettet skrivs direkt till localStorage via saveBet() och
  // dialogen stängs. Bet Tracker-fliken uppdateras via setBetLogCount.
  const handleLogValueBet = (vb: ValueBet, params: { stake: number; odds: number }) => {
    const newBet: LoggedBet = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `bet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      loggedAt: new Date().toISOString(),
      match: vb.match,
      league: vb.league ?? vb.pinnacle.tournament,
      startTs: vb.startTs ?? vb.pinnacle.startTs,
      sport: vb.sport ?? vb.pinnacle.sport ?? "soccer",
      bookmakerId: vb.bookmakerId,
      bookmakerName: vb.bookmakerName,
      outcome: vb.outcome as BetOutcome,
      outcomeLabel: vb.outcomeLabel,
      bookOdds: params.odds,
      stake: params.stake,
      pinnacleOddsAtBet: vb.pinnacle.odds[vb.outcome],
      pinnacleFairOddsAtBet: vb.fairOdds,
      pinnacleFairProbAtBet: vb.fairProb,
      // Pinnacle-likviditet (max-insats) vid spel — för CLV-per-likviditet-studien.
      pinnacleLimitAtBet: vb.pinnacle.limit ?? null,
      // EV vid ifyllt odds (kan skilja sig från snapshot om användaren justerat).
      evPctAtBet: (vb.fairProb * params.odds - 1) * 100,
      status: "open",
      source: "live-valuebet",
    };
    const all = saveBet(newBet);
    setBetLogCount(all.length);
    toast.success(t("valuebets.logBet"), {
      description: `${vb.match} · ${vb.outcomeLabel} @ ${params.odds.toFixed(2)} · ${formatMoney(params.stake)}`,
    });
    setSelectedVb(null);
    setSelectedGroup(null);
  };

  const availableBookmakers = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const vb of data.valueBets) set.add(vb.bookmakerName);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "sv"));
  }, [data]);

  const toggleBookmaker = (name: string) => {
    setBookmakers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  /**
   * Hämtar valuebets från /api/valuebets. `silent=true` skippar loading-spinner
   * och error-clearing — används av bakgrundspolling så att knappen inte
   * blinkar var 10:e sekund. Mount + manuell refresh + hours-change kör
   * icke-silent (visar spinner).
   */
  const fetchValueBets = useCallback(async (h: number, silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch(apiUrl(`/api/valuebets?hours=${h}`));
      const json = (await res.json()) as ValueBetsResponse | { ok: false; error: string };
      if (!("ok" in json) || !json.ok) {
        throw new Error("error" in json ? json.error : t("common.unknownError"));
      }
      setData(json);
      setDataReceivedAt(Date.now());
      // Lyckad silent-poll ska rensa ev. tidigare polling-error så UI inte
      // fastnar i error-state efter ett transient nätverksglapp.
      if (silent) setError(null);
    } catch (err) {
      // Silent-polling: skriv bara error om det INTE finns data sedan tidigare.
      // Annars ignorerar vi enstaka misslyckade poller — befintliga rader
      // ligger kvar och nästa poll får troligen fram nya.
      if (!silent || !data) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [data]);

  // Håll en stabil referens till senaste fetch-funktionen så att polling-
  // intervallet inte behöver återskapas vid varje render.
  const fetchValueBetsRef = useRef(fetchValueBets);
  useEffect(() => {
    fetchValueBetsRef.current = fetchValueBets;
  }, [fetchValueBets]);

  // Mount + byte av timsfönster: visa spinner.
  useEffect(() => {
    void fetchValueBets(hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours]);

  /**
   * Bakgrundspolling: hämtar /api/valuebets var 10:e sekund medan sidan är
   * öppen och synlig. Pausas när tabben blir hidden (document.hidden) för
   * att inte spamma backend när användaren inte tittar. Kör en omedelbar
   * fetch när tabben blir visible igen (kan ha varit dold i minuter).
   *
   * Polling-intervallet matchar backend cache-TTL (5s) men är något försiktigare
   * (10s) eftersom valuebets-beräkningen kör no-vig + parning vilket är
   * tyngre än rå Pinnacle-data.
   */
  const POLL_INTERVAL_MS = 10_000;
  useEffect(() => {
    let intervalId: number | null = null;

    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void fetchValueBetsRef.current(hours, true);
    };

    const start = () => {
      if (intervalId != null) return;
      intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId == null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        // Hämta direkt när tabben kommer tillbaka (silent), starta sedan polling.
        void fetchValueBetsRef.current(hours, true);
        start();
      }
    };

    if (typeof document !== "undefined" && !document.hidden) start();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      stop();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [hours]);

  // Oberoende klocka för färskhets-vakten (ovan). Behövs separat från polling
  // eftersom polling kan misslyckas — då måste vakten ändå räkna upp åldern.
  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * KLIENT-SIDANS FÄRSKHETSVAKT (säkerhetskritisk): speglar serverns 3-min-gate.
   * Servern levererar bara value bets när Pinnacle-snapshoten är färsk, men
   * frontend kunde tidigare visa ett GAMMALT lyckat svar vidare när polling
   * slutade leverera (Pinnacle nere, nätverksfel, ok:false). Då såg kunden
   * value bets mot en inaktuell linje. Här räknar vi snapshotens ålder mot
   * SAMMA tröskel som servern och döljer alla bets så fort den passeras.
   *
   * Åldern = serverns egen åldersberäkning vid svarstillfället (pinnacleAgeSeconds,
   * klock-skew-fri) + förfluten klient-tid sedan svaret togs emot. `nowTs` gör att
   * detta om-utvärderas var 5:e sekund även utan nya svar.
   */
  const freshnessThresholdMs = data?.pinnacleFreshnessThresholdMs ?? 3 * 60 * 1000;
  const displayedSnapshotAgeMs =
    data?.pinnacleAgeSeconds != null && dataReceivedAt != null
      ? data.pinnacleAgeSeconds * 1000 + (nowTs - dataReceivedAt)
      : null;
  const isDisplayStale =
    data != null &&
    (displayedSnapshotAgeMs == null ||
      !Number.isFinite(displayedSnapshotAgeMs) ||
      displayedSnapshotAgeMs > freshnessThresholdMs);

  const filtered = useMemo(() => {
    if (!data || isDisplayStale) return [];
    return data.valueBets.filter((vb) => {
      if (vb.evPct < minEvPct) return false;
      if (minOdds != null && vb.bookmakerOdds < minOdds) return false;
      if (maxOdds != null && vb.bookmakerOdds > maxOdds) return false;
      if (bookmakers.size > 0 && !bookmakers.has(vb.bookmakerName)) return false;
      if (sportFilter !== "all") {
        const s = vb.sport ?? vb.pinnacle?.sport ?? "soccer";
        if (s !== sportFilter) return false;
      }
      return true;
    });
  }, [data, isDisplayStale, minEvPct, minOdds, maxOdds, bookmakers, sportFilter]);

  // Grupperar duplicata valuebets från samma odds-grupp (ComeOn / Betsson /
  // Kambi). Filtreras först → grupperas efteråt så att bookmakerName-filter
  // bara visar gruppkort som innehåller de filtrerade bookmakers.
  const grouped = useMemo<GroupedValueBet<ValueBet>[]>(
    () => groupValueBets(filtered),
    [filtered],
  );

  // DIAGNOSTIK — efter användarrapport "0 valuebets på Render". Loggar exakt
  // var listan tappas så vi kan se i DevTools console om felet är backend
  // (rawCount 0) eller frontend-filter (rawCount > 0 men filteredCount 0).
  // Säkert att lämna i prod — endast console.log, ingen perf-impact.
  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line no-console
    console.log("[ValueBets debug]", {
      rawCount: data.valueBets?.length ?? 0,
      filteredCount: filtered.length,
      groupedCount: grouped.length,
      minEvPct,
      minOdds,
      maxOdds,
      bookmakerFilter: Array.from(bookmakers),
      hours,
      language: settingsLanguage,
      currency: settingsCurrency,
      sampleRaw: (data.valueBets ?? []).slice(0, 2).map((vb) => ({
        match: vb.match,
        bookmakerId: vb.bookmakerId,
        bookmakerName: vb.bookmakerName,
        outcome: vb.outcome,
        outcomeLabel: vb.outcomeLabel,
        evPct: vb.evPct,
        bookmakerOdds: vb.bookmakerOdds,
      })),
      apiMeta: {
        ok: data.ok,
        matchesScanned: data.matchesScanned,
        pinnacleStatus: data.pinnacleStatus,
        pinnacleAgeSeconds: data.pinnacleAgeSeconds,
        gateReason: data.gateReason,
      },
    });
  }, [data, filtered, grouped, minEvPct, minOdds, maxOdds, bookmakers, hours]);

  const [filtersOpen, setFiltersOpen] = useState(false);

  const activeFilterCount =
    (minEvPct !== 2 ? 1 : 0) +
    (minOdds != null ? 1 : 0) +
    (maxOdds != null ? 1 : 0) +
    (sportFilter !== "all" ? 1 : 0) +
    (bookmakers.size > 0 ? 1 : 0);

  const resetFilters = () => {
    setMinEvPct(2);
    setMinOdds(null);
    setMaxOdds(null);
    setBookmakers(new Set());
    setSportFilter("all");
  };


  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <BrandHeader className="mb-4" />
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-1 h-4 w-4" />
                {t("common.back")}
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{t("valuebets.title")}</h1>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchValueBets(hours)}
            disabled={loading}
          >
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh")}
          </Button>
        </div>

        <Tabs defaultValue="live" className="space-y-4">
          <TabsList>
            <TabsTrigger value="live">{t("valuebets.liveValuebets")}</TabsTrigger>
            <TabsTrigger value="log" className="gap-2">
              {t("valuebets.betTracker")}
              <Badge variant="secondary" className="text-[10px] font-mono">{betLogCount}</Badge>
            </TabsTrigger>
            <TabsTrigger value="tracking">Spårning</TabsTrigger>
            <TabsTrigger value="analys">Analys</TabsTrigger>
            <TabsTrigger value="lab">Strategy Lab</TabsTrigger>
            <TabsTrigger value="sharp">Sharp lines</TabsTrigger>
            <TabsTrigger value="quality">Datakvalitet</TabsTrigger>
          </TabsList>

          <TabsContent value="live" className="space-y-4">
        {/* Filter toggle-knapp */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFiltersOpen((o) => !o)}
            className="h-9 gap-2"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filter
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono leading-none">
                {activeFilterCount}
              </Badge>
            )}
            {filtersOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="h-9 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("common.reset")}
            </Button>
          )}
        </div>

        {/* Kollapsbar filter-panel */}
        {filtersOpen && (
        <Card className="mb-4">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <FilterField label={t("valuebets.timeWindow")}>
                <div className="flex gap-1">
                  {HOURS_OPTIONS.map((h) => (
                    <Button
                      key={h}
                      size="sm"
                      variant={hours === h ? "default" : "outline"}
                      onClick={() => setHours(h)}
                      className="h-9"
                    >
                      {h}h
                    </Button>
                  ))}
                </div>
              </FilterField>

              <FilterField label="Sport" htmlFor="sportFilter">
                <Select value={sportFilter} onValueChange={(v) => setSportFilter(v as "all" | "soccer" | "basketball" | "tennis")}>
                  <SelectTrigger id="sportFilter" className="h-9 w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Alla sporter</SelectItem>
                    <SelectItem value="soccer">Fotboll</SelectItem>
                    <SelectItem value="basketball">Basket</SelectItem>
                    <SelectItem value="tennis">Tennis</SelectItem>
                  </SelectContent>
                </Select>
              </FilterField>

              <FilterField label={t("valuebets.minEv")} htmlFor="minEv">
                <Input
                  id="minEv"
                  type="number"
                  step="0.5"
                  min="2"
                  max="100"
                  value={minEvPct}
                  onChange={(e) => setMinEvPct(Number(e.target.value) || 2)}
                  className="h-9 w-24"
                />
              </FilterField>

              <FilterField label={t("valuebets.minOdds")} htmlFor="minOdds">
                <Input
                  id="minOdds"
                  type="number"
                  step="0.1"
                  min="1"
                  placeholder="—"
                  value={minOdds ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setMinOdds(v === "" ? null : Number(v) || null);
                  }}
                  className="h-9 w-24"
                />
              </FilterField>

              <FilterField label={t("valuebets.maxOdds")} htmlFor="maxOdds">
                <Input
                  id="maxOdds"
                  type="number"
                  step="0.1"
                  min="1"
                  placeholder="—"
                  value={maxOdds ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    setMaxOdds(v === "" ? null : Number(v) || null);
                  }}
                  className="h-9 w-24"
                />
              </FilterField>
            </div>

            {availableBookmakers.length > 0 && (
              <div className="space-y-1.5 border-t border-border/40 pt-3">
                <Label className="text-xs text-muted-foreground">
                  {t("valuebets.bookmakers")}
                  {bookmakers.size > 0 && (
                    <span className="ml-1.5 text-emerald-500">
                      ({bookmakers.size})
                    </span>
                  )}
                  {bookmakers.size === 0 && (
                    <span className="ml-1.5 text-muted-foreground/70">({t("common.all")})</span>
                  )}
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {availableBookmakers.map((name) => {
                    const active = bookmakers.has(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => toggleBookmaker(name)}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                          active
                            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "border-border/60 bg-background/60 text-muted-foreground hover:border-border hover:text-foreground"
                        }`}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {error && (
          <Card className="mb-4 border-destructive/50">
            <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {/*
          Statusbannrarna döljs i UI per användarbegäran. Gating-logiken på servern är opåverkad
          (PinnacleStatusCard / BonusIndexStatusCard läser fortfarande `data`-fält när vi vill).
        */}

        {loading && !data && (
          <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
            {t("common.loading")}
          </div>
        )}

        {/* SÄKERHETSVAKT: när den visade Pinnacle-snapshoten passerat färskhets-
            tröskeln döljs alla value bets (se isDisplayStale). Visa en tydlig
            varning i stället för tomt/“inga tillfällen” så kunden förstår att
            det beror på gammal data — inte att det saknas värde. */}
        {data && isDisplayStale && (
          <Card className="mb-4 border-amber-500/50 bg-amber-500/10">
            <CardContent className="p-4 text-sm text-amber-800 dark:text-amber-300">
              <div className="font-semibold">{t("valuebets.staleGuardTitle")}</div>
              <div className="mt-1 text-xs opacity-90">{t("valuebets.staleGuardBody")}</div>
            </CardContent>
          </Card>
        )}

        {grouped.length > 0 && (
          <div className="mb-2 flex items-baseline gap-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">
              {grouped.length} {grouped.length === 1 ? t("valuebets.opportunity") : t("valuebets.opportunities")}
            </span>
            {filtered.length > grouped.length && (
              <span>· {filtered.length} {t("valuebets.bookmakerListings")}</span>
            )}
          </div>
        )}

        <div className="space-y-2">
          {grouped.map((g) => (
            <ValueBetCard
              key={g.id}
              group={g}
              onOpen={() => {
                setSelectedGroup(g);
                setSelectedVb(g.primary);
              }}
            />
          ))}
        </div>

        {data && !isDisplayStale && filtered.length === 0 && !loading && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {t("valuebets.noBetsFound")} (EV ≥ {minEvPct}%
              {minOdds != null ? `, odds ≥ ${minOdds.toFixed(2)}` : ""}
              {maxOdds != null ? `, odds ≤ ${maxOdds.toFixed(2)}` : ""})
            </CardContent>
          </Card>
        )}
          </TabsContent>

          <TabsContent value="log">
            <BetLogPanel onCountChange={setBetLogCount} />
          </TabsContent>
          <TabsContent value="tracking">
            <TrackingDashboard />
          </TabsContent>
          <TabsContent value="analys">
            <TrackingAnalytics />
          </TabsContent>
          <TabsContent value="lab">
            <StrategyLab />
          </TabsContent>
          <TabsContent value="sharp">
            <SharpLinesTable />
          </TabsContent>
          <TabsContent value="quality">
            <DataQualityPanel />
          </TabsContent>
        </Tabs>
      </div>

      <ValueBetDialog
        vb={selectedVb}
        group={selectedGroup}
        onSelectVariant={setSelectedVb}
        onClose={() => {
          setSelectedVb(null);
          setSelectedGroup(null);
        }}
        onLogBet={handleLogValueBet}
      />

    </div>
  );
}

/**
 * Format relativ ålder. Returnerar en språk-neutral form ("3m 12s ago" / "3m 12s sedan")
 * baserat på ett valfritt `agoSuffix` så att caller injicerar översatt "sedan"/"ago".
 */
function formatAge(seconds: number | null | undefined, agoSuffix = "ago"): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s ${agoSuffix}`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s ${agoSuffix}` : `${min} min ${agoSuffix}`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m ${agoSuffix}`;
}

function PinnacleStatusCard({ data }: { data: ValueBetsResponse }) {
  const { t } = useUserSettings();
  const status = data.pinnacleStatus ?? "fresh";
  const age = data.pinnacleAgeSeconds ?? null;
  const updatedAt = data.pinnacleUpdatedAt ?? null;
  const source = data.pinnacleSource ?? "cache";

  const palette: Record<
    PinnacleStatus,
    { label: string; cls: string; description: string }
  > = {
    fresh: {
      label: t("valuebets.pinnacle.fresh"),
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      description: `${t("valuebets.pinnacle.freshHint")} (${formatAge(age)})`,
    },
    cache_used: {
      label: t("valuebets.pinnacle.cache"),
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      description: `${t("valuebets.pinnacle.cacheHint")} (${formatAge(age)})`,
    },
    stale: {
      label: t("valuebets.pinnacle.stale"),
      cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      description: t("valuebets.pinnacle.staleHint"),
    },
    missing: {
      label: t("valuebets.pinnacle.missing"),
      cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
      description: t("valuebets.pinnacle.missingHint"),
    },
    fetch_failed: {
      label: t("valuebets.pinnacle.failed"),
      cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
      description: t("valuebets.pinnacle.failedHint"),
    },
  };
  const p = palette[status];

  return (
    <Card className={`mb-3 border ${p.cls}`}>
      <CardContent className="p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge className={p.cls + " border"}>{p.label}</Badge>
            <span>{p.description}</span>
          </div>
          <div className="text-[10px] opacity-80">
            {t("oddsDrops.source")}: {source} · {t("common.lastUpdated")}:{" "}
            {updatedAt ? new Date(updatedAt).toLocaleString() : "—"}
          </div>
        </div>
        {data.gateReason && (
          <div className="mt-2 text-[11px] opacity-90">{data.gateReason}</div>
        )}
      </CardContent>
    </Card>
  );
}

function BonusIndexStatusCard({ status }: { status: BonusIndexStatus }) {
  const { t } = useUserSettings();
  const palette: Record<
    BonusIndexStatusKind,
    { label: string; cls: string; description: string }
  > = {
    idle: {
      label: t("valuebets.bonusIndex.waiting"),
      cls: "border-slate-500/40 bg-slate-500/10 text-slate-700 dark:text-slate-400",
      description: t("valuebets.bonusIndex.waitingHint"),
    },
    running: {
      label: t("valuebets.bonusIndex.loading"),
      cls: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
      description: t("valuebets.bonusIndex.loadingHint"),
    },
    ready: {
      label: t("valuebets.bonusIndex.ready"),
      cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      description: `${status.matchesCount} · ${formatAge(status.ageSeconds)}`,
    },
    stale: {
      label: t("valuebets.bonusIndex.stale"),
      cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      description: t("valuebets.bonusIndex.staleHint"),
    },
    failed: {
      label: t("valuebets.bonusIndex.error"),
      cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
      description: status.errorMessage ?? t("valuebets.bonusIndex.errorHint"),
    },
  };
  const p = palette[status.status];
  return (
    <Card className={`mb-3 border ${p.cls}`}>
      <CardContent className="p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Badge className={p.cls + " border"}>{p.label}</Badge>
            <span>{p.description}</span>
          </div>
          {status.windowsLoaded && status.windowsLoaded.length > 0 && (
            <div className="text-[10px] opacity-80">
              fönster: {status.windowsLoaded.join(", ")}h
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function VerifyChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
        ok
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-rose-500/15 text-rose-700 dark:text-rose-400"
      }`}
    >
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function OddsRow({
  label,
  values,
  fmt,
}: {
  label: string;
  values: Partial<Record<Outcome, number>>;
  fmt: (v: number) => string;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-mono">
        {(["1", "X", "2"] as const)
          .filter((k) => typeof values[k] === "number" && (values[k] ?? 0) > 0)
          .map((k) => `${k}=${fmt(values[k] ?? 0)}`)
          .join(" · ")}
      </span>
    </div>
  );
}

function KV({
  label,
  value,
  mono = false,
  highlight = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`flex justify-between rounded px-2 py-1 ${highlight ? "bg-emerald-500/10" : "bg-muted/40"}`}>
      <span className="text-muted-foreground">{label}:</span>
      <span className={mono ? "font-mono font-semibold" : "font-semibold"}>{value}</span>
    </div>
  );
}

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function CopyableTeam({
  name,
  colorClass,
}: {
  name: string;
  colorClass: string;
}) {
  const { t } = useUserSettings();
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard kan vara blockerad — gör inget */
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? t("common.copied") + "!" : t("valuebets.copyTeamName")}
      className={`block w-full max-w-full truncate text-left text-sm font-semibold transition hover:underline ${colorClass}`}
    >
      {copied ? `✓ ${t("common.copied")}` : name}
    </button>
  );
}

const HOME_COLOR_CLASS = "text-sky-500 dark:text-sky-400";
const AWAY_COLOR_CLASS = "text-rose-500 dark:text-rose-400";

function ValueBetCard({
  group,
  onOpen,
}: {
  group: GroupedValueBet<ValueBet>;
  onOpen: () => void;
}) {
  const { t, formatMoney, settings } = useUserSettings();
  const drawLabel = t("outcome.draw");
  const vb = group.primary;
  // Rekommenderad insats enligt "Value Adjusted % Bankroll" (edge = vb.evPct).
  const stake = computeValueAdjustedStake(settings.bankroll ?? 0, vb.evPct);
  const teams = splitMatchTeams(vb.match);
  const homeName = teams ? cleanTeamName(teams.home) || teams.home : vb.match;
  const awayName = teams ? cleanTeamName(teams.away) || teams.away : "";

  // Tooltip-text på odds-cellen visar alla variants (bookmaker → odds).
  const oddsTooltip = group.isGrouped
    ? group.variants.map((v) => `${v.bookmakerName}: ${v.bookmakerOdds.toFixed(2)}`).join("\n")
    : "";
  // Sub-text under bookmaker-namnet visar alla brand i gruppen, t.ex.
  // "Hajper · Snabbare · ComeOn".
  const variantNamesText = group.isGrouped
    ? group.variants.map((v) => v.bookmakerName).join(" · ")
    : "";

  return (
    <Card
      className="cursor-pointer overflow-hidden border-border/60 transition hover:border-emerald-500/40"
      onClick={onOpen}
    >
      <CardContent className="p-0">
        {/*
          Fasta kolumnbredder gör att alla rader ser identiska ut oavsett antal
          siffror i odds/EV. Match-spalten är flexibel; resten är fasta.
          Hela kortet är klickbart → öppnar bet-detalj-dialog. Lagnamnen har
          stopPropagation så att klick på dem bara kopierar (öppnar inte dialog).
        */}
        <div className="grid grid-cols-[minmax(0,1fr)_80px_110px_200px_130px] items-stretch">
          <div className="min-w-0 px-4 py-3">
            <div className="space-y-0.5">
              {teams ? (
                <>
                  <CopyableTeam name={homeName} colorClass={HOME_COLOR_CLASS} />
                  <CopyableTeam name={awayName} colorClass={AWAY_COLOR_CLASS} />
                </>
              ) : (
                <CopyableTeam name={vb.match} colorClass="text-foreground/80" />
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {(vb.sport ?? vb.pinnacle?.sport) === "basketball" && (
                <Badge className="bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40 text-[10px]">
                  🏀 Basket
                </Badge>
              )}
              {(vb.sport ?? vb.pinnacle?.sport) === "tennis" && (
                <Badge className="bg-lime-500/15 text-lime-700 dark:text-lime-400 border-lime-500/40 text-[10px]">
                  🎾 Tennis
                </Badge>
              )}
              <Badge variant="secondary" className="text-[10px]">
                {vb.league ?? vb.pinnacle.tournament ?? "—"}
              </Badge>
            </div>
          </div>

          <div
            title={vb.startTs ? formatStart(vb.startTs) : ""}
            className="flex min-w-0 items-center justify-center border-l border-border/60 px-3 py-3"
          >
            <span className="whitespace-nowrap font-mono text-xs font-semibold leading-tight text-foreground">
              {relativeStart(vb.startTs)}
            </span>
          </div>

          <div
            title={group.isGrouped ? `${group.bookmakerGroupLabel}\n${variantNamesText}` : vb.bookmakerName}
            className="flex min-w-0 flex-col items-center justify-center gap-0.5 border-l border-border/60 px-3 py-3"
          >
            {group.isGrouped ? (
              <>
                <span className="text-[11px] font-bold leading-none text-foreground">
                  {group.bookmakerGroupLabel}
                </span>
                <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-mono leading-none">
                  {group.siteCount} sites
                </Badge>
                <span
                  className="mt-0.5 max-w-[120px] truncate text-[9px] leading-tight text-muted-foreground"
                  title={variantNamesText}
                >
                  {variantNamesText}
                </span>
              </>
            ) : (
              <BookmakerName
                name={vb.bookmakerName}
                className={`flex h-9 w-[80px] items-center justify-center [&_img]:w-auto [&_img]:object-contain ${
                  vb.bookmakerName === "Golden Bull"
                    ? "[&_img]:max-h-9"
                    : "[&_img]:max-h-5"
                }`}
              />
            )}
          </div>

          <div
            className="flex min-w-0 flex-col items-center justify-center gap-1 border-l border-border/60 px-3 py-3"
            title={oddsTooltip || undefined}
          >
            <span className="max-w-full truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {pickOutcomeLabel(vb.match, vb.outcome, vb.outcomeLabel, drawLabel)}
            </span>
            <span className="font-mono text-3xl font-bold leading-none text-foreground tabular-nums">
              {formatOdds(group.bestOdds)}
            </span>
            {/* Pinnacle no-vig fair odds som referenspris under bookmaker odds. */}
            <span
              className="text-[9px] uppercase tracking-wide text-muted-foreground tabular-nums"
              title={t("valuebets.pinnacleOddsTooltip")}
            >
              Pinn {vb.pinnacle.odds[vb.outcome]?.toFixed(2) ?? "—"}
            </span>
            {/* Live Pinnacle-likviditet (max-insats) — EXAKT siffra + kontinuerlig
                färg (mest känslig i låg-zonen). Färgen är ren signal; siffran är
                sanningen och visas alltid exakt. */}
            {vb.pinnacle.limit != null && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide tabular-nums"
                style={{ color: liquidityColor(vb.pinnacle.limit) }}
                title="Pinnacles max-insats = live likviditet. Ju lägre, desto tunnare linje och desto mer svänger edgen. Stor skillnad redan mellan t.ex. 80 och 450."
              >
                Likv {vb.pinnacle.limit.toLocaleString("sv-SE")}
              </span>
            )}
            {/* Market Trust Layer: composite likviditets-grade (PRIOR). Dold vid unknown. */}
            {vb.trust && vb.trust.liquidity_grade !== "unknown" && (
              <span
                className="text-[10px] font-bold uppercase tracking-wide tabular-nums"
                style={{ color: gradeColor(vb.trust.liquidity_grade) }}
                title={`Likviditets-grade (PRIOR, ej CLV-kalibrerad): ${vb.trust.liquidity_grade}`}
              >
                Grade {vb.trust.liquidity_grade}
              </span>
            )}
            {/* Flaggvarning visas ÄVEN när grade är unknown — okänd likviditet + flaggor
                = ofta det mest riskfyllda fallet (Cursor #13). */}
            {vb.trust && vb.trust.flags.length > 0 && (
              <span
                className="text-[10px] font-semibold tabular-nums text-amber-600 dark:text-amber-400"
                title={`Trust-flaggor (prior): ${vb.trust.flags.join(", ")}`}
              >
                ⚠{vb.trust.flags.length}
              </span>
            )}
            {/* §7 likviditets-justerad rekommendation (PRIOR) — visas när den avviker från "bet". */}
            {vb.trust?.recommendation && vb.trust.recommendation !== "bet" && (
              <span
                className="text-[10px] font-bold uppercase tracking-wide"
                style={{ color: recColor(vb.trust.recommendation) }}
                title="Likviditets-justerad rekommendation (PRIOR, ej CLV-kalibrerad)"
              >
                {recLabel(vb.trust.recommendation)}
              </span>
            )}
            {group.isGrouped && group.bestOdds !== group.worstOdds && (
              <span className="text-[9px] text-muted-foreground tabular-nums">
                Range: {group.worstOdds.toFixed(2)}–{group.bestOdds.toFixed(2)}
              </span>
            )}
          </div>

          <div className="flex min-w-0 flex-col items-center justify-center gap-1 border-l border-emerald-500/30 bg-emerald-500/10 px-3 py-3">
            <span className="text-[10px] uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">
              Värde EV
            </span>
            <span className="font-mono text-2xl font-bold leading-none text-emerald-600 dark:text-emerald-400 tabular-nums">
              +{vb.evPct.toFixed(2)}%
            </span>
            {/* Rekommenderad insats (Value Adjusted % Bankroll). Visas bara när
                bankroll är angiven OCH edge ger ett stakeförslag (>= 1 %). */}
            {stake.status === "Bet" && (
              <span
                className="mt-0.5 whitespace-nowrap font-mono text-xs font-semibold leading-none text-foreground tabular-nums"
                title={`${t("valuebets.stakeRecommended")}: ${(stake.stakePercentage * 100).toFixed(1)}% · ${t("valuebets.stakeRisk")}: ${stake.riskLevel}`}
              >
                {formatMoney(stake.recommendedStake)}
                <span className="ml-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                  {stake.riskLevel}
                </span>
              </span>
            )}
            {settings.bankroll != null && settings.bankroll > 0 && stake.status === "No bet" && (
              <span className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                {t("valuebets.stakeNoBet")}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ValueBetDialog({
  vb,
  group,
  onSelectVariant,
  onClose,
  onLogBet,
}: {
  vb: ValueBet | null;
  group?: GroupedValueBet<ValueBet> | null;
  onSelectVariant?: (vb: ValueBet) => void;
  onClose: () => void;
  onLogBet?: (vb: ValueBet, params: { stake: number; odds: number }) => void;
}) {
  const { t, formatMoney, settings } = useUserSettings();
  const currencySym = getCurrencySymbol(settings.currency);
  const [oddsInput, setOddsInput] = useState<string>("");
  const [stakeInput, setStakeInput] = useState<string>("");

  // Reset inputs varje gång ny bet öppnas. Förifyll insatsen med rekommendationen
  // från "Value Adjusted % Bankroll" (om bankroll är satt och edge >= 1 %).
  useEffect(() => {
    if (vb) {
      setOddsInput(vb.bookmakerOdds.toFixed(2));
      const rec = computeValueAdjustedStake(settings.bankroll ?? 0, vb.evPct);
      setStakeInput(rec.status === "Bet" && rec.recommendedStake > 0 ? String(rec.recommendedStake) : "");
    }
  }, [vb, settings.bankroll]);

  if (!vb) return null;

  const teams = splitMatchTeams(vb.match);
  const homeName = teams ? cleanTeamName(teams.home) || teams.home : vb.match;
  const awayName = teams ? cleanTeamName(teams.away) || teams.away : "";
  const outcomeLabel = pickOutcomeLabel(vb.match, vb.outcome, vb.outcomeLabel, t("outcome.draw"));

  const oddsNum = Number(oddsInput);
  const stakeNum = Number(stakeInput);
  const hasValidOdds = Number.isFinite(oddsNum) && oddsNum > 1;
  const hasValidStake = Number.isFinite(stakeNum) && stakeNum > 0;

  // EV räknas om mot Pinnacle fair-prob med användarens odds
  const fairProb = vb.fairProb;
  const liveEv = hasValidOdds ? fairProb * oddsNum - 1 : vb.ev;
  const liveEvPct = liveEv * 100;
  const liveIsValue = liveEv > 0;

  const potentialReturn = hasValidOdds && hasValidStake ? oddsNum * stakeNum : 0;
  const potentialProfit = potentialReturn - (hasValidStake ? stakeNum : 0);
  const expectedValueKr = hasValidStake ? liveEv * stakeNum : 0;

  // Rekommenderad insats (Value Adjusted % Bankroll). Edge tas från live-EV mot
  // användarens odds så förslaget följer det odds som faktiskt skrivs in.
  const stakeRec = computeValueAdjustedStake(settings.bankroll ?? 0, liveEvPct);

  return (
    <Dialog open={vb !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {teams ? (
              <span className="flex flex-wrap items-baseline gap-1.5">
                <span className={HOME_COLOR_CLASS}>{homeName}</span>
                <span className="text-muted-foreground">vs.</span>
                <span className={AWAY_COLOR_CLASS}>{awayName}</span>
              </span>
            ) : (
              vb.match
            )}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary" className="text-[10px]">
              {vb.league ?? vb.pinnacle.tournament ?? "—"}
            </Badge>
            <span>{formatStart(vb.startTs)}</span>
            <span>·</span>
            <span>{relativeStart(vb.startTs)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="space-y-4">
          {/* Bookmaker variant-selector — visas bara vid grupperat valuebet.
              Default = primary (highest odds). Byte uppdaterar oddsInput
              och vb-state så att Logga valuebet skickar vald variant. */}
          {group && group.isGrouped && onSelectVariant && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80 font-semibold">
                Available on {group.siteCount} sites — {group.bookmakerGroupLabel}
              </div>
              <Select
                value={vb.bookmakerId}
                onValueChange={(id) => {
                  const next = group.variants.find((v) => v.bookmakerId === id);
                  if (next) {
                    onSelectVariant(next);
                    setOddsInput(next.bookmakerOdds.toFixed(2));
                  }
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {group.variants.map((v) => (
                    <SelectItem key={v.bookmakerId} value={v.bookmakerId}>
                      <span className="flex items-center justify-between gap-3 w-full">
                        <span>{v.bookmakerName}</span>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          odds {v.bookmakerOdds.toFixed(2)} · EV +{v.evPct.toFixed(2)}%
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Översikt — samma info som i kortet */}
          <div className="grid grid-cols-3 gap-2">
            <DialogStat
              label={t("valuebets.bookmaker")}
              value={
                <BookmakerName
                  name={vb.bookmakerName}
                  className="flex h-6 w-[80px] items-center justify-start [&_img]:max-h-6 [&_img]:w-auto [&_img]:object-contain"
                />
              }
            />
            <DialogStat label={t("betLog.outcome")} value={outcomeLabel} />
            <DialogStat
              label={t("valuebets.ev")}
              value={
                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                  +{vb.evPct.toFixed(2)}%
                </span>
              }
            />
          </div>

          {/* Pinnacle-jämförelse */}
          <div className="rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Pinnacle (referens)
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Odds:</span>
                <span className="font-mono font-semibold">
                  {formatOdds(vb.pinnacle.odds[vb.outcome])}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fair odds:</span>
                <span className="font-mono font-semibold">
                  {formatOdds(vb.pinnacle.fairOdds[vb.outcome])}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Fair prob:</span>
                <span className="font-mono font-semibold">
                  {(fairProb * 100).toFixed(2)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Vig:</span>
                <span className="font-mono font-semibold">
                  {(vb.pinnacle.vig * 100).toFixed(2)}%
                </span>
              </div>
              {vb.pinnacle.limit != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground" title="Pinnacles max-insats = live likviditet. Ju lägre, desto tunnare linje och mer svänger edgen.">
                    Pinnacle likviditet:
                  </span>
                  <span className="font-mono font-semibold" style={{ color: liquidityColor(vb.pinnacle.limit) }}>
                    {vb.pinnacle.limit.toLocaleString("sv-SE")}
                  </span>
                </div>
              )}
              {vb.trust && vb.trust.liquidity_grade !== "unknown" && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground" title="Composite liquidity grade (PRIOR, ej CLV-kalibrerad ännu).">
                    Likviditets-grade:
                  </span>
                  <span className="font-mono font-semibold" style={{ color: gradeColor(vb.trust.liquidity_grade) }}>
                    {vb.trust.liquidity_grade}
                  </span>
                </div>
              )}
              {vb.sharpPrices && (vb.sharpPrices.pinnacle != null || vb.sharpPrices.sbobet != null || vb.sharpPrices.betfair != null) && (
                <div className="flex flex-col gap-1 pt-1">
                  <span className="text-muted-foreground" title="Varje sharp-källas no-vig fair odds för detta utfall (Pinnacle = ankaret).">
                    Sharp-priser (fair):
                  </span>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                    {vb.sharpPrices.pinnacle != null && <span>Pinnacle {vb.sharpPrices.pinnacle.toFixed(2)}</span>}
                    {vb.sharpPrices.sbobet != null && <span>SBOBET {vb.sharpPrices.sbobet.toFixed(2)}</span>}
                    {vb.sharpPrices.betfair != null && <span>Betfair {vb.sharpPrices.betfair.toFixed(2)}</span>}
                  </div>
                </div>
              )}
              {/* §2: rå Betfair-orderbok (back/lay/mid) för utfallet. */}
              {vb.betfair && (vb.betfair.back != null || vb.betfair.lay != null) && (
                <div className="flex flex-col gap-1 pt-1">
                  <span className="text-muted-foreground" title="Rå Betfair-orderbok för detta utfall: bästa back, bästa lay, mid (= 1/midpoint-prob).">Börs (Betfair):</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                    {vb.betfair.back != null && <span>back {vb.betfair.back.toFixed(2)}</span>}
                    {vb.betfair.lay != null && <span>lay {vb.betfair.lay.toFixed(2)}</span>}
                    {vb.betfair.mid != null && <span>mid {vb.betfair.mid.toFixed(2)}</span>}
                    {vb.betfair.matchedVolume != null && <span className="text-muted-foreground">vol {Math.round(vb.betfair.matchedVolume).toLocaleString("sv-SE")}</span>}
                  </div>
                </div>
              )}
              {/* §3: per-källa feed-färskhet vid detektion (stale = för gammal för att blandas). */}
              {vb.sourceFreshness && (vb.sourceFreshness.sbobet?.age_sec != null || vb.sourceFreshness.betfair?.age_sec != null) && (
                <div className="flex flex-col gap-1 pt-1">
                  <span className="text-muted-foreground" title="Hur färsk varje sharp-feed var vid detektion. Stale = för gammal → hård-gatad ur blandningen.">Källfärskhet:</span>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                    {vb.sourceFreshness.sbobet?.age_sec != null && (
                      <span className={vb.sourceFreshness.sbobet.fresh ? "" : "text-destructive"}>SBOBET {fmtSourceAge(vb.sourceFreshness.sbobet.age_sec)}{vb.sourceFreshness.sbobet.fresh ? "" : " (stale)"}</span>
                    )}
                    {vb.sourceFreshness.betfair?.age_sec != null && (
                      <span className={vb.sourceFreshness.betfair.fresh ? "" : "text-destructive"}>Betfair {fmtSourceAge(vb.sourceFreshness.betfair.age_sec)}{vb.sourceFreshness.betfair.fresh ? "" : " (stale)"}</span>
                    )}
                  </div>
                </div>
              )}
              {vb.trust && vb.trust.flags.length > 0 && (
                <div className="flex flex-col gap-1 pt-1">
                  <span className="text-muted-foreground">Trust-flaggor (prior):</span>
                  <div className="flex flex-wrap gap-1">
                    {vb.trust.flags.map((f) => (
                      <Badge key={f} variant="outline" className="text-[9px] font-normal">{f}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Inmatning: odds + insats */}
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              Lägg bett
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="dialogOdds" className="text-xs text-muted-foreground">
                  Odds (justera om ändrats)
                </Label>
                <Input
                  id="dialogOdds"
                  type="number"
                  step="0.01"
                  min="1.01"
                  value={oddsInput}
                  onChange={(e) => setOddsInput(e.target.value)}
                  className="h-9 font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="dialogStake" className="text-xs text-muted-foreground">
                  {t("betLog.stake")} ({currencySym})
                </Label>
                <Input
                  id="dialogStake"
                  type="number"
                  step="10"
                  min="0"
                  placeholder="0"
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  className="h-9 font-mono"
                />
              </div>
            </div>

            {/* Rekommenderad insats — Value Adjusted % Bankroll */}
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-emerald-500/20 pt-3 text-xs">
              <span className="text-muted-foreground">
                {t("valuebets.stakeRecommended")}
                <span className="ml-1 text-[10px] text-muted-foreground/70">
                  ({t("valuebets.stakeModel")})
                </span>
              </span>
              {stakeRec.status === "Invalid bankroll" ? (
                <span className="text-muted-foreground/80">{t("valuebets.stakeSetBankroll")}</span>
              ) : stakeRec.status === "No bet" ? (
                <span className="font-semibold text-muted-foreground">{t("valuebets.stakeNoBet")}</span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="font-mono font-bold text-foreground tabular-nums">
                    {formatMoney(stakeRec.recommendedStake)}
                  </span>
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                    {(stakeRec.stakePercentage * 100).toFixed(1)}% · {stakeRec.riskLevel}
                  </span>
                  <button
                    type="button"
                    onClick={() => setStakeInput(String(stakeRec.recommendedStake))}
                    className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition hover:border-emerald-500/50 hover:text-emerald-600 dark:hover:text-emerald-400"
                  >
                    {t("valuebets.stakeApply")}
                  </button>
                </span>
              )}
            </div>

            {hasValidOdds && (
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-emerald-500/20 pt-3 text-xs">
                <DialogStat
                  label={t("betLog.totalStake")}
                  value={
                    <span className="font-mono font-bold tabular-nums">
                      {hasValidStake ? formatMoney(potentialReturn, { fractionDigits: 0 }) : "—"}
                    </span>
                  }
                />
                <DialogStat
                  label={t("betLog.profit")}
                  value={
                    <span className="font-mono font-bold tabular-nums">
                      {hasValidStake ? formatMoney(potentialProfit, { fractionDigits: 0, showSign: true }) : "—"}
                    </span>
                  }
                />
                <DialogStat
                  label={t("valuebets.ev")}
                  value={
                    <span
                      className={`font-mono font-bold tabular-nums ${
                        liveIsValue
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-500 dark:text-rose-400"
                      }`}
                    >
                      {liveIsValue ? "+" : ""}
                      {liveEvPct.toFixed(2)}%
                    </span>
                  }
                />
                {hasValidStake && (
                  <div className="col-span-3 flex items-center justify-between rounded bg-background/60 px-2 py-1.5 text-xs">
                    <span className="text-muted-foreground">
                      {t("betLog.expectedValue")}:
                    </span>
                    <span
                      className={`font-mono font-bold tabular-nums ${
                        liveIsValue
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-500 dark:text-rose-400"
                      }`}
                    >
                      {formatMoney(expectedValueKr, { showSign: true })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {onLogBet && (
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                onClick={() => onLogBet(vb, { stake: stakeNum, odds: oddsNum })}
                disabled={!hasValidStake || !hasValidOdds}
                className="gap-2"
              >
                <BookmarkPlus className="h-4 w-4" />
                {t("betLog.addBet")}
              </Button>
            </div>
          )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DialogStat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded border border-border/40 bg-background/40 px-2 py-1.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
