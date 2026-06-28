import BookmakerName from "@/components/BookmakerName";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Bookmaker } from "@/lib/bookmakers";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { useUserSettings } from "@/hooks/useUserSettings";

type OutcomeKey = "1" | "X" | "2";

const OUTCOMES: OutcomeKey[] = ["1", "X", "2"];

function formatOddsValue(value?: number) {
  return value != null && value > 0 ? String(value).replace(".", ",") : "";
}

function rowClass(outcome?: Bookmaker["assignedOutcome"]) {
  if (outcome === "used") return "bg-muted/20 opacity-60";
  if (outcome === "1") return "bg-green-500/15";
  if (outcome === "X") return "bg-blue-500/12";
  if (outcome === "2") return "bg-red-500/15";
  return "";
}

function inputClass(active: boolean) {
  return `h-8 text-xs font-mono text-center px-1 ${active ? "ring-2 ring-primary/50 border-primary/40" : ""}`;
}

interface BookmakerOddsTableProps {
  bookmakers: Bookmaker[];
  onUpdate: (id: string, updates: Partial<Bookmaker>) => void;
  variant: "matched" | "freebet";
}

export default function BookmakerOddsTable({ bookmakers, onUpdate, variant }: BookmakerOddsTableProps) {
  const { t } = useUserSettings();
  const [draftOdds, setDraftOdds] = useState<Record<string, string>>({});

  const getDraftKey = (bookmakerId: string, outcome: OutcomeKey) => `${bookmakerId}:${outcome}`;

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
    if (next < 0 || next >= bookmakers.length) return;
    const nextInput = document.querySelector<HTMLInputElement>(
      `input[data-table="bookmaker-odds"][data-row="${next}"][data-col="${col}"]`,
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

  const setOddsForOutcome = (bm: Bookmaker, outcome: OutcomeKey, raw: string) => {
    const trimmed = raw.trim();
    const key = getDraftKey(bm.id, outcome);
    if (trimmed !== "" && !/^\d*(?:[.,]\d*)?$/.test(trimmed)) return;

    setDraftOdds((prev) => ({ ...prev, [key]: raw }));

    if (trimmed === "") {
      setDraftOdds((prev) => {
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
      onUpdate(bm.id, {
        assignedOutcome: undefined,
        oddsHome: undefined,
        oddsDraw: undefined,
        oddsAway: undefined,
      });
      return;
    }

    const v = parseOdds(trimmed);
    if (v == null) return;

    setDraftOdds((prev) => {
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    onUpdate(bm.id, {
      assignedOutcome: outcome,
      oddsHome: outcome === "1" ? v : undefined,
      oddsDraw: outcome === "X" ? v : undefined,
      oddsAway: outcome === "2" ? v : undefined,
    });
  };

  const markUsed = (bm: Bookmaker) => {
    const next = bm.assignedOutcome === "used" ? undefined : "used";
    onUpdate(bm.id, {
      assignedOutcome: next,
      oddsHome: next === "used" ? undefined : bm.oddsHome,
      oddsDraw: next === "used" ? undefined : bm.oddsDraw,
      oddsAway: next === "used" ? undefined : bm.oddsAway,
    });
  };

  const payoutPreview = (bm: Bookmaker): string | null => {
    if (!bm.assignedOutcome || bm.assignedOutcome === "used") return null;
    const o =
      bm.assignedOutcome === "1"
        ? bm.oddsHome
        : bm.assignedOutcome === "X"
          ? bm.oddsDraw
          : bm.oddsAway;
    if (!o || o <= 0) return null;
    if (variant === "matched") {
      return `→ ${(bm.betAmount * o).toFixed(0)} kr`;
    }
    const fb = bm.freebetValue || 0;
    return `→ ${(fb * (o - 1)).toFixed(0)} kr`;
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border/50 bg-muted/25 text-[11px] text-foreground/80">
            <th className="text-left font-semibold p-2 pl-3">{t("betLog.bookmaker")}</th>
            <th className="font-semibold p-2 whitespace-nowrap w-[1%]">Bonus</th>
            <th className="font-semibold p-2 text-center w-16 text-green-600 dark:text-green-400">1</th>
            <th className="font-semibold p-2 text-center w-16 text-blue-600 dark:text-blue-400">X</th>
            <th className="font-semibold p-2 text-center w-16 text-red-600 dark:text-red-400">2</th>
            <th className="font-semibold p-2 text-center w-14">{t("betLog.outcome")}</th>
            <th className="font-semibold p-2 pr-3 w-12 text-center" title={t("common.delete")}>
              —
            </th>
          </tr>
        </thead>
        <tbody>
          {bookmakers.map((bm, rowIndex) => {
            const preview = payoutPreview(bm);
            return (
              <tr key={bm.id} className={`border-b border-border/30 transition-colors ${rowClass(bm.assignedOutcome)}`}>
                <td className="p-2 pl-3 align-middle min-w-[8rem]">
                  <BookmakerName name={bm.name} className="w-32 inline-flex" />
                </td>
                <td className="p-2 align-middle whitespace-nowrap">
                  {variant === "matched" ? (
                    <>
                      <Badge className="bg-green-500/15 text-green-400 border-green-500/30 text-[10px] tabular-nums">
                        {bm.betAmount} kr
                      </Badge>
                      <span className="text-[10px] text-foreground/70 font-mono ml-1">{bm.wagering}x</span>
                    </>
                  ) : (
                    <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px] tabular-nums">
                      {bm.freebetValue} kr
                    </Badge>
                  )}
                </td>
                {OUTCOMES.map((oc) => {
                  const val =
                    oc === "1" ? bm.oddsHome : oc === "X" ? bm.oddsDraw : bm.oddsAway;
                  const active = bm.assignedOutcome === oc;
                  const draftKey = getDraftKey(bm.id, oc);
                  const inputValue = draftOdds[draftKey] ?? formatOddsValue(val);
                  return (
                    <td key={oc} className="p-1.5 align-middle">
                      <Input
                        data-table="bookmaker-odds"
                        data-row={rowIndex}
                        data-col={oc}
                        type="text"
                        inputMode="decimal"
                        placeholder="—"
                        autoComplete="off"
                        value={inputValue}
                        onChange={(e) => setOddsForOutcome(bm, oc, e.target.value)}
                        onKeyDown={handleOddsKeyDown}
                        className={inputClass(active)}
                        aria-label={`${bm.name} odds ${oc === "1" ? t("outcome.home") : oc === "X" ? t("outcome.draw") : t("outcome.away")}`}
                      />
                    </td>
                  );
                })}
                <td className="p-2 align-middle text-center">
                  {preview ? (
                    <span className="text-[10px] text-primary font-mono whitespace-nowrap">{preview}</span>
                  ) : (
                    <span className="text-[10px] text-foreground/40">—</span>
                  )}
                </td>
                <td className="p-2 pr-3 align-middle text-center">
                  <button
                    type="button"
                    onClick={() => markUsed(bm)}
                    className={`px-2 py-1 rounded text-[10px] font-semibold border transition-all ${
                      bm.assignedOutcome === "used"
                        ? "bg-muted text-foreground border-border"
                        : "bg-transparent text-foreground/50 border-border/40 hover:border-foreground/40"
                    }`}
                    title={t("common.delete")}
                  >
                    💀
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
