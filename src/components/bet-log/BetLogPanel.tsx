/**
 * Top-level Bet Log dashboard. Layout (Pinnacle Odds Dropper-stil):
 *
 *   ┌── Header ───────────────────────────────────────┐
 *   │  Bet Log    [Add manually] [Import] [Export ▾] │
 *   ├── 8 stat cards (responsiv grid) ────────────────┤
 *   ├── Profit and Bets chart ────────────────────────┤
 *   └── All bets table ───────────────────────────────┘
 *
 * Hela bet-loggen lever i state här och persisterar till localStorage
 * via betLogStorage. Beräkningar i betLogCalculations.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Upload, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getCurrencySymbol } from "@/lib/settings/currency";
import { toast } from "sonner";
import { BetLogStatsCards } from "./BetLogStatsCards";
import { BetLogChart } from "./BetLogChart";
import { BetLogTable } from "./BetLogTable";
import { BetEntryModal, type EntryMode } from "./BetEntryModal";
import {
  deleteBet,
  exportBetsAsCsv,
  exportBetsAsJson,
  importBetsFromJson,
  loadBets,
  updateBet,
} from "@/lib/betLogStorage";
import { useClvCapture } from "@/lib/useClvCapture";
import { useResultCapture } from "@/lib/useResultCapture";
import { syncBets, pullAndMergeBets, pushBetsToServer } from "@/lib/betSync";
import {
  buildCumulativeChartData,
  summarizeBets,
  yieldPct,
} from "@/lib/betLogCalculations";
import type { LoggedBet } from "@/lib/betLogTypes";
import { useLiveBetEv } from "@/lib/useLiveValueBets";
import { useUserSettings } from "@/hooks/useUserSettings";

interface BetLogPanelProps {
  onCountChange?: (count: number) => void;
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BetLogPanel({ onCountChange }: BetLogPanelProps) {
  const { t, settings, updateSettings, formatMoney } = useUserSettings();
  const currencySym = getCurrencySymbol(settings.currency);
  const bankrollSet = settings.bankroll != null && settings.bankroll > 0;
  const [bets, setBets] = useState<LoggedBet[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<EntryMode>("create-manual");
  const [modalInitial, setModalInitial] = useState<Partial<LoggedBet> | undefined>(undefined);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    const all = loadBets();
    setBets(all);
    onCountChange?.(all.length);
    // Synka lokala ändringar till server-store (så bakgrundsjobbet ser dem).
    void pushBetsToServer(all);
  }, [onCountChange]);

  useEffect(() => {
    refresh();
    const handler = (e: StorageEvent) => {
      if (e.key === "parlay-pilot-value-bet-log") refresh();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refresh]);

  // Server-synk: mount = full synk (push lokalt → pull server). Sen pollar vi
  // serverns auto-uppdateringar (CLV-fångst + auto-settle som körts på servern
  // medan kunden var utloggad) var 60:e sekund.
  useEffect(() => {
    let cancelled = false;
    void syncBets().then((changed) => {
      if (!cancelled && changed) {
        const all = loadBets();
        setBets(all);
        onCountChange?.(all.length);
      }
    });
    const id = window.setInterval(async () => {
      const changed = await pullAndMergeBets();
      if (!cancelled && changed) {
        const all = loadBets();
        setBets(all);
        onCountChange?.(all.length);
      }
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [onCountChange]);

  const summary = useMemo(() => summarizeBets(bets), [bets]);
  const yieldValue = useMemo(
    () => yieldPct(summary.totalActualProfit, summary.totalStake),
    [summary.totalActualProfit, summary.totalStake],
  );
  const chartData = useMemo(() => buildCumulativeChartData(bets), [bets]);

  // Auto-CLV: fryser Pinnacles stängnings-fair-odds vid avspark för loggade bets.
  const handleClvCapture = useCallback(
    (id: string, closingFairOdds: number) => {
      updateBet(id, { closingFairOdds, clvAuto: true });
      refresh();
    },
    [refresh],
  );
  useClvCapture(bets, handleClvCapture);

  // Closing-line FALLBACK: bets vars live-pollade Pinnacle-linje aldrig hann
  // fångas (nisch-ligor där pre-match-linjen försvinner direkt vid avspark)
  // men som lades NÄRA avspark → fair-odds vid bet-tillfället är i praktiken
  // closing line. Ger CLV även när /api/pinnacle-fair-odds inte hann svara.
  // Speglar serverns runBetMaintenance-fallback (samma trösklar).
  useEffect(() => {
    const now = Date.now();
    let changed = false;
    for (const bet of bets) {
      if (bet.closingFairOdds != null) continue;
      const fair = bet.pinnacleFairOddsAtBet;
      if (fair == null || !(fair > 1) || !bet.startTs) continue;
      const ko = Date.parse(bet.startTs);
      const logged = Date.parse(bet.loggedAt);
      if (!Number.isFinite(ko) || !Number.isFinite(logged)) continue;
      if (now - ko < 25 * 60 * 1000) continue; // ge live-fångsten sin chans först
      if (Math.abs(logged - ko) > 45 * 60 * 1000) continue; // bara om lagt nära avspark
      updateBet(bet.id, { closingFairOdds: fair, clvAuto: true });
      changed = true;
    }
    if (changed) refresh();
  }, [bets, refresh]);

  // Auto-resultat: settlar öppna fotboll/basket/tennis-bets via multi-källa-resolvern.
  const handleResultSettle = useCallback(
    (id: string, updates: Partial<LoggedBet>) => {
      updateBet(id, updates);
      refresh();
    },
    [refresh],
  );
  useResultCapture(bets, handleResultSettle);

  // Modal-actions
  const openCreateManual = () => {
    setModalMode("create-manual");
    setModalInitial(undefined);
    setModalOpen(true);
  };
  const openEdit = (bet: LoggedBet) => {
    setModalMode("edit");
    setModalInitial(bet);
    setModalOpen(true);
  };
  const openSettle = (bet: LoggedBet) => {
    setModalMode("settle");
    setModalInitial(bet);
    setModalOpen(true);
  };
  const openUpdateClv = (bet: LoggedBet) => {
    setModalMode("edit");
    setModalInitial(bet);
    setModalOpen(true);
  };

  const handleDelete = (id: string) => {
    deleteBet(id);
    refresh();
    toast.success(t("betLog.deletedToast"));
  };

  // Import / export
  const handleExportJson = () => {
    const json = exportBetsAsJson();
    const ts = new Date().toISOString().slice(0, 10);
    downloadBlob(json, `oddexus-bets-${ts}.json`, "application/json");
    toast.success("Exporterade till JSON");
  };

  const handleExportCsv = () => {
    const csv = exportBetsAsCsv();
    const ts = new Date().toISOString().slice(0, 10);
    downloadBlob(csv, `oddexus-bets-${ts}.csv`, "text/csv");
    toast.success("Exporterade till CSV");
  };

  const handleImportClick = () => importInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = importBetsFromJson(text);
      if (result.errors.length > 0) {
        toast.error(`${t("betLog.importError")}: ${result.errors[0]}`);
      } else {
        toast.success(
          t("betLog.importSuccess")
            .replace("{added}", String(result.added))
            .replace("{skipped}", String(result.skipped)),
        );
      }
      refresh();
    } catch (error) {
      toast.error(`${t("betLog.couldNotReadFile")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-4">
      {/* Förenklat header — bara titeln. Add/Import/Export-knapparna och
          beskrivningen borttagna per användarbegäran. Handlers och refs
          behålls i komponenten ifall vi vill återinföra dem senare. */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-bold tracking-tight">{t("betLog.title")}</h2>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportFile}
        />
      </div>

      {/* Bankroll — steg 1: mata in den bankroll du spelar value betting för.
          Sparas globalt (settings) → driver insatsrekommendationen "Value
          Adjusted % Bankroll" på valuebets. Highlightas tills den är satt. */}
      <div
        className={`rounded-lg border p-4 ${
          bankrollSet
            ? "border-border/60 bg-muted/20"
            : "border-emerald-500/40 bg-emerald-500/5"
        }`}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="betlog-bankroll" className="text-sm font-semibold">
              {t("betLog.bankroll")}
            </Label>
            <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
              {t("betLog.bankrollDesc")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{currencySym}</span>
            <Input
              id="betlog-bankroll"
              type="number"
              step="100"
              min="0"
              inputMode="decimal"
              placeholder={t("betLog.bankrollPlaceholder")}
              value={settings.bankroll ?? ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                const n = Number(v);
                updateSettings({
                  bankroll: v === "" || !Number.isFinite(n) || n < 0 ? undefined : n,
                });
              }}
              className="h-10 w-40 font-mono text-base"
            />
          </div>
        </div>
        {!bankrollSet ? (
          <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            {t("betLog.bankrollNotSet")}
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("betLog.bankrollActive")} <span className="font-semibold text-foreground">{formatMoney(settings.bankroll)}</span>
          </p>
        )}
      </div>

      {/* 8 stat cards — visas alltid (även när tom = "—") */}
      <BetLogStatsCards summary={summary} yieldPct={yieldValue} />

      {/* Kumulativ vinst (P&L) — har egen empty-state */}
      <BetLogChart data={chartData} onAddManually={openCreateManual} />

      {/* Bets table — har egen empty-state */}
      {bets.length > 0 && (
        <div>
          <h3 className="mb-2 text-base font-bold tracking-tight">{t("betLog.bets")}</h3>
          <BetLogTableWithLive
            bets={bets}
            onEdit={openEdit}
            onSettle={openSettle}
            onUpdateClv={openUpdateClv}
            onDelete={handleDelete}
          />
        </div>
      )}

      <BetEntryModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        mode={modalMode}
        initial={modalInitial}
        onSaved={refresh}
      />
    </div>
  );
}

/**
 * Wrapper kring BetLogTable som driver live-EV-pollingen. Hooken filtrerar
 * själv fram öppna bets och pausar pollingen när inga finns (settled bets
 * behöver inte live-data — där är EV-snapshoten det enda relevanta).
 */
function BetLogTableWithLive(props: {
  bets: LoggedBet[];
  onEdit: (bet: LoggedBet) => void;
  onSettle: (bet: LoggedBet) => void;
  onUpdateClv: (bet: LoggedBet) => void;
  onDelete: (id: string) => void;
}) {
  const live = useLiveBetEv(props.bets);
  return (
    <BetLogTable
      {...props}
      liveFairOdds={live.fairByBetId}
      liveLastUpdated={live.lastUpdated}
      liveIsFetching={live.isFetching}
    />
  );
}
