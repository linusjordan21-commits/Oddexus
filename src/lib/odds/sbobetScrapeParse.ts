/**
 * sbobetScrapeParse.ts — parsar RÅ SBOBET-DOM-odds (onPrice-handlers) till
 * vårt normaliserade marknadsformat. Detta är den TESTBARA kärnan i
 * SBOBET-skrapan; själva DOM-extraktionen
 * (scripts/fetch-sbobet-github-action.mjs) plockar onPrice-anropen + matchrad-
 * kontext och matar RÅ-rader hit.
 *
 * Bakgrund (verifierat via probe-site-json.mjs): SBOBET renderar oddsen i HTML
 * som klickbara länkar:
 *
 *     <a href="javascript:$M('od').onPrice('s', 572125529, '1', 1.47)">1.47</a>
 *
 * där argumenten är (handlingstyp, oddsId, market, price):
 *   - market '1' | 'x' | '2'  → 1X2 hemma / oavgjort / borta
 *   - market 'h' | 'a'        → Asian Handicap hemma / borta
 *
 * oddsId grupperar EN marknad (alla 1/x/2 delar ett id; h/a delar ett annat).
 * AH-LINJEN (t.ex. -0.5) finns INTE i onPrice-anropet — den ligger i intill-
 * liggande DOM och fångas av skrapan som `handicapLine` (tecken ur HEMMA-
 * perspektiv: favorit = negativ). Team/start/liga fångas likaså ur matchraden.
 *
 * Konservativt (samma princip som Betfair-parsern): hellre släppa en marknad
 * än mata in halvdata. Ofullständig 1X2 (saknar 1, x eller 2), AH utan både
 * h+a eller utan linje, eller pris ≤ 1 → marknaden släpps tyst.
 */

import { normalizeTeamName } from "./matching.ts";
import type { Selection } from "./types.ts";

export const SBOBET_SOURCE_ID = "sbobet";

/** Marknadstyper SBOBET-skrapan extraherar i v1. */
export type SbobetMarketType = "ML_1X2" | "AH";

/** En rå odds-post extraherad ur ETT onPrice-anrop + matchrad-kontext. */
export interface SbobetRawOdds {
  /** oddsId ur onPrice('s', oddsId, market, price). Grupperar en marknad. */
  oddsId: string;
  /** market-koden: '1'|'x'|'2' (1X2) eller 'h'|'a' (Asian Handicap). */
  market: string;
  /** Decimal-pris ur onPrice. */
  price: number;
  /** Lagnamn ur matchraden (skrapan fyller från DOM-kontext). */
  homeTeam?: string;
  awayTeam?: string;
  /** Liga/turnering ur sidhuvudet för matchgruppen. */
  league?: string;
  /** Starttid (ISO) om skrapan kunde tolka den ur raden. */
  startTime?: string;
  /**
   * AH-handikappet ur HEMMA-perspektiv (favorit negativ, t.ex. -0.5). Endast
   * relevant för market 'h'/'a'. Saknas → AH-marknaden kan ej byggas.
   */
  handicapLine?: number;
  /** Stabilt event-id ur DOM om skrapan hittar ett (annars härleds nyckel). */
  eventId?: string;
  /** Sport (football/tennis/basketball/baseball) härledd ur vy-URL:en. Default football. */
  sport?: string;
}

/** En SBOBET-runner (utfall) med decimal-odds. */
export interface SbobetRunner {
  selection: Selection; // HOME/DRAW/AWAY (1X2) eller HOME/AWAY (AH)
  decimalOdds: number;
}

/** En SBOBET-marknad (1 marknad = 1 oddsId). */
export interface SbobetMarket {
  oddsId: string;
  marketType: SbobetMarketType;
  /** "full" i v1. */
  scope: string;
  /** Endast AH: handikapp ur HEMMA-perspektiv. */
  line?: number;
  runners: SbobetRunner[];
}

export interface ParsedSbobetEvent {
  sbobetEventId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string | null;
  competition: string | null;
  markets: SbobetMarket[];
}

const ONE_X_TWO = new Set(["1", "x", "2"]);
const AH = new Set(["h", "a"]);

function selForMarket(market: string): Selection | null {
  switch (market) {
    case "1":
    case "h":
      return "HOME";
    case "x":
      return "DRAW";
    case "2":
    case "a":
      return "AWAY";
    default:
      return null;
  }
}

/** Härled en stabil event-nyckel ur rå-raden. */
function eventKeyOf(r: SbobetRawOdds): string | null {
  if (r.eventId) return `id:${r.eventId}`;
  if (r.homeTeam && r.awayTeam) {
    const start = r.startTime ?? "";
    // Sport i nyckeln → samma lagnamn i olika sporter (t.ex. landslag "Brazil" i fotboll
    // vs basket) slås aldrig ihop till samma event.
    const sport = r.sport ?? "football";
    return `tn:${sport}::${normalizeTeamName(r.homeTeam)}::${normalizeTeamName(r.awayTeam)}::${start}`;
  }
  return null;
}

/** Första icke-tomma värdet i en grupp (för identitetsfält). */
function firstDefined<T>(rows: SbobetRawOdds[], pick: (r: SbobetRawOdds) => T | undefined | null): T | null {
  for (const r of rows) {
    const v = pick(r);
    if (v != null && v !== "") return v;
  }
  return null;
}

/**
 * Bygg EN SbobetMarket ur en grupp rå-rader som delar oddsId. Null om
 * gruppen är ofullständig (saknar utfall / linje / giltigt pris).
 */
export function parseOneSbobetMarket(oddsId: string, rows: SbobetRawOdds[]): SbobetMarket | null {
  // En grupp ska vara antingen 1X2 ELLER AH — inte blandat.
  const markets = new Set(rows.map((r) => r.market));
  const is1x2 = [...markets].every((m) => ONE_X_TWO.has(m));
  const isAh = [...markets].every((m) => AH.has(m));

  const runnerFor = (market: string): SbobetRunner | null => {
    const row = rows.find((r) => r.market === market);
    if (!row) return null;
    const sel = selForMarket(market);
    if (!sel) return null;
    if (!Number.isFinite(row.price) || row.price <= 1) return null; // inget halvpris
    return { selection: sel, decimalOdds: row.price };
  };

  if (is1x2) {
    const home = runnerFor("1"), draw = runnerFor("x"), away = runnerFor("2");
    if (!home || !draw || !away) return null; // kräver komplett 1X2
    return { oddsId, marketType: "ML_1X2", scope: "full", runners: [home, draw, away] };
  }

  if (isAh) {
    const home = runnerFor("h"), away = runnerFor("a");
    if (!home || !away) return null; // kräver både sidor
    const line = firstDefined(rows, (r) => (Number.isFinite(r.handicapLine as number) ? r.handicapLine : null));
    if (line == null) return null; // AH utan linje → meningslöst, släpp
    return { oddsId, marketType: "AH", scope: "full", line, runners: [home, away] };
  }

  return null; // okänd/blandad marknad
}

/**
 * Parsa många rå onPrice-rader → events grupperade per matchidentitet.
 * Marknader utan komplett data släpps tyst (ingen halvdata).
 */
export function parseSbobetMarkets(raw: SbobetRawOdds[]): ParsedSbobetEvent[] {
  // 1) Gruppera rå-rader per oddsId (= en marknad).
  const byOddsId = new Map<string, SbobetRawOdds[]>();
  for (const r of raw) {
    if (!r?.oddsId || !r.market) continue;
    const arr = byOddsId.get(r.oddsId);
    if (arr) arr.push(r);
    else byOddsId.set(r.oddsId, [r]);
  }

  // 2) Bygg marknader och knyt till event-identitet.
  const byEvent = new Map<string, ParsedSbobetEvent>();
  for (const [oddsId, rows] of byOddsId) {
    const market = parseOneSbobetMarket(oddsId, rows);
    if (!market) continue;
    const key = eventKeyOf(rows[0]);
    if (!key) continue; // utan identitet kan vi inte matcha mot Pinnacle
    const home = firstDefined(rows, (r) => r.homeTeam);
    const away = firstDefined(rows, (r) => r.awayTeam);
    if (!home || !away) continue;

    const ev = byEvent.get(key);
    if (ev) {
      ev.markets.push(market);
    } else {
      byEvent.set(key, {
        sbobetEventId: firstDefined(rows, (r) => r.eventId) ?? key,
        sport: firstDefined(rows, (r) => r.sport) ?? "football",
        homeTeam: home,
        awayTeam: away,
        startTime: firstDefined(rows, (r) => r.startTime),
        competition: firstDefined(rows, (r) => r.league),
        markets: [market],
      });
    }
  }

  return [...byEvent.values()];
}

/** Serialisera till data/sbobet-rows.json-format. */
export function toSbobetRowsFile(events: ParsedSbobetEvent[]): {
  updatedAt: string;
  source: string;
  events: Record<string, ParsedSbobetEvent>;
} {
  const out: Record<string, ParsedSbobetEvent> = {};
  for (const e of events) out[e.sbobetEventId] = e;
  return { updatedAt: new Date().toISOString(), source: "github-actions-dom-scrape", events: out };
}
