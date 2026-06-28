#!/usr/bin/env node
/**
 * Andra-pass-inventering (Fas A2):
 *
 *   1. SportyBet NG — djupinspekt på football prematch.
 *      Navigerar till /ng/sport/football, fångar XHR-svar mot
 *      /api/ng/factsCenter/* och loggar event-struktur + market-shape så
 *      vi vet hur 1X2/O/U/AH/BTTS representeras.
 *
 *   2. Bet7 / betseven20 — andra-pass på djupare paths för att avgöra om
 *      sidan har publik oddsdata någonstans innan vi markerar blocked.
 *
 * Inga bypass:
 *   - Ingen captcha-lösning
 *   - Ingen login
 *   - Ingen proxy/VPN
 *   - Endast publikt synliga API-svar loggas
 *
 * Användning:
 *   node scripts/inspect-foreign-sources-deep.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const SPORTYBET_URL = "https://www.sportybet.com/ng/sport/football";
const SPORTYBET_API_REGEX = /\/api\/ng\/(factsCenter|sportsBet|sports|orderedSportList|popularSport|configurableEventList|popularSportsTournaments)\b/i;

const BET7_PATHS = [
  "https://www.betseven20.com/futebol",
  "https://www.betseven20.com/esportes",
  "https://www.betseven20.com/desporto",
  "https://www.betseven20.com/sport",
  "https://www.betseven20.com/pt/sports",
  "https://www.betseven20.com/pt/futebol",
];
const BET7_INTERESTING_API_REGEX = /\/(api|graphql|odds|sportsbook|events|markets|prematch|fixtures|matches|prices|sport|esportes|desporto|futebol|outright|livefeed|cms\/api)\b/i;

const OUT_DIR = path.resolve(process.cwd(), "data");
const SPORTYBET_DEBUG_FILE = path.join(OUT_DIR, "_inspect-sportybet-football.sample.json");
const BET7_DEBUG_FILE = path.join(OUT_DIR, "_inspect-bet7-paths.sample.json");

const ODDS_REGEX = /\b([1-9]\d?\.\d{2})\b/g;
const BLOCK_TITLE_REGEX = /just a moment|attention required|access denied|cloudflare|403 forbidden|404 not found|please verify|are you human/i;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function shortHost(url) {
  try { return new URL(url).host; } catch { return url; }
}

async function newContext(browser) {
  return browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    userAgent: USER_AGENT,
  });
}

/* ─────────────────────────────────────────────────────────────────────
 * 1. SPORTYBET DEEP INSPECT
 * ──────────────────────────────────────────────────────────────────── */

async function inspectSportybetFootball(browser) {
  console.log(`\n═══ SportyBet NG — djupinspekt football prematch ═══`);
  console.log(`URL: ${SPORTYBET_URL}`);
  const context = await newContext(browser);

  // Spara hela JSON-svar för intressanta endpoints så vi kan se shapen.
  const apiCalls = []; // { url, host, status, contentType, sizeBytes, body? }
  context.on("response", async (response) => {
    try {
      const req = response.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const url = response.url();
      if (!SPORTYBET_API_REGEX.test(url)) return;
      const status = response.status();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";
      let body = null;
      let bodyLen = 0;
      if (contentType.includes("application/json") && status === 200) {
        try {
          const text = await response.text();
          bodyLen = text.length;
          // Trimma sample-body — vi vill bara se struktur, inte alla 100 events.
          if (text.length < 8_000_000) {
            try {
              const parsed = JSON.parse(text);
              body = parsed;
            } catch { /* ej JSON trots header */ }
          }
        } catch { /* ignore */ }
      }
      apiCalls.push({
        url,
        host: shortHost(url),
        status,
        contentType,
        bodyLen,
        body,
      });
    } catch { /* ignore */ }
  });

  const page = await context.newPage();
  const startedAt = Date.now();
  let httpStatus = null;
  let finalUrl = null;
  let title = null;
  let navigationError = null;

  try {
    const navResponse = await page.goto(SPORTYBET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    httpStatus = navResponse ? navResponse.status() : null;
    // Vänta längre här — football-listan är JS-renderad och kan ta tid.
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    // Scrolla ner lite så lazy-loadade events kommer in.
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
    await page.waitForTimeout(2_500);
    finalUrl = page.url();
    title = await page.title().catch(() => "");
  } catch (err) {
    navigationError = err instanceof Error ? err.message : String(err);
  }

  await context.close().catch(() => {});

  const elapsedMs = Date.now() - startedAt;
  const titleBlocked = title ? BLOCK_TITLE_REGEX.test(title) : false;

  console.log(`  httpStatus:   ${httpStatus}`);
  console.log(`  finalUrl:     ${finalUrl}`);
  console.log(`  title:        ${JSON.stringify(title)}`);
  if (navigationError) console.log(`  error:        ${navigationError}`);
  console.log(`  titleBlocked: ${titleBlocked}`);
  console.log(`  apiCalls:     ${apiCalls.length} (mot factsCenter/sports*)`);
  console.log(`  elapsedMs:    ${elapsedMs}`);

  // Sortera på bodyLen, störst först — den största JSON:en är troligen
  // event-listan med markets.
  apiCalls.sort((a, b) => (b.bodyLen ?? 0) - (a.bodyLen ?? 0));

  console.log(`\n  --- Topp-5 största JSON-svar (sorterat på storlek) ---`);
  for (const c of apiCalls.slice(0, 5)) {
    console.log(`    [${c.status}] ${c.bodyLen}B  ${c.url}`);
  }

  // Skriv första 3 sample-bodies till disk för manuell inspektion.
  const samples = apiCalls.slice(0, 3).map((c) => ({
    url: c.url,
    status: c.status,
    bodyLen: c.bodyLen,
    bodyPreview: typeof c.body === "object" && c.body !== null
      ? truncateForJson(c.body, 6) // max djup 6 + max 5 arr-items
      : null,
  }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SPORTYBET_DEBUG_FILE, JSON.stringify(samples, null, 2));
  console.log(`\n  ✓ Sparade sample-bodies till ${SPORTYBET_DEBUG_FILE}`);

  // Analysera top-1 för market-struktur.
  if (samples[0] && samples[0].bodyPreview) {
    console.log(`\n  --- Top-1 body preview-keys ---`);
    analyzeStructure(samples[0].bodyPreview, "  ", 0, 3);
  }

  return { httpStatus, finalUrl, title, navigationError, apiCalls: apiCalls.length };
}

/**
 * Trimma JSON-objekt rekursivt så vi får en hanterbar preview.
 *   - Strängar > 200 chars trunkeras
 *   - Arrays > 5 element trunkeras
 *   - Djup > maxDepth → "[…depth limit…]"
 */
function truncateForJson(value, maxDepth, depth = 0) {
  if (depth > maxDepth) return "[…depth limit…]";
  if (value === null) return null;
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…[+${value.length - 200}]` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, 5).map((v) => truncateForJson(v, maxDepth, depth + 1));
    if (value.length > 5) sliced.push(`[+${value.length - 5} more items]`);
    return sliced;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = truncateForJson(v, maxDepth, depth + 1);
  }
  return out;
}

/** Skriv ut nyckelstruktur kompakt — bra för att se hur markets är formade. */
function analyzeStructure(value, prefix, depth, maxDepth) {
  if (depth > maxDepth) return;
  if (value === null || typeof value !== "object") {
    console.log(`${prefix}${typeof value === "string" ? `"${String(value).slice(0, 60)}"` : value}`);
    return;
  }
  if (Array.isArray(value)) {
    console.log(`${prefix}Array(${value.length})`);
    if (value[0] !== undefined) analyzeStructure(value[0], prefix + "  [0] ", depth + 1, maxDepth);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === null || typeof v !== "object") {
      const repr = typeof v === "string" ? `"${String(v).slice(0, 60)}"` : v;
      console.log(`${prefix}${k}: ${repr}`);
    } else if (Array.isArray(v)) {
      console.log(`${prefix}${k}: Array(${v.length})`);
      if (v[0] !== undefined) analyzeStructure(v[0], prefix + "  ", depth + 2, maxDepth);
    } else {
      console.log(`${prefix}${k}:`);
      analyzeStructure(v, prefix + "  ", depth + 1, maxDepth);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * 2. BET7 SECOND-PASS — testa flera djupare paths
 * ──────────────────────────────────────────────────────────────────── */

async function inspectBet7Paths(browser) {
  console.log(`\n═══ Bet7 / betseven20 — andra-pass på djupare paths ═══`);
  const results = [];

  for (const url of BET7_PATHS) {
    const context = await newContext(browser);
    const apiCalls = [];
    context.on("response", async (response) => {
      try {
        const req = response.request();
        const type = req.resourceType();
        if (type !== "xhr" && type !== "fetch") return;
        const u = response.url();
        if (!BET7_INTERESTING_API_REGEX.test(u)) return;
        apiCalls.push({
          url: u,
          host: shortHost(u),
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "",
        });
      } catch { /* ignore */ }
    });

    const page = await context.newPage();
    const started = Date.now();
    let httpStatus = null;
    let finalUrl = null;
    let title = null;
    let bodyText = "";
    let navigationError = null;

    try {
      const nav = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      httpStatus = nav ? nav.status() : null;
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      finalUrl = page.url();
      title = await page.title().catch(() => "");
      bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? "").catch(() => "");
    } catch (err) {
      navigationError = err instanceof Error ? err.message : String(err);
    }
    await context.close().catch(() => {});

    const oddsMatches = bodyText.match(ODDS_REGEX) ?? [];
    const titleBlocked = title ? BLOCK_TITLE_REGEX.test(title) : false;
    const sample = Array.from(new Set(oddsMatches)).slice(0, 6);

    let status;
    if (navigationError) status = "error";
    else if (httpStatus && httpStatus >= 400) status = `http_${httpStatus}`;
    else if (titleBlocked) status = "blocked";
    else if (finalUrl && new URL(finalUrl).pathname === "/") status = "redirected_to_root";
    else if (oddsMatches.length === 0 && apiCalls.length === 0) status = "no_odds_found";
    else status = "accessible";

    const result = {
      url,
      finalUrl,
      httpStatus,
      title,
      status,
      bodyTextLen: bodyText.length,
      oddsCount: oddsMatches.length,
      oddsSample: sample,
      apiCount: apiCalls.length,
      apiSample: apiCalls.slice(0, 4),
      elapsedMs: Date.now() - started,
      navigationError,
    };
    results.push(result);

    console.log(`\n  ${url}`);
    console.log(`    status=${status}  httpStatus=${httpStatus}  finalUrl=${finalUrl}`);
    console.log(`    title=${JSON.stringify(title)}`);
    console.log(`    bodyTextLen=${bodyText.length}  oddsCount=${oddsMatches.length}  apiCount=${apiCalls.length}`);
    if (sample.length > 0) console.log(`    oddsSample=[${sample.join(", ")}]`);
    if (apiCalls.length > 0) {
      for (const c of apiCalls.slice(0, 3)) console.log(`    api: [${c.status}] ${c.url.slice(0, 140)}`);
    }
    if (navigationError) console.log(`    error: ${navigationError}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(BET7_DEBUG_FILE, JSON.stringify(results, null, 2));
  console.log(`\n  ✓ Sparade bet7-path-resultat till ${BET7_DEBUG_FILE}`);
  return results;
}

/* ─────────────────────────────────────────────────────────────────────
 * MAIN
 * ──────────────────────────────────────────────────────────────────── */

async function main() {
  console.log("[inspect-deep] Startar djupinspekt. Stealth Chromium, ingen bypass.");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    await inspectSportybetFootball(browser);
    await inspectBet7Paths(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[inspect-deep] fatal:", err);
  process.exit(1);
});
