#!/usr/bin/env node
/**
 * Inventering (Fas A) av tre utländska odds-källor:
 *
 *   1. Football.com  (livescore/discovery)
 *   2. SportyBet NG  (bookmaker)
 *   3. Bet7 / betseven20  (bookmaker)
 *
 * Skriptet är READ-ONLY och INSPEKTERAR endast publikt tillgängligt
 * material. Det:
 *
 *   - Använder samma stealth-Chromium-setup som befintliga scrapers
 *     (playwright-extra + puppeteer-extra-plugin-stealth)
 *   - Försöker INTE bypassa Cloudflare/CAPTCHA/login
 *   - Försöker INTE logga in
 *   - Försöker INTE använda proxies eller fingerprint-bypass
 *   - Stannar på sidan i max ~12s och rapporterar vad som syntes
 *
 * Om en sida kräver login/skydd eller redirectar bort från target-URL
 * markeras källan som "blocked" / "login_required" / "geo_redirect" i
 * rapporten. Inget data skrivs till disk — output går till stdout.
 *
 * Användning:
 *   node scripts/inspect-foreign-sources.mjs
 */

import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const TARGETS = [
  {
    key: "sportybet_ng",
    displayName: "SportyBet NG",
    expectedType: "bookmaker",
    url: "https://www.sportybet.com/ng/",
    waitSelectorHints: ["[class*='odds']", ".m-table", ".event"],
  },
  {
    key: "bet7",
    displayName: "Bet7 / betseven20",
    expectedType: "bookmaker",
    url: "https://www.betseven20.com/",
    waitSelectorHints: ["[class*='odd']", "[class*='Odd']", ".event-list"],
  },
];

// Odds-pris-regex: 1.01 - 99.99 (decimal odds). Stränger än bara \d+\.\d{2}
// för att inte fånga klocka 12:30 eller "1.5 mål". Tvåställig decimal med
// första siffran 1-9 är robust för moneyline + over/under.
const ODDS_REGEX = /\b([1-9]\d?\.\d{2})\b/g;

// Kända bot/error-titlar.
const BLOCK_TITLE_REGEX = /just a moment|attention required|access denied|cloudflare|403 forbidden|404 not found|please verify|are you human/i;

// Network-endpoints vi loggar (allt som luktar odds-API).
const INTERESTING_API_REGEX = /\/(api|graphql|odds|sportsbook|events|markets|prematch|fixtures|matches|matchups|prices|outrights|livefeed|cms\/api|fbcom\/api|odds-feed)\b/i;

function shortHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function inspect(target) {
  const startedAt = Date.now();
  console.log(`\n─── ${target.displayName} (${target.url}) ───`);

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

  // Samla alla XHR/fetch-svar för att hitta odds-API:n.
  const apiCalls = []; // { url, host, status, contentType, sizeBytes }
  context.on("response", async (response) => {
    try {
      const req = response.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const url = response.url();
      if (!INTERESTING_API_REGEX.test(url)) return;
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "";
      const lenHeader = headers["content-length"];
      const sizeBytes = lenHeader ? Number(lenHeader) : null;
      apiCalls.push({
        url,
        host: shortHost(url),
        status: response.status(),
        contentType,
        sizeBytes,
      });
    } catch {
      // ignore — vissa svar kan stängas innan vi hinner läsa
    }
  });

  const page = await context.newPage();
  let httpStatus = null;
  let finalUrl = null;
  let title = null;
  let bodyText = "";
  let navigationError = null;

  try {
    const navResponse = await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    httpStatus = navResponse ? navResponse.status() : null;
    // Vänta lite extra på JS-renderad content.
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    finalUrl = page.url();
    title = await page.title().catch(() => "");
    bodyText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 50_000) ?? "")
      .catch(() => "");
  } catch (err) {
    navigationError = err instanceof Error ? err.message : String(err);
  }

  await browser.close().catch(() => {});

  // Analysera resultat.
  const elapsedMs = Date.now() - startedAt;

  // Hittade vi odds-liknande siffror i synlig text? Stränga regex som ovan.
  const oddsMatches = bodyText.match(ODDS_REGEX) ?? [];
  // Filtrera bort dubletter, behåll bara distinkt-odds-spel av sample.
  const distinctOdds = Array.from(new Set(oddsMatches)).slice(0, 20);

  const titleLooksBlocked = title ? BLOCK_TITLE_REGEX.test(title) : false;
  const redirectedAwayFromTarget = (() => {
    if (!finalUrl) return false;
    try {
      const a = new URL(target.url);
      const b = new URL(finalUrl);
      if (a.host !== b.host) return true; // ex: sportybet.com → sportybet.com/ng/ är samma host
      return false;
    } catch {
      return false;
    }
  })();

  // Klassificera status.
  let status;
  if (navigationError) status = "error";
  else if (httpStatus && httpStatus >= 400) status = "blocked";
  else if (titleLooksBlocked) status = "blocked";
  else if (redirectedAwayFromTarget) status = "geo_redirect";
  else if (oddsMatches.length === 0 && apiCalls.length === 0) status = "no_odds_found";
  else status = "accessible";

  // Markets-heuristik baseras på text i body (1X2/Over Under/etc).
  const lowerBody = bodyText.toLowerCase();
  const marketsFound = [];
  if (/\b(1x2|home.+draw.+away|hemma.+oavgjort.+borta)\b/i.test(bodyText)) marketsFound.push("1X2");
  if (lowerBody.includes("over") && lowerBody.includes("under")) marketsFound.push("OVER_UNDER");
  if (/\b(handicap|spread|asian)\b/i.test(bodyText)) marketsFound.push("ASIAN_HANDICAP");
  if (/\b(both teams to score|btts|gg\/ng)\b/i.test(bodyText)) marketsFound.push("BTTS");

  // Dedupe API-anrop på host+path-prefix.
  const distinctApiHosts = Array.from(new Set(apiCalls.map((c) => c.host))).slice(0, 10);
  const sampleApiCalls = apiCalls.slice(0, 8);

  // Rapport.
  console.log(`  status:       ${status}`);
  console.log(`  type:         ${target.expectedType}`);
  console.log(`  httpStatus:   ${httpStatus ?? "n/a"}`);
  console.log(`  finalUrl:     ${finalUrl ?? "(navigation failed)"}`);
  console.log(`  title:        ${JSON.stringify(title)}`);
  if (navigationError) console.log(`  error:        ${navigationError}`);
  console.log(`  oddsFound:    ${oddsMatches.length > 0} (${oddsMatches.length} matches, sample: ${distinctOdds.slice(0, 8).join(", ")})`);
  console.log(`  marketsFound: [${marketsFound.join(", ")}]`);
  console.log(`  apiCalls:     ${apiCalls.length} interesting XHR/fetch (distinct hosts: ${distinctApiHosts.join(", ")})`);
  if (sampleApiCalls.length > 0) {
    console.log(`  apiSamples:`);
    for (const call of sampleApiCalls) {
      const sizeNote = call.sizeBytes != null ? `${call.sizeBytes}B` : "?";
      console.log(`    - [${call.status}] ${call.contentType} (${sizeNote}) ${call.url.slice(0, 140)}`);
    }
  }
  console.log(`  bodyTextLen:  ${bodyText.length}`);
  console.log(`  elapsedMs:    ${elapsedMs}`);

  return {
    key: target.key,
    displayName: target.displayName,
    expectedType: target.expectedType,
    url: target.url,
    status,
    httpStatus,
    finalUrl,
    title,
    navigationError,
    oddsFound: oddsMatches.length > 0,
    oddsSampleCount: oddsMatches.length,
    oddsSamples: distinctOdds,
    marketsFound,
    apiCalls: sampleApiCalls,
    distinctApiHosts,
    bodyTextLen: bodyText.length,
    elapsedMs,
  };
}

async function main() {
  console.log("[inspect-foreign-sources] Startar inventering. Stealth Chromium, ingen bypass.\n");
  const results = [];
  for (const target of TARGETS) {
    try {
      const r = await inspect(target);
      results.push(r);
    } catch (err) {
      console.error(`[inspect-foreign-sources] ${target.displayName} kraschade: ${err?.message ?? err}`);
      results.push({
        key: target.key,
        displayName: target.displayName,
        status: "error",
        navigationError: err?.message ?? String(err),
      });
    }
  }

  console.log("\n═══ SAMMANFATTNING ═══");
  for (const r of results) {
    console.log(
      `  ${r.displayName.padEnd(22)} status=${(r.status ?? "?").padEnd(14)} oddsFound=${String(r.oddsFound ?? false).padEnd(5)} markets=[${(r.marketsFound ?? []).join(",")}] apiCalls=${r.apiCalls?.length ?? 0}`,
    );
  }
}

main().catch((err) => {
  console.error("[inspect-foreign-sources] fatal:", err);
  process.exit(1);
});
