/**
 * fetch-10bet-github-action.mjs — 10bet.se (Playtech Vision) prematch-fotboll-odds.
 *
 * BEVISAD METOD (recon): 10bets odds-feed är binär getslice/.bin (custom DataView) —
 * ingen JSON-väg. MEN Playtech Vision-widgeten RENDERAR oddsen i DOM:en med rena ta-*-
 * klasser, så vi DOM-skrapar via Scrapfly (passerar CF + renderar) precis som prontosport:
 *   - sida: https://www.10bet.se/sports/football/matches/today
 *   - varje .ta-EventListItem: .ta-participantName ×2 (hemma/borta), första 3 .ta-price
 *     = 1X2 (MRES-marknad: hemma/oavgjort/borta), href /events/<id>.
 * → kanoniskt events[]-format (samma som coolbet/888sport). KOSTNAD: render = 30 credits/
 * anrop → cron var 30:e min. Secret: SCRAPER_API_KEY. Output: data/10bet-rows.json.
 */
import fs from "node:fs";
import path from "node:path";
import { installHardDeadline, writeJsonPreservingCache, filterToWindowHours } from "./lib/scrape-guard.mjs";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "10bet-rows.json");
const DIAG_FILE = path.join(DATA_DIR, "_10bet-scraper-diag.json");
const PAGE = "https://www.10bet.se/sports/football/competitions";
const log = (...a) => console.log("[10bet]", ...a);
// Walk-parametrar: 10bet har ingen JSON-API (binär feed) → DOM enda vägen, och
// /matches/today listar bara 24 (curaterat). Matcher finns per TÄVLING. Vi walk:ar
// competitions client-side (lista→klick→skrapa→back→nästa). K tävlingar/render
// (Scrapfly reserverar exec-timeouts → ~4 ryms under 90s), tak MAX_COMPS över flera
// renders, prioritera riktig fotboll (esport sist). Recon 2026-06-26.
const COMPS_PER_RENDER = Number(process.env.TENBET_COMPS_PER_RENDER) || 6;
const MAX_COMPS = Number(process.env.TENBET_MAX_COMPS) || 18;

// ACCEPT: klicka cookie-accept, sedan scroll-BURST ~6000px i ETT steg (synkront). Reconen
// bevisade att en burst + lång ostörd settle (9s) låter widgeten lazy-ladda deltagarnamnen;
// scrolla däremot var 1500:e ms (run #6) → bara skelett (item=5, rows=0).
const SCROLL_BURST = `for(var s=0;s<9;s++){window.scrollBy(0,1100);}`;
// SÄKER cookie-accept: BARA <button>/[role=button] med EXAKT cookie-text. (Tidigare
// substring-match över <a> kunde klicka en länk med "ok"/"acceptera" i texten →
// navigerade BORT från /competitions → comps()=0. Recon bevisade den exakta varianten.)
const ACCEPT = `
var btns=[].slice.call(document.querySelectorAll('button,[role=button]'));
var hit=btns.find(function(e){var t=(e.textContent||'').trim();return ['Acceptera alla','Godkänn alla','Acceptera','Tillåt alla','Jag godkänner','Acceptera och fortsätt','Accept all'].indexOf(t)>=0;});
var c=false;if(hit){try{hit.click();c=true;}catch(e){}}
return JSON.stringify({ok:1,cookie:c});`;

// WALK: HELA walk:en i ETT async execute-steg (Scrapfly avvisar scenarier med för
// många steg → 422). Listar tävlingar, sorterar (riktig fotboll före esport),
// walk:ar slice [start, start+k): klick → await settle → skörda → history.back() →
// await settle. Allt client-side → exekveringskontexten överlever (inget steg-byte
// där kontext tappas). Returnerar alla rader + per-tävling-diagnostik.
function walkScript(start, k) {
  return `
function sleep(ms){return new Promise(function(r){setTimeout(r,ms)});}
function isEs(n){return /esport|efootball|esoccer|simulated|cyber|virtual|\\bsrl\\b|battle|adria/i.test(n||'');}
function comps(){var seen={};var out=[];[].slice.call(document.querySelectorAll('a[href*="/competitions/"]')).forEach(function(a){var h=a.getAttribute('href')||'';var m=h.match(/\\/competitions\\/(\\d+)/);if(!m)return;var id=m[1];if(seen[id])return;seen[id]=1;out.push({id:id,name:(a.textContent||'').trim().slice(0,48)});});return out;}
function harvestInto(rows,lg){
  [].slice.call(document.querySelectorAll('.ta-EventListItem')).forEach(function(it){
    var names=[].slice.call(it.querySelectorAll('.ta-participantName')).map(function(e){return (e.textContent||'').trim()}).filter(Boolean);
    if(names.length<2)return;
    var mres=it.querySelector('.ta-MarketType-MRES'); if(!mres)return;
    var prices=[].slice.call(mres.querySelectorAll('.ta-price_text')).map(function(e){return parseFloat((e.textContent||'').replace(',','.'))}).filter(function(v){return v>1&&v<1000});
    if(prices.length<3)return;
    var totals=[];
    [].slice.call(it.querySelectorAll('.ta-MarketType-HCTG')).forEach(function(m){var sels=[].slice.call(m.querySelectorAll('.ta-SelectionButtonView'));if(sels.length<2)return;var line=parseFloat((((sels[0].querySelector('.ta-infoTextHandicap')||{}).textContent||'').replace(',','.')));var over=parseFloat((((sels[0].querySelector('.ta-price_text')||{}).textContent||'').replace(',','.')));var under=parseFloat((((sels[1].querySelector('.ta-price_text')||{}).textContent||'').replace(',','.')));if(isFinite(line)&&over>1&&under>1)totals.push({line:line,over:over,under:under});});
    var a=it.querySelector('a[href*="/events/"]');var href=a?a.getAttribute('href'):'';
    var eid=(href.match(/events\\/(\\d+)/)||[])[1]||'';
    var t=(it.textContent||'').replace(/\\s+/g,' ');
    var tm=(t.match(/(Idag|Imorgon|Igår|\\d{1,2}\\s+[a-zåäö]{3,})[,\\s]*\\d{1,2}[:.]\\d{2}/i)||[])[0]||'';
    var id='10bet_'+(eid||(names[0]+'_'+names[1]));
    if(rows[id])return;
    var row={eventId:id,home:names[0],away:names[1],odds:{home:prices[0],draw:prices[1],away:prices[2]},timeText:tm,league:lg};
    if(totals.length)row.totals=totals;
    rows[id]=row;
  });
}
for(var sc=0;sc<8;sc++){window.scrollBy(0,1000);}
await sleep(800);
var list=comps();
list.sort(function(a,b){var pa=isEs(a.name)?1:0,pb=isEs(b.name)?1:0;if(pa!==pb)return pa-pb;return (+a.id)-(+b.id);});
var rows={};var walk=[];
var END=Math.min(${start}+${k},list.length);
for(var i=${start};i<END;i++){
  var c=list[i];
  var a=document.querySelector('a[href$="/competitions/'+c.id+'"]')||document.querySelector('a[href*="/competitions/'+c.id+'"]');
  if(!a){walk.push({id:c.id,name:c.name,found:false});continue;}
  try{a.click();}catch(e){}
  await sleep(4500);
  var before=Object.keys(rows).length; harvestInto(rows,c.name); var after=Object.keys(rows).length;
  walk.push({id:c.id,name:c.name,found:true,items:document.querySelectorAll('.ta-EventListItem').length,added:after-before});
  try{history.back();}catch(e){}
  await sleep(3500);
}
var dbg=null;
if(list.length===0){var hrefs={};[].slice.call(document.querySelectorAll('a')).forEach(function(a){var h=a.getAttribute('href')||'';if(h)hrefs[h]=1;});dbg={href:location.href.slice(0,120),anchorCount:document.querySelectorAll('a').length,sampleHrefs:Object.keys(hrefs).slice(0,25),bodyLen:(document.body&&document.body.textContent||'').length};}
return JSON.stringify({wlk:1,compCount:list.length,rows:Object.keys(rows).map(function(k){return rows[k]}),walk:walk,dbg:dbg});`;
}

function scrapflyUrl(scenario, pageUrl) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se",
    rendering_wait: "5000", timeout: "120000", retry: "false",
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

// Bäst-ansträngning: "Idag, 22:00" / "Imorgon, 01:00" / "25 jun 18:00" → ISO (Europe/
// Stockholm ≈ UTC+2 sommar). null om oparsbar — lag-namn är primärnyckeln för matchning.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };
function parseStart(timeText) {
  if (!timeText) return null;
  const tm = timeText.match(/(\d{1,2})[:.](\d{2})/); if (!tm) return null;
  const hh = Number(tm[1]), mm = Number(tm[2]);
  const now = new Date();
  let y = now.getUTCFullYear(), mo = now.getUTCMonth(), d = now.getUTCDate();
  if (/imorgon/i.test(timeText)) { const t = new Date(Date.UTC(y, mo, d + 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth(); d = t.getUTCDate(); }
  else if (/igår/i.test(timeText)) { const t = new Date(Date.UTC(y, mo, d - 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth(); d = t.getUTCDate(); }
  else { const dm = timeText.match(/(\d{1,2})\s+([a-zåäö]{3,})/i); if (dm && MONTHS[dm[2].slice(0, 3).toLowerCase()] != null) { d = Number(dm[1]); mo = MONTHS[dm[2].slice(0, 3).toLowerCase()]; } }
  // Stockholm-lokal → UTC: dra av 2h (sommar). Bäst-ansträngning.
  const ms = Date.UTC(y, mo, d, hh, mm) - 2 * 3600 * 1000;
  const iso = new Date(ms);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

async function main() {
  installHardDeadline({ budgetMs: Number(process.env.TENBET_DEADLINE_MS) || 8 * 60 * 1000, label: "10bet" });
  const diag = { ranAt: new Date().toISOString(), builtEvents: 0, notes: [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!KEY) { diag.notes.push("SCRAPER_API_KEY saknas"); fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n"); log("ingen nyckel"); return; }

  // WALK: varje render laddar /competitions → ACCEPT(cookies) → LIST(tävlingar) →
  // walk:ar en slice om COMPS_PER_RENDER (CLICK→settle→HARVEST→BACK→settle). Scrapfly
  // reserverar exec-timeouts → ~4 tävlingar ryms under 90s. main() ökar start över
  // flera renders tills MAX_COMPS/alla tävlingar täckts eller hard-deadline. Rader
  // mergas (dedupe eventId). Per tävlings-walk: CLICK 2.5 + settle 4.5 + HARVEST 3 +
  // BACK 2 + settle 3.5 = 15.5s; render = 7+3+2.5+5 + 4×15.5 + 5 ≈ 84.5s < 90.
  // Scenario = 4 steg (under Scrapflys steg-tak): boot → cookie → settle → WALK (allt
  // i ett async execute-steg). rendering_wait 5000 + 7000+3000+2500+65000 = 82500 < 120000.
  function buildScenario(start) {
    return [
      { wait: 7000 }, { execute: { script: ACCEPT, timeout: 3000 } },
      { wait: 2500 }, { execute: { script: walkScript(start, COMPS_PER_RENDER), timeout: 65000 } },
    ];
  }

  const byId = new Map();
  let scrapflyStatus = null, totalComps = null, rendersRun = 0;
  const walkDiag = [];
  for (let start = 0; start < MAX_COMPS; start += COMPS_PER_RENDER) {
    let walk = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { status, json } = await getJson(scrapflyUrl(buildScenario(start), PAGE));
      scrapflyStatus = status;
      if (status === 504 || status === 502 || status === 429) { diag.notes.push(`Scrapfly ${status} start=${start} (försök ${attempt})`); continue; }
      if (status !== 200) {
        const msg = (typeof json?.message === "string" ? json.message : json?.message?.message) || json?.result?.error || null;
        diag.notes.push(`Scrapfly ${status} start=${start}: ${String(msg || "?").slice(0, 160)}`);
      }
      const steps = json?.result?.browser_data?.js_scenario?.steps;
      const sr = Array.isArray(steps) ? steps.filter((x) => x?.result != null).map((x) => x.result) : [];
      for (const r of sr) { try { const o = JSON.parse(r); if (o.wlk === 1) walk = o; } catch { /* */ } }
      break;
    }
    rendersRun += 1;
    if (!walk) { diag.notes.push(`render start=${start} gav ingen walk`); break; }
    if (walk.dbg && !diag.walkDbg) diag.walkDbg = walk.dbg;
    totalComps = walk.compCount ?? totalComps;
    let added = 0;
    if (Array.isArray(walk.rows)) for (const r of walk.rows) if (r?.eventId && !byId.has(r.eventId)) { byId.set(r.eventId, r); added += 1; }
    const harvested = Array.isArray(walk.walk) ? walk.walk.reduce((m, w) => m + (w.added || 0), 0) : 0;
    const found = Array.isArray(walk.walk) ? walk.walk.filter((w) => w.found).length : 0;
    walkDiag.push({ start, compsFound: found, harvested, newRows: added, perComp: walk.walk });
    log(`render start=${start}: tävlingar=${found} skördade=${harvested} nya=${added} (totalt ${byId.size})`);
    if (totalComps != null && start + COMPS_PER_RENDER >= totalComps) break;
  }
  diag.scrapflyStatus = scrapflyStatus;
  diag.totalComps = totalComps;
  diag.rendersRun = rendersRun;
  diag.walk = walkDiag;
  const merged = [...byId.values()];
  diag.sampleRows = merged.slice(0, 8);

  // Filtrera bort eFootball/virtuell fotboll (FIFA-esport): lagnamn med spelar-handle i
  // parentes, t.ex. "Arsenal (hit)", "England (llulle)". Riktiga lag har ingen sådan suffix.
  const isEsport = (n) => /\([^)]+\)\s*$/.test((n || "").trim());
  let esportsFiltered = 0;

  const events = [];
  for (const r of merged) {
    const o = r.odds;
    if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) continue;
    if (!r.home || !r.away) continue;
    if (isEsport(r.home) || isEsport(r.away)) { esportsFiltered++; continue; }
    const ev = {
      eventId: r.eventId, title: `${r.home} - ${r.away}`, homeTeam: r.home, awayTeam: r.away,
      startTime: parseStart(r.timeText), league: r.league ?? null, sport: "football", odds: o,
    };
    if (Array.isArray(r.totals) && r.totals.length) ev.totals = r.totals;
    events.push(ev);
  }
  // Prematch-only inom 24h: tappa redan startade matcher OCH rader utan parsebar
  // starttid (live visar löpande klocka i st f kickoff → okänd starttid = sannolikt live).
  const win = filterToWindowHours(events, { windowHours: 24, dropUnknown: true });
  const kept = win.kept;
  diag.droppedOutsideWindow = win.dropped;
  diag.builtEvents = kept.length;
  diag.withTotals = kept.filter((e) => e.totals?.length).length;
  diag.esportsFiltered = esportsFiltered;
  const payload = { updatedAt: new Date().toISOString(), source: "10bet-playtech-dom", partial: false, events: kept };
  const res = writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "10bet" });
  log(`items=${diag.itemCount} events=${events.length} (skrivet: ${res.written})`);
  fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
}
main().catch((e) => { console.error("[10bet] fel:", e); process.exit(1); });
