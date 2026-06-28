/**
 * betfairScrapeParse.ts — parsar RÅ Betfair Exchange-data (API-NG-form, som
 * de interna webb-endpointsen speglar) till vårt BetfairMarket-format.
 *
 * Detta är den TESTBARA kärnan i Betfair-skrapan. Själva hämtningen
 * (scripts/fetch-betfair-github-action.mjs) interceptar Betfairs egna
 * JSON-svar och matar dem hit.
 *
 * ⚠️ BEGRÄNSNING: order book-DJUP + matchad volym ligger ofta bakom
 * autentisering. Utan inloggad session kan availableToBack/Lay vara tomma
 * eller grunda → parser:n släpper då marknaden (ingen halvdata). Det är
 * meningen: hellre ingen Betfair-rad än en rad utan djup som liquidity-
 * filtret ändå skulle förkasta.
 */

import { normalizeTeamName } from "./matching.ts";
import type { BetfairMarket, BetfairRunner } from "./betfairAdapter.ts";
import type { Selection } from "./types.ts";

// ── Råa Betfair-typer (API-NG marketCatalogue + marketBook) ────────────
export interface RawPriceSize { price: number; size: number }
export interface RawRunnerCatalogue { selectionId: number; runnerName: string }
export interface RawMarketCatalogue {
  marketId: string;
  marketName: string; // "Match Odds" | "Over/Under 2.5 Goals" | ...
  totalMatched?: number;
  event: { id: string; name: string; openDate: string }; // name = "Home v Away"
  competition?: { id?: string; name?: string };
  runners: RawRunnerCatalogue[];
}
export interface RawRunnerBook {
  selectionId: number;
  status?: string;
  ex?: { availableToBack?: RawPriceSize[]; availableToLay?: RawPriceSize[] };
}
export interface RawMarketBook {
  marketId: string;
  status?: string;
  totalMatched?: number;
  runners: RawRunnerBook[];
}

export interface ParsedBetfairEvent {
  betfairEventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  competition: string | null;
  markets: BetfairMarket[];
}

/** "Real Madrid v Sevilla" → { home, away }. Null om formen ej känns igen. */
export function parseEventName(name: string): { home: string; away: string } | null {
  // Betfair använder " v " (ibland " @ " för US-sporter, away först).
  const v = name.split(/\s+v\s+/i);
  if (v.length === 2) return { home: v[0].trim(), away: v[1].trim() };
  const at = name.split(/\s+@\s+/i);
  if (at.length === 2) return { home: at[1].trim(), away: at[0].trim() }; // @ = away first
  return null;
}

function bestPrice(arr: RawPriceSize[] | undefined): RawPriceSize | null {
  return arr && arr.length > 0 && Number.isFinite(arr[0].price) && arr[0].price > 1 ? arr[0] : null;
}

/** Bygg en BetfairRunner ur catalogue-runner + book-runner. Null om grund. */
function toRunner(selection: Selection, book: RawRunnerBook | undefined): BetfairRunner | null {
  if (!book || (book.status && book.status !== "ACTIVE")) return null;
  const back = bestPrice(book.ex?.availableToBack);
  const lay = bestPrice(book.ex?.availableToLay);
  if (!back || !lay) return null; // saknar djup → släpp (ingen halvdata)
  return { selection, backOdds: back.price, layOdds: lay.price, backDepth: back.size, layDepth: lay.size };
}

const TOTALS_RE = /over\/under\s+([\d.]+)\s+goals/i;

/**
 * Parsa ett joinat marketCatalogue+marketBook → BetfairMarket + identitet.
 * Stödjer Match Odds (1X2) och Over/Under Goals (totals). Övriga → null.
 */
export function parseOneMarket(
  cat: RawMarketCatalogue,
  book: RawMarketBook,
): { identity: Omit<ParsedBetfairEvent, "markets">; market: BetfairMarket } | null {
  const names = parseEventName(cat.event?.name ?? "");
  if (!names) return null;
  const bookBySel = new Map(book.runners.map((r) => [r.selectionId, r]));
  const matchedVolume = book.totalMatched ?? cat.totalMatched ?? 0;

  const identity = {
    betfairEventId: cat.event.id,
    homeTeam: names.home,
    awayTeam: names.away,
    startTime: cat.event.openDate,
    competition: cat.competition?.name ?? null,
  };

  // ── Match Odds (1X2) ──
  if (/^match odds$/i.test(cat.marketName.trim())) {
    const runners: BetfairRunner[] = [];
    for (const rc of cat.runners) {
      let sel: Selection | null = null;
      if (/^the draw$/i.test(rc.runnerName)) sel = "DRAW";
      else if (normalizeTeamName(rc.runnerName) === normalizeTeamName(names.home)) sel = "HOME";
      else if (normalizeTeamName(rc.runnerName) === normalizeTeamName(names.away)) sel = "AWAY";
      if (!sel) continue;
      const runner = toRunner(sel, bookBySel.get(rc.selectionId));
      if (runner) runners.push(runner);
    }
    if (runners.length !== 3) return null; // kräver komplett H/D/A med djup
    return {
      identity,
      market: { marketId: cat.marketId, sport: "football", marketType: "MATCH_ODDS", scope: "full", matchedVolume, runners },
    };
  }

  // ── Over/Under Goals (totals) ──
  const tm = TOTALS_RE.exec(cat.marketName);
  if (tm) {
    const line = Number(tm[1]);
    const runners: BetfairRunner[] = [];
    for (const rc of cat.runners) {
      const sel: Selection | null = /^over/i.test(rc.runnerName) ? "OVER" : /^under/i.test(rc.runnerName) ? "UNDER" : null;
      if (!sel) continue;
      const runner = toRunner(sel, bookBySel.get(rc.selectionId));
      if (runner) runners.push(runner);
    }
    if (runners.length !== 2) return null;
    return {
      identity,
      market: { marketId: cat.marketId, sport: "football", marketType: "TOTALS", scope: "match_total", line, matchedVolume, runners },
    };
  }

  return null; // ej stödd marknad
}

/**
 * Parsa många catalogues+books → events grupperade per Betfair-eventId.
 * Marknader utan djup/känd typ släpps tyst.
 */
export function parseBetfairMarkets(
  catalogues: RawMarketCatalogue[],
  books: RawMarketBook[],
): ParsedBetfairEvent[] {
  const bookById = new Map(books.map((b) => [b.marketId, b]));
  const byEvent = new Map<string, ParsedBetfairEvent>();

  for (const cat of catalogues) {
    const book = bookById.get(cat.marketId);
    if (!book) continue;
    if (book.status && book.status !== "OPEN") continue;
    const parsed = parseOneMarket(cat, book);
    if (!parsed) continue;

    const ev = byEvent.get(parsed.identity.betfairEventId);
    if (ev) ev.markets.push(parsed.market);
    else byEvent.set(parsed.identity.betfairEventId, { ...parsed.identity, markets: [parsed.market] });
  }
  return [...byEvent.values()];
}

/**
 * Parsa Betfairs publika `ero.../readonly/v1/bymarket`-svar → events per Betfair-
 * eventId. Till skillnad från API-NG är katalog + book JOINADE i samma marketNode
 * (runner har både `description.runnerName` OCH `exchange.availableToBack/Lay`).
 * Återanvänder runner→selection-mappning + back/lay-djup-logiken. Bara Match Odds
 * (1X2) i v1 (totals kan läggas till från samma struktur senare). bodies = flera
 * intercepta JSON-svar (sidan hämtar marknader i batchar).
 */
/** Bygg en BetfairRunner ur ett rått bymarket-runner-objekt + selection. */
function bymarketToRunner(r: Record<string, unknown>, sel: Selection): BetfairRunner | null {
  const rstate = r.state as { status?: string } | undefined;
  return toRunner(sel, {
    selection: sel as Selection,
    selectionId: Number(r.selectionId),
    status: rstate?.status,
    ex: r.exchange as { availableToBack?: RawPriceSize[]; availableToLay?: RawPriceSize[] } | undefined,
  });
}

/** "Over 2.5 Goals"/"Under 2.5 Goals" → OVER/UNDER. */
function totalsSelection(runnerName: string): Selection | null {
  if (/^over/i.test(runnerName)) return "OVER";
  if (/^under/i.test(runnerName)) return "UNDER";
  return null;
}

/**
 * Parsa EN marketNode (publik bymarket-form) → 0..N BetfairMarket. Stödjer:
 *  - MATCH_ODDS (1X2, 3 runners H/D/A) → 1 marknad
 *  - OVER_UNDER_xx mål (totals, 2 runners O/U, linje ur marketName "x.x Goals") → 1
 *  - ASIAN_HANDICAP (MÅNGLINJES: samma 2 lag på flera handikapp-linjer i SAMMA
 *    marknad, linje ur runner.handicap) → 1 marknad PER linje (hemma-perspektiv)
 * Tom array för ej-OPEN, okänd typ, eller ofullständigt djup.
 */
function parseMarketNode(mn: Record<string, unknown>, names: { home: string; away: string }): BetfairMarket[] {
  const desc = mn.description as { marketType?: string; marketName?: string } | undefined;
  const state = mn.state as { status?: string; totalMatched?: number } | undefined;
  if (state?.status && state.status !== "OPEN") return [];
  const mt = desc?.marketType ?? "";
  const marketId = String(mn.marketId);
  const matchedVolume = Number(state?.totalMatched ?? 0);
  const rawRunners = (mn.runners ?? []) as Array<Record<string, unknown>>;
  const nameOf = (r: Record<string, unknown>) => ((r.description as { runnerName?: string } | undefined)?.runnerName ?? "");
  const hcOf = (r: Record<string, unknown>) => Number((r as { handicap?: number }).handicap ?? NaN);

  // ── Match Odds (1X2) ──
  if (mt === "MATCH_ODDS") {
    const runners: BetfairRunner[] = [];
    for (const r of rawRunners) {
      const nm = nameOf(r);
      let sel: Selection | null = null;
      if (/^the draw$/i.test(nm)) sel = "DRAW";
      else if (normalizeTeamName(nm) === normalizeTeamName(names.home)) sel = "HOME";
      else if (normalizeTeamName(nm) === normalizeTeamName(names.away)) sel = "AWAY";
      if (!sel) continue;
      const runner = bymarketToRunner(r, sel);
      if (runner) runners.push(runner);
    }
    if (runners.length !== 3) return [];
    return [{ marketId, sport: "football", marketType: "MATCH_ODDS", scope: "full", matchedVolume, runners }];
  }

  // ── Over/Under mål (totals). marketName "Over/Under 2.5 Goals" → linje (filtrerar
  // bort corners/cards som har egen marketName). ──
  if (/^OVER_UNDER_\d+$/.test(mt)) {
    const tm = TOTALS_RE.exec(desc?.marketName ?? "");
    if (!tm) return [];
    const line = Number(tm[1]);
    const runners: BetfairRunner[] = [];
    for (const r of rawRunners) {
      const sel = totalsSelection(nameOf(r));
      if (!sel) continue;
      const runner = bymarketToRunner(r, sel);
      if (runner) runners.push(runner);
    }
    if (runners.length !== 2) return [];
    return [{ marketId, sport: "football", marketType: "TOTALS", scope: "match_total", line, matchedVolume, runners }];
  }

  // ── Asian Handicap (mångLinjes). En ASIAN_HANDICAP-marknad listar BÅDA lagen på
  // FLERA handikapp-linjer (4+ runners). Varje runner bär sin handicap; hemma-linjen
  // = hemmalagets handicap, bortalaget har motsatt tecken på SAMMA linje. Para ihop
  // home(hc=h) med away(hc=-h) → en BetfairMarket per linje (syntetiskt marketId
  // "<id>@<h>" så dedup/ladder ser dem som separata linjer). ──
  if (mt === "ASIAN_HANDICAP") {
    const homeByHc = new Map<number, Record<string, unknown>>();
    const awayByHc = new Map<number, Record<string, unknown>>();
    for (const r of rawRunners) {
      const hc = hcOf(r);
      if (!Number.isFinite(hc)) continue;
      const nm = normalizeTeamName(nameOf(r));
      if (nm === normalizeTeamName(names.home)) homeByHc.set(hc, r);
      else if (nm === normalizeTeamName(names.away)) awayByHc.set(hc, r);
    }
    const out: BetfairMarket[] = [];
    for (const [hc, hr] of homeByHc) {
      const ar = awayByHc.get(-hc);
      if (!ar) continue;
      const home = bymarketToRunner(hr, "HOME");
      const away = bymarketToRunner(ar, "AWAY");
      if (!home || !away) continue;
      out.push({ marketId: `${marketId}@${hc}`, sport: "football", marketType: "AH", scope: "full", line: hc, matchedVolume, runners: [home, away] });
    }
    return out;
  }

  return []; // ej stödd marknad
}

export function parseBymarketBodies(bodies: unknown[]): ParsedBetfairEvent[] {
  const byEvent = new Map<string, ParsedBetfairEvent>();
  for (const body of bodies) {
    const eventTypes = (body as { eventTypes?: unknown[] })?.eventTypes;
    if (!Array.isArray(eventTypes)) continue;
    for (const et of eventTypes as Array<{ eventNodes?: unknown[] }>) {
      for (const en of (et.eventNodes ?? []) as Array<Record<string, unknown>>) {
        const eventId = en.eventId != null ? String(en.eventId) : "";
        const ev = en.event as { eventName?: string; openDate?: string } | undefined;
        const names = parseEventName(ev?.eventName ?? "");
        if (!eventId || !names) continue;
        for (const mn of (en.marketNodes ?? []) as Array<Record<string, unknown>>) {
          for (const market of parseMarketNode(mn, names)) {
            const existing = byEvent.get(eventId);
            if (existing) {
              // Dedup per marketId: enumererade + passivt interceptade svar kan överlappa.
              if (!existing.markets.some((m) => m.marketId === market.marketId)) existing.markets.push(market);
            } else {
              byEvent.set(eventId, { betfairEventId: eventId, homeTeam: names.home, awayTeam: names.away, startTime: ev?.openDate ?? "", competition: null, markets: [market] });
            }
          }
        }
      }
    }
  }
  return [...byEvent.values()];
}

/** Serialisera till data/betfair-rows.json-format. */
export function toBetfairRowsFile(events: ParsedBetfairEvent[]): {
  updatedAt: string;
  source: string;
  events: Record<string, ParsedBetfairEvent>;
} {
  const out: Record<string, ParsedBetfairEvent> = {};
  for (const e of events) out[e.betfairEventId] = e;
  return { updatedAt: new Date().toISOString(), source: "github-actions-scrape", events: out };
}
