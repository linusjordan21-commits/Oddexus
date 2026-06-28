/**
 * recon-10bet-tabs.mjs — kartlägg 10bet:s fotbolls-navigation: vilka flikar/scope finns
 * (Idag/Imorgon/Kommande/Live/datum) + hur når man flest PREMATCH-matcher. Klickar
 * igenom tab-kandidater och rapporterar itemCount + href per klick. Secret: SCRAPER_API_KEY.
 * Output: data/_recon-10bet-tabs.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-tabs.json");
const PAGE = "https://www.10bet.se/sports/football/matches/today";

// Dumpa alla korta klickbara nav-etiketter (tabs/filter) + nuvarande itemCount.
const DUMP_TABS = `
for(var L of ['Acceptera alla','Godkänn alla','Acceptera','Accept all','OK']){var els=[].slice.call(document.querySelectorAll('button,a,[role=button]'));var hit=els.find(function(e){return (e.textContent||'').trim().toLowerCase().indexOf(L.toLowerCase())>=0});if(hit){try{hit.click()}catch(e){}break}}
for(var s=0;s<6;s++){window.scrollBy(0,900);}
var labels={};
[].slice.call(document.querySelectorAll('button,a,[role=button],[role=tab],li,span,div')).forEach(function(e){
  var t=(e.textContent||'').trim();
  if(t.length>0&&t.length<22&&e.offsetParent!==null&&/idag|imorgon|kommande|live|matcher|alla|tävling|liga|datum|nästa|today|tomorrow|upcoming|\\d{1,2}\\s*[a-zåäö]{3}/i.test(t)){labels[t]=(labels[t]||0)+1;}
});
return JSON.stringify({items:document.querySelectorAll('.ta-EventListItem').length,navLabels:Object.keys(labels).slice(0,40),href:location.href.slice(0,120)});`;

function clickScript(label) {
  return `
var done=null;var els=[].slice.call(document.querySelectorAll('button,a,[role=button],[role=tab],li,span,div'));
var hit=els.find(function(e){var t=(e.textContent||'').trim();return t.toLowerCase()===${JSON.stringify(label.toLowerCase())}&&e.offsetParent!==null;});
if(hit){try{hit.click();done='${label}';}catch(e){}}
for(var s=0;s<12;s++){window.scrollBy(0,1000);}
var titles=[].slice.call(document.querySelectorAll('.ta-EventListItem')).slice(0,6).map(function(it){return [].slice.call(it.querySelectorAll('.ta-participantName')).map(function(e){return (e.textContent||'').trim()}).join(' - ')}).filter(Boolean);
return JSON.stringify({clicked:done,items:document.querySelectorAll('.ta-EventListItem').length,href:location.href.slice(0,120),titles:titles});`;
}

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({ key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se", rendering_wait: "5000", timeout: "70000", retry: "false", proxy_pool: "public_residential_pool", format: "json", js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url") });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function getJson(url, t = 175000) { const c = new AbortController(); const tm = setTimeout(() => c.abort(), t); try { const r = await fetch(url, { signal: c.signal }); const x = await r.text(); try { return { status: r.status, json: JSON.parse(x) }; } catch { return { status: r.status, json: null }; } } finally { clearTimeout(tm); } }
function allSteps(json) { const st = json?.result?.browser_data?.js_scenario?.steps; const sr = Array.isArray(st) ? st.filter((s) => s?.result != null).map((s) => s.result) : []; return sr.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean); }

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  // Steg 1: dumpa nav-etiketter. Steg 2-4: klicka kandidat-tabs (Imorgon/Kommande/Nästa).
  const scenario = [
    { wait: 6000 }, { execute: { script: DUMP_TABS, timeout: 9000 } },
    { wait: 5000 }, { execute: { script: clickScript("Imorgon"), timeout: 9000 } },
    { wait: 6000 }, { execute: { script: clickScript("Kommande"), timeout: 9000 } },
  ];
  const { status, json } = await getJson(scrapflyUrl(scenario, PAGE));
  out.http = status;
  out.steps = allSteps(json);
  console.log(`[10bet-tabs] http=${status}`);
  for (const s of out.steps) console.log("  ", JSON.stringify(s).slice(0, 200));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[10bet-tabs] fel:", e); process.exit(1); });
