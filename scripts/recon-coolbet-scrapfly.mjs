/**
 * recon-coolbet-scrapfly.mjs — Coolbet sbgate-odds via Scrapfly js_scenario.
 * Transporten är löst (js_scenario når sbgate förbi Imperva). coming-soon gav tomt
 * (/odds/fotboll visar LIGA-TRÄD först). ETT Scrapfly-anrop (spar credits/throttle)
 * som in-page hämtar: ligaträd (category/fo-tree/1) + coming-soon(weekend) + provar
 * match-listning per första liga + ev. match-detalj → full odds-JSON.
 *
 * Secret: SCRAPER_API_KEY (Scrapfly). Dump → data/_coolbet-sbgate-data.json (+recon).
 */

import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_coolbet-scrapfly-recon.json");
const DATA_OUT = path.resolve(process.cwd(), "data", "_coolbet-sbgate-data.json");
const ODDS_PAGE = "https://www.coolbet.com/sv/odds/fotboll";

function scrapflyUrl(extra = {}) {
  const p = new URLSearchParams({
    key: KEY, url: ODDS_PAGE, render_js: "true", asp: "true", country: "se",
    rendering_wait: "6000", proxy_pool: "public_residential_pool", format: "json", ...extra,
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
  const results = { ranAt: new Date().toISOString(), nonce: Math.floor(Date.now() / 1000), hasKey: !!KEY };
  if (!KEY) { results.error = "SCRAPER_API_KEY saknas."; fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n"); return; }

  // REST-test: prova ALLA timeFrame-värden för coming-soon (fotboll). Enkelt script
  // (ingen recursion → ingen 422). Hittar en timeFrame som ger matcher → REST-väg.
  // UPPTÄCKTS- + PRIS-PROBE i ETT Scrapfly-anrop:
  //  1) sport-träd (hitta fotbolls-kategori-id)
  //  2) svep sportCategoryId-kandidater för coming-soon → vilken ger matcher?
  //  3) betslip-info på första marknaden i funnen match → returnerar den ODDS?
  // PRIS-FÅNGST via Pusher: efter ~12s render har WS pushat priser in i sidan.
  // Läs av oddsen ur (a) DOM (decimal-odds-knappar) och (b) ev. global store-path
  // som bär oddsByOutcomeId. Returnera prov så vi vet var/hur priserna är läsbara.
  // STEG 2: hämta fullSlug ur katalogen + navigera SPA:n till match-sidan.
  const navScript = `
var base='https://www.coolbet.com/s/sbgate/';var H={headers:{accept:'application/json'}};
var f=new Date().toISOString(),u=new Date(Date.now()+10*86400000).toISOString();
var Q='language=sv&country=SE&locale=sv&layout=EUROPEAN';
var o={};
try{
var cs=await fetch(base+'sports/fo-match/v2/coming-soon?sportCategoryId=62&offset=0&timeFrame=24&from='+encodeURIComponent(f)+'&until='+encodeURIComponent(u)+'&'+Q,H).then(function(x){return x.json()});
var ms=(cs&&cs.category&&cs.category.matches)||[];
var m=null;for(var i=0;i<ms.length;i++){if(ms[i].fullSlug){m=ms[i];break;}}
if(!m)m=ms[0];
o.n=ms.length;o.slug=m?m.fullSlug:null;o.matchId=m?m.id:null;
if(m&&m.fullSlug){o.nav='https://www.coolbet.com/sv/odds/'+m.fullSlug;window.location.href=o.nav;}
}catch(e){o.err='ERR:'+e}
return JSON.stringify(o);`;
  // STEG 4: läs oddsByOutcomeId (nu förhoppningsvis fylld av Pusher på match-sidan).
  const readScript = `
function find(o,path,depth){if(depth>7||!o||typeof o!=='object')return null;for(var k in o){try{if(k==='oddsByOutcomeId'){var v=o[k];var st=(v&&typeof v==='object'&&'state' in v)?v.state:v;var keys=st&&typeof st==='object'?Object.keys(st):[];return {path:path+'.'+k,count:keys.length,sample:JSON.stringify(st).slice(0,1800)};}var r=find(o[k],path+'.'+k,depth+1);if(r)return r;}catch(e){}}return null;}
var o={url:location.href,title:document.title};
try{o.odds=find(window.stores,'stores',0);}catch(e){o.odds='ERR:'+e}
try{o.decimalCount=(document.body.innerText.match(/\\b\\d{1,2}\\.\\d{2}\\b/g)||[]).length;}catch(e){o.decimalCount=-1}
return JSON.stringify(o);`;
  const scenario = [{ wait: 4000 }, { execute: { script: navScript } }, { wait: 14000 }, { execute: { script: readScript } }];
  const sUrl = scrapflyUrl({ js_scenario: Buffer.from(JSON.stringify(scenario)).toString("base64url") });
  const stepResults = [];
  for (let attempt = 1; attempt <= 1; attempt += 1) {
    const { status, text } = await get(sUrl);
    const j = safeJson(text);
    const sc = j?.result?.browser_data?.js_scenario;
    const steps = Array.isArray(sc?.steps) ? sc.steps : [];
    for (const st of steps) if (st?.result != null) stepResults.push(typeof st.result === "string" ? st.result : JSON.stringify(st.result));
    results.diag = {
      http: status, pageStatus: j?.result?.status_code,
      scrapflyMessage: j?.message || j?.result?.error || null,
      steps: steps.map((s) => ({ action: s?.action, success: s?.success, resultHead: typeof s?.result === "string" ? s.result.slice(0, 400) : null })),
    };
    if (status !== 200 && !results.errBody) results.errBody = text.slice(0, 2500);
    console.log(`[scrapfly-recon] attempt ${attempt} → http=${status} stepResults=${stepResults.length}`);
  }
  results.navResult = stepResults[0] || null;   // fullSlug + nav
  results.oddsResult = stepResults[1] || null;  // oddsByOutcomeId efter navigation
  results.execHead = (stepResults.join(" || ")).slice(0, 6000);
  if (stepResults.length) fs.writeFileSync(DATA_OUT, stepResults.join("\n"));
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
