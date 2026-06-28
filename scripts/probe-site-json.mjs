#!/usr/bin/env node
/**
 * probe-site-json.mjs — generisk "upptäck JSON-endpoints"-sond.
 *
 * Laddar PROBE_URL i stealth-Chromium (samma teknik som Pinnacle-skrapan) och
 * loggar VILKA JSON-/odds-endpoints sidan själv hämtar — så vi kan se om en
 * sajt (t.ex. sbobet.com/en/euro) går att intercepta oautentiserat, eller om
 * den geo-blockar / kräver login. Skriver INGET till repot — ren rekognosering.
 *
 * Env: PROBE_URL (krävs), PROBE_SETTLE_MS (default 20000).
 */

import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const URL = process.env.PROBE_URL;
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS) || 20000;

function looksInteresting(u, ct) {
  if (ct.includes("application/json")) return true;
  return /\/api\/|\/odds|event|market|sport|fixture|graphql|feed/i.test(u);
}

async function main() {
  if (!URL) { console.error("[probe] PROBE_URL saknas"); process.exit(0); }
  console.log(`[probe] startar stealth Chromium mot ${URL}`);
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-GB",
    timezoneId: "Europe/Stockholm",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const seen = [];
  page.on("response", async (res) => {
    try {
      const u = res.url();
      const ct = res.headers()["content-type"] || "";
      if (!looksInteresting(u, ct)) return;
      let size = 0, sample = "";
      try { const b = await res.body(); size = b.length; sample = b.toString("utf8").slice(0, 240).replace(/\s+/g, " "); } catch { /* body ej tillgänglig */ }
      seen.push({ u, status: res.status(), ct: ct.split(";")[0], size, sample });
    } catch { /* ignore */ }
  });

  // WebSocket-fångst (live-odds streamas ofta via WS, inte HTTP).
  const wsUrls = [];
  const wsFrames = [];
  page.on("websocket", (ws) => {
    wsUrls.push(ws.url());
    ws.on("framereceived", (d) => { if (wsFrames.length < 8) { try { wsFrames.push(String(d.payload).slice(0, 200)); } catch { /* */ } } });
  });

  let gotoErr = null;
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => { gotoErr = e?.message; });
  await page.waitForTimeout(SETTLE_MS);

  const finalUrl = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = (await page.evaluate(() => document.body?.innerText?.slice(0, 400) || "").catch(() => "")).replace(/\s+/g, " ");

  // ── DOM-odds: oddsen kan ligga inbäddade i HTML som onPrice(...)-handlers ──
  const html = await page.content().catch(() => "");
  const onPriceMatches = [...html.matchAll(/onPrice\([^)]*\)/g)].map((m) => m[0]);
  const oddsLike = [...html.matchAll(/onPrice\(\s*'?\w+'?\s*,\s*'?(\d+)'?\s*,\s*'?(\w+)'?\s*,\s*([\d.]+)\s*\)/g)]
    .map((m) => ({ id: m[1], market: m[2], price: m[3] }));

  await browser.close();

  console.log(`[probe] === RESULTAT ===`);
  console.log(`[probe] final URL: ${finalUrl}`);
  console.log(`[probe] title: "${title}"`);
  if (gotoErr) console.log(`[probe] goto-fel: ${gotoErr}`);
  console.log(`[probe] body (start): ${bodyText.slice(0, 300)}`);
  console.log(`[probe] interceptade JSON/odds-svar: ${seen.length}`);
  // Visa de största/mest intressanta (sannolikt odds-payloads).
  seen.sort((a, b) => b.size - a.size);
  for (const s of seen.slice(0, 15)) {
    console.log(`  [${s.status}] ${s.size}b ${s.ct}  ${s.u.slice(0, 140)}`);
    if (s.size > 0) console.log(`        sample: ${s.sample}`);
  }

  console.log(`[probe] WebSocket-anslutningar: ${wsUrls.length}`);
  for (const u of wsUrls.slice(0, 8)) console.log(`  WS: ${u}`);
  for (const f of wsFrames.slice(0, 4)) console.log(`  WS-frame: ${f}`);

  console.log(`[probe] DOM onPrice(...)-handlers: ${onPriceMatches.length} · strukturerade odds (id/marknad/pris): ${oddsLike.length}`);
  for (const o of oddsLike.slice(0, 12)) console.log(`  odds: id=${o.id} market=${o.market} price=${o.price}`);
  for (const m of onPriceMatches.slice(0, 4)) console.log(`  raw: ${m}`);

  if (oddsLike.length > 0) {
    console.log(`[probe] VERDIKT: ${oddsLike.length} odds extraherade DIREKT ur DOM:en → SAJTEN ÄR SKRAPBAR via DOM (ingen feed behövs).`);
  } else if (seen.length > 0 || wsUrls.length > 0) {
    console.log("[probe] VERDIKT: endpoints/WS fångade men inga onPrice-odds i DOM → odds via WS-frames eller efter interaktion.");
  } else {
    console.log("[probe] VERDIKT: inget fångat → geo-block/login-vägg/tyngre JS-render.");
  }
}

main().catch((e) => { console.error("[probe] fatal:", e?.message ?? e); process.exit(0); });
