/**
 * recon-bet365-scrapfly.mjs — FEASIBILITY-RECON: går bet365 att skrapa via Scrapfly?
 *
 * bet365 är ökänt svårast: custom anti-bot + odds pushas via ETT EGET binärt/avgränsat
 * WEBSOCKET-protokoll (ej JSON, ej REST). Den här proben mäter KONKRET:
 *   1. Laddar Scrapfly+ASP sidan alls (titel/bodyLen, eller block-sida)?
 *   2. Vilka websockets öppnas (premws/odds-feed)?
 *   3. Hur ser frame-payloaden ut (avkodbar struktur eller obfuskerad)?
 * → underlag för att bedöma om en MAINTAINABLE scraper är realistisk.
 *
 * bet365 är UK-baserad + ej svensk licens → country=gb. Secret: SCRAPER_API_KEY.
 * Output: data/_recon-bet365-scrapfly.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-bet365-scrapfly.json");
const PAGE = "https://www.bet365.com/";

// Patcha WebSocket + fetch FÖRE SPA-boot via Scrapfly:s rendering — fånga WS-URL:er
// + första frames (bet365 pushar odds via WS i custom-format).
const PATCH = `
window.__ws=window.__ws||[];window.__wsframes=window.__wsframes||[];
(function(){var OW=window.WebSocket;if(OW&&!OW.__p){var NW=function(u,p){
  try{if(window.__ws.length<12)window.__ws.push(String(u).slice(0,160));}catch(e){}
  var ws=p?new OW(u,p):new OW(u);
  try{ws.addEventListener('message',function(ev){try{var d=ev.data;var str=(typeof d==='string')?d:'[binary]';if(window.__wsframes.length<14&&str&&str.length>8)window.__wsframes.push(str.slice(0,400));}catch(e){}});}catch(e){}
  return ws;};NW.__p=true;NW.prototype=OW.prototype;window.WebSocket=NW;}})();
return JSON.stringify({patched:1});`;
// Navigera in i fotbolls-sportsboken så WS:en prenumererar på riktiga odds (ej bara handshake).
const NAV = `
try{for(var L of ['Acceptera','Godkänn','Accept','OK','Jag godkänner','Tillåt alla']){var els=[].slice.call(document.querySelectorAll('button,a,[role=button],div'));var hit=els.find(function(e){return (e.textContent||'').trim().toLowerCase()===L.toLowerCase()});if(hit){try{hit.click()}catch(e){}break}}}catch(e){}
try{location.hash='#/AC/B1/C1/D1/E2/F^1/';}catch(e){}
return JSON.stringify({nav:1});`;
const READ = `
var f=window.__wsframes||[];
// odds-bärande frames = de som har fält-koder (OD/NA/CT/PA) eller decimal-odds-mönster.
var oddsFrames=f.filter(function(x){return /\\bOD=|\\bNA=|\\bPA=|\\bHA=|\\bHD=|;OD;|\\|OD\\||\\d+\\/\\d+|\\d\\.\\d{2}/.test(x)});
return JSON.stringify({ws:window.__ws||[],frames:f,oddsFrames:oddsFrames.slice(0,8),frameCount:f.length,oddsFrameCount:oddsFrames.length,title:(document.title||'').slice(0,90),bodyLen:(document.body&&document.body.innerHTML||'').length,href:location.href.slice(0,120),hasBlock:/restricted|not available|blocked|just a moment|attention required|inte tillg/i.test((document.body&&document.body.innerText||'').slice(0,3000))});`;

function scrapflyUrl(scenario, pageUrl, country) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country,
    rendering_wait: "4000", timeout: "75000", retry: "false",
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
  for (const r of sr) { try { const o = JSON.parse(r); if (o.ws !== undefined) return o; } catch { /* */ } }
  return null;
}

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY, attempts: [] };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  // Patcha WS → navigera till fotboll → låt WS pusha odds (~30s, håll under Scrapfly-taket) → läs.
  const scenario = [{ wait: 2000 }, { execute: { script: PATCH, timeout: 6000 } }, { wait: 4000 }, { execute: { script: NAV, timeout: 6000 } }, { wait: 14000 }, { wait: 13000 }, { execute: { script: READ, timeout: 8000 } }];
  for (const country of ["se", "gb"]) {
    const { status, json, text } = await getJson(scrapflyUrl(scenario, PAGE, country));
    const read = readSteps(json);
    const att = {
      country, http: status,
      scrapflyMessage: (typeof json?.message === "string" ? json.message : json?.message?.message) || null,
      title: read?.title, bodyLen: read?.bodyLen, hasBlock: read?.hasBlock,
      wsUrls: read?.ws, wsFrameCount: read?.frameCount ?? (read?.frames || []).length, wsFrames: (read?.frames || []).slice(0, 8),
      oddsFrameCount: read?.oddsFrameCount ?? 0, oddsFrames: read?.oddsFrames || [],
      errBody: !read && status !== 200 ? (text || "").slice(0, 400) : undefined,
    };
    out.attempts.push(att);
    console.log(`[bet365-recon] country=${country} http=${status} title="${att.title || ""}" block=${att.hasBlock} wsUrls=${(att.wsUrls || []).length} frames=${att.wsFrameCount} oddsFrames=${att.oddsFrameCount}`);
    if (read && att.oddsFrameCount > 0) break; // hittade riktiga odds-frames → räcker
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[bet365-recon] fel:", e); process.exit(1); });
