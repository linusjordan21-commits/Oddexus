#!/usr/bin/env node
/**
 * recon-prontosport.mjs — hitta prematch-fotbolls-endpoint för prontosport (ABM/"Euro",
 * sb.prontosport.se, site 5066). Bootar SPA:n på /euro/home, navigerar till fotboll,
 * och dumpar HELA JSON-svaret som bär events+odds (operation-AJAX). Mullvad svensk IP.
 * Output: data/_recon-prontosport.json (endpoints) + data/_prontosport-events-sample.json (största JSON).
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-prontosport.json");
const SAMPLE = path.resolve(process.cwd(), "data", "_prontosport-events-sample.json");
const log = (...a) => console.log("[pronto]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection (ignorerad):", e?.message ?? e));

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 900 } });
  const captured = []; // {url, status, ct, len, hasOdds}
  let biggestOddsBody = { url: null, len: 0, body: "" };

  ctx.on("response", (resp) => {
    // Hela handlern i try/catch — en kastad resp.headers()/text() får ALDRIG krascha
    // processen (unhandled rejection → node exit 1, maskeras av xvfb-run → tom rapport).
    (async () => {
      try {
        const u = resp.url();
        if (!/prontosport\.se|abmbet|orbit-platform/i.test(u)) return;
        const ct = (resp.headers()["content-type"] || "");
        if (!/json/i.test(ct)) return;
        const body = await resp.text();
        const hasOdds = /"(odds|price|selections?|markets?|events?|outcomes?|competitors?|fixtures?)"/i.test(body);
        captured.push({ url: u.slice(0, 200), status: resp.status(), ct: ct.slice(0, 40), len: body.length, hasOdds });
        if (hasOdds && body.length > biggestOddsBody.len) biggestOddsBody = { url: u, len: body.length, body };
      } catch { /* ignorera enskilda svar */ }
    })();
  });

  const page = await ctx.newPage();
  log("laddar /sv/euro/home …");
  try { await page.goto("https://sb.prontosport.se/sv/euro/home", { waitUntil: "domcontentloaded", timeout: 35000 }); } catch (e) { log("goto-fel:", e.message); }
  for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK", "Jag förstår"]) {
    try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
  }
  await page.waitForTimeout(8000);
  // navigera till fotboll (länk/knapp)
  for (const t of ["Fotboll", "Football", "Soccer"]) {
    try { await page.getByText(t, { exact: false }).first().click({ timeout: 2500 }); log(`klickade "${t}"`); break; } catch { /* */ }
  }
  await page.waitForTimeout(12000);

  const sorted = captured.sort((a, b) => b.len - a.len);
  const report = { ranAt: new Date().toISOString(), endpointCount: captured.length, biggestOddsUrl: biggestOddsBody.url, biggestOddsLen: biggestOddsBody.len, endpoints: sorted.slice(0, 40) };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  if (biggestOddsBody.body) fs.writeFileSync(SAMPLE, biggestOddsBody.body.slice(0, 60000));
  log(`klart — ${captured.length} JSON-endpoints, största odds-svar: ${biggestOddsBody.len} bytes @ ${biggestOddsBody.url}`);
  await browser.close();
}
main().catch((e) => { console.error("[pronto] FATALT:", e?.message ?? e); process.exit(1); });
