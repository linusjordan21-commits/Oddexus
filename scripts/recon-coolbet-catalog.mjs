/**
 * recon-coolbet-catalog.mjs — ENGÅNGS-rekon v4: ger fo-category för ROTEN (62) alla
 * fotbollsmatcher i ETT anrop? Då blir struktur-hämtningen ett enda fetch.
 * Rapport → data/_coolbet-catalog-recon.json. ENDAST dispatch. Secret: SCRAPER_API_KEY.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const DATA_DIR = path.resolve(process.cwd(), "data");
const OUT = path.join(DATA_DIR, "_coolbet-catalog-recon.json");
const FOOTBALL_PAGE = "https://www.coolbet.com/sv/odds/fotboll";

function scrapflyUrl(scenario, pageUrl = FOOTBALL_PAGE) {
  const p = new URLSearchParams({
    key: KEY, url: pageUrl, render_js: "true", asp: "true", country: "se",
    rendering_wait: "6000", timeout: "90000", retry: "false",
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

const STEP = `
var base='https://www.coolbet.com/s/sbgate/';
var Q='country=SE&isMobile=0&language=sv&layout=EUROPEAN&matchTypeFilter=all';
function collect(node,acc){if(!node||typeof node!=='object')return;if(Array.isArray(node.matches))node.matches.forEach(function(m){acc.push(m)});if(Array.isArray(node.categories))node.categories.forEach(function(c){collect(c,acc)});if(Array.isArray(node))node.forEach(function(c){collect(c,acc)});}
async function tryRoot(limit){try{var url=base+'sports/fo-category/?categoryId=62&limit='+limit+'&'+Q;var j=await fetch(url,{headers:{accept:'application/json'}}).then(function(r){return r.json()});var acc=[];collect(j.categories||[],acc);var cats={};acc.forEach(function(m){if(m.category_id!=null)cats[m.category_id]=(cats[m.category_id]||0)+1;});return {limit:limit,matches:acc.length,distinctCategories:Object.keys(cats).length,respKeys:Object.keys(j).slice(0,8)};}catch(e){return{limit:limit,err:String(e).slice(0,120)}}}
var o={};
try{
  o.root200=await tryRoot(200);
  o.root1000=await tryRoot(1000);
}catch(e){o.err=String(e&&e.stack||e).slice(0,200);}
return JSON.stringify(o);`;

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!KEY) { fs.writeFileSync(OUT, JSON.stringify({ err: "SCRAPER_API_KEY saknas" }, null, 2) + "\n"); console.error("ingen nyckel"); return; }
  const scenario = [{ wait: 6000 }, { execute: { script: STEP, timeout: 14000 } }];
  const { status, json, text } = await getJson(scrapflyUrl(scenario));
  const steps = json?.result?.browser_data?.js_scenario?.steps;
  const sr = Array.isArray(steps) ? steps.filter((s) => s?.result != null).map((s) => s.result) : [];
  let s = null;
  for (const r of sr) { try { const p = JSON.parse(r); if (p.root200 !== undefined || p.err !== undefined) s = p; } catch { /* */ } }
  const out = { ranAt: new Date().toISOString(), scrapflyStatus: status, step: s, rawHead: s ? null : (text || "").slice(0, 300) };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log("[recon v4] status", status, "root200", s?.root200?.matches, "root1000", s?.root1000?.matches);
}
main().catch((e) => { console.error("fel:", e); fs.writeFileSync(OUT, JSON.stringify({ err: String(e?.message ?? e) }, null, 2) + "\n"); process.exit(1); });
