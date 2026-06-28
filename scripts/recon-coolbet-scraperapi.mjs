/**
 * recon-coolbet-scraperapi.mjs — Coolbet-rekon via valfri scraping-API-leverantör
 * (alla löser Imperva ABP + residential-proxy på sin sida). PROVIDER-AGNOSTISK:
 * funkar med ScraperAPI / ScrapingBee / Scrapfly / ZenRows — välj den du kommer
 * in på. Renderar Coolbets odds-sida, dumpar HTML + ev. fångade XHR/inbäddad
 * state till data/_coolbet-scraperapi-recon.json → vi ser API/odds-formen och
 * bygger scrapern mot den.
 *
 * Secrets (GitHub): SCRAPER_PROVIDER (zenrows|scrapingbee|scraperapi|scrapfly|scrapedo)
 *                   SCRAPER_API_KEY  (nyckeln från vald leverantör)
 * Inga hemligheter i repo/loggar.
 */

import fs from "node:fs";
import path from "node:path";

const PROVIDER = (process.env.SCRAPER_PROVIDER || "").trim().toLowerCase();
const API_KEY = (process.env.SCRAPER_API_KEY || process.env.ZENROWS_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_coolbet-scraperapi-recon.json");
const HEAD = 5000;

const TARGETS = [
  "https://www.coolbet.com/sv/odds/recommendations",
  "https://www.coolbet.com/sv/odds/fotboll",
];

// Bygg leverantörens API-URL. Alla renderar JS + premium/residential-proxy + SE-geo.
function buildApiUrl(provider, target) {
  const enc = encodeURIComponent(target);
  switch (provider) {
    case "zenrows":
      return `https://api.zenrows.com/v1/?apikey=${API_KEY}&url=${enc}&js_render=true&premium_proxy=true&proxy_country=se&json_response=true&wait=9000`;
    case "scrapingbee":
      return `https://app.scrapingbee.com/api/v1/?api_key=${API_KEY}&url=${enc}&render_js=true&premium_proxy=true&country_code=se&wait=9000`;
    case "scraperapi":
      return `https://api.scraperapi.com/?api_key=${API_KEY}&url=${enc}&render=true&country_code=se&ultra_premium=true&wait_for_selector=body`;
    case "scrapfly":
      return `https://api.scrapfly.io/scrape?key=${API_KEY}&url=${enc}&render_js=true&asp=true&country=se&rendering_wait=9000`;
    case "scrapedo":
    case "scrape.do":
      // super=true → residential ("Super") proxy; render=true → headless browser;
      // geoCode=se → svensk IP; customWait → vänta in odds-rendering.
      return `https://api.scrape.do/?token=${API_KEY}&url=${enc}&render=true&super=true&geoCode=se&customWait=9000`;
    default:
      return null;
  }
}

// Plocka ut renderad HTML + ev. fångade XHR ur leverantörens svar (formaten skiljer).
function extractFromResponse(provider, status, text) {
  let html = "", xhr = [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* råtext = HTML */ }
  if (provider === "zenrows" && parsed) {
    html = parsed.html ?? "";
    xhr = Array.isArray(parsed.xhr) ? parsed.xhr : [];
  } else if (provider === "scrapfly" && parsed) {
    html = parsed?.result?.content ?? "";
    // Scrapfly kan ge browser_data.xhr_calls
    xhr = Array.isArray(parsed?.result?.browser_data?.xhr_calls) ? parsed.result.browser_data.xhr_calls : [];
  } else {
    // ScraperAPI / ScrapingBee returnerar råa HTML-bytes.
    html = parsed ? JSON.stringify(parsed).slice(0, 200000) : text;
  }
  return { html: html || "", xhr };
}

function impervaSig(s) { return !!s && /Pardon Our Interruption|_Incapsula_Resource|Incapsula/i.test(s); }

// Leta API-hintar i renderad HTML/JS (om vi inte fick XHR-capture).
function extractApiHints(html) {
  if (!html) return [];
  const hints = new Set();
  for (const m of html.matchAll(/["'`](\/(?:api|sb|sportsbook|graphql|offering)\/[a-zA-Z0-9/_\-.?=&{}:]+)["'`]/g)) hints.add(m[1]);
  for (const m of html.matchAll(/https?:\/\/[a-zA-Z0-9.\-]+\/(?:api|sb|sportsbook|offering|graphql)\/[a-zA-Z0-9/_\-.]+/g)) hints.add(m[0]);
  for (const m of html.matchAll(/["'`](https?:\/\/[a-zA-Z0-9.\-]*(?:sportsbook|sb-?api|odds|offering|book)[a-zA-Z0-9.\-/_]*)["'`]/gi)) hints.add(m[1]);
  return [...hints].slice(0, 120);
}

// Balanserad-klammer-parse av window.__ENVIRONMENT__ = {...}.
function extractEnvObject(html) {
  const anchor = "__ENVIRONMENT__";
  const at = html.indexOf(anchor);
  if (at < 0) return null;
  const objStart = html.indexOf("{", at);
  if (objStart < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = objStart; i < html.length; i += 1) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return html.slice(objStart, i + 1); }
  }
  return null;
}

// Plocka alla <script src> + <link href> (för att hitta + grep:a JS-bundles).
function extractAssets(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) out.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.js[^"']*)["']/g)) out.add(m[1]);
  return [...out];
}

// Hämta en statisk asset (JS-bundle) genom leverantören UTAN JS-render (snabbt/billigt).
function buildAssetUrl(provider, target) {
  const enc = encodeURIComponent(target);
  switch (provider) {
    case "zenrows": return `https://api.zenrows.com/v1/?apikey=${API_KEY}&url=${enc}&premium_proxy=true&proxy_country=se`;
    case "scrapingbee": return `https://app.scrapingbee.com/api/v1/?api_key=${API_KEY}&url=${enc}&premium_proxy=true&country_code=se`;
    case "scraperapi": return `https://api.scraperapi.com/?api_key=${API_KEY}&url=${enc}&country_code=se`;
    case "scrapfly": return `https://api.scrapfly.io/scrape?key=${API_KEY}&url=${enc}&asp=true&country=se`;
    case "scrapedo": case "scrape.do": return `https://api.scrape.do/?token=${API_KEY}&url=${enc}&super=true&geoCode=se`;
    default: return null;
  }
}

// Grep:a JS-bundle-text efter endpoint-mönster (sportsbook/odds-API). Brett:
// minifierad kod behåller sträng-literaler, så path-fragment finns kvar.
function grepEndpoints(js) {
  const hits = new Set();
  // 1) Absoluta + relativa path-literaler med API-ord någonstans.
  for (const m of js.matchAll(/["'`](\/[a-zA-Z0-9/_\-.{}$:]*(?:api|sb|sportsbook|offering|graphql|matches|categories|coupon|markets|events|odds)[a-zA-Z0-9/_\-.{}$:]*)["'`]/gi)) hits.add(m[1]);
  // 2) Path-fragment som börjar med vN/ eller sb/ (versionerade API:er).
  for (const m of js.matchAll(/["'`]((?:\/)?(?:v[0-9]|sb|sportsbook|offering)\/[a-zA-Z0-9/_\-.{}$:]{2,80})["'`]/gi)) hits.add(m[1]);
  // 3) Absoluta URL:er till API-ish hosts.
  for (const m of js.matchAll(/["'`](https?:\/\/[a-zA-Z0-9.\-]*(?:api|sb|sportsbook|offering|odds|book)[a-zA-Z0-9.\-]*\/[a-zA-Z0-9/_\-.{}$:]*)["'`]/gi)) hits.add(m[1]);
  // 4) Bas-URL-tilldelningar (baseURL/apiBase/endpoint = "...").
  for (const m of js.matchAll(/(?:baseURL|baseUrl|apiBase|apiUrl|API_BASE|API_URL|BASE_URL|endpoint|ENDPOINT|sportsbookUrl|SPORTSBOOK_URL|oddsUrl)\s*[:=]\s*["'`]([^"'`]{3,160})["'`]/g)) hits.add(m[1]);
  // 5) Webpack public path (för chunk-URL:er).
  for (const m of js.matchAll(/["'`](\/static\/js\/[a-zA-Z0-9.\-]+\.js)["'`]/g)) hits.add(m[1]);
  return [...hits].filter((h) => h && h.length < 200);
}

async function fetchAsset(target) {
  const url = buildAssetUrl(PROVIDER, target);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try { const r = await fetch(url, { signal: controller.signal }); return await r.text(); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Direkt-hämtning (UTAN scraping-API) — statiska JS-assets är ofta CDN-cachade
// förbi Imperva. Returnerar null om blockerad (Imperva-HTML) eller fel.
async function fetchDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "user-agent": DESKTOP_UA, accept: "*/*", referer: "https://www.coolbet.com/sv/odds" } });
    const t = await r.text();
    if (/Pardon Our Interruption|_Incapsula_Resource/i.test(t.slice(0, 1500))) return null;
    if (!/[;={}()]/.test(t.slice(0, 200))) return null; // ser inte ut som JS
    return t;
  } catch { return null; } finally { clearTimeout(timer); }
}

// Extrahera webpack chunk-URL:er ur en bundle via chunk-hash-map ({id:"hash",...}).
function extractChunkUrls(js, base = "https://www.coolbet.com/static/js/") {
  const urls = new Set();
  for (const m of js.matchAll(/\{((?:\s*"?\d+"?\s*:\s*"[0-9a-f]{6,}"\s*,?){4,})\}/g)) {
    for (const pair of m[1].matchAll(/"?(\d+)"?\s*:\s*"([0-9a-f]{6,})"/g)) {
      urls.add(`${base}${pair[1]}.${pair[2]}.js`);
    }
  }
  return [...urls];
}

// Styrka-signal: hur "sportsbook-data-API" en chunk ser ut.
function sbSignal(js) {
  let s = 0;
  for (const w of ["/sb/", "sportsbook", "matches", "coupon", "markets", "outcomes", "selections", "categories", "match-list", "/odds"]) {
    if (js.includes(w)) s += 1;
  }
  return s;
}

// Spara RÅ kontext (±radie tecken) runt varje token-träff → så vi SER hur API-URL:en
// byggs (bas + path-concat). Max N träffar per token.
function contextSnippets(js, tokens, radius = 130, perToken = 4) {
  const out = [];
  for (const tok of tokens) {
    let from = 0, n = 0;
    while (n < perToken) {
      const i = js.indexOf(tok, from);
      if (i < 0) break;
      out.push({ tok, at: i, ctx: js.slice(Math.max(0, i - radius), i + tok.length + radius) });
      from = i + tok.length; n += 1;
    }
  }
  return out;
}

async function callProvider(target) {
  const url = buildApiUrl(PROVIDER, target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const text = await r.text();
    return { status: r.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const results = { ranAt: new Date().toISOString(), provider: PROVIDER, hasKey: !!API_KEY, navigations: [], capturedXhr: [], apiHints: [], apiHosts: {}, htmlSample: null, error: null };

  if (!PROVIDER || !buildApiUrl(PROVIDER, "x")) {
    results.error = `SCRAPER_PROVIDER saknas/ogiltig ('${PROVIDER}'). Sätt zenrows|scrapingbee|scraperapi|scrapfly.`;
  } else if (!API_KEY) {
    results.error = "SCRAPER_API_KEY saknas — lägg in den som GitHub Secret och kör om.";
  }
  if (results.error) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
    console.log(`[scraperapi-recon] ${results.error}`);
    return;
  }

  const seen = new Set();
  let firstHtml = "";
  for (const target of TARGETS) {
    const nav = { target, status: null, htmlLen: 0, imperva: null, xhrCount: 0, error: null };
    try {
      const res = await callProvider(target);
      nav.status = res.status;
      const { html, xhr } = extractFromResponse(PROVIDER, res.status, res.text);
      nav.htmlLen = html.length;
      // Imperva-flagga: bara om challenge-titeln finns (sensor-scriptet finns även
      // på den RIKTIGA sidan → matcha inte enbart på "Incapsula").
      nav.imperva = /Pardon Our Interruption|Request unsuccessful\. Incapsula/i.test(html);
      nav.xhrCount = xhr.length;
      if (!firstHtml && html.length > 1000) firstHtml = html;
      if (!results.htmlSample) results.htmlSample = html.slice(0, HEAD);
      // Om provider gav råtext-fel (ej HTML), spara början för felsökning.
      if (html.length < 200 && res.text) nav.providerBody = res.text.slice(0, 500);

      for (const x of xhr) {
        const xurl = x?.url || x?.request_url || "";
        if (/\.(png|jpe?g|svg|gif|woff2?|css|js)(\?|$)/i.test(xurl)) continue;
        const looksApi = /\/api\/|sportsbook|\/sb\/|graphql|odds|offering|matches|events|markets|coupon/i.test(xurl);
        const body = typeof x?.body === "string" ? x.body : (x?.response_body_str ?? (x?.body ? JSON.stringify(x.body) : ""));
        const isJson = /json/i.test(x?.content_type || x?.headers?.["content-type"] || "") || /^[\[{]/.test(String(body).trim());
        if (!looksApi && !isJson) continue;
        const key = String(xurl).split("?")[0] + "|" + (x?.method || "GET");
        if (seen.has(key)) continue;
        seen.add(key);
        try { results.apiHosts[new URL(xurl).host] = (results.apiHosts[new URL(xurl).host] || 0) + 1; } catch { /* */ }
        results.capturedXhr.push({ url: xurl, method: x?.method || "GET", status: x?.status ?? null, bodyLength: String(body).length, bodyHead: String(body).slice(0, HEAD) });
      }
      // Inga XHR (ScraperAPI/ScrapingBee) → leta API-hintar i renderad HTML.
      if (xhr.length === 0) {
        for (const h of extractApiHints(html)) if (!results.apiHints.includes(h)) results.apiHints.push(h);
      }
    } catch (e) { nav.error = e?.message ?? String(e); }
    results.navigations.push(nav);
    console.log(`[scraperapi-recon] (${PROVIDER}) ${target} → status=${nav.status} imperva=${nav.imperva} htmlLen=${nav.htmlLen} xhr=${nav.xhrCount} captured=${results.capturedXhr.length} ${nav.error || ""}`);
  }

  // ── Fas 2: extrahera __ENVIRONMENT__ + JS-bundles → grep:a efter odds-API ──
  if (firstHtml) {
    const envStr = extractEnvObject(firstHtml);
    if (envStr) {
      results.envObject = envStr.slice(0, 12000);
      try {
        const env = JSON.parse(envStr);
        // Plocka nycklar som ser ut som API/sportsbook/odds-baser.
        results.envApiKeys = Object.entries(env)
          .filter(([k, v]) => typeof v === "string" && /api|url|sportsbook|odds|book|host|graphql|proxy/i.test(k))
          .map(([k, v]) => `${k}=${v}`).slice(0, 60);
      } catch { /* env ej ren JSON (kan ha JS-uttryck) */ }
    }
    const assets = extractAssets(firstHtml).map((a) => (a.startsWith("http") ? a : `https://www.coolbet.com${a.startsWith("/") ? "" : "/"}${a}`));
    results.assets = assets.slice(0, 40);
    // Grep:a APP-bundles (index + numrerade chunks), HOPPA lib/polyfill/react/router
    // + Incapsula-scriptet. Den lazy-laddade sportsbook-koden ligger i en chunk.
    const jsBundles = assets.filter((a) => /\.js(\?|$)/i.test(a) && !/(polyfill|lib-react|lib-router|Incapsula|_Incapsula)/i.test(a)).slice(0, 5);
    results.bundlesGrepped = [];

    // Hämta index + numrerade bundles, behåll texten för kontext-extraktion.
    const API_TOKENS = ["/sb/", "sportsbook", "/api/", "matches", "coupon", "/fo/", "baseURL", "baseUrl", "apiUrl", "api_url", "v2/", "/odds", "match-list", "category"];
    results.contextSnippets = {};
    results.webpackRuntime = null;
    let directWorks = false;
    const allChunkUrls = new Set();

    results.savedBundles = [];
    for (const b of jsBundles) {
      const js = await fetchAsset(b);
      if (!js) { results.bundlesGrepped.push({ url: b, ok: false }); continue; }
      const hits = grepEndpoints(js);
      results.bundlesGrepped.push({ url: b, ok: true, len: js.length, hitCount: hits.length, hits: hits.slice(0, 60) });
      const snaps = contextSnippets(js, API_TOKENS);
      if (snaps.length) results.contextSnippets[b.split("/").pop()] = snaps.slice(0, 40);
      // DUMPA hela bundlen till disk → exhaustiv lokal grep utan fler CI-rundor.
      const fname = `_coolbet-bundle-${b.split("/").pop()}`;
      try { fs.writeFileSync(path.resolve(process.cwd(), "data", fname), js); results.savedBundles.push(fname); } catch { /* */ }
      for (const c of extractChunkUrls(js)) allChunkUrls.add(c);
      console.log(`[scraperapi-recon] bundle ${b.slice(-30)} → ${js.length}b, ${hits.length} hits, sparad=${fname}`);
    }
    results.chunkCount = allChunkUrls.size;

    // Testa gratis direkt-hämtning av en chunk (om vi hittade några).
    const chunkArr = [...allChunkUrls];
    if (chunkArr.length) directWorks = !!(await fetchDirect(chunkArr[0]));
    results.directAssetFetch = directWorks;

    // Jaga sportsbook-chunken bland alla chunks (om manifest hittades).
    results.sportsbookChunks = [];
    if (chunkArr.length) {
      const budget = directWorks ? Math.min(60, chunkArr.length) : Math.min(6, chunkArr.length);
      const scored = [];
      for (let i = 0; i < budget; i += 1) {
        const js = directWorks ? await fetchDirect(chunkArr[i]) : await fetchAsset(chunkArr[i]);
        if (!js) continue;
        const sig = sbSignal(js);
        if (sig >= 3) scored.push({ url: chunkArr[i], sig, js });
      }
      scored.sort((a, b) => b.sig - a.sig);
      for (const sc of scored.slice(0, 4)) {
        const hits = grepEndpoints(sc.js).filter((h) => /\/(?:sb|api|sportsbook|offering)\/|matches|categories|coupon|markets|events|outcomes|selections|odds/i.test(h) && !/\/static\/js\//.test(h) && !/facebook|pinterest|tumblr|hatena/i.test(h));
        const snaps = contextSnippets(sc.js, API_TOKENS);
        results.sportsbookChunks.push({ url: sc.url, sbSignal: sc.sig, len: sc.js.length, hits: [...new Set(hits)].slice(0, 60), ctx: snaps.slice(0, 30) });
        console.log(`[scraperapi-recon] sb-chunk ${sc.url.slice(-26)} sig=${sc.sig} → ${hits.length} odds-API-hits`);
      }
    }
    for (const h of extractApiHints(firstHtml)) if (!results.apiHints.includes(h)) results.apiHints.push(h);

    // ── Fas 3: rendera /sv/odds/fotboll LÄNGE → SPA injicerar sportsbook-route-
    // chunken + odds-XHR. Fånga injicerade script-URL:er + ev. odds i DOM. ──
    try {
      const longUrl = PROVIDER === "scrapedo" || PROVIDER === "scrape.do"
        ? `https://api.scrape.do/?token=${API_KEY}&url=${encodeURIComponent("https://www.coolbet.com/sv/odds/fotboll")}&render=true&super=true&geoCode=se&customWait=20000`
        : buildApiUrl(PROVIDER, "https://www.coolbet.com/sv/odds/fotboll");
      const r = await fetch(longUrl);
      const text = await r.text();
      const { html } = extractFromResponse(PROVIDER, r.status, text);
      results.oddsRender = { status: r.status, htmlLen: html.length };
      // Alla script/preload-URL:er (route-chunken injiceras dynamiskt).
      const scripts = new Set();
      for (const m of html.matchAll(/(?:src|href)=["']([^"']*\/static\/js\/[^"']+\.js[^"']*)["']/g)) scripts.add(m[1]);
      for (const m of html.matchAll(/["'`](\/static\/js\/[a-zA-Z0-9.\-]+\.js)["'`]/g)) scripts.add(m[1]);
      results.oddsRenderScripts = [...scripts].map((s) => (s.startsWith("http") ? s : `https://www.coolbet.com${s}`));
      // Spara DOM-prov (om odds renderats finns odds-tal + lag i DOM).
      results.oddsRenderHtmlSample = html.slice(0, 8000);
      // Nya chunks (ej redan grep:ade) → grep:a efter sb-endpoints.
      const known = new Set(jsBundles);
      const newChunks = results.oddsRenderScripts.filter((s) => !known.has(s) && !/polyfill|lib-react|lib-router/i.test(s)).slice(0, 6);
      for (const c of newChunks) {
        const js = (await fetchDirect(c)) || (await fetchAsset(c));
        if (!js) continue;
        const sig = sbSignal(js);
        const hits = grepEndpoints(js).filter((h) => /\/(?:sb|api|fo|sportsbook)\/|matches|coupon|markets|categories|outcomes|selections|odds/i.test(h) && !/\/static\/js\//.test(h) && !/facebook|pinterest|tumblr|hatena|reddit/i.test(h));
        const snaps = contextSnippets(js, ["coupon", "match-list", "/sb/", "matches", "sportsbook", "/api/", "request({path", "baseURL", "baseUrl"]);
        results.sportsbookChunks.push({ url: c, sbSignal: sig, len: js.length, hits: [...new Set(hits)].slice(0, 60), ctx: snaps.slice(0, 30), fromRender: true });
        console.log(`[scraperapi-recon] render-chunk ${c.slice(-26)} sig=${sig} → ${hits.length} hits`);
      }
      console.log(`[scraperapi-recon] odds-render: status=${results.oddsRender.status} htmlLen=${results.oddsRender.htmlLen} scripts=${results.oddsRenderScripts.length} nya=${newChunks.length}`);
    } catch (e) { results.oddsRenderError = e?.message ?? String(e); }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`[scraperapi-recon] KLART → ${results.capturedXhr.length} XHR, ${results.apiHints.length} HTML-hintar, ${(results.bundlesGrepped||[]).reduce((s,b)=>s+(b.hitCount||0),0)} bundle-hits, env-api-keys=${(results.envApiKeys||[]).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
