#!/usr/bin/env node
/**
 * fetch-sbobet-github-action.mjs — DOM-skrapa för SBOBET, vår andra GRATIS
 * sharp-källa efter Pinnacle.
 *
 * SBOBET har ingen publik JSON-feed; oddsen renderas i HTML som klickbara
 * onPrice-handlers (se probe-site-json.mjs / sbobetScrapeParse.ts):
 *
 *     <a href="javascript:$M('od').onPrice('s', 572125529, '1', 1.47)">1.47</a>
 *
 * Det här scriptet:
 *   1. Startar headless stealth-Chromium (samma teknik som Pinnacle-skrapan).
 *   2. Laddar de publika prematch-vyerna (ingen inloggning krävs).
 *   3. Extraherar per matchrad: lagnamn, ev. starttid/liga, samt alla
 *      onPrice-anrop (1X2: 1/x/2, Asian Handicap: h/a) + AH-handikappet ur
 *      intilliggande DOM.
 *   4. Parsar via sbobetScrapeParse → normaliserat format.
 *   5. Skriver data/sbobet-rows.json via scrape-guards cache-bevarande write.
 *
 * Robust: hård deadline (skriver partiell data före job-timeout), bevarar
 * tidigare cache om körningen ger 0 events. Kör som .mjs men importerar TS-
 * parsern via vite-node-kompatibel dynamisk import (workflow kör med vite-node).
 *
 * Env:
 *   SBOBET_URLS         kommaseparerade vy-URL:er (default euro-prematch).
 *   SBOBET_SETTLE_MS    väntetid per sida efter load (default 12000).
 *   SBOBET_DEADLINE_MS  hård deadline (default 7 min).
 *   SBOBET_DIAGNOSE     "1" → dumpa DOM-strukturprov för kalibrering.
 */

import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { installHardDeadline, writeJsonPreservingCache } from "./lib/scrape-guard.mjs";
import { flushOddsDbMirrors } from "./lib/odds-db.mjs";
import { parseSbobetMarkets, toSbobetRowsFile } from "../src/lib/odds/sbobetScrapeParse.ts";

chromiumExtra.use(StealthPlugin());

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "sbobet-rows.json");

const DEFAULT_URLS = [
  "https://www.sbobet.com/en/euro",
  "https://www.sbobet.com/en/euro/football",
];
const URLS = (process.env.SBOBET_URLS || DEFAULT_URLS.join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);
const SETTLE_MS = Number(process.env.SBOBET_SETTLE_MS) || 12_000;
const DIAGNOSE = process.env.SBOBET_DIAGNOSE === "1";

/**
 * DOM-extraktor — körs i sidkontexten. Kalibrerad mot SBOBET:s faktiska DOM
 * (se kalibreringskörning 2026-06-22):
 *   - oddsId + market + price ur onPrice-länkens href.
 *   - LAGNAMN ur länkens `title`-attribut: market '1'/'h' = hemma, '2'/'a' = borta.
 *   - START/LIVE ur radens ledande text: "Jun 22 22:08" = prematch-tid; en
 *     ställning/klocka ("0-2 2H 5'", "1-2 HT") = LIVE → hoppas över.
 *   - AH-LINJE: provar AH-länkens egen title + intilliggande cell.
 *
 * Grupperar per oddsId (en marknad) så hela 1X2/AH-marknaden byggs samlat.
 * Returnerar RÅ-rader (SbobetRawOdds-form) + ett diagnostikprov.
 */
function extractInPage(diagnose) {
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  function parseOnPrice(s) {
    const m = /onPrice\(\s*'?\w+'?\s*,\s*'?(\d+)'?\s*,\s*'?(\w+)'?\s*,\s*([\d.]+)\s*\)/.exec(s || "");
    if (!m) return null;
    return { oddsId: m[1], market: m[2].toLowerCase(), price: Number(m[3]) };
  }

  /** Rensa ett title-attribut till ett rent lagnamn (klipp efter radbryt/extra). */
  function cleanTeam(t) {
    if (!t) return undefined;
    return t.replace(/\s+/g, " ").trim().split(/[\n\r]/)[0].slice(0, 80) || undefined;
  }

  /**
   * Lagnamn ur en onPrice-länk. 1X2-länkar har namnet i `title`; AH-länkar har
   * det i inre `.OddsL`-spanens title/text (länkens egen title är null där).
   */
  function teamOf(a) {
    if (!a) return undefined;
    const t = a.getAttribute("title");
    if (t && t.trim()) return cleanTeam(t);
    const lbl = a.querySelector(".OddsL");
    return cleanTeam(lbl?.getAttribute("title") || lbl?.textContent);
  }

  /**
   * Tolka radens ledande text. Prematch börjar med "Mon DD HH:MM"; live börjar
   * med ställning/klocka. Returnerar { startTime, isLive }.
   */
  function parseTimeOrLive(rowText) {
    const t = (rowText || "").trim();
    // SBOBET klistrar ibland ihop dag+tid utan mellanslag ("Jun 3001:00" = Jun 30 01:00)
    // när radens innerText slår ihop flera matcher. \s* (ej \s+) mellan dag och tid + HH
    // som exakt \d{2} (zero-padded) tvingar regexen att backtracka dagen korrekt även för
    // 1-siffriga dagar ("Jun 301:00" → dag=3, 01:00). Coverage-audit 2026-06-29: detta var
    // 36% null startTime som bröt dedup + Pinnacle-matchning.
    const md = /^([A-Za-z]{3})\s+(\d{1,2})\s*(\d{2}):(\d{2})/.exec(t);
    if (md && MONTHS[md[1]] != null) {
      const now = new Date();
      let year = now.getUTCFullYear();
      // SBOBET visar tider i GMT+8 (sin asiatiska default — ignorerar browser-TZ
      // trots att vi satte Europe/Stockholm). Empiriskt verifierat: starttiderna
      // låg konsekvent +6h fel mot Pinnacle när vi antog +2 (8−2=6). GMT+8 har
      // ingen sommartid → fast −8 ger korrekt UTC året runt.
      const SBOBET_TZ_OFFSET_HOURS = 8;
      const d = new Date(Date.UTC(year, MONTHS[md[1]], Number(md[2]), Number(md[3]) - SBOBET_TZ_OFFSET_HOURS, Number(md[4])));
      // Årsskifte: om datumet hamnar långt i det förflutna, rulla fram ett år.
      if (d.getTime() < now.getTime() - 60 * 24 * 3600 * 1000) d.setUTCFullYear(year + 1);
      return { startTime: d.toISOString(), isLive: false };
    }
    // Live-indikatorer: ställning "x-y", halvlek "HT", spelminut "45'", "2H".
    const live = /\b\d+\s*-\s*\d+\b|\bHT\b|\b\d{1,3}'\b|\b[12]H\b/.test(t);
    return { startTime: undefined, isLive: live };
  }

  function parseHandicap(text) {
    if (!text) return null;
    const t = text.replace(/[()]/g, " ");
    const slash = /(-?\d+(?:\.\d+)?)\s*[/]\s*(-?\d+(?:\.\d+)?)/.exec(t); // kvartslina 0/0.5
    if (slash) return (Number(slash[1]) + Number(slash[2])) / 2;
    const single = /(-?\d+(?:\.\d+)?)/.exec(t);
    return single ? Number(single[1]) : null;
  }

  function climbToRow(a) {
    let node = a, row = null;
    for (let depth = 0; depth < 8 && node?.parentElement; depth++) {
      node = node.parentElement;
      const oddsCount = node.querySelectorAll('a[href*="onPrice"]').length;
      const txt = (node.innerText || "").trim();
      if (txt.length > 4 && txt.length < 600) row = node;
      if (oddsCount >= 3 && oddsCount <= 30) { row = node; break; }
    }
    return row;
  }

  // 1) Gruppera länkar per oddsId (= en marknad).
  const anchors = Array.from(document.querySelectorAll('a[href*="onPrice"]'));
  const groups = new Map();
  for (const a of anchors) {
    const p = parseOnPrice(a.getAttribute("href") || "");
    if (!p) continue;
    let g = groups.get(p.oddsId);
    if (!g) { g = { oddsId: p.oddsId, price: {}, anchor: {} }; groups.set(p.oddsId, g); }
    g.price[p.market] = p.price;
    g.anchor[p.market] = a;
  }

  // 2) Bygg rå-rader per marknad med lagnamn/tid/AH-linje.
  const rows = [];
  const diag = [];
  // COVERAGE-MÄTNING (2026-06-29): fånga de faktiska radernas text när tid INTE kunde
  // parsas (men ej live) + esports-kandidater + AH-saknad-.OddsM, så fixen baseras på
  // verklig DOM, inte gissning. Billigt, alltid på.
  const nullTimeSamples = [];
  const teamSamples = [];
  let ahMissingOddsM = 0;
  let esportsSkipped = 0;
  // Esoccer-markör: "e-"-prefix ELLER versal-handle i parentes ("(VAPOR)"). "(n)" = 1 gemen
  // (neutral plan) påverkas ej. Real-lag med 3+ versaler i parentes är extremt sällsynt här.
  const ESPORTS_RE = /^e-|\([A-Z]{3,}\)/;
  for (const g of groups.values()) {
    const homeA = g.anchor["1"] || g.anchor["h"];
    const awayA = g.anchor["2"] || g.anchor["a"];
    const homeTeam = teamOf(homeA);
    const awayTeam = teamOf(awayA);
    // ESPORTS-FILTER: esoccer ("e-Morocco (DEZZY)") matchar aldrig Pinnacle → ren brus, skippa.
    if (ESPORTS_RE.test(homeTeam || "") || ESPORTS_RE.test(awayTeam || "")) { esportsSkipped++; continue; }
    const anyA = homeA || awayA || Object.values(g.anchor)[0];
    const row = anyA ? climbToRow(anyA) : null;
    const rowText = (row?.innerText || "").replace(/\s+/g, " ").trim();
    const { startTime, isLive } = parseTimeOrLive(rowText);

    // AH-linje ligger i AH-länkens inre `.OddsM`-span (hemma-perspektiv: hemma-
    // länkens .OddsM = t.ex. "-0.50"). Faller tillbaka på att negera borta-sidans
    // .OddsM (away-perspektiv) om hemma-länken saknas. Stöder kvartslinjer.
    let handicapLine;
    const hAh = g.anchor["h"], aAh = g.anchor["a"];
    if (hAh) handicapLine = parseHandicap(hAh.querySelector(".OddsM")?.textContent) ?? undefined;
    if (handicapLine == null && aAh) {
      const aLine = parseHandicap(aAh.querySelector(".OddsM")?.textContent);
      if (aLine != null) handicapLine = -aLine;
    }
    const ahA = hAh || aAh;

    // MÄTNING (coverage): vad ser de förlorade raderna ut som?
    if (!isLive && !startTime && nullTimeSamples.length < 12) {
      nullTimeSamples.push({ home: homeTeam ?? null, away: awayTeam ?? null, codes: Object.keys(g.price), rowText: rowText.slice(0, 220) });
    }
    if (teamSamples.length < 30 && (homeTeam || awayTeam)) teamSamples.push(`${homeTeam ?? "?"} - ${awayTeam ?? "?"}`);
    if ((hAh || aAh) && handicapLine == null) ahMissingOddsM++;

    for (const [market, price] of Object.entries(g.price)) {
      rows.push({ oddsId: g.oddsId, market, price, homeTeam, awayTeam, startTime, handicapLine, isLive });
    }

    if (diagnose && diag.length < 10) {
      // För AH-grupper (h/a): dumpa DOM kring hemma-AH-ankaret så vi ser var
      // handikapp-linjen (-0.5/+0.5) bor relativt oddset → exakt extraktion.
      const hAnchor = g.anchor["h"];
      const ahDom = hAnchor ? {
        ahHtml: (hAnchor.outerHTML || "").replace(/\s+/g, " ").slice(0, 160),
        parentHtml: (hAnchor.parentElement?.outerHTML || "").replace(/\s+/g, " ").slice(0, 320),
        prevSib: (hAnchor.parentElement?.previousElementSibling?.innerText || "").replace(/\s+/g, " ").slice(0, 40),
        nextSib: (hAnchor.parentElement?.nextElementSibling?.innerText || "").replace(/\s+/g, " ").slice(0, 40),
      } : null;
      diag.push({
        oddsId: g.oddsId, markets: Object.keys(g.price),
        homeTitle: homeA?.getAttribute("title"), awayTitle: awayA?.getAttribute("title"),
        ahTitle: ahA?.getAttribute("title") ?? null, handicapLine: handicapLine ?? null,
        startTime: startTime ?? null, isLive,
        rowText: rowText.slice(0, 180),
        ...(ahDom ? { ahDom } : {}),
      });
    }
  }

  // Hoppa över live-rader (vi vill prematch-linjer).
  const prematch = rows.filter((r) => !r.isLive);

  // RECON (alltid, billigt): histogram över ALLA marknadskoder + prov på grupper vars
  // koder INTE är rena 1x2/AH (= totals-kandidater) med DOM-kontext (titlar, .OddsM/.OddsL
  // = ev. linje, celltext). Skrivs till data/_sbobet-diag.json + committas → så vi kan
  // kalibrera totals-parsern utan att kunna nå SBOBET lokalt/via Actions-trigger.
  const STD = new Set(["1", "x", "2", "h", "a"]);
  const marketHist = {};
  for (const a of anchors) { const p = parseOnPrice(a.getAttribute("href") || ""); if (p) marketHist[p.market] = (marketHist[p.market] || 0) + 1; }
  const totalsSamples = [];
  for (const g of groups.values()) {
    const codes = Object.keys(g.price);
    if (codes.every((c) => STD.has(c))) continue; // ren 1x2/AH → ej intressant
    if (totalsSamples.length >= 12) break;
    const anyA = Object.values(g.anchor)[0];
    const cell = (anyA && anyA.closest) ? (anyA.closest("td,div") || anyA.parentElement) : null;
    const span = (a, sel) => (a && a.querySelector ? (a.querySelector(sel)?.textContent || "").trim() : "");
    totalsSamples.push({
      oddsId: g.oddsId, codes, prices: g.price,
      titles: Object.fromEntries(codes.map((c) => [c, g.anchor[c]?.getAttribute("title") || null])),
      oddsM: Object.fromEntries(codes.map((c) => [c, span(g.anchor[c], ".OddsM")])),
      oddsL: Object.fromEntries(codes.map((c) => [c, span(g.anchor[c], ".OddsL")])),
      cellText: (cell?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }
  const nullTimeTotal = rows.length ? new Set(rows.filter((r) => !r.isLive && !r.startTime).map((r) => r.oddsId)).size : 0;
  return { rows: prematch, liveSkipped: rows.length - prematch.length, diag, anchorCount: anchors.length, marketHist, totalsSamples, nullTimeSamples, teamSamples, ahMissingOddsM, nullTimeTotal, esportsSkipped };
}

async function scrapeUrl(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
      console.warn(`[sbobet-action] goto-fel ${url}: ${e?.message}`);
    });
    await page.waitForTimeout(SETTLE_MS);
    const result = await page.evaluate(extractInPage, DIAGNOSE).catch((e) => {
      console.warn(`[sbobet-action] evaluate-fel ${url}: ${e?.message}`);
      return { rows: [], liveSkipped: 0, diag: [], anchorCount: 0, marketHist: {}, totalsSamples: [] };
    });
    console.log(`[sbobet-action] ${url}: ${result.anchorCount} onPrice-länkar → ${result.rows.length} prematch-rå-rader (hoppade ${result.liveSkipped ?? 0} live)`);
    console.log(`[sbobet-cov] ${url}: null-tid-grupper=${result.nullTimeTotal ?? 0} | esports-skippade=${result.esportsSkipped ?? 0} | AH utan .OddsM=${result.ahMissingOddsM ?? 0}`);
    for (const s of (result.nullTimeSamples ?? []).slice(0, 8)) console.log(`[sbobet-cov] NULL-TID: ${JSON.stringify(s)}`);
    console.log(`[sbobet-cov] lag-prov: ${JSON.stringify((result.teamSamples ?? []).slice(0, 20))}`);
    if (DIAGNOSE && result.diag?.length) {
      console.log(`[sbobet-action] DIAGNOSPROV (${url}):`);
      for (const d of result.diag) console.log(`   ${JSON.stringify(d)}`);
    }
    return { url, ...result };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const start = Date.now();
  const deadline = installHardDeadline({
    budgetMs: Number(process.env.SBOBET_DEADLINE_MS) || 7 * 60 * 1000,
    label: "sbobet-action",
  });

  console.log(`[sbobet-action] Startar stealth-Chromium mot ${URLS.length} vy(er)...`);
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-GB",
    timezoneId: "Europe/Stockholm",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  const allRaw = [];
  const reconHist = {};
  const reconTotalsSamples = [];
  const reconPerUrl = [];
  // PARALLELLT: båda vyerna skrapas samtidigt (egen page var) → cykeltid ≈ MAX(sida)
  // istället för SUM(sidor). Halverar ~sbobet-cadensen. Varje scrapeUrl öppnar+stänger
  // sin egen page i contextet, så de stör inte varandra.
  const results = await Promise.all(URLS.map((url) => scrapeUrl(context, url)));
  for (const res of results) {
    allRaw.push(...(res.rows ?? []));
    for (const [k, v] of Object.entries(res.marketHist ?? {})) reconHist[k] = (reconHist[k] || 0) + v;
    for (const s of res.totalsSamples ?? []) if (reconTotalsSamples.length < 24) reconTotalsSamples.push({ url: res.url, ...s });
    reconPerUrl.push({ url: res.url, anchors: res.anchorCount ?? 0, marketHist: res.marketHist ?? {} });
  }
  await browser.close().catch(() => {});

  // RECON-fil (committas av workflowen) → läsbar via git utan SBOBET-åtkomst lokalt.
  // Visar vilka marknadskoder SBOBET-vyn faktiskt renderar (totals-koder bortom
  // 1/x/2/h/a) + DOM-prov så totals-parsern kan kalibreras.
  if (DIAGNOSE) {
    try {
      const diagPath = path.join(DATA_DIR, "_sbobet-diag.json");
      writeJsonPreservingCache(diagPath, {
        updatedAt: new Date().toISOString(),
        urls: URLS,
        marketHist: reconHist,
        perUrl: reconPerUrl,
        totalsSamples: reconTotalsSamples,
        note: "Recon: marknadskod-histogram + icke-1x2/AH-grupper (totals-kandidater) m. DOM-kontext.",
      }, { label: "sbobet-diag", isEmpty: () => false, countOf: () => 1 });
    } catch (e) { console.warn("[sbobet-action] diag-skrivning misslyckades:", e?.message); }
  }

  const events = parseSbobetMarkets(allRaw);
  const marketCount = events.reduce((a, e) => a + e.markets.length, 0);
  const ahCount = events.reduce((a, e) => a + e.markets.filter((m) => m.marketType === "AH").length, 0);
  const payload = {
    ...toSbobetRowsFile(events),
    summary: {
      urls: URLS,
      rawRows: allRaw.length,
      events: events.length,
      markets: marketCount,
      ahMarkets: ahCount,
      ml1x2Markets: marketCount - ahCount,
      durationMs: Date.now() - start,
    },
  };

  deadline.cancel();
  const isEmpty = (p) => !p?.events || Object.keys(p.events).length === 0;
  const countOf = (p) => (p?.events ? Object.keys(p.events).length : 0);
  writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "sbobet-action", isEmpty, countOf });
  console.log(
    `[sbobet-action] Klart: ${events.length} events, ${marketCount} marknader (${ahCount} AH, ${marketCount - ahCount} 1X2) ` +
      `ur ${allRaw.length} rå-rader på ${((Date.now() - start) / 1000).toFixed(1)}s.`,
  );
  // Vänta in DB-speglingen INNAN processen exit:ar (annars abortas POSTen → DB stale).
  await flushOddsDbMirrors();
}

main().catch((error) => {
  console.error("[sbobet-action] Fatal:", error);
  process.exit(1);
});
