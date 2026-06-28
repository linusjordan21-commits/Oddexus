#!/usr/bin/env node
/**
 * bet365 DIY-probe v6 — jagar faktiska odds-frames i /zap/-WS-strömmen.
 *
 * Strategi:
 *  - Tvinga document.visibilityState=visible (bet365 prenumererar ev. bara när synlig).
 *  - Ladda hemsidan, vänta in WS-session, navigera in i en riktig liga (Allsvenskan).
 *  - Vänta länge (odds strömmar 20-30s efter mount), fånga ALLA WS-frames och
 *    flagga de som ser ut att innehålla odds (NA=/OD=/MA/PA fält-koder).
 *
 * Kör headful via Xvfb genom Mullvad:
 *   HEADFUL=1 xvfb-run -a ip netns exec mv node vps/probe-bet365-football.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const LEAGUE = process.env.BET365_LEAGUE || "Allsvenskan";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[b365-fb]", ...a);
const esc = (s) => String(s).replace(/[\x00-\x1f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));

async function main() {
  const HEADFUL = process.env.HEADFUL === "1";
  log("läge:", HEADFUL ? "HEADFUL (Xvfb)" : "headless");
  const browser = await chromiumExtra.launch({
    headless: !HEADFUL,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1600, height: 1000 } });

  // Tvinga "synlig" — bet365 prenumererar/renderar ev. bara för fokuserad flik.
  await ctx.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    Object.defineProperty(document, "hidden", { get: () => false });
    Object.defineProperty(document, "hasFocus", { value: () => true });
    window.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
  });

  const page = await ctx.newPage();

  // Fånga WS-frames; spara de som ser ut som odds (fält-koder).
  let total = 0;
  const oddsFrames = [];
  const ODDS_RE = /;(NA|OD|HA|MA|PA|FI|CT)=|\bMA;|\/\d+|\d+\.\d+/;
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      total++;
      const p = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? "");
      if (p && ODDS_RE.test(p) && oddsFrames.length < 6) oddsFrames.push(esc(p).slice(0, 600));
    });
  });

  log("laddar hemsidan...");
  await page.goto("https://www.bet365.com/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => log("nav-fel:", e.message));
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(15_000); // låt app + WS-session etablera sig

  log(`navigerar in i "${LEAGUE}"...`);
  try {
    await page.getByText(LEAGUE, { exact: false }).first().click({ timeout: 8_000 });
  } catch { log("kunde ej klicka liga-länk"); }
  // Odds strömmar in en stund efter mount — vänta tålmodigt + lite scroll/mus.
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(800, 400 + i * 40).catch(() => {});
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(4_000);
  }

  const dom = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? "").trim();
    const teams = [...document.querySelectorAll("[class*='_Team'],[class*='FixtureDetails']")].slice(0, 8).map((e) => txt(e).slice(0, 40)).filter(Boolean);
    const odds = [...document.querySelectorAll("[class*='Odds']")].slice(0, 10).map((e) => txt(e).slice(0, 16)).filter(Boolean);
    return { url: location.href, oddsEls: document.querySelectorAll("[class*='Odds']").length, teamEls: document.querySelectorAll("[class*='_Team']").length, teams, odds };
  }).catch((e) => ({ error: String(e) }));

  await page.screenshot({ path: "/root/bet365-football.png" }).catch(() => {});

  log("=========== RESULTAT ===========");
  log("WS-frames totalt:", total);
  log("ODDS-LIKNANDE FRAMES:", oddsFrames.length);
  oddsFrames.forEach((p, i) => console.log(`  [${i}] ${p}`));
  log("DOM:", JSON.stringify(dom, null, 1));
  log("================================");
  await browser.close();
}
main().catch((e) => { console.error("[b365-fb] FATALT:", e?.message ?? e); process.exit(1); });
