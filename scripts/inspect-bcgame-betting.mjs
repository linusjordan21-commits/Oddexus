#!/usr/bin/env node
/**
 * BC.Game Betting (betting.bc.game) — inventory + classification.
 *
 * Mål: avgöra om sidan är:
 *   A) bookmaker_source           — publikt placerbara odds i HTML/API
 *   B) external_prediction_signal — predictions/tips/content utan placerbara priser
 *   C) blocked_or_no_odds         — kräver login eller saknar publik data
 *
 * Vi använder samma stealth Chromium-setup som SportyBet/Bet7-inspekt.
 * Sniffar passivt alla XHR/fetch + extraherar internal links från HTML för
 * att hitta sport/match/event-paths. Inga inloggningar, ingen captcha-lösning.
 *
 * Output: data/_inspect-bcgame.json (gitignored).
 */

import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const TARGETS = [
  "https://betting.bc.game/",
  "https://betting.bc.game/predictions",
  "https://betting.bc.game/predictions/football",
  "https://betting.bc.game/football",
  "https://betting.bc.game/sport/football",
  "https://betting.bc.game/sports/football",
];

const ODDS_RE = /\b([1-9]\d?\.\d{2})\b/g;
const INTERESTING_API_RE =
  /\/(api|graphql|odds|sportsbook|prematch|live|events|markets|fixtures|matches|sport|football|tournaments|leagues|predictions|tips|outright|fixture)\b/i;
const BLOCK_TITLE_RE =
  /just a moment|attention required|access denied|cloudflare|403 forbidden|404 not found|please verify|are you human|login required/i;
const LOGIN_HINT_RE = /(sign in|log in|create account|register|connect wallet)/i;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const OUT = path.resolve(process.cwd(), "data/_inspect-bcgame.json");

async function probe(browser, url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    userAgent: UA,
  });

  const apiCalls = [];
  context.on("response", async (response) => {
    try {
      const req = response.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const u = response.url();
      if (!INTERESTING_API_RE.test(u)) return;
      const status = response.status();
      const ct = response.headers()["content-type"] ?? "";
      let bodyLen = 0;
      let bodyPreview = null;
      if (ct.includes("application/json") && status === 200) {
        try {
          const txt = await response.text();
          bodyLen = txt.length;
          if (txt.length < 100_000) {
            try {
              const json = JSON.parse(txt);
              // Trimmad preview — bara top-level keys + sample
              bodyPreview = previewJson(json, 4);
            } catch {
              // ej JSON
            }
          }
        } catch {
          /* ignore */
        }
      }
      apiCalls.push({
        url: u,
        method: req.method(),
        status,
        contentType: ct,
        bodyLen,
        bodyPreview,
      });
    } catch {
      /* ignore */
    }
  });

  const page = await context.newPage();
  const started = Date.now();
  let httpStatus = null;
  let finalUrl = null;
  let title = null;
  let bodyText = "";
  let htmlLen = 0;
  let internalLinks = [];
  let navError = null;

  try {
    const nav = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    httpStatus = nav ? nav.status() : null;
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
    await page.waitForTimeout(3_000);

    finalUrl = page.url();
    title = await page.title().catch(() => "");
    bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 40_000) ?? "").catch(() => "");
    htmlLen = await page.evaluate(() => document.documentElement?.outerHTML?.length ?? 0).catch(() => 0);
    internalLinks = await page
      .evaluate(() => {
        const out = [];
        const host = window.location.host;
        for (const a of document.querySelectorAll("a[href]")) {
          try {
            const href = a.getAttribute("href") ?? "";
            if (!href) continue;
            const abs = new URL(href, window.location.origin).toString();
            if (new URL(abs).host === host) out.push(abs);
          } catch {
            /* ignore */
          }
        }
        return [...new Set(out)].slice(0, 80);
      })
      .catch(() => []);
  } catch (err) {
    navError = err instanceof Error ? err.message : String(err);
  }
  await context.close().catch(() => {});

  const oddsMatches = bodyText.match(ODDS_RE) ?? [];
  const distinctOdds = [...new Set(oddsMatches)].slice(0, 10);

  const titleBlocked = title ? BLOCK_TITLE_RE.test(title) : false;
  const loginHinted = LOGIN_HINT_RE.test(bodyText.slice(0, 4000));

  return {
    url,
    httpStatus,
    finalUrl,
    title,
    titleBlocked,
    loginHinted,
    htmlLen,
    bodyTextLen: bodyText.length,
    oddsCount: oddsMatches.length,
    oddsSample: distinctOdds,
    apiCount: apiCalls.length,
    apiSample: apiCalls.slice(0, 12),
    internalLinkCount: internalLinks.length,
    internalLinksSample: internalLinks.slice(0, 20),
    elapsedMs: Date.now() - started,
    navError,
  };
}

function previewJson(value, maxDepth, depth = 0) {
  if (depth > maxDepth) return "[…depth limit…]";
  if (value === null) return null;
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const sliced = value.slice(0, 3).map((v) => previewJson(v, maxDepth, depth + 1));
    if (value.length > 3) sliced.push(`[+${value.length - 3} more]`);
    return sliced;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = previewJson(v, maxDepth, depth + 1);
  }
  return out;
}

function classify(results) {
  const hasAnyOdds = results.some((r) => r.oddsCount > 5);
  const hasAnyApi = results.some((r) => r.apiCount > 0);
  const allBlocked = results.every((r) => r.titleBlocked || r.httpStatus === 403);
  const allEmpty = results.every((r) => (r.bodyTextLen ?? 0) < 200 && r.apiCount === 0);
  const predictionHints = results.some((r) =>
    /prediction|tip|analysis|advice|forecast/i.test(`${r.title} ${r.bodyText ?? ""}`),
  );

  if (allBlocked || allEmpty) return "blocked_or_no_odds";
  if (hasAnyOdds && hasAnyApi) {
    return "candidate_bookmaker_source"; // behöver ytterligare djupanalys
  }
  if (predictionHints) return "external_prediction_signal";
  return "needs_investigation";
}

async function main() {
  console.log("[bcgame-inspect] Launching stealth Chromium…");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const results = [];

  // First pass: spec paths
  for (const url of TARGETS) {
    console.log(`\n── ${url}`);
    const r = await probe(browser, url);
    console.log(`  HTTP ${r.httpStatus}  final=${r.finalUrl}`);
    console.log(`  title="${r.title}"  htmlLen=${r.htmlLen}  bodyTextLen=${r.bodyTextLen}`);
    console.log(`  titleBlocked=${r.titleBlocked}  loginHinted=${r.loginHinted}`);
    console.log(`  oddsCount=${r.oddsCount}  apiCount=${r.apiCount}  linkCount=${r.internalLinkCount}`);
    if (r.oddsSample.length > 0) console.log(`  oddsSample=[${r.oddsSample.join(", ")}]`);
    if (r.apiSample.length > 0) {
      console.log(`  apiSample (first 5):`);
      for (const a of r.apiSample.slice(0, 5)) {
        console.log(`    [${a.status}] ${a.bodyLen}B  ${a.url.slice(0, 140)}`);
      }
    }
    if (r.internalLinksSample.length > 0) {
      console.log(`  internalLinks (first 5):`);
      for (const l of r.internalLinksSample.slice(0, 5)) console.log(`    ${l}`);
    }
    if (r.navError) console.log(`  ERROR: ${r.navError}`);
    results.push(r);
  }

  // Second pass: follow up to 5 distinct internal links not already covered.
  const seen = new Set(TARGETS);
  const candidates = [];
  for (const r of results) {
    for (const l of r.internalLinksSample) {
      if (seen.has(l)) continue;
      // Prioritera URLs som ser ut som sport/match/event
      if (/(football|soccer|match|event|prediction|fixture|league|tournament|bet)/i.test(l)) {
        candidates.push(l);
      }
    }
  }
  const uniqueCandidates = [...new Set(candidates)].slice(0, 5);
  if (uniqueCandidates.length > 0) {
    console.log(`\n── Probing ${uniqueCandidates.length} discovered links`);
    for (const url of uniqueCandidates) {
      const r = await probe(browser, url);
      console.log(`  ${url}`);
      console.log(`    HTTP ${r.httpStatus}  htmlLen=${r.htmlLen}  odds=${r.oddsCount}  apis=${r.apiCount}`);
      if (r.oddsSample.length > 0) console.log(`    oddsSample=[${r.oddsSample.join(", ")}]`);
      results.push(r);
    }
  }

  await browser.close().catch(() => {});

  const verdict = classify(results);
  console.log(`\n═══ VERDICT ═══`);
  console.log(`  total paths probed:    ${results.length}`);
  console.log(`  any with odds (>5):    ${results.some((r) => r.oddsCount > 5)}`);
  console.log(`  any with API calls:    ${results.some((r) => r.apiCount > 0)}`);
  console.log(`  any blocked title:     ${results.some((r) => r.titleBlocked)}`);
  console.log(`  any login-hinted:      ${results.some((r) => r.loginHinted)}`);
  console.log(`  classification:        ${verdict}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), verdict, results }, null, 2));
  console.log(`\n  ✓ Wrote ${OUT}`);
}

main().catch((err) => {
  console.error("[bcgame-inspect] fatal:", err);
  process.exit(1);
});
