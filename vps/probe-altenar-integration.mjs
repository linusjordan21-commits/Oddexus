#!/usr/bin/env node
/**
 * Upptäck sportsbook-backend + ev. Altenar `integration`-nyckel för en sida.
 * Bred variant: accepterar cookies, väntar, dumpar ALLA domäner + iframes +
 * flaggar integration/GetUpcoming/widget-anrop.
 *
 * Kör:  SITE_URL=https://happycasino.se/sports node vps/probe-altenar-integration.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const SITE = process.env.SITE_URL || "https://happycasino.com/fi";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[altenar-id]", ...a);

async function main() {
  const browser = await chromiumExtra.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const integrations = new Set();
  const apiUrls = new Set();
  const seen = (url) => {
    try {
      const u = new URL(url);
      const integ = u.searchParams.get("integration") || u.searchParams.get("integrationName");
      if (integ) integrations.add(integ);
      // Fånga allt som ser ut som data/odds-API (oavsett domän)
      if (/api|get|event|sport|odds|widget|integration|book|market|biahosted|altenar|fixture|prematch|upcoming/i.test(u.pathname + u.search))
        apiUrls.add((u.hostname + u.pathname + u.search).slice(0, 130));
    } catch {}
  };
  page.on("request", (r) => seen(r.url()));

  log("laddar", SITE);
  await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => log("nav-fel:", e.message));
  await page.waitForTimeout(4000);
  // Acceptera Cookiebot (specifika ID:n) + fallback på text
  const cookieSelectors = [
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "#CybotCookiebotDialogBodyLevelButtonAccept",
  ];
  for (const sel of cookieSelectors) {
    try { await page.locator(sel).first().click({ timeout: 3000 }); log("accepterade cookies:", sel); break; } catch {}
  }
  for (const t of ["Tillåt alla", "Acceptera alla", "Godkänn alla", "Allow all", "Accept all", "Accept"]) {
    try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 2000 }); log("klickade cookie-text:", t); break; } catch {}
  }
  await page.waitForTimeout(6000);
  // Navigera in i sport-sektionen (finska/svenska/engelska)
  for (const t of ["Vedonlyönti", "Urheilu", "Sport", "Sports", "Odds", "Live", "Betting"]) {
    try { await page.getByText(t, { exact: false }).first().click({ timeout: 3000 }); log("klickade sport-nav:", t); break; } catch {}
  }
  await page.waitForTimeout(18000);

  const frames = page.frames().map((f) => f.url()).filter((u) => u && u !== "about:blank");

  log("=========== RESULTAT ===========");
  log("integration-nyckel(ar):", integrations.size ? [...integrations] : "(ingen)");
  log("iframes:", frames.length ? frames.map((u) => u.slice(0, 80)) : "(inga)");
  log(`data/odds-liknande anrop (${apiUrls.size}):`);
  [...apiUrls].slice(0, 30).forEach((u) => console.log("   ", u));
  log("================================");
  await browser.close();
}
main().catch((e) => { console.error("[altenar-id] FATALT:", e?.message ?? e); process.exit(1); });
