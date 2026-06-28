#!/usr/bin/env node
/**
 * Altenar group prematch football scraper.
 *
 * Hämtar bulk 1X2-odds från Altenar SB2 frontend-API för Altenar-syskonen:
 *   - DBET        (integration: dbet)
 *   - MrVegas     (integration: mrvegasse)
 *   - MegaRiches  (integration: megarichesse)
 *
 * Backend: https://sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming
 *
 * En enda bulk-call per integration returnerar ~500 events med markets,
 * odds, categories, champs och competitors. Varje sajt har egen brand-
 * marginalisering så vi måste fråga alla 3 separat (samma anrops-mönster
 * som scrapeAltenarBookmaker använder live).
 *
 * Parsing: typeId=1 är 1X2 i Altenars fotbolls-flöde. Mappar typeId 1/2/3
 * i odds-array till home/draw/away. Identisk logik som parseAltenarOneXTwo
 * i vite.config.ts så cache-data är konsistent med live-fallback.
 *
 * Cache-preserve: scriptet skriver ALDRIG över rows.json med tom payload.
 * Vid HTTP-fel eller parser=0 events behålls föregående cache.
 *
 * Output: data/altenar-rows.json med byIntegration-shape:
 *   { updatedAt, source, bookmaker, byIntegration: {
 *       dbet: { displayName, updatedAt, events[], lastError? }, ...
 *   }}
 */

import fs from "node:fs";
import path from "node:path";
import { installHardDeadline, atomicWriteString } from "./lib/scrape-guard.mjs";

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const ALTENAR_FRONTEND_API = "https://sb2frontend-altenar2.biahosted.com/api";

const INTEGRATIONS = [
  { key: "dbet", displayName: "DBET" },
  { key: "mrvegasse", displayName: "MrVegas" },
  { key: "megarichesse", displayName: "MegaRiches" },
  { key: "megafortunese", displayName: "MegaFortune" },
  { key: "happycasino", displayName: "Happy Casino" },
  { key: "luckycasino", displayName: "Lucky" },
  { key: "betiniase2", displayName: "Betinia" },
  { key: "quickcasinose", displayName: "Quick" },
  // Videoslots Ltd-gruppen (recon 2026-06-26): videoslots.com/sv/sports +
  // kungaslottet.se/sports kör samma Altenar-frontend (integration=videoslotsse /
  // kungaslottetse) → samma byIntegration-cache, totals inkluderat.
  { key: "videoslotsse", displayName: "Videoslots" },
  { key: "kungaslottetse", displayName: "Kungaslottet" },
  // CampoBet (recon 2026-06-26): campobet.se kör samma Altenar-frontend
  // (integration=campose), inte Soft2Bet som först antogs.
  { key: "campose", displayName: "CampoBet" },
];

const SOCCER_SPORT_ID = 66;
const BASKETBALL_SPORT_ID = 67;
const TENNIS_SPORT_ID = 68;
// Altenars 2-vägs "Vinnare"-marknad: typeId 219 (basket, inkl. övertid) / 186 (tennis).
const MONEYLINE_2WAY_TYPEIDS = new Set([219, 186]);
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "altenar-rows.json");


// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPreviousPayload() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function fetchAltenarUpcoming(integration, sportId = SOCCER_SPORT_ID) {
  const url =
    `${ALTENAR_FRONTEND_API}/widget/GetUpcoming?` +
    new URLSearchParams({
      culture: "sv-SE",
      timezoneOffset: "-120",
      integration,
      deviceType: "1",
      numFormat: "en-GB",
      countryCode: "SE",
      sportId: String(sportId),
    }).toString();

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": UA,
        },
      });
      clearTimeout(timer);
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text().catch(() => "");
        lastErr = `HTTP ${response.status}: ${body.slice(0, 200)}`;
        if (attempt < RETRY_MAX_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw new Error(lastErr);
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timer);
      lastErr = error?.message ?? String(error);
      if (attempt < RETRY_MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error(lastErr ?? "Altenar fetch failed");
}

/**
 * Parsa 1X2-odds för ett event. Identisk logik som parseAltenarOneXTwo
 * i vite.config.ts — viktigt för konsistens med live-fallback.
 */
function parseEventOneXTwo(event, marketsById, oddsById) {
  if (!event?.marketIds?.length) return null;
  const candidates = event.marketIds
    .map((id) => marketsById.get(id))
    .filter((m) => m && Array.isArray(m.oddIds) && m.oddIds.length > 0);

  const market =
    candidates.find((m) => m.typeId === 1 && /\b1x2\b/i.test(String(m.name ?? ""))) ??
    candidates.find((m) => m.typeId === 1 && /full\s*time|fulltid|match\s*result|^\s*mw\s*$/i.test(String(m.name ?? ""))) ??
    candidates.find((m) => m.typeId === 1);

  if (!market?.oddIds?.length) return null;
  const odds = market.oddIds.map((id) => oddsById.get(id)).filter(Boolean);

  // Primary: typeId 1/2/3 → home/draw/away
  const byType = {};
  for (const odd of odds) {
    if (typeof odd.price !== "number" || !(odd.price > 1)) continue;
    if (odd.oddStatus != null && odd.oddStatus !== 0) continue;
    if (odd.typeId != null) byType[odd.typeId] = odd.price;
  }
  if (byType[1] > 1 && byType[2] > 1 && byType[3] > 1) {
    return { home: byType[1], draw: byType[2], away: byType[3] };
  }

  // Fallback: name-baserad mapping
  let h, d, a;
  for (const odd of odds) {
    if (typeof odd.price !== "number" || !(odd.price > 1)) continue;
    if (odd.oddStatus != null && odd.oddStatus !== 0) continue;
    const nm = String(odd.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (/^1$|^w1$|^hem|home\b|^h$/.test(nm)) h = odd.price;
    else if (/^x$|^w?x$|draw|oavgjort|tie\b/.test(nm)) d = odd.price;
    else if (/^2$|^w2$|^bort|away\b|^a$/.test(nm)) a = odd.price;
  }
  if (h > 1 && d > 1 && a > 1) return { home: h, draw: d, away: a };
  return null;
}

/**
 * Parsa basket-moneyline (2-vägs). Altenar: market typeId=219 "Vinnare (inkl.
 * övertid)" med outcome typeId 1=hemma, typeId 3=borta (ingen oavgjort).
 */
function parseEventMoneyline2Way(event, marketsById, oddsById) {
  if (!event?.marketIds?.length) return null;
  const candidates = event.marketIds
    .map((id) => marketsById.get(id))
    .filter((m) => m && Array.isArray(m.oddIds) && m.oddIds.length > 0);

  const market =
    candidates.find((m) => MONEYLINE_2WAY_TYPEIDS.has(m.typeId)) ??
    candidates.find((m) => /^vinnare$|^winner$|moneyline|match\s*winner|head\s*to\s*head|h2h/i.test(String(m.name ?? "")));
  if (!market?.oddIds?.length) return null;
  const odds = market.oddIds.map((id) => oddsById.get(id)).filter(Boolean);

  // Primary: outcome typeId 1=home, 3=away (samma konvention som fotbollens 1/3)
  const byType = {};
  for (const odd of odds) {
    if (typeof odd.price !== "number" || !(odd.price > 1)) continue;
    if (odd.oddStatus != null && odd.oddStatus !== 0) continue;
    if (odd.typeId != null) byType[odd.typeId] = odd.price;
  }
  if (byType[1] > 1 && byType[3] > 1) return { home: byType[1], away: byType[3] };

  // Fallback: positionellt (första oddId=home, andra=away)
  const valid = odds.filter((o) => typeof o.price === "number" && o.price > 1 && (o.oddStatus == null || o.oddStatus === 0));
  if (valid.length === 2) return { home: valid[0].price, away: valid[1].price };
  return null;
}

/** Första (tecknade) talet i en sträng: "Över 3.5" → 3.5. */
function altenarNum(s) { const m = String(s || "").match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; }

/**
 * Parsa Totals (Over/Under mål) för ett fotbollsevent. Altenar: marknad
 * typeId=18 "Totalt antal mål", odd typeId 12=Över, 13=Under, linjen i odd.name
 * ("Över 3.5"). Varje linje = en egen typeId=18-marknad. All data finns redan i
 * GetUpcoming-payloaden → inga extra anrop. Returnerar [{line,over,under}].
 */
function parseEventTotals(event, marketsById, oddsById) {
  if (!event?.marketIds?.length) return [];
  const out = [];
  for (const id of event.marketIds) {
    const m = marketsById.get(id);
    if (!m || m.typeId !== 18 || !Array.isArray(m.oddIds)) continue;
    const odds = m.oddIds.map((i) => oddsById.get(i)).filter(Boolean);
    let over = null, under = null, line = null;
    for (const o of odds) {
      if (typeof o.price !== "number" || !(o.price > 1)) continue;
      if (o.oddStatus != null && o.oddStatus !== 0) continue;
      const isOver = o.typeId === 12 || /över|over/i.test(String(o.name ?? ""));
      const isUnder = o.typeId === 13 || /under/i.test(String(o.name ?? ""));
      if (isOver) { over = o.price; if (line == null) line = altenarNum(o.name); }
      else if (isUnder) { under = o.price; if (line == null) line = altenarNum(o.name); }
    }
    if (line == null) line = altenarNum(m.name) ?? (m.specialBetValue != null ? Number(m.specialBetValue) : null);
    if (over > 1 && under > 1 && Number.isFinite(line)) out.push({ line, over, under });
  }
  return out;
}

/**
 * Parsa events för en given sport ur en GetUpcoming-payload.
 * parser = parseEventOneXTwo (fotboll, 1X2) eller parseEventMoneyline2Way (basket, ML2).
 */
function parseEventsForSport(raw, sportId, parser, sportTag) {
  const events = Array.isArray(raw?.events) ? raw.events : [];
  const markets = Array.isArray(raw?.markets) ? raw.markets : [];
  const odds = Array.isArray(raw?.odds) ? raw.odds : [];
  const champs = Array.isArray(raw?.champs) ? raw.champs : [];
  const competitors = Array.isArray(raw?.competitors) ? raw.competitors : [];

  const marketsById = new Map(markets.filter((m) => m?.id != null).map((m) => [m.id, m]));
  const oddsById = new Map(odds.filter((o) => o?.id != null).map((o) => [o.id, o]));
  const champsById = new Map(champs.filter((c) => c?.id != null).map((c) => [c.id, c]));
  const competitorsById = new Map(competitors.filter((c) => c?.id != null).map((c) => [c.id, c]));

  // OBS: Altenars GetUpcoming-bulkfeed exponerar bara 1X2, totals (typeId 18), dubbelchans,
  // första målet, draw-no-bet och BTTS — INGEN handicap-marknad (varken asiatisk eller
  // europeisk). Asian Handicap skulle kräva per-event detalj-anrop (× 8 integrationer ×
  // hundratals events → opraktiskt inom deadline). Totals finns redan; AH utelämnas.

  const parsed = [];
  let skippedNoOdds = 0;
  for (const event of events) {
    if (!event?.id) continue;
    if (event.sportId != null && event.sportId !== sportId) continue;
    const parsedOdds = parser(event, marketsById, oddsById);
    if (!parsedOdds) {
      skippedNoOdds += 1;
      continue;
    }
    const compIds = Array.isArray(event.competitorIds) ? event.competitorIds : [];
    const homeName = compIds[0] != null ? competitorsById.get(compIds[0])?.name : null;
    const awayName = compIds[1] != null ? competitorsById.get(compIds[1])?.name : null;
    const champ = event.champId != null ? champsById.get(event.champId) : null;
    // Fotboll: totals (O/U) ur typeId=18 — ingen extra last (allt i payloaden).
    const totals = sportTag === "soccer" ? parseEventTotals(event, marketsById, oddsById) : [];
    parsed.push({
      eventId: String(event.id),
      title: String(event.name ?? "").trim() || `${homeName ?? "?"} vs ${awayName ?? "?"}`,
      homeTeam: homeName ?? null,
      awayTeam: awayName ?? null,
      startTime: event.startDate ?? null,
      league: champ?.name ?? null,
      sport: sportTag,
      odds: parsedOdds,
      ...(totals.length ? { totals } : {}),
    });
  }
  return { parsed, skippedNoOdds, rawEventsCount: events.length };
}

function buildIntegrationCache(integrationKey, displayName, rawSoccer, rawBasket, rawTennis) {
  const empty = { parsed: [], skippedNoOdds: 0, rawEventsCount: 0 };
  const soccer = parseEventsForSport(rawSoccer, SOCCER_SPORT_ID, parseEventOneXTwo, "soccer");
  const basket = rawBasket
    ? parseEventsForSport(rawBasket, BASKETBALL_SPORT_ID, parseEventMoneyline2Way, "basketball")
    : empty;
  const tennis = rawTennis
    ? parseEventsForSport(rawTennis, TENNIS_SPORT_ID, parseEventMoneyline2Way, "tennis")
    : empty;

  return {
    integrationKey,
    displayName,
    updatedAt: new Date().toISOString(),
    eventsCount: soccer.parsed.length,
    skippedNoOdds: soccer.skippedNoOdds,
    rawEventsCount: soccer.rawEventsCount,
    events: soccer.parsed,
    basketEventsCount: basket.parsed.length,
    eventsBasket: basket.parsed,
    tennisEventsCount: tennis.parsed.length,
    eventsTennis: tennis.parsed,
  };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  // Backstop: exit 0 före jobbets timeout (5 min) om något hänger. Inget skrivs
  // vid deadline → tidigare cache bevaras.
  const deadline = installHardDeadline({
    budgetMs: Number(process.env.ALTENAR_DEADLINE_MS) || 4 * 60 * 1000,
    label: "altenar",
  });
  console.log(`[altenar] start — fetching ${INTEGRATIONS.length} integrations in parallel`);

  // OBS: Altenars detalj-API (GetEventDetails) bekräftar att operatören INTE erbjuder någon
  // handicap-marknad på fotboll — bara 1x2, totals, dubbelchans, DNB, udda/jämnt, rätt
  // resultat, HT/FT, 1:a-halvlek-varianter, BTTS, boosted. Asiatiskt handicap är ej möjligt.

  const results = await Promise.allSettled(
    INTEGRATIONS.map(async (integ) => {
      const t0 = Date.now();
      try {
        // Fotboll (66) + basket (67) parallellt. Basket-fel ska aldrig fälla
        // fotbollen → .catch(null) så fallbacken i buildIntegrationCache tar tom.
        const [rawSoccer, rawBasket, rawTennis] = await Promise.all([
          fetchAltenarUpcoming(integ.key, SOCCER_SPORT_ID),
          fetchAltenarUpcoming(integ.key, BASKETBALL_SPORT_ID).catch(() => null),
          fetchAltenarUpcoming(integ.key, TENNIS_SPORT_ID).catch(() => null),
        ]);
        const cache = buildIntegrationCache(integ.key, integ.displayName, rawSoccer, rawBasket, rawTennis);
        const ms = Date.now() - t0;
        console.log(
          `[altenar] ✓ ${integ.displayName.padEnd(11)} ${ms}ms · ${cache.eventsCount} soccer + ${cache.basketEventsCount} basket + ${cache.tennisEventsCount} tennis parsed (skipped noOdds=${cache.skippedNoOdds})`,
        );
        return { integ, cache, lastError: null };
      } catch (e) {
        const ms = Date.now() - t0;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[altenar] ✗ ${integ.displayName.padEnd(11)} ${ms}ms · ${msg}`);
        return {
          integ,
          cache: {
            integrationKey: integ.key,
            displayName: integ.displayName,
            updatedAt: null,
            eventsCount: 0,
            events: [],
            basketEventsCount: 0,
            eventsBasket: [],
            tennisEventsCount: 0,
            eventsTennis: [],
          },
          lastError: msg,
        };
      }
    }),
  );

  const byIntegration = {};
  let totalEvents = 0;
  let totalErrors = 0;

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { integ, cache, lastError } = r.value;
    byIntegration[integ.key] = {
      displayName: cache.displayName,
      updatedAt: cache.updatedAt,
      events: cache.events,
      eventsCount: cache.eventsCount,
      eventsBasket: cache.eventsBasket ?? [],
      basketEventsCount: cache.basketEventsCount ?? 0,
      eventsTennis: cache.eventsTennis ?? [],
      tennisEventsCount: cache.tennisEventsCount ?? 0,
      skippedNoOdds: cache.skippedNoOdds ?? null,
      rawEventsCount: cache.rawEventsCount ?? null,
      lastError,
    };
    totalEvents += cache.eventsCount;
    if (lastError) totalErrors += 1;
  }

  // Cache-preserve: om ALLA integrationer misslyckades, behåll föregående payload
  const allFailed = totalErrors === INTEGRATIONS.length && totalEvents === 0;
  if (allFailed) {
    const prev = readPreviousPayload();
    if (prev) {
      console.warn(`[altenar] alla integrationer misslyckades — behåller föregående payload (skapad ${prev.updatedAt})`);
      process.exit(2);
    }
    console.warn(`[altenar] alla integrationer misslyckades och ingen tidigare cache finns — skriver tom-status`);
  }

  const status =
    totalEvents === 0 ? "error" : totalErrors > 0 ? "partial" : "active";

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "github-actions",
    bookmaker: "altenar",
    displayName: "Altenar group (DBET / MrVegas / MegaRiches / Happy Casino)",
    status,
    fetchedIntegrations: INTEGRATIONS.length,
    failedIntegrations: totalErrors,
    totalEvents,
    durationMs: Date.now() - startMs,
    byIntegration,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  deadline.cancel();
  atomicWriteString(OUTPUT_FILE, JSON.stringify(payload, null, 2) + "\n");

  console.log(
    `[altenar] done — ${totalEvents} total events across ${INTEGRATIONS.length - totalErrors}/${INTEGRATIONS.length} integrations in ${payload.durationMs}ms`,
  );
  console.log(`[altenar] wrote ${path.relative(process.cwd(), OUTPUT_FILE)}`);
}

main().catch((e) => {
  console.error(`[altenar] fatal: ${e?.message ?? e}`);
  process.exit(1);
});
