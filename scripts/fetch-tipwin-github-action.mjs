/**
 * fetch-tipwin-github-action.mjs — tipwin.se (GP/NSoft-sportsbook) prematch-odds.
 *
 * BEVISAD METOD (recon): tipwins React/Capacitor-SPA monterar inte i headless och
 * appen är CF-skyddad, MEN data-API:t nås via Scrapfly-render (passerar CF) + en
 * same-origin in-page-fetch mot:
 *   GET https://api-web.tipwin.se/v2/100683/offer/data?filter=<base62(gzip(JSON))>&Caller-Environment=Web
 * med headers Agency-Key:100683, Shop-Id:<online-shop>, Caller-Environment:Web, Web-Device:Web.
 * Filtret (gzip+base62-kodat) avkodades från ett äkta browseranrop: fotboll, prematch
 * (eventType 0/liveStatus 0), riktiga marknads-abrv:er (3way=1X2, over-under=totals,
 * handicap). Svaret = {offer:[{event,offers}], lookup:{teams,tournaments,...}}.
 *
 * Vi renderar highlights-sidan (CF-clearance), kör in-page-fetch + parsar till kanoniskt
 * events[]-format (samma som coolbet/888sport) IN-PAGE (litet svar istället för ~600 kB).
 * KOSTNAD: ASP+render+residential = 30 credits/anrop (som Coolbet) → cron var 30:e min (budget).
 * Secret: SCRAPER_API_KEY. Output: data/tipwin-rows.json.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { installHardDeadline, writeJsonPreservingCache, filterToWindowHours } from "./lib/scrape-guard.mjs";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "tipwin-rows.json");
const DIAG_FILE = path.join(DATA_DIR, "_tipwin-scraper-diag.json");
const PAGE = "https://tipwin.se/sv/home/full/highlights";
const log = (...a) => console.log("[tipwin]", ...a);

// agencyKey + online-shopId + fotbolls-sportId (ur recon/bundlar).
const AGENCY = "100683";
const SHOP_ID = "SR1Iz8ycPvDYxsmGm3qCED";
const FOOTBALL_ID = "5rkMRxXDl4zI2f3ROfxAx1";
// Marknads-abrv:er VERBATIM ur appens äkta filter (full täckning: 1X2/dubbelchans/
// draw-no-bet/btts under NORMAL; totals/handicap under MARGINAL).
const NORMAL = ["3way", "overtime-1x2", "penalty-shootout-winner", "who-wins-1st-half", "overtime-1st-half-1x2", "double-chance", "1st-half-double-chance", "goalnr-goal", "goalnr-goal2", "overtime-goalnr-goal", "1st-half-goalnr-goal", "1st-half-goalnr-goal2", "will-both-teams-score", "draw-no-bet", "1st-half-draw-no-bet", "1st-half-which-team-wins-the-rest", "who-wins-period-periodnr", "winner", "winner-incl-overtime", "winner-incl-super-over", "winner-incl-extra-innings", "winner-incl-overtime-and-penalties", "setnr-set-winner", "most-180s", "1x2-incl-overtime", "head2head", "head2head-1x2", "head2head-teams", "inningnr-inning-1x2", "which-team-wins-the-rest-of-the-match", "setnr-set-which-player-wins-the-rest", "gamenr-set-winner"];
const MARGINAL = ["over-under", "total-incl-overtime", "total-incl-extra-innings", "overtime-total", "1st-half-totals", "handicap-hcp", "overtime-handicap", "handicap-incl-overtime", "1st-half-handicap-hcp", "overtime-1st-half-handicap", "periodnr-period-total", "match-game-handicap", "over-under-games-in-the-match", "set-handicap", "setnr-set-total-games", "total-points", "point-handicap", "total-180s", "handicap", "handicap-incl-extra-innings", "1st-half-handicap", "total-frames", "frame-handicap"];

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(buf) { let n = 0n; for (const b of buf) n = (n << 8n) | BigInt(b); if (n === 0n) return "0"; let s = ""; while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n; } return s; }
function offerDataUrl(pageSize) {
  const filter = {
    paging: { pageNumber: 1, pageSize },
    sorting: ["startTime", "sportCategory", "sportCategoryId", "tournament"],
    filter: { eventType: 0, liveStatus: 0, isTopEvent: false, sportId: FOOTBALL_ID, offers: [{ bettingType: { abrv: { eq: NORMAL } } }, { bettingType: { abrv: { eq: MARGINAL } }, isFavorite: true }] },
    language: "sv-SE",
  };
  return `https://api-web.tipwin.se/v2/${AGENCY}/offer/data?filter=${base62(zlib.gzipSync(Buffer.from(JSON.stringify(filter))))}&Caller-Environment=Web`;
}

// In-page: fetcha offer/data (same-origin, CF-clearad) + parsa till kanoniska rader.
const KICK = `
window.__probe=null;window.__pdone=false;
var H={'Accept-Language':'sv','Caller-Environment':'Web','Agency-Key':'${AGENCY}','Web-Device':'Web','Shop-Id':'${SHOP_ID}'};
var url=__URL__;
function asMap(x){if(!x)return {};if(Array.isArray(x)){var m={};x.forEach(function(t){if(t&&t.id)m[t.id]=t});return m;}return x;}
function nm(map,id){var o=map[id];return o?(o.name||o.shortName||o.displayName||o.abrv||null):null;}
var c=new AbortController();var to=setTimeout(function(){c.abort()},9000);
fetch(url,{headers:H,credentials:'include',signal:c.signal}).then(function(r){return r.text().then(function(x){clearTimeout(to);
  var o={status:r.status};
  try{
    var j=JSON.parse(x);
    var teams=asMap(j.lookup&&j.lookup.teams),tours=asMap(j.lookup&&j.lookup.tournaments),tgroups=asMap(j.lookup&&j.lookup.tournamentGroups);
    var rows=[];
    (j.offer||[]).forEach(function(eo){
      var ev=eo.event||{};if(ev.isUpcoming===false)return;
      var home=nm(teams,ev.teamOneId),away=nm(teams,ev.teamTwoId);
      var x2=null,totals=[],eh3=[];
      (eo.offers||[]).forEach(function(mk){
        var sels=mk.offers||[],tips={};
        sels.forEach(function(s){if(s&&s.tip!=null)tips[s.tip]=s.value;});
        // handikapp-specifier "a:b" (hemma:borta startmål) finns på handikapp-marknaden.
        var hcp=(mk.key&&mk.key.specifier&&mk.key.specifier.hcp);
        if(hcp==null)sels.forEach(function(s){if(s&&s.specifier&&s.specifier.hcp!=null)hcp=s.specifier.hcp;});
        // 1X2: tips 1/X/2, exakt 3 nycklar OCH ingen hcp (annars är det handikapp-marknaden).
        if(!x2&&hcp==null&&tips['1']!=null&&tips['X']!=null&&tips['2']!=null&&Object.keys(tips).length===3){var h=+tips['1'],d=+tips['X'],a=+tips['2'];if(h>1&&d>1&&a>1)x2={home:h,draw:d,away:a};}
        if(tips['+']!=null&&tips['-']!=null){var line=(mk.key&&mk.key.specifier&&mk.key.specifier.total);if(line==null)sels.forEach(function(s){if(s.specifier&&s.specifier.total!=null)line=s.specifier.total;});if(line!=null){var ov=+tips['+'],un=+tips['-'];if(ov>1&&un>1)totals.push({line:+line,over:ov,under:un});}}
        // EUROPEISKT 3-vägs-handikapp: spec.hcp "a:b" + tips 1/X/2. line = a−b (hemma-
        // handikapp, samma teckenkonvention som AH; "1:0"→+1, "0:1"→−1). Prissätts mot
        // Pinnacles AH-stege (eh3Valuebets.ts) → nu meningsfullt att fånga.
        if(hcp!=null&&tips['1']!=null&&tips['X']!=null&&tips['2']!=null){var hh=String(hcp).split(':');if(hh.length===2){var ha=+hh[0],hb=+hh[1];if(isFinite(ha)&&isFinite(hb)){var H=ha-hb,h3=+tips['1'],d3=+tips['X'],a3=+tips['2'];if(h3>1&&d3>1&&a3>1)eh3.push({line:H,home:h3,draw:d3,away:a3});}}}
      });
      if(!x2)return;var title=home&&away?(home+' - '+away):null;if(!title)return;
      var row={eventId:'tipwin_'+ev.id,title:title,homeTeam:home,awayTeam:away,startTime:ev.startTime||null,league:nm(tours,ev.tournamentId)||nm(tgroups,ev.tournamentGroupId)||null,sport:'football',odds:x2};
      if(totals.length)row.totals=totals;if(eh3.length)row.eh3=eh3;rows.push(row);
    });
    o.rows=rows;
  }catch(e){o.parseErr=String(e&&e.message).slice(0,140);o.raw=x.slice(0,300);}
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
async function getJson(url, timeoutMs = 175000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); const text = await r.text(); try { return { status: r.status, json: JSON.parse(text), text }; } catch { return { status: r.status, json: null, text }; } }
  finally { clearTimeout(t); }
}

async function fetchRows(diag) {
  const url = offerDataUrl(100);
  const kick = KICK.replace("__URL__", JSON.stringify(url));
  const scenario = [{ wait: 6000 }, { execute: { script: kick, timeout: 8000 } }, { wait: 11000 }, { execute: { script: READ, timeout: 10000 } }];
  // Scrapfly 504 (residential-proxy seg) är transient → upp till 3 försök.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { status, json } = await getJson(scrapflyUrl(scenario, PAGE));
    if (status === 504 || status === 502 || status === 429) { diag.notes.push(`Scrapfly ${status} (försök ${attempt}) — retry`); continue; }
    const steps = json?.result?.browser_data?.js_scenario?.steps;
    const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
    let probe = null;
    for (const r of sr) { try { const o = JSON.parse(r); if (o.probe !== undefined) probe = o.probe; } catch { /* */ } }
    diag.scrapflyStatus = status;
    diag.offerStatus = probe?.status ?? null;
    diag.parseErr = probe?.parseErr ?? null;
    if (probe?.raw) diag.rawSample = probe.raw;
    const rows = Array.isArray(probe?.rows) ? probe.rows : [];
    diag.withTotals = rows.filter((r) => r.totals?.length).length;
    return rows;
  }
  diag.notes.push("alla Scrapfly-försök gav timeout/throttle");
  return [];
}

async function main() {
  installHardDeadline({ budgetMs: Number(process.env.TIPWIN_DEADLINE_MS) || 7 * 60 * 1000, label: "tipwin" });
  const diag = { ranAt: new Date().toISOString(), builtEvents: 0, notes: [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!KEY) { diag.notes.push("SCRAPER_API_KEY saknas"); fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n"); log("ingen nyckel — avbryter"); return; }

  let rows = [];
  try { rows = await fetchRows(diag); }
  catch (e) { diag.notes.push(`fel: ${String(e?.message ?? e).slice(0, 160)}`); log("fel:", e?.message ?? e); }

  // Fokusera på 24h-fönstret: tappa matcher som startar >24h fram (sparar fokus
  // åt valuebettern, låter oss lägga skrapbudget på FREKVENS i 24h-fönstret).
  const win = filterToWindowHours(rows, { windowHours: 24 });
  rows = win.kept;
  diag.droppedOutsideWindow = win.dropped;
  diag.builtEvents = rows.length;
  const payload = { updatedAt: new Date().toISOString(), source: "tipwin-gp", partial: false, events: rows };
  const res = writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "tipwin" });
  log(`events=${rows.length} offerStatus=${diag.offerStatus} (skrivet: ${res.written})`);
  fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
}

main().catch((e) => { console.error("[tipwin] fel:", e); process.exit(1); });
