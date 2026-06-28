#!/usr/bin/env node
/**
 * Standalone VBET-fetcher för GitHub Actions.
 *
 * Render-IP är blockerad av Cloudflare WAF för www.vbet.se (HTTP 403 vid
 * conf.json-fetch). GitHub Actions Azure-runners passerar Cloudflare för
 * VBET, så vi hämtar odds där och commit:ar data/vbet-rows.json tillbaka
 * till repot. Render läser via GitHub API contents endpoint (raw fallback).
 *
 * Pipeline (samma protokoll som vite.config.ts:scrapeVbetBookmaker):
 *   1. GET vbet.se/desktop/conf.json → { siteId, releaseDate }
 *   2. WS wss://eu-swarm-newm.vbet.se/ → request_session → sid
 *   3. RPC "get" team1_name/team2_name LIKE term → game-list
 *   4. RPC "get" market_type=MatchResult, game.id=N → 1X2-odds
 *   5. Skriv data/vbet-rows.json
 *
 * Query-strategin är pinnacle-driven (samma som ComeOn-scriptet): vi läser
 * data/pinnacle-rows.json och bygger queries från unika homeTeam-namn för
 * soccer-matcher inom 24h. Faller tillbaka till en kort hardcoded lista om
 * pinnacle saknas.
 */

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  installHardDeadline,
  writeJsonPreservingCache,
  readAdaptiveLimit,
  buildTuning,
} from "./lib/scrape-guard.mjs";

const VBET_SWARM_WS = "wss://eu-swarm-newm.vbet.se";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "vbet-rows.json");
const PINNACLE_FILE = path.join(DATA_DIR, "pinnacle-rows.json");

const RPC_TIMEOUT_MS = 14_000;
const SESSION_TIMEOUT_MS = 30_000;
// Övergripande tidsbudget för hela scrapingen (soccer + basket + tennis). När
// den passeras slutar vi söka/hämta och skriver det vi hunnit — så write+commit
// ALLTID hinner innan loopens per-iter timeout (1200s) dödar processen.
// Höjt 11→15 min för att rymma de två nya 2-vägs-stegen (basket/tennis).
const RUN_BUDGET_MS = Number(process.env.VBET_RUN_BUDGET_MS) || 15 * 60 * 1000;
// Soccer-fasens tak: lämna resten av budgeten till basket/tennis så de aldrig
// svälts ut av en långsam soccer-fas. ~60% soccer / ~40% 2-vägs.
const SOCCER_BUDGET_MS = Number(process.env.VBET_SOCCER_BUDGET_MS) || Math.floor(RUN_BUDGET_MS * 0.6);
// Batchstorlek per swarm-session. Swarmen stänger ofta WS efter ett fåtal
// RPC:er (rate-limit) → vi återansluter per batch så en droppad anslutning
// bara påverkar den batchen, inte hela körningen.
const SWARM_SEARCH_BATCH = Number(process.env.VBET_SEARCH_BATCH) || 20;
const SWARM_DETAIL_BATCH = Number(process.env.VBET_DETAIL_BATCH) || 20;

/** Tidsfönster för pinnacle-driven queries. 72h matchar ComeOn-workflow. */
const QUERY_LOOKAHEAD_HOURS = (() => {
  const raw = Number(process.env.VBET_LOOKAHEAD_HOURS);
  return Number.isFinite(raw) && raw >= 6 && raw <= 168 ? Math.floor(raw) : 72;
})();
/** Hård tak (ceiling) på antal queries — adaptiv budget växer upp hit. */
const QUERY_LIMIT = (() => {
  const raw = Number(process.env.VBET_QUERY_LIMIT);
  return Number.isFinite(raw) && raw >= 5 && raw <= 2000 ? Math.floor(raw) : 400;
})();
/** Golv för den adaptiva budgeten (under baseline-nivån går vi inte). */
const MIN_QUERY_LIMIT = (() => {
  const raw = Number(process.env.VBET_MIN_QUERY_LIMIT);
  return Number.isFinite(raw) && raw >= 5 && raw <= QUERY_LIMIT ? Math.floor(raw) : 80;
})();
/** Max antal event-detaljer per körning. */
const MAX_EVENTS = (() => {
  const raw = Number(process.env.VBET_MAX_EVENTS);
  return Number.isFinite(raw) && raw >= 5 && raw <= 2000 ? Math.floor(raw) : 500;
})();
/** Random jitter (ms) mellan RPC-anrop. Sprider ut load på swarm-WS. */
const RPC_JITTER_MIN_MS = 200;
const RPC_JITTER_MAX_MS = 400;
/** Retry på timeouts/transient errors: 3 försök totalt, exp backoff bas 1s. */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomJitter() {
  return RPC_JITTER_MIN_MS + Math.random() * (RPC_JITTER_MAX_MS - RPC_JITTER_MIN_MS);
}

// ====================================================================
// Pinnacle-driven query-extraction (kopia av strategin från
// scripts/fetch-comeon-github-action.mjs men anpassad för VBET)
// ====================================================================

/**
 * Baseline-queries: storlag + ligor som ofta saknas i Pinnacle-feeden
 * (eller har korta team-namn som inte funkar bra som search-term). Körs
 * ALLTID, även när pinnacle ger fullt resultat — fyller på täckning.
 */
const BASELINE_QUERIES = [
  // Premier League topp
  "Manchester", "Arsenal", "Chelsea", "Liverpool", "Tottenham", "Newcastle",
  "Everton", "West Ham", "Aston Villa", "Brighton", "Brentford",
  // La Liga / Italian Serie A / Bundesliga topp
  "Real Madrid", "Barcelona", "Atletico Madrid", "Sevilla",
  "Juventus", "Inter", "Milan", "Napoli", "Roma", "Lazio", "Fiorentina",
  "Bayern", "Dortmund", "Leipzig", "Leverkusen",
  // Ligue 1
  "PSG", "Marseille", "Lyon", "Monaco",
  // Övriga storlag Europa
  "Ajax", "PSV", "Feyenoord", "Benfica", "Porto", "Sporting",
  "Galatasaray", "Fenerbahce", "Olympiacos", "Panathinaikos",
  // Sverige + Norden
  "Hammarby", "AIK", "Djurgården", "Malmö", "Elfsborg", "IFK Göteborg",
  "Brann", "Bodø", "Molde", "Rosenborg",
  "FCK", "Brøndby", "Midtjylland",
  // CONMEBOL (Pinnacle har stor coverage)
  "Boca Juniors", "River Plate", "Flamengo", "Palmeiras", "Corinthians",
  "Santos", "Fluminense", "Internacional", "Grêmio", "Atlético Mineiro",
  // USA MLS
  "LA Galaxy", "LAFC", "Inter Miami", "Seattle", "Atlanta United",
  "New York", "Toronto",
];

function buildQueries(limit = QUERY_LIMIT) {
  return buildQueriesForSport("soccer", limit, BASELINE_QUERIES, ["Brighton", "Aston Villa", "Manchester United"]);
}

/**
 * Pinnacle-driven queries för valfri sport. Soccer använder lag-namn + baseline-
 * storlag; basket/tennis bygger queries enbart från Pinnacles matchups (lag/
 * spelarnamn) för den sporten — ingen fotbolls-baseline. Tennis: lägg även till
 * efternamnet separat, eftersom VBET ofta lagrar spelare på efternamn.
 */
function buildQueriesForSport(sportTag, limit, baseline = [], fallback = []) {
  let parsed;
  try {
    if (!fs.existsSync(PINNACLE_FILE)) {
      console.warn(`[vbet-action] ${PINNACLE_FILE} saknas — ${sportTag}: baseline + fallback`);
      return [...baseline, ...fallback].slice(0, limit);
    }
    parsed = JSON.parse(fs.readFileSync(PINNACLE_FILE, "utf-8"));
  } catch (error) {
    console.warn(
      `[vbet-action] kunde inte läsa pinnacle-rows.json: ${error?.message ?? error} — ${sportTag}: baseline + fallback`,
    );
    return [...baseline, ...fallback].slice(0, limit);
  }
  const matchups = parsed?.bySport?.[sportTag]?.matchups;
  if (!Array.isArray(matchups)) {
    console.warn(`[vbet-action] pinnacle saknar bySport.${sportTag}.matchups — baseline`);
    return baseline.slice(0, limit);
  }
  const now = Date.now();
  const cutoffMin = now - 2 * 60 * 60 * 1000;
  const cutoffMax = now + QUERY_LOOKAHEAD_HOURS * 60 * 60 * 1000;
  const seen = new Set();
  const queries = [];

  // Add baseline-queries first (high-priority storlag + ligor)
  for (const q of baseline) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(q);
  }

  // Add Pinnacle-driven queries — BÅDA hemma- och bortalag, så vi
  // söker varje match från två håll. Dubblar coverage utan att dubbla
  // queries pga dedupe.
  let pinAdded = 0;
  const pushQuery = (raw) => {
    if (!raw || typeof raw !== "string") return;
    const cleaned = raw.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    if (cleaned.length < 3) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(cleaned);
    pinAdded += 1;
  };
  for (const m of matchups) {
    const startMs = Date.parse(m?.startTime ?? "");
    if (!Number.isFinite(startMs) || startMs < cutoffMin || startMs > cutoffMax) continue;
    const home = m?.participants?.find?.((p) => p?.alignment === "home")?.name;
    const away = m?.participants?.find?.((p) => p?.alignment === "away")?.name;
    for (const teamName of [home, away]) {
      pushQuery(teamName);
      // Tennis: VBET söker ofta bäst på efternamn (sista ordet i spelarnamnet).
      if (sportTag === "tennis" && typeof teamName === "string") {
        const surname = teamName.replace(/\s*\([^)]*\)\s*$/g, "").trim().split(/\s+/).pop();
        if (surname && surname.length >= 3) pushQuery(surname);
      }
    }
  }
  console.log(`[vbet-action] ${sportTag} queries: ${baseline.length} baseline + ${pinAdded} pinnacle-driven = ${queries.length} total (cap ${limit})`);

  if (queries.length === 0) {
    console.warn(`[vbet-action] ${sportTag}: inga queries genererade — fallback`);
    return fallback.slice(0, limit);
  }
  return queries.slice(0, limit);
}

// ====================================================================
// VBET conf + swarm-WS-helpers (port av vite.config.ts:2658-2939)
// ====================================================================

/**
 * Statisk VBET-config (siteId + releaseDate). Cloudflare WAF blockar
 * www.vbet.se/desktop/conf.json från GitHub Actions Azure-poolen (HTTP 403,
 * verifierat i workflow-körning 17:30Z). conf.json ändras sällan — siteId är
 * permanent och releaseDate uppdateras månadsvis.
 *
 * Strategi (steg C1): hoppa över conf-fetch helt och använd statiska värden.
 * Värdena är extraherade från lokal fetch 2026-05-07 (lokalt 200 OK). Kan
 * uppdateras manuellt via env-overrides utan kod-ändring:
 *   VBET_SITE_ID=1088 VBET_RELEASE_DATE="2026-04-29 17:03:32" node ...
 *
 * Om swarm-WS också blockar GitHub Actions IP är hela VBET-pipelinen ej
 * möjlig från GitHub utan Playwright stealth (steg C2).
 */
const VBET_STATIC_SITE_ID = 1088;
const VBET_STATIC_RELEASE_DATE = "2026-04-29 17:03:32";

function getVbetConfig() {
  const envSiteId = Number(process.env.VBET_SITE_ID);
  const envReleaseDate = process.env.VBET_RELEASE_DATE;
  const siteId = Number.isFinite(envSiteId) && envSiteId > 0 ? envSiteId : VBET_STATIC_SITE_ID;
  const releaseDate = envReleaseDate && envReleaseDate.length > 0 ? envReleaseDate : VBET_STATIC_RELEASE_DATE;
  return { siteId, releaseDate, source: envSiteId || envReleaseDate ? "env-override" : "static" };
}

function vbetLikePredicate(term) {
  const t = term.trim();
  return { "@like": { pred: t, swe: t } };
}
function vbetGameTitle(team1, team2) {
  return `${team1} - ${team2}`;
}
function isVbetSpecialEvent(team1, team2) {
  return /\bmanager\b|\bfantasy\b|special offer|\boutright\b|\bwinner\b|\bto win\b|\bgrupp\b|\bgroup\b|\bttv\b/i.test(
    `${team1} ${team2}`,
  );
}

function parseVbetGameSearchPayload(msg) {
  const games = msg?.data?.data?.game;
  if (!games || typeof games !== "object") return [];
  return Object.values(games)
    .map((g) => ({
      id: Number(g.id),
      team1: String(g.team1_name ?? "").trim(),
      team2: String(g.team2_name ?? "").trim(),
      startTs: typeof g.start_ts === "number" ? g.start_ts : undefined,
    }))
    .filter((g) => Number.isFinite(g.id) && g.team1.length > 0 && g.team2.length > 0)
    .filter((g) => !isVbetSpecialEvent(g.team1, g.team2));
}

function parseVbetMatchResultOdds(msg) {
  const markets = msg?.data?.data?.market;
  if (!markets || typeof markets !== "object") return null;

  const isMainThreeWay = (m) => {
    const t = (m.market_type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const dk = (m.display_key ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const nm = (m.name ?? "").toLowerCase();
    if (t === "matchresult" || t === "p1xp2" || t === "threeway" || t === "classicmatchresult") return true;
    if ((t.includes("winner") || t.includes("match")) && (t.includes("full") || t.includes("time"))) return true;
    if (dk.includes("matchresult") || dk.includes("1x2") || dk === "mw") return true;
    if (/\b1\s*[x×]\s*2\b/.test(nm) || nm.includes("fulltid") || nm.includes("match odds")) return true;
    return false;
  };

  for (const m of Object.values(markets)) {
    if (!isMainThreeWay(m)) continue;
    const events = m.event;
    if (!events || typeof events !== "object") continue;

    const triple = Object.values(events)
      .map((ev) => ({
        name: ev.name ?? "",
        price: ev.price,
        order: typeof ev.order === "number" ? ev.order : 999,
      }))
      .filter((ev) => typeof ev.price === "number" && ev.price > 1);

    if (triple.length === 3) {
      const hasUsableOrder = triple.some((ev) => ev.order < 100);
      if (hasUsableOrder) {
        triple.sort((a, b) => a.order - b.order);
        return { home: triple[0].price, draw: triple[1].price, away: triple[2].price };
      }
    }

    let home, draw, away;
    for (const ev of Object.values(events)) {
      const name = (ev.name ?? "").trim();
      const price = ev.price;
      if (typeof price !== "number" || !(price > 1)) continue;
      const n = name.toLowerCase();
      if (name === "W1" || name === "1" || n === "hemma" || n === "home") home = price;
      else if (name === "W2" || name === "2" || n === "borta" || n === "away") away = price;
      else if (name === "Oavgjort" || name === "Draw" || name === "X" || n === "lika" || n === "tie") draw = price;
    }
    if (home != null && draw != null && away != null) return { home, draw, away };
  }
  return null;
}

/**
 * Öppna en VBET swarm-session (WebSocket) och kör `run(rpc)`. RPC:n är
 * sekventiell — vi multiplexar inte parallella anrop på samma WS för att
 * undvika rate-limit/blockering.
 */
async function withVbetSwarmSession(siteId, releaseDate, run) {
  const socket = new WebSocket(VBET_SWARM_WS);
  return await new Promise((resolve, reject) => {
    let sessionReady = false;
    const pending = new Map();
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      reject(error);
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch {}
      resolve(value);
    };

    const sessionTimer = setTimeout(() => {
      if (!sessionReady) fail(new Error(`VBET session timeout efter ${SESSION_TIMEOUT_MS}ms`));
    }, SESSION_TIMEOUT_MS);

    socket.on("error", (err) => {
      clearTimeout(sessionTimer);
      fail(new Error(`VBET WebSocket error: ${err?.message ?? err}`));
    });

    // Swarmen stänger ofta WS efter några RPC:er (rate-limit). Utan denna
    // hanterare skickas vidare RPC:er in i en död socket och varje väntar till
    // 14s-timeout (audit 2026-06-07: 4/235 queries svarade, resten timeout).
    // Här avvisar vi alla väntande direkt så den yttre batch-loopen kan
    // återansluta med en färsk session i stället för att hänga.
    socket.on("close", () => {
      clearTimeout(sessionTimer);
      for (const waiter of pending.values()) {
        try {
          waiter.reject(new Error("VBET WS stängd (swarm droppade anslutningen)"));
        } catch {}
      }
      pending.clear();
      fail(new Error("VBET WS stängd"));
    });

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          command: "request_session",
          params: {
            afec: "",
            source: 0,
            language: "swe",
            site_id: siteId,
            release_date: releaseDate,
          },
        }),
      );
    });

    socket.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      let msg;
      try { msg = JSON.parse(text); } catch { return; }

      if (!sessionReady) {
        const sid = msg?.data?.sid;
        if (msg.code === 0 && sid) {
          sessionReady = true;
          clearTimeout(sessionTimer);
          (async () => {
            try {
              const rpc = (cmd, rid) =>
                new Promise((resolveRpc, rejectRpc) => {
                  const timer = setTimeout(() => {
                    pending.delete(rid);
                    rejectRpc(new Error(`VBET swarm RPC timeout efter ${RPC_TIMEOUT_MS}ms`));
                  }, RPC_TIMEOUT_MS);
                  pending.set(rid, {
                    resolve: (v) => { clearTimeout(timer); resolveRpc(v); },
                    reject: (e) => { clearTimeout(timer); rejectRpc(e); },
                  });
                  socket.send(JSON.stringify({ rid, ...cmd }));
                });
              const result = await run(rpc);
              ok(result);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          })();
        } else if (msg.code != null && msg.code !== 0) {
          clearTimeout(sessionTimer);
          fail(new Error(msg.msg || `VBET session failed (code=${msg.code})`));
        }
        return;
      }

      const rid = typeof msg.rid === "string" ? Number.parseInt(msg.rid, 10) : Number(msg.rid);
      if (!Number.isFinite(rid) || rid === 0) return;
      const waiter = pending.get(rid);
      if (!waiter) return;
      pending.delete(rid);
      if (msg.code != null && msg.code !== 0) {
        waiter.reject(new Error(msg.msg || `VBET swarm error (code=${msg.code})`));
      } else {
        waiter.resolve(msg);
      }
    });
  });
}

async function rpcWithRetry(rpc, ridSeed, cmd) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await rpc(cmd, ridSeed.value++);
    } catch (error) {
      lastError = error;
      const msg = error?.message ?? String(error);
      const retryable = /timeout|reset|ECONN|ETIMEDOUT|swarm error/i.test(msg);
      if (attempt < RETRY_MAX_ATTEMPTS && retryable) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("rpc retry exhausted");
}

async function vbetSearchGames(rpc, ridSeed, term, sportAlias = "Soccer") {
  const resp = await rpcWithRetry(rpc, ridSeed, {
    command: "get",
    params: {
      source: "betting",
      subscribe: true,
      what: { game: ["id", "team1_name", "team2_name", "start_ts"] },
      where: {
        sport: { alias: sportAlias },
        game: {
          "@node_limit": 120,
          "@or": [{ team1_name: vbetLikePredicate(term) }, { team2_name: vbetLikePredicate(term) }],
        },
      },
    },
  });
  return parseVbetGameSearchPayload(resp);
}

/**
 * Parse 2-vägs moneyline (basket/tennis): exakt 2 prissatta utfall, ingen
 * oavgjort. Väljer den "winner/match"-marknad som har precis 2 events och
 * undviker handikapp/total/over-under. order < 100 = hemma, näst = borta.
 */
function parseVbetMoneyline2Way(msg) {
  const markets = msg?.data?.data?.market;
  if (!markets || typeof markets !== "object") return null;

  const isMain2Way = (m) => {
    const t = (m.market_type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const dk = (m.display_key ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const nm = (m.name ?? "").toLowerCase();
    // Uteslut handikapp / total / over-under / set/games-marknader.
    if (/handicap|total|overunder|spread|sets|games|points|odd|even/.test(`${t} ${dk} ${nm}`)) return false;
    if (t.includes("winner") || t === "matchresult" || t === "p1p2" || t.includes("win2way")) return true;
    if (dk.includes("winner") || dk === "mw" || dk === "w2w") return true;
    if (/\b1\s*2\b/.test(nm) || nm.includes("winner") || nm.includes("vinnare") || nm.includes("match result") || nm.includes("moneyline")) return true;
    return false;
  };

  // Samla kandidat-marknader: 2 prissatta utfall + matchar winner-mönstret.
  let fallback = null;
  for (const m of Object.values(markets)) {
    const events = m?.event;
    if (!events || typeof events !== "object") continue;
    const priced = Object.values(events)
      .map((ev) => ({ name: String(ev.name ?? "").trim(), price: ev.price, order: typeof ev.order === "number" ? ev.order : 999 }))
      .filter((ev) => typeof ev.price === "number" && ev.price > 1);
    if (priced.length !== 2) continue;
    const pair = pickVbet2WayPair(priced);
    if (!pair) continue;
    if (isMain2Way(m)) return pair;
    // Spara första 2-utfalls-marknaden som fallback om ingen winner-märkt hittas.
    if (!fallback) fallback = pair;
  }
  return fallback;
}

function pickVbet2WayPair(priced) {
  const hasOrder = priced.some((ev) => ev.order < 100);
  if (hasOrder) {
    const sorted = [...priced].sort((a, b) => a.order - b.order);
    return { home: sorted[0].price, away: sorted[1].price };
  }
  let home, away;
  for (const ev of priced) {
    const n = ev.name.toLowerCase();
    if (ev.name === "W1" || ev.name === "1" || n === "hemma" || n === "home") home = ev.price;
    else if (ev.name === "W2" || ev.name === "2" || n === "borta" || n === "away") away = ev.price;
  }
  if (home != null && away != null) return { home, away };
  return null;
}

async function vbetFetchMoneyline2WayOdds(rpc, ridSeed, gameId) {
  const variants = [
    { game: { id: gameId }, market: { market_type: "Winner" } },
    { game: { id: gameId }, market: { market_type: "MatchResult" } },
    { game: { id: gameId } },
  ];
  for (const where of variants) {
    try {
      const resp = await rpcWithRetry(rpc, ridSeed, {
        command: "get",
        params: {
          source: "betting",
          what: {
            market: ["id", "name", "market_type", "display_key"],
            event: ["name", "price", "order"],
          },
          where,
        },
      });
      const odds = parseVbetMoneyline2Way(resp);
      if (odds) return odds;
    } catch {
      // prova nästa variant
    }
  }
  return null;
}

async function vbetFetchMatchResultOdds(rpc, ridSeed, gameId) {
  const variants = [
    { game: { id: gameId }, market: { market_type: "MatchResult" } },
    { game: { id: gameId }, market: { market_type: "matchresult" } },
    { game: { id: gameId } },
  ];
  for (const where of variants) {
    try {
      const resp = await rpcWithRetry(rpc, ridSeed, {
        command: "get",
        params: {
          source: "betting",
          what: {
            market: ["id", "name", "market_type", "display_key"],
            event: ["name", "price", "order"],
          },
          where,
        },
      });
      const odds = parseVbetMatchResultOdds(resp);
      if (odds) return odds;
    } catch {
      // prova nästa variant
    }
  }
  return null;
}

// ── Totals + Asian Handicap (bundet, andra RPC) ──────────────────────
let VBET_LINES_DIAG = false;
let vbetLinesFetched = 0;
const VBET_LINES_MAX = Number(process.env.VBET_LINES_MAX) || 40; // tak: bara dessa hämtar alla marknader
function numFromVbet(s) { const m = String(s ?? "").match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; }

/** Strippa tids-/segment-prefix ("1-75 Min.") innan vi tolkar en linje. */
function vbetCleanName(s) { return String(s ?? "").replace(/^\s*\d+\s*-\s*\d+\s*min\.?/i, "").trim(); }
function vbetLineFrom(s) { return numFromVbet(vbetCleanName(s)); }

/**
 * Parsa FULL-MATCH totals + AH ur en all-markets-respons. vbet har massor av
 * tids-segment ("1-75 Min."), lag- och kombo-marknader — vi tar BARA den rena
 * full-match O/U (market_type "OverUnder") och handikapp ("Handicap"), och
 * läser linjen ur utfallsnamnet (aldrig ur marknadsnamnet → undviker "1-75"→1).
 */
function parseVbetTotalsAh(msg, homeTeam, awayTeam) {
  const markets = msg?.data?.data?.market;
  const totals = [], ah = [];
  if (!markets || typeof markets !== "object") return { totals, ah };
  const hN = String(homeTeam ?? "").toLowerCase().trim(), aN = String(awayTeam ?? "").toLowerCase().trim();
  // Linjen ligger i base-fältet (INTE i namnet). VIKTIGT: marknadens m.base är
  // motpartens (away) perspektiv — varje UTFALL bär sin EGEN signerade base från
  // sitt eget perspektiv (Home -0.5 / Away +0.5 i samma marknad). Läs därför
  // linjen ur det relevanta utfallets egen base, inte ur m.base.
  const outBase = (o) => { const b = Number(o?.base); return Number.isFinite(b) ? b : null; };
  for (const m of Object.values(markets)) {
    const mtype = String(m.market_type ?? "");
    // BARA full-match O/U + asiatiskt handikapp (exakt typ → ingen segment/kombo).
    const isTotal = mtype === "OverUnder";
    const isAh = mtype === "AsianHandicap";
    if (!isTotal && !isAh) continue;
    const mBase = Number(m.base);
    const outs = Object.values(m?.event ?? {})
      .map((e) => ({ name: String(e.name ?? "").trim(), price: e.price, base: e.base, type: String(e.type ?? ""), order: typeof e.order === "number" ? e.order : 999 }))
      .filter((e) => typeof e.price === "number" && e.price > 1);
    if (outs.length !== 2) continue;
    if (isTotal) {
      // type-fältet ger Over/Under direkt; linjen är samma för båda sidor.
      let over = null, under = null, line = null;
      for (const o of outs) {
        const t = o.type.toLowerCase(), n = o.name.toLowerCase();
        if (t === "over" || /over|över|^o\b/.test(n)) { over = o.price; line ??= outBase(o); }
        else if (t === "under" || /under|^u\b/.test(n)) { under = o.price; line ??= outBase(o); }
      }
      if (line == null) line = outBase(outs[0]) ?? (Number.isFinite(mBase) ? mBase : null);
      if (over > 1 && under > 1 && Number.isFinite(line) && line > 0) totals.push({ line, over, under });
    } else {
      // AH: type-fältet ("Home"/"Away") ger sidan direkt (robustare än lagnamn).
      // Linjen = HEMMA-utfallets EGEN base (hemma-perspektiv, favorit negativ).
      // Fallback om hemma-basen saknas: negera m.base (= away-perspektiv).
      let home = null, away = null, line = null;
      for (const o of outs) {
        const t = o.type.toLowerCase(), n = o.name.toLowerCase();
        const isHome = t === "home" || (hN && (n.includes(hN.slice(0, 6)) || hN.includes(n.slice(0, 6))));
        const isAway = t === "away" || (aN && (n.includes(aN.slice(0, 6)) || aN.includes(n.slice(0, 6))));
        if (isHome && home == null) { home = o.price; line = outBase(o); }
        else if (isAway && away == null) { away = o.price; }
      }
      if (home == null || away == null) {
        const s = [...outs].sort((a, b) => a.order - b.order);
        home ??= s[0].price; away ??= s[1].price;
        if (line == null) line = outBase(s[0]);
      }
      if (line == null && Number.isFinite(mBase)) line = -mBase; // away-perspektiv → negera
      if (home > 1 && away > 1 && Number.isFinite(line)) ah.push({ line, home, away });
    }
  }
  return { totals, ah };
}

/**
 * EN RPC som hämtar ALLA marknader för ett game och parsar 1X2 + totals + AH ur
 * SAMMA svar. Detta är nyckeln mot stall:en: round-trip-antalet är identiskt med
 * originalets (1 RPC/game) — bara payloaden är större. Inget extra andra-RPC.
 * Returnerar { odds, totals, ah } eller null om inget 1X2.
 */
async function vbetFetchAllOdds(rpc, ridSeed, gameId, homeTeam, awayTeam) {
  try {
    const resp = await rpcWithRetry(rpc, ridSeed, {
      command: "get",
      params: {
        source: "betting",
        // base = linje/handikapp (låg INTE i utfallsnamnet → måste begäras).
        what: { market: ["id", "name", "market_type", "display_key", "base", "group_name"], event: ["name", "price", "order", "base", "type"] },
        where: { game: { id: gameId } },
      },
    });
    const odds = parseVbetMatchResultOdds(resp);
    if (!odds) return null;
    if (!VBET_LINES_DIAG) {
      VBET_LINES_DIAG = true;
      const mk = resp?.data?.data?.market;
      if (mk && typeof mk === "object") {
        // Full objekt-dump för full-match O/U + AsianHandicap → bekräfta var linjen ligger.
        for (const want of ["OverUnder", "AsianHandicap"]) {
          const m = Object.values(mk).find((x) => x.market_type === want);
          if (m) console.log(`[vbet-action] LINES-DIAG ${want}=${JSON.stringify({ base: m.base, group_name: m.group_name, name: m.name, evs: Object.values(m.event || {}).slice(0, 4).map((e) => ({ n: e.name, p: e.price, base: e.base, type: e.type })) })}`);
        }
      }
    }
    const { totals, ah } = parseVbetTotalsAh(resp, homeTeam, awayTeam);
    return { odds, totals, ah };
  } catch { return null; }
}

// ====================================================================
// Main pipeline
// ====================================================================

async function main() {
  const runStart = Date.now();
  // Adaptiv query-budget: läs förra körningens utfall ur vbet-rows.json:s _tuning.
  const { limit: effectiveLimit } = readAdaptiveLimit({
    file: OUTPUT_FILE,
    defaultLimit: QUERY_LIMIT,
    minLimit: MIN_QUERY_LIMIT,
    maxLimit: QUERY_LIMIT,
    label: "vbet-action",
  });
  const queries = buildQueries(effectiveLimit);
  // Basket/tennis: rena Pinnacle-drivna queries (ingen fotbolls-baseline). Cap
  // halva soccer-budgeten var så 2-vägs-stegen aldrig äter upp soccer-tiden.
  const TWO_WAY_LIMIT = Math.max(40, Math.floor(effectiveLimit / 2));
  const basketQueries = buildQueriesForSport("basketball", TWO_WAY_LIMIT);
  const tennisQueries = buildQueriesForSport("tennis", TWO_WAY_LIMIT);
  console.log(
    `[vbet-action] Query-strategi: pinnacle-driven (homeTeam, ${QUERY_LOOKAHEAD_HOURS}h fönster, budget ${effectiveLimit}/${QUERY_LIMIT})`,
  );
  console.log(`[vbet-action] Antal queries: ${queries.length} soccer · ${basketQueries.length} basket · ${tennisQueries.length} tennis`);
  console.log(`[vbet-action] Första 10 queries: ${JSON.stringify(queries.slice(0, 10))}`);

  const conf = getVbetConfig();
  console.log(
    `[vbet-action] VBET-config (${conf.source}): siteId=${conf.siteId} releaseDate=${conf.releaseDate}`,
  );
  console.log(
    "[vbet-action] OBS: conf.json-fetch är skippad (Cloudflare 403 från GitHub IP). " +
      "Sätt VBET_SITE_ID/VBET_RELEASE_DATE i workflow:n om värdena behöver uppdateras.",
  );

  let searchHits = 0;
  let queriesWithHits = 0;
  let detailFetches = 0;
  let detailErrors = 0;
  const seenGameIds = new Set();
  const candidateGames = []; // { gameId, team1, team2, startTs, foundBy }
  const completedEvents = []; // { gameId, title, homeTeam, awayTeam, startTs, odds, foundBy }
  const eventsBasket = []; // 2-vägs basket: { title, homeTeam, awayTeam, startTime, sport, odds:{home,away} }
  const eventsTennis = []; // 2-vägs tennis
  const errorSamples = [];
  let hitDeadline = false;

  // Skriver completedEvents cache-bevarande: 0 soccer-events → bevara tidigare
  // cache. Basket/tennis bevaras per-array: en partiell körning som inte hann
  // basket/tennis ska INTE klottra över förra körningens 2-vägs-data.
  const writeOutput = (sourceTag = "github-actions") => {
    let prevBasket = [];
    let prevTennis = [];
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
      if (Array.isArray(prev?.eventsBasket)) prevBasket = prev.eventsBasket;
      if (Array.isArray(prev?.eventsTennis)) prevTennis = prev.eventsTennis;
    } catch { /* ingen tidigare fil → tomt */ }
    const payload = {
      updatedAt: new Date().toISOString(),
      source: sourceTag,
      // Hälsoflagga: true = avbruten av hard-deadline → reducerad täckning.
      partial: String(sourceTag).includes("partial"),
      queryStrategy: "pinnacle-home-team",
      queryLookaheadHours: QUERY_LOOKAHEAD_HOURS,
      queryCount: queries.length,
      siteId: conf.siteId,
      events: completedEvents,
      eventsBasket: eventsBasket.length > 0 ? eventsBasket : prevBasket,
      eventsTennis: eventsTennis.length > 0 ? eventsTennis : prevTennis,
      _tuning: buildTuning({ limitUsed: effectiveLimit, runStart, deadlineMs: HARD_DEADLINE_MS, hitDeadline }),
    };
    writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "vbet-action" });
  };

  // Preemptiv backstop UTÖVER RUN_BUDGET_MS: om en swarm-RPC hänger så att den
  // kooperativa budget-checken aldrig hinner köra sparar deadline:n det som
  // hunnit samlas och avslutar rent (exit 0) före jobbets timeout (15 min).
  const HARD_DEADLINE_MS = Number(process.env.VBET_DEADLINE_MS) || 17 * 60 * 1000;
  const deadline = installHardDeadline({
    budgetMs: HARD_DEADLINE_MS,
    label: "vbet-action",
    onDeadline: () => {
      hitDeadline = true;
      writeOutput("github-actions-partial-deadline");
    },
  });

  console.log("[vbet-action] Öppnar swarm WebSocket-session...");
  const swarmStart = Date.now();

  // Batchad swarm: öppna en FÄRSK session per liten batch. Med en enda
  // långlivad session timeout:ade resten av queries när swarmen droppade WS:en
  // (audit 2026-06-07: 4/235 svarade). Genom att återansluta per batch får en
  // droppad anslutning bara den batchen att misslyckas; nästa får en ny session.
  // ridSeed nollställs per session (rid numreras per anslutning). Tidsbudget
  // respekteras både mellan och inom batchar.
  const runSwarmBatches = async (items, batchSize, label, handleItem, budgetMs = RUN_BUDGET_MS) => {
    for (let i = 0; i < items.length; i += batchSize) {
      if (Date.now() - runStart > budgetMs) {
        console.warn(`[vbet-action] Tidsbudget nådd (${label}) vid ${i}/${items.length} — avbryter.`);
        break;
      }
      const batch = items.slice(i, i + batchSize);
      try {
        await withVbetSwarmSession(conf.siteId, conf.releaseDate, async (rpc) => {
          const ridSeed = { value: 1 };
          for (const item of batch) {
            if (Date.now() - runStart > RUN_BUDGET_MS) break;
            await handleItem(rpc, ridSeed, item);
          }
        });
      } catch (error) {
        console.warn(
          `[vbet-action] Swarm-batch ${label} ${i}-${i + batch.length} avbröts (${error?.message ?? error}) — återansluter nästa batch.`,
        );
      }
    }
  };

  // Steg A: search per query (batchad reconnect)
  const searchStart = Date.now();
  await runSwarmBatches(queries, SWARM_SEARCH_BATCH, "search", async (rpc, ridSeed, term) => {
    let rows = [];
    try {
      rows = await vbetSearchGames(rpc, ridSeed, term);
    } catch (error) {
      if (errorSamples.length < 5) {
        errorSamples.push({ stage: "search", term, error: error?.message ?? String(error) });
      }
    }
    searchHits += rows.length;
    if (rows.length > 0) queriesWithHits += 1;
    for (const row of rows) {
      if (seenGameIds.has(row.id)) continue;
      seenGameIds.add(row.id);
      candidateGames.push({ ...row, foundBy: term });
    }
    await sleep(randomJitter());
  }, SOCCER_BUDGET_MS);
  const searchMs = Date.now() - searchStart;
  console.log(
    `[vbet-action] Search klar: ${searchHits} hits, ${seenGameIds.size} unika games, ${queriesWithHits}/${queries.length} queries-with-hits (${(searchMs / 1000).toFixed(1)}s)`,
  );

  // Steg B: detail per unik game (batchad reconnect)
  const limited = candidateGames.slice(0, MAX_EVENTS);
  const detailStart = Date.now();
  await runSwarmBatches(limited, SWARM_DETAIL_BATCH, "detail", async (rpc, ridSeed, cand) => {
    detailFetches += 1;
    try {
      // ETT RPC per game (samma round-trip-antal som original → ingen stall).
      // De första VBET_LINES_MAX games:en hämtas med ALLA marknader (1X2 + totals
      // + AH); resten med lätt 1X2-only. Aldrig ett extra andra-RPC.
      let odds = null, totals = [], ah = [];
      if (vbetLinesFetched < VBET_LINES_MAX) {
        vbetLinesFetched += 1;
        const all = await vbetFetchAllOdds(rpc, ridSeed, cand.id, cand.team1, cand.team2);
        if (all) { odds = all.odds; totals = all.totals; ah = all.ah; }
        else odds = await vbetFetchMatchResultOdds(rpc, ridSeed, cand.id);
      } else {
        odds = await vbetFetchMatchResultOdds(rpc, ridSeed, cand.id);
      }
      if (odds) {
        completedEvents.push({
          gameId: cand.id,
          title: vbetGameTitle(cand.team1, cand.team2),
          homeTeam: cand.team1,
          awayTeam: cand.team2,
          startTs: cand.startTs,
          // ISO-starttid så appens kickoff-veto kan skilja fixtures åt (samma
          // lag kan mötas flera ggr samma dag → annars fel odds-koppling).
          startTime:
            typeof cand.startTs === "number" && Number.isFinite(cand.startTs)
              ? new Date(cand.startTs < 1e11 ? cand.startTs * 1000 : cand.startTs).toISOString()
              : null,
          odds,
          ...(totals.length ? { totals } : {}),
          ...(ah.length ? { ah } : {}),
          foundBy: cand.foundBy,
        });
      } else {
        detailErrors += 1;
        if (errorSamples.length < 10) {
          errorSamples.push({ stage: "detail", gameId: cand.id, reason: "no-1x2-market" });
        }
      }
    } catch (error) {
      detailErrors += 1;
      if (errorSamples.length < 10) {
        errorSamples.push({ stage: "detail", gameId: cand.id, error: error?.message ?? String(error) });
      }
    }
    await sleep(randomJitter());
  }, SOCCER_BUDGET_MS);
  const detailMs = Date.now() - detailStart;
  console.log(
    `[vbet-action] Detail klar: ${completedEvents.length}/${limited.length} OK, ${detailErrors} errors (${(detailMs / 1000).toFixed(1)}s)`,
  );

  // Steg C: 2-vägs (basket + tennis). Helt separat från soccerns 1X2-pipeline.
  // Söker per sport-alias, hämtar 2-vägs winner-marknaden (home/away, ingen
  // oavgjort). Tidsbudgeten delas — körningen avbryter snällt om soccern redan
  // ätit upp tiden (basket/tennis bevaras då från förra körningen via writeOutput).
  const collect2Way = async (sportQueries, sportAlias, sportTag, sink, budgetMs) => {
    if (Date.now() - runStart > budgetMs) {
      console.warn(`[vbet-action] Tidsbudget redan nådd — hoppar ${sportTag}.`);
      return;
    }
    const seen = new Set();
    const cands = [];
    await runSwarmBatches(sportQueries, SWARM_SEARCH_BATCH, `search-${sportTag}`, async (rpc, ridSeed, term) => {
      let rows = [];
      try { rows = await vbetSearchGames(rpc, ridSeed, term, sportAlias); }
      catch (error) { if (errorSamples.length < 10) errorSamples.push({ stage: `search-${sportTag}`, term, error: error?.message ?? String(error) }); }
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        cands.push({ ...row, foundBy: term });
      }
      await sleep(randomJitter());
    }, budgetMs);
    const limitedCands = cands.slice(0, MAX_EVENTS);
    await runSwarmBatches(limitedCands, SWARM_DETAIL_BATCH, `detail-${sportTag}`, async (rpc, ridSeed, cand) => {
      try {
        const odds = await vbetFetchMoneyline2WayOdds(rpc, ridSeed, cand.id);
        if (odds) {
          sink.push({
            gameId: cand.id,
            title: vbetGameTitle(cand.team1, cand.team2),
            homeTeam: cand.team1,
            awayTeam: cand.team2,
            startTs: cand.startTs,
            startTime:
              typeof cand.startTs === "number" && Number.isFinite(cand.startTs)
                ? new Date(cand.startTs < 1e11 ? cand.startTs * 1000 : cand.startTs).toISOString()
                : null,
            league: null,
            sport: sportTag,
            odds,
            foundBy: cand.foundBy,
          });
        }
      } catch (error) {
        if (errorSamples.length < 12) errorSamples.push({ stage: `detail-${sportTag}`, gameId: cand.id, error: error?.message ?? String(error) });
      }
      await sleep(randomJitter());
    }, budgetMs);
    console.log(`[vbet-action] ${sportTag}: ${cands.length} kandidater → ${sink.length} kompletta 2-vägs-events`);
  };
  // Dela återstående budget mellan basket och tennis: basket till mittpunkten av
  // 2-vägs-fönstret, tennis till full RUN_BUDGET — så tennis aldrig svälts ut.
  const twoWayMidMs = SOCCER_BUDGET_MS + Math.floor((RUN_BUDGET_MS - SOCCER_BUDGET_MS) / 2);
  await collect2Way(basketQueries, "Basketball", "basketball", eventsBasket, twoWayMidMs);
  await collect2Way(tennisQueries, "Tennis", "tennis", eventsTennis, RUN_BUDGET_MS);
  console.log(`[vbet-action] 2-way totalt: ${eventsBasket.length} basket + ${eventsTennis.length} tennis`);

  const swarmMs = Date.now() - swarmStart;
  const totalMs = Date.now() - runStart;

  // Normal slutförd körning: avbryt deadline och skriv. writeOutput bevarar
  // tidigare cache vid 0 kompletta events (skriver aldrig över med tomt).
  deadline.cancel();
  writeOutput("github-actions");

  // Summary
  console.log("");
  console.log("============ SAMMANFATTNING ============");
  console.log(`Query-strategi: pinnacle-home-team (${queries.length} queries, ${QUERY_LOOKAHEAD_HOURS}h fönster)`);
  console.log(`Total runtime: ${(totalMs / 1000).toFixed(1)}s (swarm: ${(swarmMs / 1000).toFixed(1)}s)`);
  console.log(
    `Aggregerat: search-hits=${searchHits} | queries-with-hits=${queriesWithHits}/${queries.length} | unique-games=${seenGameIds.size} | detail-fetches=${detailFetches} | complete-1X2=${completedEvents.length} | errors=${detailErrors}`,
  );
  console.log(`2-vägs: basket=${eventsBasket.length} | tennis=${eventsTennis.length}`);
  if (completedEvents.length > 0) {
    console.log(`Exempel-events med komplett 1X2 (3-5 första):`);
    for (const e of completedEvents.slice(0, 5)) {
      console.log(
        `  gameId=${e.gameId} "${e.title}" | 1=${e.odds.home} X=${e.odds.draw} 2=${e.odds.away} (foundBy=${e.foundBy})`,
      );
    }
  }
  if (errorSamples.length > 0) {
    console.log(`Fel-exempel (${errorSamples.length} st, första 5):`);
    for (const err of errorSamples.slice(0, 5)) {
      console.log(`  ${JSON.stringify(err)}`);
    }
  }
  console.log(`========================================`);
  console.log(`Skrev: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("[vbet-action] Fatal:", error);
  process.exit(1);
});
