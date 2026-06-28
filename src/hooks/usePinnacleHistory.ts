/**
 * usePinnacleHistory — pollar /api/odds/pinnacle-normalized var 60s och
 * lägger till nya snapshots i localStorage history-buffer.
 *
 * Returnerar:
 *   - history (Map): för UI-rendering av drops + sparklines
 *   - state: pollingStatus, lastFetchedAt, error, sourceMeta
 *   - actions: refresh(), clearHistory()
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/apiUrl";
import {
  appendSamples,
  clearHistory as clearStorage,
  loadHistory,
} from "@/lib/oddsHistory/storage";
import type {
  OddsHistoryEntry,
  OddsKey,
  PinnacleNormalizedResponse,
} from "@/lib/oddsHistory/types";

// Sänkt 60s → 5s 2026-05-12 för POD-strategin (snabb drop-detection).
// Med backend-cache TTL också på 5s ger detta worst case ~10s frontend-latens
// efter att Pinnacle-snapshotet uppdaterats på Render.
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface PinnacleHistoryState {
  history: Map<OddsKey, OddsHistoryEntry>;
  isLoading: boolean;
  error: string | null;
  /** Hur många snapshots vi laddat ned sedan sidan öppnades. */
  snapshotCount: number;
  /** Senaste svaret från backend. */
  lastResponseAt: string | null;
  /** Status från backend-respons. */
  sourceMeta: {
    source: PinnacleNormalizedResponse["source"];
    updatedAt: string | null;
    ageSeconds: number | null;
    rowCount: number;
  };
  refresh: () => void;
  clear: () => void;
}

export function usePinnacleHistory(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): PinnacleHistoryState {
  const [history, setHistory] = useState<Map<OddsKey, OddsHistoryEntry>>(() => loadHistory());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [lastResponseAt, setLastResponseAt] = useState<string | null>(null);
  const [sourceMeta, setSourceMeta] = useState<PinnacleHistoryState["sourceMeta"]>({
    source: "empty",
    updatedAt: null,
    ageSeconds: null,
    rowCount: 0,
  });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const fetchSnapshot = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(apiUrl("/api/odds/pinnacle-normalized"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PinnacleNormalizedResponse;
        if (cancelled) return;
        if (!data.ok) {
          setError("Backend returnerade ok=false");
          return;
        }
        const timestamp = data.updatedAt ?? new Date().toISOString();
        const updated = appendSamples(data.rows, timestamp);
        setHistory(new Map(updated)); // ny Map-instans → triggar re-render
        setSnapshotCount((c) => c + 1);
        setLastResponseAt(new Date().toISOString());
        setSourceMeta({
          source: data.source,
          updatedAt: data.updatedAt,
          ageSeconds: data.ageSeconds,
          rowCount: data.count,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchSnapshot();
    const handle = window.setInterval(fetchSnapshot, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [pollIntervalMs, refreshNonce]);

  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const clear = useCallback(() => {
    clearStorage();
    setHistory(new Map());
    setSnapshotCount(0);
  }, []);

  return useMemo(
    () => ({ history, isLoading, error, snapshotCount, lastResponseAt, sourceMeta, refresh, clear }),
    [history, isLoading, error, snapshotCount, lastResponseAt, sourceMeta, refresh, clear],
  );
}
