#!/usr/bin/env node
/**
 * Smarkets DIAGNOS-probe (engångs, manuell). Svarar på: varför hittar scrapern
 * bara ~17 fotbollsmatcher när sajten visar 100+ med likviditet?
 *
 * Loggar (ingen data skrivs):
 *  1. Hur många upcoming football-event API:t returnerar totalt (alla sidor).
 *  2. Hur många som ligger inom 7 dygn.
 *  3. För de första ~25 inom fönstret: namn, start, ALLA marknader (namn+state),
 *     och för vald marknad: contracts + RÅ quotes (bids/offers) → ser exakt var
 *     odds tappas.
 *  4. RÅ JSON-dump för FÖRSTA eventets markets + quotes (struktur-sanity).
 */

const BASE = "https://api.smarkets.com/v3";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const LOOKAHEAD_HOURS = 168;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function get(pathQ) {
  const url = pathQ.startsWith("http") ? pathQ : `${BASE}${pathQ}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { status: r.status, json: null };
    return { status: r.status, json: await r.json() };
  } catch (e) {
    return { status: null, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function splitName(name) {
  const m = String(name || "").match(/^(.*?)\s+(?:vs\.?|v\.?|–|-|@)\s+(.*)$/i);
  return m ? { home: m[1].trim(), away: m[2].trim() } : null;
}

async function fetchAllEvents(domain) {
  const byId = new Map();
  let url = `/events/?type_scope=single_event&type_domain=${domain}&state=upcoming&sort=start_datetime,id&limit=100`;
  for (let page = 0; page < 20 && url; page++) {
    const r = await get(url);
    if (r.status !== 200 || !r.json) { console.log(`  [page ${page}] HTTP ${r.status} — stop`); break; }
    const batch = Array.isArray(r.json.events) ? r.json.events : [];
    const before = byId.size;
    for (const e of batch) if (e.id != null) byId.set(String(e.id), e);
    const added = byId.size - before;
    const next = r.json.pagination?.next_page || null;
    if (!next) { url = null; }
    else if (next.startsWith("http")) url = next;
    else if (next.startsWith("?")) url = `/events/${next}`;
    else if (next.startsWith("/")) url = next;
    else url = `/events/?${next}`;
    if (added === 0) break;
  }
  return Array.from(byId.values());
}

function bestBack(q) {
  const o = Array.isArray(q?.offers) ? q.offers : [];
  let b = null; for (const x of o) if (typeof x?.price === "number" && x.price > 0 && (b === null || x.price < b)) b = x.price;
  return b === null ? null : +(10000 / b).toFixed(3);
}
function bestLay(q) {
  const o = Array.isArray(q?.bids) ? q.bids : [];
  let b = null; for (const x of o) if (typeof x?.price === "number" && x.price > 0 && (b === null || x.price > b)) b = x.price;
  return b === null ? null : +(10000 / b).toFixed(3);
}

async function batchTests(domain) {
  console.log(`\n##### BATCH-TESTER (${domain}) — minimera anrop p.g.a. 429-rate-limit #####`);
  const evRes = await get(`/events/?type_scope=single_event&type_domain=${domain}&state=upcoming&sort=start_datetime,id&limit=10`);
  const evs = (evRes.json?.events || []).filter((e) => e.bettable === true).slice(0, 4);
  console.log(`testar med ${evs.length} event: ${evs.map((e) => e.id).join(",")}`);

  // TEST A: /events/{id1,id2,...}/markets/ — batchad markets per event?
  const evIds = evs.map((e) => e.id).join(",");
  const aMk = await get(`/events/${evIds}/markets/`);
  const aMarkets = aMk.json?.markets || [];
  console.log(`A) /events/{ids}/markets/ → HTTP ${aMk.status}; markets=${aMarkets.length}; har market_id-fält? ${aMarkets[0] ? ("event_id" in aMarkets[0] || "type_id" in aMarkets[0]) : "-"}; exempel:`, JSON.stringify(aMarkets.slice(0, 2).map((m) => ({ id: m.id, name: m.name, event_id: m.event_id }))));

  // Välj 1X2/winner-marknad per event ur batchen.
  const nameRe = [/full-?time result/i, /match odds/i, /1x2/i, /moneyline/i, /winner/i, /to win/i];
  const chosen = aMarkets.filter((m) => m.state === "open" && nameRe.some((re) => re.test(m.name || "")));
  const mIds = [...new Set(chosen.map((m) => m.id))].slice(0, 4);
  console.log(`valda marknads-id (batch): ${mIds.join(",")}`);

  // TEST B: /markets/{id1,id2}/contracts/ — innehåller market_id för gruppering?
  const bC = await get(`/markets/${mIds.join(",")}/contracts/`);
  const bContracts = bC.json?.contracts || [];
  console.log(`B) /markets/{ids}/contracts/ → HTTP ${bC.status}; contracts=${bContracts.length}; har market_id? ${bContracts[0] ? ("market_id" in bContracts[0]) : "-"}; exempel:`, JSON.stringify(bContracts.slice(0, 3)));

  // TEST C: /markets/{id1,id2}/quotes/ — merged contract-keyed map?
  const cQ = await get(`/markets/${mIds.join(",")}/quotes/`);
  const qKeys = cQ.json ? Object.keys(cQ.json) : [];
  console.log(`C) /markets/{ids}/quotes/ → HTTP ${cQ.status}; antal contract-nycklar=${qKeys.length}; första värdet:`, JSON.stringify(cQ.json?.[qKeys[0]] || null).slice(0, 300));
  console.log(`##### SLUT BATCH-TESTER #####\n`);
}

async function countMode(domain) {
  console.log(`\n##### COUNT-MODE (${domain}) — full paginering, tidsfördelning #####`);
  const byId = new Map();
  let url = `/events/?type_scope=single_event&type_domain=${domain}&state=upcoming&sort=start_datetime,id&limit=100`;
  let pages = 0, nonBettablePages = 0;
  for (let page = 0; page < 60 && url; page++) {
    const r = await get(url);
    if (r.status !== 200 || !r.json) { console.log(`  stop @ page ${page} HTTP ${r.status}`); break; }
    pages++;
    const batch = Array.isArray(r.json.events) ? r.json.events : [];
    const before = byId.size;
    for (const e of batch) if (e.id != null) byId.set(String(e.id), e);  // ingen bettable-filtrering här
    if (byId.size === before) nonBettablePages++;
    const next = r.json.pagination?.next_page || null;
    if (!next) { url = null; }
    else if (next.startsWith("http")) url = next;
    else if (next.startsWith("?")) url = `/events/${next}`;
    else if (next.startsWith("/")) url = next;
    else url = `/events/?${next}`;
    await sleep(120);
  }
  const evs = [...byId.values()];
  const now = Date.now();
  const within = (days) => evs.filter((e) => { const t = Date.parse(e.start_datetime); return Number.isFinite(t) && t >= now && t <= now + days * 86400_000; }).length;
  const bettableWithin = (days) => evs.filter((e) => { const t = Date.parse(e.start_datetime); return e.bettable === true && Number.isFinite(t) && t >= now && t <= now + days * 86400_000; }).length;
  console.log(`hämtade ${pages} sidor, totalt ${evs.length} unika event (alla states)`);
  console.log(`bettable-fördelning: ${JSON.stringify(evs.reduce((a,e)=>{const k=String(e.bettable);a[k]=(a[k]||0)+1;return a;},{}))}`);
  for (const d of [2, 7, 14, 21, 30]) console.log(`  inom ${d} dygn: ${within(d)} event  (varav bettable: ${bettableWithin(d)})`);
  const last = evs.map((e) => e.start_datetime).sort().slice(-1)[0];
  console.log(`  senaste event-start i listan: ${last}`);
  console.log(`##### SLUT COUNT-MODE #####\n`);
}

async function main() {
  const domain = process.argv[2] || "football";
  console.log(`\n===== SMARKETS DIAGNOS: ${domain} =====`);

  if (process.argv[3] === "batch") { await batchTests(domain); return; }
  if (process.argv[3] === "count") { await countMode(domain); return; }

  const events = await fetchAllEvents(domain);
  const now = Date.now();
  const inWindow = events.filter((e) => {
    const t = Date.parse(e.start_datetime);
    return Number.isFinite(t) && t >= now && t <= now + LOOKAHEAD_HOURS * 3600_000;
  });
  const bettable = inWindow.filter((e) => e.bettable === true);
  console.log(`Totalt upcoming-event (alla sidor): ${events.length}`);
  console.log(`Inom 7 dygn: ${inWindow.length}`);
  console.log(`Inom 7 dygn OCH bettable===true: ${bettable.length}`);
  console.log(`(bettable-fördelning inom fönstret: ${JSON.stringify(inWindow.reduce((a,e)=>{const k=String(e.bettable);a[k]=(a[k]||0)+1;return a;},{}))})`);

  // RÅ struktur-dump för första in-window-eventet.
  if (inWindow[0]) {
    const ev = inWindow[0];
    console.log(`\n----- RÅ DUMP första event: "${ev.name}" (id ${ev.id}, start ${ev.start_datetime}) -----`);
    const mk = await get(`/events/${ev.id}/markets/`);
    console.log(`markets HTTP ${mk.status}; keys=${mk.json ? Object.keys(mk.json).join(",") : "-"}`);
    const markets = mk.json?.markets || [];
    console.log(`markets[] (${markets.length}):`, JSON.stringify(markets.map((m) => ({ id: m.id, name: m.name, state: m.state }))));
    if (markets[0]) {
      const qq = await get(`/markets/${markets[0].id}/quotes/`);
      console.log(`quotes HTTP ${qq.status}; top-level keys=${qq.json ? Object.keys(qq.json).slice(0,8).join(",") : "-"}`);
      console.log(`quotes RAW (klippt 800 tecken):`, JSON.stringify(qq.json).slice(0, 800));
      const cc = await get(`/markets/${markets[0].id}/contracts/`);
      console.log(`contracts keys=${cc.json ? Object.keys(cc.json).join(",") : "-"}; contracts[]:`, JSON.stringify((cc.json?.contracts || []).map((c) => ({ id: c.id, name: c.name, display_order: c.display_order }))));
    }
  }

  // Per-event sammanfattning för de första 25 inom fönstret.
  console.log(`\n----- FÖRSTA 25 INOM FÖNSTRET -----`);
  const sample = inWindow.slice(0, 25);
  const nameRe = [/full-?time result/i, /match odds/i, /1x2/i, /moneyline/i, /winner/i, /to win/i];
  for (const ev of sample) {
    const sides = splitName(ev.name);
    const mk = await get(`/events/${ev.id}/markets/`);
    const markets = mk.json?.markets || [];
    const live = markets.filter((m) => m.state !== "settled" && m.state !== "cancelled" && m.state !== "voided");
    const match = live.filter((m) => nameRe.some((re) => re.test(m.name || "")));
    const chosen = match.find((m) => m.state === "open") || match[0];
    let oddsStr = "—";
    if (chosen) {
      const [cc, qq] = await Promise.all([get(`/markets/${chosen.id}/contracts/`), get(`/markets/${chosen.id}/quotes/`)]);
      const contracts = cc.json?.contracts || [];
      const quotes = qq.json || {};
      oddsStr = contracts.map((c) => `${(c.name||"?").slice(0,10)}=B${bestBack(quotes[c.id])}/L${bestLay(quotes[c.id])}`).join("  ");
    }
    console.log(`• ${ev.name}${sides?"":" [SPLIT-FAIL]"} | start ${ev.start_datetime} | markets=${markets.length} matchande=${match.length} vald=${chosen?`"${chosen.name}"(${chosen.state})`:"INGEN"}`);
    console.log(`    odds: ${oddsStr}`);
  }
}

main().catch((e) => { console.error("probe fatal:", e); process.exitCode = 1; });
