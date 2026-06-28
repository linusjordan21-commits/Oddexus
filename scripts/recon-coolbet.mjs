/**
 * recon-coolbet.mjs — ENGÅNGS browser-rekon av Coolbet (Imperva/Incapsula-skyddad,
 * plain fetch ger 403). Stealth-Chromium laddar odds-sidan, passerar Incapsula,
 * och FÅNGAR de faktiska XHR/fetch-anropen sidan gör (riktiga odds-API:t +
 * svarsform) → så vi bygger scrapern mot VERKLIG data, ingen gissning.
 *
 * Dumpar fångade /api/-anrop (url, status, content-type, trunkerad body) +
 * ev. __NEXT_DATA__/initial-state till data/_coolbet-recon.json (committas).
 * Inga secrets i scriptet (VPN sköts av workflowen).
 */

import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const OUT = path.resolve(process.cwd(), "data", "_coolbet-recon.json");
const HEAD = 6000;
const MAX_CAPTURED = 80;

// Solve-then-reload: ladda en sida, låt Imperva-sensorn (reese84) köra + sätta
// cookie, RELADDA tills "Pardon Our Interruption" är borta, navigera sen till odds.
const ENTRY_URL = "https://www.coolbet.com/sv/odds/recommendations";
const ODDS_URLS = [
  "https://www.coolbet.com/sv/odds/fotboll",
  "https://www.coolbet.com/sv/odds",
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Tolka COOLBET_PROXY_URL (residential/mobil-proxy) → Playwright-proxy-config.
 * Format: "http://user:pass@host:port" | "socks5://host:port" | "host:port".
 * Returnerar null om ej satt (då körs direkt, ev. via VPN).
 */
function parseProxyFromEnv() {
  const raw = (process.env.COOLBET_PROXY_URL || "").trim();
  if (!raw) return null;
  try {
    const hasScheme = /^[a-z0-9]+:\/\//i.test(raw);
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    const cfg = { server: `${u.protocol}//${u.host}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
  } catch {
    // Fallback: behandla som server-sträng utan auth.
    return { server: raw.includes("://") ? raw : `http://${raw}` };
  }
}

async function isImpervaChallenge(page) {
  try {
    const html = await page.content();
    return /Pardon Our Interruption|_Incapsula_Resource|reeseSkipExpirationCheck|Request unsuccessful\. Incapsula/i.test(html);
  } catch { return true; }
}

async function main() {
  const results = { ranAt: new Date().toISOString(), navigations: [], captured: [], apiHosts: {}, nextDataKeys: null, error: null };
  const seen = new Set();

  const proxy = parseProxyFromEnv();
  results.usingProxy = !!proxy;
  if (proxy) console.log(`[coolbet-recon] routar via proxy ${proxy.server}${proxy.username ? " (auth)" : ""}`);
  else console.log("[coolbet-recon] ingen COOLBET_PROXY_URL — kör direkt (ev. via VPN)");
  const launchProxy = proxy ? { proxy } : {};

  // RIKTIG Google Chrome (channel "chrome") headful via xvfb → mycket mer
  // övertygande fingerprint för Imperva ABP än bundlad Chromium. Faller tillbaka
  // på Chromium om Chrome ej installerad.
  let browser;
  try {
    browser = await chromiumExtra.launch({
      channel: "chrome",
      headless: false,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--window-size=1440,900"],
      ...launchProxy,
    });
    results.browserChannel = "chrome";
  } catch (e) {
    console.warn("[coolbet-recon] chrome-channel saknas, faller tillbaka på chromium:", e?.message ?? e);
    browser = await chromiumExtra.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--window-size=1440,900"],
      ...launchProxy,
    });
    results.browserChannel = "chromium";
  }
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "sv-SE",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Fånga svar: filtrera till sannolika odds-API:er (json eller /api/, sb, sport, odds, offering).
    page.on("response", async (resp) => {
      try {
        if (results.captured.length >= MAX_CAPTURED) return;
        const url = resp.url();
        const ct = resp.headers()["content-type"] || "";
        const looksApi = /\/api\/|sportsbook|\/sb\/|graphql|odds|offering|matches|events|markets/i.test(url);
        const isJson = /json/i.test(ct);
        if (!looksApi && !isJson) return;
        if (/\.(png|jpe?g|svg|gif|woff2?|css|js)(\?|$)/i.test(url)) return;
        const key = url.split("?")[0] + "|" + resp.request().method();
        if (seen.has(key)) return;
        seen.add(key);
        let bodyHead = null, bodyLength = 0;
        try { const t = await resp.text(); bodyLength = t.length; bodyHead = t.slice(0, HEAD); } catch { /* binär/redirect */ }
        try { const h = new URL(url).host; results.apiHosts[h] = (results.apiHosts[h] || 0) + 1; } catch { /* */ }
        results.captured.push({ url, method: resp.request().method(), status: resp.status(), contentType: ct, bodyLength, bodyHead });
      } catch { /* ignorera */ }
    });

    // ── Steg 1: ladda entry-URL EN gång + PASSIV auto-clear ──
    // Imperva reese84-interstitialen självsubmittar + reloadar. Tidigare manuella
    // re-goto motarbetade det → 403. Nu: ladda en gång, mänsklig jitter, vänta
    // passivt (poll) tills challengen försvinner av sig själv.
    let cleared = false;
    const entryNav = { target: ENTRY_URL, attempt: 1, status: null, challenge: null, title: null, error: null, polls: [] };
    try {
      const r = await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      entryNav.status = r?.status() ?? null;
      // Mänsklig interaktion → reese84 mäter beteende/timing.
      for (let k = 0; k < 6; k += 1) {
        try { await page.mouse.move(200 + Math.random() * 900, 150 + Math.random() * 600, { steps: 8 }); } catch { /* */ }
        try { await page.mouse.wheel(0, 200 + Math.random() * 400); } catch { /* */ }
        await sleep(1200 + Math.random() * 800);
      }
      // Passiv poll upp till ~50s: låt interstitialen självsubmitta + reloada.
      for (let p = 0; p < 16; p += 1) {
        await sleep(3000);
        const ch = await isImpervaChallenge(page);
        const url = page.url();
        entryNav.polls.push({ p, ch, status: null, url: url.slice(0, 80) });
        if (!ch) { cleared = true; break; }
        // liten jitter mellan polls
        try { await page.mouse.move(300 + Math.random() * 600, 200 + Math.random() * 400, { steps: 5 }); } catch { /* */ }
      }
      entryNav.challenge = await isImpervaChallenge(page);
      entryNav.title = await page.title().catch(() => null);
    } catch (e) { entryNav.error = e?.message ?? String(e); }
    results.navigations.push(entryNav);
    console.log(`[coolbet-recon] entry → status=${entryNav.status} cleared=${cleared} challenge=${entryNav.challenge} polls=${entryNav.polls.length} ${entryNav.error || ""}`);
    results.clearedImperva = cleared;

    // ── Steg 2: navigera till odds-sidor + fånga riktiga API-anrop ──
    const oddsTargets = cleared ? ODDS_URLS : [ENTRY_URL]; // om ej clearat: stanna kvar, fånga vad vi kan
    for (const target of oddsTargets) {
      const nav = { target, phase: "odds", ok: false, status: null, challenge: null, title: null, error: null };
      try {
        const r = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
        nav.status = r?.status() ?? null;
        await sleep(4000);
        try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch { /* */ }
        try { await page.mouse.wheel(0, 4000); await sleep(3000); } catch { /* */ }
        nav.challenge = await isImpervaChallenge(page);
        nav.title = await page.title().catch(() => null);
        nav.ok = true;
        if (!results.nextDataKeys) {
          const nd = await page.evaluate(() => {
            const el = document.getElementById("__NEXT_DATA__");
            if (el?.textContent) { try { return Object.keys(JSON.parse(el.textContent)); } catch { return ["__NEXT_DATA__ (parse-fel)"]; } }
            const w = window;
            const hint = Object.keys(w).filter((k) => /state|store|config|odds|sb|sportsbook|apollo|__/i.test(k)).slice(0, 40);
            return hint.length ? hint : null;
          }).catch(() => null);
          if (nd) results.nextDataKeys = nd;
        }
      } catch (e) { nav.error = e?.message ?? String(e); }
      results.navigations.push(nav);
      console.log(`[coolbet-recon] odds ${target} → status=${nav.status} challenge=${nav.challenge} captured=${results.captured.length} ${nav.error || ""}`);
      if (results.captured.length >= MAX_CAPTURED) break;
    }
    await context.close();
  } catch (e) {
    results.error = e?.message ?? String(e);
  } finally {
    await browser.close().catch(() => {});
  }

  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`[coolbet-recon] skrev ${OUT} (${results.captured.length} fångade anrop, hosts=${Object.keys(results.apiHosts).join(",")})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
