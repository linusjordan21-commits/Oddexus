/**
 * marketKey.ts — KANONISK, STABIL marknadsidentitet (`market_key`).
 *
 * Hela tracking-/learning-systemet (signals, snapshots, observations, movement
 * events, decisions, outcomes) länkas via market_key. Om två rader får SAMMA
 * market_key behandlas de som samma marknad — därför måste nyckeln skilja på allt
 * som faktiskt är olika marknader (se marketMismatchRisk + testerna i
 * marketKey.test.ts). Felmatchning här = falska valuebets, så detta är medvetet
 * strikt.
 *
 * Format (pipe-separerat, fält normaliserade):
 *   sport | league | matchRef | marketType | period | line | selection
 * där matchRef = eventId om det finns, annars `home~away~startBucket`.
 *
 * Återanvänder team-/tidsnormaliseringen från odds/matching.ts (single source).
 */

import { normalizeTeamName, startTimeBucket } from "../odds/matching.ts";

export type Sport = "football" | "basketball" | "tennis" | (string & {});

/** Kanoniska marknadstyper. Olika typer ger ALDRIG samma key. */
export type MarketType =
  | "1x2" // 3-vägs match-odds (fotboll)
  | "moneyline" // 2-vägs match-odds (basket/tennis)
  | "dnb" // draw-no-bet
  | "ah" // asian handicap
  | "eh3" // europeisk 3-vägs handicap
  | "total" // mål over/under (heltal/halvlinje)
  | "asian_total" // asiatisk total (kvartslinjer 2.25/2.75)
  | "team_total" // lag-total
  | "corner_total" // hörn over/under
  | "corner_ah" // hörn-handicap
  | "btts" // both teams to score
  | (string & {});

/** Period — full tid vs halvlek. ft och fh ger ALDRIG samma key. */
export type Period = "ft" | "fh" | "sh" | (string & {});

export type Selection =
  | "HOME"
  | "DRAW"
  | "AWAY"
  | "OVER"
  | "UNDER"
  | "YES"
  | "NO"
  | (string & {});

export interface MarketKeyParts {
  sport: Sport;
  league?: string | null;
  eventId?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  startTime?: string | null; // ISO
  marketType: MarketType;
  period?: Period;
  line?: number | null; // null för 1x2/moneyline/dnb/btts
  selection?: Selection | null;
}

/**
 * Sport-normalisering: aliasar "soccer"/"fotboll" → "football" så att SAMMA sport
 * aldrig får två market_key-prefix. (Live-1X2-vägen utelämnar `sport` → defaultar
 * "football"; totals/AH-motorerna hårdkodar "soccer" → annars splittras samma match
 * på `football|…` och `soccer|…`.) Andra sporter (tennis/basketball) passerar
 * oförändrade. Lowercased, trimmad, idempotent. Påverkar INGEN prissättning.
 */
export function normalizeSport(raw?: string | null): string {
  const s = (raw ?? "").toLowerCase().trim();
  if (s === "soccer" || s === "fotboll") return "football";
  return s;
}

/** Liga-normalisering: lowercase, strip diakritiker, kollapsa whitespace. */
export function normalizeLeague(name?: string | null): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mappa råa marknadssträngar (från olika motorer/böcker) till kanonisk MarketType.
 * Konservativ: okänt → returneras lowercased oförändrat (så det aldrig tyst
 * slås ihop med en känd typ).
 */
export function canonicalMarketType(raw: string): MarketType {
  const m = raw.toLowerCase().trim();
  switch (m) {
    case "1x2":
    case "ml_1x2":
    case "match_odds":
      return "1x2";
    case "moneyline":
    case "ml":
    case "ml_2way":
      return "moneyline";
    case "dnb":
    case "draw_no_bet":
      return "dnb";
    case "ah":
    case "asian_handicap":
    case "spread":
      return "ah";
    case "eh3":
    case "european_handicap":
      return "eh3";
    case "total":
    case "totals":
    case "over_under":
    case "ou":
      return "total";
    case "asian_total":
    case "asian_totals":
      return "asian_total";
    case "team_total":
      return "team_total";
    case "corner_total":
    case "corners_total":
    case "corner_totals":
      return "corner_total";
    case "corner_ah":
    case "corners_ah":
      return "corner_ah";
    case "btts":
    case "both_teams_to_score":
      return "btts";
    default:
      return m;
  }
}

/** Linjer normaliseras till 2 decimaler (så 2.5 och 2.50 är samma, 2.25 ≠ 2.5). */
function normalizeLine(line?: number | null): string {
  if (line == null || !Number.isFinite(line)) return "-";
  return line.toFixed(2);
}

/**
 * Matchreferens: eventId om det finns (stabilast), annars
 * normaliserade lagnamn + 30-min start-bucket. Olika starttider → olika bucket
 * → olika key (skyddar mot att fel match slås ihop).
 */
export function matchRef(parts: MarketKeyParts): string {
  if (parts.eventId) return `e:${String(parts.eventId).trim()}`;
  const home = normalizeTeamName(parts.homeTeam ?? "");
  const away = normalizeTeamName(parts.awayTeam ?? "");
  const bucket = parts.startTime ? startTimeBucket(parts.startTime) : null;
  return `t:${home}~${away}~${bucket ?? "-"}`;
}

/** Bygg den stabila market_key:n. */
export function buildMarketKey(parts: MarketKeyParts): string {
  const sport = normalizeSport(parts.sport);
  const league = normalizeLeague(parts.league);
  const ref = matchRef(parts);
  const mt = canonicalMarketType(parts.marketType);
  const period = (parts.period ?? "ft").toLowerCase().trim();
  const line = normalizeLine(parts.line);
  const sel = (parts.selection ?? "-").toString().toUpperCase().trim();
  return [sport, league, ref, mt, period, line, sel].join("|");
}

export interface ParsedMarketKey {
  sport: string;
  league: string;
  matchRef: string;
  marketType: string;
  period: string;
  line: string;
  selection: string;
}

/** Best-effort parse tillbaka till delar (för debugging/UI). */
export function parseMarketKey(key: string): ParsedMarketKey | null {
  const p = key.split("|");
  if (p.length !== 7) return null;
  return { sport: p[0], league: p[1], matchRef: p[2], marketType: p[3], period: p[4], line: p[5], selection: p[6] };
}

/**
 * marketMismatchRisk — bedöm risken att två "matchningar" egentligen är OLIKA
 * marknader (innan vi behandlar dem som samma). Returnerar en lista med
 * risk-koder; tom lista = ingen detekterad risk. Används både i QA-tester och i
 * fas-1-pipelinen för att skapa market_mismatch_warnings istället för
 * självsäkra valuebets.
 */
export type MarketMismatchCode =
  | "MARKET_TYPE_DIFF"
  | "PERIOD_DIFF"
  | "LINE_DIFF"
  | "ASIAN_VS_DECIMAL_TOTAL"
  | "SELECTION_SIDE_DIFF"
  | "TEAMS_DIFF"
  | "START_TIME_DIFF"
  | "DNB_VS_ML";

export function marketMismatchRisk(a: MarketKeyParts, b: MarketKeyParts): MarketMismatchCode[] {
  const codes: MarketMismatchCode[] = [];
  const at = canonicalMarketType(a.marketType);
  const bt = canonicalMarketType(b.marketType);

  if (at !== bt) {
    codes.push("MARKET_TYPE_DIFF");
    // Särskilt lömska par värda egna koder:
    if ((at === "dnb" && bt === "moneyline") || (at === "moneyline" && bt === "dnb")) codes.push("DNB_VS_ML");
    if ((at === "total" && bt === "asian_total") || (at === "asian_total" && bt === "total")) codes.push("ASIAN_VS_DECIMAL_TOTAL");
  }

  if ((a.period ?? "ft") !== (b.period ?? "ft")) codes.push("PERIOD_DIFF");

  if (normalizeLine(a.line) !== normalizeLine(b.line)) codes.push("LINE_DIFF");

  const aSel = (a.selection ?? "").toString().toUpperCase();
  const bSel = (b.selection ?? "").toString().toUpperCase();
  if (aSel && bSel && aSel !== bSel) codes.push("SELECTION_SIDE_DIFF");

  // Lag-kontroll: om eventId saknas, jämför normaliserade lagnamn.
  if (!a.eventId || !b.eventId) {
    const ah = normalizeTeamName(a.homeTeam ?? "");
    const aa = normalizeTeamName(a.awayTeam ?? "");
    const bh = normalizeTeamName(b.homeTeam ?? "");
    const ba = normalizeTeamName(b.awayTeam ?? "");
    if (ah && bh && !(ah === bh && aa === ba)) codes.push("TEAMS_DIFF");
  } else if (String(a.eventId) !== String(b.eventId)) {
    codes.push("TEAMS_DIFF");
  }

  // Starttid: >1h isär = sannolikt olika matcher.
  if (a.startTime && b.startTime) {
    const ma = Date.parse(a.startTime);
    const mb = Date.parse(b.startTime);
    if (Number.isFinite(ma) && Number.isFinite(mb) && Math.abs(ma - mb) > 60 * 60 * 1000) codes.push("START_TIME_DIFF");
  }

  return Array.from(new Set(codes));
}
