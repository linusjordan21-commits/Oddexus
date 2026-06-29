/**
 * fetch-coolbet-github-action.mjs — Coolbet (sbgate) odds via Scrapfly.
 *
 * BEVISAD METOD (recon):
 *  - Coolbet ligger bakom Imperva (reese84 Advanced Bot Protection). Scrapfly med
 *    asp=true + residential passerar (och tillåter spel, till skillnad fr. Bright Data).
 *  - KATALOG (struktur): GET /s/sbgate/sports/fo-match/v2/coming-soon?sportCategoryId=62
 *    → matcher/marknader/outcome-IDs + `fullSlug` (URL-slug). UTAN priser.
 *  - PRISER: finns BARA via Pusher-websocket → lagras i SPA:ns store
 *    window.stores.sports.oddsByOutcomeId = { <outcomeId>: { value:<decimaloods>,
 *    market_id, match_id, status } }. Fylls när SPA:n NAVIGERAR till en match-/liga-
 *    sida (då prenumererar den). Inget REST-pris finns (coming-soon, fo-match,
 *    betslip-info — alla utan odds, verifierat).
 *
 * Vi kör ETT Scrapfly js_scenario: boota SPA → hämta katalog (sv-slug) → navigera
 * till liga-sidan /sv/odds/<fullSlug> → vänta på Pusher → läs oddsByOutcomeId.
 * Joinar value (per outcomeId) mot katalogens marknader → kanoniskt events[]-format
 * (1X2 + totals + AH) identiskt med atg-rows.json.
 *
 * Secret: SCRAPER_API_KEY (Scrapfly-nyckel).
 * Output: data/coolbet-rows.json (cache-preserve). Diag: data/_coolbet-scraper-diag.json.
 */

import fs from "node:fs";
import path from "node:path";
import { installHardDeadline, writeJsonPreservingCache, filterToWindowHours } from "./lib/scrape-guard.mjs";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "coolbet-rows.json");
const DIAG_FILE = path.join(DATA_DIR, "_coolbet-scraper-diag.json");

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const SPORT_CATEGORY_ID = 62; // fotboll (verifierat)
const FOOTBALL_PAGE = "https://www.coolbet.com/sv/odds/fotboll";
const MARKET_TYPE = { ML_1X2: 81, OVER_UNDER: 818, ASIAN_HANDICAP: 1086 }; // 1086 = "Asian handicap" (2-vägs); 1011 = "Handicap (3-vägs)"

// ---------------------------------------------------------------------------
// Bygg kanoniska events ur katalog + pris-funktion (oförändrad join-logik).
// ---------------------------------------------------------------------------
function buildEvents(matches, priceFor) {
  const events = [];
  for (const m of matches) {
    const homeTeam = m.home_team_name ?? null;
    const awayTeam = m.away_team_name ?? null;
    const title = homeTeam && awayTeam ? `${homeTeam} - ${awayTeam}` : String(m.name ?? "").trim();
    const markets = Array.isArray(m.markets) ? m.markets : [];

    let one = null;
    const totals = [];
    const ah = [];
    const cornerTotals = [];

    for (const mk of markets) {
      const type = mk.market_type_id;
      const nm = String(mk.name ?? "").toLowerCase();
      const outs = Array.isArray(mk.outcomes) ? mk.outcomes : [];
      const priced = outs.map((o) => ({ o, price: priceFor(String(o.id)) }));
      if (priced.some((p) => p.price == null)) continue;

      // HÖRN först (annars skulle 'Corner Over/Under' fångas av mål-total-regexen).
      if (/corner|hörn/.test(nm)) {
        if (priced.length === 2) {
          const line = Number(mk.raw_line ?? mk.line);
          let over = null, under = null;
          for (const p of priced) {
            const k = `${p.o.result_key || ""} ${p.o.name || ""}`.toLowerCase();
            if (/over|över/.test(k)) over = p.price; else if (/under/.test(k)) under = p.price;
          }
          if (over > 1 && under > 1 && Number.isFinite(line)) cornerTotals.push({ line, over, under });
        }
        continue; // hörn-marknad klassas aldrig som mål
      }

      // Klassa på NAMN (robust mot market_type_id-ändringar), med id som hint.
      const is1x2 = type === MARKET_TYPE.ML_1X2 || /match result|1x2|full time result|fulltid/.test(nm);
      const isTotal = type === MARKET_TYPE.OVER_UNDER || /total goals.*over|over\s*\/\s*under|över\s*\/\s*under/.test(nm);
      const isAh = type === MARKET_TYPE.ASIAN_HANDICAP || /asian handicap|asiatiskt handikapp|handicap|handikapp/.test(nm);

      if (is1x2 && priced.length === 3) {
        const byKey = {};
        for (const p of priced) byKey[String(p.o.result_key || "").toLowerCase()] = p.price;
        const home = byKey["[home]"] ?? byKey["home"];
        const draw = byKey["draw"];
        const away = byKey["[away]"] ?? byKey["away"];
        if (home > 1 && draw > 1 && away > 1) one = { home, draw, away };
      } else if (isTotal && priced.length === 2) {
        const line = Number(mk.raw_line ?? mk.line);
        let over = null, under = null;
        for (const p of priced) {
          const k = `${p.o.result_key || ""} ${p.o.name || ""}`.toLowerCase();
          if (/over|över/.test(k)) over = p.price; else if (/under/.test(k)) under = p.price;
        }
        if (over > 1 && under > 1 && Number.isFinite(line)) totals.push({ line, over, under });
      } else if (isAh && priced.length === 2) {
        const line = Number(mk.raw_line ?? mk.line);
        let home = null, away = null;
        for (const p of priced) {
          const k = String(p.o.result_key || "").toLowerCase();
          if (k.includes("home")) home = p.price; else if (k.includes("away")) away = p.price;
        }
        if (home > 1 && away > 1 && Number.isFinite(line)) ah.push({ line, home, away });
      }
    }

    if (!one) continue; // konsument kräver 1X2 (atg-format) → drop utan prissatt 1X2

    const event = {
      eventId: `coolbet_${m.id}`,
      title, homeTeam, awayTeam,
      startTime: m.match_start ?? null,
      league: m.category_name ?? null,
      sport: "football",
      odds: one,
    };
    if (totals.length) event.totals = totals;
    if (ah.length) event.ah = ah;
    if (cornerTotals.length) event.corners = { totals: cornerTotals };
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Scrapfly-anrop
// ---------------------------------------------------------------------------
// Tak på antal ligor vi NAVIGERAR för odds (struktur hämtas gratis för ALLA ligor i
// INIT). Prioriterade: riktig fotboll först. Credit-kostnad är per RENDER, ej per liga
// → MAX_LEAGUES/LEAGUES_PER_CALL renders. 20/4 = upp till 5 renders (150 cr) men hard-
// deadline (6 min) kapar tidigare; 24h-filtret gör att de flesta körningar har färre.
const MAX_LEAGUES = Number(process.env.COOLBET_MAX_LEAGUES) || 20; // tak mot credit-runaway
// Kostnadsoptimering: ETT Scrapfly-render (=30 credits) besöker FLERA ligor via
// client-side-navigering (pushState+popstate → ingen reload → storen rensas ej →
// Pusher-prenumerationer ackumuleras). Credit-kostnad är per ANROP, ej per liga.
// 4000 (2026-06-29): bas-boot innan vi börjar POLLA efter flatCategories i INIT (fast
// boot-wait var flaky — 6/11/14s misslyckades, 12s lyckades; store-fyllnaden varierar).
// Pollen i INIT_SCRIPT väntar exakt så länge som behövs (upp till ~16s) → robustare.
const BOOT_MS = Number(process.env.COOLBET_BOOT_MS) || 4000;           // SPA-boot innan poll
const PUSHER_MS = Number(process.env.COOLBET_PUSHER_MS) || 6000;        // Pusher-fyllnad/liga
const LEAGUES_PER_CALL = Number(process.env.COOLBET_LEAGUES_PER_CALL) || 3; // ligor/render (3 i anrop 1 ger budget åt pollen; resten i anrop 2+)
// VIKTIGT: Scrapfly RESERVERAR varje execute-stegs hela timeout i förväg och summan
// (render + waits + execute-timeouts) måste rymmas under top-level timeout (90s).
// INIT pollar nu flatCategories (~upp till 16s) + fetchar fo-category för ligor
// parallellt (~24s) → reservera 42s. Render1: 4(boot)+42(init)+3×(6+5)=79s < 90.
const INIT_EXEC_MS = Number(process.env.COOLBET_INIT_EXEC_MS) || 42000;
const STEP_EXEC_MS = Number(process.env.COOLBET_STEP_EXEC_MS) || 5000;

function scrapflyUrl(scenario, pageUrl = FOOTBALL_PAGE) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se",
    // retry:false + timeout krävs för att få höja execute-stegets default 3s-timeout
    // (annars ERR::SCRAPE::SCENARIO_EXECUTION när navigeringen körs).
    rendering_wait: "6000", timeout: "90000", retry: "false",
    proxy_pool: "public_residential_pool", format: "json",
    js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url"),
  });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}

async function getJson(url, timeoutMs = 170000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text), text }; }
    catch { return { status: r.status, json: null, text }; }
  } finally { clearTimeout(t); }
}

// Scrapfly-anrop med retry på intermittent 422 (SCENARIO_EXECUTION, retry:false-priset).
// Returnerar även `err` (Scrapfly-meddelande + första misslyckade stegets fel) för diag.
async function scrapflyCall(scenario, pageUrl, label, tries = 3) {
  let lastErr = null;
  for (let i = 1; i <= tries; i += 1) {
    const { status, json, text } = await getJson(scrapflyUrl(scenario, pageUrl));
    const steps = json?.result?.browser_data?.js_scenario?.steps;
    const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
    if (status === 200 && sr.length) return { status, sr, err: null };
    // Plocka ut det faktiska felet: top-level message, result.error, samt det första
    // steget som misslyckades (action + error/result-huvud) så vi ser VAR det small.
    const msg = (typeof json?.message === "string" ? json.message : json?.message?.message)
      || json?.result?.error || (json ? null : (text || "").slice(0, 200));
    const badStep = Array.isArray(steps) ? steps.find((s) => s?.success === false) : null;
    lastErr = {
      http: status, message: msg || null,
      step: badStep ? { action: badStep.action, error: badStep.error || null,
        head: typeof badStep.result === "string" ? badStep.result.slice(0, 200) : null } : null,
    };
    console.log(`[coolbet] ${label} försök ${i}/${tries} → http=${status} msg=${(msg || "?").toString().slice(0, 120)} step=${badStep?.action || "-"}`);
    if (i < tries) await new Promise((r) => setTimeout(r, 4000));
    else return { status, sr, err: lastErr };
  }
  return { status: 0, sr: [], err: lastErr };
}

// Delade in-page-hjälpare: find(oddsByOutcomeId), merge(store→window.__odds),
// nav(slug via pushState+popstate → client-side, ingen reload → store bevaras).
const DEFS = `
function find(o,d){if(d>7||!o||typeof o!=='object')return null;for(var k in o){try{if(k==='oddsByOutcomeId'){var v=o[k];return (v&&typeof v==='object'&&'state' in v)?v.state:v;}var r=find(o[k],d+1);if(r)return r;}catch(e){}}return null;}
function merge(){try{var st=find(window.stores,0);if(st&&typeof st==='object'){for(var id in st){var e=st[id];if(e&&e.value!=null)window.__odds[id]=e.value;}}}catch(e){}}
function nav(s){if(s){setTimeout(function(){try{history.pushState({},'','/sv/odds/'+s);window.dispatchEvent(new PopStateEvent('popstate'));}catch(e){}},0);}}`;

// INIT (anrop 1): FULL katalog. coming-soon ger bara 6 "highlight"-matcher; den
// riktiga per-liga-listan kommer från fo-category/?categoryId=<liga>&limit=N
// (SPA:n hårdkodar limit=6 → därför 6). Vi läser flatCategories ur storen → alla
// fotbollsligor med matcher → fetchar fo-category för VARJE liga IN-PAGE (gratis,
// bara renders kostar credits) → trimmar + filtrerar till 24h-fönstret → bygger
// målslug-listan (riktig fotboll först, flest 24h-matcher först). Priserna saknas
// i strukturen (outcomeHasPrice=false, verifierat) → fylls via Pusher när vi
// navigerar till ligan (1 nav prenumererar HELA ligan, 100% outcome-täckning,
// verifierat). main() chunk:ar nav över flera renders. Returnerar matches+slugs.
const INIT_SCRIPT = DEFS + `
var base='https://www.coolbet.com/s/sbgate/';
var Q='country=SE&isMobile=0&language=sv&layout=EUROPEAN&matchTypeFilter=all';
var H={headers:{accept:'application/json'}};
function val(s){return s&&typeof s==='object'&&'state' in s?s.state:s;}
function collect(node,acc){if(!node||typeof node!=='object')return;if(Array.isArray(node.matches))node.matches.forEach(function(m){acc.push(m)});if(Array.isArray(node.categories))node.categories.forEach(function(c){collect(c,acc)});if(Array.isArray(node))node.forEach(function(c){collect(c,acc)});}
function keepMk(mk){var t=mk.market_type_id;var n=String(mk.name||'').toLowerCase();return t===81||t===818||t===1086||/1x2|match result|fulltid|full time|total|över|over|under|handicap|handikapp|asian|corner|hörn/.test(n);}
function trim(m,slug,lname){return {id:m.id,name:m.name,home_team_name:m.home_team_name,away_team_name:m.away_team_name,match_start:m.match_start,inplay:m.inplay,category_name:lname||m.category_name,fullSlug:slug,markets:(m.markets||[]).filter(keepMk).map(function(mk){return {id:mk.id,market_type_id:mk.market_type_id,name:mk.name,raw_line:mk.raw_line,line:mk.line,outcomes:(mk.outcomes||[]).map(function(oc){return {id:oc.id,result_key:oc.result_key,name:oc.name}})}})}}
var o={};
try{
  // POLL: SPA-storen fyller flatCategories vid en VARIERANDE tid (~11-14s, ibland mer).
  // En fast boot-wait är bevisat flaky (6/11/14s misslyckades, 12s lyckades). Polla
  // var 500ms tills flatCategories är en icke-tom array (max ~16s), så vi väntar exakt
  // så länge som behövs i st f att gissa. Scenariot är async (await tillåtet här).
  var st=null,fc=null,polls=0;
  for(polls=0;polls<32;polls++){st=(window.stores&&window.stores.sports)||null;fc=st?val(st.flatCategories):null;if(Array.isArray(fc)&&fc.length)break;await new Promise(function(r){setTimeout(r,500);});}
  o.bootPolls=polls;
  if(!Array.isArray(fc)||!fc.length){o.err='ingen flatCategories i store';try{o.storeKeys=window.stores?Object.keys(window.stores):'no window.stores';o.sportsKeys=st?Object.keys(st):'no window.stores.sports';o.fcType=typeof (st&&st.flatCategories);}catch(e){o.storeProbeErr=String(e).slice(0,120);}window.__matches=[];window.__slugs=[];window.__odds={};window.__i=0;return JSON.stringify(o);}
  var leagues=fc.filter(function(c){return /^fotboll(\\/|$)/i.test(String(c&&c.fullSlug||''))&&(c.matches_count||0)>0;}).map(function(c){return {id:c.id,fullSlug:c.fullSlug,name:c.name,n:c.matches_count};});
  o.leagueCount=leagues.length;
  // parallell fetch (concurrency 12) av fo-category per liga → alla matcher.
  var raw=[];var idx=0;
  async function worker(){while(idx<leagues.length){var lg=leagues[idx++];try{var j=await fetch(base+'sports/fo-category/?categoryId='+lg.id+'&limit=200&'+Q,H).then(function(r){return r.json()});var acc=[];collect(j.categories||[],acc);for(var k=0;k<acc.length;k++)raw.push(trim(acc[k],lg.fullSlug,lg.name));}catch(e){}}}
  var ws=[];for(var w=0;w<12;w++)ws.push(worker());await Promise.all(ws);
  o.rawMatches=raw.length;
  // Prematch-only inom 24h: +24h fram, INGEN grace bakåt (live tappas), och skippa
  // matcher som redan är inplay. Vi följer inga live-matcher just nu.
  var now=Date.now(),hi=now+24*3600000;
  var byId={};raw.forEach(function(m){if(m.inplay===true)return;var t=Date.parse(m.match_start||'');if(isFinite(t)&&(t>hi||t<now))return;if(!byId[m.id])byId[m.id]=m;});
  var matches=Object.keys(byId).map(function(k){return byId[k]});
  o.matches=matches;o.matchCount=matches.length;
  // DIAG: fördelning av rå-matchernas avspark (är 24h-fönstret genuint glest, eller datumbugg?)
  o.windowProbe={nInplay:0,nBadDate:0,nPast:0,n24:0,n48:0,n72:0,nFuture:0,samples:[]};
  raw.forEach(function(m){var t=Date.parse(m.match_start||'');if(m.inplay===true){o.windowProbe.nInplay++;}else if(!isFinite(t)){o.windowProbe.nBadDate++;}else{var dh=(t-now)/3600000;if(dh<0)o.windowProbe.nPast++;else if(dh<=24)o.windowProbe.n24++;else if(dh<=48)o.windowProbe.n48++;else if(dh<=72)o.windowProbe.n72++;else o.windowProbe.nFuture++;}if(o.windowProbe.samples.length<4)o.windowProbe.samples.push(String(m.match_start));});
  // målslug-lista: räkna 24h-matcher/slug; riktig fotboll FÖRE esoccer/special; flest först.
  var cnt={};matches.forEach(function(m){if(m.fullSlug)cnt[m.fullSlug]=(cnt[m.fullSlug]||0)+1;});
  function isReal(s){return !/esoccer|efootball|esport|virtual|cyber|specialspel/i.test(s);}
  var slugs=Object.keys(cnt).sort(function(a,b){var ra=isReal(a)?1:0,rb=isReal(b)?1:0;if(ra!==rb)return rb-ra;return cnt[b]-cnt[a]||(a<b?-1:1);});
  o.probe={leagues:leagues.length,rawMatches:raw.length,matches24h:matches.length,slugs:slugs.length,topSlugs:slugs.slice(0,12).map(function(s){return {slug:s,n:cnt[s]};})};
  window.__matches=matches;window.__slugs=slugs;window.__odds={};window.__i=0;
  o.slugs=slugs;o.slug=slugs[0]||null;
  nav(slugs[0]);o.nav=slugs[0]||null;
}catch(e){o.err=String(e&&e.stack||e).slice(0,300);window.__matches=window.__matches||[];window.__slugs=window.__slugs||[];window.__odds=window.__odds||{};window.__i=window.__i||0;}
return JSON.stringify(o);`;

// CHUNK_INIT (anrop 2+): färsk render, ingen katalog behövs igen — main() injicerar
// den explicita slug-listan för denna chunk; navigera client-side till första.
function chunkInitScript(slugs) {
  return DEFS + `
var o={};
try{
window.__slugs=${JSON.stringify(slugs)};window.__odds={};window.__i=0;
nav(window.__slugs[0]);o.nav=window.__slugs[0]||null;o.slugs=window.__slugs;
}catch(e){o.err=''+e}
return JSON.stringify(o);`;
}

// STEP: merga aktuell ligas priser (Pusher har hunnit fylla storen) → window.__odds,
// stega index och navigera client-side till nästa liga. count = ackumulerat antal.
const STEP_SCRIPT = DEFS + `
var o={};
try{merge();window.__i++;var s=window.__slugs[window.__i];nav(s);o.nav=s||null;o.count=Object.keys(window.__odds).length;}catch(e){o.err=''+e}
return JSON.stringify(o);`;

// READ_ALL: sista steget i en chunk — merga sista ligan och returnera allt ackumulerat.
const READ_ALL_SCRIPT = DEFS + `
var o={};
try{merge();o.odds=window.__odds;o.count=Object.keys(window.__odds).length;}catch(e){o.err=''+e}
return JSON.stringify(o);`;

// Bygg ett Scrapfly-scenario som i EN render besöker `count` ligor: boot → init(nav
// liga 0) → [vänta → STEP(merga liga j, nav j+1)]×(count-1) → vänta → READ_ALL.
function buildScenario(initScript, count) {
  const s = [{ wait: BOOT_MS }, { execute: { script: initScript, timeout: INIT_EXEC_MS } }];
  for (let j = 0; j < count; j += 1) {
    s.push({ wait: PUSHER_MS });
    s.push({ execute: { script: j === count - 1 ? READ_ALL_SCRIPT : STEP_SCRIPT, timeout: STEP_EXEC_MS } });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  installHardDeadline({ budgetMs: Number(process.env.COOLBET_DEADLINE_MS) || 6 * 60 * 1000, label: "coolbet" });
  const diag = { ranAt: new Date().toISOString(), catalogMatches: 0, oddsCount: 0, builtEvents: 0, slug: null, calls: [], notes: [] };

  if (!KEY) {
    diag.notes.push("SCRAPER_API_KEY (Scrapfly) saknas");
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
    console.error("[coolbet] SCRAPER_API_KEY saknas — avbryter");
    return;
  }

  // ANROP 1: katalog + första ligachunken i EN render (client-side-nav ackumulerar
  // odds över flera ligor utan reload → store bevaras → Pusher fyller på).
  console.log(`[coolbet] anrop 1: katalog + upp till ${LEAGUES_PER_CALL} ligor (client-side-nav)…`);
  const sc1 = buildScenario(INIT_SCRIPT, LEAGUES_PER_CALL);
  const { status, sr: sr1, err: err1 } = await scrapflyCall(sc1, FOOTBALL_PAGE, "chunk0");
  diag.scrapflyHttp = status;
  if (err1) diag.scrapflyError = err1;
  if (sr1.length < 2) {
    diag.notes.push(`Scrapfly gav inte två exec-resultat (http=${status})`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
    console.error("[coolbet] otillräckligt svar från Scrapfly");
    return;
  }
  let nav = {}, read = {};
  try { nav = JSON.parse(sr1[0]); } catch { /* */ }
  try { read = JSON.parse(sr1[sr1.length - 1]); } catch { /* */ }

  const matches = Array.isArray(nav.matches) ? nav.matches : [];
  const odds = read.odds && typeof read.odds === "object" ? { ...read.odds } : {};
  diag.catalogMatches = matches.length;
  diag.slug = nav.slug ?? null;
  diag.slugs = nav.slugs ?? null;
  diag.probe = nav.probe ?? null;
  diag.bootPolls = nav.bootPolls ?? null;     // diag: hur många 500ms-polls innan flatCategories fylldes
  diag.windowProbe = nav.windowProbe ?? null; // diag: avsparks-fördelning (glest 24h-fönster vs datumbugg?)
  diag.storeKeys = nav.storeKeys ?? null;     // diag: vilka nycklar finns på window.stores nu?
  diag.sportsKeys = nav.sportsKeys ?? null;   // diag: vilka nycklar på window.stores.sports? (hitta var flatCategories tog vägen)
  diag.fcType = nav.fcType ?? null;
  diag.marketTypes = Array.isArray(nav.marketTypes) ? nav.marketTypes.slice(0, 40) : null;
  diag.ahSample = nav.ahSample || null;
  if (nav.err) diag.notes.push(`nav-fel: ${nav.err}`);
  if (read.err) diag.notes.push(`read-fel: ${read.err}`);
  const allSlugs = Array.isArray(nav.slugs) ? nav.slugs : [];
  diag.calls.push({ chunk: allSlugs.slice(0, LEAGUES_PER_CALL), odds: Object.keys(odds).length });

  // ANROP 2+: resterande ligor (upp till MAX_LEAGUES) i chunkar om LEAGUES_PER_CALL.
  // Varje anrop = en färsk render som client-side-besöker sin chunk; merga in oddsen.
  const remaining = allSlugs.slice(LEAGUES_PER_CALL, MAX_LEAGUES);
  for (let i = 0; i < remaining.length; i += LEAGUES_PER_CALL) {
    const chunk = remaining.slice(i, i + LEAGUES_PER_CALL);
    if (!chunk.length) break;
    try {
      const sc = buildScenario(chunkInitScript(chunk), chunk.length);
      const { sr } = await scrapflyCall(sc, FOOTBALL_PAGE, `chunk ${chunk[0]}`);
      const r = sr.length ? JSON.parse(sr[sr.length - 1]) : {};
      let added = 0;
      if (r.odds) { for (const [id, v] of Object.entries(r.odds)) { if (!(id in odds)) added += 1; odds[id] = v; } }
      diag.calls.push({ chunk, odds: r.count ?? 0, totalAfter: Object.keys(odds).length });
      console.log(`[coolbet] chunk [${chunk.join(", ")}] → +${added} nya (totalt ${Object.keys(odds).length})`);
    } catch (e) {
      diag.notes.push(`chunk ${chunk[0]} fel: ${String(e).slice(0, 100)}`);
    }
  }

  diag.oddsCount = Object.keys(odds).length;
  diag.scrapflyCalls = diag.calls.length;
  diag.leaguesFetched = allSlugs.slice(0, MAX_LEAGUES);
  const allEvents = buildEvents(matches, (id) => (odds[id] != null ? Number(odds[id]) : null));
  // Fokusera på 24h-fönstret (betald Scrapfly-källa → lägg budget på färskhet, ej >24h).
  const win = filterToWindowHours(allEvents, { windowHours: 24 });
  const events = win.kept;
  diag.droppedOutsideWindow = win.dropped;
  diag.builtEvents = events.length;

  const payload = { updatedAt: new Date().toISOString(), source: "scrapfly", partial: false, events };
  const res = writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "coolbet" });
  console.log(`[coolbet] katalog=${matches.length} odds=${diag.oddsCount} events=${events.length} anrop=${diag.calls.length} slug=${diag.slug} (skrivet: ${res.written})`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
}

main().catch((e) => { console.error("[coolbet] fel:", e); process.exit(1); });
