#!/usr/bin/env node
/**
 * recon-10bet.mjs — kartlägg 10bet:s Sportradar-widget-feed (events + odds) så vi
 * kan bygga skrapan. 10bet renderar odds via sportswidget.10bet.se (Sportradar).
 * Bootar fotbollsvyn via stealth-Chromium BAKOM Mullvad (svensk IP), fångar alla
 * JSON-XHR från 10bet/sportswidget/Sportradar + WS-frames, dumpar största odds-svaret.
 * Skriver ALLTID rapport i finally (xvfb-run maskerar annars krascher → tom commit).
 * Output: data/_recon-10bet.json + data/_10bet-sample.json (största JSON-svar).
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet.json");
const SAMPLE = path.resolve(process.cwd(), "data", "_10bet-sample.json");
const log = (...a) => console.log("[10bet]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection (ignorerad):", e?.message ?? e));

// 10bet-egen + Sportradar-widget-backend (inte ren JS/bild)
const DATA_HOST = /10bet\.se|sportswidget|framegas|sportradar|betradar|fdp|ls\.fn\.sportradar/i;
const STRUCT_RE = /"(events?|markets?|selections?|outcomes?|odds|price|competitors?|fixtures?|matches?|sport_events?|markets_?)"/i;

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 900 } });
  const xhr = [];
  let biggest = { url: null, len: 0, body: "" };
  const wsFrames = [];

  ctx.on("response", (resp) => {
    (async () => {
      try {
        const u = resp.url();
        if (!DATA_HOST.test(u)) return;
        const ct = resp.headers()["content-type"] || "";
        if (!/json/i.test(ct)) return;
        const body = await resp.text();
        const struct = STRUCT_RE.test(body);
        xhr.push({ url: u.slice(0, 230), status: resp.status(), ct: ct.slice(0, 40), len: body.length, struct });
        if (struct && body.length > biggest.len) biggest = { url: u, len: body.length, body };
      } catch { /* */ }
    })();
  });

  const page = await ctx.newPage();
  page.on("websocket", (ws) => {
    const wurl = ws.url();
    if (!/10bet|sportswidget|framegas|sportradar|betradar/i.test(wurl)) return;
    log("WS:", wurl.slice(0, 90));
    const grab = (dir) => (f) => { try { const data = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? ""); if (data && data.length > 15 && wsFrames.length < 40) wsFrames.push({ url: wurl.slice(0, 90), dir, data: data.slice(0, 500) }); } catch { /* */ } };
    ws.on("framesent", grab("→")); ws.on("framereceived", grab("←"));
  });

  const writeReport = (extra = {}) => {
    const sorted = xhr.sort((a, b) => b.len - a.len);
    const report = { ranAt: new Date().toISOString(), xhrCount: xhr.length, wsFrameCount: wsFrames.length, biggestStructUrl: biggest.url, biggestStructLen: biggest.len, xhr: sorted.slice(0, 30), ws: wsFrames.slice(0, 30), ...extra };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
    if (biggest.body) fs.writeFileSync(SAMPLE, biggest.body.slice(0, 80000));
    log(`rapport — xhr=${xhr.length} ws=${wsFrames.length} struct=${biggest.len}b @ ${biggest.url}`);
  };

  let used = null; const gotoErrors = [];
  try {
    for (const url of ["https://www.10bet.se/sports/football", "https://www.10bet.se/sports", "https://www.10bet.se/sv/sports", "https://www.10bet.se/home-page"]) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }); used = url; break; }
      catch (e) { gotoErrors.push(`${url}: ${String(e?.message ?? e).slice(0, 70)}`); }
    }
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK", "Jag accepterar"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    for (const t of ["Fotboll", "Football", "Soccer", "Kommande", "Matcher"]) {
      try { await page.getByText(t, { exact: false }).first().click({ timeout: 2000 }); log(`klickade "${t}"`); break; } catch { /* */ }
    }
    await page.waitForTimeout(15000);
    writeReport({ usedUrl: used, gotoErrors, title: await page.title().catch(() => null) });
  } catch (e) {
    log("recon-fel:", e?.message ?? e);
    writeReport({ usedUrl: used, gotoErrors, error: String(e?.message ?? e).slice(0, 200) });
  } finally {
    try { await browser.close(); } catch { /* */ }
  }
}
main().catch((e) => { console.error("[10bet] FATALT (rapport ev. ändå skriven):", e?.message ?? e); });
