/**
 * recon-coolbet-tree.mjs — probe Coolbet sbgate REST odds via the REAL endpoints
 * discovered in the app bundle:
 *   - sports/fo-category/        {categoryId, isMobile, offset, language, country, layout, matchTypeFilter, limit}
 *   - sports/fo-market           {matchId, marketTypeId?, country, language, layout}  → .markets (odds)
 *   - sports/fo-match            {matchIds, language, country, layout}                 → .matches
 * Runs same-origin in a Scrapfly browser (bypasses Imperva). ONE call.
 * Dumps structural JSON so we can see where the prices live.
 *
 * Secret: SCRAPER_API_KEY (Scrapfly). Out → data/_coolbet-tree-recon.json
 */

import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_coolbet-tree-recon.json");
const ODDS_PAGE = "https://www.coolbet.com/sv/odds/fotboll";

function scrapflyUrl(extra = {}) {
  const p = new URLSearchParams({
    key: KEY, url: ODDS_PAGE, render_js: "true", asp: "true", country: "se",
    rendering_wait: "12000", proxy_pool: "public_residential_pool", format: "json", ...extra,
  });
  return `https://api.scrapfly.io/scrape?${p.toString()}`;
}
async function get(url, timeoutMs = 170000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal }); return { status: r.status, text: await r.text() }; }
  finally { clearTimeout(t); }
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function main() {
  const results = { ranAt: new Date().toISOString(), hasKey: !!KEY };
  if (!KEY) { results.error = "SCRAPER_API_KEY saknas."; fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n"); return; }

  // In-page probe. Keep flat (no recursion → no Scrapfly 422). Discover a valid
  // categoryId from popular-leagues/hot, then drill fo-category/ tree → fo-market.
  const execScript = `
var base='https://www.coolbet.com/s/sbgate/';
var H={headers:{accept:'application/json'}};
var Q=function(o){return Object.keys(o).map(function(k){return k+'='+encodeURIComponent(o[k])}).join('&')};
var JT=function(u,opt){return fetch(u[0]==='h'?u:base+u,opt||H).then(function(x){return x.text().then(function(t){return {s:x.status,t:t}})}).catch(function(e){return {s:-1,t:String(e)}})};
var out={};
var lang='en',ctry='SE',lay='EUROPEAN';
var f=new Date().toISOString(), u=new Date(Date.now()+14*86400000).toISOString();
var csR=await JT('sports/fo-match/v2/coming-soon?'+Q({sportCategoryId:62,language:lang,country:ctry,locale:lang,layout:lay,offset:0,timeFrame:'24',from:f,until:u}));
var cs={}; try{cs=JSON.parse(csR.t)}catch(e){}
var ms=(cs&&cs.category&&cs.category.matches)||[];
var pre=null, live=null;
for(var i=0;i<ms.length;i++){if(!ms[i].inplay&&!pre)pre=ms[i]; if(ms[i].inplay&&!live)live=ms[i];}
var dumpOutcome=function(m){if(!m||!m.markets||!m.markets[0])return null;var mk=m.markets[0];return {match:m.name,inplay:m.inplay,market:mk.name,market_type_id:mk.market_type_id,outcome0:mk.outcomes&&mk.outcomes[0],oddsHits:JSON.stringify(mk).match(/"[a-z_]*(odds|price|value)":[0-9.]+/gi)}};
out.prematch=dumpOutcome(pre);
out.live=dumpOutcome(live);
var oc=(pre&&pre.markets&&pre.markets[0]&&pre.markets[0].outcomes&&pre.markets[0].outcomes[0])||(live&&live.markets&&live.markets[0]&&live.markets[0].outcomes&&live.markets[0].outcomes[0]);
var ocId=oc&&oc.id, mId=(pre||live)&&(pre||live).id;
out.probe_outcomeId=ocId; out.probe_matchId=mId;
var cand=[
  ['GET','sports/fo-betslip?'+Q({outcomeIds:ocId,language:lang,country:ctry,layout:lay})],
  ['GET','sports/betslip?'+Q({outcomeIds:ocId,language:lang,country:ctry,layout:lay})],
  ['POST','sports/fo-betslip',JSON.stringify({outcome_ids:[ocId],country:ctry,language:lang,layout:lay})],
  ['POST','sports/betslip/validate',JSON.stringify({outcomes:[{id:ocId}],country:ctry})],
  ['GET','sports/fo-outcome?'+Q({outcomeIds:ocId,country:ctry,language:lang})],
  ['GET','sports/trading-position?'+Q({outcomeIds:ocId,country:ctry})],
  ['GET','sports/fo-match/v2/coming-soon?'+Q({sportCategoryId:62,language:lang,country:ctry,locale:lang,layout:lay,offset:0,timeFrame:'24',from:f,until:u,includeOdds:true})]
];
out.probes=[];
for(var c=0;c<cand.length;c++){var m=cand[c][0],p=cand[c][1],b=cand[c][2];
  var opt=m==='POST'?{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:b}:H;
  var r=await JT(p,opt);
  var hits=r.t.match(/"[a-z_]*(odds|price|value)":[0-9]+\\.[0-9]+/gi);
  out.probes.push({m:m,path:p.split('?')[0],status:r.s,len:r.t.length,oddsHits:hits?hits.slice(0,6):null,head:hits?null:r.t.slice(0,120)});
}
return JSON.stringify(out);`;

  const scenario = [{ wait: 9000 }, { execute: { script: execScript } }];
  const sUrl = scrapflyUrl({ js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url") });
  let execResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { status, text } = await get(sUrl);
    const j = safeJson(text);
    const steps = j?.result?.browser_data?.js_scenario?.steps || j?.result?.browser_data?.js_scenario || null;
    if (Array.isArray(steps)) for (const st of steps) if (st?.result != null) execResult = typeof st.result === "string" ? st.result : JSON.stringify(st.result);
    results.attempts = results.attempts || [];
    results.attempts.push({ attempt, http: status, scrapflyStatus: j?.result?.status_code, execLen: execResult?.length || 0, msg: j?.message ? String(j.message).slice(0, 150) : null });
    console.log(`[tree-recon] attempt ${attempt} → http=${status} execLen=${execResult?.length || 0}`);
    if (execResult && execResult.length > 30) break;
    await new Promise((r) => setTimeout(r, 8000));
  }
  results.exec = execResult ? safeJson(execResult) || execResult : null;
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
