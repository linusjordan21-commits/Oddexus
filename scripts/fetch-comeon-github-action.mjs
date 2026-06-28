#!/usr/bin/env node
/**
 * Standalone ComeOn-fetcher avsedd att köras i GitHub Actions.
 *
 * Render's IP-block är blockerat av Cloudflare WAF för comeon.com, hajper.com
 * och snabbare.com (HTTP 403 med text/html). GitHub Actions-runners kör på
 * Azure ASN som passerar Cloudflare med stealth-Chromium.
 *
 * Scriptet:
 *   1. Startar headless Chromium med stealth-plugin (för cf_clearance)
 *   2. För varje brand: laddar sajten + söker queries via context.request
 *   3. För varje hittad event-id: hämtar odds-detaljer via RSocket-WebSocket
 *   4. Parsar 1X2 + matchtitel ur svaret
 *   5. Skriver data/comeon-rows.json i format Render-side kan konsumera
 *
 * RSocket-WebSocket-logiken är portad direkt från vite.config.ts (samma
 * funktioner: createRSocketJsonRequest, parseComeOnRowsFromEventPayload,
 * requestComeOnEventsPayload). Vi duplicerar koden här så scriptet är
 * fristående och kan köras isolerat.
 */

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import WebSocket from "ws";
import {
  installHardDeadline,
  writeJsonPreservingCache,
  readAdaptiveLimit,
  buildTuning,
} from "./lib/scrape-guard.mjs";

chromiumExtra.use(StealthPlugin());

const COMEON_BRANDS = [
  { id: "hajper", name: "Hajper", franchiseCode: "SWEDEN_HAJPER", origin: "https://www.hajper.com" },
  { id: "snabbare", name: "Snabbare", franchiseCode: "SWEDEN_SNABBARE", origin: "https://www.snabbare.com" },
  { id: "comeon", name: "ComeOn", franchiseCode: "SWEDEN_COMEON", origin: "https://www.comeon.com" },
  { id: "casinostugan", name: "Casinostugan", franchiseCode: "SWEDEN_CASINOSTUGAN", origin: "https://www.casinostugan.com" },
  { id: "lyllo", name: "Lyllo", franchiseCode: "SWEDEN_LYLLO", origin: "https://www.lyllocasino.com" },
];

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "comeon-rows.json");
const PINNACLE_FILE = path.join(DATA_DIR, "pinnacle-rows.json");

const FETCH_TIMEOUT_MS = 14_000;
const RSOCKET_TIMEOUT_MS = 14_000;
/**
 * Max antal event-detaljer per brand. Höjt från 30 → 200 efter steg 4 där vi
 * söker dynamiskt på alla upcoming Pinnacle-soccer-team. Bonus Optimizer
 * prewarm:ar ~96 matcher; vi vill ha headroom för att alla ska hittas.
 */
const MAX_EVENTS_PER_BRAND = 200;
/**
 * Antal parallella RSocket-WebSocket-fetches per brand. Sänkt 4→1 efter
 * workflow-körning 16:36Z gav 100% HTTP 429 från GitHub Actions IP-poolen.
 * Lokalt funkar 4 men GitHub-runners delar IP med tusentals andra → striktare
 * rate-limit. Sekventiell WS-handskakning är säkraste regimen.
 */
const CONCURRENCY = (() => {
  const raw = Number(process.env.COMEON_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 32 ? Math.floor(raw) : 1;
})();
/**
 * Antal parallella REST-search-queries per brand. Sänkt 6→2 efter samma
 * workflow-körning visade 215/300 search-HTTP-fel på Hajper/Snabbare och
 * 300/300 på ComeOn. Concurrency 2 ger ~1 req/350ms i kombination med jitter.
 */
const SEARCH_CONCURRENCY = (() => {
  const raw = Number(process.env.COMEON_SEARCH_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 32 ? Math.floor(raw) : 2;
})();
/**
 * Tidsfönster för Pinnacle-driven query-extraction. 48h fångar helgens stora
 * europeiska matcher (>24h bort) som svenska bokmakare faktiskt erbjuder —
 * 24h gav mest sydamerikanska nattmatcher med dålig täckning → låga rows.
 * Kvar under QUERY_LIMIT (150) så IP-belastningen är hanterbar.
 */
const QUERY_LOOKAHEAD_HOURS = 48;
/** Hård tak (ceiling) på antal queries per brand — adaptiv budget växer upp hit. */
const QUERY_LIMIT = (() => {
  const raw = Number(process.env.COMEON_QUERY_LIMIT);
  return Number.isFinite(raw) && raw >= 5 && raw <= 1000 ? Math.floor(raw) : 150;
})();
/** Golv för den adaptiva budgeten. */
const MIN_QUERY_LIMIT = (() => {
  const raw = Number(process.env.COMEON_MIN_QUERY_LIMIT);
  return Number.isFinite(raw) && raw >= 5 && raw <= QUERY_LIMIT ? Math.floor(raw) : 40;
})();
/**
 * Random jitter (ms) mellan search-anrop, läggs på efter att en query
 * resolverat. Sprider ut bursts så vi inte triggar /minute-limit på Cloudflare.
 */
const SEARCH_JITTER_MIN_MS = 200;
const SEARCH_JITTER_MAX_MS = 400;
/** 429-retry: max antal försök totalt (inklusive första), och bas-delay i ms. */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomJitter() {
  return SEARCH_JITTER_MIN_MS + Math.random() * (SEARCH_JITTER_MAX_MS - SEARCH_JITTER_MIN_MS);
}

/**
 * Bygg dynamisk query-lista från Pinnacle-data: unika homeTeam-namn för
 * soccer-matcher som börjar inom QUERY_LOOKAHEAD_HOURS. Pinnacle uppdateras
 * var 1-2 min av en parallell workflow (.github/workflows/pinnacle-fetch.yml)
 * så datasetet är alltid färskt vid scrape-start.
 *
 * Diagnos visade att search-endpointen är symmetrisk: search för homeTeam
 * returnerar samma eventId som search för awayTeam. Vi börjar därför med
 * homeTeam-only — om täckning brister kan COMEON_QUERY_AWAY=1 läggas till
 * i framtiden för redundans.
 */
function buildDynamicQueriesFromPinnacle(sportTag = "soccer", limit = QUERY_LIMIT) {
  const fallback = sportTag === "soccer" ? ["Brighton", "Aston Villa", "Manchester United"] : [];
  let parsed;
  try {
    if (!fs.existsSync(PINNACLE_FILE)) {
      console.warn(`[comeon-action] ${PINNACLE_FILE} saknas — fallback till hardcoded queries`);
      return fallback;
    }
    parsed = JSON.parse(fs.readFileSync(PINNACLE_FILE, "utf-8"));
  } catch (error) {
    console.warn(
      `[comeon-action] kunde inte läsa pinnacle-rows.json: ${error?.message ?? error} — fallback till hardcoded queries`,
    );
    return fallback;
  }
  const matchups = parsed?.bySport?.[sportTag]?.matchups;
  if (!Array.isArray(matchups)) {
    console.warn(`[comeon-action] pinnacle saknar bySport.${sportTag}.matchups — fallback`);
    return fallback;
  }
  const now = Date.now();
  const cutoffMin = now - 2 * 60 * 60 * 1000; // -2h så pågående matcher fångas
  const cutoffMax = now + QUERY_LOOKAHEAD_HOURS * 60 * 60 * 1000;
  const seen = new Set();
  const queries = [];
  for (const m of matchups) {
    const startMs = Date.parse(m?.startTime ?? "");
    if (!Number.isFinite(startMs) || startMs < cutoffMin || startMs > cutoffMax) continue;
    const home = m?.participants?.find?.((p) => p?.alignment === "home")?.name;
    if (!home || typeof home !== "string") continue;
    // Strippa parens-suffix: "Junior de Barranquilla (Corners)" → "Junior de Barranquilla"
    const cleaned = home.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    if (cleaned.length < 3) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(cleaned);
  }
  if (queries.length === 0) {
    console.warn(`[comeon-action] inga upcoming ${sportTag}-matcher i pinnacle — fallback`);
    return fallback;
  }
  return queries.slice(0, limit);
}

/**
 * Promise-baserad concurrency-limiter. Kör `worker(item)` parallellt med max
 * `limit` samtidigt aktiva. Return-array bevarar input-ordning.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = [];
  const workerCount = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < workerCount; w += 1) {
    runners.push(
      (async () => {
        while (true) {
          const i = nextIndex;
          nextIndex += 1;
          if (i >= items.length) return;
          results[i] = await worker(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

// ====================================================================
// RSocket-WebSocket-helpers (kopia från vite.config.ts:579-783)
// ====================================================================

function createRSocketJsonRequest(streamId, route, payload) {
  const routeMetadata = Buffer.concat([Buffer.from([route.length]), Buffer.from(route)]);
  const data = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + 2 + 4 + 3 + routeMetadata.length + data.length);
  let offset = 0;
  frame.writeUInt32BE(streamId, offset);
  offset += 4;
  frame[offset] = 0x19;
  frame[offset + 1] = 0x00;
  offset += 2;
  frame.writeUInt32BE(100000, offset);
  offset += 4;
  frame.writeUIntBE(routeMetadata.length, offset, 3);
  offset += 3;
  routeMetadata.copy(frame, offset);
  offset += routeMetadata.length;
  data.copy(frame, offset);
  return frame;
}

function extractJsonPayloadFromRSocketFrame(data) {
  const text = Buffer.from(data).toString("utf-8");
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  return JSON.parse(text.slice(start));
}

function comeOnEventTitle(event) {
  if (!event) return "";
  const participants = Object.values(event.primaryParticipants ?? {});
  const home = participants.find((p) => (p.venueRole ?? "").toLowerCase() === "home")?.name;
  const away = participants.find((p) => (p.venueRole ?? "").toLowerCase() === "away")?.name;
  if (home && away) return `${home} - ${away}`;
  if (participants.length >= 2) {
    const ordered = [...participants].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (ordered[0]?.name && ordered[1]?.name) return `${ordered[0].name} - ${ordered[1].name}`;
  }
  return event.eventName ?? "";
}

function comeOnEventTeams(event) {
  if (!event) return { home: "", away: "" };
  const participants = Object.values(event.primaryParticipants ?? {});
  const home = participants.find((p) => (p.venueRole ?? "").toLowerCase() === "home")?.name ?? "";
  const away = participants.find((p) => (p.venueRole ?? "").toLowerCase() === "away")?.name ?? "";
  if (home || away) return { home, away };
  const ordered = [...participants].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { home: ordered[0]?.name ?? "", away: ordered[1]?.name ?? "" };
}

function normalizeComeOnOutcomeKey(outcomeType) {
  const s = (outcomeType ?? "").trim().toLowerCase();
  if (s === "home" || s === "h" || s === "1") return "Home";
  if (s === "tie" || s === "draw" || s === "x") return "Tie";
  if (s === "away" || s === "a" || s === "2") return "Away";
  if (/\bhome\b|hem|hemma|hemmalag/.test(s)) return "Home";
  if (/\baway\b|bort|bortalag/.test(s)) return "Away";
  if (/\b(draw|tie|oavgjort|lika)\b/.test(s)) return "Tie";
  return null;
}

function comeOnSelectionDecimalOdds(selection) {
  const raw = selection.trueOdds ?? selection.odds ?? selection.decimalOdds;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function isComeOnMainMatchOddsMarket(marketTypeId) {
  if (marketTypeId === undefined || marketTypeId === null) return true;
  if (typeof marketTypeId === "string" && marketTypeId.trim() === "") return true;
  const n = Number(marketTypeId);
  return Number.isFinite(n) && n === 1;
}

let COMEON_EVENT_KEYS_LOGGED = false;
function comeOnEventStart(event) {
  if (!event) return null;
  const raw =
    event.startingOn ?? event.start ?? event.startTime ?? event.startDate ?? event.startsAt ??
    event.beginsAt ?? event.scheduledStart ?? event.eventStart ?? event.kickoffTime ??
    event.startEventDate ?? null;
  if (raw == null) return null;
  if (typeof raw === "number") {
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parsa Totals (Over/Under mål) ur ComeOn-selections. marketTypeId=17,
 * outcomeType Over/Under, linjen i points/line/handicap. Finns redan i
 * marketGroupIds:[1]-svaret → ingen extra last. Returnerar [{line,over,under}].
 */
function parseComeOnTotals(selections) {
  const byLine = new Map();
  for (const s of selections ?? []) {
    if (Number(s.marketTypeId) !== 17) continue;
    const price = comeOnSelectionDecimalOdds(s);
    if (price == null || !(price > 1)) continue;
    const st = String(s.status ?? "").trim().toLowerCase();
    if (st && /^(closed|settled|suspended|void|inactive|cancel|cancelled|disabled)$/i.test(st)) continue;
    const line = Number(s.points ?? s.line ?? s.handicap);
    if (!Number.isFinite(line)) continue;
    const ot = String(s.outcomeType ?? "").trim().toLowerCase();
    const e = byLine.get(line) ?? { line };
    if (ot === "over") e.over = price;
    else if (ot === "under") e.under = price;
    byLine.set(line, e);
  }
  return [...byLine.values()].filter((e) => e.over > 1 && e.under > 1);
}

/**
 * Parsa Asian Handicap ur ComeOn-selections. marketTypeId=16; outcomeType är
 * TOMT, men name = "<lag> (+0.5)" och points = lagets handikapp. Två selections
 * per marketId (ett lag var). Vi matchar lagnamnet mot eventets home/away och
 * bygger {line (HEMMA-perspektiv), home, away}. Finns i [1]-svaret → ingen last.
 */
function parseComeOnAh(selections, teams) {
  if (!teams?.home || !teams?.away) return [];
  const homeN = String(teams.home).toLowerCase();
  const awayN = String(teams.away).toLowerCase();
  const byMarket = new Map();
  for (const s of selections ?? []) {
    if (Number(s.marketTypeId) !== 16) continue;
    const price = comeOnSelectionDecimalOdds(s);
    if (price == null || !(price > 1)) continue;
    const st = String(s.status ?? "").trim().toLowerCase();
    if (st && /^(closed|settled|suspended|void|inactive|cancel|cancelled|disabled)$/i.test(st)) continue;
    const pts = Number(s.points ?? s.line ?? s.handicap);
    if (!Number.isFinite(pts)) continue;
    const selTeam = String(s.name ?? "").split("(")[0].trim().toLowerCase();
    if (!selTeam) continue;
    const g = byMarket.get(String(s.marketId ?? "")) ?? {};
    if (homeN.includes(selTeam) || selTeam.includes(homeN)) { g.home = price; g.homeLine = pts; }
    else if (awayN.includes(selTeam) || selTeam.includes(awayN)) { g.away = price; }
    byMarket.set(String(s.marketId ?? ""), g);
  }
  const out = [];
  for (const g of byMarket.values()) {
    if (g.home > 1 && g.away > 1 && Number.isFinite(g.homeLine)) out.push({ line: g.homeLine, home: g.home, away: g.away });
  }
  return out;
}

function parseComeOnRowsFromEventPayload(data) {
  const root = data;
  const payload = root[0]?.payload;
  const event = payload?.events?.[0];
  const start = comeOnEventStart(event);
  if (!COMEON_EVENT_KEYS_LOGGED && event && !start) {
    COMEON_EVENT_KEYS_LOGGED = true;
    console.log("[comeon-action] DEBUG: ingen starttid hittad, event-nycklar:", JSON.stringify(Object.keys(event)));
  }
  const title = comeOnEventTitle(event);
  const teams = comeOnEventTeams(event);
  const selections = payload?.selections ?? [];
  // KALIBRERINGS-DIAG (en gång): visar vilka marknader/utfall/linjer som faktiskt
  // kommer med marketGroupIds:[1] → ser om totals (Over/Under) + AH (Home/Away med
  // linje) finns i svaret eller om vi måste be om fler market-grupper.
  const totals = parseComeOnTotals(selections);
  const ah = parseComeOnAh(selections, teams);
  const oddsByOutcome = {};
  for (const selection of selections) {
    if (!isComeOnMainMatchOddsMarket(selection.marketTypeId)) continue;
    const price = comeOnSelectionDecimalOdds(selection);
    if (price == null) continue;
    const st = String(selection.status ?? "").trim().toLowerCase();
    if (st && /^(closed|settled|suspended|void|inactive|cancel|cancelled|disabled)$/i.test(st)) continue;
    const key = normalizeComeOnOutcomeKey(selection.outcomeType);
    if (!key) continue;
    oddsByOutcome[key] = price;
  }
  const home = oddsByOutcome.Home;
  const draw = oddsByOutcome.Tie;
  const away = oddsByOutcome.Away;
  if (!(home && draw && away && home > 1 && draw > 1 && away > 1)) {
    return { ok: false, title, teams, start, eventLeagueId: event?.leagueId ?? null };
  }
  return {
    ok: true,
    title,
    teams,
    start,
    eventLeagueId: event?.leagueId ?? null,
    odds: { home, draw, away },
    totals,
    ah,
  };
}

function normalizeComeOnEventId(eventId) {
  return /^\d+$/.test(eventId) ? Number(eventId) : eventId;
}

/**
 * Wrapper kring rsocketRequestOnce med 429-retry/backoff. WS-handskakningen
 * kastar `Error` med "Unexpected server response: 429" när vi blir rate-
 * limitade — vi parsar message och retry:ar exponentiellt.
 */
async function requestComeOnEventsPayload(origin, franchiseCode, payload, timeoutMs = RSOCKET_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await rsocketRequestOnce(origin, franchiseCode, payload, timeoutMs);
    } catch (error) {
      lastError = error;
      const msg = error?.message ?? String(error);
      const is429 = /\b429\b/.test(msg);
      const isRetryable = is429 || /\b5\d\d\b|timeout|ECONN|ETIMEDOUT|ENETUNREACH/i.test(msg);
      if (attempt < RETRY_MAX_ATTEMPTS && isRetryable) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("rsocket retry exhausted");
}

async function rsocketRequestOnce(origin, franchiseCode, payload, timeoutMs) {
  const setupFrame = Buffer.from(
    "000000000400000100000000ea600001d4c01c6d6573736167652f782e72736f636b65742e726f7574696e672e7630106170706c69636174696f6e2f6a736f6e",
    "hex",
  );
  const requestFrame = createRSocketJsonRequest(1, "/v4/events", payload);

  const hostname = new URL(origin).hostname;
  const websocketUrl = `wss://${hostname}/sportsbook-api/websocket?franchiseCode=${franchiseCode}&locale=sv`;
  const socket = new WebSocket(websocketUrl);
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`ComeOn websocket timeout efter ${timeoutMs}ms (${hostname})`));
    }, timeoutMs);
    socket.on("open", () => {
      socket.send(setupFrame);
      socket.send(requestFrame);
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`ComeOn websocket error (${hostname}): ${err?.message ?? err}`));
    });
    socket.on("message", (data) => {
      try {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const json = extractJsonPayloadFromRSocketFrame(buffer);
        if (!json) return;
        clearTimeout(timeout);
        socket.close();
        resolve(json);
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });
  });
}

// ====================================================================
// Search (HTTP REST)
// ====================================================================

async function ensureClearance(page, context, originUrl, brandLabel) {
  // 6 försök × 2s = 12s. comeon.com clearar på ~2-4s. Övriga brands
  // (Hajper/Snabbare/Casinostugan/Lyllo) får ALDRIG cf_clearance men deras
  // search+RSocket-API funkar ändå utan den → ingen mening att vänta 60s.
  // Sänkt 30→6 sparar ~190s/körning (4 brands × ~48s) så ComeOn håller sig
  // under systemd-timeouten även med fotboll+basket+tennis.
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await page.waitForTimeout(2_000);
    const title = await page.title().catch(() => "");
    const cookies = await context.cookies(originUrl).catch(() => []);
    const hasClearance = cookies.some(
      (c) => c.name === "cf_clearance" || c.name === "__cf_bm",
    );
    if (hasClearance && !/just a moment|attention required|cloudflare/i.test(title)) {
      console.log(
        `[comeon-action] ${brandLabel}: Cloudflare cleared (cookies: ${cookies.length}, efter ${(attempt + 1) * 2}s)`,
      );
      return { hasClearance: true, title, cookieCount: cookies.length };
    }
    if (attempt === 0) {
      console.log(`[comeon-action] ${brandLabel}: väntar på Cloudflare clearance...`);
    }
    // Putta en fastnad challenge genom EN omladdning vid ~6s.
    if (attempt === 2) {
      console.log(
        `[comeon-action] ${brandLabel}: challenge kvar efter ${(attempt + 1) * 2}s — laddar om sidan`,
      );
      await page
        .reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
        .catch(() => {});
    }
  }
  const lastTitle = await page.title().catch(() => "");
  console.warn(
    `[comeon-action] ${brandLabel}: clearance saknas efter timeout (titel: "${lastTitle}")`,
  );
  return { hasClearance: false, title: lastTitle, cookieCount: 0 };
}

async function searchForMatch(context, brand, query, sportId = 1) {
  const url = `${brand.origin}/sportsbook-search-service/public/search?franchiseCode=${encodeURIComponent(
    brand.franchiseCode,
  )}&locale=sv&query=${encodeURIComponent(query)}&eventTypes=Fixture&sportIds=${sportId}`;
  // Retry-loop: HTTP 429 är rate-limit → vänta exponentiellt och försök igen.
  // Andra fel (timeout, 5xx, network) får också en retry men med samma delay.
  let lastResult = { ok: false, status: null, error: "no attempts", events: [] };
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await context.request.get(url, {
        headers: { accept: "application/json", origin: brand.origin, referer: `${brand.origin}/` },
        timeout: FETCH_TIMEOUT_MS,
      });
      const status = response.status();
      if (status === 429 || status >= 500) {
        const bodyPrefix = (await response.text()).slice(0, 200);
        lastResult = { ok: false, status, bodyPrefix, events: [] };
        if (attempt < RETRY_MAX_ATTEMPTS) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
          await sleep(delay);
          continue;
        }
        break;
      }
      if (status < 200 || status >= 300) {
        const bodyPrefix = (await response.text()).slice(0, 200);
        return { ok: false, status, bodyPrefix, events: [] };
      }
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        return { ok: false, status, parseError: String(parseErr), events: [] };
      }
      const events = (data?.events ?? [])
        .filter((event) => (event.sportId == null || event.sportId === sportId) && (event.id || event.eventId))
        .map((event) => ({
          id: String(event.id ?? event.eventId),
          leagueId: event.leagueId ?? null,
          sportId: event.sportId ?? null,
        }));
      // Jitter mellan lyckade calls för att sprida ut load och inte trigga
      // /minute-limit. Endast efter success — vi vill inte fördröja vid retry.
      await sleep(randomJitter());
      return { ok: true, status, events };
    } catch (error) {
      lastResult = { ok: false, status: null, error: error?.message ?? String(error), events: [] };
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
        await sleep(delay);
        continue;
      }
    }
  }
  return lastResult;
}

// ====================================================================
// Per-brand orchestration
// ====================================================================

async function fetchBrand(context, brand, queries) {
  const brandLabel = `${brand.id} (${brand.franchiseCode})`;
  const brandStart = Date.now();
  const page = await context.newPage();
  console.log(`[comeon-action] ${brandLabel}: öppnar ${brand.origin}...`);
  await page.goto(brand.origin, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
    console.warn(`[comeon-action] ${brandLabel}: navigeringsfel: ${err?.message ?? err}`);
  });
  const pageStatus = await ensureClearance(page, context, brand.origin, brandLabel);

  // Steg A: search per query → samla event-IDs (deduplicera)
  // Parallelliserat med SEARCH_CONCURRENCY för att hålla pipeline-tiden nere
  // när query-listan är ~300 lång.
  const searchStart = Date.now();
  const searchSummary = { totalEvents: 0, httpErrors: 0, parseErrors: 0, queriesWithHits: 0 };
  const seenEventIds = new Set();
  const candidateEvents = []; // { eventId, leagueId, foundBy }
  const searchResults = await mapLimit(queries, SEARCH_CONCURRENCY, async (query) => {
    const result = await searchForMatch(context, brand, query);
    return { query, result };
  });
  for (const { query, result } of searchResults) {
    if (!result.ok) {
      if (result.status && result.status >= 400) searchSummary.httpErrors += 1;
      else if (result.parseError) searchSummary.parseErrors += 1;
      continue;
    }
    searchSummary.totalEvents += result.events.length;
    if (result.events.length > 0) searchSummary.queriesWithHits += 1;
    for (const e of result.events) {
      if (seenEventIds.has(e.id)) continue;
      seenEventIds.add(e.id);
      candidateEvents.push({ eventId: e.id, leagueId: e.leagueId, foundBy: query });
    }
  }
  await page.close().catch(() => {});
  const searchMs = Date.now() - searchStart;

  // Steg B: hämta odds-detaljer per kandidat-event via RSocket-WebSocket
  // Parallelliserat med CONCURRENCY samtidiga sockets för att hålla
  // pipeline-tiden under GitHub Actions 9-min timeout även för full skala
  // (3 brands × 96 queries ≈ 288 events).
  const detailStart = Date.now();
  const limited = candidateEvents.slice(0, MAX_EVENTS_PER_BRAND);

  const detailResults = await mapLimit(limited, CONCURRENCY, async (cand) => {
    try {
      const payload = await requestComeOnEventsPayload(brand.origin, brand.franchiseCode, {
        filters: {
          eventIds: [normalizeComeOnEventId(cand.eventId)],
          marketGroupIds: [1],
          includeEntities: ["MARKET", "SELECTION"],
        },
        orders: [null],
      });
      const parsed = parseComeOnRowsFromEventPayload(payload);
      if (parsed.ok) {
        return {
          kind: "ok",
          event: {
            eventId: cand.eventId,
            leagueId: parsed.eventLeagueId ?? cand.leagueId,
            title: parsed.title,
            homeTeam: parsed.teams.home,
            awayTeam: parsed.teams.away,
            startTime: parsed.start ?? null,
            odds: parsed.odds,
            ...(parsed.totals?.length ? { totals: parsed.totals } : {}),
            ...(parsed.ah?.length ? { ah: parsed.ah } : {}),
            foundBy: cand.foundBy,
          },
        };
      }
      return {
        kind: "err",
        error: {
          eventId: cand.eventId,
          reason: parsed.title ? "incomplete-1x2" : "no-event-data",
          title: parsed.title,
        },
      };
    } catch (error) {
      return {
        kind: "err",
        error: {
          eventId: cand.eventId,
          reason: "rsocket-error",
          error: error?.message ?? String(error),
        },
      };
    }
  });

  const completedEvents = [];
  const detailErrors = [];
  for (const r of detailResults) {
    if (r.kind === "ok") completedEvents.push(r.event);
    else detailErrors.push(r.error);
  }
  const detailMs = Date.now() - detailStart;
  const totalMs = Date.now() - brandStart;

  return {
    brand: brand.id,
    bookmaker: brand.name,
    franchiseCode: brand.franchiseCode,
    pageStatus,
    searchSummary: {
      ...searchSummary,
      uniqueCandidates: candidateEvents.length,
    },
    detailSummary: {
      attempted: limited.length,
      completed: completedEvents.length,
      errors: detailErrors.length,
      concurrency: CONCURRENCY,
    },
    timing: { totalMs, searchMs, detailMs },
    events: completedEvents,
    detailErrors: detailErrors.slice(0, 10),
  };
}

// ====================================================================
// Main
// ====================================================================

/**
 * Parse 2-vägs moneyline (basket/tennis) ur en ComeOn /v4/events-payload.
 * Grupperar selections per marketTypeId och väljer gruppen med EXAKT
 * {Home, Away} och INGEN Tie (utesluter 1x2-regulation), line≈0 (utesluter
 * handikapp/totals). Basket "Vinnare inkl övertid" = marketTypeId 206.
 */
function parseComeOnMoneyline2Way(data) {
  const payload = data?.[0]?.payload;
  const event = payload?.events?.[0];
  const start = comeOnEventStart(event);
  const title = comeOnEventTitle(event);
  const teams = comeOnEventTeams(event);
  const selections = payload?.selections ?? [];
  const byMarket = new Map();
  for (const s of selections) {
    const price = comeOnSelectionDecimalOdds(s);
    if (price == null) continue;
    const st = String(s.status ?? "").trim().toLowerCase();
    if (st && /^(closed|settled|suspended|void|inactive|cancel|cancelled|disabled)$/i.test(st)) continue;
    const line = Number(s.points ?? s.line ?? s.handicap ?? 0);
    if (Number.isFinite(line) && Math.abs(line) > 0.01) continue; // hoppa handikapp/totals
    const key = normalizeComeOnOutcomeKey(s.outcomeType);
    if (!key) continue;
    const mid = String(s.marketTypeId ?? "");
    if (!byMarket.has(mid)) byMarket.set(mid, {});
    byMarket.get(mid)[key] = price;
  }
  let odds = null;
  for (const [, o] of byMarket) {
    if (o.Home > 1 && o.Away > 1 && o.Tie == null) { odds = { home: o.Home, away: o.Away }; break; }
  }
  if (!odds) return { ok: false, title, teams, start, eventLeagueId: event?.leagueId ?? null };
  return { ok: true, title, teams, start, eventLeagueId: event?.leagueId ?? null, odds };
}

/**
 * Hämta 2-vägs events (basket/tennis) för en brand. Återanvänder den redan
 * Cloudflare-clearade contexten (kör efter fetchBrand). Egen search+RSocket-
 * loop så fotbollens fetchBrand rörs inte.
 */
async function fetchBrand2WaySport(context, brand, queries, sportId, sportTag) {
  if (!queries.length) return [];
  const seen = new Set();
  const candidates = [];
  const searchResults = await mapLimit(queries, SEARCH_CONCURRENCY, async (q) => ({ q, r: await searchForMatch(context, brand, q, sportId) }));
  for (const { r } of searchResults) {
    if (!r.ok) continue;
    for (const e of r.events) {
      if (e.sportId != null && e.sportId !== sportId) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      candidates.push({ eventId: e.id, leagueId: e.leagueId });
    }
  }
  const limited = candidates.slice(0, MAX_EVENTS_PER_BRAND);
  const results = await mapLimit(limited, CONCURRENCY, async (cand) => {
    try {
      const payload = await requestComeOnEventsPayload(brand.origin, brand.franchiseCode, {
        filters: { eventIds: [normalizeComeOnEventId(cand.eventId)], marketGroupIds: [1], includeEntities: ["MARKET", "SELECTION"] },
        orders: [null],
      });
      const parsed = parseComeOnMoneyline2Way(payload);
      if (!parsed.ok || !parsed.odds) return null;
      return {
        eventId: String(cand.eventId),
        title: parsed.title,
        homeTeam: parsed.teams?.home ?? null,
        awayTeam: parsed.teams?.away ?? null,
        startTime: parsed.start ?? null,
        league: null,
        sport: sportTag,
        odds: parsed.odds,
      };
    } catch { return null; }
  });
  return results.filter(Boolean);
}

async function main() {
  const runStart = Date.now();
  // Tidsbudget: sluta scrapa nya brands efter denna tid och skriv det vi
  // hunnit, så jobbet ALLTID når write+commit innan GHA timeout-minutes (20)
  // dödar processen mitt i sista brandet (vilket gjorde ComeOn stale: data
  // hämtades men sparades aldrig). Default 16 min ger ~4 min marginal.
  const RUN_BUDGET_MS = Number(process.env.COMEON_RUN_BUDGET_MS) || 16 * 60 * 1000;
  // Adaptiv query-budget: läs förra körningens utfall ur comeon-rows.json:s
  // _tuning. Träffade vi deadline krymper budgeten; gick det snabbt växer den.
  const { limit: effectiveLimit } = readAdaptiveLimit({
    file: OUTPUT_FILE,
    defaultLimit: QUERY_LIMIT,
    minLimit: MIN_QUERY_LIMIT,
    maxLimit: QUERY_LIMIT,
    label: "comeon-action",
  });
  const queries = buildDynamicQueriesFromPinnacle("soccer", effectiveLimit);
  const basketQueries = buildDynamicQueriesFromPinnacle("basketball");
  const tennisQueries = buildDynamicQueriesFromPinnacle("tennis");
  console.log(
    `[comeon-action] Query-strategi: pinnacle-driven (homeTeam, ${QUERY_LOOKAHEAD_HOURS}h fönster, budget ${effectiveLimit}/${QUERY_LIMIT})`,
  );
  console.log(`[comeon-action] Antal queries: ${queries.length} soccer · ${basketQueries.length} basket · ${tennisQueries.length} tennis`);
  console.log(`[comeon-action] Första 10 queries: ${JSON.stringify(queries.slice(0, 10))}`);
  console.log(
    `[comeon-action] Concurrency: search=${SEARCH_CONCURRENCY} detail=${CONCURRENCY} (override via COMEON_SEARCH_CONCURRENCY / COMEON_CONCURRENCY)`,
  );

  // Muterbar progress: byggs upp brand-för-brand. Både normal slutförd körning
  // och hard-deadline-backstoppet skriver från denna.
  const byFranchise = {};
  const summaryRows = [];
  let hitDeadline = false;

  const writeOutput = (sourceTag = "github-actions") => {
    const totalEvents = Object.values(byFranchise).reduce(
      (n, fr) => n + (fr.events?.length ?? 0) + (fr.eventsBasket?.length ?? 0) + (fr.eventsTennis?.length ?? 0),
      0,
    );
    const payload = {
      updatedAt: new Date().toISOString(),
      source: sourceTag,
      // Hälsoflagga: true = avbruten av hard-deadline → ev. saknade brands.
      partial: String(sourceTag).includes("partial"),
      queryStrategy: "pinnacle-home-team",
      queryLookaheadHours: QUERY_LOOKAHEAD_HOURS,
      queryCount: queries.length,
      concurrency: CONCURRENCY,
      searchConcurrency: SEARCH_CONCURRENCY,
      byFranchise,
      _tuning: buildTuning({ limitUsed: effectiveLimit, runStart, deadlineMs: HARD_DEADLINE_MS, hitDeadline }),
    };
    writeJsonPreservingCache(OUTPUT_FILE, payload, {
      label: "comeon-action",
      isEmpty: () => totalEvents === 0,
      countOf: () => totalEvents,
    });
  };

  // Preemptiv backstop UTÖVER RUN_BUDGET_MS: om en enskild operation hänger (så
  // att den kooperativa budget-checken aldrig hinner köra) sparar deadline:n det
  // som hunnit samlas och avslutar rent (exit 0) före jobbets timeout (20 min).
  const HARD_DEADLINE_MS = Number(process.env.COMEON_DEADLINE_MS) || 18 * 60 * 1000;
  const deadline = installHardDeadline({
    budgetMs: HARD_DEADLINE_MS,
    label: "comeon-action",
    onDeadline: () => {
      hitDeadline = true;
      writeOutput("github-actions-partial-deadline");
    },
  });

  console.log("[comeon-action] Startar headless Chromium med stealth...");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "sv-SE",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  for (const brand of COMEON_BRANDS) {
    if (Date.now() - runStart > RUN_BUDGET_MS) {
      console.warn(
        `[comeon-action] Tidsbudget nådd — hoppar återstående brands, skriver ${Object.keys(byFranchise).length}/${COMEON_BRANDS.length} hunna.`,
      );
      break;
    }
    try {
      const result = await fetchBrand(context, brand, queries);
      let eventsBasket = [];
      let eventsTennis = [];
      try { eventsBasket = await fetchBrand2WaySport(context, brand, basketQueries, 2, "basketball"); } catch (e) { console.warn(`[comeon-action] ${brand.id} basket-fel:`, e?.message ?? e); }
      try { eventsTennis = await fetchBrand2WaySport(context, brand, tennisQueries, 6, "tennis"); } catch (e) { console.warn(`[comeon-action] ${brand.id} tennis-fel:`, e?.message ?? e); }
      byFranchise[brand.franchiseCode] = {
        bookmaker: brand.name,
        events: result.events,
        eventsBasket,
        eventsTennis,
      };
      console.log(`[comeon-action] ${brand.id}: ${result.events.length} soccer + ${eventsBasket.length} basket + ${eventsTennis.length} tennis`);
      summaryRows.push(result);
    } catch (error) {
      console.error(
        `[comeon-action] ${brand.id} crashade: ${error instanceof Error ? error.message : error}`,
      );
      byFranchise[brand.franchiseCode] = {
        bookmaker: brand.name,
        events: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  await browser.close();

  // Normal slutförd körning: avbryt deadline och skriv. writeOutput bevarar
  // tidigare cache om 0 events över alla brands (skriver aldrig över med tomt).
  deadline.cancel();
  writeOutput("github-actions");

  // Aggregerade siffror för logg
  let totalSearchHits = 0;
  let totalDetailAttempts = 0;
  let totalCompleted = 0;
  let totalErrors = 0;
  for (const result of summaryRows) {
    totalSearchHits += result.searchSummary?.totalEvents ?? 0;
    totalDetailAttempts += result.detailSummary?.attempted ?? 0;
    totalCompleted += result.detailSummary?.completed ?? 0;
    totalErrors += result.detailSummary?.errors ?? 0;
  }
  const totalRuntimeMs = Date.now() - runStart;

  // Sammanfattning till stdout
  console.log("");
  console.log("============ SAMMANFATTNING ============");
  console.log(`Query-strategi: pinnacle-home-team (${queries.length} queries, ${QUERY_LOOKAHEAD_HOURS}h fönster)`);
  console.log(`Concurrency: search=${SEARCH_CONCURRENCY} detail=${CONCURRENCY}`);
  console.log(`Total runtime: ${(totalRuntimeMs / 1000).toFixed(1)}s`);
  console.log(
    `Aggregerat: search-hits=${totalSearchHits} | detail-fetches=${totalDetailAttempts} | complete-1X2=${totalCompleted} | errors=${totalErrors}`,
  );
  console.log(`----------------------------------------`);
  for (const result of summaryRows) {
    const ps = result.pageStatus ?? {};
    const ss = result.searchSummary ?? {};
    const ds = result.detailSummary ?? {};
    const tm = result.timing ?? {};
    console.log(
      `  ${result.brand.padEnd(10)} | clearance=${ps.hasClearance} cookies=${ps.cookieCount} | search: ${ss.totalEvents} hits / ${ss.uniqueCandidates} unique / ${ss.queriesWithHits ?? "?"} queries-with-hits (http-fel: ${ss.httpErrors}, parse-fel: ${ss.parseErrors}) | odds-detail: ${ds.completed}/${ds.attempted} OK (errors: ${ds.errors}) | timing: total=${((tm.totalMs ?? 0) / 1000).toFixed(1)}s search=${((tm.searchMs ?? 0) / 1000).toFixed(1)}s detail=${((tm.detailMs ?? 0) / 1000).toFixed(1)}s`,
    );
    if (result.events && result.events.length > 0) {
      console.log(`    Exempel-events med komplett 1X2 (3-5 första):`);
      for (const e of result.events.slice(0, 5)) {
        console.log(
          `      eventId=${e.eventId} leagueId=${e.leagueId} "${e.title}" | 1=${e.odds.home} X=${e.odds.draw} 2=${e.odds.away} (foundBy=${e.foundBy})`,
        );
      }
    }
    if (result.detailErrors && result.detailErrors.length > 0) {
      console.log(`    Detail-fel (${result.detailErrors.length} st, första 3):`);
      for (const err of result.detailErrors.slice(0, 3)) {
        console.log(
          `      eventId=${err.eventId} reason=${err.reason} ${err.error ? `err="${err.error}"` : err.title ? `title="${err.title}"` : ""}`,
        );
      }
    }
  }
  console.log(`========================================`);
  console.log(`Skrev: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("[comeon-action] Fatal:", error);
  process.exit(1);
});
