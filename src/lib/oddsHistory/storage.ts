/**
 * localStorage-baserad rolling buffer för Pinnacle odds-historik.
 *
 * Struktur: Map<OddsKey, OddsHistoryEntry> serialiserad till localStorage.
 * Per key sparas senaste N samples (max 200) inom 24h-fönstret.
 *
 * Skydd mot quota:
 *   - Trim per key: max 200 samples
 *   - Trim per ålder: kasta samples > 24h
 *   - Trim hela buffer: max 5000 entries (om många matcher samtidigt)
 *
 * NB: history samlas bara medan en användares browser har sidan öppen.
 * Vid stäng-tab tappas no nya samples men gammal data finns kvar nästa
 * gång sidan öppnas (upp till 24h).
 */

import {
  MAX_HISTORY_AGE_MS,
  MAX_SAMPLES_PER_KEY,
  ODDS_HISTORY_STORAGE_KEY,
  type OddsHistoryEntry,
  type OddsKey,
  type PinnacleNormalizedRow,
} from "./types";

/** Max antal entries totalt i bufferten — skydd mot quota om vi pollar lika många matcher. */
const MAX_TOTAL_ENTRIES = 5000;

/** Bygg stable key för en row. Inkluderar line så att O/U 2.5 inte
 *  blandas med O/U 3.0 etc. */
export function buildOddsKey(row: {
  match: string;
  market: PinnacleNormalizedRow["market"];
  line: number | null;
  selection: PinnacleNormalizedRow["selection"];
}): OddsKey {
  const lineStr = row.line != null ? row.line.toFixed(2) : "-";
  return `${row.match}::${row.market}::${lineStr}::${row.selection}`;
}

/** Skriver hela bufferten till localStorage. Sväljer quota-fel + loggar. */
function persistHistory(history: Map<OddsKey, OddsHistoryEntry>): void {
  if (typeof window === "undefined") return;
  try {
    // Serialisera som array of [key, entry] för konsistent JSON
    const serialized = JSON.stringify(Array.from(history.entries()));
    localStorage.setItem(ODDS_HISTORY_STORAGE_KEY, serialized);
  } catch (error) {
    console.warn("[odds-history] persistHistory failed:", error);
    // Vid quota: rensa hela bufferten — bättre än crash
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      try {
        localStorage.removeItem(ODDS_HISTORY_STORAGE_KEY);
      } catch {
        // Ignore
      }
    }
  }
}

/** Läser hela bufferten från localStorage. Tom Map om inget finns/fel. */
export function loadHistory(): Map<OddsKey, OddsHistoryEntry> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(ODDS_HISTORY_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Array<[OddsKey, OddsHistoryEntry]>;
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map<OddsKey, OddsHistoryEntry>(parsed);
    // Trim gamla samples vid load
    return trimHistory(map);
  } catch (error) {
    console.warn("[odds-history] loadHistory failed:", error);
    return new Map();
  }
}

/** Tar bort samples äldre än MAX_HISTORY_AGE_MS och kapar per-key
 *  till MAX_SAMPLES_PER_KEY. Returnerar mutated map (kan vara samma instans). */
export function trimHistory(history: Map<OddsKey, OddsHistoryEntry>): Map<OddsKey, OddsHistoryEntry> {
  const cutoff = Date.now() - MAX_HISTORY_AGE_MS;
  const keysToDelete: OddsKey[] = [];
  for (const [key, entry] of history) {
    const fresh = entry.samples.filter((s) => Date.parse(s.ts) >= cutoff);
    if (fresh.length === 0) {
      keysToDelete.push(key);
      continue;
    }
    // Kapa de äldsta om vi har för många
    const kept = fresh.length > MAX_SAMPLES_PER_KEY ? fresh.slice(-MAX_SAMPLES_PER_KEY) : fresh;
    entry.samples = kept;
  }
  for (const key of keysToDelete) history.delete(key);

  // Globalt cap på 5000 entries — kasta de som har äldst senaste sample
  if (history.size > MAX_TOTAL_ENTRIES) {
    const sorted = [...history.entries()].sort((a, b) => {
      const tA = Date.parse(a[1].samples[a[1].samples.length - 1]?.ts ?? "") || 0;
      const tB = Date.parse(b[1].samples[b[1].samples.length - 1]?.ts ?? "") || 0;
      return tA - tB; // äldst först
    });
    const overflow = sorted.slice(0, history.size - MAX_TOTAL_ENTRIES);
    for (const [key] of overflow) history.delete(key);
  }
  return history;
}

/**
 * Lägg till en batch av nya odds-rows i historiken. Skriver localStorage.
 * Returnerar uppdaterad Map.
 *
 * Dedupering per key: om sista samplen har **exakt samma odds** som ny
 * sample inom 90 sekunder, hoppa över (ingen poäng att lagra duplicat).
 */
export function appendSamples(
  rows: PinnacleNormalizedRow[],
  snapshotTimestamp: string,
): Map<OddsKey, OddsHistoryEntry> {
  const history = loadHistory();
  const DUPE_WINDOW_MS = 90 * 1000;
  const snapshotMs = Date.parse(snapshotTimestamp);
  for (const row of rows) {
    const key = buildOddsKey(row);
    const sample = { odds: row.odds, ts: snapshotTimestamp };
    const existing = history.get(key);
    if (existing) {
      const last = existing.samples[existing.samples.length - 1];
      if (last && last.odds === sample.odds && Number.isFinite(snapshotMs)) {
        const lastMs = Date.parse(last.ts);
        if (Number.isFinite(lastMs) && snapshotMs - lastMs < DUPE_WINDOW_MS) {
          continue; // skip — ingen ändring inom 90s
        }
      }
      existing.samples.push(sample);
      existing.match = row.match;
      existing.sport = row.sport;
      existing.league = row.league;
      existing.startTime = row.startTime;
    } else {
      history.set(key, {
        match: row.match,
        sport: row.sport,
        league: row.league,
        startTime: row.startTime,
        market: row.market,
        line: row.line,
        selection: row.selection,
        samples: [sample],
      });
    }
  }
  trimHistory(history);
  persistHistory(history);
  return history;
}

/** Rensa hela historikbufferten. Caller bör ha bekräftelse innan. */
export function clearHistory(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ODDS_HISTORY_STORAGE_KEY);
  } catch {
    // Ignore
  }
}
