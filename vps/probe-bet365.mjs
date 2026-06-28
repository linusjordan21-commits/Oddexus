#!/usr/bin/env node
/**
 * Genomförbarhets-probe för bet365 — INTE en scraper, bara en sond.
 *
 * Startar stealth-Chromium (samma setup som comeon/betsson), navigerar bet365,
 * och rapporterar vad vi möter: laddas sidan, blockeras vi (geo/bot), och syns
 * odds-element i DOM:en. Sparar även en skärmdump för manuell inspektion.
 *
 * Körs på VPS:en GENOM Mullvad-namespacet:
 *   ip netns exec mv node vps/probe-bet365.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const URL = process.env.BET365_URL || "https://www.bet365.com/";
const SHOT = "/root/bet365-probe.png";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const log = (...a) => console.log("[bet365-probe]", ...a);

async function main() {
  log("startar stealth-Chromium...");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Logga nätverks-svar som ser ut som odds/push-feed
  const feedHosts = new Set();
  page.on("response", (res) => {
    try {
      const u = new URL(res.url());
      if (/stream|push|pub|premium|sports|inplay|overview|sportsbook/i.test(u.hostname + u.pathname)) {
        feedHosts.add(`${u.hostname}${u.pathname.slice(0, 40)} → ${res.status()}`);
      }
    } catch {}
  });

  let navErr = null;
  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (e) {
    navErr = e?.message ?? String(e);
  }
  // Ge SPA:n tid att rendera / push-feed att ansluta
  await page.waitForTimeout(12_000);

  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 400);

  // Block-indikatorer
  const blockHints = [];
  const lc = (title + " " + bodyText).toLowerCase();
  for (const phrase of [
    "not available", "inte tillgänglig", "restricted", "access denied",
    "blocked", "region", "just a moment", "attention required", "captcha",
    "unable to", "vpn", "proxy",
  ]) if (lc.includes(phrase)) blockHints.push(phrase);

  // Odds-element? bet365 använder obfuskerade klass-prefix (gl-, sgl-, ovm-, cm-, sci-)
  const oddsCounts = await page.evaluate(() => {
    const sel = [
      ".gl-Market", ".sgl-MarketGroup", ".gl-Participant_Odds", ".ovm-Fixture",
      "[class*='Market']", "[class*='Participant']", "[class*='Odds']",
    ];
    const out = {};
    for (const s of sel) out[s] = document.querySelectorAll(s).length;
    return out;
  }).catch(() => ({}));

  // Strukturdump: lär oss bet365:s faktiska klassnamn + layout för odds.
  const structSample = await page.evaluate(() => {
    const sample = (selector, n) =>
      [...document.querySelectorAll(selector)].slice(0, n).map((el) => ({
        cls: el.className?.toString().slice(0, 80),
        txt: (el.textContent ?? "").trim().slice(0, 50),
      }));
    return {
      participants: sample("[class*='Participant']", 10),
      odds: sample("[class*='Odds']", 12),
      fixtures: sample("[class*='Fixture'],[class*='ParticipantFixtureDetails']", 6),
      marketGroups: sample("[class*='MarketGroup'],[class*='Market_']", 6),
    };
  }).catch((e) => ({ error: String(e) }));

  await page.screenshot({ path: SHOT, fullPage: false }).catch(() => {});

  log("=========== RESULTAT ===========");
  log("navigeringsfel:", navErr || "(inget)");
  log("slut-URL:", finalUrl);
  log("titel:", JSON.stringify(title));
  log("body-text (400 tecken):", JSON.stringify(bodyText));
  log("block-indikatorer:", blockHints.length ? blockHints.join(", ") : "(inga)");
  log("odds-element-räkning:", JSON.stringify(oddsCounts));
  log("intressanta nätverks-svar:", feedHosts.size ? [...feedHosts].slice(0, 12) : "(inga)");
  log("STRUKTUR-SAMPLE:");
  console.log(JSON.stringify(structSample, null, 2));
  log("skärmdump sparad:", SHOT);
  log("================================");

  await browser.close();
}

main().catch((e) => {
  console.error("[bet365-probe] FATALT:", e?.message ?? e);
  process.exit(1);
});
