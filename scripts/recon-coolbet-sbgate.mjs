/**
 * recon-coolbet-sbgate.mjs — hämtar Coolbets RIKTIGA sportsbook-API (sbgate) via
 * scrape.do och dumpar JSON-svaren → så vi ser exakt odds-form + market-type-ids
 * och bygger scrapern. Bas (reverse-engineerad ur bundlarna):
 *   https://www.coolbet.com/s/sbgate/<path>   (Z(service,path)=/s/service/path)
 *   sports/fo-match/v2/coming-soon  {sportCategoryId, from, until, language, country, layout, locale, offset, timeFrame}
 *   sports/fo-match                 {matchIds:[id], language, country, layout, locale}
 *   sports/fo-market                {matchId, marketTypeId, language, country, layout}
 *   sports/fo-category/popular-leagues {language, country, limit}
 * FOOTBALL sportCategoryId = 1.  Render=true → scrape.dos browser löser Imperva.
 *
 * Secrets: SCRAPER_PROVIDER + SCRAPER_API_KEY. Dump → data/_coolbet-sbgate-recon.json.
 */

import fs from "node:fs";
import path from "node:path";

const PROVIDER = (process.env.SCRAPER_PROVIDER || "").trim().toLowerCase();
const API_KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_coolbet-sbgate-recon.json");
const SB = "https://www.coolbet.com/s/sbgate/";

// IN-PAGE-FETCH: rendera odds-SIDAN (löser Imperva + sätter reese84-cookie), kör
// sen fetch(apiPath) FRÅN sid-kontexten (cookie skickas same-origin) och lägg svaret
// i <pre> → scrape.do returnerar HTML med JSON inuti. Kringgår "render JSON-API direkt".
function scrapedoPageFetchUrl(apiUrl) {
  const js = `fetch(${JSON.stringify(apiUrl)},{headers:{accept:'application/json'}}).then(function(r){return r.text()}).then(function(t){document.body.innerHTML='<pre id=\\'SBG\\'>'+t.replace(/</g,'&lt;')+'</pre>'}).catch(function(e){document.body.innerHTML='<pre id=\\'SBG\\'>ERR:'+e+'</pre>'})`;
  const actions = [
    { Action: "Wait", Timeout: 10000 },
    { Action: "Execute", Execute: js },
    { Action: "Wait", Timeout: 9000 },
  ];
  const page = encodeURIComponent("https://www.coolbet.com/sv/odds/fotboll");
  const pwb = encodeURIComponent(JSON.stringify(actions));
  // blockResources=false → sidan bootar (annars failar SPA:n) → in-page-context giltig.
  return `https://api.scrape.do/?token=${API_KEY}&url=${page}&super=true&geoCode=se&render=true&blockResources=false&playWithBrowser=${pwb}`;
}

function viaScraper(targetUrl, render = true) {
  const enc = encodeURIComponent(targetUrl);
  switch (PROVIDER) {
    case "scrapedo": case "scrape.do":
      return `https://api.scrape.do/?token=${API_KEY}&url=${enc}&super=true&geoCode=se${render ? "&render=true&customWait=7000" : ""}`;
    case "zenrows":
      return `https://api.zenrows.com/v1/?apikey=${API_KEY}&url=${enc}&premium_proxy=true&proxy_country=se${render ? "&js_render=true" : ""}`;
    case "scrapingbee":
      return `https://app.scrapingbee.com/api/v1/?api_key=${API_KEY}&url=${enc}&premium_proxy=true&country_code=se${render ? "&render_js=true" : ""}`;
    case "scraperapi":
      return `https://api.scraperapi.com/?api_key=${API_KEY}&url=${enc}&country_code=se&ultra_premium=true${render ? "&render=true" : ""}`;
    default: return null;
  }
}

// Extrahera JSON ur scrape.do-svar (kan vara rå JSON, eller HTML-wrappad i <pre>).
function extractJson(text) {
  if (!text) return null;
  // direkt JSON?
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* */ }
  }
  // HTML-wrappad: leta första {...} eller [...] efter <body>/<pre>.
  const m = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (m) { try { return JSON.parse(m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")); } catch { /* */ } }
  const j = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (j) { try { return JSON.parse(j[1]); } catch { /* */ } }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Är svaret scrape.dos egna fel-envelope (transient rotation/502)?
function isProviderError(json) {
  return json && typeof json === "object" && "ErrorType" in json && "StatusCode" in json && !("matches" in json) && !("categories" in json);
}

async function fetchOnce(target, mode, timeoutMs) {
  const url = mode === "pagefetch" ? scrapedoPageFetchUrl(target) : viaScraper(target, mode === "render");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally { clearTimeout(timer); }
}

// render=false hänger/aborterar på Imperva-domänen; render=true returnerar men
// scrape.do ger intermittent 502 ROTATION_FAILED ("try again"). → hamra render=true
// med flera retries (varje ~30-70s). Tidsbudget håller inom 15-min-jobbet.
async function call(label, apiPath, query, renderTries = 6) {
  const qs = new URLSearchParams(query).toString();
  const target = `${SB}${apiPath}${qs ? `?${qs}` : ""}`;
  const rec = { label, target, status: null, isJson: false, imperva: false, mode: null, sample: null, keys: null, error: null, attempts: [] };
  // IN-PAGE-FETCH först (mest lovande), sen direkt render som fallback.
  const plan = [...Array.from({ length: renderTries }, () => ["pagefetch", 90000]), ["render", 75000]];
  for (const [mode, toMs] of plan) {
    try {
      const { status, text } = await fetchOnce(target, mode, toMs);
      const imperva = /Pardon Our Interruption|Request unsuccessful\. Incapsula/i.test(text);
      const json = extractJson(text);
      rec.attempts.push({ mode, status, providerErr: isProviderError(json), imperva, len: text.length });
      if (json && isProviderError(json)) { if (!rec.providerErrBody) rec.providerErrBody = text.slice(0, 600); await sleep(1500); continue; } // transient → nästa plan-steg
      // pagefetch som gav ERR: i pre → fortsätt försöka
      if (mode === "pagefetch" && /<pre[^>]*>ERR:/i.test(text)) { rec.lastPageErr = text.match(/<pre[^>]*>(ERR:[^<]{0,200})/i)?.[1]; await sleep(1500); continue; }
      rec.status = status; rec.imperva = imperva; rec.mode = mode;
      if (json) {
        rec.isJson = true;
        rec.keys = Array.isArray(json) ? `array[${json.length}]` : Object.keys(json);
        rec.sample = JSON.stringify(json).slice(0, 7000);
      } else { rec.sample = text.slice(0, 1500); }
      console.log(`[sbgate-recon] ${label} → mode=${rec.mode} status=${status} json=${rec.isJson} imperva=${imperva}`);
      return rec;
    } catch (e) { rec.error = e?.message ?? String(e); rec.attempts.push({ mode, error: rec.error }); await sleep(1000); }
  }
  console.log(`[sbgate-recon] ${label} → uttömt (sista status=${rec.status})`);
  return rec;
}

async function main() {
  const results = { ranAt: new Date().toISOString(), provider: PROVIDER, hasKey: !!API_KEY, calls: [] };
  if (!PROVIDER || !API_KEY) {
    results.error = "SCRAPER_PROVIDER/SCRAPER_API_KEY saknas.";
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
    console.log("[sbgate-recon]", results.error);
    return;
  }

  const writeOut = () => { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n"); };

  const now = new Date(results.ranAt);
  const fromISO = now.toISOString();
  const untilISO = new Date(now.getTime() + 3 * 24 * 3600 * 1000).toISOString();

  // SISTA scrape.do-lever: rendera odds-sidan med LÅNG väntan så SPA:n hydrerar +
  // renderar odds i DOM:en själv. Då parsar vi DOM (ingen API/playWithBrowser behövs).
  results.longRenders = [];
  // blockResources=false: ladda ALLA resurser (scrape.do blockar annars css/img/
  // ev. JS-chunks → SPA:n kan faila boot:en). Detta är den troligaste fixen.
  for (const wait of [45000]) {
    try {
      const u = `https://api.scrape.do/?token=${API_KEY}&url=${encodeURIComponent("https://www.coolbet.com/sv/odds/fotboll")}&super=true&geoCode=se&render=true&blockResources=false&customWait=${wait}`;
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 110000);
      const r = await fetch(u, { signal: ctrl.signal }); const txt = await r.text(); clearTimeout(t);
      const providerErr = isProviderError(extractJson(txt));
      // Odds-indikatorer i DOM: decimal-odds-mönster, match-länkar, lagnamn-struktur.
      const oddsLike = (txt.match(/>\s?\d\.\d{2}\s?</g) || []).length;
      const hasMatchDom = /fo-match|match-row|MatchRow|data-match|odds-button|outcome/i.test(txt);
      const hydrated = txt.length > 60000 || oddsLike > 10 || hasMatchDom;
      const rec = { wait, status: r.status, len: txt.length, providerErr, oddsLike, hasMatchDom, hydrated };
      // Hydrerat → DUMPA hela DOM:en till fil för parser-bygge + leta inbäddad state.
      if (hydrated && !results.savedHydrated) {
        try { fs.writeFileSync(path.resolve(process.cwd(), "data", "_coolbet-hydrated.html"), txt); results.savedHydrated = true; } catch { /* */ }
        // Inbäddad app-state (Apollo/redux/preloaded) som kan innehålla odds-JSON?
        const stateMarkers = ["__PRELOADED_STATE__", "__APOLLO_STATE__", "__NEXT_DATA__", "window.__data", "sbgate", "fo-match", "outcomes", "marketTypeId"];
        results.hydratedMarkers = stateMarkers.filter((s) => txt.includes(s));
        // Hitta första match-ish region (länk till /odds/.../match eller decimal-odds).
        const mi = txt.search(/\/sv\/odds\/[a-z-]+\/[a-z0-9-]+\/\d|matchId|"odds"|data-match|outcome/i);
        results.hydratedBodySample = mi >= 0 ? txt.slice(mi - 200, mi + 3000) : txt.slice(40000, 43000);
      }
      results.longRenders.push(rec); writeOut();
      console.log(`[sbgate-recon] longRender wait=${wait} status=${r.status} len=${txt.length} oddsLike=${oddsLike} hasMatchDom=${hasMatchDom} hydrated=${hydrated} providerErr=${providerErr}`);
      if (hydrated) break;
    } catch (e) { results.longRenders.push({ wait, error: e?.message ?? String(e) }); writeOut(); }
  }
  // In-page-fetch av sbgate-API:t (nu med blockResources=false → sidan bootar).
  const coming = await call("coming-soon football", "sports/fo-match/v2/coming-soon", {
    sportCategoryId: 62, language: "en", country: "SE", locale: "en", layout: "EUROPEAN", offset: 0, from: fromISO, until: untilISO, timeFrame: "24",
  }, 3);
  results.calls.push(coming); writeOut();

  // 4) Om vi fick matcher: hämta en match-detalj (fulla marknader → market-type-ids).
  // Plocka första id ur sample-strängen (kan vara trunkerad → regex, ej JSON.parse).
  let firstMatchId = null;
  if (coming.isJson && coming.sample) {
    const m = coming.sample.match(/"(?:id|matchId)":\s*"?(\d{4,})"?/);
    if (m) firstMatchId = m[1];
  }
  results.firstMatchId = firstMatchId; writeOut();
  let detail = null;
  if (firstMatchId) {
    detail = await call("fo-match detail", "sports/fo-match", { matchIds: firstMatchId, language: "en", country: "SE", locale: "en", layout: "EUROPEAN" }, 3);
    results.calls.push(detail); writeOut();
  }

  // 5) PRIS-PROBE: plocka ett market-id ur match-detaljen och anropa betslip-info.
  // Detta är frågan: returnerar betslip-info faktiska ODDS? (bekräftar REST-pris-vägen).
  let firstMarketId = null;
  const detailSample = (detail && detail.sample) || (coming && coming.sample) || "";
  const mk = detailSample.match(/"markets?":\s*\[\s*\{\s*"id":\s*"?(\d{4,})"?/) || detailSample.match(/"market_id":\s*"?(\d{4,})"?/);
  if (mk) firstMarketId = mk[1];
  results.firstMarketId = firstMarketId; writeOut();
  if (firstMarketId) {
    const bs = await call("betslip-info PRICE", `sports/fo-market/betslip-info/${firstMarketId}`, { language: "en", country: "SE", locale: "en", layout: "EUROPEAN" }, 4);
    // Markera om svaret innehåller odds/pris (decimaltal > 1 i price/odds-fält).
    bs.hasOdds = !!(bs.sample && /"(?:price|odds|decimal_odds|raw_odds)":\s*"?\d+\.?\d*/i.test(bs.sample));
    results.calls.push(bs); writeOut();
    console.log(`[sbgate-recon] betslip-info marketId=${firstMarketId} → hasOdds=${bs.hasOdds}`);
  }

  writeOut();
  console.log(`[sbgate-recon] KLART → ${results.calls.filter((c) => c.isJson).length}/${results.calls.length} JSON-svar`);
}

main().catch((e) => { console.error(e); process.exit(1); });
