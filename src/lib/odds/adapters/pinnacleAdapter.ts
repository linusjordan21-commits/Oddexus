/**
 * PinnacleAdapter — wrappar befintlig Pinnacle-pipeline.
 *
 * Befintlig Pinnacle-data ligger i `data/pinnacle-rows.json` (committad av
 * GitHub Actions). Filen har strukturen:
 *   { bySport: { soccer: { matchups: [...], markets: [...] } }, updatedAt }
 *
 * Vi översätter detta till `NormalizedOdds[]` utan att röra befintliga
 * filer eller scraping. PinnacleAdapter är read-only.
 *
 * Var den körs:
 *   - Node-script (test-script, GitHub Actions): läs JSON direkt från disk
 *   - Browser/SSR (senare): läs via fetch("/data/pinnacle-rows.json")
 *
 * För att hålla adaptern miljö-neutral injicerar caller en loader-funktion.
 */

import type {
  BookmakerAdapter,
  MarketType,
  NormalizedOdds,
  Selection,
  SnapshotMeta,
} from "../types.ts";

/** Pinnacle:s JSON-format för matchup + markets. */
interface PinnacleMatchup {
  id: number | string;
  startTime: string;
  league?: { name?: string };
  participants?: Array<{ alignment?: string; name?: string }>;
}

interface PinnaclePrice {
  designation?: string;
  points?: number;
  /** Pinnacle använder primärt American odds: +250 / -125 etc. */
  price?: number | string;
  /** Vissa endpoints exponerar även decimal direkt — vi accepterar båda. */
  decimal?: number | string;
}

/**
 * Konvertera American odds → decimal. Pinnacle API returnerar `price` i
 * American format:
 *   +250 → 3.50  (positive: decimal = price/100 + 1)
 *   -150 → 1.667 (negative: decimal = 100/|price| + 1)
 *
 * Returnerar null vid ogiltigt värde. Vi accepterar också direktdecimal
 * (>= 1.01) som fallback om endpoint exposar decimal direkt.
 */
function pinnaclePriceToDecimal(price: PinnaclePrice): number | null {
  // Föredra explicit decimal om det finns och är giltigt.
  if (price.decimal != null) {
    const d = Number(price.decimal);
    if (Number.isFinite(d) && d > 1) return d;
  }
  if (price.price == null) return null;
  const american = Number(price.price);
  if (!Number.isFinite(american)) return null;
  if (american > 0) return american / 100 + 1;
  if (american < 0) return 100 / Math.abs(american) + 1;
  return null;
}

interface PinnacleMarket {
  matchupId: number | string;
  /** "moneyline" | "spread" | "total" — Pinnacle:s egna nyckelord. */
  type?: string;
  /** Optionellt: "all" | "match" — period-mässigt. Vi tar bara "match"/"all". */
  period?: number | string;
  prices?: PinnaclePrice[];
}

interface PinnaclePayload {
  updatedAt?: string;
  bySport?: {
    soccer?: {
      matchups?: PinnacleMatchup[];
      markets?: PinnacleMarket[];
    };
  };
}

/** Loader-funktion = caller injicerar hur JSON läses (Node vs browser). */
export type PinnacleLoader = () => Promise<PinnaclePayload | null>;

/** Default Node-loader. Importera fs+path lazy så browser-bundle inte bryts. */
async function defaultNodeLoader(): Promise<PinnaclePayload | null> {
  try {
    // Lazy-import så filen kan importeras i browser utan att fs evalueras.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(process.cwd(), "data", "pinnacle-rows.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    console.warn("[pinnacle-adapter] node-loader failed:", error);
    return null;
  }
}

/** Översätt Pinnacle "designation" → vår Selection-typ. */
function designationToSelection(d: string | undefined, marketType: MarketType): Selection | null {
  const norm = (d ?? "").toLowerCase().trim();
  if (marketType === "1X2") {
    if (norm === "home") return "HOME";
    if (norm === "away") return "AWAY";
    if (norm === "draw") return "DRAW";
  }
  if (marketType === "OVER_UNDER") {
    if (norm === "over") return "OVER";
    if (norm === "under") return "UNDER";
  }
  if (marketType === "ASIAN_HANDICAP") {
    if (norm === "home") return "HOME";
    if (norm === "away") return "AWAY";
  }
  return null;
}

/** Pinnacle market.type → vår MarketType. Pinnacle har ingen native BTTS. */
function mapPinnacleMarketType(t: string | undefined): MarketType | null {
  const norm = (t ?? "").toLowerCase().trim();
  if (norm === "moneyline") return "1X2";
  if (norm === "total") return "OVER_UNDER";
  if (norm === "spread") return "ASIAN_HANDICAP";
  return null;
}

/** Plocka home/away från participants-array (sorterad efter alignment). */
function extractTeams(matchup: PinnacleMatchup): { home: string; away: string } | null {
  const parts = matchup.participants ?? [];
  const home = parts.find((p) => (p.alignment ?? "").toLowerCase() === "home")?.name;
  const away = parts.find((p) => (p.alignment ?? "").toLowerCase() === "away")?.name;
  if (!home || !away) return null;
  return { home, away };
}

/**
 * Konvertera Pinnacle payload → NormalizedOdds[].
 *
 * Algoritm:
 *   1. Bygg matchup-map (id → {teams, startTime, league})
 *   2. Iterera markets, mappa typ + selection, skapa NormalizedOdds-rader
 *   3. Skip period ≠ 0/"all" (vi vill bara full-time markets)
 */
export function pinnaclePayloadToNormalizedOdds(payload: PinnaclePayload): NormalizedOdds[] {
  const soccer = payload?.bySport?.soccer;
  if (!soccer) return [];
  const matchups = soccer.matchups ?? [];
  const markets = soccer.markets ?? [];

  const matchupById = new Map<string, PinnacleMatchup>();
  for (const m of matchups) {
    matchupById.set(String(m.id), m);
  }

  const now = new Date().toISOString();
  const out: NormalizedOdds[] = [];

  for (const market of markets) {
    // Pinnacle returnerar markets för olika perioder (full time, halftime).
    // period=0 eller "match" är full time — vi tar bara dessa.
    const period = String(market.period ?? "0");
    if (period !== "0" && period !== "match" && period !== "all") continue;

    const marketType = mapPinnacleMarketType(market.type);
    if (!marketType) continue;

    const matchup = matchupById.get(String(market.matchupId));
    if (!matchup) continue;
    const teams = extractTeams(matchup);
    if (!teams) continue;

    for (const price of market.prices ?? []) {
      const decimal = pinnaclePriceToDecimal(price);
      if (decimal == null || decimal <= 1) continue;
      const selection = designationToSelection(price.designation, marketType);
      if (!selection) continue;

      out.push({
        bookmaker: "pinnacle",
        sport: "football",
        league: matchup.league?.name,
        homeTeam: teams.home,
        awayTeam: teams.away,
        startTime: matchup.startTime,
        market: marketType,
        line: typeof price.points === "number" ? price.points : undefined,
        selection,
        odds: decimal,
        timestamp: now,
        providerEventId: String(matchup.id),
      });
    }
  }

  return out;
}

/**
 * Skapar en PinnacleAdapter med valfri loader (default: Node-disk).
 * I browser-miljö, skicka in en loader som fetchar `/data/pinnacle-rows.json`.
 */
export function createPinnacleAdapter(loader: PinnacleLoader = defaultNodeLoader): BookmakerAdapter {
  let lastMeta: SnapshotMeta = { source: "empty", updatedAt: null };

  return {
    id: "pinnacle",
    displayName: "Pinnacle",

    async fetchOdds(): Promise<NormalizedOdds[]> {
      const payload = await loader();
      if (!payload) {
        lastMeta = { source: "empty", updatedAt: null };
        return [];
      }
      const odds = pinnaclePayloadToNormalizedOdds(payload);
      lastMeta = {
        source: "cache", // Pinnacle är alltid cachad via GitHub Actions
        updatedAt: payload.updatedAt ?? null,
        oddsCount: odds.length,
      };
      return odds;
    },

    async getSnapshotMeta(): Promise<SnapshotMeta> {
      return lastMeta;
    },
  };
}
