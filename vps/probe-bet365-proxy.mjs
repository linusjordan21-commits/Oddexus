#!/usr/bin/env node
/**
 * bet365-probe genom RESIDENTIAL PROXY + full /zap/-protokoll-fångst.
 *
 * Gör tre saker i en körning:
 *  (a) testar om residential-IP låser upp odds-feeden (vs datacenter-gate),
 *  (b) fångar HELA WS-utbytet (skickade + mottagna frames) = ritning för en
 *      browserlös /zap/-klient,
 *  (c) blockar bilder/fonter/media → minimal bandbredd (billig produktion).
 *
 * Proxy via env: PROXY_SERVER, PROXY_USER, PROXY_PASS (sätt på VPS, ej i chatt).
 * Kör: HEADFUL=1 xvfb-run -a node vps/probe-bet365-proxy.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[b365-proxy]", ...a);
const esc = (s) => String(s).replace(/[\x00-\x1f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));

async function main() {
  const { PROXY_SERVER, PROXY_USER, PROXY_PASS } = process.env;
  if (!PROXY_SERVER) { console.error("[b365-proxy] FEL: PROXY_SERVER saknas."); process.exit(1); }
  log("proxy:", PROXY_SERVER, PROXY_USER ? "(auth)" : "");

  const browser = await chromiumExtra.launch({
    headless: process.env.HEADFUL !== "1" ? true : false,
    proxy: { server: PROXY_SERVER, username: PROXY_USER, password: PROXY_PASS },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    Object.defineProperty(document, "hidden", { get: () => false });
  });
  // (c) Blocka tung media → minimal bandbredd. Behåll JS/XHR/WS.
  let blocked = 0, bytesIn = 0;
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["image", "media", "font"].includes(t)) { blocked++; return route.abort(); }
    return route.continue();
  });

  const page = await ctx.newPage();

  // (b) Fånga HELA WS-utbytet
  let totalRecv = 0;
  const sent = [], recv = [];
  page.on("websocket", (ws) => {
    log("WS öppnad:", ws.url().slice(0, 70));
    ws.on("framesent", (f) => {
      const p = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? "");
      if (p && sent.length < 25) sent.push(esc(p).slice(0, 500));
    });
    ws.on("framereceived", (f) => {
      totalRecv++;
      const p = typeof f.payload === "string" ? f.payload : (f.payload?.toString?.("utf8") ?? "");
      if (p) { bytesIn += p.length; if (recv.length < 30) recv.push(esc(p).slice(0, 500)); }
    });
  });

  try {
    const ipPage = await ctx.newPage();
    await ipPage.goto("https://api.ipify.org?format=json", { timeout: 25_000 });
    log("exit-IP via proxy:", (await ipPage.textContent("body"))?.slice(0, 80));
    await ipPage.close();
  } catch (e) { log("exit-IP-fel:", e.message); }

  log("laddar bet365 + Allsvenskan...");
  await page.goto("https://www.bet365.com/", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => log("nav-fel:", e.message));
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(12_000);
  try { await page.getByText("Allsvenskan", { exact: false }).first().click({ timeout: 8_000 }); } catch { log("kunde ej klicka liga"); }
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 800).catch(() => {}); await page.waitForTimeout(4_000); }

  const dom = await page.evaluate(() => ({
    url: location.href,
    oddsEls: document.querySelectorAll("[class*='Odds']").length,
    teamEls: document.querySelectorAll("[class*='_Team']").length,
  })).catch((e) => ({ error: String(e) }));

  log("=========== RESULTAT ===========");
  log("DOM:", JSON.stringify(dom));
  log("WS mottagna frames:", totalRecv, "| ~bytes in:", bytesIn, "| media-block:", blocked);
  log("--- WS SENT (klientens prenumerationer) ---");
  sent.forEach((p, i) => console.log(`  S[${i}] ${p}`));
  log("--- WS RECV (serverns svar/odds) ---");
  recv.forEach((p, i) => console.log(`  R[${i}] ${p}`));
  log("================================");
  await browser.close();
}
main().catch((e) => { console.error("[b365-proxy] FATALT:", e?.message ?? e); process.exit(1); });
