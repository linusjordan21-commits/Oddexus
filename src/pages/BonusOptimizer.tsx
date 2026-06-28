import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useUserSettings } from "@/hooks/useUserSettings";
import { ArrowLeft, ChevronDown, ChevronRight, Copy, RefreshCw } from "lucide-react";
import { BrandHeader } from "@/components/BrandHeader";
import { toast } from "sonner";
import { apiUrl } from "@/lib/apiUrl";
import BookmakerName from "@/components/BookmakerName";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BONUS_BOOKMAKER_NAMES,
  computeWageringProgress,
  optimizeBonusMatch,
  type BonusBookmakerId,
  type ContinuationPlan,
  type ContinuationResult,
  type FreebetVoucher,
  type BonusOptimizationPlan,
  type BonusOptimizationResult,
  type BonusPortfolio,
  type OddsTriple,
  type Outcome,
  type WageringAccount,
  type WageringProgress,
} from "@/lib/bonusOptimizer";
import { loadBonusPortfolio, saveBonusPortfolio } from "@/lib/bonusPortfolio";
import { getBetLogs, saveBetLog, syncBetLogsOnLoad, type BetLog, type Bookmaker } from "@/lib/bookmakers";

type BestBonusMatch = {
  title: string;
  startTs?: string;
  league?: string;
  odds: Partial<Record<BonusBookmakerId, OddsTriple>>;
  splitMatches?: Array<{
    title: string;
    startTs?: string;
    league?: string;
    odds: Partial<Record<BonusBookmakerId, OddsTriple>>;
  }>;
  optimization: BonusOptimizationResult;
  externalComplement?: ExternalComplementPlan | null;
  unavailableBookmakerIds?: BonusBookmakerId[];
  staleBookmakerIds?: BonusBookmakerId[];
  mirroredBookmakerIds?: BonusBookmakerId[];
  mirroredBookmakers?: Array<{
    bookmakerId: BonusBookmakerId;
    bookmaker: string;
    fromBookmakerId?: BonusBookmakerId;
    fromBookmaker?: string;
  }>;
};

type ContinuationMatch = {
  title: string;
  startTs?: string;
  league?: string;
  odds: Partial<Record<BonusBookmakerId, OddsTriple>>;
  optimization: ContinuationResult;
  /** Matched-konton som saknar odds på denna match (ens via systerbrand) → utesluts ur planen. */
  missingAccountBookmakers?: Array<{ bookmakerId: BonusBookmakerId; bookmaker: string }>;
  unavailableBookmakerIds?: BonusBookmakerId[];
  staleBookmakerIds?: BonusBookmakerId[];
  mirroredBookmakers?: Array<{
    bookmakerId: BonusBookmakerId;
    bookmaker: string;
    fromBookmakerId?: BonusBookmakerId;
    fromBookmaker?: string;
  }>;
};

type BonusHistoryLog = BetLog & { bonusOptimizer: NonNullable<BetLog["bonusOptimizer"]> };
type BonusOptimizerRound = NonNullable<BetLog["bonusOptimizer"]>["rounds"][number];
type EarnedFreebet = NonNullable<NonNullable<BetLog["bonusOptimizer"]>["earnedFreebets"]>[number];

type ExternalComplementPlan = {
  bets: Array<{
    outcome: Outcome;
    bookmakerId: string;
    bookmaker: string;
    stake: number;
    odds: number;
    grossReturn: number;
  }>;
  totalStake: number;
  paybackPerOutcome: Record<Outcome, number>;
  accountReturnPerOutcome: Record<Outcome, number>;
  stakeMinusReturnPerOutcome: Record<Outcome, number>;
  minPayback: number;
  averagePayback: number;
  worstCaseEdgePct: number;
  averageEdgePct: number;
  outcomeSpread: number;
  improvementWorstEdgePct: number;
  improvementMinPayback: number;
};

const PERSON_STORAGE_KEY = "bonus-optimizer-person";
const DISTRIBUTION_TOLERANCE = 1;

const OUTCOME_ACCENT_CLASSES: Record<Outcome, string> = {
  "1": "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  X: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  "2": "border-red-500/30 bg-red-500/10 text-red-300",
};

const OUTCOME_BADGE_CLASSES: Record<Outcome, string> = {
  "1": "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
  X: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  "2": "bg-red-500/15 text-red-300 border border-red-500/30",
};

function formatCurrency(value: number) {
  return `${Math.round(value).toLocaleString("sv-SE")} kr`;
}

function formatSignedCurrency(value: number) {
  const rounded = Math.round(value);
  const prefix = rounded > 0 ? "+" : "";
  return `${prefix}${rounded.toLocaleString("sv-SE")} kr`;
}

function formatMinusResult(value: number) {
  const rounded = Math.round(value);
  if (rounded > 0) return `${rounded.toLocaleString("sv-SE")} kr minus`;
  if (rounded < 0) return `${Math.abs(rounded).toLocaleString("sv-SE")} kr plus`;
  return "0 kr";
}

function formatPercent(value: number) {
  return `${value.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

function formatLossEdgePct(averageEdgePct: number) {
  return formatPercent(Math.max(0, -averageEdgePct));
}

function formatWorstLossEdgePct(worstCaseEdgePct: number) {
  return formatPercent(Math.max(0, -worstCaseEdgePct));
}

function formatOddsDisplay(value: number) {
  return value.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function formatShortDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const month = date.toLocaleString("sv-SE", { month: "long" });
  const day = date.toLocaleString("sv-SE", { day: "2-digit" });
  const time = date.toLocaleString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return `${month} ${day} ${time}`;
}

function teamsFromMatchTitle(title: string) {
  const normalized = title.replace(/\s+/g, " ").trim();
  const parts =
    normalized.split(/\s+vs\.?\s+/i).length === 2
      ? normalized.split(/\s+vs\.?\s+/i)
      : normalized.split(/\s+-\s+/);
  return {
    home: parts[0]?.trim() || "Hemma",
    away: parts[1]?.trim() || "Borta",
  };
}

const TEAM_NAME_ABBREVIATIONS = [
  "FC",
  "AFC",
  "CF",
  "SC",
  "FK",
  "SK",
  "BK",
  "IF",
  "FF",
  "AC",
  "CD",
  "RC",
  "SV",
  "AS",
  "US",
  "SSC",
  "VFB",
  "VfB",
];

function searchFriendlyTeamName(name: string) {
  const abbreviationPattern = TEAM_NAME_ABBREVIATIONS.join("|");
  return name
    .replace(new RegExp(`\\b(?:${abbreviationPattern})\\.?\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function outcomeName(title: string, outcome: Outcome, drawLabel = "Draw") {
  const teams = teamsFromMatchTitle(title);
  if (outcome === "1") return teams.home;
  if (outcome === "2") return teams.away;
  return drawLabel;
}

function parseOddsInput(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  if (normalized === "" || normalized === "." || /\.{2,}/.test(normalized)) return null;
  const value = parseFloat(normalized);
  if (Number.isNaN(value) || value < 1.01) return null;
  return value;
}

function matchCardKey(match: { title: string; startTs?: string }) {
  return `${match.title}\t${match.startTs ?? ""}`;
}

function oddsOverrideKey(bookmakerId: string, outcome: Outcome) {
  return `${bookmakerId}:${outcome}`;
}

function applyOddsOverrides(
  odds: Partial<Record<BonusBookmakerId, OddsTriple>>,
  overrides: Record<string, number>,
): Partial<Record<BonusBookmakerId, OddsTriple>> {
  const next = Object.fromEntries(
    Object.entries(odds).map(([bookmakerId, triple]) => [bookmakerId, { ...(triple as OddsTriple) }]),
  ) as Partial<Record<BonusBookmakerId, OddsTriple>>;

  for (const [key, value] of Object.entries(overrides)) {
    const [bookmakerId, outcome] = key.split(":") as [BonusBookmakerId, Outcome];
    if (!bookmakerId || !outcome || !next[bookmakerId]) continue;
    next[bookmakerId] = { ...next[bookmakerId]!, [outcome]: value };
  }

  return next;
}

function setMatchedBonusEnabled(portfolio: BonusPortfolio, id: string, enabled: boolean): BonusPortfolio {
  return {
    ...portfolio,
    matched: portfolio.matched.map((bonus) => (bonus.id === id ? { ...bonus, enabled } : bonus)),
  };
}

function setFreebetBonusEnabled(portfolio: BonusPortfolio, id: string, enabled: boolean): BonusPortfolio {
  return {
    ...portfolio,
    freebets: portfolio.freebets.map((bonus) => (bonus.id === id ? { ...bonus, enabled } : bonus)),
  };
}

function planToBookmakers(plan: BonusOptimizationPlan): Bookmaker[] {
  const matched = plan.matched.map((bet) => ({
    id: bet.bookmakerId,
    name: bet.bookmaker,
    bonusType: "matched" as const,
    depositAmount: bet.deposit,
    betAmount: bet.stake,
    wagering: bet.wagerRequired / Math.max(1, bet.deposit),
    oddsHome: bet.outcome === "1" ? bet.odds : undefined,
    oddsDraw: bet.outcome === "X" ? bet.odds : undefined,
    oddsAway: bet.outcome === "2" ? bet.odds : undefined,
    assignedOutcome: bet.outcome,
    status: "wagering" as const,
  }));
  const freebets = plan.freebets.map((bet) => ({
    id: bet.bookmakerId,
    name: bet.bookmaker,
    bonusType: "freebet" as const,
    depositAmount: bet.amount,
    betAmount: 0,
    freebetValue: bet.amount,
    oddsHome: bet.outcome === "1" ? bet.odds : undefined,
    oddsDraw: bet.outcome === "X" ? bet.odds : undefined,
    oddsAway: bet.outcome === "2" ? bet.odds : undefined,
    assignedOutcome: bet.outcome,
    status: "freebet" as const,
  }));
  return [...matched, ...freebets];
}

function accountFromMatchedBet(bet: BonusOptimizationPlan["matched"][number], sourceRound = 1): WageringAccount {
  return {
    bookmakerId: bet.bookmakerId,
    bookmaker: bet.bookmaker,
    balance: bet.grossReturn,
    minOdds: bet.odds >= 1.9 ? 1.9 : 1.8,
    wageringRemaining: bet.wagerRemainingAfterBet,
    sourceRound,
  };
}

function vouchersFromPortfolio(portfolio: BonusPortfolio): FreebetVoucher[] {
  return portfolio.freebets
    .filter((bonus) => bonus.enabled)
    .map((bonus) => ({
      bookmakerId: bonus.id,
      bookmaker: BONUS_BOOKMAKER_NAMES[bonus.id],
      amount: bonus.amount,
      minOdds: bonus.minOdds,
    }));
}

function remainingAccountsAfterContinuation(plan: ContinuationPlan, result: Outcome): WageringAccount[] {
  return plan.wageringBets
    .filter((bet) => bet.outcome === result && bet.wageringRemainingAfterBet > 0)
    .map((bet) => ({
      bookmakerId: bet.bookmakerId,
      bookmaker: bet.bookmaker,
      balance: bet.reserve + bet.grossReturn,
      minOdds: bet.odds >= 1.9 ? 1.9 : 1.8,
      wageringRemaining: bet.wageringRemainingAfterBet,
    }));
}

function normalizePersonName(value: string) {
  return value.trim().replace(/\s+/g, " ") || "Person 1";
}

export default function BonusOptimizer() {
  const { t } = useUserSettings();
  const [portfolio, setPortfolio] = useState<BonusPortfolio>(() => loadBonusPortfolio());
  const [personName, setPersonName] = useState(() => {
    if (typeof window === "undefined") return "Person 1";
    return normalizePersonName(window.localStorage.getItem(PERSON_STORAGE_KEY) ?? "Person 1");
  });
  const [hoursAhead, setHoursAhead] = useState("24");
  const [loading, setLoading] = useState(false);
  /** True medan servern fortfarande bygger sitt odds-index — vi auto-pollar då. */
  const [building, setBuilding] = useState(false);
  const [matches, setMatches] = useState<BestBonusMatch[]>([]);
  const [expandedTitle, setExpandedTitle] = useState<string | null>(null);
  const [logs, setLogs] = useState<BetLog[]>([]);
  /**
   * Vilken loggad rond som är utfälld i logg-listan. Master/detail-mönster:
   * översikten är en kompakt klickbar lista, detaljerna (alla ronder + per-konto-rader,
   * omsättningskrav, freebets-status, t("bonusOpt.optimizeNextRound")) visas bara för den valda.
   */
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  /**
   * Vy-läge: "setup" = namn+bonusar, "matches" = matchlista, "logs" = loggade rundor.
   * Startar alltid i "setup" — ingen sessionStorage.
   */
  const [viewMode, setViewMode] = useState<"setup" | "matches" | "logs">("setup");
  /** Vilken loggad runda som auto-expanderas när logs-vyn öppnas (null = ingen). */
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [roundDrafts, setRoundDrafts] = useState<Record<string, string>>({});
  const [continuationLoadingId, setContinuationLoadingId] = useState<string | null>(null);
  /**
   * "Tappa-matched"-läge: tvinga matched bets till hög odds (≥ 3.5 default)
   * så de troligen FÖRLORAR — snabbare exit från omsättningskrav, och Pinnacle/
   * Smarkets-komplementet hamnar på de låga oddsen. PÅ som standard för Dag 2/3:
   * vi vill medvetet förlora på bonus-sidorna och vinna pengarna på sharp-sidan.
   * Freebets påverkas EJ (de använder fortfarande sin egen voucher.minOdds).
   */
  const [tappaMatchedEnabled, setTappaMatchedEnabled] = useState(true);
  const [tappaMatchedMinOdds, setTappaMatchedMinOdds] = useState(3.5);
  const [continuationMatchesByLog, setContinuationMatchesByLog] = useState<Record<string, ContinuationMatch[]>>({});
  const [expandedContinuationKey, setExpandedContinuationKey] = useState<string | null>(null);
  /*
   * Manuell komplement-form togs bort 2026-05-19 — ersätts med auto-beräknade
   * cplan.cashComplements från optimeraren. Algoritmen letar bästa odds per
   * saknat utfall över alla scrapade sajter, så användaren slipper räkna ut
   * hedge själv.
   */
  /** Manuellt ändrade odds per matchkort — nycklar `${bookmakerId}:${outcome}`. */
  const [oddsOverridesByMatch, setOddsOverridesByMatch] = useState<Record<string, Record<string, number>>>({});
  /** Utkast under tangentbordsinmatning (rensas vid blur). */
  const [oddsLineDrafts, setOddsLineDrafts] = useState<Record<string, string>>({});
  /** Utkast i formuläret "registrera intjänad freebet" per logg. */
  const [earnedFreebetDrafts, setEarnedFreebetDrafts] = useState<
    Record<string, { bookmakerId: BonusBookmakerId; amount: string; minOdds: string }>
  >({});

  useEffect(() => {
    saveBonusPortfolio(portfolio);
  }, [portfolio]);

  useEffect(() => {
    void syncBetLogsOnLoad().then(setLogs);
  }, []);

  const activeSummary = useMemo(() => {
    const matched = portfolio.matched.filter((bonus) => bonus.enabled);
    const freebets = portfolio.freebets.filter((bonus) => bonus.enabled);
    return {
      matched: matched.length,
      freebets: freebets.length,
      matchedDeposit: matched.reduce((sum, bonus) => sum + bonus.deposit, 0),
      freebetDeposit: freebets.reduce((sum, bonus) => sum + bonus.amount, 0),
    };
  }, [portfolio]);
  const totalDepositToSwish = activeSummary.matchedDeposit + activeSummary.freebetDeposit;
  const selectedPersonName = normalizePersonName(personName);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PERSON_STORAGE_KEY, selectedPersonName);
  }, [selectedPersonName]);

  const tolerance = DISTRIBUTION_TOLERANCE;

  const copyTeamName = async (teamName: string) => {
    const selectedText = window.getSelection()?.toString().trim() ?? "";
    const selectedFromTeam =
      selectedText && teamName.toLocaleLowerCase("sv-SE").includes(selectedText.toLocaleLowerCase("sv-SE"));
    const cleaned = searchFriendlyTeamName(selectedFromTeam ? selectedText : teamName);
    if (!cleaned) return;
    try {
      await navigator.clipboard.writeText(cleaned);
      toast.success(`Kopierade ${cleaned}`);
    } catch {
      toast.error("Kunde inte kopiera lagnamnet");
    }
  };

  const knownPeople = useMemo(() => {
    const names = logs
      .filter((log) => Boolean(log.bonusOptimizer))
      .map((log) => normalizePersonName(log.person));
    return [...new Set([selectedPersonName, ...names])].filter(Boolean).slice(0, 12);
  }, [logs, selectedPersonName]);

  const bonusLogs = useMemo(
    () =>
      logs
        .filter((log): log is BonusHistoryLog => Boolean(log.bonusOptimizer))
        .filter((log) => normalizePersonName(log.person) === selectedPersonName)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [logs, selectedPersonName],
  );

  const personStatus = useMemo(() => {
    const latest = bonusLogs[0];
    if (!latest) {
      return {
        nextAction: "Starta Dag 1",
        matchedBalance: 0,
        wageringRemaining: 0,
        withdrawable: 0,
      };
    }

    const continuationState = continuationStateForLog(latest);
    const matchedBalance = continuationState.accounts.reduce((sum, account) => sum + account.balance, 0);
    const wageringRemaining = continuationState.accounts.reduce((sum, account) => sum + account.wageringRemaining, 0);
    const continuationRounds = latest.bonusOptimizer.rounds.filter((round) => round.type === "continuation");
    const openContinuation = continuationRounds.find((round) => !round.result);
    const savedPlan = latest.bonusOptimizer.plan as BonusOptimizationPlan;
    const day1FreebetWinnings = latest.bonusOptimizer.result
      ? savedPlan.freebets
          .filter((bet) => bet.outcome === latest.bonusOptimizer.result)
          .reduce((sum, bet) => sum + bet.profitOnWin, 0)
      : 0;
    const continuationFreebetWinnings = continuationRounds.reduce((sum, round) => {
      if (!round.result || !round.plan) return sum;
      const plan = round.plan as ContinuationPlan;
      return sum + plan.freebetBets
        .filter((bet) => bet.outcome === round.result)
        .reduce((inner, bet) => inner + bet.profitOnWin, 0);
    }, 0);

    return {
      nextAction: !latest.bonusOptimizer.result
        ? "Markera Dag 1"
        : openContinuation
          ? `Markera Dag ${openContinuation.round}`
          : continuationState.accounts.length > 0 || continuationState.vouchers.length > 0
            ? `Optimera Dag ${continuationState.nextRound}`
            : "Klar",
      matchedBalance,
      wageringRemaining,
      withdrawable: day1FreebetWinnings + continuationFreebetWinnings,
    };
  }, [bonusLogs, portfolio]);

  const fetchBestMatches = async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const response = await fetch(apiUrl("/api/best-bonus-matches"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolio,
          method: "strict-balance",
          hours: Number(hoursAhead),
          top: 10,
          tolerance,
          strategy: "single",
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(raw.slice(0, 240) || `HTTP ${response.status}`);
      }
      let data: {
        ok: boolean;
        matches?: BestBonusMatch[];
        error?: string;
        pending?: boolean;
        cached?: boolean;
        preview?: boolean;
        building?: boolean;
        count?: number;
      };
      try {
        data = JSON.parse(raw) as typeof data;
      } catch {
        throw new Error("Ogiltigt svar från servern (förväntade JSON).");
      }
      if (!data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const incomingMatches = data.matches ?? [];
      setMatches(incomingMatches);
      if (!options.silent) {
        setOddsOverridesByMatch({});
        setOddsLineDrafts({});
        setExpandedTitle(incomingMatches[0]?.title ?? null);
      } else if (incomingMatches.length > 0 && expandedTitle === null) {
        setExpandedTitle(incomingMatches[0].title);
      }

      const stillBuilding = Boolean(data.building) || Boolean(data.pending);
      setBuilding(stillBuilding);

      if (!options.silent) {
        if (data.pending) {
          toast.message(
            data.preview && incomingMatches.length > 0
              ? `Visar ${incomingMatches.length} snabba förslag. Fler byggs nu i bakgrunden.`
              : "Bygger matchförslag i bakgrunden. Listan uppdateras automatiskt.",
          );
        } else {
          toast.success(`${data.cached ? "Visar cache" : "Hittade"} ${incomingMatches.length} bonusförslag`);
        }
      }
    } catch (error) {
      if (!options.silent) {
        toast.error(error instanceof Error ? error.message : "Kunde inte optimera bonusmatcher");
      }
      setBuilding(false);
    } finally {
      if (!options.silent) setLoading(false);
    }
  };

  useEffect(() => {
    void fetchBestMatches();
    // Vid mount och när tidsfönster ändras. Bonus toggles: använd t("bonusOpt.refresh").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoursAhead]);

  // Auto-poll while server is still building the bonus odds index. Stops when servern svarar
  // utan pending=true.
  useEffect(() => {
    if (!building) return;
    const interval = setInterval(() => {
      void fetchBestMatches({ silent: true });
    }, 6000);
    return () => clearInterval(interval);
  }, [building, hoursAhead]);

  const refreshLogs = () => setLogs(getBetLogs());

  const savePlanToHistory = (
    match: BestBonusMatch,
    plan: BonusOptimizationPlan,
    odds: Partial<Record<BonusBookmakerId, OddsTriple>>,
    overrides: Record<string, number>,
  ) => {
    const existing = logs.find((log) => normalizePersonName(log.person) === selectedPersonName && log.matchName === match.title);
    const now = new Date().toISOString();
    const log: BetLog = {
      id: existing?.id ?? `bonus-${Date.now()}`,
      date: now,
      matchName: match.title,
      person: selectedPersonName,
      bookmakers: planToBookmakers(plan),
      worstCase: plan.minPayback,
      bestCase: Math.max(...Object.values(plan.paybackPerOutcome)),
      totalStake: plan.totalStakePlaced,
      notes: `Bonus optimering. Snitt ${Math.round(plan.averagePayback)} kr, edge ${plan.averageEdgePct.toFixed(2)}%.`,
      result: existing?.result,
      bonusOptimizer: {
        version: 1,
        status: existing?.bonusOptimizer?.status ?? "open",
        result: existing?.bonusOptimizer?.result,
        startTs: match.startTs,
        league: match.league,
        odds: JSON.parse(JSON.stringify(odds)),
        oddsOverrides: { ...overrides },
        plan: JSON.parse(JSON.stringify(plan)),
        earnedFreebets: existing?.bonusOptimizer?.earnedFreebets ?? [],
        rounds: [
          ...(existing?.bonusOptimizer?.rounds?.filter((round) => round.type !== "day1") ?? []),
          {
            id: `round-${Date.now()}`,
            round: 1,
            type: "day1" as const,
            matchName: match.title,
            startTs: match.startTs,
            league: match.league,
            createdAt: now,
            matched: JSON.parse(JSON.stringify(plan.matched)),
            freebets: JSON.parse(JSON.stringify(plan.freebets)),
          } satisfies BonusOptimizerRound,
        ].sort((a, b) => a.round - b.round),
      },
    };
    saveBetLog(log);
    refreshLogs();
    toast.success("Planen är sparad i historiken");
  };

  const setHistoryResult = (log: BonusHistoryLog, result: Outcome) => {
    const next: BetLog = {
      ...log,
      date: new Date().toISOString(),
      result,
      bonusOptimizer: {
        ...log.bonusOptimizer,
        status: "settled",
        result,
        rounds: log.bonusOptimizer.rounds.map((round) =>
          round.round === 1 ? { ...round, result } : round,
        ),
      },
    };
    saveBetLog(next);
    refreshLogs();
  };

  const addWageringRound = (log: BonusHistoryLog) => {
    const result = log.bonusOptimizer.result;
    if (!result) {
      toast.error("Välj först resultatet på matchen");
      return;
    }
    const matchName = (roundDrafts[log.id] ?? "").trim();
    if (!matchName) {
      toast.error("Skriv nästa match/lag innan du sparar rundan");
      return;
    }
    const savedPlan = log.bonusOptimizer.plan as BonusOptimizationPlan;
    const matchedWinners = savedPlan.matched.filter((bet) => bet.outcome === result);
    const now = new Date().toISOString();
    const roundNumber = Math.max(1, ...log.bonusOptimizer.rounds.map((round) => round.round)) + 1;
    const next: BetLog = {
      ...log,
      date: now,
      bonusOptimizer: {
        ...log.bonusOptimizer,
        status: "continued",
        rounds: [
          ...log.bonusOptimizer.rounds,
          {
            id: `round-${Date.now()}`,
            round: roundNumber,
            type: "wagering",
            matchName,
            createdAt: now,
            matched: JSON.parse(JSON.stringify(matchedWinners)),
            notes: "Fortsatt omsättning från vinnande matched-konton.",
          },
        ],
      },
    };
    saveBetLog(next);
    setRoundDrafts((prev) => ({ ...prev, [log.id]: "" }));
    refreshLogs();
    toast.success("Omsättningsrundan är sparad");
  };

  /**
   * Plockar fram alla freebets som tjänats in under spelet och inte ännu använts
   * i en runda (`usedInRound` saknas) och konverterar dem till vouchers som
   * `optimizeContinuationMatch` kan ta in i nästa runda.
   */
  function unusedEarnedVouchers(log: BonusHistoryLog): FreebetVoucher[] {
    const earned = log.bonusOptimizer.earnedFreebets ?? [];
    return earned
      .filter((eb) => !eb.usedInRound && eb.amount > 0)
      .map((eb) => ({
        bookmakerId: eb.bookmakerId as BonusBookmakerId,
        bookmaker: BONUS_BOOKMAKER_NAMES[eb.bookmakerId as BonusBookmakerId] ?? eb.bookmakerId,
        amount: eb.amount,
        minOdds: eb.minOdds,
      }));
  }

  function continuationStateForLog(log: BonusHistoryLog) {
    const result = log.bonusOptimizer.result;
    const earnedVouchers = unusedEarnedVouchers(log);
    if (!result) return { accounts: [] as WageringAccount[], vouchers: earnedVouchers, nextRound: 2 };
    const continuationRounds = log.bonusOptimizer.rounds.filter((round) => round.type === "continuation");
    const lastContinuation = continuationRounds[continuationRounds.length - 1];
    const lastResult = lastContinuation?.result;
    if (lastContinuation && !lastResult) {
      return {
        accounts: [] as WageringAccount[],
        vouchers: [] as FreebetVoucher[],
        nextRound: lastContinuation.round + 1,
        waitingForRoundResult: lastContinuation.round,
      };
    }
    if (lastContinuation && lastResult && Array.isArray(lastContinuation.remainingAccountsAfterResult)) {
      return {
        accounts: lastContinuation.remainingAccountsAfterResult as WageringAccount[],
        vouchers: earnedVouchers,
        nextRound: Math.max(...log.bonusOptimizer.rounds.map((round) => round.round)) + 1,
      };
    }

    const savedPlan = log.bonusOptimizer.plan as BonusOptimizationPlan;
    const portfolioVouchers =
      continuationRounds.length === 0 ? vouchersFromPortfolio(portfolio) : ([] as FreebetVoucher[]);
    // Slå ihop portföljens freebets (Dag 2 första gången) med inarbetade earned freebets.
    const merged: FreebetVoucher[] = [...portfolioVouchers];
    for (const ev of earnedVouchers) {
      if (!merged.some((m) => m.bookmakerId === ev.bookmakerId)) merged.push(ev);
    }
    return {
      accounts: savedPlan.matched.filter((bet) => bet.outcome === result).map((bet) => accountFromMatchedBet(bet, 1)),
      vouchers: merged,
      nextRound: Math.max(...log.bonusOptimizer.rounds.map((round) => round.round)) + 1,
    };
  }

  const fetchContinuationMatches = async (log: BonusHistoryLog) => {
    const { accounts, vouchers } = continuationStateForLog(log);
    if (accounts.length === 0 && vouchers.length === 0) {
      toast.error("Markera resultatet på senaste dag innan du optimerar vidare");
      return;
    }

    setContinuationLoadingId(log.id);
    try {
      const response = await fetch(apiUrl("/api/bonus-continuation-matches"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts,
          vouchers,
          hours: Number(hoursAhead),
          top: 5,
          // Tappa-matched: skicka bara med om enabled så standard-flödet blir oförändrat.
          ...(tappaMatchedEnabled && tappaMatchedMinOdds > 1
            ? { wageringMinOdds: tappaMatchedMinOdds }
            : {}),
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(raw.slice(0, 240) || `HTTP ${response.status}`);
      }
      let data: { ok: boolean; matches?: ContinuationMatch[]; error?: string };
      try {
        data = JSON.parse(raw) as typeof data;
      } catch {
        throw new Error("Ogiltigt svar från servern (förväntade JSON).");
      }
      if (!data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setContinuationMatchesByLog((prev) => ({ ...prev, [log.id]: data.matches ?? [] }));
      setExpandedContinuationKey(data.matches?.[0] ? `${log.id}:${data.matches[0].title}` : null);
      toast.success(`Hittade ${data.matches?.length ?? 0} fortsättningsförslag`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Kunde inte optimera Dag 2/3");
    } finally {
      setContinuationLoadingId(null);
    }
  };

  const saveContinuationRound = (log: BonusHistoryLog, match: ContinuationMatch, plan: ContinuationPlan) => {
    const now = new Date().toISOString();
    const { accounts, vouchers, nextRound } = continuationStateForLog(log);
    if (accounts.length === 0 && vouchers.length === 0) {
      toast.error("Markera resultatet på senaste dag innan du sparar nästa plan");
      return;
    }
    // Earned freebets som faktiskt landar i den här rundans plan markeras som
    // använda så de inte rullar med en gång till.
    const usedBookmakerIds = new Set(plan.freebetBets.map((bet) => bet.bookmakerId));
    const updatedEarnedFreebets = (log.bonusOptimizer.earnedFreebets ?? []).map((eb) =>
      !eb.usedInRound && usedBookmakerIds.has(eb.bookmakerId as BonusBookmakerId)
        ? { ...eb, usedInRound: nextRound }
        : eb,
    );
    const continuationRound: BonusOptimizerRound = {
      id: `round-${Date.now()}`,
      round: nextRound,
      type: "continuation",
      sourceRound: nextRound - 1,
      matchName: match.title,
      startTs: match.startTs,
      league: match.league,
      createdAt: now,
      matchedAccounts: JSON.parse(JSON.stringify(accounts)),
      freebetVouchers: JSON.parse(JSON.stringify(vouchers)),
      cashComplements: JSON.parse(JSON.stringify(plan.cashComplements)),
      plan: JSON.parse(JSON.stringify(plan)),
    };
    const next: BetLog = {
      ...log,
      date: now,
      bonusOptimizer: {
        ...log.bonusOptimizer,
        status: "continued",
        earnedFreebets: updatedEarnedFreebets,
        rounds: [...log.bonusOptimizer.rounds, continuationRound],
      },
    };
    saveBetLog(next);
    refreshLogs();
    toast.success(`Dag ${nextRound}-plan sparad`);
  };

  const addEarnedFreebet = (
    log: BonusHistoryLog,
    bookmakerId: BonusBookmakerId,
    amount: number,
    minOdds: number,
    sourceRound: number,
    note?: string,
  ) => {
    const entry: EarnedFreebet = {
      id: `eb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      bookmakerId,
      amount,
      minOdds,
      sourceRound,
      addedAt: new Date().toISOString(),
      note,
    };
    const next: BetLog = {
      ...log,
      date: new Date().toISOString(),
      bonusOptimizer: {
        ...log.bonusOptimizer,
        earnedFreebets: [...(log.bonusOptimizer.earnedFreebets ?? []), entry],
      },
    };
    saveBetLog(next);
    refreshLogs();
    toast.success(`Freebet ${amount} kr på ${BONUS_BOOKMAKER_NAMES[bookmakerId]} registrerad`);
  };

  const removeEarnedFreebet = (log: BonusHistoryLog, freebetId: string) => {
    const next: BetLog = {
      ...log,
      date: new Date().toISOString(),
      bonusOptimizer: {
        ...log.bonusOptimizer,
        earnedFreebets: (log.bonusOptimizer.earnedFreebets ?? []).filter((eb) => eb.id !== freebetId),
      },
    };
    saveBetLog(next);
    refreshLogs();
  };

  const setContinuationRoundResult = (log: BonusHistoryLog, roundId: string, result: Outcome) => {
    const next: BetLog = {
      ...log,
      date: new Date().toISOString(),
      bonusOptimizer: {
        ...log.bonusOptimizer,
        rounds: log.bonusOptimizer.rounds.map((round) => {
          if (round.id !== roundId || round.type !== "continuation") return round;
          const plan = round.plan as ContinuationPlan | undefined;
          return {
            ...round,
            result,
            remainingAccountsAfterResult: plan ? remainingAccountsAfterContinuation(plan, result) : [],
          };
        }),
      },
    };
    saveBetLog(next);
    refreshLogs();
  };

  console.log("[BonusOptimizer view]", { viewMode, selectedLogId, matches: matches.length, logs: bonusLogs.length, personName });

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-7xl px-2 py-6 sm:px-3 md:px-4">
        <BrandHeader className="mb-4" />
        <div className="mb-3">
          <a
            href="/smarkets-extraction"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 text-xs font-medium text-sky-700 transition hover:bg-sky-500/20 dark:text-sky-300"
          >
            💱 Smarkets-uttag (dag 2) →
          </a>
        </div>
        {viewMode === "setup" && (
          <div className="mx-auto max-w-xl space-y-4">
            {bonusLogs.length > 0 && (
              <button
                type="button"
                className="h-7 rounded-full border bg-muted/30 px-3 text-xs font-medium transition hover:bg-muted/60"
                onClick={() => { setSelectedLogId(null); setViewMode("logs"); }}
              >
                Loggade VB ({bonusLogs.length})
              </button>
            )}

            <Card>
              <CardContent className="space-y-2 p-3">
                <Input
                  value={personName}
                  onChange={(event) => setPersonName(event.target.value)}
                  onBlur={() => setPersonName((name) => normalizePersonName(name))}
                  placeholder="Person"
                  className="font-semibold"
                />
                {knownPeople.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {knownPeople.map((name) => (
                      <Button
                        key={name}
                        size="sm"
                        variant={name === selectedPersonName ? "default" : "outline"}
                        className="h-7 px-2 text-xs"
                        onClick={() => setPersonName(name)}
                      >
                        {name}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                    <div className="text-muted-foreground">Swish</div>
                    <div className="font-mono font-bold">{formatCurrency(totalDepositToSwish)}</div>
                  </div>
                  <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                    <div className="text-muted-foreground">Uttagbart</div>
                    <div className="font-mono font-bold">{formatCurrency(personStatus.withdrawable)}</div>
                  </div>
                  <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                    <div className="text-muted-foreground">Kvar matched</div>
                    <div className="font-mono font-bold">{formatCurrency(personStatus.matchedBalance)}</div>
                  </div>
                  <div className="rounded-md border bg-muted/20 px-2 py-1.5">
                    <div className="text-muted-foreground">WR kvar</div>
                    <div className="font-mono font-bold">{formatCurrency(personStatus.wageringRemaining)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2 p-3">
                <div className="rounded-md border border-emerald-500/35 bg-emerald-500/[0.06] p-2 ring-1 ring-emerald-500/15">
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-200/90">
                    Matched bonusar
                  </h2>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {portfolio.matched.map((bonus) => (
                      <div
                        key={bonus.id}
                        className="flex items-center justify-between gap-1.5 rounded border border-emerald-500/20 bg-background/50 px-1.5 py-1"
                      >
                        <BookmakerName
                          name={BONUS_BOOKMAKER_NAMES[bonus.id]}
                          className="min-w-0 flex-1 [&_img]:max-h-6"
                        />
                        <Switch
                          className="scale-90"
                          checked={bonus.enabled}
                          onCheckedChange={(enabled) => setPortfolio((p) => setMatchedBonusEnabled(p, bonus.id, enabled))}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-md border border-violet-500/35 bg-violet-500/[0.06] p-2 ring-1 ring-violet-500/15">
                  <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-violet-200/90">Freebets</h2>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {portfolio.freebets.map((bonus) => (
                      <div
                        key={bonus.id}
                        className="flex items-center justify-between gap-1.5 rounded border border-violet-500/20 bg-background/50 px-1.5 py-1"
                      >
                        <BookmakerName
                          name={BONUS_BOOKMAKER_NAMES[bonus.id]}
                          className="min-w-0 flex-1 [&_img]:max-h-6"
                        />
                        <Switch
                          className="scale-90"
                          checked={bonus.enabled}
                          onCheckedChange={(enabled) => setPortfolio((p) => setFreebetBonusEnabled(p, bonus.id, enabled))}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button
              size="lg"
              className="w-full"
              disabled={loading}
              onClick={() => { void fetchBestMatches(); setViewMode("matches"); setSelectedLogId(null); }}
            >
              {loading ? (
                <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />{t("bonusOpt.searching")}</>
              ) : building ? (
                `Bygger... (${matches.length} förslag)`
              ) : "Sök matcher →"}
            </Button>
          </div>
        )}

        {viewMode === "matches" && (
          <div className="space-y-4">
            {/* Sub-header: back button + context badges + rundor-knapp */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewMode("setup")}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Ändra namn &amp; bonusar
                </Button>
                <Badge>{selectedPersonName}</Badge>
                <Badge variant="secondary">{activeSummary.matched} matched aktiva</Badge>
                <Badge variant="secondary">{activeSummary.freebets} freebets aktiva</Badge>
                <Badge>Swish: {formatCurrency(totalDepositToSwish)}</Badge>
              </div>
              {bonusLogs.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => { setViewMode("logs"); setSelectedLogId(null); }}
                >
                  Rundor ({bonusLogs.length})
                </Button>
              )}
            </div>

            <Card>
              <CardContent className="flex flex-col gap-4 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-3">
                    <h2 className="font-semibold">Matcher</h2>
                    <div className="max-w-xs">
                      <div>
                        <Select value={hoursAhead} onValueChange={setHoursAhead}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="24">{t("bonusOpt.hours24")}</SelectItem>
                            <SelectItem value="48">{t("bonusOpt.hours48")}</SelectItem>
                            <SelectItem value="72">{t("bonusOpt.hours72")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  <Button onClick={() => void fetchBestMatches()} disabled={loading} className="w-full shrink-0 sm:w-auto sm:min-w-36">
                    <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    {loading ? t("bonusOpt.loading") : t("bonusOpt.refresh")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {matches.length === 0 && (
              <Card>
                <CardContent className="p-8 text-center text-muted-foreground">
                  Resultaten visas här när beräkningen är klar.
                </CardContent>
              </Card>
            )}

            {matches.map((match, index) => {
              const cardKey = matchCardKey(match);
              const basePlan = match.optimization.best;
              const overrides = oddsOverridesByMatch[cardKey] ?? {};
              const adjustedOdds = applyOddsOverrides(match.odds, overrides);
              const plan = match.splitMatches
                ? basePlan
                : optimizeBonusMatch({ ...match, odds: adjustedOdds }, portfolio, "strict-balance", tolerance)?.best ??
                  basePlan;
              const expanded = expandedTitle === match.title;
              const unavailableBookmakers = match.unavailableBookmakerIds ?? [];

              const setOddOverride = (bookmakerId: string, outcome: Outcome, value: number | undefined) => {
                const key = oddsOverrideKey(bookmakerId, outcome);
                setOddsOverridesByMatch((prev) => {
                  const cur = { ...(prev[cardKey] ?? {}) };
                  if (value === undefined) delete cur[key];
                  else cur[key] = value;
                  if (Object.keys(cur).length === 0) {
                    const next = { ...prev };
                    delete next[cardKey];
                    return next;
                  }
                  return { ...prev, [cardKey]: cur };
                });
              };

              const originalOdds = (bookmakerId: BonusBookmakerId, outcome: Outcome) =>
                match.odds[bookmakerId]?.[outcome];

              const draftKey = (bookmakerId: string, outcome: Outcome) =>
                `${cardKey}|${oddsOverrideKey(bookmakerId, outcome)}`;
              const headerTeams = teamsFromMatchTitle(match.title);
              const headerMatches = match.splitMatches ?? [{ title: match.title, startTs: match.startTs, league: match.league }];

              return (
                <Card key={`${match.title}-${match.startTs}`} className="overflow-hidden">
                  <CardContent className="p-0">
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full cursor-pointer p-4 text-left hover:bg-muted/40"
                      onClick={() => setExpandedTitle(expanded ? null : match.title)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setExpandedTitle(expanded ? null : match.title);
                        }
                      }}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-2">
                          {headerMatches.map((headerMatch, matchIdx) => {
                            const teams = teamsFromMatchTitle(headerMatch.title);
                            return (
                              <div key={`${headerMatch.title}-${headerMatch.startTs ?? matchIdx}`} className={matchIdx > 0 ? "border-t border-border/50 pt-2" : ""}>
                                <div className="flex items-start gap-2">
                                  {matchIdx === 0 ? (
                                    <Badge className="mt-0.5 shrink-0 px-2.5 py-1 text-xs">#{index + 1}</Badge>
                                  ) : (
                                    <Badge variant="secondary" className="mt-0.5 shrink-0 px-2.5 py-1 text-xs">M{matchIdx + 1}</Badge>
                                  )}
                                  <h2 className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xl font-bold leading-snug sm:text-2xl">
                                    <span className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:bg-primary/10">
                                      <span className="select-text">{teams.home}</span>
                                      <button
                                        type="button"
                                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary/20 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                        title={`Kopiera: ${searchFriendlyTeamName(teams.home)}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void copyTeamName(teams.home);
                                        }}
                                      >
                                        <Copy className="h-3.5 w-3.5" />
                                      </button>
                                    </span>
                                    <span className="text-base font-semibold text-muted-foreground sm:text-lg">vs</span>
                                    <span className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:bg-primary/10">
                                      <span className="select-text">{teams.away}</span>
                                      <button
                                        type="button"
                                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary/20 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                        title={`Kopiera: ${searchFriendlyTeamName(teams.away)}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void copyTeamName(teams.away);
                                        }}
                                      >
                                        <Copy className="h-3.5 w-3.5" />
                                      </button>
                                    </span>
                                  </h2>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-12 text-sm font-medium text-muted-foreground">
                                  {headerMatch.league && <span>{headerMatch.league}</span>}
                                  {headerMatch.league && headerMatch.startTs && <span className="text-muted-foreground/50">·</span>}
                                  {headerMatch.startTs && <span>{formatShortDateTime(headerMatch.startTs)}</span>}
                                  {matchIdx === 0 && (
                                    <Badge variant="secondary" className="font-mono text-[11px]">
                                      {plan.matchedDistribution["1"]}/{plan.matchedDistribution.X}/{plan.matchedDistribution["2"]}
                                    </Badge>
                                  )}
                                </div>
                                {headerMatch.startTs && !headerMatch.league && (
                                  <div className="sr-only">
                                    {formatShortDateTime(headerMatch.startTs)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {unavailableBookmakers.length > 0 && (
                            <div className="pl-12">
                              <Badge
                                variant="destructive"
                                title={`Ej hämtade 1X2: ${unavailableBookmakers.map((id) => BONUS_BOOKMAKER_NAMES[id] ?? id).join(", ")}. (NB: VBET/Unibet har ingen syster-speglning.)`}
                              >
                                {unavailableBookmakers.length} odds saknas
                              </Badge>
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            savePlanToHistory(match, plan, adjustedOdds, overrides);
                          }}
                          className="shrink-0 sm:min-w-32"
                        >
                          Spara plan
                        </Button>
                      </div>
                    </div>

                    {expanded && (
                      <div className="space-y-4 border-t p-4">
                        <div className="grid gap-2 md:grid-cols-3">
                          {(["1", "X", "2"] as Outcome[]).map((outcome) => (
                            <div key={outcome} className={`rounded-md border p-2 text-sm ${OUTCOME_ACCENT_CLASSES[outcome]}`}>
                              <div className="truncate text-xs font-semibold opacity-90">Om {outcomeName(match.title, outcome, t("outcome.draw"))}</div>
                              <div className="font-bold text-foreground">{formatSignedCurrency(plan.paybackPerOutcome[outcome])}</div>
                              <div className="text-xs text-muted-foreground">
                                tillbaka {formatCurrency(plan.accountReturnPerOutcome[outcome])}
                              </div>
                            </div>
                          ))}
                        </div>

                        <div>
                          <h3 className="mb-2 font-semibold">Matched bets</h3>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="font-bold">Lag</TableHead>
                                <TableHead className="font-bold">Bookmaker</TableHead>
                                <TableHead className="w-[120px] font-bold">Odds</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {[...plan.matched]
                                .sort((a, b) => {
                                  const order = { "1": 0, X: 1, "2": 2 } as Record<Outcome, number>;
                                  const byOutcome = order[a.outcome] - order[b.outcome];
                                  if (byOutcome !== 0) return byOutcome;
                                  return a.bookmaker.localeCompare(b.bookmaker, "sv");
                                })
                                .map((bet) => {
                                  const dk = draftKey(bet.bookmakerId, bet.outcome);
                                  const displayOdds =
                                    oddsLineDrafts[dk] ?? formatOddsDisplay(bet.odds);
                                  const betMatchTitle = bet.matchTitle ?? match.title;
                                  return (
                                    <TableRow key={bet.bookmakerId}>
                                      <TableCell>
                                        <div className="flex items-center gap-2">
                                          <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded px-2 font-mono text-xs font-bold ${OUTCOME_BADGE_CLASSES[bet.outcome]}`}>
                                            {bet.outcome}
                                          </span>
                                          <span className="text-sm font-medium">
                                            {outcomeName(betMatchTitle, bet.outcome, t("outcome.draw"))}
                                            {bet.matchIndex != null && <span className="ml-1 text-xs text-muted-foreground">M{bet.matchIndex + 1}</span>}
                                          </span>
                                        </div>
                                      </TableCell>
                                      <TableCell>
                                        <BookmakerName name={bet.bookmaker} />
                                      </TableCell>
                                      <TableCell>
                                        <Input
                                          className="h-9 w-full max-w-[7rem] font-mono text-sm"
                                          inputMode="decimal"
                                          value={displayOdds}
                                          onChange={(e) =>
                                            setOddsLineDrafts((prev) => ({ ...prev, [dk]: e.target.value }))
                                          }
                                          onBlur={() => {
                                            const raw = oddsLineDrafts[dk];
                                            setOddsLineDrafts((prev) => {
                                              const next = { ...prev };
                                              delete next[dk];
                                              return next;
                                            });
                                            if (raw === undefined) return;
                                            const parsed = parseOddsInput(raw);
                                            if (parsed == null) return;
                                            const orig = originalOdds(bet.bookmakerId, bet.outcome) ?? bet.odds;
                                            if (Math.abs(parsed - orig) < 1e-6) {
                                              setOddOverride(bet.bookmakerId, bet.outcome, undefined);
                                              return;
                                            }
                                            setOddOverride(bet.bookmakerId, bet.outcome, parsed);
                                          }}
                                        />
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                            </TableBody>
                          </Table>
                        </div>

                        <div>
                          <h3 className="mb-2 font-semibold">{t("bonusOpt.freebetsThatEqualize")}</h3>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="font-bold">Lag</TableHead>
                                <TableHead className="font-bold">Bookmaker</TableHead>
                                <TableHead className="w-[120px] font-bold">Odds</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {plan.freebets.map((bet) => {
                                const dk = draftKey(bet.bookmakerId, bet.outcome);
                                const displayOdds = oddsLineDrafts[dk] ?? formatOddsDisplay(bet.odds);
                                const betMatchTitle = bet.matchTitle ?? match.title;
                                return (
                                  <TableRow key={`${bet.bookmakerId}-${bet.outcome}`}>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <span className={`inline-flex h-7 min-w-7 items-center justify-center rounded px-2 font-mono text-xs font-bold ${OUTCOME_BADGE_CLASSES[bet.outcome]}`}>
                                          {bet.outcome}
                                        </span>
                                        <span className="text-sm font-medium">
                                          {outcomeName(betMatchTitle, bet.outcome, t("outcome.draw"))}
                                          {bet.matchIndex != null && <span className="ml-1 text-xs text-muted-foreground">M{bet.matchIndex + 1}</span>}
                                        </span>
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      <BookmakerName name={bet.bookmaker} />
                                    </TableCell>
                                    <TableCell>
                                      <Input
                                        className="h-9 w-full max-w-[7rem] font-mono text-sm"
                                        inputMode="decimal"
                                        value={displayOdds}
                                        onChange={(e) =>
                                          setOddsLineDrafts((prev) => ({ ...prev, [dk]: e.target.value }))
                                        }
                                        onBlur={() => {
                                          const raw = oddsLineDrafts[dk];
                                          setOddsLineDrafts((prev) => {
                                            const next = { ...prev };
                                            delete next[dk];
                                            return next;
                                          });
                                          if (raw === undefined) return;
                                          const parsed = parseOddsInput(raw);
                                          if (parsed == null) return;
                                          const orig = originalOdds(bet.bookmakerId, bet.outcome) ?? bet.odds;
                                          if (Math.abs(parsed - orig) < 1e-6) {
                                            setOddOverride(bet.bookmakerId, bet.outcome, undefined);
                                            return;
                                          }
                                          setOddOverride(bet.bookmakerId, bet.outcome, parsed);
                                        }}
                                      />
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>

                      </div>
                    )}
                </CardContent>
              </Card>
              );
            })}

          </div>
        )}

        {viewMode === "logs" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { matches.length > 0 ? setViewMode("matches") : setViewMode("setup"); }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {matches.length > 0 ? "Tillbaka till matcher" : "Ändra namn & bonusar"}
              </Button>
              <span className="text-lg font-semibold">Loggade rundor ({bonusLogs.length})</span>
            </div>
            <div className="space-y-3">
              {bonusLogs.map((log, logIdx) => {
                  const state = continuationStateForLog(log);
                  const continuationRounds = log.bonusOptimizer.rounds
                    .filter((r) => r.type === "continuation")
                    .sort((a, b) => a.round - b.round);
                  const lastContinuation = continuationRounds[continuationRounds.length - 1];
                  const day1Result = log.bonusOptimizer.result;
                  const earned = log.bonusOptimizer.earnedFreebets ?? [];
                  const draft =
                    earnedFreebetDrafts[log.id] ?? { bookmakerId: "unibet" as BonusBookmakerId, amount: "", minOdds: "1.8" };
                  const setDraft = (next: Partial<typeof draft>) =>
                    setEarnedFreebetDrafts((prev) => ({ ...prev, [log.id]: { ...draft, ...next } }));

                  const sourceRoundForNewEarned =
                    lastContinuation?.result
                      ? lastContinuation.round
                      : lastContinuation
                        ? lastContinuation.round
                        : day1Result
                          ? 1
                          : 1;

                  const day1Plan = log.bonusOptimizer.plan as BonusOptimizationPlan | undefined;
                  const day1Net =
                    day1Result && day1Plan ? day1Plan.paybackPerOutcome[day1Result] : undefined;

                  // Total netto = R1 (om resultat finns) + summa över avgjorda fortsättningsronder.
                  const totalNet =
                    (day1Net ?? 0) +
                    continuationRounds.reduce((sum, r) => {
                      const p = r.plan as ContinuationPlan | undefined;
                      return r.result && p ? sum + p.paybackPerOutcome[r.result] : sum;
                    }, 0);
                  const hasAnyResult = Boolean(day1Result) || continuationRounds.some((r) => r.result);

                  const wageringProgress: WageringProgress[] = computeWageringProgress(
                    log.bonusOptimizer.rounds,
                    day1Plan,
                    day1Result,
                  );
                  const clearedBonuses = wageringProgress.filter((p) => p.status === "cleared");
                  const earnedBookmakerIds = new Set(earned.map((eb) => eb.bookmakerId));

                  // Antal unika spel-sajter som var med i R1 (för list-summary).
                  const sajterIds = new Set<string>();
                  if (day1Plan) {
                    for (const m of day1Plan.matched) sajterIds.add(m.bookmakerId);
                    for (const f of day1Plan.freebets) sajterIds.add(f.bookmakerId);
                  }
                  const sajterCount = sajterIds.size;

                  const defaultAmountForBookmaker = (bookmakerId: BonusBookmakerId): number => {
                    const matchedBonus = portfolio.matched.find((b) => b.id === bookmakerId);
                    if (matchedBonus) return matchedBonus.deposit;
                    const freebetBonus = portfolio.freebets.find((b) => b.id === bookmakerId);
                    if (freebetBonus) return freebetBonus.amount;
                    return 0;
                  };

                  // R1-freebet-status: varje konfigurerad freebet markeras som förbrukad
                  // (ja/nej) och vinst på vinnande utfall = (odds − 1) × amount.
                  type FreebetStatusEntry = {
                    key: string;
                    sourceLabel: string;
                    bookmakerId: BonusBookmakerId;
                    bookmaker: string;
                    amount: number;
                    odds: number;
                    outcome: Outcome;
                    matchTitle?: string;
                    used: boolean;
                    won?: boolean;
                    profitOnWin: number;
                  };
                  const freebetStatus: FreebetStatusEntry[] = [];
                  if (day1Plan) {
                    for (const fb of day1Plan.freebets) {
                      freebetStatus.push({
                        key: `r1-${fb.bookmakerId}-${fb.outcome}`,
                        sourceLabel: "R1",
                        bookmakerId: fb.bookmakerId,
                        bookmaker: fb.bookmaker,
                        amount: fb.amount,
                        odds: fb.odds,
                        outcome: fb.outcome,
                        matchTitle: fb.matchTitle ?? log.matchName,
                        used: Boolean(day1Result),
                        won: day1Result ? day1Result === fb.outcome : undefined,
                        profitOnWin: fb.profitOnWin,
                      });
                    }
                  }
                  for (const round of continuationRounds) {
                    const cplan = round.plan as ContinuationPlan | undefined;
                    if (!cplan) continue;
                    for (const fb of cplan.freebetBets) {
                      freebetStatus.push({
                        key: `${round.id}-${fb.bookmakerId}-${fb.outcome}`,
                        sourceLabel: `R${round.round}`,
                        bookmakerId: fb.bookmakerId,
                        bookmaker: fb.bookmaker,
                        amount: fb.amount,
                        odds: fb.odds,
                        outcome: fb.outcome,
                        matchTitle: round.matchName,
                        used: Boolean(round.result),
                        won: round.result ? round.result === fb.outcome : undefined,
                        profitOnWin: fb.profitOnWin,
                      });
                    }
                  }

                  const continuationMatches = continuationMatchesByLog[log.id] ?? [];
                  const isLoadingContinuation = continuationLoadingId === log.id;
                  const canOptimizeNext =
                    !state.waitingForRoundResult && (state.accounts.length > 0 || state.vouchers.length > 0);

                  // Status-etikett i list-summary (kompakt): visar vad användaren behöver göra
                  // härnäst eller var i kedjan ronden står.
                  const statusLabel = (() => {
                    if (!day1Result) return "Väntar R1-resultat";
                    if (state.waitingForRoundResult) return `Väntar R${state.waitingForRoundResult}-resultat`;
                    if (canOptimizeNext) return `Optimera R${state.nextRound}`;
                    return "Klar";
                  })();

                  // Per-bet-rader för en enskild rond: enhetlig form oavsett om det är
                  // matched/freebet/cash så samma render-block kan användas.
                  type RoundBetRow = {
                    key: string;
                    bookmakerId: string;
                    bookmaker: string;
                    type: "matched" | "freebet" | "cash";
                    outcome: Outcome;
                    stake: number;
                    odds: number;
                    payoutOnWin: number;
                    payoutLabel: string;
                  };

                  const buildR1Rows = (): RoundBetRow[] => {
                    if (!day1Plan) return [];
                    const matched: RoundBetRow[] = day1Plan.matched.map((bet) => ({
                      key: `r1-m-${bet.bookmakerId}`,
                      bookmakerId: bet.bookmakerId,
                      bookmaker: bet.bookmaker,
                      type: "matched",
                      outcome: bet.outcome,
                      stake: bet.stake,
                      odds: bet.odds,
                      payoutOnWin: bet.grossReturn,
                      payoutLabel: `stake×odds = ${formatCurrency(bet.grossReturn)}`,
                    }));
                    const free: RoundBetRow[] = day1Plan.freebets.map((bet) => ({
                      key: `r1-f-${bet.bookmakerId}-${bet.outcome}`,
                      bookmakerId: bet.bookmakerId,
                      bookmaker: bet.bookmaker,
                      type: "freebet",
                      outcome: bet.outcome,
                      stake: bet.amount,
                      odds: bet.odds,
                      payoutOnWin: bet.profitOnWin,
                      payoutLabel: `(odds−1)×stake = ${formatCurrency(bet.profitOnWin)}`,
                    }));
                    return [...matched, ...free];
                  };

                  const buildContinuationRows = (cplan: ContinuationPlan, roundId: string): RoundBetRow[] => {
                    const wagering: RoundBetRow[] = cplan.wageringBets.map((bet) => ({
                      key: `${roundId}-w-${bet.bookmakerId}`,
                      bookmakerId: bet.bookmakerId,
                      bookmaker: bet.bookmaker,
                      type: "matched",
                      outcome: bet.outcome,
                      stake: bet.stake,
                      odds: bet.odds,
                      payoutOnWin: bet.grossReturn,
                      payoutLabel: `stake×odds = ${formatCurrency(bet.grossReturn)}`,
                    }));
                    const free: RoundBetRow[] = cplan.freebetBets.map((bet) => ({
                      key: `${roundId}-f-${bet.bookmakerId}-${bet.outcome}`,
                      bookmakerId: bet.bookmakerId,
                      bookmaker: bet.bookmaker,
                      type: "freebet",
                      outcome: bet.outcome,
                      stake: bet.amount,
                      odds: bet.odds,
                      payoutOnWin: bet.profitOnWin,
                      payoutLabel: `(odds−1)×stake = ${formatCurrency(bet.profitOnWin)}`,
                    }));
                    const cash: RoundBetRow[] = cplan.cashComplements.map((bet) => ({
                      key: `${roundId}-c-${bet.bookmakerId}-${bet.outcome}`,
                      bookmakerId: bet.bookmakerId,
                      bookmaker: bet.bookmaker,
                      type: "cash",
                      outcome: bet.outcome,
                      stake: bet.stake,
                      odds: bet.odds,
                      payoutOnWin: bet.grossReturn,
                      payoutLabel: `cash stake×odds = ${formatCurrency(bet.grossReturn)}`,
                    }));
                    return [...wagering, ...free, ...cash];
                  };

                  const renderRoundBets = (rows: RoundBetRow[], roundResult?: Outcome) => {
                    if (rows.length === 0) {
                      return (
                        <div className="text-xs text-muted-foreground">{t("bonusOpt.noBetsRegistered")}</div>
                      );
                    }
                    const sorted = [...rows].sort((a, b) => {
                      const order: Record<Outcome, number> = { "1": 0, X: 1, "2": 2 };
                      const byOutcome = order[a.outcome] - order[b.outcome];
                      if (byOutcome !== 0) return byOutcome;
                      const typeOrder = { matched: 0, freebet: 1, cash: 2 } as const;
                      const byType = typeOrder[a.type] - typeOrder[b.type];
                      if (byType !== 0) return byType;
                      return a.bookmaker.localeCompare(b.bookmaker, "sv");
                    });
                    return (
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {sorted.map((row) => {
                          const won = roundResult ? row.outcome === roundResult : undefined;
                          const cardClass =
                            won === true
                              ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                              : won === false
                                ? "border-border/30 bg-muted/10 opacity-70"
                                : "border-border/30 bg-background/50";
                          const typeBadge =
                            row.type === "matched" ? (
                              <Badge
                                className="bg-emerald-500/20 text-emerald-200 border border-emerald-500/40"
                                title="Matched: bidrar till omsättningskravet, vinst stake×odds (insats återges)"
                              >
                                Matched
                              </Badge>
                            ) : row.type === "freebet" ? (
                              <Badge
                                className="bg-violet-500/20 text-violet-200 border border-violet-500/40"
                                title="Freebet: ingen omsättning, vinst (odds−1)×stake"
                              >
                                Freebet
                              </Badge>
                            ) : (
                              <Badge
                                className="bg-sky-500/20 text-sky-200 border border-sky-500/40"
                                title="Cash-komplement: jämnar ut utfallen, ingen bonus."
                              >
                                Cash
                              </Badge>
                            );
                          return (
                            <div
                              key={row.key}
                              className={`rounded-md border p-2 text-xs ${cardClass}`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-1.5">
                                <BookmakerName name={row.bookmaker} className="min-w-0 flex-1 [&_img]:max-h-6" />
                                <div className="flex items-center gap-1.5">
                                  {typeBadge}
                                  <span
                                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 font-mono text-[10px] ${OUTCOME_BADGE_CLASSES[row.outcome]}`}
                                  >
                                    {row.outcome}
                                  </span>
                                </div>
                              </div>
                              {/*
                                Förenklad rad: vi visar bara "pengar på sidan" — själva
                                resultatet i kr. Odds + insats är dolda per användarbegäran
                                (de behövs inte i loggvyn, finns kvar i RoundBetRow-datan
                                om vi vill ta tillbaka senare).
                              */}
                              {/* Förlust-text borttagen — badge-färgen räcker som indikator.
                                * Vinst (+kr) och "vid vinst kr"-prognos visas fortfarande. */}
                              {won !== false && (
                                <div className="mt-1 flex items-center justify-end font-mono">
                                  <span
                                    className={`text-[11px] ${won === true ? "text-emerald-300 font-semibold" : "text-muted-foreground"}`}
                                    title={row.payoutLabel}
                                  >
                                    {won === true
                                      ? `+${formatCurrency(row.payoutOnWin)}`
                                      : `vid vinst ${formatCurrency(row.payoutOnWin)}`}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  };

                  const isExpanded = expandedLogId === log.id;

                  return (
                    <Card key={log.id} className="overflow-hidden">
                      <CardContent className="p-0">
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          className="flex w-full items-start gap-2 p-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                          onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                        >
                          {isExpanded ? (
                            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          ) : (
                            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <Badge variant="secondary" className="mt-0 shrink-0">
                            #{bonusLogs.length - logIdx}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-bold sm:text-base">{log.matchName}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground sm:text-xs">
                              {log.bonusOptimizer.startTs && (
                                <span>{formatShortDateTime(log.bonusOptimizer.startTs)}</span>
                              )}
                              {/* Sajt-räknaren borttagen — bookmaker-loggorna i listan räcker. */}
                              <span aria-hidden>·</span>
                              <span>
                                {log.bonusOptimizer.rounds.length}{" "}
                                {log.bonusOptimizer.rounds.length === 1 ? "rond" : "ronder"}
                              </span>
                              {hasAnyResult && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span
                                    className={`font-mono font-semibold ${totalNet >= 0 ? "text-emerald-300" : "text-red-300"}`}
                                  >
                                    netto {formatSignedCurrency(totalNet)}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <Badge variant="secondary" className="shrink-0 text-[10px] sm:text-xs">
                            {statusLabel}
                          </Badge>
                        </button>

                        {isExpanded && (
                          <div className="space-y-4 border-t bg-background/40 p-3 sm:p-4">
                            {/* Per-rond-vy: varje rond är ett eget kort med spel-sajternas konton. */}
                            <div className="space-y-3">
                              <div className="rounded-md border bg-muted/20 p-3">
                                <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-sm font-semibold">Runda 1: {log.matchName}</div>
                                    <div className="text-[11px] text-muted-foreground">
                                      {log.bonusOptimizer.league && <>{log.bonusOptimizer.league} · </>}
                                      {formatShortDateTime(log.bonusOptimizer.startTs)}
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {day1Result && (
                                      <Badge className={OUTCOME_BADGE_CLASSES[day1Result]}>{day1Result}</Badge>
                                    )}
                                    {day1Net != null && (
                                      <Badge>netto {formatSignedCurrency(day1Net)}</Badge>
                                    )}
                                  </div>
                                </div>
                                <div className="mb-2">{renderRoundBets(buildR1Rows(), day1Result)}</div>
                                {/* Resultat-knapparna stannar kvar även efter val — tryckte man fel
                                  * kan man klicka om för att rätta. Valt utfall markeras (default-variant). */}
                                <div className="flex flex-wrap gap-1.5 border-t border-border/30 pt-2">
                                  <span className="self-center text-xs font-semibold text-muted-foreground">
                                    Markera resultat:
                                  </span>
                                  {(["1", "X", "2"] as Outcome[]).map((outcome) => (
                                    <Button
                                      key={outcome}
                                      size="sm"
                                      variant={day1Result === outcome ? "default" : "outline"}
                                      className="flex-1 text-xs"
                                      onClick={() => setHistoryResult(log, outcome)}
                                    >
                                      {outcomeName(log.matchName, outcome, t("outcome.draw"))} ({outcome})
                                    </Button>
                                  ))}
                                </div>
                              </div>

                              {continuationRounds.map((round) => {
                                const roundPlan = round.plan as ContinuationPlan | undefined;
                                const netto =
                                  round.result && roundPlan
                                    ? roundPlan.paybackPerOutcome[round.result]
                                    : undefined;
                                const rows = roundPlan ? buildContinuationRows(roundPlan, round.id) : [];
                                return (
                                  <div key={round.id} className="rounded-md border bg-muted/20 p-3">
                                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                                      <div className="min-w-0">
                                        <div className="text-sm font-semibold">
                                          Runda {round.round}: {round.matchName}
                                        </div>
                                        <div className="text-[11px] text-muted-foreground">
                                          {round.league && <>{round.league} · </>}
                                          {formatShortDateTime(round.startTs)}
                                        </div>
                                      </div>
                                      <div className="flex flex-wrap gap-1.5">
                                        {round.result && (
                                          <Badge className={OUTCOME_BADGE_CLASSES[round.result]}>{round.result}</Badge>
                                        )}
                                        {netto != null && <Badge>netto {formatSignedCurrency(netto)}</Badge>}
                                      </div>
                                    </div>
                                    <div className="mb-2">{renderRoundBets(rows, round.result)}</div>
                                    {/* Resultat-knapparna STANNAR kvar även efter att man valt — tryckte
                                      * man fel utfall kan man klicka om för att rätta. Det valda utfallet
                                      * markeras (default-variant), övriga är outline. */}
                                    <div className="flex flex-wrap gap-1.5 border-t border-border/30 pt-2">
                                      <span className="self-center text-xs font-semibold text-muted-foreground">
                                        Markera resultat:
                                      </span>
                                      {(["1", "X", "2"] as Outcome[]).map((outcome) => (
                                        <Button
                                          key={outcome}
                                          size="sm"
                                          variant={round.result === outcome ? "default" : "outline"}
                                          className="flex-1 text-xs"
                                          onClick={() => setContinuationRoundResult(log, round.id, outcome)}
                                        >
                                          {outcomeName(round.matchName, outcome, t("outcome.draw"))} ({outcome})
                                        </Button>
                                      ))}
                                    </div>
                                    {round.result && (
                                      <div className="border-t border-border/30 pt-2 text-[11px] text-muted-foreground">
                                        Konton som rullas vidare:{" "}
                                        {Array.isArray(round.remainingAccountsAfterResult) &&
                                        round.remainingAccountsAfterResult.length > 0
                                          ? (round.remainingAccountsAfterResult as WageringAccount[])
                                              .map((a) => `${a.bookmaker} (${formatCurrency(a.balance)})`)
                                              .join(", ")
                                          : "inga (rondkedjan klar)"}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>

                            {/* Översikt: kumulativ omsättningsstatus per matched-bookmaker. */}
                            {wageringProgress.length > 0 && (
                              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
                                <div className="mb-2 flex items-center justify-between">
                                  <span className="text-sm font-semibold">{t("bonusOpt.requirementsMatched")}</span>
                                  <Badge variant="secondary">
                                    {clearedBonuses.length} av {wageringProgress.length} klara
                                  </Badge>
                                </div>
                                <div className="space-y-2">
                                  {wageringProgress.map((p) => {
                                    const pct =
                                      p.target > 0
                                        ? Math.min(100, Math.round((p.placed / p.target) * 100))
                                        : 0;
                                    const statusBadge =
                                      p.status === "cleared" ? (
                                        <Badge className="bg-emerald-500/20 text-emerald-200 border border-emerald-500/40">
                                          Klar — kan tas ut
                                        </Badge>
                                      ) : p.status === "lost" ? (
                                        <Badge variant="destructive">{t("bonusOpt.lost")}</Badge>
                                      ) : p.status === "in-progress" ? (
                                        <Badge className="bg-amber-500/20 text-amber-200 border border-amber-500/40">
                                          Pågår
                                        </Badge>
                                      ) : (
                                        <Badge variant="secondary">Väntar resultat</Badge>
                                      );
                                    const alreadyEarned = earnedBookmakerIds.has(p.bookmakerId);
                                    const showSuggestEarn = p.status === "cleared" && !alreadyEarned;
                                    const suggestedAmount = defaultAmountForBookmaker(p.bookmakerId);
                                    return (
                                      <div
                                        key={p.bookmakerId}
                                        className="rounded border border-emerald-500/20 bg-background/40 p-2"
                                      >
                                        <div className="mb-1 flex flex-wrap items-center justify-between gap-1.5 text-xs">
                                          <div className="flex flex-wrap items-center gap-1.5">
                                            <BookmakerName name={p.bookmaker} />
                                            <span className="font-mono text-muted-foreground">
                                              {formatCurrency(p.placed)} / {formatCurrency(p.target)}
                                              {p.target > 0 && <span className="ml-1">({pct}%)</span>}
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-1.5">
                                            {p.currentBalance > 0 && p.status !== "lost" && (
                                              <Badge variant="secondary" className="font-mono">
                                                saldo {formatCurrency(p.currentBalance)}
                                              </Badge>
                                            )}
                                            {statusBadge}
                                          </div>
                                        </div>
                                        <Progress
                                          value={pct}
                                          className={`h-2 ${
                                            p.status === "cleared"
                                              ? "[&>div]:bg-emerald-500"
                                              : p.status === "lost"
                                                ? "[&>div]:bg-red-500/60"
                                                : "[&>div]:bg-amber-500"
                                          }`}
                                        />
                                        {showSuggestEarn && suggestedAmount > 0 && (
                                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-violet-500/30 bg-violet-500/10 px-2 py-1.5 text-xs">
                                            <span className="text-violet-200">
                                              Tjäna in freebet från {p.bookmaker}-bonusen?
                                              <span className="ml-1 text-muted-foreground">
                                                (default {formatCurrency(suggestedAmount)} · min 1.50)
                                              </span>
                                            </span>
                                            <Button
                                              size="sm"
                                              variant="secondary"
                                              className="h-7 px-2 text-xs"
                                              onClick={() =>
                                                addEarnedFreebet(
                                                  log,
                                                  p.bookmakerId,
                                                  suggestedAmount,
                                                  1.5,
                                                  sourceRoundForNewEarned,
                                                  `Auto-genererad: ${p.bookmaker} omsättning klar.`,
                                                )
                                              }
                                            >
                                              + Lägg till freebet
                                            </Button>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {state.waitingForRoundResult ? (
                              <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.05] p-3 text-xs text-amber-200">
                                Markera resultatet på Runda {state.waitingForRoundResult} innan du startar nästa rond.
                              </div>
                            ) : canOptimizeNext ? (
                              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] p-3">
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                  <div>
                                    <div className="text-sm font-semibold">Starta Runda {state.nextRound}</div>
                                    <div className="text-xs text-muted-foreground">
                                      {state.accounts.length} konton ·{" "}
                                      {formatCurrency(state.accounts.reduce((s, a) => s + a.balance, 0))} matched ·{" "}
                                      {state.vouchers.length} freebets ·{" "}
                                      {formatCurrency(state.vouchers.reduce((s, v) => s + v.amount, 0))}
                                    </div>
                                  </div>
                                  <Button
                                    size="sm"
                                    onClick={() => void fetchContinuationMatches(log)}
                                    disabled={isLoadingContinuation}
                                  >
                                    {isLoadingContinuation ? t("bonusOpt.searching") : `Optimera Runda ${state.nextRound}`}
                                  </Button>
                                </div>

                                {/* Tappa-matched-läge: tvinga matched bets till ≥X odds så de
                                  * troligen FÖRLORAR — snabbare exit från omsättningskrav.
                                  * Freebets påverkas EJ (egen voucher.minOdds gäller fortfarande).
                                  */}
                                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/[0.04] px-3 py-2 text-xs">
                                  <label className="flex items-center gap-1.5">
                                    <input
                                      type="checkbox"
                                      checked={tappaMatchedEnabled}
                                      onChange={(e) => setTappaMatchedEnabled(e.target.checked)}
                                      className="h-3.5 w-3.5"
                                    />
                                    <span className="font-medium">Tappa matched</span>
                                  </label>
                                  {tappaMatchedEnabled && (
                                    <>
                                      <span className="text-muted-foreground">min odds</span>
                                      <Input
                                        type="number"
                                        step="0.1"
                                        min="1.01"
                                        max="15"
                                        value={tappaMatchedMinOdds}
                                        onChange={(e) => setTappaMatchedMinOdds(parseFloat(e.target.value) || 3.5)}
                                        className="h-7 w-20 px-2 text-xs"
                                      />
                                      <span className="text-[10px] text-muted-foreground italic">
                                        bonus-bets placeras på ≥{tappaMatchedMinOdds} odds (förlorar troligen → snabb-exit). Pinnacle/Smarkets-komplementet täcker de låga oddsen. Freebets opåverkade.
                                      </span>
                                    </>
                                  )}
                                </div>

                                {continuationMatches.length > 0 && (
                                  <div className="mt-2 space-y-2">
                                    {continuationMatches.slice(0, 3).map((m) => {
                                      const key = `${log.id}:${m.title}`;
                                      const expanded = expandedContinuationKey === key;
                                      const cplan = m.optimization.best;
                                      return (
                                        <div key={key} className="rounded border border-emerald-500/20 bg-background/40">
                                          <button
                                            type="button"
                                            className="flex w-full items-center justify-between gap-2 p-2 text-left hover:bg-muted/40"
                                            onClick={() => setExpandedContinuationKey(expanded ? null : key)}
                                          >
                                            <div>
                                              <div className="text-sm font-semibold">{m.title}</div>
                                              <div className="text-xs text-muted-foreground">
                                                {m.league && <>{m.league} · </>}
                                                {formatShortDateTime(m.startTs)}
                                              </div>
                                            </div>
                                            <div className="flex items-center gap-1.5 text-xs">
                                              <Badge>min {formatSignedCurrency(cplan.minPayback)}</Badge>
                                              <Badge variant="secondary">{formatPercent(cplan.averageEdgePct)}</Badge>
                                            </div>
                                          </button>
                                          {expanded && (
                                            <div className="space-y-3 border-t p-2">
                                              {/* Varning: en eller flera matched-sajter finns INTE på denna match
                                                * (ens via systerbrand). De uteslöts ur planen — användaren måste
                                                * komplettera dem separat via Bonus Findern. Visas bara i nödfall
                                                * (ingen full-täckande match hittades). */}
                                              {(m.missingAccountBookmakers?.length ?? 0) > 0 && (
                                                <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
                                                  ⚠ Varning: matchen hittas ej på{" "}
                                                  <span className="font-semibold">
                                                    {m.missingAccountBookmakers!.map((b) => b.bookmaker).join(", ")}
                                                  </span>{" "}
                                                  — den/de sajterna uteslöts ur planen. Komplettera{" "}
                                                  {m.missingAccountBookmakers!.length > 1 ? "dem" : "den"} separat via
                                                  Bonus Findern.
                                                </div>
                                              )}
                                              {/* Dag-N-planen sparas alltid som EN runda (continuationRound).
                                                * UI:t delas upp visuellt i Matched + Freebets så det är lätt
                                                * att skilja insatstyperna, men `saveContinuationRound(log, m, cplan)`
                                                * sparar hela cplan oavsett vilken save-knapp användaren klickar.
                                                * Båda knapparna är därför likvärdiga.
                                                */}
                                              {cplan.wageringBets.length > 0 && (
                                                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04]">
                                                  <div className="flex items-center justify-between border-b border-emerald-500/20 px-3 py-1.5">
                                                    <span className="text-xs font-semibold uppercase tracking-wide text-emerald-300">
                                                      Matched bets ({cplan.wageringBets.length})
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground" title="Bidrar till omsättningskravet, vinst stake×odds">
                                                      stake×odds
                                                    </span>
                                                  </div>
                                                  <Table>
                                                    <TableHeader>
                                                      <TableRow>
                                                        <TableHead className="font-bold">Bookmaker</TableHead>
                                                        <TableHead className="font-bold">{t("bonusOpt.outcome")}</TableHead>
                                                        <TableHead className="font-bold">Insats</TableHead>
                                                        <TableHead className="font-bold">Odds</TableHead>
                                                        <TableHead className="font-bold">{t("bonusOpt.profitModel")}</TableHead>
                                                      </TableRow>
                                                    </TableHeader>
                                                    <TableBody>
                                                      {cplan.wageringBets.map((wb, i) => (
                                                        <TableRow key={`m-${wb.bookmakerId}-${i}`}>
                                                          <TableCell><BookmakerName name={wb.bookmaker} /></TableCell>
                                                          <TableCell>
                                                            <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 font-mono text-xs ${OUTCOME_BADGE_CLASSES[wb.outcome]}`}>
                                                              {wb.outcome}
                                                            </span>
                                                          </TableCell>
                                                          <TableCell className="font-mono text-xs">{formatCurrency(wb.stake)}</TableCell>
                                                          <TableCell className="font-mono text-xs">{formatOddsDisplay(wb.odds)}</TableCell>
                                                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                                                            stake×odds = {formatCurrency(wb.stake * wb.odds)}
                                                          </TableCell>
                                                        </TableRow>
                                                      ))}
                                                    </TableBody>
                                                  </Table>
                                                  <div className="flex justify-end gap-2 border-t border-emerald-500/20 px-3 py-2">
                                                    <span className="text-[10px] text-muted-foreground self-center">
                                                      Sparar BÅDA sektionerna i samma runda
                                                    </span>
                                                    <Button
                                                      size="sm"
                                                      onClick={() => saveContinuationRound(log, m, cplan)}
                                                    >
                                                      Spara Runda {state.nextRound}
                                                    </Button>
                                                  </div>
                                                </div>
                                              )}

                                              {/* AUTO-komplement från algoritmen — hedge för matched-bets.
                                                * Algoritmen letar bästa odds bland alla scrapade sajter (Pinnacle +
                                                * alla bookmakers) per saknat utfall och räknar ut stake för att
                                                * minimum-payback per outcome blir balanserad.
                                                * Visas bara om plan.cashComplements har innehåll. */}
                                              {cplan.cashComplements.length > 0 && (
                                                <div className="rounded-md border border-sky-500/30 bg-sky-500/[0.04]">
                                                  <div className="flex items-center justify-between border-b border-sky-500/20 px-3 py-1.5">
                                                    <span className="text-xs font-semibold uppercase tracking-wide text-sky-300">
                                                      Komplement-bets ({cplan.cashComplements.length})
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground" title="Auto-beräknat: hitta bästa odds per saknat utfall för hedge mot matched-loss">
                                                      auto · bästa externa odds
                                                    </span>
                                                  </div>
                                                  <Table>
                                                    <TableHeader>
                                                      <TableRow>
                                                        <TableHead className="font-bold">Bookmaker</TableHead>
                                                        <TableHead className="font-bold">{t("bonusOpt.outcome")}</TableHead>
                                                        <TableHead className="font-bold">Insats</TableHead>
                                                        <TableHead className="font-bold">Odds</TableHead>
                                                        <TableHead className="font-bold">Vinst om träff</TableHead>
                                                      </TableRow>
                                                    </TableHeader>
                                                    <TableBody>
                                                      {cplan.cashComplements.map((c, i) => (
                                                        <TableRow key={`${c.bookmakerId}-${c.outcome}-${i}`}>
                                                          <TableCell><BookmakerName name={c.bookmaker} /></TableCell>
                                                          <TableCell>
                                                            <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 font-mono text-xs ${OUTCOME_BADGE_CLASSES[c.outcome]}`}>
                                                              {c.outcome}
                                                            </span>
                                                          </TableCell>
                                                          <TableCell className="font-mono text-xs">{formatCurrency(c.stake)}</TableCell>
                                                          <TableCell className="font-mono text-xs">{formatOddsDisplay(c.odds)}</TableCell>
                                                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                                                            stake×odds = {formatCurrency(c.grossReturn)}
                                                          </TableCell>
                                                        </TableRow>
                                                      ))}
                                                    </TableBody>
                                                  </Table>
                                                  <p className="border-t border-sky-500/20 px-3 py-2 text-[10px] italic text-muted-foreground">
                                                    Placeras på Pinnacle/Smarkets (de låga oddsen) för att täcka tappa-matched-rundan — där vill du vinna pengarna. Total stake: {formatCurrency(cplan.totalCashComplementStake)}.
                                                  </p>
                                                </div>
                                              )}

                                              {cplan.freebetBets.length > 0 && (
                                                <div className="rounded-md border border-violet-500/30 bg-violet-500/[0.04]">
                                                  <div className="flex items-center justify-between border-b border-violet-500/20 px-3 py-1.5">
                                                    <span className="text-xs font-semibold uppercase tracking-wide text-violet-300">
                                                      Freebets ({cplan.freebetBets.length})
                                                    </span>
                                                    <span className="text-[10px] text-muted-foreground" title="Ingen omsättning, vinst (odds−1)×stake">
                                                      (odds−1)×stake
                                                    </span>
                                                  </div>
                                                  <Table>
                                                    <TableHeader>
                                                      <TableRow>
                                                        <TableHead className="font-bold">Bookmaker</TableHead>
                                                        <TableHead className="font-bold">{t("bonusOpt.outcome")}</TableHead>
                                                        <TableHead className="font-bold">Insats</TableHead>
                                                        <TableHead className="font-bold">Odds</TableHead>
                                                        <TableHead className="font-bold">{t("bonusOpt.profitModel")}</TableHead>
                                                      </TableRow>
                                                    </TableHeader>
                                                    <TableBody>
                                                      {cplan.freebetBets.map((fb, i) => (
                                                        <TableRow key={`f-${fb.bookmakerId}-${i}`}>
                                                          <TableCell><BookmakerName name={fb.bookmaker} /></TableCell>
                                                          <TableCell>
                                                            <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 font-mono text-xs ${OUTCOME_BADGE_CLASSES[fb.outcome]}`}>
                                                              {fb.outcome}
                                                            </span>
                                                          </TableCell>
                                                          <TableCell className="font-mono text-xs">{formatCurrency(fb.amount)}</TableCell>
                                                          <TableCell className="font-mono text-xs">{formatOddsDisplay(fb.odds)}</TableCell>
                                                          <TableCell className="font-mono text-[11px] text-muted-foreground">
                                                            (odds−1)×stake = {formatCurrency(fb.profitOnWin)}
                                                          </TableCell>
                                                        </TableRow>
                                                      ))}
                                                    </TableBody>
                                                  </Table>
                                                  <div className="flex justify-end gap-2 border-t border-violet-500/20 px-3 py-2">
                                                    <span className="text-[10px] text-muted-foreground self-center">
                                                      Sparar BÅDA sektionerna i samma runda
                                                    </span>
                                                    <Button
                                                      size="sm"
                                                      onClick={() => saveContinuationRound(log, m, cplan)}
                                                    >
                                                      Spara Runda {state.nextRound}
                                                    </Button>
                                                  </div>
                                                </div>
                                              )}

                                              {cplan.wageringBets.length === 0 && cplan.freebetBets.length === 0 && (
                                                <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                                                  Inga bets i planen.
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ) : day1Result ? (
                              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                                Inga aktiva konton eller freebets kvar — rondkedjan är klar.
                              </div>
                            ) : null}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
