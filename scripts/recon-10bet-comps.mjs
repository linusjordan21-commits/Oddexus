/**
 * recon-10bet-comps.mjs — ENGÅNGS: är en BILLIG en-render-walk genom 10bet:s
 * tävlingar (competitions) möjlig? 10bet har ingen JSON-API (binär feed, netCount=0)
 * → DOM enda vägen. /matches/today visar bara 24. Matcher finns per tävling.
 *
 * Frågor: (1) hur många competition-länkar finns på /competitions? (2) efter klick
 * in i en tävling — finns de ANDRA tävlingslänkarna kvar (persistent nav → vi kan
 * klicka oss igenom flera i SAMMA render)? (3) hur många matcher per tävling?
 * Rapport → data/_recon-10bet-comps.json. ENDAST dispatch. Secret: SCRAPER_API_KEY.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-comps.json");
const PAGE = "https://www.10bet.se/sports/football/competitions";

const COOKIE = `
var btns=[].slice.call(document.querySelectorAll('button,[role=button]'));
var hit=btns.find(function(e){var t=(e.textContent||'').trim();return ['Acceptera alla','Godkänn alla','Acceptera','Tillåt alla','Jag godkänner','Acceptera och fortsätt'].indexOf(t)>=0;});
var c=false;if(hit){try{hit.click();c=true;}catch(e){}}
return JSON.stringify({cookie:c});`;

// Samla competition-länkar (href + namn), spara i window. Rapportera antal + sample.
const LIST = `
for(var s=0;s<6;s++){window.scrollBy(0,1000);}
function comps(){var seen={};var out=[];[].slice.call(document.querySelectorAll('a[href*="/competitions/"]')).forEach(function(a){var h=a.getAttribute('href')||'';var m=h.match(/\\/competitions\\/(\\d+)/);if(!m)return;var id=m[1];if(seen[id])return;seen[id]=1;out.push({id:id,href:h,name:(a.textContent||'').trim().slice(0,40)});});return out;}
var list=comps();
window.__comps=list;window.__ci=0;
return JSON.stringify({compCount:list.length,sample:list.slice(0,12),items:document.querySelectorAll('.ta-EventListItem').length});`;

// Klicka in i nästa tävling (via href), harvest matcher, OCH räkna kvarvarande
// competition-länkar (persistent nav?).
const CLICKNEXT = `
var i=window.__ci||0;var list=window.__comps||[];var c=list[i];window.__ci=i+1;
var clicked=null;
if(c){var a=document.querySelector('a[href="'+c.href+'"]')||document.querySelector('a[href*="/competitions/'+c.id+'"]');if(a){try{a.click();clicked=c.href;}catch(e){}}}
return JSON.stringify({clicked:clicked,target:c||null});`;
const HARVEST = `
for(var s=0;s<8;s++){window.scrollBy(0,1000);}
var items=document.querySelectorAll('.ta-EventListItem').length;
var titles=[].slice.call(document.querySelectorAll('.ta-EventListItem')).slice(0,5).map(function(it){return [].slice.call(it.querySelectorAll('.ta-participantName')).map(function(e){return (e.textContent||'').trim()}).join(' - ')}).filter(Boolean);
var compsLeft=0;var seen={};[].slice.call(document.querySelectorAll('a[href*="/competitions/"]')).forEach(function(a){var m=(a.getAttribute('href')||'').match(/\\/competitions\\/(\\d+)/);if(m&&!seen[m[1]]){seen[m[1]]=1;compsLeft++;}});
return JSON.stringify({items:items,titles:titles,compsLeftInDom:compsLeft,href:location.href.slice(0,120)});`;

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({ key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se", rendering_wait: "5000", timeout: "90000", retry: "false", proxy_pool: "public_residential_pool", format: "json", js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url") });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function getJson(url, t = 175000) { const c = new AbortController(); const tm = setTimeout(() => c.abort(), t); try { const r = await fetch(url, { signal: c.signal }); const x = await r.text(); try { return { status: r.status, json: JSON.parse(x) }; } catch { return { status: r.status, json: null, text: x }; } } finally { clearTimeout(tm); } }

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const scenario = [
    { wait: 6000 }, { execute: { script: COOKIE, timeout: 5000 } },
    { wait: 2000 }, { execute: { script: LIST, timeout: 9000 } },
    { execute: { script: CLICKNEXT, timeout: 6000 } }, { wait: 5000 }, { execute: { script: HARVEST, timeout: 9000 } },
    { execute: { script: CLICKNEXT, timeout: 6000 } }, { wait: 5000 }, { execute: { script: HARVEST, timeout: 9000 } },
    { execute: { script: CLICKNEXT, timeout: 6000 } }, { wait: 5000 }, { execute: { script: HARVEST, timeout: 9000 } },
  ];
  const { status, json, text } = await getJson(scrapflyUrl(scenario, PAGE));
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => { try { return JSON.parse(s.result); } catch { return null; } }).filter(Boolean) : [];
  out.http = status;
  out.list = sr.find((s) => s.compCount !== undefined) || null;
  out.harvests = sr.filter((s) => s.items !== undefined && s.compsLeftInDom !== undefined);
  out.clicks = sr.filter((s) => s.clicked !== undefined);
  if (!out.list) out.rawHead = (text || "").slice(0, 300);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log("[10bet-comps] http", status, "compCount", out.list?.compCount, "harvests", out.harvests.map((h) => h.items));
}
main().catch((e) => { console.error("fel:", e); fs.writeFileSync(OUT, JSON.stringify({ err: String(e?.message ?? e) }, null, 2) + "\n"); process.exit(1); });
