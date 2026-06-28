/**
 * recon-10bet-corners.mjs — RECON: erbjuder 10bet hörn-marknader, och var?
 *
 * List-vyn (matches/today) visar bara MRES (1X2) + HCTG (mål-total). Hörn skulle
 * ligga på per-match-detaljsidan (/.../events/<id>). Probe:n hämtar today-listan,
 * plockar första event-href, laddar detaljsidan och dumpar ALLA .ta-MarketType-*-
 * klasser + namn → ser om hörn finns (HCTC/Corners/Hörnor) och under vilken kod.
 *
 * Secret: SCRAPER_API_KEY. Output: data/_recon-10bet-corners.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-corners.json");
const LIST = "https://www.10bet.se/sports/football/matches/today";

const FIND_HREF = `
for(var L of ['Acceptera alla','Godkänn alla','Acceptera','Accept all','OK']){var els=[].slice.call(document.querySelectorAll('button,a,[role=button]'));var hit=els.find(function(e){return (e.textContent||'').trim().toLowerCase().indexOf(L.toLowerCase())>=0});if(hit){try{hit.click()}catch(e){}break}}
for(var s=0;s<6;s++){window.scrollBy(0,1100);}
var hrefs=[].slice.call(document.querySelectorAll('a[href*="/events/"]')).map(function(a){return a.getAttribute('href')}).filter(Boolean);
return JSON.stringify({hrefs:hrefs.slice(0,5)});`;

const DUMP_MARKETS = `
for(var L of ['Acceptera alla','Godkänn alla','Acceptera','Accept all','OK']){var els=[].slice.call(document.querySelectorAll('button,a,[role=button]'));var hit=els.find(function(e){return (e.textContent||'').trim().toLowerCase().indexOf(L.toLowerCase())>=0});if(hit){try{hit.click()}catch(e){}break}}
for(var s=0;s<10;s++){window.scrollBy(0,900);}
// alla market-type-klasser
var types={};
[].slice.call(document.querySelectorAll('[class*="ta-MarketType-"]')).forEach(function(el){
  (el.className||'').split(/\\s+/).forEach(function(c){var m=c.match(/^ta-MarketType-(.+)$/);if(m)types[m[1]]=(types[m[1]]||0)+1;});
});
// marknads-rubriker (för att se 'Hörnor'/'Corners')
var titles=[].slice.call(document.querySelectorAll('.ta-MarketName,.ta-marketName,[class*="MarketName"],[class*="market-name"]')).map(function(e){return (e.textContent||'').trim()}).filter(Boolean).slice(0,40);
var cornerTitles=titles.filter(function(t){return /corner|hörn/i.test(t)});
var bodyHasCorner=/corner|hörn/i.test(document.body.innerText||'');
return JSON.stringify({marketTypes:types,titles:titles,cornerTitles:cornerTitles,bodyHasCorner:bodyHasCorner,bodyLen:(document.body.innerHTML||'').length});`;

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se",
    rendering_wait: "5000", timeout: "60000", retry: "false",
    proxy_pool: "public_residential_pool", format: "json",
    js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url"),
  });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function getJson(url, timeoutMs = 175000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); const text = await r.text(); try { return { status: r.status, json: JSON.parse(text), text }; } catch { return { status: r.status, json: null, text }; } }
  finally { clearTimeout(t); }
}
function readSteps(json) {
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
  for (const r of sr) { try { return JSON.parse(r); } catch { /* */ } }
  return null;
}

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  // 1) lista → event-href
  const s1 = [{ wait: 6000 }, { execute: { script: FIND_HREF, timeout: 8000 } }, { wait: 4000 }, { execute: { script: FIND_HREF, timeout: 8000 } }];
  const r1 = await getJson(scrapflyUrl(s1, LIST));
  const got = readSteps(r1.json);
  out.listHttp = r1.status; out.hrefs = got?.hrefs ?? null;
  const href = (got?.hrefs || [])[0];
  if (!href) { out.note = "ingen event-href hittad"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); console.log("[10bet-corners] ingen href"); return; }
  const eventUrl = href.startsWith("http") ? href : `https://www.10bet.se${href}`;
  out.eventUrl = eventUrl;
  // 2) detaljsida → dumpa marknadstyper
  const s2 = [{ wait: 6000 }, { execute: { script: DUMP_MARKETS, timeout: 9000 } }, { wait: 5000 }, { execute: { script: DUMP_MARKETS, timeout: 9000 } }];
  const r2 = await getJson(scrapflyUrl(s2, eventUrl));
  out.detailHttp = r2.status;
  out.detail = readSteps(r2.json);
  console.log(`[10bet-corners] list=${r1.status} detail=${r2.status} cornerTitles=${JSON.stringify(out.detail?.cornerTitles||[])} bodyHasCorner=${out.detail?.bodyHasCorner} types=${JSON.stringify(Object.keys(out.detail?.marketTypes||{}))}`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[10bet-corners] fel:", e); process.exit(1); });
