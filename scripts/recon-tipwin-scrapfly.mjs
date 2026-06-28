/**
 * recon-tipwin-scrapfly.mjs — VALIDERING: bygg tipwins offer/data-anrop med det riktiga
 * filtret (gzip+base62, avkodat från ett äkta browseranrop) och hämta odds in-page via
 * Scrapfly (renderar förbi CF; same-origin-fetch funkar). Fångar svarets struktur så vi
 * kan skriva parsern. Secret: SCRAPER_API_KEY. Output: data/_recon-tipwin-scrapfly.json.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_recon-tipwin-scrapfly.json");
const PAGE = "https://tipwin.se/sv/home/full/highlights";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(buf) { let n = 0n; for (const b of buf) n = (n << 8n) | BigInt(b); if (n === 0n) return "0"; let s = ""; while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n; } return s; }
function encFilter(obj) { return base62(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))); }

const FOOTBALL_ID = "5rkMRxXDl4zI2f3ROfxAx1";
// "normal" = huvudmarknader (3way=1X2 för fotboll), "marginal" = totals/handicap.
const NORMAL = ["3way", "double-chance", "winner", "draw-no-bet", "will-both-teams-score"];
const MARGINAL = ["over-under", "handicap"];
function offerDataUrl({ topOnly = false, pageSize = 50 } = {}) {
  const filter = {
    paging: { pageNumber: 1, pageSize },
    sorting: ["startTime", "sportCategory", "sportCategoryId", "tournament"],
    filter: { eventType: 0, liveStatus: 0, isTopEvent: topOnly, sportId: FOOTBALL_ID, offers: [{ bettingType: { abrv: { eq: NORMAL } } }, { bettingType: { abrv: { eq: MARGINAL } }, isFavorite: true }] },
    language: "sv-SE",
  };
  return `https://api-web.tipwin.se/v2/100683/offer/data?filter=${encFilter(filter)}&Caller-Environment=Web`;
}

const KICK = `
window.__probe=null;window.__pdone=false;
var H={'Accept-Language':'sv','Caller-Environment':'Web','Agency-Key':'100683','Web-Device':'Web','Shop-Id':'SR1Iz8ycPvDYxsmGm3qCED'};
var url=__URL__;
function asMap(x){if(!x)return {};if(Array.isArray(x)){var m={};x.forEach(function(t){if(t&&t.id)m[t.id]=t});return m;}return x;}
function nm(map,id){var o=map[id];return o?(o.name||o.shortName||o.displayName||o.abrv||null):null;}
var c=new AbortController();var to=setTimeout(function(){c.abort()},9000);
fetch(url,{headers:H,credentials:'include',signal:c.signal}).then(function(r){return r.text().then(function(x){clearTimeout(to);
  var o={status:r.status,len:x.length};
  try{
    var j=JSON.parse(x);
    var teams=asMap(j.lookup&&j.lookup.teams),tours=asMap(j.lookup&&j.lookup.tournaments),tgroups=asMap(j.lookup&&j.lookup.tournamentGroups);
    o.teamSample=JSON.stringify(Object.values(teams)[0]||null).slice(0,200);
    o.tourSample=JSON.stringify(Object.values(tours)[0]||null).slice(0,200);
    var rows=[];
    (j.offer||[]).forEach(function(eo){
      var ev=eo.event||{};if(ev.isUpcoming===false)return;
      var home=nm(teams,ev.teamOneId),away=nm(teams,ev.teamTwoId);
      var x2=null,totals=[];
      (eo.offers||[]).forEach(function(mk){
        var sels=mk.offers||[],tips={};
        sels.forEach(function(s){if(s&&s.tip!=null)tips[s.tip]=s.value;});
        if(!x2&&tips['1']!=null&&tips['X']!=null&&tips['2']!=null&&Object.keys(tips).length===3){var h=+tips['1'],d=+tips['X'],a=+tips['2'];if(h>1&&d>1&&a>1)x2={home:h,draw:d,away:a};}
        if(tips['+']!=null&&tips['-']!=null){var line=(mk.key&&mk.key.specifier&&mk.key.specifier.total);if(line==null)sels.forEach(function(s){if(s.specifier&&s.specifier.total!=null)line=s.specifier.total;});if(line!=null){var ov=+tips['+'],un=+tips['-'];if(ov>1&&un>1)totals.push({line:+line,over:ov,under:un});}}
      });
      if(!x2)return;var title=home&&away?(home+' - '+away):null;if(!title)return;
      var row={eventId:'tipwin_'+ev.id,title:title,homeTeam:home,awayTeam:away,startTime:ev.startTime||null,league:nm(tours,ev.tournamentId)||nm(tgroups,ev.tournamentGroupId)||null,sport:'football',odds:x2};
      if(totals.length)row.totals=totals;rows.push(row);
    });
    o.rowCount=rows.length;o.rows=rows.slice(0,4);
  }catch(e){o.parseErr=String(e&&e.message).slice(0,120);o.raw=x.slice(0,500);}
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
  const out = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  if (!KEY) { out.error = "SCRAPER_API_KEY saknas"; fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n"); return; }
  const url = offerDataUrl({ topOnly: false, pageSize: 50 });
  out.urlLen = url.length;
  const kick = KICK.replace("__URL__", JSON.stringify(url));
  const scenario = [{ wait: 6000 }, { execute: { script: kick, timeout: 8000 } }, { wait: 11000 }, { execute: { script: READ, timeout: 10000 } }];
  const { status, json, text } = await getJson(scrapflyUrl(scenario, PAGE));
  out.http = status;
  out.scrapflyMessage = (typeof json?.message === "string" ? json.message : json?.message?.message) || null;
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
  for (const r of sr) { try { const o = JSON.parse(r); if (o.probe !== undefined) out.read = o; } catch { /* */ } }
  if (status !== 200 && !out.read) out.errBody = (text || "").slice(0, 1200);
  console.log(`[tipwin-offer] http=${status} offerStatus=${out.read?.probe?.status} rowCount=${out.read?.probe?.rowCount} parseErr=${out.read?.probe?.parseErr || "-"}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
}
main().catch((e) => { console.error("[tipwin-offer] fel:", e); process.exit(1); });
