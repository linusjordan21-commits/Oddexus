/**
 * recon-10bet-urls.mjs — hitta 10bet-URL:en med FLEST fotbollsmatcher.
 * /matches/today gav bara 6 (sent på dagen → mest avspark). Provar upcoming/all/
 * tomorrow → räknar .ta-EventListItem + dumpar sample-titlar. Secret: SCRAPER_API_KEY.
 * Output: data/_recon-10bet-urls.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-urls.json");
const URLS = [
  "https://www.10bet.se/sports/football",
  "https://www.10bet.se/sports/football/matches/upcoming",
  "https://www.10bet.se/sports/football/matches/tomorrow",
  "https://www.10bet.se/sports/football/matches/all",
];

const SCAN = `
for(var L of ['Acceptera alla','Godkänn alla','Acceptera','Accept all','OK']){var els=[].slice.call(document.querySelectorAll('button,a,[role=button]'));var hit=els.find(function(e){return (e.textContent||'').trim().toLowerCase().indexOf(L.toLowerCase())>=0});if(hit){try{hit.click()}catch(e){}break}}
for(var s=0;s<14;s++){window.scrollBy(0,1100);}
var items=document.querySelectorAll('.ta-EventListItem').length;
var titles=[].slice.call(document.querySelectorAll('.ta-EventListItem')).slice(0,8).map(function(it){return [].slice.call(it.querySelectorAll('.ta-participantName')).map(function(e){return (e.textContent||'').trim()}).join(' - ')}).filter(Boolean);
return JSON.stringify({items:items,titles:titles,href:location.href.slice(0,120)});`;

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({ key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se", rendering_wait: "5000", timeout: "60000", retry: "false", proxy_pool: "public_residential_pool", format: "json", js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url") });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function getJson(url, t = 170000) { const c = new AbortController(); const tm = setTimeout(() => c.abort(), t); try { const r = await fetch(url, { signal: c.signal }); const x = await r.text(); try { return { status: r.status, json: JSON.parse(x) }; } catch { return { status: r.status, json: null }; } } finally { clearTimeout(tm); } }
function readSteps(json) { const st = json?.result?.browser_data?.js_scenario?.steps; const sr = Array.isArray(st) ? st.filter((s) => s?.result != null).map((s) => s.result) : []; for (const r of sr) { try { const o = JSON.parse(r); if (o.items !== undefined) return o; } catch {} } return null; }

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY, results: [] };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const scenario = [{ wait: 6000 }, { execute: { script: SCAN, timeout: 8000 } }, { wait: 7000 }, { execute: { script: SCAN, timeout: 8000 } }];
  for (const url of URLS) {
    const { status, json } = await getJson(scrapflyUrl(scenario, url));
    const r = readSteps(json);
    out.results.push({ url, http: status, items: r?.items ?? null, href: r?.href, titles: (r?.titles || []).slice(0, 6) });
    console.log(`[10bet-urls] ${url} → http=${status} items=${r?.items}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[10bet-urls] fel:", e); process.exit(1); });
