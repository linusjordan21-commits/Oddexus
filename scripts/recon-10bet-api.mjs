/**
 * recon-10bet-api.mjs — hitta 10bet:s DATA-API bakom match-listan.
 *
 * 10bet organiserar matcher per tävling (hundratals matcher). Flata DOM-vyer visar bara
 * ett urval. Vi patchar fetch+XHR, laddar competitions-vyn + drillar in i en liga, och
 * fångar alla API-anrop (URL + svars-snutt) → ser om det finns ett bulk-match/odds-API
 * (Playtech-cache e.d.) så vi kan hämta ALLA matcher billigt istället för DOM-skrapa.
 *
 * Secret: SCRAPER_API_KEY. Output: data/_recon-10bet-api.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-10bet-api.json");
const PAGE = "https://www.10bet.se/sports/football/competitions";

const PATCH = `
window.__net=window.__net||[];
var SKIP=/\\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ttf|ico|mp4|webp|map)(\\?|$)|google|gtm|analytics|sentry|hotjar|facebook|doubleclick|cookiebot|onetrust|recaptcha|cloudflare|/i;
function rec(u,status,body){try{u=String(u||"");if(!u||SKIP.test(u))return;
  var snip=null;if(typeof body==='string'&&body.length){snip=body.slice(0,500);}
  if(window.__net.length<70)window.__net.push({u:u.slice(0,260),status:status==null?null:status,snip:snip});
}catch(e){}}
(function(){
  var of=window.fetch;
  if(of&&!of.__p){var nf=function(){var a=arguments;var u=(a[0]&&a[0].url)||a[0];
    return of.apply(this,a).then(function(r){try{var rr=r.clone();rr.text().then(function(t){rec(u,r.status,t)}).catch(function(){rec(u,r.status,null)});}catch(e){rec(u,r&&r.status,null)}return r;});};
    nf.__p=true;window.fetch=nf;}
  var ox=window.XMLHttpRequest;
  if(ox&&!ox.__p){var NX=function(){var x=new ox();var _u=null;var _o=x.open;
    x.open=function(m,u){_u=u;return _o.apply(x,arguments);};
    x.addEventListener('load',function(){try{rec(_u,x.status,x.responseText)}catch(e){rec(_u,x.status,null)}});
    return x;};NX.__p=true;NX.prototype=ox.prototype;window.XMLHttpRequest=NX;}
})();
return JSON.stringify({patched:1});`;
// PRECIS cookie-accept: bara <button> med EXAKT cookie-text (matcha ej privacy-länkar).
const COOKIE = `
var btns=[].slice.call(document.querySelectorAll('button,[role=button]'));
var hit=btns.find(function(e){var t=(e.textContent||'').trim();return ['Acceptera alla','Godkänn alla','Acceptera','Tillåt alla','Jag godkänner','Acceptera och fortsätt'].indexOf(t)>=0;});
var c=false;if(hit){try{hit.click();c=true;}catch(e){}}
return JSON.stringify({cookie:c});`;
// Klicka en LIGA-länk via href (client-side route → patchad fetch fångar match-API:t).
const CLICKLEAGUE = `
var a=document.querySelector('a[href*="/football/competitions/"]')||document.querySelector('a[href*="/competitions/"]')||document.querySelector('a[href*="/football/"]');
var clicked=null;if(a){try{clicked=a.getAttribute('href');a.click();}catch(e){}}
for(var s=0;s<5;s++){window.scrollBy(0,900);}
return JSON.stringify({clicked:clicked,href:location.href.slice(0,120)});`;
const READ = `
var net=window.__net||[];
return JSON.stringify({count:net.length,all:net.slice(0,40),href:location.href.slice(0,120)});`;

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({ key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se", rendering_wait: "5000", timeout: "80000", retry: "false", proxy_pool: "public_residential_pool", format: "json", js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url") });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function getJson(url, t = 175000) { const c = new AbortController(); const tm = setTimeout(() => c.abort(), t); try { const r = await fetch(url, { signal: c.signal }); const x = await r.text(); try { return { status: r.status, json: JSON.parse(x) }; } catch { return { status: r.status, json: null }; } } finally { clearTimeout(tm); } }
function readSteps(json) { const st = json?.result?.browser_data?.js_scenario?.steps; const sr = Array.isArray(st) ? st.filter((s) => s?.result != null).map((s) => s.result) : []; for (const r of sr) { try { const o = JSON.parse(r); if (o.all !== undefined) return o; } catch {} } return null; }

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const scenario = [
    { wait: 4000 }, { execute: { script: PATCH, timeout: 6000 } },
    { wait: 3000 }, { execute: { script: COOKIE, timeout: 5000 } },
    { wait: 4000 }, { execute: { script: CLICKLEAGUE, timeout: 7000 } },
    { wait: 9000 }, { execute: { script: READ, timeout: 9000 } },
  ];
  const { status, json } = await getJson(scrapflyUrl(scenario, PAGE));
  out.http = status;
  const r = readSteps(json);
  if (r) { out.href = r.href; out.netCount = r.count; out.all = r.all; }
  console.log(`[10bet-api] http=${status} href=${r?.href} netCount=${r?.count}`);
  for (const a of (r?.all || []).slice(0, 15)) console.log("  ", a.status, a.u);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[10bet-api] fel:", e); process.exit(1); });
