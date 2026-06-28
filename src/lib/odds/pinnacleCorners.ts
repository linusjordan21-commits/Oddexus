/**
 * pinnacleCorners.ts — bygger Pinnacles HÖRN-stegar (corner totals + corner AH) ur
 * de separat capturade corner-special-matchupsen i pinnacle-rows.json.
 *
 * Pinnacle exponerar hörn som SPECIAL-matchups (special.category="Corners") med
 * `parent` → huvudmatchen. Scrapern sparar dem i bySport.soccer.cornerMatchups
 * (id, parentId) + cornerMarkets (total = O/U hörn, spread = hörn-AH; samma form
 * som mål-markets). Vi bygger ladders per corner-matchup och NYCKLAR OM dem på
 * PARENT-matchup-id:t (= samma eventId som parsePinnacleSoccer) så corners-motorn
 * slår upp dem med exakt samma Pinnacle-lookup som totals/AH.
 *
 * Sharp referens: Pinnacle är skarpast på hörn. OBS: corner-limits är låga (tunnare
 * marknad) → motorn behandlar dem som lägre likviditet.
 */

import { devigTwoWay } from "./consensus.ts";
import type { LinePoint, SourceLadder } from "./lineMatching.ts";

const PINNACLE_SOURCE_ID = "pinnacle";

function americanToDecimal(american: number): number {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

interface RawPrice { designation?: string; price?: number; points?: number }
interface RawMarket { matchupId?: number; type?: string; isAlternate?: boolean; limit?: number | null; prices?: RawPrice[] }
interface CornerMatchup { id?: number; parentId?: number }

export interface PinnacleCornerLadders {
  /** canonical = OVER no-vig per hörn-total-linje. */
  totals: SourceLadder;
  /** canonical = HOME no-vig per hörn-handikapp-linje (hemma-perspektiv). */
  ah: SourceLadder;
  /** Högsta limit över corner-marknaderna (låg = tunn marknad). */
  limit: number | null;
}

/**
 * Parsa per-event hörn-stegar ur pinnacle-rows.json. Nyckel = String(PARENT-matchupId),
 * = samma eventId som parsePinnacleSoccer. Tom map om scrapern inte capturat corners.
 */
export function parsePinnacleCornerLadders(json: unknown): Map<string, PinnacleCornerLadders> {
  const out = new Map<string, PinnacleCornerLadders>();
  const soccer = (json as { bySport?: Record<string, { cornerMatchups?: CornerMatchup[]; cornerMarkets?: RawMarket[] }> })?.bySport?.soccer;
  const cornerMatchups = soccer?.cornerMatchups;
  const cornerMarkets = soccer?.cornerMarkets;
  if (!Array.isArray(cornerMatchups) || !Array.isArray(cornerMarkets) || cornerMatchups.length === 0) return out;

  // corner-matchup-id → parent-matchup-id.
  const parentOf = new Map<number, number>();
  for (const cm of cornerMatchups) {
    if (typeof cm?.id === "number" && typeof cm?.parentId === "number") parentOf.set(cm.id, cm.parentId);
  }
  if (parentOf.size === 0) return out;

  // Bygg per corner-matchup-id (line→devig-par), kollapsa main+alternate till en punkt.
  const totalsByCorner = new Map<number, Map<number, { over?: number; under?: number }>>();
  const ahByCorner = new Map<number, Map<number, { home?: number; away?: number }>>();
  const limitByParent = new Map<number, number>();
  const ensure = <T>(m: Map<number, Map<number, T>>, id: number) => { let lm = m.get(id); if (!lm) { lm = new Map(); m.set(id, lm); } return lm; };

  for (const mk of cornerMarkets) {
    const id = mk?.matchupId;
    if (typeof id !== "number" || !parentOf.has(id) || !Array.isArray(mk.prices)) continue;
    // Bara full-match-hörn (period 0). team_total/moneyline hoppas (v1: O/U + AH).
    if (mk.type === "total") {
      const over = mk.prices.find((p) => p.designation === "over");
      const under = mk.prices.find((p) => p.designation === "under");
      if (over && under && Number.isFinite(over.points) && Number.isFinite(over.price) && Number.isFinite(under.price)) {
        const lm = ensure(totalsByCorner, id);
        const line = over.points as number;
        if (!lm.has(line)) lm.set(line, { over: americanToDecimal(over.price!), under: americanToDecimal(under.price!) });
      }
    } else if (mk.type === "spread") {
      const home = mk.prices.find((p) => p.designation === "home");
      const away = mk.prices.find((p) => p.designation === "away");
      if (home && away && Number.isFinite(home.points) && Number.isFinite(home.price) && Number.isFinite(away.price)) {
        const lm = ensure(ahByCorner, id);
        const line = home.points as number;
        if (!lm.has(line)) lm.set(line, { home: americanToDecimal(home.price!), away: americanToDecimal(away.price!) });
      }
    }
    if (typeof mk.limit === "number") {
      const parent = parentOf.get(id)!;
      const cur = limitByParent.get(parent);
      if (cur == null || mk.limit > cur) limitByParent.set(parent, mk.limit);
    }
  }

  const cornerIds = new Set<number>([...totalsByCorner.keys(), ...ahByCorner.keys()]);
  for (const cid of cornerIds) {
    const parent = parentOf.get(cid);
    if (parent == null) continue;
    const totalsPts: LinePoint[] = [];
    for (const [line, pr] of totalsByCorner.get(cid) ?? []) {
      if (pr.over != null && pr.under != null) totalsPts.push({ line, prob: devigTwoWay(pr.over, pr.under) });
    }
    const ahPts: LinePoint[] = [];
    for (const [line, pr] of ahByCorner.get(cid) ?? []) {
      if (pr.home != null && pr.away != null) ahPts.push({ line, prob: devigTwoWay(pr.home, pr.away) });
    }
    totalsPts.sort((a, b) => a.line - b.line);
    ahPts.sort((a, b) => a.line - b.line);
    out.set(String(parent), {
      totals: { sourceId: PINNACLE_SOURCE_ID, marketType: "TOTAL", scope: "corners", points: totalsPts },
      ah: { sourceId: PINNACLE_SOURCE_ID, marketType: "AH", scope: "corners", points: ahPts },
      limit: limitByParent.get(parent) ?? null,
    });
  }
  return out;
}
