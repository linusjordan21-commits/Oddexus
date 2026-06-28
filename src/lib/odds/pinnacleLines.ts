/**
 * pinnacleLines.ts — bygger Pinnacles totals- (O/U) och Asian Handicap-stegar
 * ur de utökade marknaderna i pinnacle-rows.json (fetchern behåller numera
 * `total` + `spread` utöver `moneyline`).
 *
 * Pinnacle är vårt SKARPASTE ankare även för totals/AH — datan låg redan i
 * `/markets/straight` men trimmades tidigare bort. Linjevärdet ligger per pris
 * i `points`:
 *   - total:  over/under delar samma `points` (t.ex. 2.5 mål).
 *   - spread: home/away har motsatt `points` (handikapp; home -0.5 ↔ away +0.5).
 *
 * Vi devig:ar varje linje tvåvägs → canonical-prob (OVER för totals, HOME för
 * AH) och bygger en SourceLadder som lineMatching kan matcha mot en target-linje
 * (exact → quarter_split → interpolated → rejected). Alternates ger tät stege.
 */

import { devigTwoWay } from "./consensus.ts";
import type { LinePoint, SourceLadder } from "./lineMatching.ts";

const PINNACLE_SOURCE_ID = "pinnacle";

/** Amerikanska odds → decimal. */
function americanToDecimal(american: number): number {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

interface RawPrice {
  designation?: string;
  price?: number;
  points?: number;
}
interface RawMarket {
  matchupId?: number;
  type?: string;
  isAlternate?: boolean;
  limit?: number | null;
  prices?: RawPrice[];
}

export interface PinnacleLineLadders {
  /** canonical = OVER no-vig per total-linje. */
  totals: SourceLadder;
  /** canonical = HOME no-vig per handikapp-linje (hemma-perspektiv). */
  ah: SourceLadder;
  /** Högsta limit över event:ets total/spread-marknader (likviditetssignal). */
  limit: number | null;
}

/**
 * Parsa per-event totals- och AH-stegar ur pinnacle-rows.json för EN sport.
 * Nyckel = String(matchupId), samma eventId som parsePinnacleSoccer använder.
 */
export function parsePinnacleLineLadders(json: unknown, sportTag = "soccer"): Map<string, PinnacleLineLadders> {
  const out = new Map<string, PinnacleLineLadders>();
  const sport = (json as { bySport?: Record<string, { markets?: RawMarket[] }> })?.bySport?.[sportTag];
  const markets = sport?.markets;
  if (!Array.isArray(markets)) return out;

  // line→devig-par per event. Map så dubbletter (main + alternate på samma
  // linje) kollapsar till EN punkt (första vinner — typiskt huvudlinjen).
  const totalsByEvent = new Map<number, Map<number, { over?: number; under?: number }>>();
  const ahByEvent = new Map<number, Map<number, { home?: number; away?: number }>>();
  const limitByEvent = new Map<number, number>();

  const ensure = <T>(m: Map<number, Map<number, T>>, id: number) => {
    let lm = m.get(id);
    if (!lm) { lm = new Map(); m.set(id, lm); }
    return lm;
  };

  for (const mk of markets) {
    const id = mk?.matchupId;
    if (typeof id !== "number" || !Array.isArray(mk.prices)) continue;

    if (mk.type === "total") {
      const over = mk.prices.find((p) => p.designation === "over");
      const under = mk.prices.find((p) => p.designation === "under");
      if (over && under && Number.isFinite(over.points) && Number.isFinite(over.price) && Number.isFinite(under.price)) {
        const lm = ensure(totalsByEvent, id);
        const line = over.points as number;
        if (!lm.has(line)) lm.set(line, { over: americanToDecimal(over.price!), under: americanToDecimal(under.price!) });
      }
    } else if (mk.type === "spread") {
      const home = mk.prices.find((p) => p.designation === "home");
      const away = mk.prices.find((p) => p.designation === "away");
      if (home && away && Number.isFinite(home.points) && Number.isFinite(home.price) && Number.isFinite(away.price)) {
        const lm = ensure(ahByEvent, id);
        const line = home.points as number; // handikapp ur hemma-perspektiv
        if (!lm.has(line)) lm.set(line, { home: americanToDecimal(home.price!), away: americanToDecimal(away.price!) });
      }
    }

    if (typeof mk.limit === "number") {
      const cur = limitByEvent.get(id);
      if (cur == null || mk.limit > cur) limitByEvent.set(id, mk.limit);
    }
  }

  const eventIds = new Set<number>([...totalsByEvent.keys(), ...ahByEvent.keys()]);
  for (const id of eventIds) {
    const totalsPts: LinePoint[] = [];
    for (const [line, pr] of totalsByEvent.get(id) ?? []) {
      if (pr.over != null && pr.under != null) totalsPts.push({ line, prob: devigTwoWay(pr.over, pr.under) });
    }
    const ahPts: LinePoint[] = [];
    for (const [line, pr] of ahByEvent.get(id) ?? []) {
      if (pr.home != null && pr.away != null) ahPts.push({ line, prob: devigTwoWay(pr.home, pr.away) });
    }
    totalsPts.sort((a, b) => a.line - b.line);
    ahPts.sort((a, b) => a.line - b.line);

    out.set(String(id), {
      totals: { sourceId: PINNACLE_SOURCE_ID, marketType: "TOTAL", scope: "match_total", points: totalsPts },
      ah: { sourceId: PINNACLE_SOURCE_ID, marketType: "AH", scope: "full", points: ahPts },
      limit: limitByEvent.get(id) ?? null,
    });
  }
  return out;
}
