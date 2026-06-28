/**
 * useClvCapture — fångar automatiskt Pinnacles stängnings-fair-odds (closing
 * line) för loggade bets kring avspark, och sparar som `closingFairOdds`.
 *
 * Hur: pollar POST /api/pinnacle-fair-odds för bets vars kickoff är inom
 * fångst-fönstret [-15 min, +30 min] och som ännu saknar closingFairOdds.
 * Pinnacles odds runt avspark = stängningslinjen → CLV = bookOdds / closing.
 *
 * Begränsning: körs klientsidan, så sidan måste vara öppen nära avspark. Missas
 * fönstret kan användaren fortfarande sätta CLV manuellt via "Update CLV".
 */
import { useEffect, useRef } from "react";
import { apiUrl } from "./apiUrl";
import type { LoggedBet } from "./betLogTypes";

const POLL_MS = 120_000; // 2 min
const WINDOW_BEFORE_MS = 15 * 60 * 1000; // börja försöka 15 min före avspark
const WINDOW_AFTER_MS = 30 * 60 * 1000; // ge upp 30 min efter (annars in-play-odds = fel CLV)

interface FairOddsResult {
  id: string;
  fairOdds: number | null;
  pinnacleMatch: string | null;
}

export function useClvCapture(
  bets: LoggedBet[],
  onCapture: (id: string, closingFairOdds: number) => void,
) {
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  useEffect(() => {
    const now = Date.now();
    const eligible = bets.filter((b) => {
      if (b.closingFairOdds != null) return false;
      if (!b.startTs || !b.match || !b.outcome) return false;
      const ms = Date.parse(b.startTs);
      if (!Number.isFinite(ms)) return false;
      const delta = now - ms; // >0 = avspark passerad
      return delta >= -WINDOW_BEFORE_MS && delta <= WINDOW_AFTER_MS;
    });
    if (eligible.length === 0) return;

    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch(apiUrl("/api/pinnacle-fair-odds"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bets: eligible.map((b) => ({
              id: b.id,
              match: b.match,
              outcome: b.outcome,
              startTs: b.startTs,
              sport: b.sport ?? "soccer",
            })),
          }),
        });
        const json = (await res.json()) as { ok?: boolean; results?: FairOddsResult[] };
        if (cancelled || !json?.ok || !Array.isArray(json.results)) return;
        for (const r of json.results) {
          if (r.fairOdds != null && Number.isFinite(r.fairOdds) && r.fairOdds > 1) {
            onCaptureRef.current(r.id, Number(r.fairOdds));
          }
        }
      } catch {
        /* tyst — försöker igen vid nästa poll */
      }
    };

    void fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // Re-evalueras när bets ändras (t.ex. ny bet loggad eller en fångad).
  }, [bets]);
}
