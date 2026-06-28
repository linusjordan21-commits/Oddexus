import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import BookmakerName from "@/components/BookmakerName";
import { useUserSettings } from "@/hooks/useUserSettings";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Outcome, OUTCOMES } from "@/lib/hedging";

function siteOddsInputClass(active: boolean) {
  return `h-8 text-xs font-mono text-center px-1 ${active ? "ring-2 ring-primary/50 border-primary/40" : ""}`;
}

/**
 * OUTCOME_LABELS byggs runtime via injecerad t() — se buildOutcomeLabels nedan.
 * Behåller export-namnet för bakåtkompatibilitet om någon importerar konstanten.
 */
const buildOutcomeLabels = (t: (k: import("@/lib/settings/i18n").TranslationKey) => string): Record<Outcome, string> => ({
  '1': t("outcome.homeWithCode"),
  'X': t("outcome.drawWithCode"),
  '2': t("outcome.awayWithCode"),
});

function formatOddsValue(value?: number) {
  return value != null && value > 0 ? String(value).replace(".", ",") : "";
}

export interface BetSide {
  id: string;
  name: string;
  stake: number;
  isFreebet?: boolean;
  assignedOutcome?: Outcome;
  odds?: number;
}

interface Props {
  title: string;
  sites: BetSide[];
  onSitesChange: (sites: BetSide[]) => void;
  matchName: string;
  onMatchNameChange: (name: string) => void;
  allowStakeEdit?: boolean;
  allowConsume?: boolean;
  /** Dag 2 freebet: efter minst ett ifyllt odds visas flik för att förbruka freebets mot matched i Dag 2. */
  allowMatchedDay2FreebetTab?: boolean;
  /** Om satt styrs "Kompletteringssida" i motspel externt (t.ex. sparas i logg). */
  hedgeComplementSite?: string;
  onHedgeComplementSiteChange?: (name: string) => void;
  /** Konton från Dag 2 vinnare-match som kan finansiera motspel i freebet-matchen. */
  matchedFundingSites?: BetSide[];
  onMatchedFundingSitesChange?: (sites: BetSide[]) => void;
}

const fadeIn = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35 } };

export default function MatchCalculator({
  title,
  sites,
  onSitesChange,
  matchName,
  onMatchNameChange,
  allowStakeEdit = false,
  allowConsume = false,
  allowMatchedDay2FreebetTab = false,
  hedgeComplementSite,
  onHedgeComplementSiteChange,
  matchedFundingSites,
  onMatchedFundingSitesChange,
}: Props) {
  const { t } = useUserSettings();
  const OUTCOME_LABELS = buildOutcomeLabels(t);
  const [internalHedgeSite, setInternalHedgeSite] = useState("Pinnacle");
  const hedgeSiteControlled = onHedgeComplementSiteChange != null;
  const exchangeName = hedgeSiteControlled ? (hedgeComplementSite ?? "Pinnacle") : internalHedgeSite;
  const setExchangeName = (name: string) => {
    if (hedgeSiteControlled) onHedgeComplementSiteChange(name);
    else setInternalHedgeSite(name);
  };
  const [exchangeOdds, setExchangeOdds] = useState<Record<Outcome, number>>({ '1': 0, 'X': 0, '2': 0 });
  const [draftOdds, setDraftOdds] = useState<Record<string, string>>({});
  const [freebetD2Tab, setFreebetD2Tab] = useState("hedge");
  const [useMatchedFundingMode, setUseMatchedFundingMode] = useState(false);
  const [hedgeFundingRecords, setHedgeFundingRecords] = useState<
    Partial<Record<Outcome, { siteId: string; name: string; amount: number }[]>>
  >({});
  const [matchedFundingOdds, setMatchedFundingOdds] = useState<
    Record<string, Partial<Record<Outcome, number>>>
  >({});
  const [matchedFundingDraftOdds, setMatchedFundingDraftOdds] = useState<Record<string, string>>({});

  const getDraftKey = (siteId: string, outcome: Outcome) => `${siteId}:${outcome}`;
  const getFundingDraftKey = (siteId: string, outcome: Outcome) => `funding:${siteId}:${outcome}`;

  const parseOdds = (raw: string) => {
    const normalized = raw.trim().replace(",", ".");
    if (normalized === "" || normalized === "." || normalized.endsWith(".")) return null;
    const value = parseFloat(normalized);
    if (Number.isNaN(value) || value <= 0) return null;
    return value;
  };

  const moveOddsFocus = (event: KeyboardEvent<HTMLInputElement>, rowDelta: number) => {
    const target = event.currentTarget;
    const row = Number(target.dataset.row);
    const col = target.dataset.col;
    if (!Number.isFinite(row) || !col) return;
    const next = row + rowDelta;
    if (next < 0 || next >= sites.length) return;
    const nextInput = document.querySelector<HTMLInputElement>(
      `input[data-table="match-odds"][data-row="${next}"][data-col="${col}"]`,
    );
    if (!nextInput) return;
    event.preventDefault();
    nextInput.focus();
    nextInput.select();
  };

  const handleOddsKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "ArrowDown") {
      moveOddsFocus(event, 1);
    } else if (event.key === "ArrowUp") {
      moveOddsFocus(event, -1);
    }
  };

  const updateSite = (id: string, updates: Partial<BetSide>) => {
    onSitesChange(sites.map((site) => site.id === id ? { ...site, ...updates } : site));
  };

  const consumeSite = (id: string) => {
    onSitesChange(sites.filter((site) => site.id !== id));
  };

  const useMatchedFunding = useCallback((outcome: Outcome, source: BetSide, requestedStake: number) => {
    if (!matchedFundingSites || !onMatchedFundingSitesChange) return;
    const amount = Math.min(source.stake, Math.round(requestedStake));
    if (amount <= 0) return;

    onMatchedFundingSitesChange(
      matchedFundingSites
        .map((site) =>
          site.id === source.id ? { ...site, stake: Math.max(0, site.stake - amount) } : site,
        )
        .filter((site) => site.stake > 0),
    );
    setHedgeFundingRecords((prev) => ({
      ...prev,
      [outcome]: [...(prev[outcome] || []), { siteId: source.id, name: source.name, amount }],
    }));
  }, [matchedFundingSites, onMatchedFundingSitesChange]);

  const setMatchedFundingOdd = (siteId: string, outcome: Outcome, raw: string) => {
    const trimmed = raw.trim();
    const key = getFundingDraftKey(siteId, outcome);
    if (trimmed !== "" && !/^\d*(?:[.,]\d*)?$/.test(trimmed)) return;

    setMatchedFundingDraftOdds((prev) => ({ ...prev, [key]: raw }));

    if (trimmed === "") {
      setMatchedFundingDraftOdds((prev) => {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
      setMatchedFundingOdds((prev) => ({
        ...prev,
        [siteId]: { ...prev[siteId], [outcome]: undefined },
      }));
      return;
    }

    const v = parseOdds(trimmed);
    if (v == null) return;

    setMatchedFundingDraftOdds((prev) => {
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    setMatchedFundingOdds((prev) => ({
      ...prev,
      [siteId]: { ...prev[siteId], [outcome]: v },
    }));
  };

  const setSiteOddsForOutcome = (site: BetSide, outcome: Outcome, raw: string) => {
    const trimmed = raw.trim();
    const key = getDraftKey(site.id, outcome);
    if (trimmed !== "" && !/^\d*(?:[.,]\d*)?$/.test(trimmed)) return;

    setDraftOdds((prev) => ({ ...prev, [key]: raw }));

    if (trimmed === "") {
      setDraftOdds((prev) => {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
      updateSite(site.id, { assignedOutcome: undefined, odds: undefined });
      return;
    }

    const v = parseOdds(trimmed);
    if (v == null) return;

    setDraftOdds((prev) => {
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    updateSite(site.id, { assignedOutcome: outcome, odds: v });
  };

  const allAssigned = sites.length > 0 && sites.every((site) => site.assignedOutcome && site.odds && site.odds > 0);
  const someOddsEntered =
    sites.length > 0 &&
    sites.some((site) => site.assignedOutcome && site.odds != null && site.odds > 0);
  const showDay2FreebetMatchedTabs = allowMatchedDay2FreebetTab && someOddsEntered;
  const freebetsWithOdds = sites.filter(
    (site) => site.assignedOutcome && site.odds != null && site.odds > 0,
  );
  const allExchangeOdds = OUTCOMES.every((outcome) => exchangeOdds[outcome] > 0);
  const hasMatchedFunding = !!matchedFundingSites && !!onMatchedFundingSitesChange;
  const showMatchedFundingToggle = allowMatchedDay2FreebetTab;
  const availableMatchedFundingSites = (matchedFundingSites || []).filter((site) => site.stake > 0);

  const outcomeProfits = useMemo(() => {
    const profits: Record<Outcome, number> = { '1': 0, 'X': 0, '2': 0 };

    OUTCOMES.forEach((winningOutcome) => {
      profits[winningOutcome] = sites.reduce((sum, site) => {
        if (!site.assignedOutcome || !site.odds || site.odds <= 0) return sum;
        if (site.assignedOutcome === winningOutcome) {
          return sum + site.stake * (site.odds - 1);
        }
        return sum - (site.isFreebet ? 0 : site.stake);
      }, 0);
    });

    return profits;
  }, [sites]);

  // Back-betting hedge: for each outcome, calculate how much to back at Pinnacle
  // to equalize profit across all outcomes
  const hedgePlan = useMemo(() => {
    if (!allAssigned || !allExchangeOdds) return null;

    const maxProfit = Math.max(...OUTCOMES.map(o => outcomeProfits[o]));
    const backStakes: Record<Outcome, number> = { '1': 0, 'X': 0, '2': 0 };

    OUTCOMES.forEach(o => {
      const gap = maxProfit - outcomeProfits[o];
      if (gap > 0 && exchangeOdds[o] > 0) {
        backStakes[o] = gap / exchangeOdds[o];
      }
    });

    const totalStaked = OUTCOMES.reduce((s, o) => s + backStakes[o], 0);
    const equalProfit = maxProfit - totalStaked;

    return { backStakes, equalProfit, totalStaked };
  }, [allAssigned, allExchangeOdds, exchangeOdds, outcomeProfits]);

  const getMatchedFundingStake = (outcome: Outcome, odds?: number) => {
    if (!allAssigned || !odds || odds <= 0) return 0;
    const targetProfit = Math.max(...OUTCOMES.map((o) => outcomeProfits[o]));
    const gap = targetProfit - outcomeProfits[outcome];
    return gap > 0 ? gap / odds : 0;
  };

  const matchedFundingPanel = showMatchedFundingToggle && useMatchedFundingMode ? (
    <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-3 space-y-2">
      <div className="text-xs font-bold text-foreground">{t("matchCalc.matchWithDay2Money")}</div>
      <p className="text-[11px] text-foreground/80">
        Fyll i odds för kontot du vill använda. När beloppet visas klickar du på &quot;Använd&quot;,
        så dras pengarna från Dag 2 — Vinnare-match.
      </p>
      {availableMatchedFundingSites.length > 0 ? (
        <div className="space-y-2">
          {availableMatchedFundingSites.map((source) => (
            <div key={source.id} className="rounded border border-border/40 bg-background/60 p-2 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <BookmakerName name={source.name} className="min-w-0" />
                <span className="font-mono text-xs text-primary">{source.stake.toFixed(0)} kr kvar</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {OUTCOMES.map((outcome) => {
                  const draftKey = getFundingDraftKey(source.id, outcome);
                  const odds = matchedFundingOdds[source.id]?.[outcome];
                  const stake = getMatchedFundingStake(outcome, odds);
                  const inputValue = matchedFundingDraftOdds[draftKey] ?? formatOddsValue(odds);
                  const canUse = stake > 0;
                  return (
                    <div key={outcome} className="space-y-1">
                      <label className="text-[10px] font-semibold text-foreground">{OUTCOME_LABELS[outcome]}</label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="Odds"
                        value={inputValue}
                        onChange={(e) => setMatchedFundingOdd(source.id, outcome, e.target.value)}
                        className="h-8 text-xs font-mono"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canUse}
                        onClick={() => useMatchedFunding(outcome, source, stake)}
                        className="h-7 w-full px-1 text-[10px]"
                      >
                        {canUse ? `${t("matchCalc.useStake")} ${Math.round(stake)}` : t("matchCalc.use")}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-foreground/60">{t("matchCalc.noDay2Money")}</div>
      )}
      {OUTCOMES.some((outcome) => (hedgeFundingRecords[outcome] || []).length > 0) && (
        <div className="space-y-1 border-t border-border/30 pt-2">
          <div className="text-[11px] font-semibold text-foreground">{t("matchCalc.deductFromWinner")}</div>
          {OUTCOMES.flatMap((outcome) =>
            (hedgeFundingRecords[outcome] || []).map((record, index) => (
              <div
                key={`${outcome}-${record.siteId}-${index}`}
                className="flex justify-between gap-2 text-[10px] text-primary"
              >
                <span>
                  {OUTCOME_LABELS[outcome]} · {record.name}
                </span>
                <span className="font-mono">-{record.amount.toFixed(0)} kr</span>
              </div>
            )),
          )}
        </div>
      )}
    </div>
  ) : null;

  const motspelElement = useMemo(() => {
    if (!allAssigned) return null;
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="border-accent/20 bg-muted/20">
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <h3 className="text-sm font-bold text-foreground">📊 {exchangeName.trim() || "Vald sida"} — motspel</h3>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-foreground">Kompletteringssida</label>
                <Input
                  type="text"
                  placeholder="t.ex. Bet365 / Unibet / valfri sida"
                  value={exchangeName}
                  onChange={(e) => setExchangeName(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {OUTCOMES.map((outcome) => (
                <div key={outcome} className="space-y-1">
                  <label className="text-xs font-semibold text-foreground">{OUTCOME_LABELS[outcome]}</label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Odds"
                    value={exchangeOdds[outcome] || ""}
                    onChange={(e) => setExchangeOdds((prev) => ({ ...prev, [outcome]: parseFloat(e.target.value) || 0 }))}
                    className="h-9 font-mono text-sm"
                  />
                </div>
              ))}
            </div>

            {showMatchedFundingToggle && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/50 p-2">
                <div className="text-xs font-semibold text-foreground">
                  komplementera matched bets
                </div>
                <div className="flex rounded-md border border-border/50 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setUseMatchedFundingMode(false)}
                    className={`h-7 rounded px-3 ${!useMatchedFundingMode ? "bg-muted text-foreground" : "text-foreground/60"}`}
                  >
                    Av
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseMatchedFundingMode(true)}
                    className={`h-7 rounded px-3 ${useMatchedFundingMode ? "bg-primary text-primary-foreground" : "text-foreground/60"}`}
                  >
                    På
                  </button>
                </div>
              </div>
            )}

            {matchedFundingPanel}

            {hedgePlan ? (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3 border-t border-border/30 pt-3">
                <div className="text-xs font-semibold text-foreground">Satsa detta på {exchangeName.trim() || "vald sida"}:</div>
                <div className="grid grid-cols-3 gap-3">
                  {OUTCOMES.map((outcome) => {
                    const stake = hedgePlan.backStakes[outcome];
                    return (
                      <div key={outcome} className="text-center rounded-lg border border-border/30 bg-background/60 p-3">
                        <div className="text-xs font-semibold text-foreground">{OUTCOME_LABELS[outcome]}</div>
                        <div className="text-lg font-bold font-mono text-primary">
                          {stake > 0 ? `${stake.toFixed(0)} kr` : "—"}
                        </div>
                        {stake > 0 && (
                          <div className="text-[10px] text-foreground">
                            → +{(stake * (exchangeOdds[outcome] - 1)).toFixed(0)} kr
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="border-t border-border/30 pt-3 space-y-2">
                  <div className="text-xs font-semibold text-foreground">{t("matchCalc.outcomeOverview")}</div>
                  <div className="grid grid-cols-3 gap-3">
                    {OUTCOMES.map((outcome) => {
                      const sitesOnThis = sites.filter((s) => s.assignedOutcome === outcome);
                      const sitesOnOther = sites.filter((s) => s.assignedOutcome && s.assignedOutcome !== outcome);
                      const exchangeStake = hedgePlan.backStakes[outcome];

                      const siteWinnings = sitesOnThis.reduce((sum, s) => {
                        if (!s.odds) return sum;
                        return sum + (s.isFreebet ? s.stake * (s.odds - 1) : s.stake * s.odds);
                      }, 0);

                      const siteLosses = sitesOnOther.reduce((sum, s) => sum + (s.isFreebet ? 0 : s.stake), 0);

                      const exchangeWin = exchangeStake > 0 ? exchangeStake * exchangeOdds[outcome] : 0;

                      const exchangeLost = OUTCOMES.reduce((sum, o) => {
                        if (o === outcome) return sum;
                        return sum + hedgePlan.backStakes[o];
                      }, 0);

                      const totalResult = siteWinnings - siteLosses + exchangeWin - exchangeLost;

                      return (
                        <div key={outcome} className="rounded-lg border border-border/30 bg-background/40 p-3 space-y-2 text-[11px]">
                          <div className="text-xs font-bold text-foreground text-center">{OUTCOME_LABELS[outcome]} vinner</div>

                          {sitesOnThis.length > 0 && (
                            <div className="space-y-0.5">
                              <div className="font-semibold text-primary">{t("matchCalc.winningBets")}</div>
                              {sitesOnThis.map((s) => (
                                <div key={s.id} className="flex justify-between text-foreground">
                                  <span>
                                    {s.name} {s.isFreebet ? "🎁" : ""}
                                  </span>
                                  <span className="font-mono">
                                    +{(s.isFreebet ? s.stake * ((s.odds || 1) - 1) : s.stake * (s.odds || 1)).toFixed(0)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}

                          {exchangeWin > 0 && (
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-foreground">
                                <span className="text-primary">✅ {exchangeName.trim() || "Vald sida"}</span>
                                <span className="font-mono">+{exchangeWin.toFixed(0)}</span>
                              </div>
                            </div>
                          )}

                          {sitesOnOther.filter((s) => !s.isFreebet).length > 0 && (
                            <div className="space-y-0.5">
                              <div className="font-semibold text-destructive">{t("matchCalc.lostBets")}</div>
                              {sitesOnOther
                                .filter((s) => !s.isFreebet)
                                .map((s) => (
                                  <div key={s.id} className="flex justify-between text-foreground">
                                    <span>{s.name}</span>
                                    <span className="font-mono">-{s.stake.toFixed(0)}</span>
                                  </div>
                                ))}
                            </div>
                          )}

                          {exchangeLost > 0 && (
                            <div className="flex justify-between text-foreground">
                              <span className="text-destructive">❌ {exchangeName.trim() || "Vald sida"}</span>
                              <span className="font-mono">-{exchangeLost.toFixed(0)}</span>
                            </div>
                          )}

                          <div className="border-t border-border/30 pt-1 flex justify-between font-bold">
                            <span>Netto:</span>
                            <span className={`font-mono ${totalResult >= 0 ? "text-primary" : "text-destructive"}`}>
                              {totalResult >= 0 ? "+" : ""}
                              {totalResult.toFixed(0)} kr
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border/30 pt-2 text-center space-y-1">
                  {sites.every((s) => s.isFreebet) ? (
                    <>
                      <div className="text-xs text-foreground">
                        Totalt att satsa på {exchangeName.trim() || "vald sida"}:{" "}
                        <span className="font-mono font-bold">{hedgePlan.totalStaked.toFixed(0)} kr</span>
                      </div>
                      <div className="text-xs text-foreground">{t("matchCalc.pureProfitGuaranteed")}</div>
                      <div
                        className={`text-xl font-bold font-mono ${hedgePlan.equalProfit >= 0 ? "text-primary" : "text-destructive"}`}
                      >
                        {hedgePlan.equalProfit >= 0 ? "+" : ""}
                        {hedgePlan.equalProfit.toFixed(0)} kr
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs text-foreground">{t("matchCalc.sameProfitLossRegardless")}</div>
                      <div
                        className={`text-xl font-bold font-mono ${hedgePlan.equalProfit >= 0 ? "text-primary" : "text-destructive"}`}
                      >
                        {hedgePlan.equalProfit >= 0 ? "+" : ""}
                        {hedgePlan.equalProfit.toFixed(0)} kr
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            ) : null}
          </CardContent>
        </Card>
      </motion.div>
    );
  }, [
    allAssigned,
    hedgePlan,
    exchangeName,
    exchangeOdds,
    showMatchedFundingToggle,
    matchedFundingPanel,
    sites,
    useMatchedFundingMode,
  ]);

  return (
    <motion.div {...fadeIn}>
      <Card className="border-accent/30">
        <CardContent className="p-5 space-y-4">
          <h2 className="text-lg font-bold text-foreground">{title}</h2>

          <div className="flex items-center gap-2 flex-1 min-w-[180px]">
            <label className="text-sm text-foreground whitespace-nowrap">Match:</label>
            <Input className="font-medium" placeholder="t.ex. Liverpool vs Man City" value={matchName} onChange={e => onMatchNameChange(e.target.value)} />
          </div>

          <div className="overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border/50 bg-muted/25 text-[11px] text-foreground/80">
                  <th className="text-left font-semibold p-2 pl-3">Bolag</th>
                  <th className="font-semibold p-2 w-20">Insats</th>
                  <th className="font-semibold p-2 text-center w-16 text-green-600 dark:text-green-400">1</th>
                  <th className="font-semibold p-2 text-center w-16 text-blue-600 dark:text-blue-400">X</th>
                  <th className="font-semibold p-2 text-center w-16 text-red-600 dark:text-red-400">2</th>
                  <th className="font-semibold p-2 pr-3 text-center min-w-[5rem]">Utbetalning</th>
                  {allowConsume && <th className="font-semibold p-2 pr-3 text-center w-24">Status</th>}
                </tr>
              </thead>
              <tbody>
                {sites.map((site, rowIndex) => {
                  const active = site.assignedOutcome;
                  const rowBg =
                    active === "1"
                      ? "bg-green-500/15"
                      : active === "X"
                        ? "bg-blue-500/12"
                        : active === "2"
                          ? "bg-red-500/15"
                          : "";
                  const showOdds =
                    site.assignedOutcome && site.odds && site.odds > 0 ? formatOddsValue(site.odds) : "";
                  const payout =
                    site.odds && site.odds > 0
                      ? (site.isFreebet ? site.stake * (site.odds - 1) : site.stake * site.odds).toFixed(0)
                      : null;
                  return (
                    <tr key={site.id} className={`border-b border-border/30 ${rowBg}`}>
                      <td className="p-2 pl-3 align-middle min-w-[8rem]">
                        <BookmakerName name={site.name} className="w-32 inline-flex" />
                      </td>
                      <td className="p-2 align-middle whitespace-nowrap text-[11px] font-mono text-foreground">
                        {allowStakeEdit ? (
                          <Input
                            type="number"
                            min={0}
                            step="1"
                            value={Number.isFinite(site.stake) ? site.stake : 0}
                            onChange={(e) => {
                              const next = parseFloat(e.target.value);
                              updateSite(site.id, { stake: Number.isFinite(next) && next >= 0 ? next : 0 });
                            }}
                            className="h-8 w-20 text-xs font-mono px-2"
                            aria-label={`${site.name} insats`}
                          />
                        ) : (
                          <>{site.stake} kr</>
                        )}
                        {site.isFreebet ? " 🎁" : ""}
                      </td>
                      {OUTCOMES.map((oc) => {
                        const draftKey = getDraftKey(site.id, oc);
                        const inputValue = draftOdds[draftKey] ?? (site.assignedOutcome === oc && showOdds ? showOdds : "");
                        return (
                          <td key={oc} className="p-1.5 align-middle">
                            <Input
                              data-table="match-odds"
                              data-row={rowIndex}
                              data-col={oc}
                              type="text"
                              inputMode="decimal"
                              placeholder="—"
                              autoComplete="off"
                              value={inputValue}
                              onChange={(e) => setSiteOddsForOutcome(site, oc, e.target.value)}
                              onKeyDown={handleOddsKeyDown}
                              className={siteOddsInputClass(site.assignedOutcome === oc)}
                              aria-label={`${site.name} odds ${OUTCOME_LABELS[oc]}`}
                            />
                          </td>
                        );
                      })}
                      <td className="p-2 pr-3 align-middle text-center">
                        {payout != null ? (
                          <span className="text-[10px] text-primary font-mono">→ {payout} kr</span>
                        ) : (
                          <span className="text-[10px] text-foreground/40">—</span>
                        )}
                      </td>
                      {allowConsume && (
                        <td className="p-2 pr-3 align-middle text-center">
                          <button
                            type="button"
                            onClick={() => consumeSite(site.id)}
                            className="h-8 px-2 text-[10px] rounded border border-border/50 hover:bg-muted/40"
                          >
                            Förbrukad
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Motspel / alternativ mot matched (Dag 2 freebet) */}
          {showDay2FreebetMatchedTabs ? (
            <Tabs value={freebetD2Tab} onValueChange={setFreebetD2Tab} className="w-full">
              <TabsList className="h-auto min-h-9 w-full flex-wrap justify-start gap-1 p-1 sm:w-auto">
                <TabsTrigger value="hedge" className="text-xs px-2 sm:px-3">
                  Motspel
                </TabsTrigger>
                <TabsTrigger value="matched" className="text-xs px-2 sm:px-3">
                  Mot matched (Dag 2)
                </TabsTrigger>
              </TabsList>
              <TabsContent value="hedge" className="mt-3">
                {motspelElement ?? (
                  <div className="rounded-md border border-border/40 bg-muted/20 p-3 text-xs text-foreground/85">
                    Fyll i odds för alla freebets i tabellen för att se motspel. Under fliken &quot;Mot matched&quot; kan du redan nu ta bort freebets som du spelade mot matched i Dag 2.
                  </div>
                )}
              </TabsContent>
              <TabsContent value="matched" className="mt-3 space-y-2">
                <p className="text-xs text-foreground/80">
                  Om du matched freebets mot Dag 2-vinnare (matched) istället för motspel: markera här så försvinner raden från freebet-listan.
                </p>
                <div className="space-y-2">
                  {freebetsWithOdds.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("matchCalc.noFreebetsLeft")}</p>
                  ) : (
                    freebetsWithOdds.map((site) => (
                      <div
                        key={site.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/40 px-2 py-1.5"
                      >
                        <BookmakerName name={site.name} className="min-w-0 shrink" />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 shrink-0 text-xs"
                          onClick={() => consumeSite(site.id)}
                        >
                          Förbrukad mot matched
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>
            </Tabs>
          ) : (
            motspelElement
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
