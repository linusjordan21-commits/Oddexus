/**
 * Tabell över loggade bets med actions: edit / settle / update CLV / delete.
 * EV-kr, CLV% och actual profit räknas live från betLogCalculations.
 */

import { useState } from "react";
import { Pencil, Trash2, CheckCircle2, LineChart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  actualProfit,
  clvPct,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
} from "@/lib/betLogCalculations";
import type { LoggedBet } from "@/lib/betLogTypes";
import type { LiveFairOdds } from "@/lib/useLiveValueBets";
import { useUserSettings } from "@/hooks/useUserSettings";
import { formatCurrency } from "@/lib/settings/currency";

interface BetLogTableProps {
  bets: LoggedBet[];
  onEdit: (bet: LoggedBet) => void;
  onSettle: (bet: LoggedBet) => void;
  onUpdateClv: (bet: LoggedBet) => void;
  onDelete: (id: string) => void;
  /** Pinnacles aktuella fair odds per bet-id. fairOdds=null betyder att
   *  Pinnacle inte längre noterar linjen (stängd/borta). */
  liveFairOdds?: Map<string, LiveFairOdds>;
  liveLastUpdated?: Date | null;
  liveIsFetching?: boolean;
}

/** formatRelative — språk-neutralt format. Caller passar in en "ago"-string. */
function formatRelative(date: Date | null | undefined, waiting = "—", ago = "ago"): string {
  if (!date) return waiting;
  const diffMs = Date.now() - date.getTime();
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 60) return `${sec}s ${ago}`;
  const min = Math.floor(sec / 60);
  return `${min} min ${ago}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "—";
  }
}

export function BetLogTable({
  bets,
  onEdit,
  onSettle,
  onUpdateClv,
  onDelete,
  liveFairOdds,
  liveLastUpdated,
  liveIsFetching,
}: BetLogTableProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteBet = bets.find((b) => b.id === confirmDeleteId);
  const { settings, t } = useUserSettings();
  const fmtMoney = (n: number | null | undefined): string =>
    formatCurrency(n, settings.currency, { fractionDigits: 2, showSign: true });

  if (bets.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
        {t("betLog.empty")} — {t("betLog.emptyHint")}
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-md border border-border/60">
        <table className="w-full min-w-[1280px] text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">{t("betLog.date")}</th>
              <th className="px-3 py-2 text-left font-semibold">{t("betLog.match")}</th>
              <th className="px-3 py-2 text-left font-semibold">{t("betLog.bookmaker")}</th>
              <th className="px-3 py-2 text-center font-semibold">{t("betLog.outcome")}</th>
              <th className="px-3 py-2 text-right font-semibold">{t("betLog.odds")}</th>
              <th className="px-3 py-2 text-right font-semibold">{t("betLog.stake")}</th>
              <th className="px-3 py-2 text-right font-semibold">
                <div className="flex items-center justify-end gap-1.5">
                  <span>Live EV%</span>
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      liveFairOdds && liveFairOdds.size > 0
                        ? liveIsFetching
                          ? "animate-pulse bg-emerald-400"
                          : "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"
                        : "bg-muted-foreground/40"
                    }`}
                    title={
                      liveFairOdds && liveFairOdds.size > 0
                        ? `${t("betLog.liveVsPinnacle")} · ${t("common.lastUpdated")} ${formatRelative(liveLastUpdated, t("common.waiting"), t("common.minutesAgo"))}`
                        : t("betLog.pollingPinnacle")
                    }
                  />
                </div>
              </th>
              <th className="px-3 py-2 text-right font-semibold">Closing FO</th>
              <th className="px-3 py-2 text-right font-semibold">{t("betLog.clv")}%</th>
              <th className="px-3 py-2 text-center font-semibold">{t("betLog.status")}</th>
              <th className="px-3 py-2 text-right font-semibold">{t("betLog.profit")}</th>
              <th className="px-3 py-2 text-right font-semibold">—</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {bets.map((bet) => {
              const clv = clvPct(bet.bookOdds, bet.closingFairOdds);
              const profit = actualProfit(bet);
              const live = liveFairOdds?.get(bet.id);
              const isOpenBet = bet.status === "open";
              return (
                <tr key={bet.id} className="hover:bg-muted/20">
                  <td className="px-3 py-2 text-muted-foreground">{fmtDate(bet.loggedAt)}</td>
                  <td className="px-3 py-2 font-medium">
                    <div className="truncate max-w-[260px]" title={bet.match}>{bet.match}</div>
                    {bet.league && <div className="text-xs text-muted-foreground truncate max-w-[260px]">{bet.league}</div>}
                  </td>
                  <td className="px-3 py-2">{bet.bookmakerName}</td>
                  <td className="px-3 py-2 text-center">
                    <Badge variant="outline" className="font-mono text-[11px]">{bet.outcome}</Badge>
                    {bet.outcomeLabel && (
                      <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[120px]">{bet.outcomeLabel}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{bet.bookOdds.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{bet.stake.toFixed(0)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {(() => {
                      // Settled bet → snapshot är den enda relevanta siffran (matchen är spelad)
                      if (!isOpenBet) {
                        return (
                          <span
                            className="text-muted-foreground"
                            title={t("betLog.settledShowsEvAtBetTime")}
                          >
                            {fmtPct(bet.evPctAtBet ?? null)}
                          </span>
                        );
                      }
                      // Öppet bet med Pinnacle-linje kvar: live-EV mot DINA
                      // låsta odds (det är positionens värde just nu).
                      if (live && live.fairOdds != null) {
                        const fairProb = 1 / live.fairOdds;
                        const liveEvPct = (fairProb * bet.bookOdds - 1) * 100;
                        const positive = liveEvPct > 0;
                        return (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              positive
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-rose-500 dark:text-rose-400"
                            }`}
                            title={`Pinnacle fair odds: ${live.fairOdds.toFixed(2)} (${(fairProb * 100).toFixed(2)}%) · dina odds: ${bet.bookOdds.toFixed(2)} · EV vid bet: ${fmtPct(bet.evPctAtBet ?? null)}`}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                              aria-hidden="true"
                            />
                            {fmtPct(liveEvPct)}
                          </span>
                        );
                      }
                      // Pinnacle noterar inte längre linjen → säg det explicit.
                      if (live && live.fairOdds == null) {
                        const started =
                          bet.startTs != null && Date.parse(bet.startTs) <= Date.now();
                        return (
                          <span
                            className="text-[11px] font-sans font-medium text-amber-600 dark:text-amber-400"
                            title={`${started ? t("betLog.lineClosedHint") : t("betLog.lineGoneHint")} · ${t("betLog.evAtBetLabel")}: ${fmtPct(bet.evPctAtBet ?? null)}`}
                          >
                            {started ? t("betLog.lineClosed") : t("betLog.lineGone")}
                          </span>
                        );
                      }
                      // Pollen har inte hunnit svara än.
                      return (
                        <span
                          className="text-muted-foreground"
                          title={`${t("betLog.pollingPinnacle")} · ${t("betLog.evAtBetLabel")}: ${fmtPct(bet.evPctAtBet ?? null)}`}
                        >
                          …
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                    {bet.closingFairOdds != null && Number.isFinite(bet.closingFairOdds)
                      ? bet.closingFairOdds.toFixed(2)
                      : "—"}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums font-semibold ${
                    clv == null ? "text-muted-foreground font-normal" : clv > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                  }`}>
                    {fmtPct(clv)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Badge variant={STATUS_BADGE_VARIANT[bet.status]} className="text-[11px]">
                      {STATUS_LABEL[bet.status]}
                    </Badge>
                    {/* Auto-settle (TheSportsDB) täcker inte alla ligor (nisch-
                        basket, tennis). Öppet bet långt efter avspark ⇒ visa en
                        klickbar nudge så användaren settlar manuellt och får
                        +/- i Vinst-kolumnen + resultatkurvan. */}
                    {isOpenBet &&
                      bet.startTs != null &&
                      Date.now() - Date.parse(bet.startTs) > 6 * 3_600_000 && (
                        <button
                          type="button"
                          onClick={() => onSettle(bet)}
                          title={t("betLog.settleManuallyHint")}
                          className="mt-0.5 block w-full text-[10px] font-medium text-amber-600 hover:underline dark:text-amber-400"
                        >
                          {t("betLog.settleManually")}
                        </button>
                      )}
                    {bet.finalScore && (
                      <div
                        className="text-xs text-muted-foreground mt-0.5 font-mono tabular-nums"
                        title={t("betLog.finalScore")}
                      >
                        {bet.finalScore}
                      </div>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${
                    profit == null ? "text-muted-foreground" :
                    profit > 0 ? "text-emerald-600 dark:text-emerald-400" :
                    profit < 0 ? "text-rose-600 dark:text-rose-400" : ""
                  }`}>
                    {fmtMoney(profit)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onUpdateClv(bet)} title={t("betLog.updateClosingOdds")}>
                        <LineChart className="h-3.5 w-3.5" />
                      </Button>
                      {bet.status === "open" && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onSettle(bet)} title={t("betLog.modalSetResult")}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onEdit(bet)} title={t("common.edit")}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-500 hover:text-rose-600" onClick={() => setConfirmDeleteId(bet.id)} title={t("common.delete")}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AlertDialog open={confirmDeleteId !== null} onOpenChange={(open) => !open && setConfirmDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("betLog.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteBet && (
                <>{t("betLog.confirmDeleteRow")} <strong>{confirmDeleteBet.match}</strong> ({confirmDeleteBet.bookmakerName}, odds {confirmDeleteBet.bookOdds.toFixed(2)}). {t("betLog.confirmDeleteHint")}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (confirmDeleteId) onDelete(confirmDeleteId);
                setConfirmDeleteId(null);
              }}
            >
              Ta bort
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
