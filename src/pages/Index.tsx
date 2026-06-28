import { useState, useMemo, useEffect, useRef, useCallback, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { useUserSettings } from "@/hooks/useUserSettings";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import MatchCalculator, { BetSide } from "@/components/MatchCalculator";
import BookmakerOddsTable from "@/components/BookmakerOddsTable";
import BookmakerName from "@/components/BookmakerName";
import { BrandHeader } from "@/components/BrandHeader";
import {
  defaultBookmakers,
  Bookmaker,
  BetLog,
  BET_LOGS_STORAGE_KEY,
  calcMatchedBonusEV,
  saveBetLog,
  getBetLogs,
  deleteBetLog,
  updateBetLogResult,
  serializeBetLogsForExport,
  importBetLogsMergeJson,
  syncBetLogsOnLoad,
} from "@/lib/bookmakers";
import { toast } from "sonner";
import { apiUrl } from "@/lib/apiUrl";

type Outcome = '1' | 'X' | '2';
const OUTCOMES: Outcome[] = ['1', 'X', '2'];
/** OUTCOME_LABELS byggs nu runtime via t() i komponenten. Behållen för
 *  backwards-compat med ev. extern import. */
const OUTCOME_LABELS: Record<Outcome, string> = { '1': 'Home (1)', 'X': 'Draw (X)', '2': 'Away (2)' };
const fadeIn = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };
const stagger = { animate: { transition: { staggerChildren: 0.06 } } };

type ScrapedOddRow = { bookmakerId?: string; bookmaker: string; home: number; draw: number; away: number };
type ScrapedMatch = { title: string; url: string };
type BookmakerScrapeResult = {
  bookmakerId: string;
  bookmaker: string;
  status: "found" | "not_found" | "blocked" | "error";
  title?: string;
  home?: number;
  draw?: number;
  away?: number;
  sourceUrl?: string;
  error?: string;
};

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatOddsValue(value?: number) {
  return value != null && value > 0 ? String(value).replace(".", ",") : "";
}

function cleanScrapedMatchName(raw?: string) {
  if (!raw) return "";
  return raw
    .replace(/\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s*$/, "")
    .replace(/\s+Odds,.*$/i, "")
    .replace(/\s+\|\s*OddsPortal.*$/i, "")
    .replace(/\s+-\s+/g, " vs ")
    .trim();
}

type View = 'calculator' | 'history';

const Index = () => {
  const { t } = useUserSettings();
  const savedState = useMemo(() => {
    try {
      const raw = sessionStorage.getItem('app-state');
      if (raw) {
        sessionStorage.removeItem('app-state');
        return JSON.parse(raw);
      }
    } catch {}
    return null;
  }, []);

  const [view, setView] = useState<View>(savedState?.view || 'calculator');
  const [bookmakers, setBookmakers] = useState<Bookmaker[]>(savedState?.bookmakers || defaultBookmakers);
  const [matchName, setMatchName] = useState(savedState?.matchName || "");
  const [personTag, setPersonTag] = useState(savedState?.personTag || "Oliwer");
  const [oddsScrapeUrl, setOddsScrapeUrl] = useState(savedState?.oddsScrapeUrl || "https://www.oddsportal.com/");
  const [oddsSearchQuery, setOddsSearchQuery] = useState(savedState?.oddsSearchQuery || "");
  const [isScrapingOdds, setIsScrapingOdds] = useState(false);
  const [lastScrapeSummary, setLastScrapeSummary] = useState<string>(savedState?.lastScrapeSummary || "");
  const [scrapeMatches, setScrapeMatches] = useState<ScrapedMatch[]>(savedState?.scrapeMatches || []);
  const [lastScrapedOddsRows, setLastScrapedOddsRows] = useState<ScrapedOddRow[]>(savedState?.lastScrapedOddsRows || []);
  const [bookmakerScrapeResults, setBookmakerScrapeResults] = useState<BookmakerScrapeResult[]>(
    savedState?.bookmakerScrapeResults || [],
  );
  const [bestComplements, setBestComplements] = useState<Record<Outcome, { bookmaker: string; odds: number } | null>>(
    savedState?.bestComplements || { '1': null, 'X': null, '2': null },
  );
  const [logs, setLogs] = useState<BetLog[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedResult, setSelectedResult] = useState<'1' | 'X' | '2' | null>(savedState?.selectedResult || null);

  // Step 3: Freebet match
  const [fbMatchName, setFbMatchName] = useState(savedState?.fbMatchName || "");
  const [fbHedgeComplementSite, setFbHedgeComplementSite] = useState(savedState?.fbHedgeComplementSite || "Pinnacle");
  const [fbSites, setFbSites] = useState<BetSide[]>(savedState?.fbSites || []);

  // Step 4: Matched winners match
  const [mwMatchName, setMwMatchName] = useState(savedState?.mwMatchName || "");
  const [mwSites, setMwSites] = useState<BetSide[]>(savedState?.mwSites || []);
  const [mwCandidateSites, setMwCandidateSites] = useState<BetSide[]>(savedState?.mwCandidateSites || []);
  const [day2StrategyNote, setDay2StrategyNote] = useState(savedState?.day2StrategyNote || "");

  // Step 5: Dag 3 — matched bet wagering
  const [d3MatchName, setD3MatchName] = useState(savedState?.d3MatchName || "");
  const [d3Sites, setD3Sites] = useState<BetSide[]>(savedState?.d3Sites || []);
  const [d3Result, setD3Result] = useState<'1' | 'X' | '2' | null>(savedState?.d3Result || null);
  const [d3FbResult, setD3FbResult] = useState<'1' | 'X' | '2' | null>(savedState?.d3FbResult || null);

  // Pinnacle hedging for freebets
  const [pinnacleOdds, setPinnacleOdds] = useState<Record<string, number>>(savedState?.pinnacleOdds || {});
  const [pinnacleDraftOdds, setPinnacleDraftOdds] = useState<Partial<Record<Outcome, string>>>({});
  const [complementBookmaker, setComplementBookmaker] = useState(savedState?.complementBookmaker || "Pinnacle");
  const [complementAccountOwner, setComplementAccountOwner] = useState(savedState?.complementAccountOwner || "");
  const [complementPlaced, setComplementPlaced] = useState<Record<Outcome, boolean>>({
    '1': !!savedState?.complementPlaced?.['1'],
    'X': !!savedState?.complementPlaced?.['X'],
    '2': !!savedState?.complementPlaced?.['2'],
  });
  const importLogsRef = useRef<HTMLInputElement>(null);

  const refreshLogsFromStorage = useCallback(async () => {
    const next = await syncBetLogsOnLoad();
    setLogs(next);
  }, []);

  useEffect(() => {
    void refreshLogsFromStorage();
  }, [refreshLogsFromStorage]);

  useEffect(() => {
    if (view === "history") void refreshLogsFromStorage();
  }, [view, refreshLogsFromStorage]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== BET_LOGS_STORAGE_KEY && e.key !== null) return;
      void refreshLogsFromStorage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshLogsFromStorage]);

  useEffect(() => {
    const onFocus = () => void refreshLogsFromStorage();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshLogsFromStorage]);

  const storageDebugLine = useMemo(() => {
    if (typeof window === "undefined") return "";
    try {
      const raw = localStorage.getItem(BET_LOGS_STORAGE_KEY);
      const o = window.location.origin;
      if (raw == null) return `Lagring för denna webbadress (${o}): ingen sparad lista ännu (eller du använder en annan adress/port än när du sparade).`;
      if (raw === "[]") return `Lagring finns på ${o} men listan är tom.`;
      const parsed = JSON.parse(raw) as unknown;
      const n = Array.isArray(parsed) ? parsed.length : -1;
      if (n < 0) return `Lagring på ${o} har data men formatet verkar fel (${raw.length} tecken). Exportera inte — prova backup-fil eller spara om.`;
      return `Lagring på ${o}: ${n} spel i localStorage. Om du ändå inte ser dem, tryck "Läs om listan".`;
    } catch {
      return "Kunde inte läsa localStorage (blockerat, privat fönster eller säkerhetsinställning).";
    }
  }, [logs.length, view]);

  const appOrigin = useMemo(
    () => (typeof window !== "undefined" ? window.location.origin : ""),
    [],
  );

  const handleExportBetLogs = () => {
    const blob = new Blob([serializeBetLogsForExport()], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `sparade-spel-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Backup nedladdad");
  };

  const handleImportBetLogsFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const merged = importBetLogsMergeJson(text);
      setLogs(merged);
      toast.success(`Importerade — ${merged.length} spel i listan`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte importera filen");
    }
  };

  const allMatched = bookmakers.filter(b => b.bonusType === 'matched');
  const allFreebets = bookmakers.filter(b => b.bonusType === 'freebet' && (b.freebetValue || 0) > 0);
  const matchedSites = allMatched.filter(b => b.assignedOutcome !== 'used');
  const freebetSites = allFreebets.filter(b => b.assignedOutcome !== 'used');

  const updateBm = (id: string, updates: Partial<Bookmaker>) => {
    setBookmakers(prev => prev.map(b => b.id === id ? { ...b, ...updates } : b));
  };

  const getOdds = (bm: Bookmaker): number => {
    if (bm.assignedOutcome === '1') return bm.oddsHome || 0;
    if (bm.assignedOutcome === 'X') return bm.oddsDraw || 0;
    if (bm.assignedOutcome === '2') return bm.oddsAway || 0;
    return 0;
  };

  const analysis = useMemo(() => {
    const assignedMatched = matchedSites.filter(b => b.assignedOutcome && getOdds(b) > 0);
    const assignedFreebets = freebetSites.filter(b => b.assignedOutcome && getOdds(b) > 0);
    const totalMatchedStake = assignedMatched.reduce((s, b) => s + b.betAmount, 0);

    const outcomes = OUTCOMES.map(outcome => {
      const matchedWinners = assignedMatched.filter(b => b.assignedOutcome === outcome);
      const matchedPayout = matchedWinners.reduce((s, b) => s + b.betAmount * getOdds(b), 0);
      const freebetWinners = assignedFreebets.filter(b => b.assignedOutcome === outcome);
      const freebetLosers = assignedFreebets.filter(b => b.assignedOutcome !== outcome);
      const freebetPayout = freebetWinners.reduce((s, b) => s + (b.freebetValue || 0) * (getOdds(b) - 1), 0);
      const freebetLost = freebetLosers.reduce((s, b) => s + (b.freebetValue || 0), 0);
      const totalPayout = matchedPayout + freebetPayout;
      return {
        outcome, matchedWinners, freebetWinners, freebetLosers, matchedPayout, freebetPayout, freebetLost, totalPayout,
        profit: totalPayout - totalMatchedStake - freebetLost,
        matchedStakeOnOutcome: matchedWinners.reduce((s, b) => s + b.betAmount, 0),
      };
    });

    return {
      outcomes,
      totalMatchedStake,
      worstCase: Math.min(...outcomes.map(o => o.profit)),
      bestCase: Math.max(...outcomes.map(o => o.profit)),
      maxPayout: Math.max(...outcomes.map(o => o.totalPayout)),
      minPayout: Math.min(...outcomes.map(o => o.totalPayout)),
    };
  }, [matchedSites, freebetSites]);

  const pinnaclePlan = useMemo(() => {
    const hasBaseAnalysis =
      matchedSites.every((bookmaker) => bookmaker.assignedOutcome && getOdds(bookmaker) > 0) &&
      analysis.outcomes.length > 0;
    if (!hasBaseAnalysis) return null;

    const profitByOutcome: Record<Outcome, number> = { '1': 0, 'X': 0, '2': 0 };
    analysis.outcomes.forEach((o) => {
      profitByOutcome[o.outcome] = o.profit;
    });

    const targetProfit = Math.max(...OUTCOMES.map((outcome) => profitByOutcome[outcome]));
    const stakes: Record<Outcome, number> = { '1': 0, 'X': 0, '2': 0 };

    OUTCOMES.forEach((outcome) => {
      const odd = pinnacleOdds[outcome] || 0;
      const gap = targetProfit - profitByOutcome[outcome];
      if (odd > 0 && gap > 0) {
        stakes[outcome] = gap / odd;
      }
    });

    const allOddsFilled = OUTCOMES.every((outcome) => (pinnacleOdds[outcome] || 0) > 0);
    if (!allOddsFilled) {
      return { allOddsFilled: false, stakes, equalProfit: 0, totalStaked: 0 };
    }

    const totalStaked = OUTCOMES.reduce((sum, outcome) => sum + stakes[outcome], 0);
    const equalProfit = targetProfit - totalStaked;

    return { allOddsFilled: true, stakes, equalProfit, totalStaked };
  }, [analysis.outcomes, matchedSites, pinnacleOdds]);

  const updatePinnacleOdd = (outcome: Outcome, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed !== "" && !/^\d*(?:[.,]\d*)?$/.test(trimmed)) return;

    setPinnacleDraftOdds((prev) => ({ ...prev, [outcome]: raw }));

    if (trimmed === "") {
      setPinnacleOdds((prev) => {
        const next = { ...prev };
        delete next[outcome];
        return next;
      });
      return;
    }

    const normalized = trimmed.replace(",", ".");
    if (normalized === "." || normalized.endsWith(".")) return;
    const value = parseFloat(normalized);
    if (Number.isNaN(value) || value <= 0) return;
    setPinnacleOdds((prev) => ({ ...prev, [outcome]: value }));
  };

  const totalMatchedBonus = matchedSites.reduce((s, b) => s + b.betAmount, 0);
  const totalMatchedEV = matchedSites.reduce((s, b) => s + calcMatchedBonusEV(b.depositAmount, b.wagering || 1), 0);
  const totalFreebetValue = freebetSites.reduce((s, b) => s + (b.freebetValue || 0), 0);
  const allMatchedHaveOdds = matchedSites.every(b => b.assignedOutcome && getOdds(b) > 0);
  const d3FreebetWinners = useMemo(
    () =>
      d3FbResult
        ? fbSites.filter(
            (site) => site.assignedOutcome === d3FbResult && !!site.odds && site.odds > 0,
          )
        : [],
    [d3FbResult, fbSites],
  );
  const d3FreebetWithdrawTotal = useMemo(
    () =>
      d3FreebetWinners.reduce(
        (sum, site) => sum + site.stake * ((site.odds || 1) - 1),
        0,
      ),
    [d3FreebetWinners],
  );

  const handleSaveLog = () => {
    if (!matchName) return;
    const existing = logs.find((l) => l.person === personTag && l.matchName === matchName);
    const log: BetLog = {
      id: existing?.id || Date.now().toString(),
      date: existing?.date || new Date().toISOString(),
      matchName,
      person: personTag,
      bookmakers: JSON.parse(JSON.stringify(bookmakers)),
      worstCase: analysis.worstCase,
      bestCase: analysis.bestCase,
      totalStake: analysis.totalMatchedStake,
      result: selectedResult || existing?.result,
      pinnacleOdds: { ...pinnacleOdds },
      complementBookmaker: complementBookmaker.trim() || undefined,
      complementAccountOwner: complementAccountOwner.trim() || undefined,
      complementPlaced: { ...complementPlaced },
      fbMatchName: fbMatchName.trim() || undefined,
      fbHedgeComplementSite: fbHedgeComplementSite.trim() || undefined,
      fbSites: JSON.parse(JSON.stringify(fbSites)),
      mwMatchName: mwMatchName.trim() || undefined,
      mwSites: JSON.parse(JSON.stringify(mwSites)),
      mwCandidateSites: JSON.parse(JSON.stringify(mwCandidateSites)),
      day2StrategyNote: day2StrategyNote.trim() || undefined,
      d3MatchName: d3MatchName.trim() || undefined,
      d3Sites: JSON.parse(JSON.stringify(d3Sites)),
      d3Result: d3Result || existing?.d3Result,
      d3FbResult: d3FbResult || existing?.d3FbResult,
      day2Saved: existing?.day2Saved,
      day3Saved: existing?.day3Saved,
    };
    saveBetLog(log);
    setLogs(getBetLogs());
  };

  const applyScrapedOddsToBookmakers = (rows: ScrapedOddRow[]) => {
    const legacyIdsByName: Record<string, string> = {
      bet365: "bet365",
      unibet: "unibet",
      hajper: "hajper",
      dbet: "dbet",
      mrvegas: "mrvegas",
      megariches: "megariches",
      betsson: "betsson",
      x3000: "x3000",
      goldenbull: "goldenbull",
      "1x2": "1x2",
      vbet: "vbet",
      speedybet: "speedybet",
      snabbare: "snabbare",
      comeon: "comeon",
      bethard: "bethard",
      spelklubben: "spelklubben",
    };
    const rowByBookmakerId = new Map<string, ScrapedOddRow>();
    rows.forEach((row) => {
      const bookmakerId = row.bookmakerId || legacyIdsByName[normalizeName(row.bookmaker)];
      if (bookmakerId) rowByBookmakerId.set(bookmakerId, row);
    });

    let updated = 0;
    setBookmakers((prev) =>
      prev.map((bookmaker) => {
        const match = rowByBookmakerId.get(bookmaker.id);
        if (!match) {
          return {
            ...bookmaker,
            oddsHome: undefined,
            oddsDraw: undefined,
            oddsAway: undefined,
          };
        }
        updated += 1;
        return {
          ...bookmaker,
          oddsHome: match.home,
          oddsDraw: match.draw,
          oddsAway: match.away,
        };
      }),
    );
    return { updated };
  };

  const handleScrapeOddsComparison = async (urlOverride?: string, matchTitleOverride?: string) => {
    const target = (urlOverride ?? oddsScrapeUrl).trim();
    if (!target) {
      toast.error("Fyll i en URL till Oddsportal");
      return;
    }
    setIsScrapingOdds(true);
    try {
      const r = await fetch(apiUrl("/api/odds-comparison"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = (await r.json()) as
        | {
            ok: boolean;
            mode: "search";
            count?: number;
            query?: string;
            matches?: ScrapedMatch[];
            error?: string;
          }
        | {
            ok: boolean;
            mode: "url";
            count?: number;
            title?: string;
            odds?: ScrapedOddRow[];
            bookmakerResults?: BookmakerScrapeResult[];
            bestByOutcome?: Record<Outcome, { bookmaker: string; odds: number } | null>;
            error?: string;
          };
      if (!r.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      if (data.mode === "search") {
        const matches = data.matches || [];
        setScrapeMatches(matches);
        const summary = `Sökning: ${matches.length} match-länkar hittades`;
        setLastScrapeSummary(summary);
        toast.success(summary);
      } else {
        const oddsRows = data.odds || [];
        setBookmakerScrapeResults(data.bookmakerResults || []);
        const scrapedMatchName = cleanScrapedMatchName(matchTitleOverride || data.title);
        if (scrapedMatchName) {
          setMatchName(scrapedMatchName);
          setOddsSearchQuery(scrapedMatchName);
        }
        setLastScrapedOddsRows(oddsRows);
        const { updated } = applyScrapedOddsToBookmakers(oddsRows);
        setBestComplements(data.bestByOutcome || { '1': null, 'X': null, '2': null });
        const summary = `${data.title || "Sida"}: ${oddsRows.length} oddsrader, uppdaterade ${updated} av dina sidor`;
        setLastScrapeSummary(summary);
        if (oddsRows.length === 0) {
          toast.error(`Scrapern hittade matchen men 0 oddsrader. URL: ${target}`);
        } else {
          toast.success(summary);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Kunde inte skrapa odds just nu");
    } finally {
      setIsScrapingOdds(false);
    }
  };

  const searchOddsMatches = async (queryRaw: string, silent = false, targetMatch?: ScrapedMatch) => {
    const query = queryRaw.trim();
    if (!query) {
      setScrapeMatches([]);
      return;
    }
    if (query.length < 3) {
      setScrapeMatches([]);
      if (!silent) toast.error(t("welcome.minSearchChars"));
      return;
    }
    setIsScrapingOdds(true);
    try {
      const r = await fetch(apiUrl("/api/odds-comparison"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          ...(targetMatch ? { targetTitle: targetMatch.title, targetUrl: targetMatch.url } : {}),
        }),
      });
      const data = (await r.json()) as {
        ok: boolean;
        mode: "search";
        count?: number;
        matches?: ScrapedMatch[];
        title?: string;
        odds?: ScrapedOddRow[];
        bookmakerResults?: BookmakerScrapeResult[];
        bestByOutcome?: Record<Outcome, { bookmaker: string; odds: number } | null>;
        error?: string;
      };
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const matches = data.matches || [];
      setScrapeMatches(matches);
      if (!targetMatch) {
        const summary = `Sökning klar: ${matches.length} träffar. Välj exakt match för att hämta odds.`;
        setLastScrapeSummary(summary);
        if (!silent) toast.success(summary);
        return;
      }
      const oddsRows = data.odds || [];
      setLastScrapedOddsRows(oddsRows);
      setBookmakerScrapeResults(data.bookmakerResults || []);
      setBestComplements(oddsRows.length > 0 ? data.bestByOutcome || { '1': null, 'X': null, '2': null } : { '1': null, 'X': null, '2': null });
      const scrapedMatchName = cleanScrapedMatchName(data.title || matches[0]?.title);
      if (scrapedMatchName) {
        setMatchName(scrapedMatchName);
      }
      const { updated } = applyScrapedOddsToBookmakers(oddsRows);
      const summary =
        oddsRows.length > 0
          ? `Sökning klar: ${matches.length} träffar, ${oddsRows.length} oddsrader, uppdaterade ${updated} av dina sidor`
          : `Sökning klar: ${matches.length} träffar`;
      setLastScrapeSummary(summary);
      if (!silent) toast.success(summary);
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : "Kunde inte söka matcher");
    } finally {
      setIsScrapingOdds(false);
    }
  };

  const handleSearchOddsMatches = async () => {
    await searchOddsMatches(oddsSearchQuery, false);
  };

  const handleTestScraper = async () => {
    setIsScrapingOdds(true);
    try {
      const searchResponse = await fetch(apiUrl("/api/odds-comparison"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "psg" }),
      });
      const searchData = (await searchResponse.json()) as {
        ok: boolean;
        mode: "search";
        matches?: ScrapedMatch[];
        title?: string;
        odds?: ScrapedOddRow[];
        bookmakerResults?: BookmakerScrapeResult[];
        bestByOutcome?: Record<Outcome, { bookmaker: string; odds: number } | null>;
        error?: string;
      };
      if (!searchResponse.ok || !searchData.ok) {
        throw new Error(searchData.error || `HTTP ${searchResponse.status}`);
      }

      const firstMatch = (searchData.matches || [])[0];
      if (!firstMatch) {
        throw new Error("Scraper-test misslyckades: sökning på psg gav ingen match.");
      }

      const scrapeResponse = await fetch(apiUrl("/api/odds-comparison"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: firstMatch.title, targetTitle: firstMatch.title, targetUrl: firstMatch.url }),
      });
      const scrapeData = (await scrapeResponse.json()) as {
        ok: boolean;
        mode: "search";
        matches?: ScrapedMatch[];
        title?: string;
        odds?: ScrapedOddRow[];
        bookmakerResults?: BookmakerScrapeResult[];
        bestByOutcome?: Record<Outcome, { bookmaker: string; odds: number } | null>;
        error?: string;
      };
      if (!scrapeResponse.ok || !scrapeData.ok) {
        throw new Error(scrapeData.error || `HTTP ${scrapeResponse.status}`);
      }

      setOddsSearchQuery("psg");
      setScrapeMatches(scrapeData.matches || searchData.matches || []);
      setOddsScrapeUrl(firstMatch.url);
      const oddsRows = scrapeData.odds || [];
      setLastScrapedOddsRows(oddsRows);
      setBookmakerScrapeResults(scrapeData.bookmakerResults || []);
      setBestComplements(scrapeData.bestByOutcome || { '1': null, 'X': null, '2': null });
      applyScrapedOddsToBookmakers(oddsRows);

      if (oddsRows.length === 0) {
        const summary = `Scraper-test misslyckades: match hittades (${firstMatch.title}) men 0 oddsrader skrapades.`;
        setLastScrapeSummary(summary);
        toast.error(summary);
        return;
      }

      const summary = `Scraper OK: ${oddsRows.length} oddsrader från ${scrapeData.title || firstMatch.title}`;
      setLastScrapeSummary(summary);
      toast.success(summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scraper-test misslyckades";
      setLastScrapeSummary(message);
      toast.error(message);
    } finally {
      setIsScrapingOdds(false);
    }
  };

  useEffect(() => {
    const q = oddsSearchQuery.trim();
    if (q.length < 3) {
      setScrapeMatches([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void searchOddsMatches(q, true);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [oddsSearchQuery]);

  const handleSaveDay2 = () => {
    if (!matchName) return;
    const existing = logs.find(l => l.person === personTag && l.matchName === matchName);
    const log: BetLog = {
      id: existing?.id || Date.now().toString(),
      date: existing?.date || new Date().toISOString(),
      matchName,
      person: personTag,
      bookmakers: JSON.parse(JSON.stringify(bookmakers)),
      worstCase: analysis.worstCase,
      bestCase: analysis.bestCase,
      totalStake: analysis.totalMatchedStake,
      result: selectedResult || undefined,
      pinnacleOdds: { ...pinnacleOdds },
      complementBookmaker: complementBookmaker.trim() || undefined,
      complementAccountOwner: complementAccountOwner.trim() || undefined,
      complementPlaced: { ...complementPlaced },
      fbMatchName,
      fbHedgeComplementSite: fbHedgeComplementSite.trim() || undefined,
      fbSites: JSON.parse(JSON.stringify(fbSites)),
      mwMatchName,
      mwSites: JSON.parse(JSON.stringify(mwSites)),
      mwCandidateSites: JSON.parse(JSON.stringify(mwCandidateSites)),
      day2StrategyNote: day2StrategyNote.trim() || undefined,
      day2Saved: true,
      d3MatchName,
      d3Sites: JSON.parse(JSON.stringify(d3Sites)),
      d3FbResult: d3FbResult || undefined,
    };
    saveBetLog(log);
    setLogs(getBetLogs());
  };

  const handleSaveDay3 = () => {
    if (!matchName) return;
    const existing = logs.find(l => l.person === personTag && l.matchName === matchName);
    const log: BetLog = {
      id: existing?.id || Date.now().toString(),
      date: existing?.date || new Date().toISOString(),
      matchName,
      person: personTag,
      bookmakers: JSON.parse(JSON.stringify(bookmakers)),
      worstCase: analysis.worstCase,
      bestCase: analysis.bestCase,
      totalStake: analysis.totalMatchedStake,
      result: selectedResult || undefined,
      pinnacleOdds: { ...pinnacleOdds },
      complementBookmaker: complementBookmaker.trim() || undefined,
      complementAccountOwner: complementAccountOwner.trim() || undefined,
      complementPlaced: { ...complementPlaced },
      fbMatchName,
      fbHedgeComplementSite: fbHedgeComplementSite.trim() || undefined,
      fbSites: JSON.parse(JSON.stringify(fbSites)),
      mwMatchName,
      mwSites: JSON.parse(JSON.stringify(mwSites)),
      mwCandidateSites: JSON.parse(JSON.stringify(mwCandidateSites)),
      day2StrategyNote: day2StrategyNote.trim() || undefined,
      day2Saved: true,
      d3MatchName,
      d3Sites: JSON.parse(JSON.stringify(d3Sites)),
      d3Result: d3Result || undefined,
      d3FbResult: d3FbResult || undefined,
      day3Saved: true,
    };
    saveBetLog(log);
    setLogs(getBetLogs());
  };

  const handleLoadLog = (log: BetLog) => {
    setBookmakers(log.bookmakers);
    setMatchName(log.matchName);
    setPersonTag(log.person);
    setSelectedResult(log.result || null);
    setPinnacleOdds(log.pinnacleOdds || {});
    setPinnacleDraftOdds({});
    setComplementBookmaker(log.complementBookmaker || "Pinnacle");
    setComplementAccountOwner(log.complementAccountOwner || "");
    setComplementPlaced({
      '1': !!log.complementPlaced?.['1'],
      'X': !!log.complementPlaced?.['X'],
      '2': !!log.complementPlaced?.['2'],
    });
    setFbMatchName(log.fbMatchName || "");
    setFbHedgeComplementSite(log.fbHedgeComplementSite || "Pinnacle");
    setFbSites(log.fbSites || []);
    setMwMatchName(log.mwMatchName || "");
    setMwSites(log.mwSites || []);
    setMwCandidateSites(log.mwCandidateSites || log.mwSites || []);
    setDay2StrategyNote(log.day2StrategyNote || "");
    setD3MatchName(log.d3MatchName || "");
    setD3Sites(log.d3Sites || []);
    setD3Result(log.d3Result || null);
    setD3FbResult(log.d3FbResult || null);
    setView('calculator');
  };

  const handleDeleteLog = (id: string) => {
    deleteBetLog(id);
    setLogs(getBetLogs());
  };

  const handleReset = () => {
    setBookmakers(defaultBookmakers);
    setMatchName("");
    setSelectedResult(null);
    setD3Result(null);
    setD3FbResult(null);
    setD3Sites([]);
    setPinnacleOdds({});
    setPinnacleDraftOdds({});
    setComplementBookmaker("Pinnacle");
    setComplementAccountOwner("");
    setComplementPlaced({ '1': false, 'X': false, '2': false });
    setMwCandidateSites([]);
    setDay2StrategyNote("");
    setFbMatchName("");
    setFbHedgeComplementSite("Pinnacle");
    setFbSites([]);
    setMwMatchName("");
    setMwSites([]);
    setOddsScrapeUrl("https://www.oddsportal.com/");
    setOddsSearchQuery("");
    setScrapeMatches([]);
    setLastScrapedOddsRows([]);
    setBookmakerScrapeResults([]);
    setBestComplements({ '1': null, 'X': null, '2': null });
    setLastScrapeSummary("");
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <BrandHeader />
        {/* Header */}
        <motion.div {...fadeIn} className="relative z-20 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2 min-w-0">
            <h1 className="m-0">
              <button
                type="button"
                onClick={() => setView("calculator")}
                className="inline-flex items-center min-h-11 text-3xl font-extrabold tracking-tight rounded-md text-left px-1 -mx-1 py-1 -my-1 m-0 bg-transparent border-0 cursor-pointer hover:opacity-85 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background relative z-10"
                aria-label={t("welcome.backToCalculator")}
              >
                <span className="pointer-events-none bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent select-none">
                  Välkomstbonusar
                </span>
              </button>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="secondary" size="sm" className="text-xs relative shrink-0">
              <Link to="/bonus-optimizer">Bonus-optimerare</Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsRefreshing(true);
                sessionStorage.setItem('app-state', JSON.stringify({
                  view, bookmakers, matchName, personTag, selectedResult,
                  oddsScrapeUrl, oddsSearchQuery, scrapeMatches, lastScrapedOddsRows, bookmakerScrapeResults, bestComplements, lastScrapeSummary,
                  fbMatchName, fbHedgeComplementSite, fbSites, mwMatchName, mwSites, pinnacleOdds,
                  complementBookmaker, complementAccountOwner, complementPlaced,
                  mwCandidateSites,
                  day2StrategyNote,
                  d3MatchName, d3Sites, d3Result, d3FbResult,
                }));
                setTimeout(() => window.location.reload(), 500);
              }}
              className="text-xs"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant={view === "history" ? "secondary" : "outline"}
              size="sm"
              onClick={() => setView((v) => (v === "history" ? "calculator" : "history"))}
              className="text-xs relative shrink-0"
            >
              {view === "history" ? "Kalkylator" : "Loggad"}
              {logs.length > 0 && view !== "history" && (
                <span className="ml-1.5 bg-accent text-accent-foreground text-[10px] rounded-full px-1.5 py-0.5 font-bold">
                  {logs.length}
                </span>
              )}
              {logs.length > 0 && view === "history" && (
                <span className="ml-1.5 text-muted-foreground text-[10px] tabular-nums">({logs.length})</span>
              )}
            </Button>
          </div>
        </motion.div>

        <AnimatePresence mode="wait">
          {view === 'calculator' ? (
            <motion.div key="calc" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.3 }} className="space-y-6">

              {/* DAG 1 */}
              <div className="border-2 border-orange-500/60 rounded-xl p-4 space-y-4">
              <h2 className="text-lg font-bold text-foreground">📅 Dag 1</h2>

              {/* Match + Person + Save */}
              <motion.div {...fadeIn}>
                <Card>
                  <CardContent className="p-4 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                      <label className="text-sm text-foreground whitespace-nowrap">Match:</label>
                      <Input
                        className="font-medium"
                        placeholder="t.ex. Arsenal vs Chelsea"
                        value={matchName}
                        onChange={(e) => {
                          const v = e.target.value;
                          setMatchName(v);
                          setOddsSearchQuery(v);
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-foreground whitespace-nowrap">Person:</label>
                      <Input className="w-32 font-medium" placeholder="Namn" value={personTag} onChange={e => setPersonTag(e.target.value)} />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveLog} disabled={!matchName} className="text-xs font-semibold">
                        💾 Spara
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleReset} className="text-xs">
                        🔄 Rensa
                      </Button>
                    </div>
                    <div className="w-full grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                      <Input
                        className="text-xs"
                        placeholder={t("welcome.searchPlaceholder")}
                        value={oddsSearchQuery}
                        onChange={(e) => setOddsSearchQuery(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleSearchOddsMatches()}
                        disabled={isScrapingOdds}
                        className="text-xs"
                      >
                        {isScrapingOdds ? t("welcome.searching") : t("welcome.searchMatch")}
                      </Button>
                    </div>
                    {scrapeMatches.length > 0 && (
                      <div className="w-full space-y-1">
                        <div className="text-[11px] font-semibold text-foreground/80">
                          Välj match att hämta odds från ({scrapeMatches.length} träffar):
                        </div>
                        <div className="grid gap-1 max-h-64 overflow-y-auto pr-1">
                          {scrapeMatches.map((m) => (
                            <button
                              key={m.url}
                              type="button"
                              onClick={() => {
                                setOddsScrapeUrl(m.url);
                                setOddsSearchQuery(cleanScrapedMatchName(m.title) || m.title);
                                void searchOddsMatches(m.title, false, m);
                              }}
                              className="text-left rounded border border-border/40 px-2 py-1 text-xs hover:bg-muted/30"
                            >
                              <span className="font-medium">{m.title}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="w-full grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                      <Input
                        className="text-xs"
                        placeholder="Odds comparison URL (t.ex. https://www.oddsportal.com/...)"
                        value={oddsScrapeUrl}
                        onChange={(e) => setOddsScrapeUrl(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleScrapeOddsComparison()}
                        disabled={isScrapingOdds}
                        className="text-xs"
                      >
                        {isScrapingOdds ? t("welcome.fetchingOdds") : t("welcome.fetchOdds")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleTestScraper()}
                        disabled={isScrapingOdds}
                        className="text-xs"
                      >
                        🧪 Testa scraper
                      </Button>
                    </div>
                    {lastScrapeSummary && (
                      <div className="w-full space-y-1 text-xs text-foreground/80">
                        <div>
                          {lastScrapeSummary}
                          {lastScrapedOddsRows.length > 0 ? ` · Oddsrader i minne: ${lastScrapedOddsRows.length}` : ""}
                        </div>
                        {bookmakerScrapeResults.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {bookmakerScrapeResults.map((result) => (
                              <span
                                key={result.bookmakerId}
                                className={`rounded border px-1.5 py-0.5 ${
                                  result.status === "found"
                                    ? "border-emerald-500/40 text-emerald-700"
                                    : "border-border/60 text-muted-foreground"
                                }`}
                                title={result.error || result.title || result.sourceUrl || result.status}
                              >
                                {result.bookmaker}: {result.status === "found" ? "hittad" : result.status === "blocked" ? "blockerad" : "saknas"}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>

              {/* Person Tag */}
              {personTag && (
                <motion.div {...fadeIn}>
                  <Badge className="bg-primary/15 text-primary border border-primary/30 text-sm px-3 py-1">
                    👤 {personTag}s konton
                  </Badge>
                </motion.div>
              )}

              {/* MATCHED BONUSAR */}
              <motion.div {...fadeIn} className="space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-foreground">📋 Matched Bonusar</h2>
                </div>

                <BookmakerOddsTable bookmakers={allMatched} onUpdate={updateBm} variant="matched" />
              </motion.div>

              {/* FREEBETS */}
              <motion.div {...fadeIn} className="space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-foreground">🎁 Freebets</h2>
                  {allMatchedHaveOdds && analysis.minPayout < analysis.maxPayout && (
                    <Badge variant="outline" className="text-accent border-accent/30 text-[10px]">
                      Skillnad: {(analysis.maxPayout - analysis.minPayout).toFixed(0)}kr
                    </Badge>
                  )}
                </div>

                <BookmakerOddsTable bookmakers={allFreebets} onUpdate={updateBm} variant="freebet" />
              </motion.div>
              {/* Utfallsöversikt */}
              {allMatchedHaveOdds && analysis.outcomes.length > 0 && (
                <motion.div {...fadeIn}>
                  <Card className="border-accent/30">
                    <CardContent className="p-5 space-y-3">
                      <h2 className="text-lg font-bold text-foreground">{t("welcome.outcomeOverviewDay1")}</h2>
                      {(() => {
                        const active = matchedSites.filter(b => b.assignedOutcome && b.assignedOutcome !== 'used');
                        const warnings = OUTCOMES
                          .map(oc => ({ oc, count: active.filter(b => b.assignedOutcome === oc).length }))
                          .filter(x => x.count > 3);
                        return warnings.length > 0 ? warnings.map(w => (
                          <div key={w.oc} className="bg-yellow-500/25 border-2 border-yellow-500/70 rounded-lg p-4 text-sm text-yellow-200 font-bold text-center">
                            ⚠️ {w.count} valt på {w.oc}
                          </div>
                        )) : null;
                      })()}
                      <div className="grid grid-cols-3 gap-3">
                        {analysis.outcomes.map(o => (
                          <div key={o.outcome} className={`text-center rounded-lg border p-3 ${
                            o.outcome === '1' ? 'border-green-400/40 bg-green-500/10' :
                            o.outcome === 'X' ? 'border-blue-400/40 bg-blue-500/10' :
                            'border-red-400/40 bg-red-500/10'
                          }`}>
                            <div className="text-xs font-semibold text-foreground mb-1">
                              {o.outcome === '1' ? t("welcome.outcomeHomeWithCode") : o.outcome === 'X' ? t("welcome.outcomeDrawWithCode") : t("welcome.outcomeAwayWithCode")}
                            </div>
                            <div className="text-xs text-foreground/70 mb-1">
                              Utbetalning: {o.totalPayout.toFixed(0)} kr
                            </div>
                            <div className={`text-lg font-bold font-mono ${o.profit >= 0 ? 'text-primary' : 'text-destructive'}`}>
                              {o.profit >= 0 ? '+' : ''}{o.profit.toFixed(0)} kr
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between text-xs text-foreground/70 pt-1">
                        <span>Worst case: <span className="font-mono font-bold text-destructive">{analysis.worstCase.toFixed(0)} kr</span></span>
                        <span>Best case: <span className="font-mono font-bold text-primary">+{analysis.bestCase.toFixed(0)} kr</span></span>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              )}

              {allMatchedHaveOdds && (
                <motion.div {...fadeIn}>
                  <Card className="border-primary/30">
                    <CardContent className="p-5 space-y-4">
                      <h2 className="text-lg font-bold text-foreground">Komplementerring</h2>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-xs font-semibold text-foreground">Spelsida</label>
                          <Input
                            type="text"
                            placeholder="t.ex. Unibet"
                            value={complementBookmaker}
                            onChange={(e) => setComplementBookmaker(e.target.value)}
                            className="h-9"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-semibold text-foreground">Vems konto</label>
                          <Input
                            type="text"
                            placeholder={t("welcome.examplePlaceholder")}
                            value={complementAccountOwner}
                            onChange={(e) => setComplementAccountOwner(e.target.value)}
                            className="h-9"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        {OUTCOMES.map((outcome) => (
                          <div key={outcome} className="space-y-1">
                            <label className="text-xs font-semibold text-foreground">{OUTCOME_LABELS[outcome]}</label>
                            <Input
                              type="text"
                              inputMode="decimal"
                              placeholder="Odds"
                              value={pinnacleDraftOdds[outcome] ?? formatOddsValue(pinnacleOdds[outcome])}
                              onChange={(e) => updatePinnacleOdd(outcome, e.target.value)}
                              className="h-9 font-mono text-sm"
                            />
                          </div>
                        ))}
                      </div>
                      <div className="space-y-2 rounded-lg border border-border/40 bg-muted/20 p-3">
                        <div className="text-xs font-semibold text-foreground">{t("welcome.bestOddsHint")}</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {OUTCOMES.map((outcome) => {
                            const best = bestComplements[outcome];
                            return (
                              <div key={outcome} className="rounded border border-border/40 bg-background/70 p-2 text-xs space-y-1">
                                <div className="font-semibold text-foreground">{OUTCOME_LABELS[outcome]}</div>
                                {best ? (
                                  <>
                                    <div className="text-foreground/80">{best.bookmaker}</div>
                                    <div className="font-mono text-primary">{best.odds.toFixed(2)}</div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-[11px] w-full"
                                      onClick={() => {
                                        setComplementBookmaker(best.bookmaker);
                                        setPinnacleOdds((prev) => ({ ...prev, [outcome]: best.odds }));
                                        setPinnacleDraftOdds((prev) => {
                                          const next = { ...prev };
                                          delete next[outcome];
                                          return next;
                                        });
                                      }}
                                    >
                                      Använd för {outcome}
                                    </Button>
                                  </>
                                ) : (
                                  <div className="text-foreground/50">{t("welcome.noDataYet")}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {pinnaclePlan?.allOddsFilled ? (
                        <div className="space-y-3 border-t border-border/30 pt-3">
                          <div className="text-xs font-semibold text-foreground">
                            Lägg följande kompletteringsspel på {complementBookmaker.trim() || "vald spelsida"}:
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            {OUTCOMES.map((outcome) => {
                              const canPlace = pinnaclePlan.stakes[outcome] > 0;
                              return (
                                <div key={outcome} className="text-center rounded-lg border border-border/30 bg-background/60 p-3 space-y-2">
                                  <div className="text-xs font-semibold text-foreground">{OUTCOME_LABELS[outcome]}</div>
                                  <div className="text-lg font-bold font-mono text-primary">
                                    {canPlace ? `${pinnaclePlan.stakes[outcome].toFixed(0)} kr` : "—"}
                                  </div>
                                  <label className={`flex items-center justify-center gap-1.5 text-xs ${canPlace ? "text-foreground" : "text-foreground/40"}`}>
                                    <input
                                      type="checkbox"
                                      checked={complementPlaced[outcome]}
                                      disabled={!canPlace}
                                      onChange={(e) =>
                                        setComplementPlaced((prev) => ({ ...prev, [outcome]: e.target.checked }))
                                      }
                                    />
                                    Lagt
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                          <div className="text-xs text-foreground text-center">
                            Konto:{" "}
                            <span className="font-semibold">
                              {complementAccountOwner.trim() || "Ej angivet"}
                            </span>
                          </div>
                          <div className="text-xs text-foreground text-center">
                            Bekräftat lagt:{" "}
                            <span className="font-mono font-bold">
                              {OUTCOMES.filter((outcome) => complementPlaced[outcome]).length}/{OUTCOMES.filter((outcome) => pinnaclePlan.stakes[outcome] > 0).length}
                            </span>
                          </div>
                          <div className="text-xs text-foreground text-center">
                            Totalt att satsa: <span className="font-mono font-bold">{pinnaclePlan.totalStaked.toFixed(0)} kr</span>
                          </div>
                          <div className="text-xs text-foreground text-center">
                            Jämnat netto per utfall:{" "}
                            <span className={`font-mono font-bold ${pinnaclePlan.equalProfit >= 0 ? 'text-primary' : 'text-destructive'}`}>
                              {pinnaclePlan.equalProfit >= 0 ? "+" : ""}{pinnaclePlan.equalProfit.toFixed(0)} kr
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                </motion.div>
              )}
              </div>

              {/* DAG 2 */}
              <div className="border-2 border-yellow-500/60 rounded-xl p-4 space-y-4">
              {/* DAG 2 — Resultat */}
              {allMatchedHaveOdds && (
                <motion.div {...fadeIn}>
                  <Card className="border-accent/30">
                    <CardContent className="p-5 space-y-4">
                      <h2 className="text-lg font-bold text-foreground">{t("welcome.day1MoneyOn")}</h2>
                      
                      <div className="flex items-center gap-2">
                        {OUTCOMES.map(oc => (
                          <Button
                            key={oc}
                            size="sm"
                            variant={selectedResult === oc ? 'default' : 'outline'}
                            className={`text-sm h-9 px-4 ${selectedResult === oc ? '' : 'opacity-60'}`}
                            onClick={() => {
                              const newResult = selectedResult === oc ? null : oc;
                              setSelectedResult(newResult);
                              setD3Result(null);
                              setD3FbResult(null);
                              setD3Sites([]);
                              if (!newResult) {
                                setFbSites([]);
                                setMwSites([]);
                                setMwCandidateSites([]);
                                return;
                              }
                              if (newResult) {
                                // Populate Step 3: freebets
                                const fbs = freebetSites.filter(b => b.assignedOutcome && b.assignedOutcome !== 'used');
                                setFbSites(fbs.map(b => ({
                                  id: b.id, name: b.name, stake: b.freebetValue || 0, isFreebet: true,
                                })));
                                // Populate Step 4: matched winners
                                const matchedBms = bookmakers.filter(b => b.bonusType === 'matched' && b.assignedOutcome && b.assignedOutcome !== 'used' && getOdds(b) > 0);
                                const mw = matchedBms.filter(b => b.assignedOutcome === newResult);
                                const mappedMw = mw.map(b => ({
                                  id: b.id, name: b.name, stake: Math.round(b.betAmount * getOdds(b)),
                                }));
                                setMwCandidateSites(mappedMw);
                                setMwSites(mappedMw);
                              }
                            }}
                          >
                            {oc === '1' ? t("welcome.outcomeHomeWithCode") : oc === 'X' ? t("welcome.outcomeDrawWithCode") : t("welcome.outcomeAwayWithCode")}
                          </Button>
                        ))}
                      </div>

                      {selectedResult && (() => {
                        const freebetWins = freebetSites.filter(
                          b => b.assignedOutcome === selectedResult && getOdds(b) > 0,
                        );
                        const matchedWins = matchedSites.filter(
                          b => b.assignedOutcome === selectedResult && getOdds(b) > 0,
                        );

                        return (freebetWins.length > 0 || matchedWins.length > 0) ? (
                          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
                            {freebetWins.length > 0 && (
                              <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 space-y-1">
                                <div className="text-xs font-bold text-primary">🎁 Freebet — vann</div>
                                {freebetWins.map(b => (
                                  <div key={b.id} className="text-xs font-mono text-primary flex justify-between">
                                    <span>{b.name}</span>
                                    <span>+{((b.freebetValue || 0) * (getOdds(b) - 1)).toFixed(0)} kr</span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {matchedWins.length > 0 && (
                              <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 space-y-1">
                                <div className="text-xs font-bold text-primary">💰 Matched — vann</div>
                                {matchedWins.map(b => (
                                  <div key={b.id} className="text-xs font-mono text-primary flex justify-between">
                                    <span>{b.name}</span>
                                    <span>+{(b.betAmount * getOdds(b)).toFixed(0)} kr</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </motion.div>
                        ) : null;
                      })()}
                    </CardContent>
                  </Card>
                </motion.div>
              )}



              {selectedResult && fbSites.length > 0 && (
                <MatchCalculator
                  title="🎁 Dag 2 Freebet"
                  sites={fbSites}
                  onSitesChange={setFbSites}
                  matchName={fbMatchName}
                  onMatchNameChange={setFbMatchName}
                  allowMatchedDay2FreebetTab
                  hedgeComplementSite={fbHedgeComplementSite}
                  onHedgeComplementSiteChange={setFbHedgeComplementSite}
                  matchedFundingSites={mwSites}
                  onMatchedFundingSitesChange={setMwSites}
                />
              )}

              {/* DAG 2 — Matched winners match */}
              {selectedResult && mwSites.length > 0 && (
                <MatchCalculator
                  title="Dag 2 matched"
                  sites={mwSites}
                  onSitesChange={setMwSites}
                  matchName={mwMatchName}
                  onMatchNameChange={setMwMatchName}
                  allowStakeEdit
                  allowConsume
                />
              )}

              {/* Dag 2 Save button */}
              {selectedResult && (
                <motion.div {...fadeIn} className="space-y-2">
                  <Button size="sm" onClick={handleSaveDay2} disabled={!matchName} className="text-xs font-semibold w-full">
                    💾 Spara Dag 2
                  </Button>
                </motion.div>
              )}
              </div>

              {/* DAG 3 — Freebet-resultat + omsättning matched bets */}
              {selectedResult && (fbSites.length > 0 || mwSites.length > 0) && (
                <div className="border-2 border-green-500/60 rounded-xl p-4 space-y-4">
                  <h2 className="text-lg font-bold text-foreground">{t("welcome.day3MoneyOn")}</h2>

                  {fbSites.length > 0 && (
                    <motion.div {...fadeIn}>
                      <Card className="border-primary/30">
                        <CardContent className="p-4 space-y-3">
                          <h3 className="text-sm font-bold text-foreground">{t("welcome.freebetResultQuestion")}</h3>
                          <div className="flex items-center gap-2">
                            {OUTCOMES.map(oc => (
                              <Button
                                key={oc}
                                size="sm"
                                variant={d3FbResult === oc ? 'default' : 'outline'}
                                className={`text-sm h-9 px-4 ${d3FbResult === oc ? '' : 'opacity-60'}`}
                                onClick={() => setD3FbResult(d3FbResult === oc ? null : oc)}
                              >
                                {oc === '1' ? t("welcome.outcomeHomeWithCode") : oc === 'X' ? t("welcome.outcomeDrawWithCode") : t("welcome.outcomeAwayWithCode")}
                              </Button>
                            ))}
                          </div>

                          {d3FbResult && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
                              <div className="rounded-lg border border-primary/20 bg-primary/10 p-3 space-y-1">
                                <div className="text-xs font-bold text-primary">
                                  {d3FreebetWinners.length > 0
                                    ? t("welcome.withdrawableProfitTitle")
                                    : t("welcome.noFreebetWon")}
                                </div>
                                {d3FreebetWinners.map(site => (
                                  <div key={site.id} className="text-xs font-mono text-primary flex justify-between">
                                    <span>{site.name}</span>
                                    <span>+{(site.stake * ((site.odds || 1) - 1)).toFixed(0)} kr</span>
                                  </div>
                                ))}
                                {d3FreebetWinners.length > 0 && (
                                  <div className="border-t border-primary/20 pt-1 mt-1 text-xs font-semibold text-primary flex justify-between">
                                    <span>{t("welcome.totalWithdrawable")}</span>
                                    <span className="font-mono">+{d3FreebetWithdrawTotal.toFixed(0)} kr</span>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </CardContent>
                      </Card>
                    </motion.div>
                  )}

                  {mwSites.length > 0 && (
                    <motion.div {...fadeIn}>
                    <Card className="border-green-500/30">
                      <CardContent className="p-4 space-y-3">
                        <h3 className="text-sm font-bold text-foreground">{t("welcome.matchedWinnerResultQuestion")}</h3>
                        <div className="flex items-center gap-2">
                          {OUTCOMES.map(oc => (
                            <Button
                              key={oc}
                              size="sm"
                              variant={d3Result === oc ? 'default' : 'outline'}
                              className={`text-sm h-9 px-4 ${d3Result === oc ? 'bg-green-600 hover:bg-green-700' : 'opacity-60'}`}
                              onClick={() => {
                                const newResult = d3Result === oc ? null : oc;
                                setD3Result(newResult);

                                if (!newResult) {
                                  setD3Sites([]);
                                  return;
                                }

                                const nextSites = mwSites
                                  .filter((site) => site.assignedOutcome === newResult)
                                  .map((site) => {
                                    const bm = allMatched.find((bookmaker) => bookmaker.id === site.id);
                                    if (!bm) return null;

                                    const totalRequired = bm.depositAmount * (bm.wagering || 1);
                                    const omsattHittills = bm.betAmount + site.stake;
                                    const remaining = Math.max(0, totalRequired - omsattHittills);

                                    return remaining > 0
                                      ? {
                                          id: bm.id,
                                          name: bm.name,
                                          stake: remaining,
                                        }
                                      : null;
                                  })
                                  .filter(Boolean) as BetSide[];

                                setD3Sites(nextSites);
                              }}
                            >
                              {oc === '1' ? t("welcome.outcomeHomeWithCode") : oc === 'X' ? t("welcome.outcomeDrawWithCode") : t("welcome.outcomeAwayWithCode")}
                            </Button>
                          ))}
                        </div>

                        {/* Show what happened */}
                        {d3Result && (() => {
                          const winners = mwSites.filter(s => s.assignedOutcome === d3Result && s.odds && s.odds > 0);
                          return winners.length > 0 ? (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-1">
                              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 space-y-1">
                                <div className="text-xs font-bold text-green-400">{t("welcome.wonOnWinnerMatch")}</div>
                                {winners.map(s => (
                                  <div key={s.id} className="text-xs font-mono text-green-400 flex justify-between">
                                    <span>{s.name}</span>
                                    <span>+{(s.stake * (s.odds! - 1)).toFixed(0)} kr vinst</span>
                                  </div>
                                ))}
                              </div>
                            </motion.div>
                          ) : null;
                        })()}
                      </CardContent>
                    </Card>
                    </motion.div>
                  )}

                  {/* Wagering overview */}
                  {d3Result && d3Sites.length > 0 && (
                    <motion.div {...fadeIn}>
                      <Card className="border-green-500/30 bg-green-500/5">
                        <CardContent className="p-4 space-y-3">
                          <h3 className="text-sm font-bold text-foreground">{t("welcome.accountTurnover")}</h3>
                          <div className="grid gap-2">
                            {d3Sites.map((site) => {
                              const bm = allMatched.find((bookmaker) => bookmaker.id === site.id);
                              const dag2Bet = mwSites.find((matchSite) => matchSite.id === site.id);

                              if (!bm || !dag2Bet) return null;

                              const totalRequired = bm.depositAmount * (bm.wagering || 1);
                              const omsattHittills = bm.betAmount + dag2Bet.stake;
                              const remaining = Math.max(0, totalRequired - omsattHittills);
                              const pct = Math.min(100, (omsattHittills / totalRequired) * 100);

                              return (
                                <div key={bm.id} className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-2">
                                  <div className="flex items-center justify-between gap-3 text-xs">
                                    <BookmakerName name={bm.name} />
                                    <span className="font-mono text-foreground">
                                      Omsatt: {omsattHittills.toFixed(0)} / {totalRequired.toFixed(0)} kr
                                    </span>
                                  </div>
                                  <div className="flex-1 bg-muted/30 rounded-full h-2 overflow-hidden">
                                    <div className="bg-green-500 h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
                                  </div>
                                  <div className="flex justify-between gap-3 text-[11px] text-foreground">
                                    <span>Dag 1: <span className="font-mono">{bm.betAmount.toFixed(0)} kr</span></span>
                                    <span>Dag 2: <span className="font-mono">{dag2Bet.stake.toFixed(0)} kr</span></span>
                                  </div>
                                  <div className="flex justify-between gap-3 text-[11px]">
                                    <span className="text-foreground">{t("welcome.needsTurnoverNow")}</span>
                                    <span className="font-mono font-bold text-green-400">{remaining.toFixed(0)} kr</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  )}

                  {/* Dag 3 MatchCalculator for remaining wagering */}
                  {d3Result && d3Sites.length > 0 && (
                    <MatchCalculator
                      title={t("welcome.day3Wagering")}
                      sites={d3Sites}
                      onSitesChange={setD3Sites}
                      matchName={d3MatchName}
                      onMatchNameChange={setD3MatchName}
                    />
                  )}

                  {d3Result && d3Sites.length === 0 && (
                    <motion.div {...fadeIn}>
                      <div className="text-center text-sm text-green-400 font-bold py-4">
                        ✅ Alla konton är färdigomsatta!
                      </div>
                    </motion.div>
                  )}

                  {/* Dag 3 Save button */}
                  <motion.div {...fadeIn}>
                    <Button size="sm" onClick={handleSaveDay3} disabled={!matchName} className="text-xs font-semibold w-full bg-green-600 hover:bg-green-700">
                      💾 Spara Dag 3
                    </Button>
                  </motion.div>
                </div>
              )}
            </motion.div>
          ) : (
            /* HISTORY VIEW */
            <motion.div key="history" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }} className="space-y-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto gap-2 font-semibold border-primary/40 hover:bg-primary/10"
                onClick={() => setView("calculator")}
              >
                <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
                Tillbaka till kalkylatorn
              </Button>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-lg font-bold text-foreground">{t("welcome.savedBets")}</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={importLogsRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={handleImportBetLogsFile}
                  />
                  <Button type="button" size="sm" variant="outline" className="text-xs" onClick={handleExportBetLogs}>
                    Exportera backup
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="text-xs" onClick={() => importLogsRef.current?.click()}>
                    Importera backup
                  </Button>
                  <Button type="button" size="sm" variant="secondary" className="text-xs" onClick={refreshLogsFromStorage}>
                    Läs om listan
                  </Button>
                </div>
              </div>

              {logs.length === 0 ? (
                <Card>
                  <CardContent className="p-8 space-y-4 text-foreground text-sm">
                    <p className="text-center">{t("welcome.noSavedBets")}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed border-t border-border/40 pt-4">
                      {storageDebugLine}
                    </p>
                    <p className="text-xs text-center text-muted-foreground">
                      Spara från kalkylatorn med <span className="font-medium text-foreground">💾 Spara</span>, eller importera en tidigare JSON-backup.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-3">
                  {[...logs].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map((log, i) => {
                    const activeBms = log.bookmakers.filter(b => b.assignedOutcome && b.assignedOutcome !== 'used');
                    const winners = log.result ? activeBms.filter(b => b.assignedOutcome === log.result) : [];
                    const losers = log.result ? activeBms.filter(b => b.assignedOutcome !== log.result) : [];
                    const freebetWinners = winners.filter(b => b.bonusType === 'freebet');
                    const matchedWinners = winners.filter(b => b.bonusType === 'matched');
                    const matchedLosers = losers.filter(b => b.bonusType === 'matched');

                    const getOddsForBm = (b: Bookmaker) => {
                      if (b.assignedOutcome === '1') return b.oddsHome || 0;
                      if (b.assignedOutcome === 'X') return b.oddsDraw || 0;
                      if (b.assignedOutcome === '2') return b.oddsAway || 0;
                      return 0;
                    };

                    return (
                    <motion.div key={log.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.25 }}>
                      <Card className={`transition-all duration-300 ${log.day3Saved ? 'bg-green-400/20 border-green-400/50' : log.result ? 'bg-yellow-400/20 border-yellow-400/50' : 'bg-orange-400/20 border-orange-400/50'}`}>
                        <CardContent className="p-4 space-y-3">
                          {/* Header row */}
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <span className="font-bold text-sm text-foreground">{log.matchName}</span>
                              <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px]">
                                👤 {log.person}
                              </Badge>
                              <Badge className={`text-[10px] ${log.day3Saved ? 'bg-green-400/15 text-green-400 border-green-400/30' : log.result ? 'bg-accent/15 text-accent border-accent/30' : 'bg-muted/30 text-foreground border-border/30'}`}>
                                📅 {log.day3Saved ? 'Dag 3' : log.result ? 'Dag 2' : 'Dag 1'}
                              </Badge>
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={() => handleLoadLog(log)}>
                                📂
                              </Button>
                              <Button size="sm" variant="outline" className="text-xs h-7 px-2 text-destructive hover:text-destructive" onClick={() => handleDeleteLog(log.id)}>
                                🗑
                              </Button>
                            </div>
                          </div>

                          {/* Result buttons */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-foreground">Resultat:</span>
                            {OUTCOMES.map(oc => (
                              <Button
                                key={oc}
                                size="sm"
                                variant={log.result === oc ? 'default' : 'outline'}
                                className={`text-xs h-7 px-3 ${log.result === oc ? '' : 'opacity-60'}`}
                                onClick={() => {
                                  updateBetLogResult(log.id, oc);
                                  setLogs(getBetLogs());
                                }}
                              >
                                {oc === '1' ? t("welcome.outcomeHomeWithCode") : oc === 'X' ? t("welcome.outcomeDrawWithCode") : t("welcome.outcomeAwayWithCode")}
                              </Button>
                            ))}
                          </div>

                          {/* Result breakdown */}
                          {log.day2StrategyNote && (
                            <div className="rounded-lg border border-border/30 bg-background/50 p-2">
                              <div className="text-[11px] font-semibold text-foreground/80">Dag 2 strategi:</div>
                              <div className="text-xs text-foreground">{log.day2StrategyNote}</div>
                            </div>
                          )}

                          {(log.complementBookmaker ||
                            log.complementAccountOwner ||
                            log.fbMatchName ||
                            log.fbHedgeComplementSite ||
                            log.mwMatchName ||
                            log.d3MatchName) && (
                            <div className="rounded-lg border border-border/30 bg-muted/20 p-2 space-y-1">
                              <div className="text-[11px] font-semibold text-foreground/80">Sparade uppgifter</div>
                              {log.complementBookmaker && (
                                <div className="text-xs text-foreground">
                                  Kompletteringssida: <span className="font-mono">{log.complementBookmaker}</span>
                                </div>
                              )}
                              {log.complementAccountOwner && (
                                <div className="text-xs text-foreground">
                                  Kompletteringskonto: <span className="font-mono">{log.complementAccountOwner}</span>
                                </div>
                              )}
                              {log.fbMatchName && (
                                <div className="text-xs text-foreground">
                                  Dag 2 freebet-match: <span className="font-medium">{log.fbMatchName}</span>
                                </div>
                              )}
                              {log.fbHedgeComplementSite && (
                                <div className="text-xs text-foreground">
                                  Dag 2 motspel / komplettering: <span className="font-mono">{log.fbHedgeComplementSite}</span>
                                </div>
                              )}
                              {log.mwMatchName && (
                                <div className="text-xs text-foreground">
                                  Dag 2 vinnare-match: <span className="font-medium">{log.mwMatchName}</span>
                                </div>
                              )}
                              {log.d3MatchName && (
                                <div className="text-xs text-foreground">
                                  Dag 3 omsättning: <span className="font-medium">{log.d3MatchName}</span>
                                </div>
                              )}
                            </div>
                          )}

                          {log.result && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2 pt-2 border-t border-border/30">
                              {/* Freebet winners */}
                              {freebetWinners.length > 0 && (
                                <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 space-y-1">
                                  <div className="text-xs font-bold text-primary">🎁 Freebet — vann</div>
                                  {freebetWinners.map(b => (
                                    <div key={b.id} className="text-xs font-mono text-primary flex justify-between">
                                      <span>{b.name}</span>
                                      <span>+{((b.freebetValue || 0) * getOddsForBm(b)).toFixed(0)} kr</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Matched winners - collect */}
                              {matchedWinners.length > 0 && (
                                <div className="bg-primary/10 border border-primary/20 rounded-lg p-3 space-y-1">
                                  <div className="text-xs font-bold text-primary">💰 Matched — vann</div>
                                  {matchedWinners.map(b => (
                                    <div key={b.id} className="text-xs font-mono text-primary flex justify-between">
                                      <span>{b.name}</span>
                                      <span>+{(b.betAmount * getOddsForBm(b)).toFixed(0)} kr</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </motion.div>
                          )}
                        </CardContent>
                      </Card>
                    </motion.div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default Index;
