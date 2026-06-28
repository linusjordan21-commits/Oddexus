#!/usr/bin/env node
/**
 * Extraherar EXAKT backend-identifierare per sajt (inte bara backend-namn).
 * Fångar nätverkstrafik och plockar ut:
 *   - ComeOn   franchiseCode  (wss ...?franchiseCode=X)
 *   - Altenar  integration    (...GetUpcoming?integration=X / ?integration=X)
 *   - Kambi    offering       (.../offering/v2018/<offering>/...)
 *   - Betsson  brandId        (startup-config / api/sb/ headers)
 *   - Sportradar / cdnary     (kluster — markeras för dedikerad scraper)
 *
 * Syfte: maximera antal spelkällor. Output = brand → {backend, key} så vi kan
 * bulk-adda allt som kör en backend vi redan skrapar (eller en kluster-backend).
 *
 * Kör via Mullvad (svensk exit-IP) för att undvika geo/Cloudflare-block:
 *   xvfb-run -a ip netns exec mv node vps/probe-backend-keys.mjs
 * eller headless direkt:
 *   ip netns exec mv node vps/probe-backend-keys.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[keys]", ...a);

// Kandidat-brands som ÄNNU EJ är tillagda men som troligen kör känd/kluster-backend.
const SITES = [
  // ComeOn-grupp (Cloudflare-blockad från datacenter-IP — extrahera franchiseCode)
  ["Folkeautomaten", ["https://www.folkeautomaten.com/sv/sportsbook", "https://www.folkeautomaten.com/sv/sport"]],
  ["GetLucky",       ["https://www.getlucky.com/sv/sportsbook", "https://www.getlucky.com/sv/sport"]],
  ["MobileBet",      ["https://www.mobilebet.com/sv/sportsbook", "https://www.mobilebet.com/sv/sport"]],
  ["SuperLenny",     ["https://www.superlenny.com/sv/sportsbook", "https://www.superlenny.com/sv/"]],
  ["Galaxino",       ["https://www.galaxino.com/sv/sportsbook", "https://www.galaxino.com/sv/"]],
  // Kambi (Kindred) — extrahera offering
  ["Expekt",         ["https://www.expekt.com/sv/sportsbook", "https://www.expekt.com/sv"]],
  ["MariaCasino",    ["https://www.mariacasino.se/sportsbook", "https://www.mariacasino.se/sv"]],
  ["Storspelare",    ["https://www.storspelare.com/sportsbook", "https://www.storspelare.com/"]],
  ["BingoCom",       ["https://www.bingo.com/sv/sportsbook", "https://www.bingo.com/sv/"]],
  // Sportradar-kluster (4 venues — en scraper)
  ["Casumo",         ["https://www.casumo.com/sv/sportsbook", "https://www.casumo.com/sv/"]],
  ["Betinia",        ["https://betinia.se/sv/sportsbook", "https://betinia.se/"]],
  ["Quick",          ["https://quickcasino.se/sv/sportsbook", "https://quickcasino.se/"]],
  ["Swiper",         ["https://swiper.com/sv/sports", "https://swiper.com/"]],
  // cdnary-kluster (3 venues — en scraper)
  ["FrankFred",      ["https://www.frankfred.com/sv/sports", "https://www.frankfred.com/sv/"]],
  ["Onerush",        ["https://onerush.com/sv/sports", "https://onerush.com/"]],
  ["Jubla",          ["https://jubla.com/sv/sports", "https://jubla.com/"]],
];

// identifier-extraktorer: regex med capture-grupp → {backend, key}
const EXTRACTORS = [
  { backend: "ComeOn",    re: /franchiseCode=([A-Za-z0-9_]+)/i },
  { backend: "Altenar",   re: /[?&]integration=([A-Za-z0-9_]+)/i },
  { backend: "Kambi",     re: /\/offering\/v2018\/([A-Za-z0-9_]+)\//i },
  { backend: "Sportradar",re: /(?:sportradar|betradar|ls\.betradar|widgets\.sir)/i, cluster: true },
  { backend: "cdnary",    re: /(sga\.cdnary\.com)/i, cluster: true },
  { backend: "BetConstruct", re: /(?:bcapps|betconstruct|sportsbookv2)/i, cluster: true },
];

async function main() {
  const browser = await chromiumExtra.launch({
    headless: process.env.HEADFUL !== "1",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const results = [];
  for (const [name, urls] of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", viewport: { width: 1366, height: 850 } });
    let found = null;
    const seen = new Set();
    const onUrl = (u) => {
      if (found && !found.cluster) return; // exakt nyckel funnen → klar
      for (const ex of EXTRACTORS) {
        const m = ex.re.exec(u);
        if (m) {
          const key = ex.cluster ? "(kluster — dedikerad scraper)" : m[1];
          // exakt nyckel slår kluster-match
          if (!found || (found.cluster && !ex.cluster)) found = { backend: ex.backend, key, cluster: !!ex.cluster };
          if (!ex.cluster) return;
        }
      }
    };
    ctx.on("request", (r) => { const u = r.url(); if (!seen.has(u)) { seen.add(u); onUrl(u); } });
    ctx.on("websocket", (ws) => onUrl(ws.url()));
    const page = await ctx.newPage();
    let loaded = false;
    for (const url of urls) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }); loaded = true; break; } catch {}
    }
    if (loaded) {
      for (const t of ["Acceptera alla", "Godkänn alla", "Tillåt alla", "Accept all", "Acceptera"]) {
        try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch {}
      }
      // klicka ev. in i sportbok för att trigga backend-anrop
      for (const t of ["Sport", "Sportsbook", "Sportbok", "Odds", "Betting"]) {
        try { await page.getByRole("link", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch {}
      }
      await page.waitForTimeout(10000);
    }
    const out = found
      ? `${found.backend.padEnd(12)} ${found.key}`
      : (loaded ? "okänd (ingen backend-signatur i trafiken)" : "EJ LADDAD");
    results.push({ name, ...(found || {}) });
    log(`${name.padEnd(15)} → ${out}`);
    await ctx.close();
  }
  log("\n=========== SAMMANFATTNING (brand → backend → exakt nyckel) ===========");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(15)} ${(r.backend || "okänd").padEnd(13)} ${r.key || ""}`);
  }
  await browser.close();
}
main().catch((e) => { console.error("[keys] FATALT:", e?.message ?? e); process.exit(1); });
