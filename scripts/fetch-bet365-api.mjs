#!/usr/bin/env node
/**
 * bet365-odds via BetsAPI (b365api.com) — ren HTTP-API, ingen Chromium/Mullvad.
 *
 * Flöde:
 *   1. GET /v4/bet365/upcoming?sport_id=1  → kommande fotbollsmatcher (FI, lag, tid)
 *   2. Per match: GET /v4/bet365/prematch?FI=...  → Full Time Result (1X2)
 *   3. Skriv data/bet365-rows.json i samma format som övriga källor:
 *        { updatedAt, source, events: [{ eventId, homeTeam, awayTeam, startTime, odds:{home,draw,away}, foundBy }] }
 *
 * Nyckel via env: BETSAPI_TOKEN (sätts på VPS:en, ALDRIG i kod/chatt).
 * Tuning via env: BET365_MAX_EVENTS (default 200), BET365_WINDOW_H (default 72),
 *                 BET365_CONCURRENCY (default 4), BET365_DEBUG=1 (dumpa struktur).
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.BETSAPI_TOKEN;
const BASE = "https://api.b365api.com/v4/bet365";
const SPORT_SOCCER = 1;
const MAX_EVENTS = Number(process.env.BET365_MAX_EVENTS ?? 200);
const WINDOW_H = Number(process.env.BET365_WINDOW_H ?? 72);
const CONCURRENCY = Number(process.env.BET365_CONCURRENCY ?? 4);
const DEBUG = process.env.BET365_DEBUG === "1";
const OUTPUT = path.resolve(process.cwd(), "data", "bet365-rows.json");

if (!TOKEN) {
  console.error("[bet365-api] FEL: BETSAPI_TOKEN saknas (sätt som miljövariabel).");
  process.exit(1);
}

const log = (...a) => console.log("[bet365-api]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "matched-betting-vps" }, signal: AbortSignal.timeout(25_000) });
      if (res.status === 429) { await sleep(attempt * 1500); continue; }
      const json = await res.json();
      return json;
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(attempt * 1000);
    }
  }
  return null;
}

/** Hämta alla kommande fotbollsmatcher (paginerat). */
async function fetchUpcoming() {
  const events = [];
  for (let page = 1; page <= 10; page++) {
    const data = await apiGet(`${BASE}/upcoming?sport_id=${SPORT_SOCCER}&token=${TOKEN}&page=${page}`);
    const results = data?.results ?? [];
    if (DEBUG && page === 1) log("DEBUG upcoming[0]:", JSON.stringify(results[0] ?? data, null, 1).slice(0, 700));
    if (!results.length) break;
    events.push(...results);
    const total = data?.pager?.total ?? 0;
    if (events.length >= total || events.length >= MAX_EVENTS * 1.5) break;
  }
  return events;
}

/** Plocka 1X2 ur en prematch-respons, defensivt (fältnamn varierar). */
function extractFTR(prematchResult) {
  // Leta rekursivt efter en marknad vars namn liknar Full Time Result / 1X2.
  let found = null;
  const visit = (node) => {
    if (!node || typeof node !== "object" || found) return;
    const name = String(node.name ?? "").toLowerCase();
    if (/full.?time.?result|match.?result|fulltid|^1x2$|^resultat/.test(name) && Array.isArray(node.odds) && node.odds.length >= 3) {
      found = node.odds;
      return;
    }
    // Vanlig path: main.sp.full_time_result.odds
    for (const k of Object.keys(node)) {
      if (found) break;
      const v = node[k];
      if (/full_time_result|fulltime_result|match_result/i.test(k) && Array.isArray(v?.odds)) { found = v.odds; return; }
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(prematchResult);
  if (!found) return null;
  // Mappa till home/draw/away via header/name (1/X/2) eller ordning.
  const num = (o) => { const n = parseFloat(String(o?.odds ?? "")); return Number.isFinite(n) && n > 1 ? n : null; };
  const byKey = {};
  for (const o of found) {
    const h = String(o.header ?? o.name ?? "").trim().toUpperCase();
    if (h === "1" || h === "H") byKey.home = num(o);
    else if (h === "X" || h === "D") byKey.draw = num(o);
    else if (h === "2" || h === "A") byKey.away = num(o);
  }
  let home = byKey.home, draw = byKey.draw, away = byKey.away;
  if (!(home && draw && away) && found.length >= 3) { // fallback: ordning 1,X,2
    home = home ?? num(found[0]); draw = draw ?? num(found[1]); away = away ?? num(found[2]);
  }
  if (home && draw && away) return { home, draw, away };
  return null;
}

async function fetchPrematch(fi) {
  const data = await apiGet(`${BASE}/prematch?FI=${encodeURIComponent(fi)}&token=${TOKEN}`);
  const result = data?.results?.[0];
  return { result, raw: data };
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  log(`hämtar kommande fotboll (sport_id=1, fönster ${WINDOW_H}h, max ${MAX_EVENTS})...`);
  const all = await fetchUpcoming();
  const now = Date.now();
  const cutoff = now + WINDOW_H * 3600_000;
  const upcoming = all
    .map((e) => {
      const ts = Number(e.time) * 1000;
      return { fi: e.id ?? e.FI, home: e.home?.name ?? null, away: e.away?.name ?? null, startMs: ts, league: e.league?.name ?? null };
    })
    .filter((e) => e.fi && e.home && e.away && Number.isFinite(e.startMs) && e.startMs > now - 3600_000 && e.startMs < cutoff)
    .slice(0, MAX_EVENTS);
  log(`${all.length} kommande totalt → ${upcoming.length} inom fönstret, hämtar odds...`);

  let okCount = 0, debugged = false;
  const events = await mapLimit(upcoming, CONCURRENCY, async (ev) => {
    const { result, raw } = await fetchPrematch(ev.fi);
    if (DEBUG && !debugged && result) { debugged = true; log("DEBUG prematch-struktur (nycklar):", JSON.stringify(Object.keys(result))); log("DEBUG prematch[0] utdrag:", JSON.stringify(result).slice(0, 900)); }
    const odds = result ? extractFTR(result) : null;
    if (!odds) return null;
    okCount++;
    return {
      eventId: String(ev.fi),
      homeTeam: ev.home,
      awayTeam: ev.away,
      startTime: new Date(ev.startMs).toISOString(),
      league: ev.league,
      odds,
      foundBy: "betsapi-upcoming",
    };
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "betsapi-bet365",
    queryStrategy: "upcoming-soccer",
    eventsFromApi: all.length,
    eventsInWindow: upcoming.length,
    events: events.filter(Boolean),
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2), "utf-8");
  log(`Skrev ${OUTPUT}: ${payload.events.length} matcher med 1X2 (av ${upcoming.length} i fönstret).`);
  if (payload.events.length > 0) {
    const e = payload.events[0];
    log(`Ex: ${e.homeTeam} - ${e.awayTeam} @ ${e.startTime} | 1X2=${e.odds.home}/${e.odds.draw}/${e.odds.away}`);
  } else {
    log("VARNING: 0 matcher med 1X2 — kör med BET365_DEBUG=1 för att inspektera API-strukturen.");
  }
}

main().catch((e) => { console.error("[bet365-api] FATALT:", e?.message ?? e); process.exit(1); });
