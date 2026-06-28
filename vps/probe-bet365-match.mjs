#!/usr/bin/env node
/**
 * bet365 DIY-probe v7 — testar ENSKILD MATCH-vy (inte fler-match-kupong).
 * Hypotes: en match-detaljsida renderar sin 1X2 i DOM även när kuponger inte gör det.
 *
 * Navigerar: home → "Allsvenskan" (→ ev. match) → om liga-lista, klicka första matchen.
 * Bred DOM-dump (pierce shadow) + WS-odds-frame-fångst i varje steg.
 *
 * Kör: HEADFUL=1 xvfb-run -a ip netns exec mv node vps/probe-bet365-match.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[b365-match]", ...a);
const esc = (s) => String(s).replace(/[\x00-\x1f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));

async function dump(page, label) {
  const d = await page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? "").trim();
    let shadowHosts = 0;
    const odds = [], teams = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        const c = el.className?.toString?.() ?? "";
        if (/Odds/.test(c) && odds.length < 16) odds.push({ cls: c.slice(0, 50), txt: txt(el).slice(0, 16) });
        if (/_Team\b|FixtureDetails|Participant_Name/.test(c) && teams.length < 12) teams.push(txt(el).slice(0, 40));
        if (el.shadowRoot) { shadowHosts++; walk(el.shadowRoot); }
      }
    };
    walk(document);
    return { url: location.href, shadowHosts, oddsCount: document.querySelectorAll("[class*='Odds']").length, teamCount: document.querySelectorAll("[class*='_Team']").length, oddsSamples: odds, teamSamples: teams };
  }).catch((e) => ({ error: String(e) }));
  log(`--- DUMP (${label}) ---`);
  console.log(JSON.stringify(d, null, 1));
  return d;
}

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1" ? true : false, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    Object.defineProperty(document, "hidden", { get: () => false });
  });
  const page = await ctx.newPage();

  let totalWs = 0; const oddsFrames = [];
  const ODDS_RE = /;(NA|OD|HA|MA|PA|FI|CT|HD)=|\bMA;|\d+\.\d+/;
  page.on("websocket", (ws) => ws.on("framereceived", (f) => {
    totalWs++;
    const p = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? "");
    if (p && ODDS_RE.test(p) && p.length > 30 && oddsFrames.length < 5) oddsFrames.push(esc(p).slice(0, 700));
  }));

  log("laddar home...");
  await page.goto("https://www.bet365.com/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => log("nav-fel", e.message));
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(12_000);

  // Klicka "Allsvenskan" robust
  log("klickar Allsvenskan...");
  let nav = false;
  for (const loc of [() => page.getByText("Allsvenskan", { exact: true }), () => page.locator("text=Allsvenskan"), () => page.getByText("Helgens fotboll", { exact: false })]) {
    try { await loc().first().click({ timeout: 6000 }); nav = true; break; } catch {}
  }
  log("nav lyckades:", nav, "url:", page.url());
  await page.waitForTimeout(12_000);
  let d1 = await dump(page, "efter Allsvenskan-klick");

  // Om inga odds: försök klicka in i första matchen/fixturen
  if (!d1.oddsCount) {
    log("inga odds — försöker klicka in i en match...");
    let mclick = false;
    for (const sel of ["[class*='FixtureDetails']", "[class*='ParticipantFixtureDetails']", "[class*='Fixture_']", "[class*='Rnk']"]) {
      try { await page.locator(sel).first().click({ timeout: 5000 }); mclick = true; break; } catch {}
    }
    log("match-klick lyckades:", mclick, "url:", page.url());
    await page.waitForTimeout(12_000);
    await dump(page, "efter match-klick");
  }

  await page.screenshot({ path: "/root/bet365-match.png" }).catch(() => {});
  log("=== WS: totalt", totalWs, "| odds-frames", oddsFrames.length, "===");
  oddsFrames.forEach((p, i) => console.log(`  WS[${i}] ${p}`));
  await browser.close();
}
main().catch((e) => { console.error("[b365-match] FATALT:", e?.message ?? e); process.exit(1); });
