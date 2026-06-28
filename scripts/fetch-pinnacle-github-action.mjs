#!/usr/bin/env node
/**
 * Standalone Pinnacle-fetcher avsedd att köras i GitHub Actions.
 *
 * Render's IP-block är blockerat av Cloudflare WAF för Pinnacle (HTTP 403 även
 * med stealth-Chromium). GitHub Actions körs på Azure ASN som har bättre rykte
 * och passerar Cloudflare. Scriptet:
 *   1. Startar headless Chromium med stealth-plugin
 *   2. Laddar pinnacle.com (Cloudflare clearance)
 *   3. Hämtar matchups + markets/straight per sport via context.request
 *   4. Skriver data/pinnacle-rows.json som workflow:n committar
 *
 * Render läser sedan den filen via raw.githubusercontent.com.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { installHardDeadline, writeJsonPreservingCache, readJsonSafe } from "./lib/scrape-guard.mjs";

chromiumExtra.use(StealthPlugin());

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

async function ensureClearance(page, context) {
  // Clearance-väntan är ren spilltid: på GitHubs IP:er får vi nästan ALDRIG
  // cf_clearance-cookien, men API-fetchen nedan funkar ändå (returnerar full
  // data utan sid-clearance). Tidigare 16×2s = 32s slösades per fetch → takten
  // fastnade på ~40s oavsett cadens. Vi gör ett SNABBT försök (default 4×2s=8s)
  // och fortsätter sedan oavsett. Lyckas clearance tidigt returnerar vi direkt.
  // Tunbar via PINNACLE_CLEARANCE_ATTEMPTS om Pinnacle någon gång börjar kräva
  // clearance även för API:t.
  const maxAttempts = Math.max(1, Number(process.env.PINNACLE_CLEARANCE_ATTEMPTS) || 3);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await page.waitForTimeout(2_000);
    const title = await page.title().catch(() => "");
    const cookies = await context.cookies(PINNACLE_SITE_URL).catch(() => []);
    const hasClearance = cookies.some((c) => c.name === "cf_clearance" || c.name === "__cf_bm");
    if (hasClearance && !/just a moment|attention required|cloudflare/i.test(title)) {
      console.log(`[pinnacle-action] Cloudflare cleared (titel: "${title}", cookies: ${cookies.length})`);
      return { hasClearance: true, title, cookieCount: cookies.length };
    }
    if (attempt === 0) console.log("[pinnacle-action] Väntar på Cloudflare clearance (kort)...");
  }
  const lastTitle = await page.title().catch(() => "");
  console.warn(`[pinnacle-action] Clearance saknas efter ${maxAttempts} försök — fortsätter (API funkar ändå), titel: "${lastTitle}"`);
  return { hasClearance: false, title: lastTitle, cookieCount: 0 };
}

/**
 * Trimma + pre-filtrera matchups/markets så bara det backend faktiskt använder
 * sparas. Reducerar JSON-filen kraftigt (35MB → ~3MB), undviker OOM-krash på
 * Render's 512MB Starter-plan vid JSON.parse.
 */
function trimMatchup(matchup) {
  if (!matchup || typeof matchup !== "object") return null;
  // Backend ignorerar live-matcher och redan startade.
  if (matchup.isLive) return null;
  const startMs = matchup.startTime ? Date.parse(matchup.startTime) : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null;
  // Backend kräver minst home + away.
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

// Marknadstyper vi behåller. moneyline (1X2/ML) som förr + total (O/U) + spread
// (Asian Handicap för fotboll / point spread). Linjevärdet ligger per pris i
// `points` (total-linje resp. handikapp) och MÅSTE bevaras för line-matching.
const KEPT_MARKET_TYPES = new Set(["moneyline", "spread", "total"]);

function trimMarket(market) {
  if (!market || typeof market !== "object") return null;
  if (market.period !== 0) return null; // bara full match (period 0)
  if (market.status && market.status !== "open") return null;
  if (typeof market.matchupId !== "number") return null;
  const type = market.type;
  if (!KEPT_MARKET_TYPES.has(type)) return null;
  // moneyline: bara huvudlinjen (ej alternates) — exakt som förr (bakåtkompat).
  // total/spread: BEHÅLL alternates — de bygger linjestegen som line-matching
  // behöver (Over 2.0/2.25/2.5..., AH -0.5/-0.75/-1.0...).
  if (type === "moneyline" && market.isAlternate) return null;
  // LIKVIDITET: Pinnacles max-insats (limit) per marknad är deras egen
  // confidence-signal. Hög limit = vass, stabil linje (toppligor nära avspark)
  // → edge att lita på. Låg limit = osäker/tunn linje (obskyra ligor, tidiga
  // linjer) → "edge" är brus och svänger ofta hårt. Vi sparar den så backend
  // kan flagga/vikta valuebets efter likviditet.
  const pinnacleLimit = (() => {
    const lim = Array.isArray(market.limits) ? market.limits : [];
    let max = null;
    for (const l of lim) {
      const a = typeof l?.amount === "number" ? l.amount
        : typeof l?.maxRiskStake === "number" ? l.maxRiskStake
        : typeof l?.max === "number" ? l.max : null;
      if (a != null && (max === null || a > max)) max = a;
    }
    return max;
  })();
  return {
    matchupId: market.matchupId,
    type,
    period: 0,
    ...(type === "moneyline" ? {} : { isAlternate: !!market.isAlternate }),
    limit: pinnacleLimit,
    prices: Array.isArray(market.prices)
      ? market.prices
          .filter((p) => p?.designation && Number.isFinite(p.price))
          // `points` = total-linje (over/under) ELLER handikapp (home/away).
          .map((p) => (Number.isFinite(p.points)
            ? { designation: p.designation, price: p.price, points: p.points }
            : { designation: p.designation, price: p.price }))
      : [],
  };
}

/**
 * HÖRN-marknader (corners): Pinnacle exponerar dem som SPECIAL-matchups
 * (special.category === "Corners") med parent → huvudmatchen. Vi behåller dem i
 * SEPARATA arrayer (cornerMatchups/cornerMarkets) så mål-parsningen är orörd; team-
 * namn länkas via parentId till huvudmatchen. total = O/U hörn, spread = hörn-AH.
 */
function trimCornerMatchup(matchup) {
  if (!matchup || typeof matchup !== "object") return null;
  if (matchup.isLive) return null;
  // Pinnacle identifierar hörn-special-matchups via units==="Corners" (special-fältet
  // är null). FIX 2026-06-26: tidigare special.category==="Corners" → fångade 0 (Pinnacle
  // ändrade strukturen). Recon visade special=null + units="Corners". Behåller den gamla
  // kontrollen som fallback ifall de byter tillbaka.
  const isCorner = matchup.units === "Corners" || matchup.special?.category === "Corners";
  if (!isCorner) return null;
  const parentId = matchup.parent?.id ?? matchup.parentId;
  if (typeof parentId !== "number") return null;
  const startMs = matchup.startTime ? Date.parse(matchup.startTime) : NaN;
  if (!Number.isFinite(startMs) || startMs <= Date.now()) return null;
  return { id: matchup.id, parentId, startTime: matchup.startTime };
}

async function fetchSport(context, sportId) {
  const baseHeaders = {
    accept: "application/json",
    "x-api-key": PINNACLE_API_KEY,
    origin: PINNACLE_SITE_URL,
    referer: `${PINNACLE_SITE_URL}/`,
  };
  const fetchPath = async (p) => {
    try {
      const r = await context.request.get(`${PINNACLE_API_BASE}${p}`, { headers: baseHeaders, timeout: 30_000 });
      const status = r.status();
      if (status < 200 || status >= 300) return { ok: false, status };
      return { ok: true, status, data: await r.json() };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };
  const [matchupsRes, marketsRes] = await Promise.all([
    fetchPath(`/0.1/sports/${sportId}/matchups`),
    fetchPath(`/0.1/sports/${sportId}/markets/straight`),
  ]);
  // Pre-filtrera + trimma — slänger ~95% av rådata som backend ändå skulle filtrera bort.
  const trimmedMatchups =
    matchupsRes.ok && Array.isArray(matchupsRes.data)
      ? matchupsRes.data.map(trimMatchup).filter(Boolean)
      : null;
  let trimmedMarkets =
    marketsRes.ok && Array.isArray(marketsRes.data)
      ? marketsRes.data.map(trimMarket).filter(Boolean)
      : null;
  // Bara markets vars matchupId finns kvar i trimmedMatchups (referensiell integritet).
  if (Array.isArray(trimmedMatchups) && Array.isArray(trimmedMarkets)) {
    const matchupIds = new Set(trimmedMatchups.map((m) => m.id));
    trimmedMarkets = trimmedMarkets.filter((m) => matchupIds.has(m.matchupId));
  }
  // HÖRN: separat capture (soccer-only i praktiken). Corner-matchups (special) +
  // deras total/spread-markets, länkade via parentId till huvudmatchen. Backend
  // bygger corner-ladders ur dessa utan att mål-parsningen rörs.
  let cornerMatchups = null, cornerMarkets = null;
  if (matchupsRes.ok && Array.isArray(matchupsRes.data)) {
    cornerMatchups = matchupsRes.data.map(trimCornerMatchup).filter(Boolean);
    if (cornerMatchups.length && marketsRes.ok && Array.isArray(marketsRes.data)) {
      const cids = new Set(cornerMatchups.map((m) => m.id));
      cornerMarkets = marketsRes.data.map(trimMarket).filter((m) => m && cids.has(m.matchupId));
    } else {
      cornerMatchups = cornerMatchups.length ? cornerMatchups : null;
    }
  }
  return {
    matchupsOk: matchupsRes.ok,
    marketsOk: marketsRes.ok,
    matchups: trimmedMatchups,
    markets: trimmedMarkets,
    cornerMatchups,
    cornerMarkets,
    matchupsStatus: matchupsRes.status ?? null,
    marketsStatus: marketsRes.status ?? null,
  };
}

async function main() {
  const mainStart = Date.now();
  // Backstop: exit 0 före jobbets timeout (9 min) om Chromium/Cloudflare hänger,
  // så commit-steget kör. Inget skrivs vid deadline → tidigare cache bevaras.
  // Extra viktigt: pinnacle-rows.json seedar query-strategin för betsson/comeon/
  // vbet — en tom/förlorad pinnacle-cache gör ALLA dessa källor stale i kaskad.
  const deadline = installHardDeadline({
    budgetMs: Number(process.env.PINNACLE_DEADLINE_MS) || 7 * 60 * 1000,
    label: "pinnacle-action",
  });
  console.log("[pinnacle-action] Startar headless Chromium med stealth...");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  console.log(`[pinnacle-action] Öppnar ${PINNACLE_SITE_URL}...`);
  await page.goto(PINNACLE_SITE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const pageStatus = await ensureClearance(page, context);

  const bySport = {};
  let totalMatchups = 0;
  let totalMarkets = 0;
  let okSports = 0;

  // Parallell hämtning av alla sporter (tidigare sekventiell ~30s →
  // parallell ~5-10s). Promise.allSettled så att fel i en sport inte
  // sänker hela körningen — övriga sporters resultat sparas ändå.
  // Per-sport timing loggas för observability.
  const fetchAllStart = Date.now();
  const results = await Promise.allSettled(
    PINNACLE_SPORT_IDS.map(async (sport) => {
      const sportStart = Date.now();
      try {
        const result = await fetchSport(context, sport.id);
        const sportDurationMs = Date.now() - sportStart;
        return { sport, ok: true, result, durationMs: sportDurationMs };
      } catch (error) {
        const sportDurationMs = Date.now() - sportStart;
        return {
          sport,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: sportDurationMs,
        };
      }
    }),
  );

  // Aggregera resultat + per-sport-loggar (en gång var, ordnat)
  for (let i = 0; i < results.length; i += 1) {
    const settled = results[i];
    const sport = PINNACLE_SPORT_IDS[i];
    if (settled.status === "rejected") {
      // Skulle inte hända eftersom vi har inre try/catch, men säkerhet
      console.warn(`[pinnacle-action] ${sport.tag} rejected:`, settled.reason);
      bySport[sport.tag] = { sportId: sport.id, ok: false, matchups: [], markets: [] };
      continue;
    }
    const payload = settled.value;
    if (!payload.ok) {
      console.warn(
        `[pinnacle-action] ${sport.tag} misslyckades efter ${payload.durationMs}ms: ${payload.error}`,
      );
      bySport[sport.tag] = { sportId: sport.id, ok: false, matchups: [], markets: [] };
      continue;
    }
    const result = payload.result;
    const matchupsCount = Array.isArray(result.matchups) ? result.matchups.length : 0;
    const marketsCount = Array.isArray(result.markets) ? result.markets.length : 0;
    bySport[sport.tag] = {
      sportId: sport.id,
      ok: result.matchupsOk && result.marketsOk,
      matchupsStatus: result.matchupsStatus,
      marketsStatus: result.marketsStatus,
      matchups: result.matchups ?? [],
      markets: result.markets ?? [],
      // Hörn-marknader (endast närvarande för soccer) — utelämnas när tomma.
      ...(result.cornerMatchups?.length ? { cornerMatchups: result.cornerMatchups } : {}),
      ...(result.cornerMarkets?.length ? { cornerMarkets: result.cornerMarkets } : {}),
    };
    totalMatchups += matchupsCount;
    totalMarkets += marketsCount;
    if (result.matchupsOk && result.marketsOk) okSports += 1;
    console.log(
      `[pinnacle-action] ${sport.tag}: matchups=${matchupsCount} markets=${marketsCount} (${result.matchupsStatus}/${result.marketsStatus}) [${payload.durationMs}ms]`,
    );
  }
  const fetchAllDurationMs = Date.now() - fetchAllStart;
  console.log(
    `[pinnacle-action] Parallell fetch klar: ${okSports}/${PINNACLE_SPORT_IDS.length} sporter OK, total fetch-tid ${fetchAllDurationMs}ms`,
  );

  await browser.close();

  // Hjälpare: pinnacle-payload är "tom" om inga matchups hämtades. Då bevaras
  // tidigare cache i stället för att klottra över den (annars tappar betsson/
  // comeon/vbet sin query-seed → kaskad-staleness).
  const isPinnacleEmpty = (p) => !(p?.summary?.totalMatchups > 0);
  const pinnacleCount = (p) => p?.summary?.totalMatchups ?? 0;

  if (okSports === 0) {
    console.error(`[pinnacle-action] Alla ${PINNACLE_SPORT_IDS.length} sporter misslyckades — bevarar tidigare cache, exit 1.`);
    // Cache-bevarande: skriv ALDRIG en tom payload över en bra pinnacle-cache.
    deadline.cancel();
    writeJsonPreservingCache(
      OUTPUT_FILE,
      {
        updatedAt: new Date().toISOString(),
        summary: {
          totalMatchups: 0,
          totalMarkets: 0,
          okSports: 0,
          pageStatus,
          perSportStatus: Object.fromEntries(
            Object.entries(bySport).map(([t, e]) => [t, { ok: e.ok, matchupsStatus: e.matchupsStatus, marketsStatus: e.marketsStatus }]),
          ),
          error: "Alla sporter misslyckades — Cloudflare blockerar troligen GitHub Actions runners.",
        },
      },
      { label: "pinnacle-action", isEmpty: isPinnacleEmpty, countOf: pinnacleCount },
    );
    process.exit(1);
  }

  const totalDurationMs = Date.now() - mainStart;
  const payload = {
    updatedAt: new Date().toISOString(),
    bySport,
    summary: {
      totalMatchups,
      totalMarkets,
      okSports,
      pageStatus,
      // Total workflow duration i ms — för observability (kan plottas över tid)
      totalDurationMs,
    },
  };

  // ── Datakvalitets-skydd (tidsbegränsat) ────────────────────────────────────
  // Skriv inte över en NYLIG, substantiell cache med en kraftigt degraderad
  // fetch. En partiell Cloudflare-block kan ge okSports>0 men nästan inga
  // soccer-matchups — och soccer är just det som driver valuebets-gaten. Då är
  // det bättre att behålla den någon minut äldre KOMPLETTA datan än att committa
  // tunn data som ger dåliga/inga valuebets. Tidsbegränsat: är cachen redan
  // > MAX_PRESERVE_AGE gammal accepterar vi ändå den tunna datan, så skyddet
  // aldrig kan trycka datan förbi 10-min-gaten.
  const newSoccer = payload.bySport?.soccer?.matchups?.length ?? 0;
  const prev = readJsonSafe(OUTPUT_FILE);
  const prevSoccer = prev?.bySport?.soccer?.matchups?.length ?? 0;
  const prevAgeMs = prev?.updatedAt ? Date.now() - Date.parse(prev.updatedAt) : Infinity;
  const QUALITY_MIN_PREV_SOCCER = 100; // föregående måste varit rejält substantiell
  const QUALITY_DROP_RATIO = 0.4; // ny < 40% av föregående = uppenbart degraderad
  const QUALITY_MAX_PRESERVE_AGE_MS = 7 * 60 * 1000; // aldrig förbi gaten (10 min)
  if (
    prevSoccer >= QUALITY_MIN_PREV_SOCCER &&
    newSoccer < prevSoccer * QUALITY_DROP_RATIO &&
    Number.isFinite(prevAgeMs) &&
    prevAgeMs < QUALITY_MAX_PRESERVE_AGE_MS
  ) {
    console.warn(
      `[pinnacle-action] KVALITETSSKYDD: ny soccer-räkning ${newSoccer} << föregående ${prevSoccer} ` +
        `(cache ${Math.round(prevAgeMs / 1000)}s gammal < 7min) — trolig partiell Cloudflare-degradering, ` +
        `bevarar komplett cache i stället för att committa tunn data.`,
    );
    deadline.cancel();
    process.exit(0); // inget skrivs → commit-steget ser ingen förändring
  }

  deadline.cancel();
  writeJsonPreservingCache(OUTPUT_FILE, payload, {
    label: "pinnacle-action",
    isEmpty: isPinnacleEmpty,
    countOf: pinnacleCount,
  });
  console.log(
    `[pinnacle-action] Skrev ${OUTPUT_FILE}: ${totalMatchups} matchups, ${totalMarkets} markets, ${okSports}/${PINNACLE_SPORT_IDS.length} sporter OK. Total tid: ${(totalDurationMs / 1000).toFixed(1)}s.`,
  );
}

main().catch((error) => {
  console.error("[pinnacle-action] Fatal:", error);
  process.exit(1);
});
