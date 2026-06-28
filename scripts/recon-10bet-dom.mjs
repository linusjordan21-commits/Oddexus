#!/usr/bin/env node
/**
 * recon-10bet-dom.mjs — hitta DOM-strukturen för 10bet:s renderade match-rader så vi
 * kan DOM-skrapa odds (binära getslice-protokollet kringgås helt — webbläsaren har
 * redan målat ut oddsen). Söker i ALLA frames (widgeten ligger i en iframe), hittar
 * odds-lika element (1X2-knappar), grupperar till match-rader och dumpar outerHTML +
 * klass-vägar så vi kan härleda selektorer. Mullvad svensk IP.
 * Output: data/_recon-10bet-dom.json.
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-dom.json");
const log = (...a) => console.log("[10bet-dom]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));

// körs IN i varje frame: hitta odds-element + match-rader, returnera prov.
const EXTRACT = () => {
  // format-agnostiskt: decimal (1.85 / 1,85) ELLER fraktion (5/2)
  const priceRe = /^(\d{1,2}[.,]\d{1,2}|\d{1,3}\/\d{1,3})$/;
  const isPrice = (el) => { const t = (el.textContent || "").trim(); return priceRe.test(t) && el.querySelectorAll("*").length <= 3; };
  const all = Array.from(document.querySelectorAll("div,span,button,a,li"));
  const priceEls = all.filter(isPrice);
  const cssPath = (el) => { const p = []; let n = el; for (let i = 0; i < 4 && n && n.nodeType === 1; i++) { let s = n.tagName.toLowerCase(); if (n.className && typeof n.className === "string") s += "." + n.className.trim().split(/\s+/).slice(0, 3).join("."); p.unshift(s); n = n.parentElement; } return p.join(" > "); };
  const rows = []; const seen = new Set();
  for (const o of priceEls) {
    let n = o.parentElement;
    for (let up = 0; up < 9 && n; up++) {
      const childP = Array.from(n.querySelectorAll("div,span,button,a")).filter(isPrice);
      if (childP.length >= 2 && childP.length <= 3) {
        if (!seen.has(n)) {
          seen.add(n);
          rows.push({ rowSelector: cssPath(n), priceSelector: cssPath(childP[0]), prices: childP.map((x) => x.textContent.trim()), text: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180), html: n.outerHTML.slice(0, 1100) });
        }
        break;
      }
      n = n.parentElement;
    }
  }
  // även: distinkta klassnamn på pris-element + ett DOM-prov av största pris-containern
  const priceClasses = [...new Set(priceEls.map((e) => (e.className && typeof e.className === "string" ? e.className.trim() : "")).filter(Boolean))].slice(0, 12);
  // dumpa widgetens nav-länkar (URL-schema) så vi kan gå DIREKT till match-listan
  const links = [...new Set(Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => h && /\/sports?\//i.test(h) && !/competitions$/i.test(h)))].slice(0, 50);
  const footballLinks = links.filter((h) => /football|fotboll|soccer/i.test(h));
  return { url: location.href, priceCount: priceEls.length, rowCount: rows.length, priceClasses, bodyLen: (document.body.innerText || "").length, rows: rows.slice(0, 8), footballLinks, links: links.slice(0, 30) };
};

async function main() {
  const report = { ranAt: new Date().toISOString(), frames: [] };
  const write = () => { try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n"); log(`rapport SKRIVEN — frames=${report.frames.length} err=${report.error || "-"}`); } catch (e) { log("write-fel:", e?.message ?? e); } };
  let browser;
  try {
    browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
    const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 1100 } });
    const page = await ctx.newPage();
    for (const url of ["https://www.10bet.se/sports/football", "https://www.10bet.se/sports", "https://www.10bet.se/home-page"]) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }); report.usedUrl = url; break; } catch { /* */ }
    }
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    for (const t of ["Fotboll", "Football", "Kommande", "Matcher"]) {
      try { await page.getByText(t, { exact: false }).first().click({ timeout: 2000 }); log(`klick "${t}"`); break; } catch { /* */ }
    }
    await page.waitForTimeout(6000);
    // RUNDA 1: dumpa nav-länkar från competitions-vyn (lär oss URL-schemat)
    let firstExtract = null;
    try { firstExtract = await page.evaluate(EXTRACT); } catch { /* */ }
    report.competitionsView = firstExtract;
    // navigera DIREKT till en football-match-länk om vi hittade en
    const fbLinks = (firstExtract && firstExtract.footballLinks) || [];
    if (fbLinks.length) {
      const target = fbLinks[0].startsWith("http") ? fbLinks[0] : `https://www.10bet.se${fbLinks[0]}`;
      try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }); report.navigatedTo = target; log(`gick till ${target}`); } catch { /* */ }
      await page.waitForTimeout(9000);
      for (let i = 0; i < 4; i++) { try { await page.mouse.wheel(0, 1500); await page.waitForTimeout(1200); } catch { /* */ } }
      await page.waitForTimeout(4000);
    }
    report.frameUrls = page.frames().map((f) => f.url().slice(0, 90));
    for (const fr of page.frames()) {
      try {
        const r = await fr.evaluate(EXTRACT);
        if (r && (r.priceCount > 0 || r.rowCount > 0 || (r.footballLinks && r.footballLinks.length))) report.frames.push(r);
      } catch { /* cross-origin/eval-fel */ }
    }
  } catch (e) {
    report.error = String(e?.message ?? e).slice(0, 200);
    log("recon-fel:", e?.message ?? e);
  } finally {
    write();
    try { await browser?.close(); } catch { /* */ }
  }
}
main().catch((e) => { console.error("[10bet-dom] FATALT:", e?.message ?? e); });
