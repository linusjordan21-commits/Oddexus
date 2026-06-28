import { Link } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BrandHeader } from "@/components/BrandHeader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useUserSettings } from "@/hooks/useUserSettings";
import { apiUrl } from "@/lib/apiUrl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const BRAND_STAKE_SRC = `${import.meta.env.BASE_URL}brands/stake-logo.png`;
const BRAND_BETONLINE_SRC = `${import.meta.env.BASE_URL}brands/betonline-logo.png`;

type BrandSize = "xs" | "sm" | "md" | "lg";

const brandImgHeight: Record<BrandSize, string> = {
  xs: "h-3.5",
  sm: "h-4",
  md: "h-5",
  lg: "h-8",
};

function BrandStake({ size = "md", className }: { size?: BrandSize; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md bg-black px-2 py-0.5 ring-1 ring-white/15",
        className,
      )}
    >
      <img
        src={BRAND_STAKE_SRC}
        alt="Stake"
        className={cn(brandImgHeight[size], "w-auto max-w-[min(7rem,100%)] object-contain object-left")}
      />
    </span>
  );
}

function BrandBetOnline({ size = "md", className }: { size?: BrandSize; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md bg-black px-2 py-0.5 ring-1 ring-white/15",
        className,
      )}
    >
      <img
        src={BRAND_BETONLINE_SRC}
        alt="BetOnline"
        className={cn(brandImgHeight[size], "w-auto max-w-[min(9rem,100%)] object-contain object-left")}
      />
    </span>
  );
}

type StakeRow = {
  source: "stake";
  sport?: string;
  match: string;
  startTime?: number;
  tournament?: string;
  homeName?: string;
  awayName?: string;
  homeOutcomeLabel?: string;
  awayOutcomeLabel?: string;
  marketType?: "moneyline" | "spread" | "total";
  line?: number;
  marketLabel?: string;
};

type MatchedOpportunity = {
  match: string;
  sport?: string;
  startTime?: number;
  tournament?: string;
  marketType?: "moneyline" | "spread" | "total";
  marketLabel?: string;
  line?: number;
  stakeMatch: string;
  betOnlineMatch: string;
  stakeSide: "home" | "draw" | "away";
  stakeOutcomeLabel?: string;
  stakeOdds: number;
  betOnlineSide: "home" | "draw" | "away";
  betOnlineOutcomeLabel?: string;
  betOnlineOdds: number;
  stakeStake: number;
  betOnlineStake: number;
  totalStake: number;
  payout: number;
  profit: number;
  edgePct: number;
  legs?: Array<{
    book: "stake" | "betonline";
    outcome: "home" | "draw" | "away";
    label: string;
    odds: number;
    stake: number;
    payout: number;
    result: number;
  }>;
};

type AutoResponse = {
  ok: boolean;
  error?: string;
  updatedAt?: string;
  stakeUpdatedAt?: string;
  betOnlineUpdatedAt?: string;
  stakeCount?: number;
  betOnlineCount?: number;
  stakeRows?: StakeRow[];
  opportunities?: MatchedOpportunity[];
};

/** Siffror: läsbara siffror med jämn bredd utan monospace-känsla */
const FIGURE = "tabular-nums tracking-tight";

function formatOdds(value?: number) {
  if (!value || !Number.isFinite(value)) return "–";
  return value.toLocaleString("sv-SE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatCurrency(value: number) {
  const rounded = Math.round(value);
  return rounded.toLocaleString("sv-SE", { maximumFractionDigits: 0 }) + "\u00a0kr";
}

function formatSignedCurrency(value: number) {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded).toLocaleString("sv-SE", { maximumFractionDigits: 0 });
  if (rounded === 0) return `0\u00a0kr`;
  const sign = rounded > 0 ? "+" : "−";
  return `${sign}${abs}\u00a0kr`;
}

function formatPercent(value: number) {
  return (
    value.toLocaleString("sv-SE", {
      minimumFractionDigits: 0,
      maximumFractionDigits: value === 0 ? 0 : Math.abs(value) < 1 ? 2 : 1,
    }) + "\u00a0%"
  );
}

/** Endast klockslag (ingen månad/dag). */
function formatClockTime(value?: number): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

/** Relativ tid till matchstart (endast framtida tider). startTime kan vara ms eller sekunder (unix). */
function formatRelativeUntilStart(startTime?: number): string | null {
  if (startTime == null || !Number.isFinite(startTime)) return null;
  const startMs = startTime < 1e12 ? startTime * 1000 : startTime;
  const diff = startMs - Date.now();
  if (diff <= 0) return null;

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diff >= dayMs) {
    const days = Math.ceil(diff / dayMs);
    return days === 1 ? "om 1 dag" : `om ${days} dagar`;
  }
  if (diff >= hourMs) {
    const hours = Math.max(1, Math.round(diff / hourMs));
    return hours === 1 ? "om 1 h" : `om ${hours} h`;
  }
  const mins = Math.max(1, Math.ceil(diff / minuteMs));
  return mins === 1 ? "om 1 min" : `om ${mins} min`;
}

function teamForSide(
  row: StakeRow | undefined,
  side: "home" | "draw" | "away",
  labels: { home: string; draw: string; away: string },
) {
  if (side === "draw") return labels.draw;
  if (!row) return side === "home" ? labels.home : labels.away;
  if (side === "home") return row.homeName ?? row.match.split(" - ")[0] ?? labels.home;
  return row.awayName ?? row.match.split(" - ").slice(-1)[0] ?? labels.away;
}

const SPORT_LABELS: Record<string, string> = {
  soccer: "Fotboll",
  basketball: "Basket",
  tennis: "Tennis",
  "ice-hockey": "Ishockey",
  "american-football": "Amerikansk fotboll",
  baseball: "Baseball",
  mma: "MMA",
  boxing: "Boxning",
};

function parseAmount(value: string) {
  const amount = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function formatInputAmount(value: number) {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function balancedStakesForTotal(totalStake: number, stakeOdds: number, betOnlineOdds: number) {
  const oddsSum = stakeOdds + betOnlineOdds;
  if (!(totalStake > 0) || !(oddsSum > 0)) return { stakeStake: 0, betOnlineStake: 0 };
  return {
    stakeStake: (totalStake * betOnlineOdds) / oddsSum,
    betOnlineStake: (totalStake * stakeOdds) / oddsSum,
  };
}

function buildCustomStakePlan(item: MatchedOpportunity, stakeStake: number, betOnlineStake: number) {
  if (item.legs?.length) {
    const scale = item.totalStake > 0 ? (stakeStake + betOnlineStake) / item.totalStake : 1;
    const legs = item.legs.map((leg) => ({
      ...leg,
      stake: leg.stake * scale,
      payout: leg.payout * scale,
      result: leg.result * scale,
    }));
    const totalStake = legs.reduce((sum, leg) => sum + leg.stake, 0);
    const payouts = legs.map((leg) => leg.payout);
    const guaranteedProfit = Math.min(...payouts) - totalStake;
    return {
      totalStake,
      stakePayout: legs.filter((leg) => leg.book === "stake").reduce((sum, leg) => sum + leg.payout, 0),
      betOnlinePayout: legs.filter((leg) => leg.book === "betonline").reduce((sum, leg) => sum + leg.payout, 0),
      stakeResult: legs.filter((leg) => leg.book === "stake").reduce((sum, leg) => sum + leg.result, 0),
      betOnlineResult: legs.filter((leg) => leg.book === "betonline").reduce((sum, leg) => sum + leg.result, 0),
      guaranteedProfit,
      edgePct: totalStake > 0 ? (guaranteedProfit / totalStake) * 100 : 0,
      payoutGap: Math.max(...payouts) - Math.min(...payouts),
      legs,
    };
  }

  const totalStake = stakeStake + betOnlineStake;
  const stakePayout = stakeStake * item.stakeOdds;
  const betOnlinePayout = betOnlineStake * item.betOnlineOdds;
  const stakeResult = stakePayout - totalStake;
  const betOnlineResult = betOnlinePayout - totalStake;
  const guaranteedProfit = Math.min(stakeResult, betOnlineResult);

  return {
    totalStake,
    stakePayout,
    betOnlinePayout,
    stakeResult,
    betOnlineResult,
    guaranteedProfit,
    edgePct: totalStake > 0 ? (guaranteedProfit / totalStake) * 100 : 0,
    payoutGap: Math.abs(stakePayout - betOnlinePayout),
    legs: null,
  };
}

type OpportunityCardProps = {
  item: MatchedOpportunity;
  index: number;
  stakeRow?: StakeRow;
};

function OpportunityCard({ item, index, stakeRow }: OpportunityCardProps) {
  const { t } = useUserSettings();
  const outcomeLabels = { home: t("outcome.home"), draw: t("outcome.draw"), away: t("outcome.away") };
  const [stakeInput, setStakeInput] = useState(formatInputAmount(item.stakeStake));
  const [betOnlineInput, setBetOnlineInput] = useState(formatInputAmount(item.betOnlineStake));
  const [totalInput, setTotalInput] = useState(formatInputAmount(item.totalStake));

  useEffect(() => {
    setStakeInput(formatInputAmount(item.stakeStake));
    setBetOnlineInput(formatInputAmount(item.betOnlineStake));
    setTotalInput(formatInputAmount(item.totalStake));
  }, [item]);

  const stakeAmount = parseAmount(stakeInput);
  const betOnlineAmount = parseAmount(betOnlineInput);
  const plan = useMemo(
    () => buildCustomStakePlan(item, stakeAmount, betOnlineAmount),
    [betOnlineAmount, item, stakeAmount],
  );

  const clockStart = formatClockTime(item.startTime ?? stakeRow?.startTime);
  const untilStart = formatRelativeUntilStart(item.startTime ?? stakeRow?.startTime);
  const sportLabel = item.sport ? SPORT_LABELS[item.sport] ?? item.sport : null;
  const marketLabel = item.marketLabel ?? (item.marketType === "moneyline" ? "Moneyline" : null);
  const stakeTeam = item.stakeOutcomeLabel ?? teamForSide(stakeRow, item.stakeSide, outcomeLabels);
  const betOnlineTeam = item.betOnlineOutcomeLabel ?? teamForSide(stakeRow, item.betOnlineSide, outcomeLabels);
  const inputId = `stake-betonline-${index}`;
  const displayLegs =
    plan.legs ??
    [
      {
        book: "stake" as const,
        outcome: item.stakeSide,
        label: stakeTeam,
        odds: item.stakeOdds,
        stake: stakeAmount,
        payout: plan.stakePayout,
        result: plan.stakeResult,
      },
      {
        book: "betonline" as const,
        outcome: item.betOnlineSide,
        label: betOnlineTeam,
        odds: item.betOnlineOdds,
        stake: betOnlineAmount,
        payout: plan.betOnlinePayout,
        result: plan.betOnlineResult,
      },
    ];
  const stakeDisplayLegs = displayLegs.filter((leg) => leg.book === "stake");
  const betOnlineDisplayLegs = displayLegs.filter((leg) => leg.book === "betonline");
  const cardTone =
    plan.guaranteedProfit >= 0
      ? "border-emerald-500/40 bg-emerald-500/10"
      : plan.edgePct >= -1.5
        ? "border-amber-400/40 bg-amber-50/40 dark:bg-amber-950/20"
        : "bg-muted/20";

  const rebalanceTotal = (rawTotal: string) => {
    setTotalInput(rawTotal);
    const totalStake = parseAmount(rawTotal);
    if (item.legs?.length && item.totalStake > 0) {
      const scale = totalStake / item.totalStake;
      setStakeInput(formatInputAmount(item.stakeStake * scale));
      setBetOnlineInput(formatInputAmount(item.betOnlineStake * scale));
      return;
    }
    const balanced = balancedStakesForTotal(totalStake, item.stakeOdds, item.betOnlineOdds);
    setStakeInput(formatInputAmount(balanced.stakeStake));
    setBetOnlineInput(formatInputAmount(balanced.betOnlineStake));
  };

  const updateStakeInput = (value: string) => {
    setStakeInput(value);
    setTotalInput(formatInputAmount(parseAmount(value) + betOnlineAmount));
  };

  const updateBetOnlineInput = (value: string) => {
    setBetOnlineInput(value);
    setTotalInput(formatInputAmount(stakeAmount + parseAmount(value)));
  };

  const balanceCurrentTotal = () => {
    rebalanceTotal(formatInputAmount(plan.totalStake || item.totalStake));
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`w-full rounded-md border p-3 text-left text-sm transition hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${cardTone}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold leading-snug">{item.match}</div>
            <Badge
              variant={plan.guaranteedProfit >= 0 ? "default" : "secondary"}
              className={cn(FIGURE, "shrink-0 px-2.5 py-0.5 text-xs font-medium")}
            >
              {formatPercent(plan.edgePct)}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {sportLabel && <span>{sportLabel}</span>}
            {item.tournament && <span>· {item.tournament}</span>}
            {marketLabel && <span>· {marketLabel}</span>}
            {untilStart && <span>· {untilStart}</span>}
            {clockStart && <span>· {clockStart}</span>}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border bg-background/60 p-2.5 shadow-sm">
              <BrandStake size="sm" className="mb-2" />
              <div className="space-y-1">
                {stakeDisplayLegs.map((leg) => (
                  <div key={`${leg.book}-${leg.outcome}`} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-[13px] font-medium leading-snug">{leg.label}</span>
                    <span className={cn(FIGURE, "text-lg font-semibold text-foreground")}>
                      {formatOdds(leg.odds)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-lg border bg-background/60 p-2.5 shadow-sm">
              <BrandBetOnline size="sm" className="mb-2" />
              <div className="space-y-1">
                {betOnlineDisplayLegs.map((leg) => (
                  <div key={`${leg.book}-${leg.outcome}`} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-[13px] font-medium leading-snug">{leg.label}</span>
                    <span className={cn(FIGURE, "text-lg font-semibold text-foreground")}>
                      {formatOdds(leg.odds)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item.match}</DialogTitle>
          <DialogDescription>
            Ändra totalinsats eller sätt egna belopp per bookmaker (se logotyperna nedan).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor={`${inputId}-total`}>Total insats</Label>
              <Input
                id={`${inputId}-total`}
                inputMode="decimal"
                min="0"
                step="10"
                type="number"
                value={totalInput}
                onChange={(event) => rebalanceTotal(event.target.value)}
                className={cn(FIGURE, "text-base")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${inputId}-stake`} className="flex items-center gap-2">
                <BrandStake size="sm" />
                <span className="sr-only">Insats Stake</span>
              </Label>
              <Input
                id={`${inputId}-stake`}
                inputMode="decimal"
                min="0"
                step="10"
                type="number"
                value={stakeInput}
                onChange={(event) => updateStakeInput(event.target.value)}
                className={cn(FIGURE, "text-base")}
              />
              <div className="text-xs text-muted-foreground">
                {stakeDisplayLegs.map((leg) => (
                  <div key={`${leg.book}-${leg.outcome}`}>
                    <span>{leg.label}</span>
                    <span className="mx-1 text-muted-foreground/45">·</span>
                    <span className="text-muted-foreground">Odds </span>
                    <span className={cn(FIGURE, "font-semibold text-foreground")}>{formatOdds(leg.odds)}</span>
                    {item.legs?.length ? (
                      <>
                        <span className="mx-1 text-muted-foreground/45">·</span>
                        <span className={cn(FIGURE, "text-foreground")}>{formatCurrency(leg.stake)}</span>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${inputId}-betonline`} className="flex items-center gap-2">
                <BrandBetOnline size="sm" />
                <span className="sr-only">Insats BetOnline</span>
              </Label>
              <Input
                id={`${inputId}-betonline`}
                inputMode="decimal"
                min="0"
                step="10"
                type="number"
                value={betOnlineInput}
                onChange={(event) => updateBetOnlineInput(event.target.value)}
                className={cn(FIGURE, "text-base")}
              />
              <div className="text-xs text-muted-foreground">
                {betOnlineDisplayLegs.map((leg) => (
                  <div key={`${leg.book}-${leg.outcome}`}>
                    <span>{leg.label}</span>
                    <span className="mx-1 text-muted-foreground/45">·</span>
                    <span className="text-muted-foreground">Odds </span>
                    <span className={cn(FIGURE, "font-semibold text-foreground")}>{formatOdds(leg.odds)}</span>
                    {item.legs?.length ? (
                      <>
                        <span className="mx-1 text-muted-foreground/45">·</span>
                        <span className={cn(FIGURE, "text-foreground")}>{formatCurrency(leg.stake)}</span>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Button type="button" variant="secondary" size="sm" onClick={balanceCurrentTotal}>
            Balansera på totalen
          </Button>

          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {displayLegs.map((leg) => (
              <div key={`${leg.book}-${leg.outcome}`} className="rounded-lg border bg-muted/25 p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-muted-foreground">
                  {leg.book === "stake" ? <BrandStake size="xs" /> : <BrandBetOnline size="xs" />}
                  <span>{leg.label}</span>
                </div>
                <dl className="mt-2 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">Insats</dt>
                    <dd className={cn(FIGURE, "text-base font-semibold")}>{formatCurrency(leg.stake)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">Payout</dt>
                    <dd className={cn(FIGURE, "text-base font-semibold")}>{formatCurrency(leg.payout)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-muted-foreground">{t("stake.result")}</dt>
                    <dd className={cn(FIGURE, "text-base font-semibold")}>{formatSignedCurrency(leg.result)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <div className="rounded-lg border bg-muted/15 p-3 text-sm shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">{t("stake.worstCase")}</span>
              <span className={cn(FIGURE, "text-lg font-semibold tracking-normal text-foreground")}>
                {formatSignedCurrency(plan.guaranteedProfit)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                Edge{" "}
                <span className={cn(FIGURE, "font-semibold text-foreground")}>{formatPercent(plan.edgePct)}</span>
              </span>
              <span>
                {t("stake.difference")}{" "}
                <span className={cn(FIGURE, "font-semibold text-foreground")}>{formatCurrency(plan.payoutGap)}</span>
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function StakeBetOnline() {
  const { t } = useUserSettings();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoData, setAutoData] = useState<AutoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stakeRowByMatch = useMemo(() => {
    const map = new Map<string, StakeRow>();
    for (const row of autoData?.stakeRows ?? []) map.set(row.match, row);
    return map;
  }, [autoData?.stakeRows]);

  const opportunities = autoData?.opportunities ?? [];

  const loadFromCache = async () => {
    try {
      const response = await fetch(apiUrl("/api/stake-betonline/auto"), { method: "GET" });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(raw.slice(0, 240) || `HTTP ${response.status}`);
      }
      let data: AutoResponse;
      try {
        data = JSON.parse(raw) as AutoResponse;
      } catch {
        throw new Error(t("stake.invalidResponse"));
      }
      if (!data.ok) throw new Error(data.error || t("stake.fetchFailed"));
      setAutoData(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknownError"));
    }
  };

  const refreshNow = async () => {
    setRefreshing(true);
    try {
      const response = await fetch(apiUrl("/api/stake-betonline/auto"), { method: "POST" });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(raw.slice(0, 240) || `HTTP ${response.status}`);
      }
      let data: AutoResponse;
      try {
        data = JSON.parse(raw) as AutoResponse;
      } catch {
        throw new Error(t("stake.invalidResponse"));
      }
      if (!data.ok) throw new Error(data.error || t("stake.refreshFailed"));
      setAutoData(data);
      setError(null);
      toast.success(
        t("stake.updatedToast")
          .replace("{bo}", String(data.betOnlineCount ?? 0))
          .replace("{ops}", String(data.opportunities?.length ?? 0)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : t("stake.refreshFailed");
      setError(message);
      toast.error(message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadFromCache().finally(() => {
      if (active) setLoading(false);
    });
    const interval = setInterval(() => {
      void loadFromCache();
    }, 90_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <BrandHeader className="mb-4" />
        <Button asChild variant="ghost" size="sm" className="mb-4">
          <Link to="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("common.back")}
          </Link>
        </Button>

        <div className="mb-6">
          <Badge className="mb-3">{t("stake.fullyAutomatic")}</Badge>
          <h1 className="flex flex-wrap items-center gap-3">
            <span className="sr-only">Stake och BetOnline</span>
            <BrandStake size="lg" />
            <BrandBetOnline size="lg" />
          </h1>
        </div>

        <Card className="mb-4">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold">{t("betLog.status")}</div>
              {error && <div className="text-xs text-destructive">{error}</div>}
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void refreshNow()} disabled={refreshing}>
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? t("stake.refreshing") : t("stake.refreshNow")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">{t("stake.bestPlays")}</h2>
              <Badge variant="secondary" className={cn(FIGURE, "font-medium")}>
                {opportunities.length}
              </Badge>
            </div>

            {opportunities.length === 0 ? (
              <div className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
                {loading ? (
                  <span>
                    {t("stake.loadingHint")} <span className="text-xs">{t("stake.firstTimeHint")}</span>
                  </span>
                ) : (autoData?.stakeCount ?? 0) === 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <BrandStake size="sm" />
                    <span>{t("stake.noOddsLoaded")}</span>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <BrandBetOnline size="sm" />
                    <span>{t("stake.workerCheck")}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {opportunities.map((item, index) => {
                  const stakeRow = stakeRowByMatch.get(item.stakeMatch);
                  return (
                    <OpportunityCard
                      key={`${item.match}-${item.stakeSide}-${item.betOnlineSide}-${index}`}
                      item={item}
                      index={index}
                      stakeRow={stakeRow}
                    />
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
