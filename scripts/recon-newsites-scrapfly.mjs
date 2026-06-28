/**
 * recon-newsites-scrapfly.mjs — BLIND nätverks-recon för nya sportböcker via Scrapfly.
 *
 * Vi vet inte odds-API:t för videoslots/kungaslottet (Videoslots Ltd, Betradar-trading),
 * svenskaspel/Oddset (egen plattform) eller campobet (Soft2Bet). Sandlådan blockar
 * domänerna och WebFetch får 403 → kan inte recona lokalt. Scrapfly renderar förbi
 * anti-bot; i js_scenario patchar vi window.fetch + XMLHttpRequest så ALLA odds-ish
 * anrop (URL + svars-snutt) loggas. Sportbok-SPA:er pollar oftast odds var few sek →
 * post-load-patch fångar refresh-anropen även om första anropet redan gått.
 *
 * Mål: hitta odds-API-bas + svarsstruktur så scrapers kan byggas (separat steg).
 * Secret: SCRAPER_API_KEY. Output: data/_recon-newsites-scrapfly.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-newsites-scrapfly.json");

// Sajter att recona. waitMs = dwell efter patch (delas i två stadier; Scrapfly tillåter
// max 15000ms PER wait-stadium). videoslots/kungaslottet (Altenar) + svenskaspel/oddset
// (Kambi) LÖSTA — runda 4 fokuserar på campobet (Soft2Bet, finder-only). Tidigare
// /sv/sports/ → 404, så vi provar .se-domänen + flera path-varianter.
const SITES = [
  { id: "campobet_se_root", url: "https://campobet.se/sv/", waitMs: 14000 },
  { id: "campobet_se_sports", url: "https://campobet.se/sv/sports", waitMs: 14000 },
  { id: "campobet_com_root", url: "https://www.campobet.com/sv/", waitMs: 14000 },
  { id: "campobet_com_sportsbook", url: "https://www.campobet.com/sv/sportsbook", waitMs: 14000 },
];

// Runda 2: BRED capture. Inget KEEP-filter (logga ALLA icke-statiska anrop) + WebSocket-
// URL:er (många sportböcker pushar odds via WS) + sid-diagnostik (om SPA:t ens bootade).
const PATCH = `
window.__net=window.__net||[];window.__ws=window.__ws||[];
var SKIP=/\\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ttf|ico|mp4|webp|map)(\\?|$)|google|gtm|googletag|analytics|sentry|hotjar|facebook|doubleclick|cookiebot|onetrust|recaptcha|cloudflare/i;
function rec(u,status,body){try{
  u=String(u||"");if(!u||SKIP.test(u))return;
  var snip=null;if(typeof body==='string'&&body.length){snip=body.slice(0,800);}
  if(window.__net.length<60)window.__net.push({u:u.slice(0,260),status:status==null?null:status,snip:snip});
}catch(e){}}
(function(){
  var of=window.fetch;
  if(of&&!of.__patched){var nf=function(){var args=arguments;var u=(args[0]&&args[0].url)||args[0];
    return of.apply(this,args).then(function(r){try{var rr=r.clone();rr.text().then(function(t){rec(u,r.status,t)}).catch(function(){rec(u,r.status,null)});}catch(e){rec(u,r&&r.status,null)}return r;});};
    nf.__patched=true;window.fetch=nf;}
  var ox=window.XMLHttpRequest;
  if(ox&&!ox.__patched){var NX=function(){var x=new ox();var _u=null;var _o=x.open;
    x.open=function(m,u){_u=u;return _o.apply(x,arguments);};
    x.addEventListener('load',function(){try{rec(_u,x.status,x.responseText)}catch(e){rec(_u,x.status,null)}});
    return x;};NX.__patched=true;NX.prototype=ox.prototype;window.XMLHttpRequest=NX;}
  var OW=window.WebSocket;
  if(OW&&!OW.__patched){var NW=function(u,p){try{if(window.__ws.length<20)window.__ws.push(String(u).slice(0,200));}catch(e){}return p?new OW(u,p):new OW(u);};
    NW.__patched=true;NW.prototype=OW.prototype;window.WebSocket=NW;}
})();
return JSON.stringify({patched:1});`;
const READ = `return JSON.stringify({net:window.__net||[],ws:window.__ws||[],count:(window.__net||[]).length,wsCount:(window.__ws||[]).length,host:location.host,href:location.href.slice(0,160),title:(document.title||"").slice(0,80),bodyLen:(document.body&&document.body.innerHTML||"").length});`;

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se",
    rendering_wait: "3500", timeout: "75000", retry: "false",
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

async function reconSite(site) {
  // Scrapfly tillåter max 15000ms per wait-stadium → dela dwell i två (≈28s totalt).
  const half = Math.min(Math.ceil(site.waitMs / 2), 14000);
  const scenario = [
    { wait: 4000 },
    { execute: { script: PATCH, timeout: 8000 } },
    { wait: half },
    { wait: half },
    { execute: { script: READ, timeout: 10000 } },
  ];
  const res = { id: site.id, url: site.url };
  try {
    const { status, json, text } = await getJson(scrapflyUrl(scenario, site.url));
    res.http = status;
    res.scrapflyMessage = (typeof json?.message === "string" ? json.message : json?.message?.message) || null;
    const steps = json?.result?.browser_data?.js_scenario?.steps;
    const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
    for (const r of sr) { try { const o = JSON.parse(r); if (Array.isArray(o.net)) { res.host = o.host; res.href = o.href; res.title = o.title; res.bodyLen = o.bodyLen; res.count = o.count; res.net = o.net; res.wsCount = o.wsCount; res.ws = o.ws; } } catch { /* */ } }
    if (status !== 200 && !res.net) res.errBody = (text || "").slice(0, 800);
  } catch (e) { res.error = String(e?.message ?? e).slice(0, 160); }
  console.log(`[recon-newsites] ${site.id}: http=${res.http} captured=${res.count ?? 0} ws=${res.wsCount ?? 0} title="${res.title || ""}" msg=${res.scrapflyMessage || "-"}`);
  return res;
}

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY, sites: [] };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  // Sekventiellt — varje Scrapfly-render tar ~30-60s, undvik rate-limit.
  for (const site of SITES) {
    out.sites.push(await reconSite(site));
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`[recon-newsites] klart → ${OUT}`);
}
main().catch((e) => { console.error("[recon-newsites] fel:", e); process.exit(1); });
