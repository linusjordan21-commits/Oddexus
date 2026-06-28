#!/usr/bin/env node
/**
 * Diagnos: soccer bulk markets/straight ger 403 (för stort svar). Testar vilken
 * FINKORNIGARE endpoint som funkar (per-liga / per-match) så vi kan bygga rätt
 * fallback. Kör via Mullvad:
 *   ip netns exec mv node scripts/probe-pinnacle-markets.mjs
 */
const BASE = "https://guest.api.arcadia.pinnacle.com";
const SITE = "https://www.pinnacle.com";
const KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";
const HEADERS = {
  accept: "application/json",
  "x-api-key": KEY,
  origin: SITE,
  referer: `${SITE}/`,
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
const SOCCER = 29;

async function hit(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    const ms = Date.now() - t0;
    const body = await r.text();
    let n = "?";
    try { const j = JSON.parse(body); n = Array.isArray(j) ? j.length : (j?.length ?? Object.keys(j).length); } catch {}
    return { status: r.status, ms, bytes: body.length, n, bodyHead: body.slice(0, 120) };
  } catch (e) { return { status: "ERR", ms: Date.now() - t0, err: String(e).slice(0, 80) }; }
}
const log = (label, r) => console.log(`  ${label.padEnd(48)} → ${String(r.status).padEnd(5)} ${r.ms}ms  ${r.bytes ?? "?"}b  n=${r.n}  ${r.status >= 400 || r.status === "ERR" ? (r.bodyHead || r.err || "") : ""}`);

async function main() {
  console.log("[probe] 1) hämtar soccer matchups för id:er …");
  const m = await hit(`/0.1/sports/${SOCCER}/matchups`);
  log("GET /sports/29/matchups", m);
  let matchupId = null, leagueId = null;
  try {
    const j = await (await fetch(`${BASE}/0.1/sports/${SOCCER}/matchups`, { headers: HEADERS })).json();
    const first = (Array.isArray(j) ? j : []).find((x) => x?.id && x?.league?.id);
    matchupId = first?.id; leagueId = first?.league?.id;
    console.log(`     → matchupId=${matchupId}  leagueId=${leagueId} (${first?.league?.name})`);
  } catch (e) { console.log("     kunde ej parsa matchups:", String(e).slice(0, 60)); }

  console.log("\n[probe] 2) testar markets-granulariteter:");
  log("GET /sports/29/markets/straight  (bulk, väntat 403)", await hit(`/0.1/sports/${SOCCER}/markets/straight`));
  if (leagueId) {
    log(`GET /leagues/${leagueId}/markets/straight`, await hit(`/0.1/leagues/${leagueId}/markets/straight`));
  }
  if (matchupId) {
    log(`GET /matchups/${matchupId}/markets/straight`, await hit(`/0.1/matchups/${matchupId}/markets/straight`));
    log(`GET /matchups/${matchupId}/markets`, await hit(`/0.1/matchups/${matchupId}/markets`));
  }
  // ev. query-param för att krympa bulk
  log("GET /sports/29/markets/straight?primaryOnly=true", await hit(`/0.1/sports/${SOCCER}/markets/straight?primaryOnly=true`));
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
