#!/usr/bin/env node
/**
 * Standalone Betsson-grupp-fetcher för GitHub Actions.
 *
 * Render-IP är blockerad av Cloudflare WAF för Betsson-syskonen
 * (bethard.com, spelklubben.se, betsson.com — HTTP 403 på HTML-sidan).
 * GitHub Actions Azure-runners passerar med stealth-Chromium.
 *
 * Pipeline (samma protokoll som vite.config.ts:scrapeBetssonBookmaker):
 *   1. Stealth Chromium → ladda en av flera context-URL:er
 *   2. Vänta på Cloudflare clearance
 *   3. Hämta page HTML → extrahera <iframe src="...playground.net..."> URL
 *   4. Ladda iframe → extrahera window.obgClientEnvironmentConfig
 *   5. Bygg REST-headers (brandid, x-sb-* etc) från config
 *   6. Per query: GET /api/sb/v2/search/suggestions → eventIds (fotboll)
 *   7. Per eventId: GET /api/sb/v1/widgets/event/v2 → title/teams
 *   8. Per eventId: GET /api/sb/v1/widgets/accordion/v1?groupableId=MW3W → 1X2
 *   9. Skriv data/betsson-rows.json
 *
 * En enda cache-fil för båda Bethard + Spelklubben — de delar samma underlying
 * Betsson-grupp-API och returnerar identiska odds.
 *
 * Query-strategin är pinnacle-driven (samma mönster som ComeOn-scriptet).
 */

import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import {
  installHardDeadline,
  writeJsonPreservingCache,
  readAdaptiveLimit,
  buildTuning,
} from "./lib/scrape-guard.mjs";

chromiumExtra.use(StealthPlugin());

/**
 * Context-URL:er att försöka i ordning. Bethard tenderar att ge mest stabil
 * Cloudflare-clearance från GitHub Actions IP-poolen — listas först.
 */
const CONTEXT_URLS = [
  "https://www.bethard.com/sv/sports/sok",
  "https://www.spelklubben.se/sv/betting/",
  "https://www.betsson.com/sv/sport",
  "https://www.nordicbet.com/sv/sportsbook",
  "https://www.betsafe.com/sv/sportsbook",
];

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "betsson-rows.json");
const PINNACLE_FILE = path.join(DATA_DIR, "pinnacle-rows.json");

const FETCH_TIMEOUT_MS = 14_000;
// 30s (sänkt från 60s): en page.goto som tar >30s hänger nästan alltid på en
// Cloudflare-challenge som ändå inte löser — bättre att fela snabbt, försöka
// nästa CONTEXT_URL/retry, och hålla totaltiden under hard-deadline. 60s × flera
// navs × retries kunde ensamt äta hela 9-min-jobbet på en seg Mullvad-dag.
const NAV_TIMEOUT_MS = 30_000;

// Hård intern deadline (ms). Jobbets timeout är 9 min; vi sparar partiell data
// och avslutar rent vid ~7 min så commit-steget hinner köra istället för SIGKILL.
const HARD_DEADLINE_MS = (() => {
  const raw = Number(process.env.BETSSON_DEADLINE_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 7 * 60_000;
})();

/** Tidsfönster för pinnacle-driven queries. */
// Betsson scrapas genom att SÖKA per Pinnacle-match → antalet rader begränsas av
// hur många Pinnacle-fotbollsmatcher som finns i fönstret. Mätning 2026-06-16:
//   48h = 117 Pinnacle-matcher → ~86 Betsson-rader (73% yield, körningen HANN klart)
//   96h = 147 Pinnacle-matcher → ~107+ rader, ryms fortfarande under QUERY_LIMIT
// Vi höjer till 96h för fler rader (gäller hela betsson-gruppen: NordicBet/Bethard/
// Spelklubben/Betsafe som delar denna data). Större fönster = fler obskyra matcher
// men också fler riktiga helgmatcher.
const QUERY_LOOKAHEAD_HOURS = 96;
/** Hård tak (ceiling) på antal queries — adaptiv budget kan växa upp hit. */
const QUERY_LIMIT = (() => {
  const raw = Number(process.env.BETSSON_QUERY_LIMIT);
  // 200 (höjt från 150): 96h-fönstret ger ~147 Pinnacle-matcher, så vi vill ha
  // marginal ovanför taket så det aldrig kapar bort matcher när Pinnacle växer.
  return Number.isFinite(raw) && raw >= 5 && raw <= 1000 ? Math.floor(raw) : 200;
})();
/** Golv för den adaptiva budgeten — krymper aldrig under detta. */
const MIN_QUERY_LIMIT = (() => {
  const raw = Number(process.env.BETSSON_MIN_QUERY_LIMIT);
  return Number.isFinite(raw) && raw >= 5 && raw <= QUERY_LIMIT ? Math.floor(raw) : 40;
})();
/** Max antal event-detaljer per körning. */
const MAX_EVENTS = (() => {
  const raw = Number(process.env.BETSSON_MAX_EVENTS);
  return Number.isFinite(raw) && raw >= 5 && raw <= 1000 ? Math.floor(raw) : 200;
})();
/**
 * Search-concurrency. 3 (höjt från 2): betsson kör numera via Mullvads
 * residential svenska IP (inte GitHubs IP-pool), så 429-risken som motiverade
 * 2 gäller inte längre. Snabbare search → mer tid kvar till detail + basket/tennis.
 */
const SEARCH_CONCURRENCY = (() => {
  const raw = Number(process.env.BETSSON_SEARCH_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 32 ? Math.floor(raw) : 3;
})();
/**
 * Detail-concurrency. 4 (höjt från 2): per-event-latensen över Mullvad var
 * flaskhalsen som fick scrapen att träffa hard-deadline (~8s/event × 100 events
 * vid concurrency 2). Med 4 halveras detail-tiden → körningen hinner klart inom
 * budget och får med tennis-steget. Via Mullvad-IP, inte GitHub-IP → låg 429-risk.
 */
const DETAIL_CONCURRENCY = (() => {
  const raw = Number(process.env.BETSSON_DETAIL_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 32 ? Math.floor(raw) : 4;
})();
/** Random jitter (ms) mellan REST-anrop. */
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 400;
/** 429-retry: 3 försök, exp backoff bas 1s. */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomJitter() {
  return JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
}

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
// Pinnacle-driven queries (samma som ComeOn/VBET)
// ====================================================================

function buildDynamicQueriesFromPinnacle(sportTag = "soccer", limit = QUERY_LIMIT) {
  const fallback = sportTag === "soccer" ? ["Brighton", "Aston Villa", "Manchester United"] : [];
  let parsed;
  try {
    if (!fs.existsSync(PINNACLE_FILE)) {
      console.warn(`[betsson-action] ${PINNACLE_FILE} saknas — fallback`);
      return fallback;
    }
    parsed = JSON.parse(fs.readFileSync(PINNACLE_FILE, "utf-8"));
  } catch (error) {
    console.warn(`[betsson-action] kunde inte läsa pinnacle-rows.json: ${error?.message ?? error}`);
    return fallback;
  }
  const matchups = parsed?.bySport?.[sportTag]?.matchups;
  if (!Array.isArray(matchups)) return fallback;
  const now = Date.now();
  const cutoffMin = now - 2 * 60 * 60 * 1000;
  const cutoffMax = now + QUERY_LOOKAHEAD_HOURS * 60 * 60 * 1000;
  const seen = new Set();
  const queries = [];
  for (const m of matchups) {
    const startMs = Date.parse(m?.startTime ?? "");
    if (!Number.isFinite(startMs) || startMs < cutoffMin || startMs > cutoffMax) continue;
    const home = m?.participants?.find?.((p) => p?.alignment === "home")?.name;
    if (!home || typeof home !== "string") continue;
    const cleaned = home.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    if (cleaned.length < 3) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(cleaned);
  }
  if (queries.length === 0) return fallback;
  return queries.slice(0, limit);
}

// ====================================================================
// Betsson-context-helpers (port av vite.config.ts:802-1037)
// ====================================================================

function extractBetssonIframeUrl(pageHtml) {
  const iframeSrc = /<iframe[^>]+src=["']([^"']*playground\.net[^"']+)["']/i.exec(pageHtml)?.[1];
  if (!iframeSrc) return null;
  return iframeSrc.replace(/&amp;/g, "&");
}

function extractJsonObjectAfterAssignment(html, assignment) {
  const start = html.indexOf(assignment);
  if (start < 0) return null;
  const objectStart = html.indexOf("{", start + assignment.length);
  if (objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < html.length; i += 1) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return html.slice(objectStart, i + 1);
  }
  return null;
}

function buildBetssonHeadersFromConfig(configJson, iframeUrl, pageOriginUrl) {
  const startupContext = JSON.parse(configJson)?.startupContext;
  if (!startupContext) return null;
  const ctx = startupContext.userContext?.contextInformation ?? {};
  return {
    brandid: startupContext.brandId ?? "",
    correlationid: crypto.randomUUID(),
    marketcode: startupContext.market?.slug ?? "sv",
    origin: new URL(iframeUrl).origin,
    "x-obg-channel": ctx.channel ?? "Web",
    "x-obg-device": ctx.deviceType ?? "Desktop",
    "x-sb-app-version": startupContext.appContext?.version ?? "",
    "x-sb-channel": ctx.channel ?? "Web",
    "x-sb-content-id": ctx.interfaceSettings?.["content-ID"] ?? startupContext.brandId ?? "",
    "x-sb-country-code": ctx.countryCode ?? "SE",
    "x-sb-currency-code": ctx.currencyCode ?? "SEK",
    "x-sb-device-type": ctx.deviceType ?? "Desktop",
    "x-sb-frame-ancestors": ctx.frameAncestors ?? new URL(pageOriginUrl).origin,
    "x-sb-jurisdiction": ctx.jurisdiction ?? "",
    "x-sb-language-code": ctx.languageCode ?? "sv",
    "x-sb-segment-id": ctx.segmentId ?? "",
    "x-sb-static-context-id": startupContext.contextId?.staticContextId ?? "",
    "x-sb-type": "b2b",
    "x-sb-user-context-id": startupContext.contextId?.userContextId ?? "",
    ...(startupContext.contextId?.sessionToken ? { sessiontoken: startupContext.contextId.sessionToken } : {}),
  };
}

// ====================================================================
// Parsers (port av vite.config.ts:862-923)
// ====================================================================

function parseBetssonOddsFromAccordion(data) {
  const accordions = data?.data?.accordions ?? {};
  if (!BETSSON_MK_DIAG && accordions && typeof accordions === "object" && Object.keys(accordions).length) {
    BETSSON_MK_DIAG = true;
    const combos = Object.entries(accordions).slice(0, 25).map(([k, v]) => `${k}: sel=${(v?.selections || []).map((s) => s.selectionTemplateId).join("/")} keys=${Object.keys((v?.selections || [])[0] || {}).join(",")}`);
    console.log(`[betsson-action] MARKNADS-DIAG: ${JSON.stringify(combos)}`);
  }
  const accordionKeys = [...new Set(["MW3W", ...Object.keys(accordions)])];
  const tryParse = (selections, allowSuspended) => {
    const oddsByTemplate = Object.fromEntries(
      selections
        .filter((s) => {
          const st = String(s.status ?? "").trim();
          if (!s.selectionTemplateId || s.odds == null) return false;
          if (/^open$/i.test(st)) return true;
          return allowSuspended && /^suspended$/i.test(st);
        })
        .map((s) => [String(s.selectionTemplateId).toUpperCase(), Number(s.odds)]),
    );
    const home = oddsByTemplate.HOME, draw = oddsByTemplate.DRAW, away = oddsByTemplate.AWAY;
    if (!(home > 1 && draw > 1 && away > 1)) return null;
    return { home, draw, away };
  };
  for (const key of accordionKeys) {
    const selections = accordions[key]?.selections ?? [];
    if (selections.length === 0) continue;
    const odds = tryParse(selections, false) ?? tryParse(selections, true);
    if (odds) return odds;
  }
  return null;
}

/**
 * Parse 2-vägs moneyline (basket/tennis) ur en Betsson-accordion. Hittar den
 * accordion vars selections är HOME + AWAY men INGEN DRAW (utesluter 1X2).
 */
function parseBetssonMoneyline2Way(data) {
  const accordions = data?.data?.accordions ?? {};
  const tryParse = (selections, allowSuspended) => {
    const byTpl = {};
    for (const s of selections) {
      const st = String(s.status ?? "").trim();
      if (!s.selectionTemplateId || s.odds == null) continue;
      if (!/^open$/i.test(st) && !(allowSuspended && /^suspended$/i.test(st))) continue;
      byTpl[String(s.selectionTemplateId).toUpperCase()] = Number(s.odds);
    }
    if (byTpl.HOME > 1 && byTpl.AWAY > 1 && byTpl.DRAW == null) return { home: byTpl.HOME, away: byTpl.AWAY };
    return null;
  };
  for (const key of Object.keys(accordions)) {
    const selections = accordions[key]?.selections ?? [];
    if (selections.length === 0) continue;
    const odds = tryParse(selections, false) ?? tryParse(selections, true);
    if (odds) return odds;
  }
  return null;
}

// ====================================================================
// Totals (MTG2W) + Asian Handicap (MAHCP) — parsas ur accordion/v1.
// Linjen ligger i utfallets LABEL (inte selectionSpecifics): totals
// "Över 3.5"/"Under 1.5"; AH "1 (+0.5)"/"2 (-0.5)" (handikapp i parentes).
// Normaliserad form matchar shadowConsensus: totals[{line,over,under}],
// ah[{line,home,away}] (line = hemma-perspektiv, favorit negativ).
// ====================================================================
function betssonSelections(data) {
  const accs = data?.data?.accordions ?? {};
  const out = [];
  for (const v of Object.values(accs)) {
    for (const s of v?.selections ?? []) {
      out.push({
        tpl: String(s.selectionTemplateId ?? s.templateId ?? "").toUpperCase(),
        label: String(s.alternateLabel ?? s.participantLabel ?? s.label ?? "").trim(),
        odds: Number(s.odds),
      });
    }
  }
  return out;
}

function parseBetssonTotals(data) {
  const byLine = new Map();
  for (const s of betssonSelections(data)) {
    if (!(s.odds > 1)) continue;
    const m = s.label.match(/(\d+(?:\.\d+)?)/); // "Över 3.5" → 3.5
    if (!m) continue;
    const line = Number(m[1]);
    if (!Number.isFinite(line) || line <= 0) continue;
    const isOver = s.tpl === "OVER" || /öve?r|over/i.test(s.label);
    const isUnder = s.tpl === "UNDER" || /under/i.test(s.label);
    if (!isOver && !isUnder) continue;
    const rec = byLine.get(line) ?? { line };
    if (isOver) rec.over = s.odds; else rec.under = s.odds;
    byLine.set(line, rec);
  }
  return [...byLine.values()].filter((r) => r.over > 1 && r.under > 1);
}

function parseBetssonAh(data, homeTeam, awayTeam) {
  const hN = String(homeTeam ?? "").toLowerCase().trim();
  const aN = String(awayTeam ?? "").toLowerCase().trim();
  const byLine = new Map();
  for (const s of betssonSelections(data)) {
    if (!(s.odds > 1)) continue;
    const m = s.label.match(/\(([+-]?\d+(?:\.\d+)?)\)/); // "1 (+0.5)" → +0.5
    if (!m) continue;
    const hcap = Number(m[1]);
    if (!Number.isFinite(hcap)) continue;
    const lo = s.label.toLowerCase();
    const isHome = s.tpl.includes("HOME") || /^1\b/.test(s.label) || (hN.length >= 4 && lo.includes(hN.slice(0, 6)));
    const isAway = s.tpl.includes("AWAY") || /^2\b/.test(s.label) || (aN.length >= 4 && lo.includes(aN.slice(0, 6)));
    if (isHome === isAway) continue; // okänd/tvetydig sida
    // line = hemma-perspektiv: home-utfallet bär home-handikappet; away-utfallet
    // bär away-handikappet (= -home) → negera för att få hemma-linjen.
    const line = isHome ? hcap : -hcap;
    const rec = byLine.get(line) ?? { line };
    if (isHome) rec.home = s.odds; else rec.away = s.odds;
    byLine.set(line, rec);
  }
  return [...byLine.values()].filter((r) => r.home > 1 && r.away > 1);
}

let BETSSON_EVENT_KEYS_LOGGED = false;
let BETSSON_MK_DIAG = false;
let BETSSON_REC = false; // engångs-recon: hitta totals/AH-groupableIds
let LINES_DIAG = { ran: false }; // hälsoflagga: körde lines-steget (B2) och med vilket utfall
let LINES_PROBE = null; // diagnostik: in-page fetch HTTP-status (skrivs EJ över av B2)
let ODDS_PROBE = null; // diagnostik: 1X2-detalj in-page fetch-status (första eventet)
function betssonEventStart(ev) {
  if (!ev) return null;
  const raw =
    ev.start ?? ev.startEventDate ?? ev.startDate ?? ev.startsAt ?? ev.beginsAt ??
    ev.scheduledStart ?? ev.eventStart ?? ev.kickoffTime ?? ev.startTime ?? null;
  if (raw == null) return null;
  if (typeof raw === "number") {
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseBetssonTitleFromEvent(data) {
  const ev = data?.data?.event;
  const start = betssonEventStart(ev);
  if (!BETSSON_EVENT_KEYS_LOGGED && ev && !start) {
    BETSSON_EVENT_KEYS_LOGGED = true;
    console.log("[betsson-action] DEBUG: ingen starttid hittad, event-nycklar:", JSON.stringify(Object.keys(ev)));
  }
  const participants = ev?.participants
    ?.slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((p) => p.label?.trim())
    .filter(Boolean);
  if (participants && participants.length >= 2) {
    return { title: participants.join(" - "), homeTeam: participants[0], awayTeam: participants[1], start };
  }
  const label = ev?.label ?? "";
  return { title: label, homeTeam: "", awayTeam: "", start };
}

// ====================================================================
// REST-anrop med retry/jitter
// ====================================================================

async function betssonGetJson(context, url, refererUrl, headers) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await context.request.get(url, {
        headers: {
          ...headers,
          accept: "application/json, text/plain, */*",
          "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
          referer: refererUrl,
        },
        timeout: FETCH_TIMEOUT_MS,
      });
      const status = response.status();
      if (status === 429 || status >= 500) {
        if (attempt < RETRY_MAX_ATTEMPTS) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
          await sleep(delay);
          continue;
        }
        throw new Error(`Upstream status ${status}`);
      }
      if (status < 200 || status >= 300) throw new Error(`Upstream status ${status}`);
      const text = await response.text();
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const msg = error?.message ?? String(error);
      const retryable = /timeout|ECONN|ETIMEDOUT|429|5\d\d/i.test(msg);
      if (attempt < RETRY_MAX_ATTEMPTS && retryable) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("rest retry exhausted");
}

// ====================================================================
// RECON-LÄGE (env BETSSON_RECON_MODE=1): kartlägg alternativa vägar till
// totals/AH. accordion/v1-groupableId-proben (REC) visade att bara MW3W/
// MW2W/DC/BTTS svarar; totals/AH ligger troligen bakom event/v2:s tab-/
// topic-struktur eller en transient markets-topic. Denna recon dumpar rå
// status+body för event/v2 (olika subTabs) + kandidat-endpoints så vi ser
// var marknadskatalogen finns. Helt inert i normal loop (env ej satt).
// ====================================================================
async function betssonRawGet(context, url, ref, headers) {
  try {
    const resp = await context.request.get(url, {
      headers: { ...headers, accept: "application/json, text/plain, */*", "accept-language": "sv-SE,sv;q=0.9,en;q=0.7", referer: ref },
      timeout: FETCH_TIMEOUT_MS,
    });
    const status = resp.status();
    const text = await resp.text();
    return { status, text };
  } catch (e) { return { status: -1, text: `ERR ${e?.message ?? e}` }; }
}

async function betssonRichRecon(context, betsContext, eventId, title, tag) {
  const H = betsContext.headers, ref = betsContext.iframeUrl, b = betsContext.baseUrl;
  let foundMahcp = false;
  console.log(`[betsson-action] RICHREC[${tag}] event=${eventId} title=${JSON.stringify(title)}`);
  // event/v2 subTabs=133 är default-fliken med ALLA marknader inline (för riktiga
  // matcher). Dumpa katalog-strukturen: distinctMarketTemplateTags (id→namn),
  // accordionGrouping (grupp→templateIds) och accordionSummaries (marknader +
  // selections/odds). Detta avslöjar vilket template-id som är totals resp AH.
  const url = `${b}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`;
  const { status, text } = await betssonRawGet(context, url, ref, H);
  let hasMahcp = false;
  try {
    const j = JSON.parse(text); const d = j?.data ?? j;
    const sums = d?.accordionSummaries;
    const entries = Array.isArray(sums) ? sums : Object.entries(sums || {}).map(([k, v]) => ({ _key: k, ...v }));
    const keysPresent = new Set(entries.map((s) => s._key ?? s.id ?? s.accordionId));
    hasMahcp = keysPresent.has("MAHCP");
    console.log(`[betsson-action] RICHREC[${tag}] event/v2 status=${status} acc=${entries.length} hasMAHCP=${hasMahcp} hasMTG2W=${keysPresent.has("MTG2W")}`);
    if (!hasMahcp) return false; // gå vidare till nästa event utan att burst:a
    // GENTLE: hämta bara MTG2W + MAHCP, en i taget med sleep + 403-retry, så vi
    // inte trippar Cloudflare (burst gav 403). Dumpa ALLA selections som mall.
    const summaryByKey = Object.fromEntries(entries.map((s) => [s._key ?? s.id ?? s.accordionId, s]));
    for (const key of ["MTG2W", "MAHCP"]) {
      const s = summaryByKey[key]; if (!s) continue;
      const gid = s.groupableId || key;
      const aurl = `${b}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}&groupableId=${encodeURIComponent(gid)}`;
      let a = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await sleep(1500 + Math.random() * 800);
        a = await betssonRawGet(context, aurl, ref, H);
        if (a.status !== 403) break;
        await sleep(4000); // Cloudflare-backoff
      }
      let dump = a.text.slice(0, 120);
      try {
        const aj = JSON.parse(a.text); const accs = aj?.data?.accordions ?? {};
        dump = Object.entries(accs).map(([k, v]) => `${k}:[${(v?.selections || []).slice(0, 16).map((x) => `${x.selectionTemplateId ?? x.templateId}|${x.alternateLabel ?? x.participantLabel ?? x.label}|spec=${JSON.stringify(x.selectionSpecifics)}|@${x.odds}`).join(" ; ")}]`).join(" || ");
        if (key === "MAHCP" && Object.keys(accs).length) foundMahcp = true;
      } catch { /* icke-JSON */ }
      console.log(`[betsson-action] RICHREC[${tag}] ACCFETCH key=${key} gid=${gid} status=${a.status} sel=${dump} (gotSel=${foundMahcp})`);
    }
  } catch (e) { console.log(`[betsson-action] RICHREC[${tag}] parse-fel: ${e?.message}`); }
  return hasMahcp; // STOP-signal: vi nådde ett MAHCP-event (burst inte vidare)
}

const BETSSON_2WAY_STATS = {};
async function searchEventIds(context, betsContext, query, categoryRe = /^fotboll$/i) {
  const url = `${betsContext.baseUrl}/api/sb/v2/search/suggestions?searchText=${encodeURIComponent(query)}`;
  const data = await betssonGetJson(context, url, betsContext.iframeUrl, betsContext.headers);
  if (!/fotboll/.test(categoryRe.source)) {
    const src = categoryRe.source;
    const st = (BETSSON_2WAY_STATS[src] = BETSSON_2WAY_STATS[src] || { rawMatches: 0, cats: new Set() });
    for (const m of data?.matches ?? []) { st.rawMatches += 1; if (m?.categoryName) st.cats.add(m.categoryName); }
  }
  return [
    ...new Set(
      (data?.matches ?? [])
        .filter((m) => categoryRe.test((m?.categoryName ?? "").trim()))
        .flatMap((m) => m?.state?.eventIds ?? []),
    ),
  ];
}

async function fetchEventTitle(context, betsContext, eventId) {
  const url = `${betsContext.baseUrl}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`;
  const data = await betssonGetJson(context, url, betsContext.iframeUrl, betsContext.headers);
  return parseBetssonTitleFromEvent(data);
}

async function fetchEventOdds2Way(context, betsContext, eventId) {
  // Basket-moneyline = groupableId MW2W; no-groupableId ger tom accordion. Prova
  // flera och låt 2-vägs-parsern välja den med HOME+AWAY (ingen DRAW).
  const base = `${betsContext.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}`;
  const urls = [`${base}&groupableId=MW2W`, `${base}&groupableId=MO`, base];
  for (const url of urls) {
    try {
      const data = await betssonGetJson(context, url, betsContext.iframeUrl, betsContext.headers);
      const odds = parseBetssonMoneyline2Way(data);
      if (odds) return odds;
    } catch { /* prova nästa URL */ }
  }
  return null;
}

// Bästa-möjliga totals (MTG2W) + Asian handicap (MAHCP) för ETT event.
// VIKTIGT (diagnos 2026-06-25): event/v2 listar marknaderna men deras odds hämtas via
// accordion/v1, och DET endpoint-anropet svarar HTTP 403 (Cloudflare-challenge) för
// totals/AH-grupperna — till skillnad från 1X2 (MW3W) som svarar tidigt i körningen.
// Felet är ratelimiting/clearance-degradering när lines-steget kör (~6.5 min in), inte
// fel groupableId. Originalkoden (RICHREC) utforskade detta men lyckades aldrig heller.
// Vi gör en SKONSAM best-effort: accordionGrouping som nyckel + 403-retry med backoff.
// En 403/tom rör ALDRIG 1X2.
// In-page GET från den kvarhållna iframe-sidan (samma origin, full CF-clearance i riktig
// webbläsare → passerar 403 där context.request kan utmanas på TLS/JA3-fingerprint).
async function betssonInPageGet(linesPage, url, headers = {}) {
  if (!linesPage) return { status: -1, text: "" };
  // betsson-API:t kräver custom-headers (brandId m.fl.) → annars 400 E_VALIDATION_INVALIDHEADER.
  // Skicka med betsContext.headers men filtrera bort headers webbläsaren förbjuder via fetch.
  const FORBIDDEN = new Set(["host", "origin", "referer", "user-agent", "cookie", "content-length", "connection", "accept-encoding"]);
  const safe = { accept: "application/json, text/plain, */*" };
  for (const [k, v] of Object.entries(headers || {})) { if (v != null && !FORBIDDEN.has(k.toLowerCase())) safe[k] = String(v); }
  try {
    return await linesPage.evaluate(async ({ u, h }) => {
      try { const resp = await fetch(u, { headers: h, credentials: "include" }); return { status: resp.status, text: await resp.text() }; }
      catch (e) { return { status: -2, text: String((e && e.message) || e) }; }
    }, { u: url, h: safe });
  } catch (e) { return { status: -3, text: String(e?.message ?? e) }; }
}

async function fetchEventLines(context, betsContext, eventId, homeTeam, awayTeam) {
  const b = betsContext.baseUrl, lp = betsContext.linesPage;
  let totals = [], ah = [], corners = [];
  try {
    // event/v2 + accordion via IN-PAGE fetch (CF-clearad webbläsar-kontext).
    const evUrl = `${b}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`;
    const evR = await betssonInPageGet(lp, evUrl, betsContext.headers);
    let d = null; try { const ev = JSON.parse(evR.text); d = ev?.data ?? ev; } catch { /* */ }
    const sums = d?.accordionSummaries;
    const entries = Array.isArray(sums) ? sums : Object.entries(sums || {}).map(([k, v]) => ({ _key: k, ...(v && typeof v === "object" ? v : {}) }));
    const byKey = {};
    for (const s of entries) { const k = s?._key ?? s?.id ?? s?.accordionId ?? s?.groupableId; if (k) byKey[k] = s; }

    // diagnostik (en gång): fånga event/v2-steget DIREKT — visar hasLinesPage, ev-status,
    // antal summaries och body-head ÄVEN om MTG2W/MAHCP saknas (då accordion-loopen skippas).
    if (!LINES_PROBE) {
      LINES_PROBE = { hasLinesPage: !!lp, evStatus: evR.status, nSummaries: entries.length, sumKeys: Object.keys(byKey).slice(0, 20), evBodyHead: (evR.text || "").slice(0, 140), accStatus: null, gid: null };
      // HÖRN-RECON (en gång): subTabs=133 ger bara MW3W/MTG2W/MAHCP. Hämta HELA katalogen
      // (alla subTabs) → hitta hörn-marknadens key (t.ex. MTC*/Corners) så vi kan parsa den.
      try {
        const allUrl = `${b}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}`;
        const allR = await betssonInPageGet(lp, allUrl, betsContext.headers);
        let ad = null; try { const aj = JSON.parse(allR.text); ad = aj?.data ?? aj; } catch { /* */ }
        const asums = ad?.accordionSummaries;
        const aents = Array.isArray(asums) ? asums : Object.entries(asums || {}).map(([k, v]) => ({ _key: k, ...(v && typeof v === "object" ? v : {}) }));
        const allKeys = aents.map((s) => `${s?._key ?? s?.id ?? s?.accordionId ?? s?.groupableId}|${s?.name ?? s?.title ?? s?.label ?? ""}`);
        LINES_PROBE.fullCatalogStatus = allR.status;
        LINES_PROBE.fullCatalogKeys = allKeys.slice(0, 60);
        LINES_PROBE.cornerKeys = allKeys.filter((k) => /corner|hörn/i.test(k));
      } catch { /* */ }
    }

    for (const [key, kind] of [["MTG2W", "totals"], ["MAHCP", "ah"]]) {
      const s = byKey[key];
      if (!s) continue;
      // gid: prova LITERAL nyckeln (MTG2W/MAHCP) FÖRST — 1X2 funkar med literal MW3W via in-page.
      // accordionGrouping ("accordion.football.goals", med punkter) triggar CloudFront-WAF (403).
      const gidCandidates = [...new Set([key, s.groupableId, s.accordionGrouping].filter(Boolean))];
      for (const gid of gidCandidates) {
        const aurl = `${b}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}&groupableId=${encodeURIComponent(gid)}`;
        const r = await betssonInPageGet(lp, aurl, betsContext.headers);
        if (LINES_PROBE && (LINES_PROBE.accStatus == null || (LINES_PROBE.accStatus !== 200 && r.status === 200))) { LINES_PROBE.accStatus = r.status; LINES_PROBE.gid = gid; LINES_PROBE.accBodyHead = (r.text || "").slice(0, 140); }
        let parsed = [];
        try { const a = JSON.parse(r.text); parsed = kind === "totals" ? parseBetssonTotals(a) : parseBetssonAh(a, homeTeam, awayTeam); } catch { /* */ }
        if (parsed.length) { if (kind === "totals") totals = parsed; else ah = parsed; break; }
        await sleep(randomJitter());
      }
    }

    // HÖRN: hitta corner-marknaden på NAMN (ingen hårdkodad key — finns bara på större
    // matcher). Parsa som 2-vägs O/U men BEHÅLL bara halvlinjer (.5) → om betsson ger
    // 3-vägs hörn (heltal + "Exakt", likt 10bet/Playtech) emitteras INGEN felaktig data.
    const cornerSummary = entries.find((s) => /hörn|corner/i.test(String(s?.name ?? s?.title ?? s?.label ?? "")));
    if (cornerSummary) {
      const ckey = cornerSummary._key ?? cornerSummary.id ?? cornerSummary.accordionId ?? cornerSummary.groupableId;
      const cgids = [...new Set([ckey, cornerSummary.groupableId, cornerSummary.accordionGrouping].filter(Boolean))];
      for (const gid of cgids) {
        const aurl = `${b}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}&groupableId=${encodeURIComponent(gid)}`;
        const r = await betssonInPageGet(lp, aurl, betsContext.headers);
        let parsed = [];
        try { const a = JSON.parse(r.text); parsed = parseBetssonTotals(a).filter((x) => Math.abs((x.line % 1) - 0.5) < 0.05); } catch { /* */ }
        if (parsed.length) { corners = parsed; break; }
        await sleep(randomJitter());
      }
    }
  } catch { /* bäst-ansträngning: en 403/tom rör ALDRIG 1X2 */ }
  return { totals, ah, corners };
}

async function fetchEventOdds(context, betsContext, eventId) {
  // Engångs-recon (första eventet): proba kandidat-groupableIds för att hitta
  // totals/AH-koderna (no-groupableId gav tom accordion → koderna måste anges).
  if (!BETSSON_REC) {
    BETSSON_REC = true;
    try {
      const base = `${betsContext.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}`;
      const candidates = [
        "MW3W", "MR", "MOU", "OU", "TG", "MTG", "MOUG", "OUG", "TOTAL", "TOTALGOALS", "GOALS", "GOU", "TGOU",
        "MAH", "AH", "AHC", "HCAP", "HANDICAP", "ASIAN", "AHG", "GH", "MW2W", "DC", "BTTS", "GGNG", "OE",
      ];
      for (const gid of candidates) {
        try {
          const r = await betssonGetJson(context, `${base}&groupableId=${gid}`, betsContext.iframeUrl, betsContext.headers);
          const accs = r?.data?.accordions ?? {};
          const keys = Object.keys(accs);
          if (keys.length) {
            const sample = keys.slice(0, 2).map((k) => ({
              k,
              sel: (accs[k]?.selections || []).slice(0, 3).map((s) => ({ tpl: s.selectionTemplateId, lbl: s.alternateLabel ?? s.participantLabel ?? s.label, line: s.selectionSpecifics ?? s.line, odds: s.odds })),
            }));
            console.log(`[betsson-action] REC gid=${gid} keys=${JSON.stringify(keys)} sample=${JSON.stringify(sample)}`);
          }
        } catch { /* nästa gid */ }
      }
      console.log(`[betsson-action] REC klar (event ${eventId})`);
    } catch (e) { console.log(`[betsson-action] REC fel: ${e?.message}`); }
  }
  const urls = [
    `${betsContext.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}&groupableId=MW3W`,
    `${betsContext.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}`,
  ];
  for (const url of urls) {
    // 1) IN-PAGE fetch (CF-clearad iframe-sida) FÖRST — context.request 403:as nu på accordion
    //    (även 1X2/MW3W). In-page-anropet kör i riktig webbläsarkontext och passerar CF.
    try {
      const r = await betssonInPageGet(betsContext.linesPage, url, betsContext.headers);
      if (!ODDS_PROBE) ODDS_PROBE = { via: "inpage", status: r.status, hasLinesPage: !!betsContext.linesPage, bodyHead: (r.text || "").slice(0, 120) };
      if (r.status >= 200 && r.status < 300) {
        const odds = parseBetssonOddsFromAccordion(JSON.parse(r.text));
        if (odds) return odds;
      }
    } catch { /* falla tillbaka */ }
    // 2) FALLBACK: context.request (fungerar när CF inte utmanar)
    try {
      const data = await betssonGetJson(context, url, betsContext.iframeUrl, betsContext.headers);
      const odds = parseBetssonOddsFromAccordion(data);
      if (odds) return odds;
    } catch {
      // prova nästa URL
    }
  }
  return null;
}

// ====================================================================
// Cloudflare clearance + context-discovery
// ====================================================================

/**
 * Vänta tills sidan inte längre är en challenge-page. Betsson-syskonen
 * använder inte alltid Cloudflare — Bethard kör Akamai/eget WAF — så vi
 * kollar primärt på title-mönster, inte på cf_clearance-cookies.
 *
 * Returnerar success så fort titeln INTE är ett "Just a moment / Vänta..."-
 * mönster och vi har minst en cookie satt.
 */
async function ensureClearance(page, context, originUrl, label) {
  const challengeTitleRe = /just a moment|attention required|cloudflare|access denied|vänta\.\.\./i;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(1_500);
    const title = await page.title().catch(() => "");
    const cookies = await context.cookies(originUrl).catch(() => []);
    const isChallenge = challengeTitleRe.test(title);
    if (!isChallenge && cookies.length > 0) {
      const cf = cookies.some((c) => c.name === "cf_clearance" || c.name === "__cf_bm");
      console.log(
        `[betsson-action] ${label}: page ready (titel="${title.slice(0, 60)}", cookies=${cookies.length}, cf=${cf})`,
      );
      return { hasClearance: true, title, cookieCount: cookies.length, cfClearance: cf };
    }
    if (attempt === 0) console.log(`[betsson-action] ${label}: väntar på page-ready...`);
  }
  const lastTitle = await page.title().catch(() => "");
  const cookies = await context.cookies(originUrl).catch(() => []);
  if (!challengeTitleRe.test(lastTitle) && cookies.length > 0) {
    // Acceptera även om vi tappade tålamodet — title är inte challenge.
    console.log(`[betsson-action] ${label}: page accepterad efter timeout (titel="${lastTitle.slice(0, 60)}", cookies=${cookies.length})`);
    return { hasClearance: true, title: lastTitle, cookieCount: cookies.length, cfClearance: false };
  }
  console.warn(`[betsson-action] ${label}: page-ready saknas (titel="${lastTitle.slice(0, 60)}")`);
  return { hasClearance: false, title: lastTitle, cookieCount: cookies.length, cfClearance: false };
}

async function discoverBetssonContext(browserContext) {
  for (const url of CONTEXT_URLS) {
    const label = new URL(url).hostname;
    console.log(`[betsson-action] Testar context-URL: ${url}`);
    const page = await browserContext.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch((err) => {
        console.warn(`[betsson-action] ${label} navigeringsfel: ${err?.message ?? err}`);
      });
      const cf = await ensureClearance(page, browserContext, url, label);
      if (!cf.hasClearance) { await page.close().catch(() => {}); continue; }

      const pageHtml = await page.content();
      const iframeUrl = extractBetssonIframeUrl(pageHtml);
      if (!iframeUrl) {
        console.warn(`[betsson-action] ${label}: ingen playground-iframe i HTML`);
        await page.close().catch(() => {});
        continue;
      }

      // Ladda iframe i samma context (cookies följer med). BEHÅLL sidan öppen → in-page
      // fetch från denna origin bär full CF-clearance (passerar 403 där context.request kan
      // utmanas på TLS/JA3-fingerprint). Används för totals/AH-accordion (linesPage).
      const iframePage = await browserContext.newPage();
      await iframePage.goto(iframeUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
        referer: url,
      }).catch((err) => {
        console.warn(`[betsson-action] iframe nav fel: ${err?.message ?? err}`);
      });
      const iframeHtml = await iframePage.content();

      const configJson = extractJsonObjectAfterAssignment(iframeHtml, "window.obgClientEnvironmentConfig =");
      if (!configJson) {
        console.warn(`[betsson-action] ${label}: hittade ingen obgClientEnvironmentConfig i iframe`);
        await iframePage.close().catch(() => {});
        await page.close().catch(() => {});
        continue;
      }

      const headers = buildBetssonHeadersFromConfig(configJson, iframeUrl, url);
      if (!headers) {
        await iframePage.close().catch(() => {});
        await page.close().catch(() => {});
        continue;
      }

      // WAF-HÄLSOKOLL: odds-endpointen (accordion/v1) WAF-403:as intermittent per varumärke
      // (CloudFront). Testa den DIREKT; vid 403 → prova nästa varumärke (annan CF-distribution)
      // som kanske inte är blockerat. Dummy-eventId räcker — WAF-403 sker före API-validering.
      const baseOrigin = new URL(iframeUrl).origin;
      try {
        const hc = await betssonInPageGet(iframePage, `${baseOrigin}/api/sb/v1/widgets/accordion/v1?eventId=healthcheck&groupableId=MW3W`, headers);
        console.log(`[betsson-action] WAF-hälsokoll ${label}: accordion status=${hc.status}`);
        if (hc.status === 403) {
          console.log(`[betsson-action] ${label}: accordion WAF-403 → provar nästa varumärke`);
          await iframePage.close().catch(() => {});
          await page.close().catch(() => {});
          continue;
        }
      } catch (e) { console.log(`[betsson-action] WAF-hälsokoll ${label} fel: ${e?.message} — använder ändå`); }

      await page.close().catch(() => {});
      return {
        baseUrl: baseOrigin,
        iframeUrl,
        headers,
        contextLabel: label,
        linesPage: iframePage, // kvarhållen iframe-sida för in-page accordion-fetch
      };
    } catch (error) {
      console.warn(`[betsson-action] ${label} discovery-fel: ${error?.message ?? error}`);
      await page.close().catch(() => {});
    }
  }
  return null;
}

// ====================================================================
// Main
// ====================================================================

/**
 * Hämta 2-vägs events (basket/tennis) — söker sport-kategorin, hämtar title +
 * 2-vägs-accordion per event. Återanvänder den redan etablerade betsContexten.
 */
async function fetchBetsson2WaySport(browserContext, betsContext, queries, categoryRe, sportTag) {
  if (!queries.length) return [];
  const seen = new Set();
  const candidates = [];
  const searchResults = await mapLimit(queries, SEARCH_CONCURRENCY, async (q) => {
    try { const ids = await searchEventIds(browserContext, betsContext, q, categoryRe); await sleep(randomJitter()); return ids; }
    catch { return []; }
  });
  for (const ids of searchResults) for (const id of ids) { if (!seen.has(id)) { seen.add(id); candidates.push(id); } }
  const st = BETSSON_2WAY_STATS[categoryRe.source];
  console.log(`[betsson-action] ${sportTag}: ${candidates.length} kandidat-events från ${queries.length} queries · råa matches=${st?.rawMatches ?? 0} categoryNames=${JSON.stringify([...(st?.cats ?? [])].slice(0, 15))}`);
  const limited = candidates.slice(0, MAX_EVENTS);
  const results = await mapLimit(limited, DETAIL_CONCURRENCY, async (eventId) => {
    try {
      const titleData = await fetchEventTitle(browserContext, betsContext, eventId);
      await sleep(randomJitter());
      const odds = await fetchEventOdds2Way(browserContext, betsContext, eventId);
      await sleep(randomJitter());
      if (!titleData?.title || !odds) return null;
      return { eventId, title: titleData.title, homeTeam: titleData.homeTeam, awayTeam: titleData.awayTeam, startTime: titleData.start ?? null, league: null, sport: sportTag, odds };
    } catch { return null; }
  });
  return results.filter(Boolean);
}

async function main() {
  const runStart = Date.now();
  // Adaptiv query-budget: läs förra körningens utfall ur betsson-rows.json:s
  // _tuning-fält. Träffade vi deadline sist krymper budgeten så vi hinner klart
  // (och med basket/tennis); gick det snabbt växer den tillbaka mot QUERY_LIMIT.
  const { limit: effectiveLimit } = readAdaptiveLimit({
    file: OUTPUT_FILE,
    defaultLimit: QUERY_LIMIT,
    minLimit: MIN_QUERY_LIMIT,
    maxLimit: QUERY_LIMIT,
    label: "betsson-action",
  });
  const queries = buildDynamicQueriesFromPinnacle("soccer", effectiveLimit);
  const basketQueries = buildDynamicQueriesFromPinnacle("basketball");
  const tennisQueries = buildDynamicQueriesFromPinnacle("tennis");
  console.log(
    `[betsson-action] Query-strategi: pinnacle-driven (homeTeam, ${QUERY_LOOKAHEAD_HOURS}h fönster, budget ${effectiveLimit}/${QUERY_LIMIT})`,
  );
  console.log(`[betsson-action] Antal queries: ${queries.length}`);
  console.log(`[betsson-action] Första 10 queries: ${JSON.stringify(queries.slice(0, 10))}`);
  console.log(
    `[betsson-action] Concurrency: search=${SEARCH_CONCURRENCY} detail=${DETAIL_CONCURRENCY}`,
  );

  // Muterbar progress-state. Hard-deadline-handlern (och normal slutförd körning)
  // läser från denna för att skriva den partiella datan som hunnit samlas in.
  let betsContext = null;
  let completedEvents = [];
  let eventsBasket = [];
  let eventsTennis = [];
  // Sätts true av deadline-handlern så _tuning vet att budgeten ska krympa nästa
  // körning. Normal slutförd körning lämnar den false → budgeten kan växa.
  let hitDeadline = false;

  // Bygger payload från nuvarande progress och skriver cache-bevarande: en tom
  // payload klottrar aldrig över en icke-tom cache (writeJsonPreservingCache).
  const writeOutput = (sourceTag = "github-actions") => {
    const payload = {
      updatedAt: new Date().toISOString(),
      source: sourceTag,
      queryStrategy: "pinnacle-home-team",
      queryLookaheadHours: QUERY_LOOKAHEAD_HOURS,
      queryCount: queries.length,
      contextLabel: betsContext?.contextLabel ?? null,
      brandId: betsContext?.headers?.brandid ?? null,
      // Hälsoflagga: true = körningen avbröts av hard-deadline → reducerad
      // täckning (t.ex. soccer hämtat men basket/tennis hann inte). Konsumenter
      // (audit/watchdog/app) kan visa "partiell" utan att gissa på source-taggen.
      partial: hitDeadline,
      events: completedEvents,
      eventsBasket,
      eventsTennis,
      // Självreglerande budget: nästa körning läser detta via readAdaptiveLimit.
      _tuning: buildTuning({ limitUsed: effectiveLimit, runStart, deadlineMs: HARD_DEADLINE_MS, hitDeadline }),
      _linesDiag: LINES_DIAG, // hälsoflagga: lines-steget (totals/AH) — ran + utfall
      _linesProbe: LINES_PROBE, // TEMP: totals/AH in-page fetch HTTP-status
      _oddsProbe: ODDS_PROBE, // TEMP: 1X2-detalj in-page fetch-status (bevisar om CF passeras)
    };
    writeJsonPreservingCache(OUTPUT_FILE, payload, {
      label: "betsson-action",
      // "Tom" = inga 1X2-events OCH inga basket/tennis-events. Då bevarar vi cachen.
      isEmpty: (p) =>
        (!Array.isArray(p.events) || p.events.length === 0) &&
        (!Array.isArray(p.eventsBasket) || p.eventsBasket.length === 0) &&
        (!Array.isArray(p.eventsTennis) || p.eventsTennis.length === 0),
      countOf: (p) =>
        (Array.isArray(p.events) ? p.events.length : 0) +
        (Array.isArray(p.eventsBasket) ? p.eventsBasket.length : 0) +
        (Array.isArray(p.eventsTennis) ? p.eventsTennis.length : 0),
    });
  };

  // Intern deadline: spara partiell data + avsluta rent (exit 0) före job-timeout.
  const deadline = installHardDeadline({
    budgetMs: HARD_DEADLINE_MS,
    label: "betsson-action",
    onDeadline: () => {
      hitDeadline = true;
      writeOutput("github-actions-partial-deadline");
    },
  });

  console.log("[betsson-action] Startar headless Chromium med stealth...");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const browserContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "sv-SE",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });

  betsContext = await discoverBetssonContext(browserContext);
  if (!betsContext) {
    console.error("[betsson-action] Kunde inte hitta fungerande Betsson-context — alla CONTEXT_URLS misslyckades");
    await browser.close();
    deadline.cancel();
    // Context-fail = transient (Cloudflare-block/timeout). Bevara befintlig cache
    // istället för att klottra över den med tomt — skriver bara om ingen cache finns.
    writeOutput("github-actions-context-failure");
    process.exit(1);
  }
  console.log(
    `[betsson-action] Context OK från ${betsContext.contextLabel}: baseUrl=${betsContext.baseUrl} brandId=${betsContext.headers.brandid}`,
  );

  // Steg A: search per query, dedupe eventIds
  const searchStart = Date.now();
  let searchHits = 0;
  let queriesWithHits = 0;
  let searchErrors = 0;
  const seenEventIds = new Set();
  const candidateEvents = []; // { eventId, foundBy }

  const searchResults = await mapLimit(queries, SEARCH_CONCURRENCY, async (query) => {
    try {
      const ids = await searchEventIds(browserContext, betsContext, query);
      await sleep(randomJitter());
      return { query, ids, ok: true };
    } catch (error) {
      return { query, ids: [], ok: false, error: error?.message ?? String(error) };
    }
  });
  for (const r of searchResults) {
    if (!r.ok) { searchErrors += 1; continue; }
    searchHits += r.ids.length;
    if (r.ids.length > 0) queriesWithHits += 1;
    for (const id of r.ids) {
      if (seenEventIds.has(id)) continue;
      seenEventIds.add(id);
      candidateEvents.push({ eventId: id, foundBy: r.query });
    }
  }
  const searchMs = Date.now() - searchStart;
  console.log(
    `[betsson-action] Search klar: ${searchHits} hits, ${seenEventIds.size} unika events, ${queriesWithHits}/${queries.length} queries-with-hits, ${searchErrors} errors (${(searchMs / 1000).toFixed(1)}s)`,
  );


  // RECON-LÄGE: kartlägg alternativa totals/AH-vägar på ETT riktigt fotbolls-
  // event (ej esports) + ETT godtyckligt, dumpa struktur och avsluta rent utan
  // att skriva data. Aktiveras bara av env BETSSON_RECON_MODE (probe-workflow).
  if (process.env.BETSSON_RECON_MODE === "1") {
    console.log(`[betsson-action] RECON-LÄGE aktivt — ${candidateEvents.length} kandidat-events`);
    const isReal = (t) => typeof t === "string" && t.includes(" - ") && !t.includes("(") && !/\besport|cyber|sim(ulated)?\b/i.test(t);
    // Skanna riktiga matcher tills vi hittar EN med MAHCP (asiatiskt handikapp) —
    // alla ligor erbjuder inte AH. Cap 10 events så proben förblir bunden.
    let scanned = 0, foundMahcp = false;
    for (const cand of candidateEvents.slice(0, 60)) {
      if (foundMahcp || scanned >= 10) break;
      let titleData = null;
      try { titleData = await fetchEventTitle(browserContext, betsContext, cand.eventId); } catch { /* nästa */ }
      const title = titleData?.title ?? "";
      if (!isReal(title)) continue;
      scanned += 1;
      foundMahcp = await betssonRichRecon(browserContext, betsContext, cand.eventId, title, `real${scanned}`);
      await sleep(randomJitter());
    }
    console.log(`[betsson-action] RECON-LÄGE klar (scanned=${scanned} foundMAHCP=${foundMahcp}) — avslutar utan att skriva data.`);
    deadline.cancel();
    await browser.close();
    process.exit(0);
  }

  // Steg B: per event hämta title + odds
  const limited = candidateEvents.slice(0, MAX_EVENTS);
  const detailStart = Date.now();
  let detailErrors = 0;
  let titleErrors = 0;
  const errorSamples = [];

  const detailResults = await mapLimit(limited, DETAIL_CONCURRENCY, async (cand) => {
    try {
      const titleData = await fetchEventTitle(browserContext, betsContext, cand.eventId);
      await sleep(randomJitter());
      const odds = await fetchEventOdds(browserContext, betsContext, cand.eventId);
      await sleep(randomJitter());
      if (!titleData?.title) {
        return { kind: "title-err", cand };
      }
      if (!odds) {
        return { kind: "odds-err", cand, title: titleData.title };
      }
      return {
        kind: "ok",
        event: {
          eventId: cand.eventId,
          title: titleData.title,
          homeTeam: titleData.homeTeam,
          awayTeam: titleData.awayTeam,
          startTime: titleData.start ?? null,
          odds,
          foundBy: cand.foundBy,
        },
      };
    } catch (error) {
      return { kind: "exc", cand, error: error?.message ?? String(error) };
    }
  });
  for (const r of detailResults) {
    if (r.kind === "ok") completedEvents.push(r.event);
    else if (r.kind === "title-err") {
      titleErrors += 1;
      if (errorSamples.length < 5) errorSamples.push({ stage: "title", eventId: r.cand.eventId });
    } else if (r.kind === "odds-err") {
      detailErrors += 1;
      if (errorSamples.length < 10) errorSamples.push({ stage: "odds", eventId: r.cand.eventId, title: r.title });
    } else if (r.kind === "exc") {
      detailErrors += 1;
      if (errorSamples.length < 10) errorSamples.push({ stage: "exception", eventId: r.cand.eventId, error: r.error });
    }
  }
  const detailMs = Date.now() - detailStart;
  console.log(
    `[betsson-action] Detail klar: ${completedEvents.length}/${limited.length} OK, ${detailErrors + titleErrors} errors (${(detailMs / 1000).toFixed(1)}s)`,
  );

  // Steg B2: bäst-ansträngning totals (MTG2W) + Asian handicap (MAHCP) för de
  // NÄRMAST avsparkade matcherna. Bundet (BETSSON_LINES_MAX) + låg samtidighet +
  // jitter → skonsamt mot Cloudflare (burst gav 403 i recon). En 403/tom svar
  // rör ALDRIG 1X2 — totals/ah bara berikar, aldrig blockerar.
  const LINES_MAX = Number(process.env.BETSSON_LINES_MAX ?? 30);
  if (LINES_MAX > 0 && completedEvents.length) {
    const linesStart = Date.now();
    const nowMs = Date.now();
    const nearest = completedEvents
      .filter((e) => e.startTime && Date.parse(e.startTime) > nowMs)
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
      .slice(0, LINES_MAX);
    let withTotals = 0, withAh = 0, withCorners = 0;
    await mapLimit(nearest, 2, async (e) => {
      try {
        const { totals, ah, corners } = await fetchEventLines(browserContext, betsContext, e.eventId, e.homeTeam, e.awayTeam);
        if (totals.length) { e.totals = totals; withTotals += 1; }
        if (ah.length) { e.ah = ah; withAh += 1; }
        if (corners && corners.length) { e.corners = { totals: corners }; withCorners += 1; }
      } catch { /* bäst-ansträngning */ }
      await sleep(randomJitter());
    });
    console.log(`[betsson-action] Lines klar: ${withTotals} totals + ${withAh} AH + ${withCorners} hörn av ${nearest.length} närmast-matcher (${((Date.now() - linesStart) / 1000).toFixed(1)}s)`);
    LINES_DIAG = { ran: true, withTotals, withAh, nearest: nearest.length, ms: Math.round((Date.now() - linesStart) / 1000) };
  } else {
    LINES_DIAG = { ran: false, linesMax: LINES_MAX, completed: completedEvents.length };
  }

  // 2-vägs (basket + tennis) — söker basket/tennis-kategorin, parsar HOME/AWAY.
  try { eventsBasket = await fetchBetsson2WaySport(browserContext, betsContext, basketQueries, /basket/i, "basketball"); } catch (e) { console.warn("[betsson-action] basket-fel:", e?.message ?? e); }
  // Betssons sök matchar inte tennis-spelarnas fullständiga namn → använd
  // efternamn (sista token, ≥3 tecken) som är hur spelare oftast är indexerade.
  const tennisSurnames = [...new Set(tennisQueries.map((q) => q.trim().split(/\s+/).pop()).filter((s) => s && s.length >= 3))];
  try { eventsTennis = await fetchBetsson2WaySport(browserContext, betsContext, tennisSurnames, /tennis/i, "tennis"); } catch (e) { console.warn("[betsson-action] tennis-fel:", e?.message ?? e); }
  console.log(`[betsson-action] 2-way: ${eventsBasket.length} basket + ${eventsTennis.length} tennis`);

  await browser.close();

  // Normal slutförd körning: avbryt deadline och skriv den fullständiga datan.
  deadline.cancel();
  writeOutput("github-actions");

  const totalMs = Date.now() - runStart;
  console.log("");
  console.log("============ SAMMANFATTNING ============");
  console.log(`Query-strategi: pinnacle-home-team (${queries.length} queries, ${QUERY_LOOKAHEAD_HOURS}h fönster)`);
  console.log(`Context: ${betsContext.contextLabel} (brandId=${betsContext.headers.brandid})`);
  console.log(`Concurrency: search=${SEARCH_CONCURRENCY} detail=${DETAIL_CONCURRENCY}`);
  console.log(`Total runtime: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(
    `Aggregerat: search-hits=${searchHits} | queries-with-hits=${queriesWithHits}/${queries.length} | unique-events=${seenEventIds.size} | detail-attempted=${limited.length} | complete-1X2=${completedEvents.length} | errors=${detailErrors + titleErrors}`,
  );
  if (completedEvents.length > 0) {
    console.log("Exempel-events med komplett 1X2 (3-5 första):");
    for (const e of completedEvents.slice(0, 5)) {
      console.log(
        `  eventId=${e.eventId} "${e.title}" | 1=${e.odds.home} X=${e.odds.draw} 2=${e.odds.away} (foundBy=${e.foundBy})`,
      );
    }
  }
  if (errorSamples.length > 0) {
    console.log(`Fel-exempel (${errorSamples.length} st):`);
    for (const err of errorSamples.slice(0, 5)) console.log(`  ${JSON.stringify(err)}`);
  }
  console.log("========================================");
  console.log(`Skrev: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("[betsson-action] Fatal:", error);
  process.exit(1);
});
