/**
 * shadowConsensus.ts — wiring av sharp-consensus-mellanlagret mot vår
 * BEFINTLIGA odds-pipeline, i SHADOW MODE.
 *
 * Flöde:
 *   1. Parsa riktiga Pinnacle-odds (data/pinnacle-rows.json) → 1X2 fair probs.
 *   2. Bygg Betfair-mock per event (samma format som riktiga adaptern senare).
 *   3. Parsa en soft book (candidate) ur befintliga *-rows.json.
 *   4. Matcha event via befintlig matching-logik (normalizeTeamName + bucket).
 *   5. Kör evaluateMarket() per selection.
 *   6. Returnera ClvOpenEntry[] (skrivs till data/clv-log.jsonl av CLI:n).
 *
 * Påverkar INGA live-beslut: rena funktioner, läser bara, skriver bara till
 * clv-log.jsonl. Allt shadowMode=true. Saknad/omatchad data → reason-kod,
 * aldrig krasch.
 *
 * v1: fotboll 1X2 (moneyline). Totals/tennis kan läggas på senare med samma
 * mönster (Betfair-adaptern stödjer redan totals/tennis).
 */

import type { Selection } from "./types.ts";
import type { BenchSport, LeagueTier, TtsBucket } from "./consensusTypes.ts";
import { normalizeTeamName, startTimeBucket } from "./matching.ts";
import { devigThreeWay, evaluateMarket, type MarketContext } from "./consensus.ts";
import { betfairMoneylineQuote, betfairTotalsQuote, betfairAhQuote, type BetfairMarket } from "./betfairAdapter.ts";
import type { ParsedBetfairEvent } from "./betfairScrapeParse.ts";
import { sbobetMoneylineQuote, sbobetAhQuote } from "./sbobetAdapter.ts";
import type { ParsedSbobetEvent, SbobetMarket } from "./sbobetScrapeParse.ts";
import { lineMatchedQuote, type SourceLadder } from "./lineMatching.ts";
import type { PinnacleLineLadders } from "./pinnacleLines.ts";
import { buildClvEntry, type ClvOpenEntry } from "./clvLogger.ts";

// ── Parsade strukturer ─────────────────────────────────────────────────
export interface EventIdentity {
  eventId: string;
  sport: BenchSport;
  league: string | null;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
}

export interface PinnacleEvent {
  identity: EventIdentity;
  /** Decimal odds per selection (med vig). */
  decimal: { HOME: number; DRAW: number; AWAY: number };
  /** No-vig fair prob per selection. */
  fairProb: { HOME: number; DRAW: number; AWAY: number };
  /** Pinnacles limit (likviditetssignal). */
  limit: number | null;
}

/** Soft-bokens O/U-erbjudande på EN total-linje (decimal odds). */
export interface TotalsOffer { line: number; over: number; under: number }
/** Soft-bokens AH-erbjudande på EN handikapp-linje (hemma-perspektiv, decimal). */
export interface AhOffer { line: number; home: number; away: number }
/**
 * Soft-bokens EUROPEISKA 3-vägs-handikapp på EN linje (hemma-perspektiv, decimal).
 * line = hemmalagets mål-handikapp i samma teckenkonvention som AH (negativt = hemma
 * ger mål). Tre utfall med oavgjort: hemma vinner om (M + line) > 0, oavgjort om
 * (M + line) == 0, borta om (M + line) < 0, där M = hemmamål − bortamål.
 */
export interface Eh3Offer { line: number; home: number; draw: number; away: number }
/** Soft-bokens HÖRN-erbjudanden: O/U på antal hörn + asiatiskt hörn-handikapp. */
export interface CornersOffer { totals: TotalsOffer[]; ah: AhOffer[] }

export interface CandidateEvent {
  identity: EventIdentity;
  bookmaker: string;
  odds: { HOME: number; DRAW: number; AWAY: number };
  /** Valfria linje-marknader (när fetchern levererar dem). */
  totals?: TotalsOffer[];
  ah?: AhOffer[];
  eh3?: Eh3Offer[];
  corners?: CornersOffer;
}

export type SkipReason =
  | "NO_PINNACLE_MATCH"
  | "INCOMPLETE_PINNACLE_MARKET"
  | "INVALID_CANDIDATE_ODDS"
  | "NO_SOFT_ODDS";

export interface SkippedRecord {
  reason: SkipReason;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  bookmaker?: string;
}

const SELECTIONS: Array<keyof PinnacleEvent["decimal"]> = ["HOME", "DRAW", "AWAY"];

// ── Odds-hjälpare ──────────────────────────────────────────────────────
export function americanToDecimal(american: number): number {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

/** Tid-till-start-hink från startTime relativt now. */
export function ttsBucketFrom(startTime: string, now = Date.now()): TtsBucket {
  const ms = Date.parse(startTime);
  if (!Number.isFinite(ms)) return ">24h";
  const h = (ms - now) / 3_600_000;
  if (h < 1) return "<1h";
  if (h < 6) return "1-6h";
  if (h < 24) return "6-24h";
  return ">24h";
}

/** Konservativ tier-härledning ur liganamn. Default T1; okänt → T2. */
export function deriveTier(league: string | null): LeagueTier {
  if (!league) return "T2";
  const l = league.toLowerCase();
  if (/challenger|itf|i?tf|reserv|u19|u20|u21|youth|friendly|träning/.test(l)) return "T3";
  return "T1";
}

// ── Pinnacle-parsning ──────────────────────────────────────────────────
/** Parsa soccer-moneyline ur pinnacle-rows.json → Map<eventKey, PinnacleEvent>. */
export function parsePinnacleSoccer(json: unknown): PinnacleEvent[] {
  const out: PinnacleEvent[] = [];
  const soccer = (json as { bySport?: Record<string, { matchups?: unknown[]; markets?: unknown[] }> })?.bySport?.soccer;
  if (!soccer?.matchups || !soccer?.markets) return out;

  const byId = new Map<number, { startTime: string; league: string | null; home: string; away: string }>();
  for (const mu of soccer.matchups as Array<{ id: number; startTime: string; league?: { name?: string }; participants?: Array<{ alignment: string; name: string }> }>) {
    const home = mu.participants?.find((p) => p.alignment === "home")?.name;
    const away = mu.participants?.find((p) => p.alignment === "away")?.name;
    if (!home || !away) continue;
    byId.set(mu.id, { startTime: mu.startTime, league: mu.league?.name ?? null, home, away });
  }

  for (const mk of soccer.markets as Array<{ matchupId: number; type: string; period: number; limit?: number; prices?: Array<{ designation: string; price: number }> }>) {
    if (mk.type !== "moneyline" || mk.period !== 0) continue;
    const ident = byId.get(mk.matchupId);
    if (!ident) continue;
    const ph = mk.prices?.find((p) => p.designation === "home")?.price;
    const pd = mk.prices?.find((p) => p.designation === "draw")?.price;
    const pa = mk.prices?.find((p) => p.designation === "away")?.price;
    if (ph == null || pd == null || pa == null) continue; // ofullständig 1X2

    const dHome = americanToDecimal(ph), dDraw = americanToDecimal(pd), dAway = americanToDecimal(pa);
    out.push({
      identity: {
        eventId: String(mk.matchupId), sport: "football", league: ident.league,
        homeTeam: ident.home, awayTeam: ident.away, startTime: ident.startTime,
      },
      decimal: { HOME: dHome, DRAW: dDraw, AWAY: dAway },
      fairProb: {
        HOME: devigThreeWay(dHome, dDraw, dAway, "HOME"),
        DRAW: devigThreeWay(dHome, dDraw, dAway, "DRAW"),
        AWAY: devigThreeWay(dHome, dDraw, dAway, "AWAY"),
      },
      limit: mk.limit ?? null,
    });
  }
  return out;
}

// ── Soft book-parsning (candidate) ─────────────────────────────────────
interface RawSoftEvent {
  eventId?: string;
  homeTeam?: string;
  awayTeam?: string;
  startTime?: string;
  league?: string;
  leagueId?: number;
  odds?: { home?: number; draw?: number; away?: number };
  /** Linje-marknader om fetchern levererar dem. */
  totals?: Array<{ line?: number; over?: number; under?: number }>;
  ah?: Array<{ line?: number; home?: number; away?: number }>;
  eh3?: Array<{ line?: number; home?: number; draw?: number; away?: number }>;
  corners?: { totals?: Array<{ line?: number; over?: number; under?: number }>; ah?: Array<{ line?: number; home?: number; away?: number }> };
}

/** Behåll bara giltiga decimal-erbjudanden (>1) med ändlig linje. */
function cleanTotals(raw: RawSoftEvent["totals"]): TotalsOffer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && Number.isFinite(t.line) && Number(t.over) > 1 && Number(t.under) > 1)
    .map((t) => ({ line: t!.line as number, over: t!.over as number, under: t!.under as number }));
}
function cleanAh(raw: RawSoftEvent["ah"]): AhOffer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && Number.isFinite(a.line) && Number(a.home) > 1 && Number(a.away) > 1)
    .map((a) => ({ line: a!.line as number, home: a!.home as number, away: a!.away as number }));
}
function cleanEh3(raw: RawSoftEvent["eh3"]): Eh3Offer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && Number.isFinite(e.line) && Number(e.home) > 1 && Number(e.draw) > 1 && Number(e.away) > 1)
    .map((e) => ({ line: e!.line as number, home: e!.home as number, draw: e!.draw as number, away: e!.away as number }));
}

function softEventFrom(raw: RawSoftEvent, bookmaker: string): CandidateEvent | null {
  const { homeTeam, awayTeam, startTime, odds } = raw;
  if (!homeTeam || !awayTeam || !startTime || !odds) return null;
  if (odds.home == null || odds.draw == null || odds.away == null) return null;
  const totals = cleanTotals(raw.totals);
  const ah = cleanAh(raw.ah);
  const eh3 = cleanEh3(raw.eh3);
  const cTotals = cleanTotals(raw.corners?.totals);
  const cAh = cleanAh(raw.corners?.ah);
  const corners = (cTotals.length || cAh.length) ? { totals: cTotals, ah: cAh } : null;
  return {
    identity: {
      eventId: raw.eventId ?? `${homeTeam}-${awayTeam}`, sport: "football",
      league: raw.league ?? (raw.leagueId != null ? String(raw.leagueId) : null),
      homeTeam, awayTeam, startTime,
    },
    bookmaker,
    odds: { HOME: odds.home, DRAW: odds.draw, AWAY: odds.away },
    ...(totals.length ? { totals } : {}),
    ...(ah.length ? { ah } : {}),
    ...(eh3.length ? { eh3 } : {}),
    ...(corners ? { corners } : {}),
  };
}

type SoftContainer = Record<string, { bookmaker?: string; events?: RawSoftEvent[] }>;

/**
 * Parsa en soft book ur dess *-rows.json. Stödjer alla våra fetchers-layouter:
 *  - direkt `events[]` (betsson/vbet/kambi)
 *  - platt `footballRows[]`/`rows[]` (smarkets-exchange)
 *  - nästlade skin-/brand-mappar `byFranchise`/`byIntegration`/`byBrand`
 *    (comeon/altenar/paf — varje nyckel är en skin med IDENTISKA odds).
 * Dedupar per eventId så att skins av samma bok inte dubbelräknas. Football 1X2.
 */
export function parseSoftBook(json: unknown, bookmaker: string, franchise?: string): CandidateEvent[] {
  const j = json as {
    events?: RawSoftEvent[];
    rows?: RawSoftEvent[];
    footballRows?: RawSoftEvent[];
    byFranchise?: SoftContainer;
    byIntegration?: SoftContainer;
    byBrand?: SoftContainer;
  };
  const out: CandidateEvent[] = [];
  const seen = new Set<string>();
  const push = (arr: RawSoftEvent[] | undefined, book: string) => {
    for (const e of arr ?? []) {
      const c = softEventFrom(e, book);
      if (!c) continue;
      if (seen.has(c.identity.eventId)) continue; // skin-dedup
      seen.add(c.identity.eventId);
      out.push(c);
    }
  };
  // Direkta event-arrayer. footballRows är football-subsetet av smarkets `rows`.
  push(j?.events, bookmaker);
  push(j?.footballRows ?? j?.rows, bookmaker);
  // Nästlade map-layouter (skin/integration/brand → { bookmaker?, events[] }).
  for (const container of [j?.byFranchise, j?.byIntegration, j?.byBrand]) {
    if (!container) continue;
    const keys = franchise ? [franchise] : Object.keys(container);
    for (const k of keys) push(container[k]?.events, container[k]?.bookmaker ?? bookmaker);
  }
  return out;
}

// ── Betfair-mock (benchmark) ───────────────────────────────────────────
/**
 * Bygg en LIKVID Betfair-mockmarknad ur ett Pinnacle-event (back/lay tätt
 * runt Pinnacles decimal-odds). Detta är platshållare tills riktig provider
 * finns; den normaliseras + devig:as precis som riktig data.
 */
export function mockBetfairFromPinnacle(ev: PinnacleEvent): BetfairMarket {
  const mk = (dec: number, sel: Selection) => ({
    selection: sel,
    backOdds: dec * 0.999,
    layOdds: dec * 1.012,
    backDepth: 4000,
    layDepth: 3800,
  });
  return {
    marketId: `mock-bf-${ev.identity.eventId}`,
    sport: "football",
    marketType: "MATCH_ODDS",
    scope: "full",
    matchedVolume: 200000,
    runners: [mk(ev.decimal.HOME, "HOME"), mk(ev.decimal.DRAW, "DRAW"), mk(ev.decimal.AWAY, "AWAY")],
  };
}

/**
 * Bygg en mock-Betfair-map (per team-bucket-nyckel) från Pinnacle — endast demo.
 * Nycklas på SAMMA team+bucket-nyckel som Pinnacle/SBOBET (eventKey) så uppslaget
 * (lookupBetfair) fungerar identiskt för mock och riktig feed.
 */
export function buildMockBetfairMap(pinnacle: PinnacleEvent[]): Map<string, BetfairMarket> {
  const m = new Map<string, BetfairMarket>();
  for (const p of pinnacle) {
    const k = eventKey(p.identity.homeTeam, p.identity.awayTeam, p.identity.startTime);
    if (k) m.set(k, mockBetfairFromPinnacle(p));
  }
  return m;
}

/**
 * Parsa en riktig data/betfair-rows.json → Map<teamBucketKey, BetfairMarket(MATCH_ODDS)>.
 * Skrapan skriver { events: { [betfairEventId]: ParsedBetfairEvent } } där varje event
 * bär homeTeam/awayTeam/startTime + markets[] (varav vi plockar MATCH_ODDS-marknaden).
 * Indexeras på samma team+bucket-nyckel som Pinnacle/SBOBET så Betfair kan slås upp
 * per Pinnacle-event (order-oberoende, samma som lookupSbobet). Tom/saknad → tom map.
 */
export function parseBetfairRowsMap(json: unknown): Map<string, BetfairMarket> {
  const out = new Map<string, BetfairMarket>();
  const events = (json as { events?: Record<string, ParsedBetfairEvent> })?.events;
  if (!events || typeof events !== "object") return out;
  for (const ev of Object.values(events)) {
    if (!ev?.homeTeam || !ev?.awayTeam || !ev?.startTime) continue;
    const mo = ev.markets?.find((m) => m.marketType === "MATCH_ODDS" && m.runners?.length === 3);
    if (!mo) continue;
    const k = eventKey(ev.homeTeam, ev.awayTeam, ev.startTime);
    if (k) out.set(k, mo);
  }
  return out;
}

/**
 * Parsa data/betfair-rows.json → Map<teamBucketKey, BetfairMarket[]> med ALLA
 * linje-marknader (TOTALS + AH) per event. Indexeras på samma team+bucket-nyckel
 * som Pinnacle så Betfairs börs-linjer kan blandas in i totals-/AH-fair-price via
 * likviditetsfiltret. Tom/saknad → tom map.
 */
export function parseBetfairLineRowsMap(json: unknown): Map<string, BetfairMarket[]> {
  const out = new Map<string, BetfairMarket[]>();
  const events = (json as { events?: Record<string, ParsedBetfairEvent> })?.events;
  if (!events || typeof events !== "object") return out;
  for (const ev of Object.values(events)) {
    if (!ev?.homeTeam || !ev?.awayTeam || !ev?.startTime) continue;
    const lines = (ev.markets ?? []).filter(
      (m) => (m.marketType === "TOTALS" || m.marketType === "AH") && m.line != null && m.runners?.length === 2,
    );
    if (lines.length === 0) continue;
    const k = eventKey(ev.homeTeam, ev.awayTeam, ev.startTime);
    if (k) out.set(k, lines);
  }
  return out;
}

/**
 * Parsa data/sbobet-rows.json → Map<teamBucketKey, SbobetMarket(ML_1X2)>.
 * Indexeras på samma team+bucket-nyckel som Pinnacle så SBOBET kan slås upp
 * per candidate. Endast 1X2-marknaden plockas i v1 (AH läggs på senare via
 * sbobetAhQuote när Pinnacle/soft också levererar AH-linjer). Tom/saknad → tom.
 */
export function parseSbobetRowsMap(json: unknown): Map<string, SbobetMarket> {
  const out = new Map<string, SbobetMarket>();
  const events = (json as { events?: Record<string, ParsedSbobetEvent> })?.events;
  if (!events || typeof events !== "object") return out;
  for (const ev of Object.values(events)) {
    if (!ev?.homeTeam || !ev?.awayTeam || !ev?.startTime) continue;
    const ml = ev.markets?.find((m) => m.marketType === "ML_1X2" && m.runners?.length === 3);
    if (!ml) continue;
    const k = eventKey(ev.homeTeam, ev.awayTeam, ev.startTime);
    if (k) out.set(k, ml);
  }
  return out;
}

/**
 * Parsa data/sbobet-rows.json → Map<teamBucketKey, SbobetMarket[]> med ALLA
 * AH-marknader (linjer) per event. SBOBET visar flera AH-linjer per match → en
 * stege; buildAhLadder/sbobetAhQuote prissätter candidatens linje mot den.
 */
export function parseSbobetAhRowsMap(json: unknown): Map<string, SbobetMarket[]> {
  const out = new Map<string, SbobetMarket[]>();
  const events = (json as { events?: Record<string, ParsedSbobetEvent> })?.events;
  if (!events || typeof events !== "object") return out;
  for (const ev of Object.values(events)) {
    if (!ev?.homeTeam || !ev?.awayTeam || !ev?.startTime) continue;
    const ah = (ev.markets ?? []).filter((m) => m.marketType === "AH" && m.line != null && m.runners?.length === 2);
    if (ah.length === 0) continue;
    const k = eventKey(ev.homeTeam, ev.awayTeam, ev.startTime);
    if (k) out.set(k, ah);
  }
  return out;
}

// ── Matchning + körning ────────────────────────────────────────────────
function eventKey(homeTeam: string, awayTeam: string, startTime: string): string | null {
  const bucket = startTimeBucket(startTime);
  if (bucket === null) return null;
  return `${normalizeTeamName(homeTeam)}::${normalizeTeamName(awayTeam)}::${bucket}`;
}

// ── Orientering: kanonisera ALLA källors utfall till Pinnacles hemma/borta ──
// Många böcker listar lagen i motsatt ordning mot Pinnacle (särskilt neutrala
// internationella matcher: "Algeria v Jordan" vs Pinnacles "Jordan v Algeria").
// Matchar vi då utan att remappa jämförs candidate-HOME mot Pinnacle-AWAY → FEL
// odds. Regel: 1X2 byter HOME↔AWAY (DRAW står), AH negerar linjen + byter
// home/away (linjen är hemma-perspektiv), totals är symmetriska (oberoende av
// lag-ordning) → oförändrade. Exakt ordning matchas ALLTID först (prioritet).
export const OPP_SELECTION: Record<Selection, Selection> = { HOME: "AWAY", DRAW: "DRAW", AWAY: "HOME" };

function swapCandidateOrientation(c: CandidateEvent): CandidateEvent {
  return {
    ...c,
    identity: { ...c.identity, homeTeam: c.identity.awayTeam, awayTeam: c.identity.homeTeam },
    odds: { HOME: c.odds.AWAY, DRAW: c.odds.DRAW, AWAY: c.odds.HOME },
    ...(c.totals ? { totals: c.totals } : {}), // totals symmetriska → oförändrade
    ...(c.ah ? { ah: c.ah.map((a) => ({ line: -a.line, home: a.away, away: a.home })) } : {}),
  };
}

export function swapSbobetAhOrientation(markets: SbobetMarket[]): SbobetMarket[] {
  return markets.map((m) => ({
    ...m,
    line: m.line != null ? -m.line : m.line,
    runners: m.runners.map((r) => ({ ...r, selection: OPP_SELECTION[r.selection as Selection] })),
  }));
}

// Reorientera Betfairs linje-marknader till Pinnacle-orientering. AH negerar linjen
// + byter HOME/AWAY-runner (hemma-perspektiv); TOTALS är symmetriska → oförändrade.
export function swapBetfairLineOrientation(markets: BetfairMarket[]): BetfairMarket[] {
  return markets.map((m) =>
    m.marketType === "AH"
      ? { ...m, line: m.line != null ? -m.line : m.line, runners: m.runners.map((r) => ({ ...r, selection: OPP_SELECTION[r.selection] })) }
      : m,
  );
}

export interface ShadowRunResult {
  entries: ClvOpenEntry[];
  skipped: SkippedRecord[];
  stats: {
    candidates: number;
    matched: number;
    decisions: number;
    byDecision: Record<string, number>;
    bySkipReason: Record<string, number>;
  };
}

export interface ShadowRunInput {
  pinnacle: PinnacleEvent[];
  candidates: CandidateEvent[];
  now?: number;
  /** Default true. Aldrig false i shadow-jobbet. */
  shadowMode?: boolean;
  /**
   * Empiriska CLV-multiplikatorer per sourceId (från clv-calibrate → data/clv-
   * multipliers.json). Skalar källvikten i consensus efter uppmätt träffsäkerhet
   * mot stängningslinjen. Utelämnad/tom ⇒ alla 1.0 (ren prior-vikt).
   */
  clvMultipliers?: Record<string, number>;
  /**
   * Betfair MATCH_ODDS-marknader per team-bucket-nyckel (från parseBetfairRowsMap
   * eller buildMockBetfairMap). När satt läggs Betfair in som extra benchmark-källa
   * (börs; vägs via likviditetsfiltret). Slås upp order-oberoende mot Pinnacle precis
   * som SBOBET. Utelämnad → PINNACLE-ONLY (ren CLV-attribution).
   */
  betfairMarkets?: Map<string, BetfairMarket>;
  /**
   * Betfair TOTALS+AH-marknader (flera linjer) per team-bucket-nyckel (från
   * parseBetfairLineRowsMap). När satt blandas Betfairs börs-linjer in i totals-/
   * AH-fair-price via likviditetsfiltret (vikt 0.8/0.85). Order-oberoende.
   */
  betfairLines?: Map<string, BetfairMarket[]>;
  /**
   * SBOBET 1X2-marknader per team-bucket-nyckel (från parseSbobetRowsMap).
   * När satt läggs SBOBET in som andra SKARP källa (no-vig, ej börs). SBO
   * korrelerar med IBC/ISN — consensus räknar ned korrelerade källor.
   */
  sbobet?: Map<string, SbobetMarket>;
  /**
   * SBOBET AH-marknader (flera linjer = en stege) per team-bucket-nyckel (från
   * parseSbobetAhRowsMap). När satt blandas SBOBET in som skarpt komplement i
   * AH-fair-price (SBOBET är marknadsledande på asiatiskt handikapp, vikt 0.95).
   */
  sbobetAh?: Map<string, SbobetMarket[]>;
  /**
   * Pinnacle totals-/AH-stegar per eventId (från parsePinnacleLineLadders).
   * När satt utvärderas candidatens totals-/AH-erbjudanden mot Pinnacles
   * skarpa linjesteg via line-matching (exact → quarter → interpolated).
   */
  pinnacleLines?: Map<string, PinnacleLineLadders>;
}

/**
 * Kör shadow-utvärdering: matcha varje candidate mot Pinnacle, bygg Betfair-
 * mock, kör evaluateMarket per selection, samla ClvOpenEntry. Pure (ingen IO).
 */
export function runShadow(input: ShadowRunInput): ShadowRunResult {
  const shadowMode = input.shadowMode !== false;
  const now = input.now ?? Date.now();

  // Indexera Pinnacle på event-key (prova ±1 bucket vid uppslag).
  const pinIndex = new Map<string, PinnacleEvent>();
  for (const p of input.pinnacle) {
    const k = eventKey(p.identity.homeTeam, p.identity.awayTeam, p.identity.startTime);
    if (k) pinIndex.set(k, p);
  }
  const lookupPin = (c: CandidateEvent): { pin: PinnacleEvent; swapped: boolean } | undefined => {
    const bucket = startTimeBucket(c.identity.startTime);
    if (bucket === null) return undefined;
    const h = normalizeTeamName(c.identity.homeTeam);
    const a = normalizeTeamName(c.identity.awayTeam);
    // Exakt ordning prioriteras (skyddar mot ev. separat retur-/hemma-borta-match).
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = pinIndex.get(`${h}::${a}::${b}`);
      if (hit) return { pin: hit, swapped: false };
    }
    // Kastad ordning: lagen matchar omvänt → candidate måste reorienteras.
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = pinIndex.get(`${a}::${h}::${b}`);
      if (hit) return { pin: hit, swapped: true };
    }
    return undefined;
  };

  // SBOBET-uppslag (samma ±1 bucket-tolerans). Nyckeln byggdes med eventKey.
  const lookupSbobet = (pin: PinnacleEvent): { market: SbobetMarket; swapped: boolean } | undefined => {
    if (!input.sbobet) return undefined;
    const bucket = startTimeBucket(pin.identity.startTime);
    if (bucket === null) return undefined;
    const h = normalizeTeamName(pin.identity.homeTeam);
    const a = normalizeTeamName(pin.identity.awayTeam);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.sbobet.get(`${h}::${a}::${b}`);
      if (hit) return { market: hit, swapped: false };
    }
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.sbobet.get(`${a}::${h}::${b}`);
      if (hit) return { market: hit, swapped: true };
    }
    return undefined;
  };

  // Betfair-uppslag (samma ±1 bucket-tolerans + order-oberoende). Nyckeln byggdes
  // med eventKey i parseBetfairRowsMap/buildMockBetfairMap.
  const lookupBetfair = (pin: PinnacleEvent): { market: BetfairMarket; swapped: boolean } | undefined => {
    if (!input.betfairMarkets) return undefined;
    const bucket = startTimeBucket(pin.identity.startTime);
    if (bucket === null) return undefined;
    const h = normalizeTeamName(pin.identity.homeTeam);
    const a = normalizeTeamName(pin.identity.awayTeam);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.betfairMarkets.get(`${h}::${a}::${b}`);
      if (hit) return { market: hit, swapped: false };
    }
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.betfairMarkets.get(`${a}::${h}::${b}`);
      if (hit) return { market: hit, swapped: true };
    }
    return undefined;
  };

  // Betfair TOTALS+AH-linjer (samma nyckel/tolerans + order-oberoende).
  const lookupBetfairLines = (pin: PinnacleEvent): { markets: BetfairMarket[]; swapped: boolean } | undefined => {
    if (!input.betfairLines) return undefined;
    const bucket = startTimeBucket(pin.identity.startTime);
    if (bucket === null) return undefined;
    const h = normalizeTeamName(pin.identity.homeTeam);
    const a = normalizeTeamName(pin.identity.awayTeam);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.betfairLines.get(`${h}::${a}::${b}`);
      if (hit) return { markets: hit, swapped: false };
    }
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.betfairLines.get(`${a}::${h}::${b}`);
      if (hit) return { markets: hit, swapped: true };
    }
    return undefined;
  };

  // SBOBET AH-stegar (samma nyckel/tolerans). Marknadsledande på asiatiskt
  // handikapp → blandas in i AH-fair-price som skarpt komplement.
  const lookupSbobetAh = (pin: PinnacleEvent): { markets: SbobetMarket[]; swapped: boolean } | undefined => {
    if (!input.sbobetAh) return undefined;
    const bucket = startTimeBucket(pin.identity.startTime);
    if (bucket === null) return undefined;
    const h = normalizeTeamName(pin.identity.homeTeam);
    const a = normalizeTeamName(pin.identity.awayTeam);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.sbobetAh.get(`${h}::${a}::${b}`);
      if (hit) return { markets: hit, swapped: false };
    }
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const hit = input.sbobetAh.get(`${a}::${h}::${b}`);
      if (hit) return { markets: hit, swapped: true };
    }
    return undefined;
  };

  const entries: ClvOpenEntry[] = [];
  const skipped: SkippedRecord[] = [];
  const byDecision: Record<string, number> = {};
  const bySkipReason: Record<string, number> = {};
  let matched = 0;

  const skip = (reason: SkipReason, c: CandidateEvent) => {
    skipped.push({ reason, homeTeam: c.identity.homeTeam, awayTeam: c.identity.awayTeam, startTime: c.identity.startTime, bookmaker: c.bookmaker });
    bySkipReason[reason] = (bySkipReason[reason] ?? 0) + 1;
  };

  for (const c0 of input.candidates) {
    const match = lookupPin(c0);
    if (!match) { skip("NO_PINNACLE_MATCH", c0); continue; }
    matched++;
    const pin = match.pin;
    // Reorientera candidaten till Pinnacles hemma/borta om lagen matchade kastat
    // → all jämförelse nedan sker i SAMMA orientering (samma alternativ).
    const c = match.swapped ? swapCandidateOrientation(c0) : c0;

    const tier = deriveTier(pin.identity.league);
    const ttsBucket = ttsBucketFrom(pin.identity.startTime, now);
    const bfHit = lookupBetfair(pin);
    const betfairMarket = bfHit?.market ?? null;
    const betfairSwapped = bfHit?.swapped ?? false;
    const sboHit = lookupSbobet(pin);
    const sbobetMarket = sboHit?.market ?? null;
    const sbobetSwapped = sboHit?.swapped ?? false;

    for (const sel of SELECTIONS) {
      const candOdds = c.odds[sel];
      if (!Number.isFinite(candOdds) || candOdds <= 1) { skip("INVALID_CANDIDATE_ODDS", c); continue; }

      const context: MarketContext = {
        sport: "football", market: "ML_1X2", tier, phase: "prematch", ttsBucket,
        line: null, selection: sel as Selection,
        eventId: pin.identity.eventId, league: pin.identity.league,
        startTime: pin.identity.startTime,
        homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam,
      };

      const sources = [{ sourceId: "pinnacle", fairProb: pin.fairProb[sel] }];
      let sourceMeta: Record<string, unknown> | undefined;
      if (betfairMarket) {
        // Betfair kan lista lagen kastat mot Pinnacle → fråga motsatt utfall så vi
        // jämför SAMMA lag (Pinnacle-HOME = Betfair-AWAY när swappad).
        const bfSel = (betfairSwapped ? OPP_SELECTION[sel as Selection] : (sel as Selection));
        const bf = betfairMoneylineQuote(betfairMarket, bfSel);
        sources.push(bf.quote);
        sourceMeta = { ...sourceMeta, betfair: bf.snapshot };
      }
      if (sbobetMarket) {
        // SBOBET kan lista lagen kastat mot Pinnacle → fråga motsatt utfall så vi
        // jämför SAMMA lag (Pinnacle-HOME = SBOBET-AWAY när swappad).
        const sboSel = (sbobetSwapped ? OPP_SELECTION[sel as Selection] : (sel as Selection));
        const sbo = sbobetMoneylineQuote(sbobetMarket, sboSel);
        if (sbo.lineComparable) {
          sources.push(sbo);
          sourceMeta = { ...sourceMeta, sbobet: { oddsId: sbobetMarket.oddsId, fairProb: sbo.fairProb, rawOdds: sbo.rawOdds } };
        }
      }

      const out = evaluateMarket({
        context,
        candidate: { bookmaker: c.bookmaker, odds: candOdds },
        sources,
        shadowMode,
        clvMultipliers: input.clvMultipliers,
      });

      const entry = buildClvEntry(out, { sourceMeta });
      entries.push(entry);
      byDecision[entry.decision] = (byDecision[entry.decision] ?? 0) + 1;
    }

    // ── Totals (O/U) + Asian Handicap: prissätt candidatens linje-erbjudanden
    // mot Pinnacles skarpa stege (line-matching). Bara linjer Pinnacle täcker
    // (exact/quarter/interpolated) utvärderas — övriga hoppas tyst.
    const pinLines = input.pinnacleLines?.get(pin.identity.eventId) ?? null;
    const sboAhHit = lookupSbobetAh(pin);
    // Reorientera SBOBET:s AH-stege till Pinnacle-orientering om lagen är kastade
    // (negera linjer + byt home/away) → linje-matchning sker mot samma sida.
    const sbobetAhMarkets = sboAhHit
      ? (sboAhHit.swapped ? swapSbobetAhOrientation(sboAhHit.markets) : sboAhHit.markets)
      : null;
    // Betfair börs-linjer (TOTALS+AH), reorienterade till Pinnacle om lagen kastade.
    const bfLinesHit = lookupBetfairLines(pin);
    const betfairLineMarkets = bfLinesHit
      ? (bfLinesHit.swapped ? swapBetfairLineOrientation(bfLinesHit.markets) : bfLinesHit.markets)
      : null;
    const betfairTotalsMarkets = betfairLineMarkets?.filter((m) => m.marketType === "TOTALS") ?? null;
    const betfairAhMarkets = betfairLineMarkets?.filter((m) => m.marketType === "AH") ?? null;
    if (pinLines) {
      const evalLine = (
        market: "TOTAL" | "AH",
        scope: string,
        line: number,
        selection: Selection,
        candOdds: number,
        ladder: SourceLadder,
      ) => {
        if (!Number.isFinite(candOdds) || candOdds <= 1) return;
        const q = lineMatchedQuote({ marketType: market, scope, line, selection }, ladder);
        if (!q.lineComparable) return; // ingen jämförbar Pinnacle-linje → hoppa
        const sources = [q];
        // AH: blanda in SBOBET-stegen (skarpt komplement) om linjen är jämförbar.
        // PINNACLE_ANCHOR-blandningen håller Pinnacle dominant; SBOBET (vikt 0.95)
        // nudgar fair price där den är skarpast.
        if (market === "AH" && sbobetAhMarkets) {
          const sq = sbobetAhQuote({ marketType: "AH", scope, line, selection }, sbobetAhMarkets).quote;
          if (sq.lineComparable) sources.push(sq);
        }
        // Betfair-börsen (likviditetsvägd) blandas in på BÅDE totals och AH där den
        // är jämförbar — håller Pinnacle dominant men nudgar fair price där börsen
        // är skarpast (tjock bok). Illikvid/omatchad linje → lineComparable false.
        if (market === "TOTAL" && betfairTotalsMarkets && betfairTotalsMarkets.length) {
          const bq = betfairTotalsQuote({ marketType: "TOTAL", scope, line, selection }, betfairTotalsMarkets).quote;
          if (bq.lineComparable) sources.push(bq);
        }
        if (market === "AH" && betfairAhMarkets && betfairAhMarkets.length) {
          const bq = betfairAhQuote({ marketType: "AH", scope, line, selection }, betfairAhMarkets).quote;
          if (bq.lineComparable) sources.push(bq);
        }
        const ctx: MarketContext = {
          sport: "football", market, tier, phase: "prematch", ttsBucket,
          line, selection,
          eventId: pin.identity.eventId, league: pin.identity.league,
          startTime: pin.identity.startTime,
          homeTeam: pin.identity.homeTeam, awayTeam: pin.identity.awayTeam,
        };
        const out = evaluateMarket({
          context: ctx,
          candidate: { bookmaker: c.bookmaker, odds: candOdds },
          sources,
          shadowMode,
          clvMultipliers: input.clvMultipliers,
        });
        const e = buildClvEntry(out, { sourceMeta: { pinnacleLineMatch: q.lineMatch.lineMatchType } });
        entries.push(e);
        byDecision[e.decision] = (byDecision[e.decision] ?? 0) + 1;
      };

      for (const t of c.totals ?? []) {
        evalLine("TOTAL", "match_total", t.line, "OVER", t.over, pinLines.totals);
        evalLine("TOTAL", "match_total", t.line, "UNDER", t.under, pinLines.totals);
      }
      for (const a of c.ah ?? []) {
        evalLine("AH", "full", a.line, "HOME", a.home, pinLines.ah);
        evalLine("AH", "full", a.line, "AWAY", a.away, pinLines.ah);
      }
    }
  }

  return {
    entries,
    skipped,
    stats: { candidates: input.candidates.length, matched, decisions: entries.length, byDecision, bySkipReason },
  };
}
