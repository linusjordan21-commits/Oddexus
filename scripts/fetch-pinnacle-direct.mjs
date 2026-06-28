#!/usr/bin/env node
/**
 * Direkt-HTTP Pinnacle-fetcher — UTAN Playwright/Chromium.
 *
 * Den GitHub Actions-versionen (fetch-pinnacle-github-action.mjs) startar
 * headless Chromium med stealth-plugin för att få Cloudflare-clearance, för
 * att Render's delade moln-IP är blockerad av Cloudflare WAF.
 *
 * MEN: en VPS med ren IP (Hetzner/DigitalOcean) får HTTP 200 direkt mot
 * Pinnacles guest-API utan clearance. Då behövs ingen Chromium alls — bara
 * en enkel fetch(). Detta script är ~50x snabbare (~2s vs ~60s) och kräver
 * inga browser-binärer.
 *
 * Producerar EXAKT samma data/pinnacle-rows.json-format som GitHub-versionen
 * så att Render-backend och resten av pipelinen inte märker skillnad.
 *
 * ANVÄNDNING (på VPS):
 *   node scripts/fetch-pinnacle-direct.mjs
 *
 * Om du får HTTP 403 betyder det att VPS:ns IP också är blockerad — falla då
 * tillbaka på Chromium-versionen eller byt VPS-region.
 */

import fs from "node:fs";
import path from "node:path";

const PINNACLE_API_BASE = "https://guest.api.arcadia.pinnacle.com";
const PINNACLE_SITE_URL = "https://www.pinnacle.com";
const PINNACLE_API_KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";

const PINNACLE_SPORT_IDS = [
  { id: 29, tag: "soccer" },
  { id: 4, tag: "basketball" },
  { id: 33, tag: "tennis" },
  { id: 19, tag: "ice-hockey" },
  { id: 15, tag: "american-football" },
  { id: 3, tag: "baseball" },
  { id: 22, tag: "mma" },
  { id: 6, tag: "boxing" },
];

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "pinnacle-rows.json");

// --- Trim-funktioner (identiska med GitHub-versionen) ---

function trimMatchup(matchup) {
  if (!matchup || typeof matchup !== "object") return null;
  if (matchup.isLive) return null;
  const startMs = matchup.startTime ? Date.parse(matchup.startTime) : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null;
  const participants = Array.isArray(matchup.participants) ? matchup.participants : [];
  const hasHome = participants.some((p) => p?.alignment === "home" && p?.name);
  const hasAway = participants.some((p) => p?.alignment === "away" && p?.name);
  if (!hasHome || !hasAway) return null;
  return {
    id: matchup.id,
    startTime: matchup.startTime,
    league: matchup.league?.name ? { name: matchup.league.name } : undefined,
    participants: participants
      .filter((p) => p?.alignment !== "neutral" && p?.name && p?.alignment)
      .map((p) => ({ alignment: p.alignment, name: p.name })),
  };
}

function trimMarket(market) {
  if (!market || typeof market !== "object") return null;
  if (market.period !== 0) return null;
  if (market.isAlternate) return null;
  if (market.status && market.status !== "open") return null;
  if (market.type !== "moneyline") return null;
  if (typeof market.matchupId !== "number") return null;
  return {
    matchupId: market.matchupId,
    type: "moneyline",
    period: 0,
    prices: Array.isArray(market.prices)
      ? market.prices
          .filter((p) => p?.designation && Number.isFinite(p.price))
          .map((p) => ({ designation: p.designation, price: p.price }))
      : [],
  };
}

// --- Direkt fetch (ingen Chromium) ---

const BASE_HEADERS = {
  accept: "application/json",
  "x-api-key": PINNACLE_API_KEY,
  origin: PINNACLE_SITE_URL,
  referer: `${PINNACLE_SITE_URL}/`,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Exponentiell backoff + jitter. Pinnacle 403:ar markets-endpointen under hög
// samtidighet (rate-limit) — retry löser de transienta blocken.
const retryDelay = (attempt) => 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);

async function fetchPath(p) {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const r = await fetch(`${PINNACLE_API_BASE}${p}`, { headers: BASE_HEADERS, signal: controller.signal });
      const status = r.status;
      if (status >= 200 && status < 300) return { ok: true, status, data: await r.json() };
      // 429/503 = transient rate-limit → backoff + retry. 403 = permanent
      // "ACCESS_DENIED" (Pinnacle nekar för stora markets-svar) → ingen retry;
      // primaryOnly-fallbacken i fetchSport hanterar det.
      if ((status === 429 || status === 503) && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelay(attempt));
        continue;
      }
      return { ok: false, status };
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelay(attempt));
        continue;
      }
      return { ok: false, error: error?.message ?? String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: null };
}

// Concurrency-begränsad map (Promise.allSettled-kompatibel retur). Pinnacle
// rate-limit:ar vid ~16 samtidiga requests (8 sporter × 2 endpoints) → kör
// max PINNACLE_CONCURRENCY sporter åt gången så markets inte 403:ar.
const PINNACLE_CONCURRENCY = 2;
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await worker(items[i], i) }; }
      catch (e) { out[i] = { status: "rejected", reason: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function fetchSport(sportId) {
  const [matchupsRes, marketsFull] = await Promise.all([
    fetchPath(`/0.1/sports/${sportId}/matchups`),
    fetchPath(`/0.1/sports/${sportId}/markets/straight`),
  ]);
  // Stora sporter (soccer) 403:ar full markets/straight ("ACCESS_DENIED" — för
  // stort svar). Fallback: ?primaryOnly=true ger bara huvudlinjerna (moneyline
  // + primär total/spread = det valuebets behöver) och returnerar 200.
  const marketsRes = marketsFull.ok
    ? marketsFull
    : await fetchPath(`/0.1/sports/${sportId}/markets/straight?primaryOnly=true`);
  const trimmedMatchups =
    matchupsRes.ok && Array.isArray(matchupsRes.data)
      ? matchupsRes.data.map(trimMatchup).filter(Boolean)
      : null;
  let trimmedMarkets =
    marketsRes.ok && Array.isArray(marketsRes.data)
      ? marketsRes.data.map(trimMarket).filter(Boolean)
      : null;
  if (Array.isArray(trimmedMatchups) && Array.isArray(trimmedMarkets)) {
    const matchupIds = new Set(trimmedMatchups.map((m) => m.id));
    trimmedMarkets = trimmedMarkets.filter((m) => matchupIds.has(m.matchupId));
  }
  return {
    matchupsOk: matchupsRes.ok,
    marketsOk: marketsRes.ok,
    matchups: trimmedMatchups,
    markets: trimmedMarkets,
    matchupsStatus: matchupsRes.status ?? null,
    marketsStatus: marketsRes.status ?? null,
  };
}

async function main() {
  const mainStart = Date.now();
  console.log("[pinnacle-direct] Hämtar Pinnacle via direkt HTTP (ingen Chromium)...");

  const bySport = {};
  let totalMatchups = 0;
  let totalMarkets = 0;
  let okSports = 0;

  const results = await mapLimit(PINNACLE_SPORT_IDS, PINNACLE_CONCURRENCY, async (sport) => {
    const start = Date.now();
    const result = await fetchSport(sport.id);
    return { sport, result, durationMs: Date.now() - start };
  });

  for (let i = 0; i < results.length; i += 1) {
    const settled = results[i];
    const sport = PINNACLE_SPORT_IDS[i];
    if (settled.status === "rejected") {
      bySport[sport.tag] = { sportId: sport.id, ok: false, matchups: [], markets: [] };
      continue;
    }
    const { result, durationMs } = settled.value;
    const matchupsCount = Array.isArray(result.matchups) ? result.matchups.length : 0;
    const marketsCount = Array.isArray(result.markets) ? result.markets.length : 0;
    bySport[sport.tag] = {
      sportId: sport.id,
      ok: result.matchupsOk && result.marketsOk,
      matchupsStatus: result.matchupsStatus,
      marketsStatus: result.marketsStatus,
      matchups: result.matchups ?? [],
      markets: result.markets ?? [],
    };
    totalMatchups += matchupsCount;
    totalMarkets += marketsCount;
    if (result.matchupsOk && result.marketsOk) okSports += 1;
    console.log(
      `[pinnacle-direct] ${sport.tag}: matchups=${matchupsCount} markets=${marketsCount} (${result.matchupsStatus}/${result.marketsStatus}) [${durationMs}ms]`,
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (okSports === 0) {
    console.error("[pinnacle-direct] Alla sporter misslyckades — IP troligen Cloudflare-blockerad. Falla tillbaka på Chromium-versionen.");
    process.exit(1);
  }

  const totalDurationMs = Date.now() - mainStart;
  const payload = {
    updatedAt: new Date().toISOString(),
    bySport,
    summary: { totalMatchups, totalMarkets, okSports, totalDurationMs, source: "direct-http" },
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload), "utf-8");
  console.log(
    `[pinnacle-direct] Skrev ${OUTPUT_FILE}: ${totalMatchups} matchups, ${totalMarkets} markets, ${okSports}/${PINNACLE_SPORT_IDS.length} sporter OK. ${(totalDurationMs / 1000).toFixed(1)}s.`,
  );
}

main().catch((error) => {
  console.error("[pinnacle-direct] Fatal:", error);
  process.exit(1);
});
