#!/usr/bin/env node
/**
 * recon-pinnacle-corners.mjs — RECON: kartlägg Pinnacles HÖRN-marknader (corners).
 *
 * Vår pinnacle-scraper hämtar /matchups + /markets/straight men TRIMMAR bort allt
 * utom huvudmatchens moneyline/spread/total (mål). Hörn-marknader finns i SAMMA feed
 * som SPECIAL-matchups (matchup.special = { category, ... } + parent → huvudmatchen).
 * Vi vet inte exakt fältstruktur → denna probe dumpar den så vi kan bygga en korrekt
 * corner-ladder-parser (sharp referens) UTAN att gissa.
 *
 * Återanvänder pinnacle-scraperns stealth-Chromium-approach (context.request förbi CF).
 * Output: data/_pinnacle-corner-recon.json (committas tillbaka). Ingen prod-påverkan.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const BASE = "https://guest.api.arcadia.pinnacle.com";
const SITE = "https://www.pinnacle.com";
const KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";
const SOCCER = 29;
const OUT = path.resolve(process.cwd(), "data", "_pinnacle-corner-recon.json");

async function main() {
  const out = { ranAt: new Date().toISOString() };
  const browser = await chromiumExtra.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: "en-US",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const H = { accept: "application/json", "x-api-key": KEY, origin: SITE, referer: `${SITE}/` };
    const getJ = async (p) => {
      try { const r = await context.request.get(`${BASE}${p}`, { headers: H, timeout: 30000 }); return r.ok() ? await r.json() : { __status: r.status() }; }
      catch (e) { return { __err: String(e?.message ?? e).slice(0, 100) }; }
    };
    const matchups = await getJ(`/0.1/sports/${SOCCER}/matchups`);
    const markets = await getJ(`/0.1/sports/${SOCCER}/markets/straight`);
    out.matchupsCount = Array.isArray(matchups) ? matchups.length : `non-array: ${JSON.stringify(matchups).slice(0,80)}`;
    out.marketsCount = Array.isArray(markets) ? markets.length : `non-array: ${JSON.stringify(markets).slice(0,80)}`;

    if (Array.isArray(matchups)) {
      // SPECIAL-matchups: bär ett `special`-fält (kategori) och oftast `parent`.
      const specials = matchups.filter((m) => m && (m.special || m.parent != null || m.parentId != null));
      out.specialCount = specials.length;
      // Kategorisera special-matchups på special.category / description.
      const cats = {};
      for (const m of specials) {
        const c = m.special?.category ?? m.special?.description ?? m.units ?? "(okänd)";
        cats[c] = (cats[c] || 0) + 1;
      }
      out.specialCategories = cats;
      // Hitta corner-relaterade specials.
      const corners = matchups.filter((m) => /corner/i.test(JSON.stringify(m?.special ?? m?.units ?? "")));
      out.cornerMatchupCount = corners.length;
      out.cornerMatchupSamples = corners.slice(0, 3).map((m) => JSON.parse(JSON.stringify(m)));
      out.anySpecialSample = specials.slice(0, 2).map((m) => JSON.parse(JSON.stringify(m)));

      // Koppla corner-markets: markets vars matchupId tillhör en corner-matchup.
      if (Array.isArray(markets)) {
        const cornerIds = new Set(corners.map((m) => m.id));
        const cornerMarkets = markets.filter((mk) => cornerIds.has(mk.matchupId));
        out.cornerMarketCount = cornerMarkets.length;
        out.cornerMarketSamples = cornerMarkets.slice(0, 6).map((mk) => JSON.parse(JSON.stringify(mk)));
        // Marknadstyper på corner-matchups
        const mt = {};
        for (const mk of cornerMarkets) mt[`${mk.type}/p${mk.period}${mk.isAlternate ? "/alt" : ""}`] = (mt[`${mk.type}/p${mk.period}${mk.isAlternate ? "/alt" : ""}`] || 0) + 1;
        out.cornerMarketTypes = mt;
      }
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  } finally {
    await browser.close().catch(() => {});
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`[pin-corner-recon] klart → matchups=${out.matchupsCount} special=${out.specialCount} corners=${out.cornerMatchupCount} cornerMarkets=${out.cornerMarketCount}`);
}

main().catch((e) => { console.error("[pin-corner-recon] fatal:", e); process.exit(1); });
