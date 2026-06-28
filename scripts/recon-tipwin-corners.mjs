/**
 * recon-tipwin-corners.mjs — RECON v2: hitta tipwins (NSoft) HÖRN-marknadskod.
 *
 * NSoft returnerar bara marknader man EXPLICIT begär (offers.bettingType.abrv).
 * Förra recon (utan filter) gav 0 marknader. Nu begär vi en bred uppsättning
 * KANDIDAT-corner-abrv:er + dumpar (a) vilka som faktiskt returnerar offers och
 * (b) råstrukturen för första marknaden (så vi ser var abrv/namn/line ligger).
 *
 * Secret: SCRAPER_API_KEY. Output: data/_recon-tipwin-corners.json.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-tipwin-corners.json");
const PAGE = "https://tipwin.se/sv/home/full/highlights";
const FOOTBALL_ID = "5rkMRxXDl4zI2f3ROfxAx1";

// Kandidat-abrv:er för hörn-marknader (NSoft-namngivning varierar).
const CORNER_ABRVS = [
  "total-corners", "corners-total", "total-corner", "corner-over-under", "corners-over-under",
  "corner-handicap", "handicap-corners", "corner-handicap-hcp", "corners-handicap",
  "corner-1x2", "1x2-corners", "three-way-corners", "corner-3way", "corners-3way",
  "corner-match-bet", "corners-match", "race-to-corners", "first-corner", "last-corner",
  "1st-half-corners", "total-corners-1st-half", "asian-total-corners", "asian-corner-handicap",
  "over-under-corners", "match-corners", "corners",
];

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(buf) { let n = 0n; for (const b of buf) n = (n << 8n) | BigInt(b); if (n === 0n) return "0"; let s = ""; while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n; } return s; }
function encFilter(obj) { return base62(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))); }

function offerDataUrl() {
  const filter = {
    paging: { pageNumber: 1, pageSize: 40 },
    sorting: ["startTime", "sportCategory", "sportCategoryId", "tournament"],
    filter: { eventType: 0, liveStatus: 0, sportId: FOOTBALL_ID, offers: [{ bettingType: { abrv: { eq: CORNER_ABRVS } } }] },
    language: "sv-SE",
  };
  return `https://api-web.tipwin.se/v2/100683/offer/data?filter=${encFilter(filter)}&Caller-Environment=Web`;
}

const KICK = `
window.__probe=null;window.__pdone=false;
var H={'Accept-Language':'sv','Caller-Environment':'Web','Agency-Key':'100683','Web-Device':'Web','Shop-Id':'SR1Iz8ycPvDYxsmGm3qCED'};
var url=__URL__;
var c=new AbortController();var to=setTimeout(function(){c.abort()},9000);
fetch(url,{headers:H,credentials:'include',signal:c.signal}).then(function(r){return r.text().then(function(x){clearTimeout(to);
  var o={status:r.status,len:x.length};
  try{
    var j=JSON.parse(x);
    var nEvents=(j.offer||[]).length;var nMarkets=0;var abrvHits={};var firstMarket=null;
    (j.offer||[]).forEach(function(eo){
      (eo.offers||[]).forEach(function(mk){nMarkets++;
        // försök hitta abrv på flera ställen
        var bt=mk.key&&mk.key.bettingType;
        var abrv=(bt&&bt.abrv)||(mk.bettingType&&mk.bettingType.abrv)||(mk.key&&mk.key.bettingTypeAbrv)||mk.abrv||null;
        if(abrv)abrvHits[abrv]=(abrvHits[abrv]||0)+1;
        if(!firstMarket)firstMarket=JSON.stringify(mk).slice(0,700);
      });
    });
    o.nEvents=nEvents;o.nMarkets=nMarkets;o.abrvHits=abrvHits;o.firstMarket=firstMarket;
    o.lookupKeys=j.lookup?Object.keys(j.lookup):null;
    if(j.lookup&&j.lookup.bettingTypes){var bts=j.lookup.bettingTypes;o.bettingTypeSample=JSON.stringify(Array.isArray(bts)?bts.slice(0,4):Object.values(bts).slice(0,4)).slice(0,500);}
  }catch(e){o.parseErr=String(e&&e.message).slice(0,140);o.raw=x.slice(0,400);}
  window.__probe=o;window.__pdone=true;
})}).catch(function(e){window.__pdone='err:'+String(e&&(e.name+':'+e.message)).slice(0,160);});
return JSON.stringify({fired:1});`;
const READ = `return JSON.stringify({done:window.__pdone,probe:window.__probe});`;

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se",
    rendering_wait: "3000", timeout: "60000", retry: "false",
    proxy_pool: "public_residential_pool", format: "json",
    js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url"),
  });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function getJson(url, timeoutMs = 170000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); const text = await r.text(); try { return { status: r.status, json: JSON.parse(text), text }; } catch { return { status: r.status, json: null, text }; } }
  finally { clearTimeout(t); }
}

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY, candidates: CORNER_ABRVS };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const url = offerDataUrl();
  const kick = KICK.replace("__URL__", JSON.stringify(url));
  const scenario = [{ wait: 6000 }, { execute: { script: kick, timeout: 8000 } }, { wait: 11000 }, { execute: { script: READ, timeout: 10000 } }];
  const { status, json, text } = await getJson(scrapflyUrl(scenario, PAGE));
  out.http = status;
  out.scrapflyMessage = (typeof json?.message === "string" ? json.message : json?.message?.message) || null;
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
  for (const r of sr) { try { const o = JSON.parse(r); if (o.probe !== undefined) out.read = o; } catch { /* */ } }
  if (status !== 200 && !out.read) out.errBody = (text || "").slice(0, 800);
  console.log(`[tipwin-corners] http=${status} nMarkets=${out.read?.probe?.nMarkets} abrvHits=${JSON.stringify(out.read?.probe?.abrvHits || {})}`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[tipwin-corners] fel:", e); process.exit(1); });
