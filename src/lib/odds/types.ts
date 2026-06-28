/**
 * Generella odds-typer för cross-book-jämförelse. Alla bookmaker-adapters
 * normaliserar sin källdata till `NormalizedOdds[]` så att resten av
 * pipelinen (matching, edge, snapshots, UI) är bookmaker-agnostisk.
 *
 * Säkerhetsregel: adapters som hämtar från en kommersiell API ska köras
 * server-side (Render backend, GitHub Actions, eller cron) — aldrig direkt
 * client-side. Frontend läser endast cachad data via /data/-filer eller
 * /api/odds/<bookmaker>-endpoints.
 *
 * Version 1: bara football prematch. Sport-fältet är förberedt för
 * basketball/tennis etc. men adapter-implementationerna ignorerar andra
 * sporter tills vidare.
 */

export type Sport = "football";

export type MarketType =
  /** 1 / X / 2 (moneyline). */
  | "1X2"
  /** Over/Under på totalmål (line = totalmål-gräns, t.ex. 2.5). */
  | "OVER_UNDER"
  /** Asian Handicap (line = handicap för home, t.ex. -0.25). */
  | "ASIAN_HANDICAP"
  /** Both Teams To Score (yes/no, ingen line). */
  | "BTTS";

export type Selection =
  | "HOME"
  | "DRAW"
  | "AWAY"
  | "OVER"
  | "UNDER"
  | "YES"
  | "NO";

/**
 * Ett enskilt odds-erbjudande från en bookmaker, normaliserat.
 * En match kan generera flera NormalizedOdds (en per market × selection).
 *
 * Exempel — Liverpool–Chelsea 1X2:
 *   { market: "1X2", selection: "HOME", odds: 2.10, line: undefined, ... }
 *   { market: "1X2", selection: "DRAW", odds: 3.50, line: undefined, ... }
 *   { market: "1X2", selection: "AWAY", odds: 3.40, line: undefined, ... }
 */
export interface NormalizedOdds {
  /** Bookmaker-id i lowercase, t.ex. "pinnacle" eller "bet365". */
  bookmaker: string;
  sport: Sport;
  league?: string;
  homeTeam: string;
  awayTeam: string;
  /** Kickoff, ISO 8601 med Z-suffix. */
  startTime: string;
  market: MarketType;
  /** Required för OVER_UNDER + ASIAN_HANDICAP. Undefined annars. */
  line?: number;
  selection: Selection;
  /** Decimal odds, > 1. */
  odds: number;
  /** När adaptern snapshotade detta odds (ISO). */
  timestamp: string;
  /** Provider-intern event-id om båda providers råkar dela ID-system (sällan). */
  providerEventId?: string;
}

/**
 * Bookmaker-adapter-interface. Varje adapter:
 *   - läser från sin källa (provider-API, JSON-cache, fixture)
 *   - normaliserar till NormalizedOdds[]
 *   - rapporterar källa och färskhet
 */
export interface BookmakerAdapter {
  /** Stabil id, används i NormalizedOdds.bookmaker och matching-keys. */
  readonly id: string;
  /** Visningsnamn för UI. */
  readonly displayName: string;
  /** Hämtar samtliga odds adaptern känner till just nu. */
  fetchOdds(): Promise<NormalizedOdds[]>;
  /** Metadata om senaste hämtning — visas som "data X sek gammal" i UI. */
  getSnapshotMeta(): Promise<SnapshotMeta>;
}

export interface SnapshotMeta {
  /** "mock" | "cache" | "live-provider" — så vi vet om det är riktig data. */
  source: "mock" | "cache" | "live-provider" | "empty";
  /** ISO timestamp för senaste lyckade hämtning, null om aldrig. */
  updatedAt: string | null;
  /** Optional: hur många events / odds adaptern returnerade senast. */
  oddsCount?: number;
}

/**
 * Resultat av matching mellan två adapters (typiskt Pinnacle vs Bet365).
 * En MatchedOpportunity = exakt samma (event, market, line, selection)
 * fanns i båda källorna, med Pinnacle som fair-value-referens.
 */
export interface MatchedOpportunity {
  /** Stabil key: normalizedHome::normalizedAway::startBucket::market::line::selection */
  matchKey: string;
  /** Pinnacle-erbjudandet (fair-value-källa). */
  reference: NormalizedOdds;
  /** Bet365- eller annan motpart. */
  candidate: NormalizedOdds;
  /** Pinnacle implied probability (med vig). */
  referenceImpliedProb: number;
  /** Pinnacle no-vig fair probability (vi delar med marknadens overround). */
  referenceFairProb: number;
  /** Edge = candidate.odds × referenceFairProb − 1. */
  edge: number;
  /** Edge i procent (×100). */
  edgePct: number;
  /** True om edgePct > VALUE_EDGE_THRESHOLD_PCT. */
  isValue: boolean;
  /** När matchningen utfördes (ISO). */
  matchedAt: string;
}

/** Edge ≥ 2 % = value, samma tröskel som ValueBets-pipelinen. */
export const VALUE_EDGE_THRESHOLD_PCT = 2;

/** Time-tolerans för "samma event" — 1 h ger marginal mot timezone-fel. */
export const SAME_EVENT_TIME_TOLERANCE_MS = 60 * 60 * 1000;
