/**
 * recon-bet365-protocol.mjs — bet365 Fas 1: DJUP zap-protokoll-recon.
 *
 * Fångar HELA WS-flödet (BÅDA riktningar): klientens subscribe-frames (ws.send) +
 * serverns pushade odds-records (onmessage), string OCH binärt (→ hex). Navigerar in
 * i fotboll så bet365:s egen JS prenumererar → odds-frames flödar. Dumpar allt raw så
 * vi kan reverse-engineera record-format + fältkoder (Fas 2 decoder).
 *
 * Svenska bet365 (country=se, bekräftat licens + laddbart). Secret: SCRAPER_API_KEY.
 * Output: data/_recon-bet365-protocol.json.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-bet365-protocol.json");
const PAGE = "https://www.bet365.com/";

// Patcha WS i BÅDA riktningar + binär→hex. Fånga upp till 80 frames raw.
const PATCH = `
window.__net=window.__net||[];window.__wsurls=window.__wsurls||[];
function hex(a){var h='';for(var i=0;i<a.length&&i<260;i++){h+=('0'+a[i].toString(16)).slice(-2);}return h;}
function enc(d){try{
  if(typeof d==='string')return {t:'str',v:d.slice(0,600)};
  if(d instanceof ArrayBuffer)return {t:'ab',v:hex(new Uint8Array(d))};
  if(d&&d.buffer)return {t:'bin',v:hex(new Uint8Array(d.buffer))};
  if(d&&d.byteLength!=null)return {t:'bin',v:hex(new Uint8Array(d))};
  return {t:'?',v:String(d).slice(0,200)};
}catch(e){return {t:'err',v:String(e).slice(0,60)}}}
function rec(dir,d){try{if(window.__net.length<80){var e=enc(d);window.__net.push({dir:dir,t:e.t,v:e.v});}}catch(e){}}
// PASSIVT: bara onmessage (INGEN ws.send-override → bet365:s anti-tamper triggas ej).
(function(){var OW=window.WebSocket;if(OW&&!OW.__p){var NW=function(u,p){
  try{if(window.__wsurls.length<8)window.__wsurls.push(String(u).slice(0,180));}catch(e){}
  var ws=p?new OW(u,p):new OW(u);
  try{ws.addEventListener('message',function(ev){rec('recv',ev.data);});}catch(e){}
  return ws;};NW.__p=true;NW.prototype=OW.prototype;window.WebSocket=NW;}})();
return JSON.stringify({patched:1});`;

// Klicka in i fotboll (vänster sport-meny) → undermeny → så bet365 prenumererar på odds.
const NAVA = `
function clk(re){var els=[].slice.call(document.querySelectorAll('div,a,span,li,button'));
  var hit=els.find(function(e){var t=(e.textContent||'').trim();return t.length<24&&re.test(t)&&e.offsetParent!==null;});
  if(hit){try{hit.click();return (hit.textContent||'').trim();}catch(e){}}return null;}
var c1=clk(/^(Fotboll|Football|Soccer)$/i);
return JSON.stringify({clicked:c1});`;
const NAVB = `
function clk(re,max){var els=[].slice.call(document.querySelectorAll('div,a,span,li'));
  var hit=els.find(function(e){var t=(e.textContent||'').trim();return t.length<(max||40)&&re.test(t)&&e.offsetParent!==null;});
  if(hit){try{hit.click();return (hit.textContent||'').trim();}catch(e){}}return null;}
// klicka en topp-liga/region om synlig (England/Spanien/Champions/Idag/Matcher)
var c2=clk(/England|Spanien|Italien|Tyskland|Champions|Idag|Matcher|Alla|Today|Kommande/i,30);
return JSON.stringify({clicked2:c2});`;
const READ = `return JSON.stringify({wsurls:window.__wsurls||[],net:window.__net||[],count:(window.__net||[]).length,recv:(window.__net||[]).filter(function(x){return x.dir==='recv'}).length,sent:(window.__net||[]).filter(function(x){return x.dir==='send'}).length,title:(document.title||'').slice(0,80),href:location.href.slice(0,140)});`;

function scrapflyUrl(scenario, pageUrl, country) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country,
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
function readSteps(json) {
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
  for (const r of sr) { try { const o = JSON.parse(r); if (o.net !== undefined) return o; } catch { /* */ } }
  return null;
}

async function main() {
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const scenario = [
    { wait: 3000 }, { execute: { script: PATCH, timeout: 6000 } },
    { wait: 4000 }, { execute: { script: NAVA, timeout: 6000 } },
    { wait: 9000 }, { execute: { script: NAVB, timeout: 6000 } },
    { wait: 13000 }, { execute: { script: READ, timeout: 9000 } },
  ];
  const { status, json, text } = await getJson(scrapflyUrl(scenario, PAGE, "se"));
  out.http = status;
  out.scrapflyMessage = (typeof json?.message === "string" ? json.message : json?.message?.message) || null;
  const read = readSteps(json);
  if (read) { out.wsurls = read.wsurls; out.title = read.title; out.href = read.href; out.frameCount = read.count; out.recvCount = read.recv; out.sentCount = read.sent; out.net = read.net; }
  else if (status !== 200) out.errBody = (text || "").slice(0, 500);
  console.log(`[bet365-proto] http=${status} title="${out.title || ""}" frames=${out.frameCount} (recv=${out.recvCount} sent=${out.sentCount})`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[bet365-proto] fel:", e); process.exit(1); });
