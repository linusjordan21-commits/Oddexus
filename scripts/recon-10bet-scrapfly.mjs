/**
 * recon-10bet-scrapfly.mjs — 10bet DOM-skrap-recon via Scrapfly.
 * Odds-feeden är binär .bin (custom DataView) → ingen JSON-väg. MEN Playtech Vision-
 * widgeten RENDERAR oddsen i DOM:en (till skillnad från tipwins inerta app), så vi
 * DOM-skrapar som prontosport. Vi renderar fotbolls-sidan, accepterar cookies, scrollar,
 * och dumpar pris-rader (3 odds = 1X2 + team-labels) så vi hittar selektorerna.
 * Secret: SCRAPER_API_KEY. Output: data/_recon-10bet-scrapfly.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-scrapfly.json");
const PAGE = process.env.TENBET_URL || "https://www.10bet.se/sports/football/matches/today";

const ACCEPT = `
for(var L of ['Acceptera alla','Godkänn alla','Acceptera','Tillåt alla','Accept all','OK','Jag godkänner']){
  var els=[].slice.call(document.querySelectorAll('button,a,[role=button]'));
  var hit=els.find(function(e){return (e.textContent||'').trim().toLowerCase().indexOf(L.toLowerCase())>=0});
  if(hit){try{hit.click();}catch(e){} break;}
}
for(var i=0;i<5;i++){window.scrollBy(0,1200);}
return JSON.stringify({ok:1});`;

// Playtech Vision-DOM: ta-* klasser. Kartlägg taxonomin + en EVENT-struktur så vi
// hittar event-container, lagnamn och 1X2-marknadens MarketType-kod.
const EXTRACT = `
var all=[].slice.call(document.querySelectorAll('[class*="ta-"]'));
// distinkta ta-MarketType-koder
var mtypes={};all.forEach(function(e){var m=(e.className||'').toString().match(/ta-MarketType-([A-Za-z0-9]+)/);if(m)mtypes[m[1]]=(mtypes[m[1]]||0)+1;});
// distinkta ta-klass-tokens (taxonomi)
var toks={};all.forEach(function(e){(e.className||'').toString().split(/\\s+/).forEach(function(c){if(/^ta-[A-Za-z]/.test(c)&&!/MarketId|EventId|SelectionId|Id-/.test(c))toks[c]=(toks[c]||0)+1;});});
// hitta event-containers (ta-Event / ta-EventCard / ta-...Event...)
var eventSel=Object.keys(toks).filter(function(t){return /event/i.test(t)&&!/eventid/i.test(t)});
var evEls=document.querySelectorAll(eventSel.map(function(s){return '.'+s}).join(',')||'.ta-Event');
// dumpa ETT events struktur: lagnamn-kandidater + marknader med MarketType + odds
function sample(ev){
  var compEls=[].slice.call(ev.querySelectorAll('[class*="ta-"]')).filter(function(e){var c=(e.className||'').toString();return /competitor|participant|teamname|eventname|name/i.test(c)&&e.children.length<=1&&(e.textContent||'').trim().length>1&&(e.textContent||'').trim().length<40;});
  var comps=[].slice.call(new Set(compEls.map(function(e){return (e.className||'').toString().match(/ta-[A-Za-z]+/)[0]+'='+(e.textContent||'').trim()}))).slice(0,8);
  var mkts=[].slice.call(ev.querySelectorAll('[class*="ta-MarketType-"]')).slice(0,6).map(function(m){var mt=(m.className||'').toString().match(/ta-MarketType-([A-Za-z0-9]+)/)[1];var sels=[].slice.call(m.querySelectorAll('[class*="ta-SelectionButton"],[role=button]')).map(function(s){return (s.textContent||'').replace(/\\s+/g,' ').trim().slice(0,24)}).filter(Boolean).slice(0,6);return {mt:mt,sels:sels};});
  return {text:(ev.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),comps:comps,mkts:mkts,cls:(ev.className||'').toString().slice(0,100)};
}
var samples=[].slice.call(evEls).slice(0,4).map(sample);
// EventListItem-struktur: dumpa leaf-element {cls,text} så vi hittar lagnamn + tid.
var items=[].slice.call(document.querySelectorAll('.ta-EventListItem')).slice(0,2);
var itemDump=items.map(function(it){
  var leaves=[].slice.call(it.querySelectorAll('[class*="ta-"]')).filter(function(e){return e.children.length===0&&(e.textContent||'').trim().length>0&&(e.textContent||'').trim().length<30;}).slice(0,30).map(function(e){return {cls:((e.className||'').toString().match(/ta-[A-Za-z][A-Za-z0-9-]*/g)||[]).slice(0,3).join(' '),t:(e.textContent||'').trim().slice(0,28)};});
  return {leaves:leaves,html:it.outerHTML.replace(/style="[^"]*"/g,'').slice(0,1600)};
});
return JSON.stringify({url:location.href,title:document.title,eventCount:evEls.length,itemCount:document.querySelectorAll('.ta-EventListItem').length,itemDump:itemDump});`;

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

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY, page: PAGE };
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const scenario = [{ wait: 8000 }, { execute: { script: ACCEPT, timeout: 6000 } }, { wait: 9000 }, { execute: { script: EXTRACT, timeout: 10000 } }];
  let json, status, text;
  for (let attempt = 1; attempt <= 3; attempt++) {
    ({ status, json, text } = await getJson(scrapflyUrl(scenario, PAGE)));
    if (status === 504 || status === 502 || status === 429) { out.retries = (out.retries || 0) + 1; continue; }
    break;
  }
  out.http = status;
  out.scrapflyMessage = (typeof json?.message === "string" ? json.message : json?.message?.message) || null;
  out.pageStatus = json?.result?.status_code;
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
  for (const r of sr) { try { const o = JSON.parse(r); if (o.itemDump !== undefined) out.extract = o; } catch { /* */ } }
  if (status !== 200 && !out.extract) out.errBody = (text || "").slice(0, 1200);
  console.log(`[10bet-dom] http=${status} url=${out.extract?.url} items=${out.extract?.itemCount}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[10bet-dom] fel:", e); process.exit(1); });
