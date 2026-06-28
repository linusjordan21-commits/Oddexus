/**
 * Definition av bookmakers som delar odds-feed eller är samma underliggande
 * sportsbook med olika brand. Används som presentation-layer i ValueBets-
 * listan så att samma valuebet inte visas tre gånger när tre brand i en
 * grupp har identiskt odds.
 *
 * Källa till sanning: scraping-pipelinen i vite.config.ts skiljer på alla
 * bookmakerId individuellt — vi rör inte den. Detta är endast en UI-
 * gruppering ovanpå rådata. Bet Log och valuebets-fetchen påverkas inte.
 */

export interface BookmakerGroupDef {
  /** Stabil id för React-keys och grouping. */
  id: string;
  /** Visningsnamn ovanför "X sites"-badge. */
  label: string;
  /** Lista över bookmakerId som rapporteras i ValueBetsResponse. */
  bookmakerIds: string[];
}

export const BOOKMAKER_GROUPS: readonly BookmakerGroupDef[] = [
  {
    id: "comeon-group",
    label: "ComeOn Group",
    bookmakerIds: ["hajper", "snabbare", "comeon"],
  },
  {
    id: "betsson-group",
    label: "Betsson Group",
    bookmakerIds: ["bethard", "spelklubben", "betsson"],
  },
  {
    id: "kambi-group",
    label: "Kambi Group",
    bookmakerIds: ["dbet", "mrvegas", "megariches"],
  },
] as const;

/** Bygg snabb lookup-map: bookmakerId → groupDef. */
const ID_TO_GROUP: ReadonlyMap<string, BookmakerGroupDef> = (() => {
  const map = new Map<string, BookmakerGroupDef>();
  for (const group of BOOKMAKER_GROUPS) {
    for (const id of group.bookmakerIds) {
      map.set(id.toLowerCase(), group);
    }
  }
  return map;
})();

/**
 * Returnerar gruppId för en bookmaker, eller bookmakerId själv (lowercase)
 * om den inte finns i någon grupp. Detta gör grouping-key enhetlig — singel-
 * bookmakers blir egna "grupper" med siteCount=1.
 */
export function getBookmakerGroupId(bookmakerId: string): string {
  const norm = (bookmakerId ?? "").toLowerCase().trim();
  if (!norm) return "";
  return ID_TO_GROUP.get(norm)?.id ?? norm;
}

/** Returnerar gruppdef om bookmakerId hör till en grupp, annars null. */
export function getBookmakerGroup(bookmakerId: string): BookmakerGroupDef | null {
  const norm = (bookmakerId ?? "").toLowerCase().trim();
  return ID_TO_GROUP.get(norm) ?? null;
}

/** Visningsnamn: gruppens label om medlem, annars första-bokstav-cap av id. */
export function getBookmakerGroupLabel(bookmakerId: string, fallbackName?: string): string {
  const group = getBookmakerGroup(bookmakerId);
  if (group) return group.label;
  return fallbackName ?? bookmakerId;
}

// ====================================================================
// Grouping av ValueBet[] → GroupedValueBet[]
// ====================================================================

/**
 * Generic grouping-input. Vi typar det löst för att slippa cirkulärt
 * beroende mot ValueBets.tsx; konsumenten skickar in vilken array som
 * helst som matchar denna shape.
 */
export interface GroupableBet {
  match: string;
  startTs?: string;
  outcome: string;
  bookmakerId: string;
  bookmakerName: string;
  bookmakerOdds: number;
  evPct: number;
}

export interface GroupedValueBet<T extends GroupableBet = GroupableBet> {
  /** Stabil React-key. */
  id: string;
  /** "Bästa" variant (högst odds). Används för hela kortets representation. */
  primary: T;
  /** Alla varianter i gruppen, sorterade odds DESC. Innehåller primary. */
  variants: T[];
  /** "comeon-group" / "betsson-group" / "kambi-group" eller bookmakerId. */
  bookmakerGroupId: string;
  /** "ComeOn Group" / bookmakerName. */
  bookmakerGroupLabel: string;
  /** True om siteCount > 1 — UI visar "X sites"-badge. */
  isGrouped: boolean;
  /** Antal varianter (=antal bookmakers i gruppen som har samma valuebet). */
  siteCount: number;
  /** Högsta odds bland varianter. */
  bestOdds: number;
  /** Lägsta odds bland varianter — för range-tooltip. */
  worstOdds: number;
  /** Högsta EV% bland varianter (= primary.evPct när sortering är odds DESC och fair odds är samma). */
  bestEvPct: number;
}

/**
 * Time-tolerans för att räkna två startTs som "samma match". 1 timme räcker
 * för att täcka edge cases där bookmakers rapporterar något olika kickoff,
 * men förhindrar att helt olika matcher mergas.
 */
const SAME_MATCH_TIME_TOLERANCE_MS = 60 * 60 * 1000;

function normalizeMatchKey(match: string): string {
  return (match ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function startTimeBucket(startTs: string | undefined): string {
  if (!startTs) return "no-start";
  const ms = Date.parse(startTs);
  if (!Number.isFinite(ms)) return "no-start";
  // Bucket i 1h-intervall. Två events inom 1h från varandra hamnar i samma
  // bucket → kan grupperas. Mer än 1h isär = olika buckets, blockerar merge.
  return String(Math.floor(ms / SAME_MATCH_TIME_TOLERANCE_MS));
}

/**
 * Grupperar valuebets på (match, startTime-bucket, outcome, bookmakerGroup).
 * Singel-bookmakers blir egna "grupper" med siteCount=1 och isGrouped=false.
 *
 * Sortering inom grupp: odds DESC (= mest edge först). Primary = första.
 *
 * Sortering av output: bestEvPct DESC. Använder en stable sort så ordningen
 * inom same-EV följer input-ordningen.
 *
 * Try/catch sväljer fel och returnerar raw input mappat 1:1 till singel-
 * grupper — så att UI:t aldrig kraschar pga grouping-fel.
 */
export function groupValueBets<T extends GroupableBet>(bets: T[]): GroupedValueBet<T>[] {
  try {
    const buckets = new Map<string, T[]>();
    for (const bet of bets) {
      const groupId = getBookmakerGroupId(bet.bookmakerId);
      const matchKey = normalizeMatchKey(bet.match);
      const startBucket = startTimeBucket(bet.startTs);
      const key = `${matchKey}::${startBucket}::${bet.outcome}::${groupId}`;
      const arr = buckets.get(key);
      if (arr) arr.push(bet);
      else buckets.set(key, [bet]);
    }

    const result: GroupedValueBet<T>[] = [];
    for (const [key, variants] of buckets) {
      // Sortera odds DESC; vid lika odds, behåll input-ordning.
      const sorted = [...variants].sort((a, b) => b.bookmakerOdds - a.bookmakerOdds);
      const primary = sorted[0];
      const groupDef = getBookmakerGroup(primary.bookmakerId);
      const label = groupDef ? groupDef.label : primary.bookmakerName;
      const groupId = getBookmakerGroupId(primary.bookmakerId);
      const oddsValues = sorted.map((v) => v.bookmakerOdds);
      result.push({
        id: key,
        primary,
        variants: sorted,
        bookmakerGroupId: groupId,
        bookmakerGroupLabel: label,
        isGrouped: sorted.length > 1,
        siteCount: sorted.length,
        bestOdds: Math.max(...oddsValues),
        worstOdds: Math.min(...oddsValues),
        bestEvPct: primary.evPct,
      });
    }

    // Sortera grouped-output på bestEvPct DESC (samma som tidigare valuebets-
    // sortering på evPct DESC).
    result.sort((a, b) => b.bestEvPct - a.bestEvPct);
    return result;
  } catch (error) {
    console.warn("[bookmaker-groups] groupValueBets failed, falling back to ungrouped:", error);
    return bets.map((bet, i) => ({
      id: `fallback-${i}-${bet.bookmakerId}-${bet.outcome}`,
      primary: bet,
      variants: [bet],
      bookmakerGroupId: bet.bookmakerId,
      bookmakerGroupLabel: bet.bookmakerName,
      isGrouped: false,
      siteCount: 1,
      bestOdds: bet.bookmakerOdds,
      worstOdds: bet.bookmakerOdds,
      bestEvPct: bet.evPct,
    }));
  }
}
