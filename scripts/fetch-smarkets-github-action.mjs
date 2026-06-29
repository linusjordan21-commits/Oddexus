#!/usr/bin/env node
/**
 * Smarkets odds-scraper (betting-BÖRS) — GitHub Actions.
 *
 * Verifierat via probe 2026-06-14:
 *   - Öppet API (ingen auth), funkar från datacenter-IP (ingen VPN behövs).
 *   - Matcher: GET /v3/events/?type_scope=single_event&type_domain={domain}
 *       &state=upcoming&sort=start_datetime,id  → events med id, name "A vs B",
 *       type, bettable, parent_id (liga), start_datetime.
 *   - Marknader: GET /v3/events/{id}/markets/ → "Full-time result" (fotboll 1X2),
 *       moneyline/"Winner" (tennis 2-vägs).
 *   - Utfall: GET /v3/markets/{id}/contracts/ → namn matchas mot lagnamn + "Draw".
 *   - Priser: GET /v3/markets/{id}/quotes/ → per contract { bids, offers }.
 *       offers = priser vi kan BACKA på. decimal-odds = 10000 / price.
 *
 * Smarkets är en börs: ~2% KOMMISSION på nettovinst. Vi sparar RÅ back-odds +
 * commission i payloaden; backend applicerar kommissionen när EV räknas (så att
 * kunder aldrig ser falsk +EV). Effektivt odds = 1 + (rå − 1) × (1 − commission).
 *
 * Output: data/smarkets-rows.json. Speglas till Supabase via scrape-guard.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteString } from "./lib/scrape-guard.mjs";

const BASE = "https://api.smarkets.com/v3";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;            // hög parallellism för full täckning per sport
const LOOKAHEAD_HOURS = 168;      // 7 dygn — MAX (medvetet val). Vi tittar aldrig
                                  // längre fram än så; inom fönstret tar vi ALLA
                                  // matcher med odds (batchning gör att inga tappas
                                  // till rate-limit). Mätning 2026-06-15: ~98 fotboll
                                  // inom 7 dygn → i praktiken full täckning.
const MAX_EVENTS_PER_SPORT = 400; // tak per sport — endast 3 sporter → råd att täcka brett
const COMMISSION = Number(process.env.SMARKETS_COMMISSION) || 0.02;

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "smarkets-rows.json");

// Smarkets är BARA en lay-sida (vi valuebettar aldrig på börsen) → vi behöver
// bara de sporter dina andra spelbolag erbjuder: fotboll, basket, tennis. Målet
// är att täcka ALLA deras matcher så att bonus/uttags-matchningen får så många
// alternativ som möjligt (fler alternativ = bättre lay-odds = mer +EV).
// 2-vägs = ingen oavgjort (moneyline). 3-vägs = 1X2. marketNames matchas mot
// marknadsnamnet (case-insensitive).
const TWO_WAY = [/moneyline/i, /match odds/i, /winner/i, /to win/i, /money line/i];
const THREE_WAY = [/full-?time result/i, /match odds/i, /1x2/i, /to win\b/i];
// Linje-marknader (fotboll): Smarkets modellerar VARJE linje som en EGEN marknad
// ("Over/Under 2.5", "Asian Handicap -0.5") → vi samlar alla och bygger en stege.
const TOTALS_NAMES = [/over\s*\/?\s*under/i, /total goals?/i, /goals over\/under/i];
const AH_NAMES = [/asian handicap/i, /asian line/i];
const MAX_LINE_MARKETS_PER_EVENT = 12; // tak per typ → bounded extra-anrop
let SMARKETS_LINE_DIAG_LOGGED = false;

/** Första (tecknade) talet i en sträng, t.ex. "Over 2.5" → 2.5, "Home -0.5" → -0.5. */
function numFrom(s) { const m = String(s || "").match(/[-+]?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; }
const SPORTS = [
  { key: "soccer",     domain: "football",   twoWay: false, marketNames: THREE_WAY },
  { key: "basketball", domain: "basketball", twoWay: true,  marketNames: TWO_WAY },
  { key: "tennis",     domain: "tennis",     twoWay: true,  marketNames: TWO_WAY },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function get(pathQ) {
  const url = pathQ.startsWith("http") ? pathQ : `${BASE}${pathQ}`;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok) return { status: r.status, json: null };
    return { status: r.status, json: await r.json() };
  } catch (e) {
    return { status: null, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Begränsad parallell-map. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function readPreviousPayload() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  } catch { return null; }
}

/** "Team A vs Team B" → { home, away }. */
function splitName(name) {
  const m = String(name || "").match(/^(.*?)\s+(?:vs\.?|v\.?|–|-|@)\s+(.*)$/i);
  if (!m) return null;
  return { home: m[1].trim(), away: m[2].trim() };
}

/** Hämta alla upcoming-matcher för en sport (paginerat). */
async function fetchEvents(domain) {
  const byId = new Map();
  let url = `/events/?type_scope=single_event&type_domain=${domain}&state=upcoming&sort=start_datetime,id&limit=100`;
  for (let page = 0; page < 12 && url; page++) {
    const r = await get(url);
    if (r.status !== 200 || !r.json) break;
    if (page === 0) console.log(`[smarkets] ${domain} pagination keys:`, JSON.stringify(r.json.pagination || null));
    const batch = Array.isArray(r.json.events) ? r.json.events : [];
    const before = byId.size;
    for (const e of batch) if (e.bettable === true && e.id != null) byId.set(String(e.id), e);
    const added = byId.size - before;
    // Smarkets v3 cursor-paginering: pagination.next_page är en RÅ query-sträng
    // ("?state=...&pagination_last_id=..."). Den hör till SAMMA endpoint, så
    // den måste prefixas med "/events/" — inte bara "/" (då tappas sökvägen och
    // sidan blir tom). Detta var buggen som låste oss vid 100 event/sport.
    const next = r.json.pagination?.next_page || null;
    if (!next) { url = null; }
    else if (next.startsWith("http")) { url = next; }
    else if (next.startsWith("?")) { url = `/events/${next}`; }
    else if (next.startsWith("/")) { url = next; }
    else { url = `/events/?${next}`; }
    if (added === 0) break;                       // inga nya event → slut på data
    if (byId.size >= MAX_EVENTS_PER_SPORT) break;
    await sleep(150);
  }
  return Array.from(byId.values()).slice(0, MAX_EVENTS_PER_SPORT);
}

/** Bästa back-odds (decimal) per contract ur quotes. offers = backbara priser. */
function bestBackDecimal(quote) {
  const offers = Array.isArray(quote?.offers) ? quote.offers : [];
  let best = null; // lägsta price = högsta decimal-odds = bäst för backaren
  for (const o of offers) {
    if (typeof o?.price === "number" && o.price > 0 && (best === null || o.price < best)) best = o.price;
  }
  return best === null ? null : 10000 / best;
}

/** Bästa LAY-odds (decimal) per contract. bids = back-ordrar från andra = de
 *  priser DU kan laya på. Bäst lay = lägsta decimal-odds = HÖGSTA price (minst
 *  liability). decimal = 10000 / price. */
function bestLayDecimal(quote) {
  const bids = Array.isArray(quote?.bids) ? quote.bids : [];
  let best = null; // högsta price = lägsta decimal = bäst för layaren
  for (const b of bids) {
    if (typeof b?.price === "number" && b.price > 0 && (best === null || b.price > best)) best = b.price;
  }
  return best === null ? null : 10000 / best;
}

/** Diagnostik-tratt PER SPORT: var tappas matcher? Loggas i main(). */
const funnelBySport = {};
function fnl(key) {
  return (funnelBySport[key] ??= { events: 0, outOfWindow: 0, noMarket: 0, noOdds: 0, ok: 0 });
}

// Batch-storlekar. Smarkets stöder komma-separerade id:n på events/markets,
// markets/contracts och markets/quotes (verifierat). Det kollapsar ~3 anrop per
// match till ~3 anrop per CHUNK → vi slipper 429 (rate-limit) som tidigare
// kapade oss vid ~17 matcher.
const MARKETS_CHUNK = 20;   // event-id per /events/{ids}/markets/
const ODDS_CHUNK = 30;      // market-id per /markets/{ids}/{contracts,quotes}/

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

/** get() med backoff vid 429 (rate-limit). */
async function getRetry(pathQ, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await get(pathQ);
    if (r.status !== 429) return r;
    await sleep(700 * (i + 1));
  }
  return get(pathQ);
}

/** Utfalls-slot (home/draw/away) från contract: slug → contract_type → display_order. */
function slotFromContract(c, idx, twoWay) {
  const slug = String(c.slug || "").toLowerCase();
  const ct = String(c.contract_type?.name || "").toUpperCase();
  if (slug === "home" || ct === "HOME") return "home";
  if (slug === "draw" || ct === "DRAW" || ct === "TIE") return "draw";
  if (slug === "away" || ct === "AWAY") return "away";
  if (ct === "PLAYER_A") return "home";
  if (ct === "PLAYER_B") return "away";
  return (twoWay ? ["home", "away"] : ["home", "draw", "away"])[idx] || null;  // fallback
}

/** Parsa en Smarkets O/U-marknad → {line, over, under} (back-odds). Null om osäker. */
function parseSmarketsTotals(market, contracts, quoteByContract) {
  let over = null, under = null, line = null;
  for (const c of contracts) {
    const t = `${c.slug || ""} ${c.contract_type?.name || ""} ${c.name || ""}`.toLowerCase();
    const b = bestBackDecimal(quoteByContract.get(String(c.id)));
    if (b == null) continue;
    if (/\bover\b/.test(t)) { over = b; if (line == null) line = numFrom(c.name); }
    else if (/\bunder\b/.test(t)) { under = b; if (line == null) line = numFrom(c.name); }
  }
  if (line == null) line = numFrom(market.name);
  return over > 1 && under > 1 && Number.isFinite(line) ? { line, over, under } : null;
}

/** Parsa en Smarkets AH-marknad → {line, home, away} ur HEMMA-perspektiv. Null om osäker. */
function parseSmarketsAh(market, contracts, quoteByContract, homeTeam, awayTeam) {
  let home = null, away = null, homeLine = null;
  const hKey = String(homeTeam || "").toLowerCase().slice(0, 6);
  const aKey = String(awayTeam || "").toLowerCase().slice(0, 6);
  for (const c of contracts) {
    const slug = String(c.slug || "").toLowerCase();
    const ct = String(c.contract_type?.name || "").toUpperCase();
    const nm = String(c.name || "").toLowerCase();
    const b = bestBackDecimal(quoteByContract.get(String(c.id)));
    if (b == null) continue;
    const isHome = slug === "home" || ct === "HOME" || ct === "PLAYER_A" || (hKey && nm.includes(hKey));
    const isAway = slug === "away" || ct === "AWAY" || ct === "PLAYER_B" || (aKey && nm.includes(aKey));
    if (isHome && !isAway) { home = b; if (homeLine == null) homeLine = numFrom(c.name); }
    else if (isAway && !isHome) { away = b; }
  }
  if (homeLine == null) homeLine = numFrom(market.name);
  return home > 1 && away > 1 && Number.isFinite(homeLine) ? { line: homeLine, home, away } : null;
}

/** Bygg ALLA odds-rader för en sport via batchade anrop (rate-limit-säkert). */
async function buildSportRows(sport, events) {
  const funnel = fnl(sport.key);
  const now = Date.now();
  const inWin = events.filter((ev) => {
    funnel.events++;
    const t = Date.parse(ev.start_datetime);
    if (!Number.isFinite(t) || t < now || t > now + LOOKAHEAD_HOURS * 3600_000) { funnel.outOfWindow++; return false; }
    return true;
  });

  // 1) Batch markets per event → välj 1X2/winner-marknad per event. För fotboll
  // samlar vi ÄVEN alla O/U- och AH-marknader (en per linje) → linje-stegar.
  const isLive = (m) => m.state !== "settled" && m.state !== "cancelled" && m.state !== "voided";
  const wantLines = sport.key === "soccer";
  const marketByEvent = new Map();
  const totalsMarketsByEvent = new Map();
  const ahMarketsByEvent = new Map();
  for (const ids of chunk(inWin.map((e) => String(e.id)), MARKETS_CHUNK)) {
    const r = await getRetry(`/events/${ids.join(",")}/markets/`);
    const markets = Array.isArray(r.json?.markets) ? r.json.markets : [];
    const byEvent = new Map();
    for (const m of markets) { const eid = String(m.event_id); (byEvent.get(eid) || byEvent.set(eid, []).get(eid)).push(m); }
    for (const eid of ids) {
      const all = byEvent.get(eid) || [];
      const cand = all.filter((m) => isLive(m) && sport.marketNames.some((re) => re.test(m.name || "")));
      const chosen = cand.find((m) => m.state === "open") || cand[0];
      if (chosen) marketByEvent.set(eid, chosen); else funnel.noMarket++;
      if (wantLines) {
        const tot = all.filter((m) => isLive(m) && TOTALS_NAMES.some((re) => re.test(m.name || ""))).slice(0, MAX_LINE_MARKETS_PER_EVENT);
        const ah = all.filter((m) => isLive(m) && AH_NAMES.some((re) => re.test(m.name || ""))).slice(0, MAX_LINE_MARKETS_PER_EVENT);
        if (tot.length) totalsMarketsByEvent.set(eid, tot);
        if (ah.length) ahMarketsByEvent.set(eid, ah);
        // OVILLKORLIG kalibrerings-diagnostik för FÖRSTA eventet med marknader:
        // logga ALLA marknadsnamn så vi ser om/under vilket namn O/U + AH ligger
        // (eller om Smarkets-börsen helt enkelt saknar dem för fotboll).
        if (!SMARKETS_LINE_DIAG_LOGGED && all.length) {
          SMARKETS_LINE_DIAG_LOGGED = true;
          console.log(`[smarkets] LINJE-DIAG eid=${eid}: matchade totals=${tot.length} ah=${ah.length}; ALLA marknadsnamn=${JSON.stringify([...new Set(all.map((m) => m.name))].slice(0, 40))}`);
        }
      }
    }
    await sleep(100);
  }

  // BUDGET-TAK: linje-marknaderna (O/U + AH) kräver extra contracts/quotes-anrop
  // i steg 2. Att hämta dem för ALLA events stallade loopen (~20 min). Begränsa
  // därför till de SMARKETS_LINES_MAX NÄRMAST avsparkade matcherna — bäst-
  // ansträngning som aldrig rör 1X2 (som hämtas för alla events oavsett).
  const LINES_MAX = Number(process.env.SMARKETS_LINES_MAX ?? 20);
  if (wantLines && LINES_MAX > 0 && (totalsMarketsByEvent.size || ahMarketsByEvent.size)) {
    const nowMs = Date.now();
    const nearest = new Set(
      inWin
        .filter((e) => e.start_datetime && Date.parse(e.start_datetime) > nowMs)
        .sort((a, b) => Date.parse(a.start_datetime) - Date.parse(b.start_datetime))
        .slice(0, LINES_MAX)
        .map((e) => String(e.id)),
    );
    for (const eid of [...totalsMarketsByEvent.keys()]) if (!nearest.has(eid)) totalsMarketsByEvent.delete(eid);
    for (const eid of [...ahMarketsByEvent.keys()]) if (!nearest.has(eid)) ahMarketsByEvent.delete(eid);
    console.log(`[smarkets] linje-budget: ${totalsMarketsByEvent.size} events med totals + ${ahMarketsByEvent.size} med AH (tak ${LINES_MAX} närmast)`);
  }

  // 2) Batch contracts + quotes för de valda marknaderna + linje-marknaderna.
  const lineMarketIds = wantLines
    ? [...totalsMarketsByEvent.values(), ...ahMarketsByEvent.values()].flat().map((m) => String(m.id))
    : [];
  const marketIds = [...new Set([...[...marketByEvent.values()].map((m) => String(m.id)), ...lineMarketIds])];
  const contractsByMarket = new Map();
  const quoteByContract = new Map();
  for (const ids of chunk(marketIds, ODDS_CHUNK)) {
    const [cR, qR] = await Promise.all([
      getRetry(`/markets/${ids.join(",")}/contracts/`),
      getRetry(`/markets/${ids.join(",")}/quotes/`),
    ]);
    for (const c of (cR.json?.contracts || [])) { const mid = String(c.market_id); (contractsByMarket.get(mid) || contractsByMarket.set(mid, []).get(mid)).push(c); }
    for (const [cid, v] of Object.entries(qR.json || {})) quoteByContract.set(String(cid), v);
    await sleep(100);
  }

  // 3) Bygg rader.
  const rows = [];
  for (const ev of inWin) {
    const market = marketByEvent.get(String(ev.id));
    if (!market) continue;
    const contracts = contractsByMarket.get(String(market.id)) || [];
    if (contracts.length === 0) { funnel.noMarket++; continue; }

    const ordered = [...contracts].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    const slotOf = {};
    const nameOf = {};
    ordered.forEach((c, i) => {
      const slot = slotFromContract(c, i, sport.twoWay);
      if (slot && !(slot in nameOf)) { slotOf[c.id] = slot; nameOf[slot] = c.name; }
    });
    // Lagnamn från contracts (robust mot "A vs B"/"A at B"/"A @ B"); fallback titel.
    const sides = splitName(ev.name);
    const homeTeam = nameOf.home || sides?.home || ev.name;
    const awayTeam = nameOf.away || sides?.away || "";

    const back = {};
    const lay = {};
    for (const c of contracts) {
      const slot = slotOf[c.id];
      if (!slot) continue;
      const q = quoteByContract.get(String(c.id));
      const b = bestBackDecimal(q);
      const l = bestLayDecimal(q);
      if (b != null) back[slot] = b;
      if (l != null) lay[slot] = l;
    }
    const slots = sport.twoWay ? ["home", "away"] : ["home", "draw", "away"];
    const layCount = slots.filter((s) => lay[s] != null).length;
    const backCount = slots.filter((s) => back[s] != null).length;
    // Behåll event med MINST ett pris på någon sida. Tidigare `layCount<1 && backCount<2`
    // slängde ~169 giltiga tennis-events (2-vägs) med asymmetrisk börs-likviditet — coverage-
    // audit 2026-06-29. Börs har normalt partiell depth; används som confirmation, downstream
    // tål partiell likviditet. Endast helt pris-lösa event filtreras nu bort.
    if (layCount === 0 && backCount === 0) { funnel.noOdds++; continue; }

    funnel.ok++;
    const row = {
      eventId: String(ev.id),
      sport: sport.key,
      league: ev.parent_id ? String(ev.parent_id) : null,
      homeTeam,
      awayTeam,
      title: ev.name,
      startTime: ev.start_datetime,
      odds: sport.twoWay ? { home: back.home, away: back.away } : { home: back.home, draw: back.draw, away: back.away },
      layOdds: sport.twoWay ? { home: lay.home ?? null, away: lay.away ?? null } : { home: lay.home ?? null, draw: lay.draw ?? null, away: lay.away ?? null },
    };
    // Fotboll: bygg O/U- och AH-stegar ur de extra marknaderna (back-odds).
    if (wantLines) {
      const totals = (totalsMarketsByEvent.get(String(ev.id)) || [])
        .map((m) => parseSmarketsTotals(m, contractsByMarket.get(String(m.id)) || [], quoteByContract))
        .filter(Boolean);
      const ah = (ahMarketsByEvent.get(String(ev.id)) || [])
        .map((m) => parseSmarketsAh(m, contractsByMarket.get(String(m.id)) || [], quoteByContract, homeTeam, awayTeam))
        .filter(Boolean);
      if (totals.length) row.totals = totals;
      if (ah.length) row.ah = ah;
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  const start = Date.now();
  const previous = readPreviousPayload();
  const allRows = [];
  const countsBySport = {};
  const eventsBySport = {};

  for (const sport of SPORTS) {
    const events = await fetchEvents(sport.domain);
    const rows = await buildSportRows(sport, events);
    countsBySport[sport.key] = rows.length;
    eventsBySport[sport.key] = events.length;
    console.log(`[smarkets] ${sport.key}: ${events.length} event → ${rows.length} rader med odds`);
    allRows.push(...rows);
  }

  console.log(`[smarkets] events: ${JSON.stringify(eventsBySport)}`);
  console.log(`[smarkets] counts: ${JSON.stringify(countsBySport)}`);
  console.log(`[smarkets] funnel: ${JSON.stringify(funnelBySport)}`);

  // Bakåtkompatibla vyer (äldre backend läser footballRows/tennisRows).
  const footballRows = allRows.filter((r) => r.sport === "soccer");
  const tennisRows = allRows.filter((r) => r.sport === "tennis");

  if (allRows.length === 0 && previous) {
    console.warn("[smarkets] 0 rader — behåller föregående fil orörd (trolig transient).");
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "github-actions",
    bookmaker: "smarkets",
    displayName: "Smarkets",
    isExchange: true,
    commission: COMMISSION,
    blocked: false,
    lastError: null,
    totalDurationMs: Date.now() - start,
    countsBySport,
    eventsBySport,        // diagnostik: hur många event Smarkets returnerade per sport
    funnelBySport,        // diagnostik: var matcher tappas per sport (noMarket vs noOdds)
    rows: allRows,        // ALLA sporter (varje rad bär .sport)
    footballRows,         // bakåtkompat
    tennisRows,           // bakåtkompat
  };
  atomicWriteString(OUTPUT_FILE, JSON.stringify(payload));
  console.log(`[smarkets] skrev ${OUTPUT_FILE}: ${allRows.length} rader totalt över ${SPORTS.length} sporter (commission ${COMMISSION})`);
}

main().catch((e) => {
  console.error("[smarkets] fatal:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
