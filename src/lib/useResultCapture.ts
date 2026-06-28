/**
 * useResultCapture — auto-settlar öppna bets när matchen spelats, via
 * multi-källa-resolvern (POST /api/match-result → TheSportsDB + ESPN +
 * Sofascore). Fotboll, basket och tennis stöds; hittas inget resultat
 * (ligan saknas i alla källor) visas "Settla manuellt"-nudgen i tabellen.
 *
 * Kollar bets vars kickoff är >2.5h sedan (match rimligen klar) och status
 * fortfarande "open". Sätter status won/lost utifrån bet.outcome vs resultat.
 */
import { useEffect, useRef } from "react";
import { apiUrl } from "./apiUrl";
import type { LoggedBet, BetStatus, BetOutcome } from "./betLogTypes";

const POLL_MS = 5 * 60 * 1000; // 5 min
const MIN_AFTER_KO_MS = 2.5 * 60 * 60 * 1000; // 2.5h efter avspark

interface ResultRow {
  id: string;
  result: BetOutcome | null;
  /** Slutställning "hemma-borta" (t.ex. "2-1") från TheSportsDB, eller null. */
  score: string | null;
  supported: boolean;
}

export function useResultCapture(
  bets: LoggedBet[],
  onSettle: (id: string, updates: Partial<LoggedBet>) => void,
) {
  const onSettleRef = useRef(onSettle);
  onSettleRef.current = onSettle;

  useEffect(() => {
    const now = Date.now();
    const eligible = bets.filter((b) => {
      if (b.status !== "open" || !b.startTs || !b.match) return false;
      const sport = b.sport ?? "soccer";
      // soccer/basket: TheSportsDB+ESPN+Sofascore · tennis: Sofascore
      if (sport !== "soccer" && sport !== "basketball" && sport !== "tennis") return false;
      const ms = Date.parse(b.startTs);
      return Number.isFinite(ms) && now - ms > MIN_AFTER_KO_MS;
    });
    if (eligible.length === 0) return;

    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const res = await fetch(apiUrl("/api/match-result"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // startTs + league följer med som verifierings-veto på servern:
            // kandidat-event med >3h tidsdiff eller motsägande liga förkastas.
            bets: eligible.map((b) => ({
              id: b.id,
              match: b.match,
              sport: b.sport ?? "soccer",
              startTs: b.startTs,
              league: b.league,
            })),
          }),
        });
        const json = (await res.json()) as { ok?: boolean; results?: ResultRow[] };
        if (cancelled || !json?.ok || !Array.isArray(json.results)) return;
        const byId = new Map(eligible.map((b) => [b.id, b]));
        for (const r of json.results) {
          if (!r.result) continue;
          const bet = byId.get(r.id);
          if (!bet) continue;
          const status: BetStatus = bet.outcome === r.result ? "won" : "lost";
          onSettleRef.current(r.id, {
            status,
            result: r.result,
            finalScore: r.score ?? undefined,
            settledAt: new Date().toISOString(),
          });
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
  }, [bets]);
}
