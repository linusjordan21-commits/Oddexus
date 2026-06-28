/**
 * useLiveBetEv — pollar POST /api/pinnacle-fair-odds för öppna loggade bets
 * och returnerar Pinnacles aktuella no-vig fair odds per bet-id.
 *
 * Till skillnad från /api/valuebets (som bara listar spel som FORTFARANDE är
 * valuebets över EV-tröskeln) svarar den här endpointen så länge Pinnacle
 * noterar linjen — även när EV:n blivit negativ. Det är poängen: live-EV ska
 * följa bettet hela vägen så användaren kan se om värdet försvinner (cash out)
 * eller om en liga systematiskt tappar EV.
 *
 * Live-EV för ett redan lagt bet räknas mot användarens LÅSTA odds:
 *   EV = fairProb_nu × bookOdds_vid_bet − 1
 *
 * fairOdds === null ⇒ Pinnacle noterar inte längre linjen (typiskt: matchen
 * har startat och pre-match-linjen är stängd). UI:t visar det explicit
 * istället för "—".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./apiUrl";
import type { LoggedBet } from "./betLogTypes";

export interface LiveFairOdds {
  /** Pinnacles no-vig fair odds just nu — null om linjen inte längre noteras. */
  fairOdds: number | null;
  /** Pinnacle-matchens namn (för felsökning av parningen). */
  pinnacleMatch: string | null;
}

interface FairOddsApiResult {
  id: string;
  fairOdds: number | null;
  pinnacleMatch: string | null;
}

const POLL_INTERVAL_MS = 60_000;

export function useLiveBetEv(bets: LoggedBet[]) {
  const [fairByBetId, setFairByBetId] = useState<Map<string, LiveFairOdds>>(new Map());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Stabil payload-nyckel så pollingen inte startas om av varje re-render —
  // bara när själva uppsättningen öppna bets faktiskt ändras.
  const payloadKey = useMemo(() => {
    const open = bets
      .filter((b) => b.status === "open" && b.match && b.outcome)
      .map((b) => ({
        id: b.id,
        match: b.match,
        outcome: b.outcome,
        startTs: b.startTs,
        sport: b.sport ?? "soccer",
      }));
    return JSON.stringify(open);
  }, [bets]);

  useEffect(() => {
    const open = JSON.parse(payloadKey) as Array<{
      id: string;
      match: string;
      outcome: string;
      startTs?: string;
      sport: string;
    }>;
    if (open.length === 0) {
      setFairByBetId(new Map());
      return;
    }

    let cancelled = false;

    const fetchOnce = async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setIsFetching(true);
      try {
        const res = await fetch(apiUrl("/api/pinnacle-fair-odds"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bets: open }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { ok?: boolean; results?: FairOddsApiResult[] };
        if (cancelled || !json?.ok || !Array.isArray(json.results)) return;
        const map = new Map<string, LiveFairOdds>();
        for (const r of json.results) {
          const valid = r.fairOdds != null && Number.isFinite(r.fairOdds) && r.fairOdds > 1;
          map.set(r.id, {
            fairOdds: valid ? Number(r.fairOdds) : null,
            pinnacleMatch: r.pinnacleMatch ?? null,
          });
        }
        setFairByBetId(map);
        setLastUpdated(new Date());
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        /* tyst — nästa poll försöker igen; gamla värden ligger kvar */
      } finally {
        if (!cancelled) setIsFetching(false);
      }
    };

    void fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      abortRef.current?.abort();
    };
  }, [payloadKey]);

  return useMemo(
    () => ({ fairByBetId, lastUpdated, isFetching }),
    [fairByBetId, lastUpdated, isFetching],
  );
}
