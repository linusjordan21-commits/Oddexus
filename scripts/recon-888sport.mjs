#!/usr/bin/env node
/**
 * recon-888sport.mjs — kartlägg Spectate (888) prematch-fotbolls-feed så vi kan bygga
 * skrapan (återanvänder Coolbet-pipelinen: katalog för struktur + WS för priser).
 *
 * Bootar 888sport.se/fotboll via stealth-Chromium BAKOM Mullvad (svensk IP), fångar:
 *  - ALLA JSON-XHR från safe-iplay.com / 888sport.se (kandidat: event-katalog m. marknader+lag)
 *  - WebSocket-frames (subscribe + price_update) i HELA — för att se prisstruktur + outcome-id
 * Dumpar de största/mest lovande till loggen (Dump report-steget) + fil.
 * Output: data/_recon-888sport.json + data/_888sport-sample.json (största JSON-svar).
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-888sport.json");
const SAMPLE = path.resolve(process.cwd(), "data", "_888sport-sample.json");
const log = (...a) => console.log("[888]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection (ignorerad):", e?.message ?? e));

// host-filter: 888sport egen + Spectate-backend (safe-iplay.com), men inte ren JS/bild.
const DATA_HOST = /888sport\.se|safe-iplay\.com/i;
const STRUCT_RE = /"(events?|markets?|selections?|outcomes?|competitors?|fixtures?|sport|league|odds|price|participants?)"/i;

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 900 } });
  const xhr = [];                 // {url, status, ct, len, struct}
  let biggest = { url: null, len: 0, body: "" };
  const wsFrames = [];            // {url, dir, data}

  ctx.on("response", (resp) => {
    (async () => {
      try {
        const u = resp.url();
        if (!DATA_HOST.test(u)) return;
        const ct = resp.headers()["content-type"] || "";
        if (!/json/i.test(ct)) return;           // bara JSON (struktur/odds), inte JS-bundles
        const body = await resp.text();
        const struct = STRUCT_RE.test(body);
        xhr.push({ url: u.slice(0, 220), status: resp.status(), ct: ct.slice(0, 40), len: body.length, struct });
        if (struct && body.length > biggest.len) biggest = { url: u, len: body.length, body };
      } catch { /* */ }
    })();
  });

  const page = await ctx.newPage();
  page.on("websocket", (ws) => {
    const wurl = ws.url();
    if (!/888sport\.se|safe-iplay|spectate/i.test(wurl)) return;
    log("WS öppnad:", wurl.slice(0, 90));
    const grab = (dir) => (f) => {
      try {
        const data = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? "");
        if (data && data.length > 15 && wsFrames.length < 40) wsFrames.push({ url: wurl.slice(0, 90), dir, data: data.slice(0, 700) });
      } catch { /* */ }
    };
    ws.on("framesent", grab("→sent"));
    ws.on("framereceived", grab("←recv"));
  });

  // Skriv ALLTID rapporten (även vid partiell krasch) → finally. Annars förlorar vi
  // allt om något kastar mitt i (xvfb-run maskerar exit-koden → tom commit).
  const writeReport = (extra = {}) => {
    const sorted = xhr.sort((a, b) => b.len - a.len);
    const report = { ranAt: new Date().toISOString(), xhrCount: xhr.length, wsFrameCount: wsFrames.length, biggestStructUrl: biggest.url, biggestStructLen: biggest.len, xhr: sorted.slice(0, 30), ws: wsFrames.slice(0, 40), ...extra };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
    if (biggest.body) fs.writeFileSync(SAMPLE, biggest.body.slice(0, 80000));
    log(`rapport skriven — xhr=${xhr.length} ws=${wsFrames.length} struct=${biggest.len}b`);
  };

  let used = null; const gotoErrors = [];
  try {
    log("laddar 888sport.se/fotboll …");
    for (const url of ["https://www.888sport.se/fotboll/", "https://www.888sport.se/sport/fotboll", "https://www.888sport.se/"]) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }); used = url; break; }
      catch (e) { gotoErrors.push(`${url}: ${String(e?.message ?? e).slice(0, 80)}`); }
    }
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK", "Jag förstår"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    for (const t of ["Kommande", "Prematch", "Matcher", "Alla"]) {
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
main().catch((e) => { console.error("[888] FATALT (rapport ev. ändå skriven):", e?.message ?? e); });
