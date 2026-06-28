/**
 * GET /api/bonus-finder/:bookmaker — admin-only bonus-finder-endpoint.
 *
 * Använder samma odds-index som /api/valuebets för att slippa duplicerad
 * scraping. Pinnacle-odds berikar varje match som referensmarknad.
 *
 * Säkerhet: admin-only via ctx.isAdminUsername (samma pattern som
 * /api/admin/storage/health). Vanliga kunder får 403.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getBonusOpportunities,
  resolveBonusBookmakerSlug,
  type BonusFinderInput,
  type MatchData,
  type OddsRowWithBookmaker,
  type OddsTriple,
} from "./bonusFinder";
import { getAppUserByUsername } from "./appUsers";

export type BonusFinderApiContext = {
  isAdminUsername: (username: string) => boolean;
  getAuthUsername: (req: IncomingMessage) => string | null;
  /** Loadar matcher med aggregerade odds (samma source som valuebets). */
  loadMatches: (hoursWindow: number) => Promise<MatchData[]>;
};

const PATH_PREFIX = "/api/bonus-finder/";

function parseQuery(req: IncomingMessage): URLSearchParams {
  const queryString = req.url?.split("?")[1] ?? "";
  return new URLSearchParams(queryString);
}

function parseNumber(p: URLSearchParams, key: string, def: number, min?: number, max?: number): number {
  const raw = Number(p.get(key));
  if (!Number.isFinite(raw)) return def;
  let v = raw;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

export async function bonusFinderApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  ctx: BonusFinderApiContext,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "";
  if (!url.startsWith(PATH_PREFIX)) {
    next();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }

  // Admin ELLER kund med per-användare-behörigheten `bonusFinder` (sätts i
  // /admin/users). Defense-in-depth utöver bonusFinderAccessMiddleware.
  const user = ctx.getAuthUsername(req);
  const appUser = user ? getAppUserByUsername(user) : null;
  const allowed = !!user && (ctx.isAdminUsername(user) || appUser?.bonusFinder === true);
  if (!allowed) {
    res.statusCode = 403;
    res.end(JSON.stringify({ ok: false, error: "Bonus finder access required" }));
    return;
  }

  const slug = url.slice(PATH_PREFIX.length).trim().replace(/\/+$/, "");
  if (!slug) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "bookmaker slug missing in URL" }));
    return;
  }

  const resolved = resolveBonusBookmakerSlug(slug);
  if (!resolved) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: `unknown bookmaker slug: ${slug}` }));
    return;
  }

  const params = parseQuery(req);
  const hoursAhead = parseNumber(params, "hours", 48, 6, 168);
  const stake = parseNumber(params, "stake", 500, 1, 100_000);
  const minOdds = parseNumber(params, "minOdds", 1.5, 1.01, 100);
  const maxOdds = parseNumber(params, "maxOdds", 100, 1.01, 1000);
  const limit = parseNumber(params, "limit", 20, 1, 200);
  const sport = params.get("sport") ?? undefined;
  const excludeRaw = params.get("exclude") ?? "";
  const excludeBookmakerIds = excludeRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // covers=a,b,c — begränsa täckningen (hedge-poolen) till valda bookmakers.
  // Tom/saknas = alla (default best-odds).
  const coversRaw = params.get("covers") ?? "";
  const includeCoverBookmakerIds = coversRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  try {
    const matches = await ctx.loadMatches(hoursAhead);
    const input: BonusFinderInput = {
      bonusBookmakerId: resolved.id,
      bonusBookmakerName: resolved.name,
      stake,
      minOdds,
      maxOdds,
      hoursAhead,
      sport,
      excludeBookmakerIds,
      includeCoverBookmakerIds,
      limit,
    };
    const result = getBonusOpportunities(matches, input);

    // Räkna hur många matcher som har odds från varje svensk bookmaker.
    // Visas i UI/debug så admin kan se varför vissa bookmakers ger 0 träffar
    // (typiskt: 0 rows för bookmakeren i indexet → ingen pipeline matar dit).
    const rowsPerBookmaker: Record<string, number> = {};
    for (const m of matches) {
      for (const r of m.oddsRows) {
        rowsPerBookmaker[r.bookmakerId] = (rowsPerBookmaker[r.bookmakerId] ?? 0) + 1;
      }
    }
    const debug = {
      matchesLoaded: matches.length,
      hoursAhead,
      requestedBookmakerId: resolved.id,
      requestedBookmakerName: resolved.name,
      rowsPerBookmaker,
    };

    res.statusCode = 200;
    res.end(JSON.stringify({ ...result, _debug: debug }, null, 2));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[bonus-finder] error:", msg);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: msg }));
  }
}
