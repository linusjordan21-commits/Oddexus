/**
 * Run this from your normal Mac terminal (NOT inside Cursor's sandboxed shell):
 *   cd /Users/lilgan/Downloads/matched-betting-project
 *   node scripts/probe-blocked-sites.mjs > probe-output.txt
 *
 * Then paste probe-output.txt back to the assistant. We use it to discover the actual API
 * endpoints each site calls so we can scrape them efficiently (not page-render every time).
 *
 * It opens each site once in headless Chromium, lets the page run for ~7 seconds, and prints
 * every relevant network request. CF challenges are auto-solved by the browser.
 */
import { chromium } from "playwright";

const SITES = [
  { name: "DBET", url: "https://www.dbet.com/sv/sportsbook" },
  { name: "MrVegas", url: "https://www.mrvegas.com/sv/sport" },
  { name: "MegaRiches", url: "https://www.megariches.com/sv/sport" },
  { name: "Betsson", url: "https://www.betsson.com/sv/odds" },
];

const interesting = /\/(api|sb|event|fixture|sport|match|odds|widget|search|fsb|fed|playtech)\b/i;
const ignoreHosts = /(cloudflare|googletagmanager|google-analytics|optimizely|hotjar|doubleclick|sentry|datadoghq|amplitude|segment|cloudfront\.net|akamai|tealium)/i;

const browser = await chromium.launch({ headless: true });

for (const site of SITES) {
  console.log(`\n============================== ${site.name}`);
  console.log(`URL:                          ${site.url}`);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
  });
  const page = await context.newPage();
  const apiHits = new Map();
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("http")) return;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (ignoreHosts.test(u.hostname)) return;
    if (!interesting.test(u.pathname) && !interesting.test(u.search)) return;
    const key = `${req.method()} ${u.origin}${u.pathname}`;
    apiHits.set(key, (apiHits.get(key) ?? 0) + 1);
  });
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!url.startsWith("http")) return;
    let u;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (ignoreHosts.test(u.hostname)) return;
    if (!interesting.test(u.pathname)) return;
    const ct = (resp.headers()["content-type"] ?? "").split(";")[0];
    if (!/json|javascript/i.test(ct)) return;
    try {
      const body = await resp.text();
      if (body.length > 30 && body.length < 6000) {
        console.log(`  RESP ${resp.status()} ${u.origin}${u.pathname}`);
        console.log(`       ${body.slice(0, 400).replace(/\n/g, " ")}`);
      }
    } catch {
      // Body already consumed or aborted.
    }
  });

  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(8000);
    console.log(`title:                        ${await page.title()}`);
  } catch (e) {
    console.log(`error:                        ${e.message?.slice(0, 100)}`);
  }
  console.log(`Distinct API endpoints:       ${apiHits.size}`);
  for (const [u, count] of [...apiHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  [${count.toString().padStart(2, " ")}] ${u}`);
  }
  await context.close();
}

await browser.close();
console.log("\n============================== done");
