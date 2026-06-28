#!/usr/bin/env node
/**
 * recon-10bet-slice.mjs — knäck 10bet:s binära "getslice"-feed.
 * 10bet (sportswidget-cdn.10bet.se) levererar odds via /v2/getslice/.../sv.bin.
 * Pathen innehåller "json" → hypotes: gzip-komprimerad JSON serverad som .bin.
 * Vi fångar getslice/.bin-svaren som BUFFER, provar gunzip/inflate/brotli, och
 * dumpar dekodningsresultat + JSON-prov så vi vet hur datan ska parsas.
 * Output: data/_recon-10bet-slice.json + data/_10bet-slice-sample.json.
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-slice.json");
const SAMPLE = path.resolve(process.cwd(), "data", "_10bet-slice-sample.json");
const log = (...a) => console.log("[10bet-slice]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));

function tryDecode(buf) {
  // returnera {method, text} för första som ger läsbar text/JSON
  const attempts = [
    ["raw", () => buf.toString("utf8")],
    ["gunzip", () => zlib.gunzipSync(buf).toString("utf8")],
    ["inflate", () => zlib.inflateSync(buf).toString("utf8")],
    ["inflateRaw", () => zlib.inflateRawSync(buf).toString("utf8")],
    ["brotli", () => zlib.brotliDecompressSync(buf).toString("utf8")],
  ];
  for (const [method, fn] of attempts) {
    try {
      const text = fn();
      if (text && /[{\[]/.test(text.slice(0, 50))) {
        let isJson = false; try { JSON.parse(text); isJson = true; } catch { /* */ }
        return { method, isJson, len: text.length, text };
      }
    } catch { /* */ }
  }
  return null;
}

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 900 } });
  const slices = []; // {url, ct, bytes, decode:{method,isJson,len}}
  let biggestJson = { url: null, len: 0, text: "" };

  ctx.on("response", (resp) => {
    (async () => {
      try {
        const u = resp.url();
        if (!/sportswidget(-cdn)?\.10bet\.se/i.test(u)) return;
        // ENDAST data-slices — skippa JS/CSS-bundles (de fyllde rapporten förut)
        if (!/getslice|getmeta|\/v2\/|\.bin|\/config|\/init|getEvents|prematch/i.test(u)) return;
        if (/\.js(\?|$)|\.css(\?|$)/i.test(u)) return;
        const buf = await resp.body();
        const dec = tryDecode(buf);
        const rec = { url: u.slice(0, 200), ct: (resp.headers()["content-type"] || "").slice(0, 40), bytes: buf.length, decode: dec ? { method: dec.method, isJson: dec.isJson, len: dec.len } : null, head: dec ? dec.text.slice(0, 160) : buf.slice(0, 32).toString("hex") };
        slices.push(rec);
        if (dec && dec.isJson && /event|market|odds|price|selection|competitor|participant/i.test(dec.text) && dec.len > biggestJson.len) {
          biggestJson = { url: u, len: dec.len, text: dec.text };
        }
      } catch { /* */ }
    })();
  });

  const writeReport = (extra = {}) => {
    const report = { ranAt: new Date().toISOString(), sliceCount: slices.length, biggestJsonUrl: biggestJson.url, biggestJsonLen: biggestJson.len, slices: slices.slice(0, 50), ...extra };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
    if (biggestJson.text) fs.writeFileSync(SAMPLE, biggestJson.text.slice(0, 80000));
    log(`rapport — slices=${slices.length} störstaJSON=${biggestJson.len}b @ ${biggestJson.url}`);
  };

  let used = null;
  try {
    const page = await ctx.newPage();
    for (const url of ["https://www.10bet.se/sports/football", "https://www.10bet.se/sports", "https://www.10bet.se/home-page"]) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }); used = url; break; } catch { /* */ }
    }
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    for (const t of ["Fotboll", "Football", "Kommande", "Matcher"]) {
      try { await page.getByText(t, { exact: false }).first().click({ timeout: 2000 }); log(`klickade "${t}"`); break; } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    // klicka in på en första match/liga → triggar event-getslice
    for (const sel of ["a[href*='match']", "a[href*='event']", ".event", "[data-test*='event']"]) {
      try { await page.locator(sel).first().click({ timeout: 2000 }); log(`klickade ${sel}`); break; } catch { /* */ }
    }
    await page.waitForTimeout(8000);
    // DIREKT in-page-fetch av getmeta/config (CF-clearad kontext) → avgör format
    const probes = {};
    for (const ep of ["https://sportswidget-cdn.10bet.se/v2/getmeta", "https://sportswidget-cdn.10bet.se/config", "https://sportswidget.10bet.se/configuration/init"]) {
      try {
        probes[ep] = await page.evaluate(async (url) => {
          try { const r = await fetch(url, { credentials: "include" }); const t = await r.text(); return { status: r.status, ct: r.headers.get("content-type"), len: t.length, head: t.slice(0, 300) }; }
          catch (e) { return { err: String(e && e.message || e) }; }
        }, ep);
      } catch (e) { probes[ep] = { err: String(e?.message ?? e).slice(0, 80) }; }
    }
    writeReport({ usedUrl: used, title: await page.title().catch(() => null), probes });
  } catch (e) {
    log("recon-fel:", e?.message ?? e);
    writeReport({ usedUrl: used, error: String(e?.message ?? e).slice(0, 200) });
  } finally {
    try { await browser.close(); } catch { /* */ }
  }
}
main().catch((e) => { console.error("[10bet-slice] FATALT:", e?.message ?? e); });
