#!/usr/bin/env node
/**
 * Paf-brand group prewarm search cache.
 *
 * Endpoint: <origin>/api/betting/search?q=<query> (4 separata brands).
 * Varje brand exponerar samma Kambi-mirror med olika brand-specifik marginal:
 *   - x3000.com
 *   - goldenbull.se
 *   - 1x2.se
 *   - speedybet.com
 *
 * Problem: ingen bulk-feed finns. Sökendpointen är enda offentliga vägen och
 * returnerar 5-10 events per query. Vi kör en strategisk lista av prewarm-
 * queries (stora lag + ligor + länder) och dedupe:ar events per brand på
 * eventId. Coverage = täcker matcher där minst ett av lagen/ligorna matchar
 * en query — typiskt nästan all europeisk topptopp + de stora cuper.
 *
 * INTE en "full cache" — kalla den "prewarm cache" eftersom obskyra ligor
 * faller utanför vår query-lista. Cache-miss → live-fallback i scrapePaf-
 * BrandBookmaker (samma search-API men med smart-search per match-titel).
 *
 * Cache-preserve: skriver ALDRIG över rows.json med tom payload.
 *
 * Output: data/paf-brand-rows.json med byBrand-shape.
 */

import fs from "node:fs";
import path from "node:path";
import { installHardDeadline, atomicWriteString } from "./lib/scrape-guard.mjs";

// ----------------------------------------------------------------------
// Brand-config
// ----------------------------------------------------------------------

// Paf-brands är en Kambi-mirror. Recon: detalj-paths på brand-origin 404:ar,
// men Kambi-API:t svarar per brand-offering (verifierat: "paf" → 200 betOffers).
// kambiOffering används för totals/AH via /betoffer/event/{id}.
// Recon: bara Kambi-offering "paf" svarar 200 (brand-specifika koder 404/429).
// Paf-brandsen är near-identiska mirrors → vi använder "paf"-feeden för totals/AH
// på alla (1X2 förblir brand-specifik från search). Bättre full täckning än 0.
const BRANDS = [
  { key: "x3000", displayName: "X3000", baseUrl: "https://www.x3000.com", kambiOffering: "paf" },
  { key: "goldenbull", displayName: "Golden Bull", baseUrl: "https://www.goldenbull.se", kambiOffering: "paf" },
  { key: "oneTwo", displayName: "1x2", baseUrl: "https://www.1x2.se", kambiOffering: "paf" },
  { key: "speedybet", displayName: "Speedybet", baseUrl: "https://www.speedybet.com", kambiOffering: "paf" },
];

// Bundet antal Kambi-detalj-anrop per brand (totals/AH). Strypt → begränsad last.
const PAF_DETAIL_MAX = Number(process.env.PAF_DETAIL_MAX) || 60;
const KAMBI_DETAIL_BASE = "https://eu-offering-api.kambicdn.com/offering/v2018";

/** Hämta Kambi-detalj för ett event via brandens offering. Null vid fel. */
async function fetchKambiDetailForPaf(offering, eventId) {
  const url = `${KAMBI_DETAIL_BASE}/${offering}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Totals (Total Goals) + Asian Handicap ur Kambi-detalj (odds/line i milli). */
function parsePafKambiTotalsAh(data, homeTeam, awayTeam) {
  const betOffers = Array.isArray(data?.betOffers) ? data.betOffers : [];
  const totals = [], ah = [];
  const hN = String(homeTeam ?? "").toLowerCase(), aN = String(awayTeam ?? "").toLowerCase();
  const ok = (x) => (!x?.status || x.status === "OPEN") && Number(x?.odds) / 1000 > 1;
  for (const o of betOffers) {
    const type = String(o?.betOfferType?.englishName ?? "");
    const crit = String(o?.criterion?.englishLabel ?? "").trim().toLowerCase();
    const outs = Array.isArray(o?.outcomes) ? o.outcomes : [];
    if (type === "Over/Under" && crit === "total goals") {
      let over = null, under = null, line = null;
      for (const x of outs) {
        if (!ok(x)) continue;
        const odd = Number(x.odds) / 1000, ln = Number(x.line) / 1000;
        if (x.type === "OT_OVER" || /över|over/i.test(String(x.label))) { over = odd; if (line == null) line = ln; }
        else if (x.type === "OT_UNDER" || /under/i.test(String(x.label))) { under = odd; if (line == null) line = ln; }
      }
      if (over > 1 && under > 1 && Number.isFinite(line)) totals.push({ line, over, under });
    } else if (crit === "asian handicap" && type === "Asian Handicap") {
      let home = null, away = null, homeLine = null;
      for (const x of outs) {
        if (!ok(x)) continue;
        const odd = Number(x.odds) / 1000, ln = Number(x.line) / 1000;
        const lbl = String(x.label ?? "").toLowerCase();
        if (hN && (hN.includes(lbl) || lbl.includes(hN))) { home = odd; homeLine = ln; }
        else if (aN && (aN.includes(lbl) || lbl.includes(aN))) { away = odd; }
      }
      if (home > 1 && away > 1 && Number.isFinite(homeLine)) ah.push({ line: homeLine, home, away });
    }
  }
  return { totals, ah };
}

/**
 * Prewarm-queries. Bred täckning av topp-ligor + storlag + länder.
 * Lista hålls kort (~70 termer) så total fetch-tid stannar under ~40s
 * även med 4 brands sekventiellt.
 *
 * Coverage-driven: termerna är curated från audit-swedish-bookmaker-
 * coverage.mjs som visar vilka Pinnacle-events som missas i Paf-cachen.
 * Stora kategorier som tidigare missades (CONMEBOL, MLS, fler ligor) är
 * nu täckta. Lägg till termer här om du ser systematiska coverage-luckor.
 */
const PAF_PREWARM_QUERIES = [
  // Engelska topp
  "manchester", "arsenal", "chelsea", "liverpool", "tottenham", "newcastle",
  "everton", "leeds", "wolves", "brighton", "aston villa", "west ham",
  // Spanska/italienska/tyska/franska topplag
  "real madrid", "barcelona", "atletico", "sevilla", "valencia",
  "juventus", "inter", "milan", "napoli", "roma", "lazio", "fiorentina",
  "bayern", "dortmund", "leipzig", "leverkusen",
  "psg", "marseille", "lyon", "monaco",
  // Nederländerna / Portugal
  "ajax", "psv", "feyenoord", "benfica", "porto", "sporting",
  // Norden
  "sweden", "norway", "denmark", "finland",
  // Cup-turneringar
  "champions league", "europa league", "conference league",
  // Generiska liga-termer
  "premier league", "la liga", "serie a", "bundesliga", "ligue 1",
  // CONMEBOL (sydamerikansk fotboll — Pinnacle har mycket coverage)
  // Curated från audit: ALLA svenska källor missar dessa idag
  "libertadores", "sudamericana", "copa america",
  "boca juniors", "river plate", "flamengo", "palmeiras", "corinthians",
  "santos", "fluminense", "atletico mineiro", "internacional", "gremio",
  // USA MLS (Pinnacle har mycket; Paf täcker ~0 idag)
  "mls", "los angeles", "inter miami", "seattle sounders", "atlanta united",
  "new york", "lafc",
  // Sydeuropa breddat (Pinnacle täcker Grekland/Cypern/Turkiet)
  "olympiacos", "panathinaikos", "fenerbahce", "galatasaray",
];

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;
const QUERY_CONCURRENCY_PER_BRAND = 3;
const INTER_BATCH_DELAY_MS = 80; // gentle rate-limit mellan batches

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "paf-brand-rows.json");

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPreviousPayload() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function fetchSearchEvents(brand, query) {
  const url = `${brand.baseUrl}/api/betting/search?q=${encodeURIComponent(query)}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": UA,
          referer: `${brand.baseUrl}/betting`,
        },
      });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text().catch(() => "");
        lastErr = `HTTP ${response.status}: ${body.slice(0, 200)}`;
        if (attempt < RETRY_MAX_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw new Error(lastErr);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) return [];
      // Same parsing logic som fetchPafBrandSearchEvents i vite.config.ts
      const events = data
        .flatMap((sport) => sport?.competitions ?? [])
        .filter((c) => c?.sportId === "FOOTBALL")
        .filter((c) => !/cyber\s?live|esport|fantasy|simulated/i.test(c?.title ?? ""))
        .flatMap((c) =>
          (c?.events ?? []).map((evt) => ({ ...evt, _competitionTitle: c.title ?? null })),
        );
      return events;
    } catch (error) {
      clearTimeout(timer);
      lastErr = error?.message ?? String(error);
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error(lastErr ?? "Paf-brand search fetch failed");
}

function normalizeOdd(value) {
  if (value == null) return null;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) && n > 1 ? n : null;
}

function parse1X2(event) {
  const home = normalizeOdd(event?.betOffers?.match?.one?.odds);
  const draw = normalizeOdd(event?.betOffers?.match?.cross?.odds);
  const away = normalizeOdd(event?.betOffers?.match?.two?.odds);
  if (home && draw && away) return { home, draw, away };
  return null;
}

function buildTitle(event) {
  const home = event?.participants?.home?.name?.trim();
  const away = event?.participants?.away?.name?.trim();
  if (home && away) return `${home} - ${away}`;
  return (event?.name ?? "").trim();
}

async function fetchBrandPrewarm(brand) {
  const startMs = Date.now();
  // Map<eventId, { event, matchedQuery }> för dedupe
  const eventsById = new Map();
  let queriesSucceeded = 0;
  let queriesFailed = 0;
  const queryErrors = [];

  const queue = [...PAF_PREWARM_QUERIES];
  const workers = Array.from({ length: QUERY_CONCURRENCY_PER_BRAND }, async () => {
    while (queue.length > 0) {
      const query = queue.shift();
      if (!query) break;
      try {
        const events = await fetchSearchEvents(brand, query);
        queriesSucceeded += 1;
        for (const evt of events) {
          if (!evt?.eventId) continue;
          if (eventsById.has(evt.eventId)) continue;
          const odds = parse1X2(evt);
          if (!odds) continue;
          eventsById.set(evt.eventId, {
            event: evt,
            odds,
            matchedQuery: query,
          });
        }
        await sleep(INTER_BATCH_DELAY_MS);
      } catch (e) {
        queriesFailed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (queryErrors.length < 3) queryErrors.push(`${query}: ${msg.slice(0, 80)}`);
      }
    }
  });
  await Promise.all(workers);

  const events = [];
  for (const { event, odds, matchedQuery } of eventsById.values()) {
    const title = buildTitle(event);
    if (!title) continue;
    events.push({
      eventId: String(event.eventId),
      title,
      homeTeam: event?.participants?.home?.name ?? null,
      awayTeam: event?.participants?.away?.name ?? null,
      startTime: event?.startTime ?? null,
      league: event?._competitionTitle ?? null,
      odds,
      matchedQuery,
    });
  }

  // ── Totals + AH via BUNDNA Kambi-detalj-anrop (brandens offering) ──
  // Sekventiellt + 150ms delay → undviker 429 (som recon såg vid hammering).
  const nowMs = Date.now();
  const detailTargets = events
    .filter((e) => { const t = Date.parse(e.startTime ?? ""); return Number.isFinite(t) && t > nowMs; })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
    .slice(0, PAF_DETAIL_MAX);
  let detailWithLines = 0;
  for (const ev of detailTargets) {
    const data = await fetchKambiDetailForPaf(brand.kambiOffering, ev.eventId);
    if (data) {
      const { totals, ah } = parsePafKambiTotalsAh(data, ev.homeTeam, ev.awayTeam);
      if (totals.length) ev.totals = totals;
      if (ah.length) ev.ah = ah;
      if (totals.length || ah.length) detailWithLines += 1;
    }
    await sleep(150);
  }
  if (detailTargets.length) {
    console.log(`[paf-brand] ${brand.displayName}: detalj ${detailWithLines}/${detailTargets.length} med totals/AH (offering=${brand.kambiOffering})`);
  }

  const durationMs = Date.now() - startMs;
  const lastError =
    queriesFailed === 0
      ? null
      : queriesFailed === PAF_PREWARM_QUERIES.length
        ? `all queries failed (sample: ${queryErrors.join("; ")})`
        : `${queriesFailed}/${PAF_PREWARM_QUERIES.length} queries failed`;

  console.log(
    `[paf-brand] ${queriesFailed > 0 ? "⚠" : "✓"} ${brand.displayName.padEnd(11)} ${durationMs}ms · ${events.length} events (queries ok=${queriesSucceeded} failed=${queriesFailed})`,
  );

  return {
    displayName: brand.displayName,
    baseUrl: brand.baseUrl,
    updatedAt: new Date().toISOString(),
    queriesTried: PAF_PREWARM_QUERIES.length,
    queriesSucceeded,
    queriesFailed,
    eventsFound: events.length,
    durationMs,
    events,
    lastError,
  };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  // Backstop: exit 0 före jobbets timeout (5 min) om något hänger. Inget skrivs
  // vid deadline → tidigare cache bevaras.
  const deadline = installHardDeadline({
    budgetMs: Number(process.env.PAF_DEADLINE_MS) || 4 * 60 * 1000,
    label: "paf-brand",
  });
  console.log(
    `[paf-brand] start — ${BRANDS.length} brands × ${PAF_PREWARM_QUERIES.length} prewarm queries (concurrency ${QUERY_CONCURRENCY_PER_BRAND}/brand)`,
  );

  // Kör brands sekventiellt så vi inte spammar 4 brands × 3 conc = 12
  // parallella requests samtidigt mot olika hosts. Snäll mot upstream.
  const byBrand = {};
  let totalEvents = 0;
  let brandsFailedCompletely = 0;
  for (const brand of BRANDS) {
    try {
      const result = await fetchBrandPrewarm(brand);
      byBrand[brand.key] = result;
      totalEvents += result.eventsFound;
      if (result.queriesSucceeded === 0) brandsFailedCompletely += 1;
    } catch (e) {
      brandsFailedCompletely += 1;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[paf-brand] ✗ ${brand.displayName.padEnd(11)} catastrophic: ${msg}`);
      byBrand[brand.key] = {
        displayName: brand.displayName,
        baseUrl: brand.baseUrl,
        updatedAt: null,
        queriesTried: PAF_PREWARM_QUERIES.length,
        queriesSucceeded: 0,
        queriesFailed: PAF_PREWARM_QUERIES.length,
        eventsFound: 0,
        durationMs: 0,
        events: [],
        lastError: msg,
      };
    }
  }

  // Cache-preserve: om ALLA brands failade helt → behåll föregående payload
  if (brandsFailedCompletely === BRANDS.length && totalEvents === 0) {
    const prev = readPreviousPayload();
    if (prev) {
      console.warn(`[paf-brand] alla brands failade — behåller föregående payload (skapad ${prev.updatedAt})`);
      process.exit(2);
    }
  }

  const status =
    totalEvents === 0
      ? "error"
      : brandsFailedCompletely > 0
        ? "partial"
        : "active";

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "github-actions",
    bookmaker: "paf-brand",
    displayName: "Paf brand group (X3000 / Golden Bull / 1x2 / Speedybet)",
    cacheType: "prewarm",
    status,
    queryCount: PAF_PREWARM_QUERIES.length,
    brandsFetched: BRANDS.length - brandsFailedCompletely,
    brandsFailed: brandsFailedCompletely,
    totalEvents,
    durationMs: Date.now() - startMs,
    note:
      "Search-based prewarm cache — coverage depends on configured queries. " +
      "Live-fallback (per-match search) handles cache misses for obscure leagues.",
    byBrand,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  deadline.cancel();
  atomicWriteString(OUTPUT_FILE, JSON.stringify(payload, null, 2) + "\n");

  console.log(
    `[paf-brand] done — ${totalEvents} total events across ${BRANDS.length - brandsFailedCompletely}/${BRANDS.length} brands in ${payload.durationMs}ms`,
  );
  console.log(`[paf-brand] wrote ${path.relative(process.cwd(), OUTPUT_FILE)}`);
}

main().catch((e) => {
  console.error(`[paf-brand] fatal: ${e?.message ?? e}`);
  process.exit(1);
});
