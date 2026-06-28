#!/usr/bin/env node
/**
 * recon-tipwin-dom.mjs — hitta tipwin:s (proprietär, tipwin.se) match-rad-struktur för
 * DOM-skrapning. CF-skyddad → Mullvad svensk IP + stealth. Bootar sports-vyn, dumpar
 * nav-länkar (rätt football-URL) + match-vyns pris-rader. Bulletproof + stdout-dump
 * (överlever xvfb-krasch — samma som löste prontosport).
 * Output: data/_recon-tipwin-dom.json (+ stdout HOMEVIEW/MATCHVIEW).
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "node:fs";
import path from "node:path";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-tipwin-dom.json");
const log = (...a) => console.log("[tipwin-dom]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));

const EXTRACT = () => {
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
        if (!seen.has(n)) { seen.add(n); rows.push({ rowSelector: cssPath(n), priceSelector: cssPath(childP[0]), prices: childP.map((x) => x.textContent.trim()), text: (n.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180), html: n.outerHTML.slice(0, 1100) }); }
        break;
      }
      n = n.parentElement;
    }
  }
  const links = [...new Set(Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter(Boolean))];
  const footballLinks = links.filter((h) => /football|fotboll|soccer/i.test(h)).slice(0, 20);
  return { url: location.href, priceCount: priceEls.length, rowCount: rows.length, bodyLen: (document.body.innerText || "").length, rows: rows.slice(0, 8), footballLinks, links: links.filter((h) => /sport|football|fotboll|soccer|event|match|league|comp/i.test(h)).slice(0, 30) };
};

async function main() {
  const report = { ranAt: new Date().toISOString() };
  const write = () => { try { console.log("TIPWIN_REPORT_BEGIN" + JSON.stringify(report) + "TIPWIN_REPORT_END"); } catch { /* */ } try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n"); log("SKRIVEN"); } catch (e) { log("write-fel:", e?.message ?? e); } };
  let browser;
  try {
    browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
    const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 1100 } });
    const page = await ctx.newPage();
    for (const url of ["https://tipwin.se/sv/sports", "https://tipwin.se/sv/home/full/highlights", "https://www.tipwin.se/sv/sports", "https://tipwin.se/"]) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }); report.usedUrl = url; break; } catch { /* */ }
    }
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK", "Jag accepterar", "Tillåt alla"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(12000); // CF-challenge + SPA
    log("home:", page.url());
    report.homeView = await page.evaluate(EXTRACT).catch((e) => ({ extractErr: String(e?.message ?? e).slice(0, 80) }));
    console.log("HOMEVIEW " + JSON.stringify(report.homeView).slice(0, 700));
    let navigated = false;
    for (const t of ["Fotboll", "Football", "Soccer"]) {
      try { await page.getByText(t, { exact: false }).first().click({ timeout: 2500 }); log(`klick "${t}"`); navigated = true; break; } catch { /* */ }
    }
    if (!navigated && report.homeView?.footballLinks?.length) {
      const h = report.homeView.footballLinks[0];
      const target = h.startsWith("http") ? h : `https://tipwin.se${h.startsWith("/") ? "" : "/"}${h}`;
      try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }); report.navigatedTo = target; log(`gick till ${target}`); } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    for (let i = 0; i < 4; i++) { try { await page.mouse.wheel(0, 1500); await page.waitForTimeout(1200); } catch { /* */ } }
    report.matchView = await page.evaluate(EXTRACT).catch((e) => ({ extractErr: String(e?.message ?? e).slice(0, 80) }));
    report.finalUrl = page.url();
    console.log("MATCHVIEW " + JSON.stringify(report.matchView).slice(0, 1600));
  } catch (e) {
    report.error = String(e?.message ?? e).slice(0, 200);
    log("recon-fel:", e?.message ?? e);
  } finally {
    write();
    try { await browser?.close(); } catch { /* */ }
  }
}
main().catch((e) => { console.error("[tipwin-dom] FATALT:", e?.message ?? e); });
