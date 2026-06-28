#!/usr/bin/env node
/**
 * recon-tier2-backends.mjs — fångar sportsbook-API-endpoints för de nya sajterna
 * (888sport, 10bet, prontosport, tipwin) så vi kan bygga skrapor utan att rendera
 * varje gång. Laddar varje sajt via stealth-Chromium, fångar alla API-anrop +
 * JSON-svar (events/odds/markets), identifierar backend, och dumpar topp-endpoints
 * med svars-prov.
 *
 * Körs i GitHub Actions BAKOM Mullvad-WireGuard (svensk exit-IP) — samma infra som
 * betsson-fetch.yml. Output: data/_recon-tier2-backends.json.
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";

chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-tier2-backends.json");
const log = (...a) => console.log("[tier2]", ...a);

const SITES = [
  // Round 2: peka på FOTBOLL-vyerna (där odds-feeden faktiskt triggas) + längre väntan + WS-fångst.
  ["888sport",   ["https://www.888sport.se/fotboll/", "https://www.888sport.se/sport/fotboll", "https://www.888sport.se/"]],
  ["10bet",      ["https://www.10bet.se/sports/football", "https://www.10bet.se/sports", "https://www.10bet.se/sv/sports", "https://www.10bet.se/home-page"]],
  ["prontosport", ["https://sb.prontosport.se/sv/euro/sport/1", "https://sb.prontosport.se/sv/euro/home", "https://www.prontosport.se/?bt-path=/euro/home"]],
  ["tipwin",     ["https://tipwin.se/sv/sports/highlights", "https://tipwin.se/sv/sports/soccer", "https://tipwin.se/sv/home/full/highlights", "https://www.tipwin.se/"]],
];

// backend-signaturer
const SIG = [
  [/kambi|kambicdn|\/offering\//i, "Kambi"],
  [/biahosted|altenar/i, "Altenar"],
  [/bcapps|betconstruct|sportsbookv2|swarm/i, "BetConstruct"],
  [/digitain|dgsts/i, "Digitain"],
  [/betby\.com|sptpub|sb2\.|\bbetby\b|bt-renderer/i, "Betby"],
  [/sbtech|sportsbook\.sg|geocomply/i, "SBTech"],
  [/spectate|888spectate|ips-/i, "Spectate (888)"],
  [/playtech|ptawe|geneity|butlerbet|whichbingo/i, "Playtech"],
  [/sportradar|betradar/i, "Sportradar"],
  [/sportnco|gig-|gigsport/i, "GiG/Sportnco"],
  [/oddin|delasport|logifuture/i, "Delasport/annan B2B"],
];

// API-liknande endpoints (events/odds/markets/sport)
const API_RE = /\/(api|sb|sbgate|event|fixture|sport|match|odds|market|widget|search|fsb|fed|prematch|live|catalog|feed|offering|getupcoming|listview)\b/i;
const IGNORE = /(cloudflare|googletag|google-analytics|gstatic|optimizely|hotjar|doubleclick|sentry|datadog|amplitude|segment|cloudfront\.net|akamai|tealium|facebook|cookiebot|onetrust|recaptcha|fonts\.|\.png|\.jpg|\.svg|\.css|\.woff)/i;

async function probeSite(browser, name, urls) {
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 850 } });
  const hosts = new Map();
  const apiHits = new Map(); // url-key → {url, method, status, ct, sample}
  let backend = null;

  ctx.on("request", (r) => {
    const u = r.url();
    try { const h = new URL(u).hostname; hosts.set(h, (hosts.get(h) || 0) + 1); } catch { /* */ }
    if (!backend) for (const [re, label] of SIG) if (re.test(u)) { backend = label; break; }
  });
  ctx.on("response", async (resp) => {
    const u = resp.url();
    if (IGNORE.test(u) || !API_RE.test(u)) return;
    const ct = resp.headers()["content-type"] || "";
    if (!/json|text/i.test(ct)) return;
    const key = u.split("?")[0];
    if (apiHits.has(key)) return;
    let sample = "";
    try { const t = await resp.text(); sample = t.slice(0, 400); } catch { /* */ }
    apiHits.set(key, { url: u.slice(0, 300), method: resp.request().method(), status: resp.status(), ct: ct.slice(0, 60), sample });
  });

  const page = await ctx.newPage();
  // WebSocket-fångst: odds-feeds (Spectate/Playtech/ABM) pushar ofta via WS.
  const sockets = new Map();
  page.on("websocket", (ws) => {
    const u = ws.url();
    if (IGNORE.test(u)) return;
    const rec = { url: u.slice(0, 250), frames: [] };
    sockets.set(u, rec);
    if (!backend) for (const [re, label] of SIG) if (re.test(u)) { backend = label; break; }
    ws.on("framereceived", (f) => {
      if (rec.frames.length < 3) {
        const data = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? "");
        if (data && data.length > 20) rec.frames.push(data.slice(0, 300));
      }
    });
  });
  let loaded = false, usedUrl = null;
  for (const url of urls) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); loaded = true; usedUrl = url; break; } catch { /* */ }
  }
  if (loaded) {
    for (const t of ["Acceptera alla", "Godkänn alla", "Tillåt alla", "Accept all", "Acceptera", "OK", "Jag förstår"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(20000); // låt SPA + odds-feed (XHR/WS) ladda
  }
  const topHosts = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => `${h}(${n})`);
  const api = [...apiHits.values()].slice(0, 30);
  const ws = [...sockets.values()].slice(0, 8);
  await ctx.close();
  log(`${name.padEnd(12)} backend=${backend || (loaded ? "okänd" : "EJ LADDAD")} api=${api.length} ws=${ws.length}`);
  return { name, loaded, usedUrl, backend: backend || (loaded ? "okänd" : "kunde ej ladda"), topHosts, api, ws };
}

async function main() {
  const browser = await chromiumExtra.launch({
    headless: process.env.HEADFUL !== "1",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const report = { ranAt: new Date().toISOString(), sites: [] };
  for (const [name, urls] of SITES) {
    try { report.sites.push(await probeSite(browser, name, urls)); }
    catch (e) { report.sites.push({ name, error: String(e?.message ?? e).slice(0, 200) }); log(`${name} FEL: ${e?.message}`); }
  }
  await browser.close();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  log("klart →", OUT);
}
main().catch((e) => { console.error("[tier2] FATALT:", e?.message ?? e); process.exit(1); });
