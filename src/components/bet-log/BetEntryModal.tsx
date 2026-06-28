/**
 * Universalmodal för bet-loggning. Används i fyra lägen:
 *   - mode="create-from-valuebet": förifylld med snapshot från live valuebet
 *   - mode="create-manual":         tomt formulär för manuell inläggning
 *   - mode="edit":                  redigera ett befintligt bet
 *   - mode="settle":                fokus på status + ev. CLV
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useUserSettings } from "@/hooks/useUserSettings";
import { CURRENCY_SYMBOL } from "@/lib/settings/currency";
import {
  loadLastStake,
  saveBet,
  saveLastStake,
} from "@/lib/betLogStorage";
import { clvPct, evKr } from "@/lib/betLogCalculations";
import type { BetOutcome, BetStatus, LoggedBet } from "@/lib/betLogTypes";

export type EntryMode = "create-from-valuebet" | "create-manual" | "edit" | "settle";

interface BetEntryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: EntryMode;
  /** Förifylld data — används både för create-from-valuebet och edit/settle. */
  initial?: Partial<LoggedBet>;
  onSaved?: (bet: LoggedBet) => void;
}

/**
 * Status-/outcome-option-listor — bygger labels via t() runtime så att
 * språkbyte i Settings reflekteras direkt. Behåller value-koderna (BetStatus
 * / BetOutcome) som internal identifiers oförändrat.
 */
import type { TranslationKey } from "@/lib/settings/i18n";
const STATUS_OPTION_VALUES: { value: BetStatus; labelKey: TranslationKey }[] = [
  { value: "open", labelKey: "betLog.statusOpen" },
  { value: "won", labelKey: "betLog.won" },
  { value: "lost", labelKey: "betLog.lost" },
  { value: "void", labelKey: "betLog.statusRefunded" },
  { value: "half-won", labelKey: "betLog.statusHalfWon" },
  { value: "half-lost", labelKey: "betLog.statusHalfLost" },
];

const OUTCOME_OPTION_VALUES: { value: BetOutcome; labelKey: TranslationKey }[] = [
  { value: "1", labelKey: "betLog.outcomeHome" },
  { value: "X", labelKey: "betLog.outcomeDraw" },
  { value: "2", labelKey: "betLog.outcomeAway" },
];

function toNum(s: string): number | undefined {
  const v = Number(s.replace(",", "."));
  return Number.isFinite(v) ? v : undefined;
}

export function BetEntryModal({ open, onOpenChange, mode, initial, onSaved }: BetEntryModalProps) {
  const isEdit = mode === "edit" || mode === "settle";
  const lastStake = useMemo(() => loadLastStake(), []);
  const { settings, t } = useUserSettings();
  const currencySymbol = CURRENCY_SYMBOL[settings.currency];

  // Build runtime label-mapped option lists (translated each render).
  const STATUS_OPTIONS = STATUS_OPTION_VALUES.map((o) => ({ value: o.value, label: t(o.labelKey) }));
  const OUTCOME_OPTIONS = OUTCOME_OPTION_VALUES.map((o) => ({ value: o.value, label: t(o.labelKey) }));

  const [match, setMatch] = useState(initial?.match ?? "");
  const [league, setLeague] = useState(initial?.league ?? "");
  const [bookmakerName, setBookmakerName] = useState(initial?.bookmakerName ?? "");
  const [bookmakerId, setBookmakerId] = useState(initial?.bookmakerId ?? "");
  const [outcome, setOutcome] = useState<BetOutcome>(initial?.outcome ?? "1");
  const [outcomeLabel, setOutcomeLabel] = useState(initial?.outcomeLabel ?? "");
  const [bookOdds, setBookOdds] = useState<string>(
    initial?.bookOdds != null ? String(initial.bookOdds) : "",
  );
  const [stake, setStake] = useState<string>(
    initial?.stake != null
      ? String(initial.stake)
      : lastStake != null
        ? String(lastStake)
        : "",
  );
  const [pinnacleFairOddsAtBet, setPinnacleFairOddsAtBet] = useState<string>(
    initial?.pinnacleFairOddsAtBet != null ? String(initial.pinnacleFairOddsAtBet) : "",
  );
  const [evPctAtBet, setEvPctAtBet] = useState<string>(
    initial?.evPctAtBet != null ? String(initial.evPctAtBet) : "",
  );
  const [closingFairOdds, setClosingFairOdds] = useState<string>(
    initial?.closingFairOdds != null ? String(initial.closingFairOdds) : "",
  );
  const [status, setStatus] = useState<BetStatus>(initial?.status ?? "open");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [startTs, setStartTs] = useState(initial?.startTs ?? "");

  // Sync formulär när initial-prop ändras (om modalen återanvänds).
  useEffect(() => {
    if (!open) return;
    setMatch(initial?.match ?? "");
    setLeague(initial?.league ?? "");
    setBookmakerName(initial?.bookmakerName ?? "");
    setBookmakerId(initial?.bookmakerId ?? "");
    setOutcome(initial?.outcome ?? "1");
    setOutcomeLabel(initial?.outcomeLabel ?? "");
    setBookOdds(initial?.bookOdds != null ? String(initial.bookOdds) : "");
    setStake(
      initial?.stake != null
        ? String(initial.stake)
        : lastStake != null
          ? String(lastStake)
          : "",
    );
    setPinnacleFairOddsAtBet(
      initial?.pinnacleFairOddsAtBet != null ? String(initial.pinnacleFairOddsAtBet) : "",
    );
    setEvPctAtBet(initial?.evPctAtBet != null ? String(initial.evPctAtBet) : "");
    setClosingFairOdds(
      initial?.closingFairOdds != null ? String(initial.closingFairOdds) : "",
    );
    setStatus(initial?.status ?? "open");
    setNotes(initial?.notes ?? "");
    setStartTs(initial?.startTs ?? "");
  }, [open, initial, lastStake]);

  const bookOddsNum = toNum(bookOdds);
  const stakeNum = toNum(stake);
  const evPctNum = toNum(evPctAtBet);
  const closingFairNum = toNum(closingFairOdds);
  const previewEvKr = bookOddsNum && stakeNum && evPctNum != null ? evKr(stakeNum, evPctNum) : null;
  const previewClvPct = bookOddsNum && closingFairNum != null ? clvPct(bookOddsNum, closingFairNum) : null;

  const canSubmit =
    match.trim().length > 0 &&
    bookmakerName.trim().length > 0 &&
    bookOddsNum != null &&
    bookOddsNum > 1 &&
    stakeNum != null &&
    stakeNum > 0;

  const title =
    mode === "create-from-valuebet"
      ? t("betLog.addBet")
      : mode === "create-manual"
        ? t("betLog.modalAddManually")
        : mode === "settle"
          ? t("betLog.modalSetResult")
          : t("betLog.editBet");

  const description =
    mode === "create-from-valuebet"
      ? t("betLog.modalHintFromValuebet")
      : mode === "settle"
        ? t("betLog.modalHintSettle")
        : t("betLog.modalHintCreate");

  const handleSubmit = () => {
    if (!canSubmit || bookOddsNum == null || stakeNum == null) return;

    const id = initial?.id ?? (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `bet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    const isNewSettlement = isEdit && initial?.status === "open" && status !== "open";

    const bet: LoggedBet = {
      id,
      loggedAt: initial?.loggedAt ?? new Date().toISOString(),
      match: match.trim(),
      league: league.trim() || undefined,
      startTs: startTs || undefined,
      bookmakerId: bookmakerId.trim() || bookmakerName.trim().toLowerCase().replace(/[^a-z0-9]/g, ""),
      bookmakerName: bookmakerName.trim(),
      outcome,
      outcomeLabel: outcomeLabel.trim() || undefined,
      bookOdds: bookOddsNum,
      stake: stakeNum,
      pinnacleOddsAtBet: initial?.pinnacleOddsAtBet,
      pinnacleFairOddsAtBet: toNum(pinnacleFairOddsAtBet),
      pinnacleFairProbAtBet: initial?.pinnacleFairProbAtBet,
      evPctAtBet: evPctNum,
      closingFairOdds: toNum(closingFairOdds),
      status,
      settledAt: isNewSettlement
        ? new Date().toISOString()
        : initial?.settledAt,
      notes: notes.trim() || undefined,
      source: initial?.source ?? (mode === "create-from-valuebet" ? "live-valuebet" : "manual"),
    };

    try {
      saveBet(bet);
      saveLastStake(stakeNum);
      toast.success(isEdit ? t("betLog.savedUpdated") : t("betLog.savedLogged"));
      onSaved?.(bet);
      onOpenChange(false);
    } catch (error) {
      console.error("[bet-log] save failed:", error);
      toast.error(t("betLog.saveFailed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="match">{t("betLog.match")}</Label>
            <Input id="match" value={match} onChange={(e) => setMatch(e.target.value)} placeholder={`${t("outcome.home")} - ${t("outcome.away")}`} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="league">{t("valuebets.match")}</Label>
            <Input id="league" value={league} onChange={(e) => setLeague(e.target.value)} placeholder="Premier League" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="startTs">{t("valuebets.time")}</Label>
            <Input id="startTs" value={startTs} onChange={(e) => setStartTs(e.target.value)} placeholder="2026-05-08T20:00:00Z" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="bookmaker">{t("betLog.bookmaker")}</Label>
            <Input id="bookmaker" value={bookmakerName} onChange={(e) => setBookmakerName(e.target.value)} placeholder="Hajper" />
          </div>

          <div className="space-y-1">
            <Label>{t("betLog.outcome")}</Label>
            <Select value={outcome} onValueChange={(v) => setOutcome(v as BetOutcome)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {OUTCOME_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="bookOdds">Bet odds</Label>
            <Input id="bookOdds" inputMode="decimal" value={bookOdds} onChange={(e) => setBookOdds(e.target.value)} placeholder="2.05" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="stake">Stake ({currencySymbol})</Label>
            <Input id="stake" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} placeholder="100" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="fairOdds">Pinnacle fair odds vid bet</Label>
            <Input id="fairOdds" inputMode="decimal" value={pinnacleFairOddsAtBet} onChange={(e) => setPinnacleFairOddsAtBet(e.target.value)} placeholder="1.95" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="evPct">EV% vid bet</Label>
            <Input id="evPct" inputMode="decimal" value={evPctAtBet} onChange={(e) => setEvPctAtBet(e.target.value)} placeholder="5.13" />
          </div>

          <div className="space-y-1">
            <Label htmlFor="closingFair">Closing fair odds (CLV)</Label>
            <Input id="closingFair" inputMode="decimal" value={closingFairOdds} onChange={(e) => setClosingFairOdds(e.target.value)} placeholder={t("betLog.closingFairOddsPlaceholder")} />
          </div>

          <div className="space-y-1">
            <Label>{t("betLog.status")}</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as BetStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="notes">{t("betLog.notes")}</Label>
            <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("betLog.notesPlaceholder")} rows={2} />
          </div>

          {(previewEvKr !== null || previewClvPct !== null) && (
            <div className="sm:col-span-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
              <div className="font-semibold text-emerald-600 dark:text-emerald-400 mb-1">{t("settings.preview.title")}</div>
              {previewEvKr !== null && (
                <div>{t("betLog.evInCurrency")} {currencySymbol}: <span className="font-mono font-semibold">{previewEvKr.toFixed(2)} {currencySymbol}</span></div>
              )}
              {previewClvPct !== null && (
                <div>{t("betLog.clv")}%: <span className="font-mono font-semibold">{previewClvPct.toFixed(2)}%</span></div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isEdit ? t("common.saveChanges") : t("betLog.addBet")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
