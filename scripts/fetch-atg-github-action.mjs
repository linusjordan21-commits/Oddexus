#!/usr/bin/env node
/**
 * ATG Sport (Kambi-plattform) prematch football scraper.
 *
 * ATG Sport drivs av Kambi — IDENTISK feed-struktur som Unibet/Kambi-scrapern,
 * bara en annan offering-kod ("atg" i st. f. "ubse"). Bekräftat via rekon:
 * eu-offering-api.kambicdn.com/offering/v2018/atg/listView gav 334 fotbollsevents.
 *
 * Backend: https://eu-offering-api.kambicdn.com/offering/v2018/atg/listView/
 *          football/{region}.json
 *
 * Bulk-fetch av Kambi's listView per region — varje response innehåller events
 * MED inbäddade betOffers (typeId=2 Match + criterion="Fulltid" = 1X2). Vi
 * slipper per-event-call eftersom main-offer redan finns i listView-svaret.
 *
 * Coverage: vi fetchar 8 region-paths (all/all + england, europe, international
 * etc) parallellt och dedupe:ar på event.id. Lokalt test ~140 events från
 * all/all-region, totalt ~400-600 unika events efter union.
 *
 * Parsing-logik identisk med parseKambiMainOffer/kambiMainOfferTriple i
 * vite.config.ts: hitta betOffer med betOfferType.englishName="Match" och
 * criterion.englishLabel="Full Time"/"Fulltid", labels 1|X|2, odds delas
 * med 1000 (Kambi lagrar dem som integer 5600 = 5.60).
 *
 * Cache-preserve: scriptet skriver ALDRIG över rows.json med tom payload.
 *
 * Output: data/atg-rows.json med events[]-shape.
 */

import fs from "node:fs";
import path from "node:path";
import { installHardDeadline, atomicWriteString } from "./lib/scrape-guard.mjs";

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const KAMBI_API_BASE = "https://eu-offering-api.kambicdn.com/offering/v2018";
const OFFERING = "atg"; // ATG Sport (Kambi-offering, bekräftad via rekon)
const REFERER = "https://www.atg.se/sport";

const REGION_TERMS = [
  "all/all",
  "england/all",
  "europe/all",
  "international/all",
  "international-clubs/all",
  "club-international/all",
  "champions-league/all",
  "uefa_champions_league/all",
];

const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;
const REGION_CONCURRENCY = 4;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "atg-rows.json");

// Bundet antal per-event detalj-anrop (för totals/AH). listView ger bara 1X2;
// /betoffer/event/{id} ger ALLA marknader. Vi tar de N matcher närmast avspark
// → begränsad last (jfr Smarkets-incidenten). Strypt concurrency + delay.
const KAMBI_DETAIL_MAX = Number(process.env.ATG_DETAIL_MAX) || 400;
const KAMBI_DETAIL_CONCURRENCY = 3;

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hämta Kambis per-event detalj (alla betOffers). Null vid fel. */
async function fetchKambiDetail(eventId) {
  const url = `${KAMBI_API_BASE}/${OFFERING}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": UA, referer: REFERER } });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch { clearTimeout(timer); return null; }
}

/**
 * Parsa totals (Total Goals) + Asian Handicap ur Kambis detalj-svar.
 * Odds + line ligger i MILLI (÷1000). Totals: type "Over/Under" crit "Total
 * Goals", outcome OT_OVER/OT_UNDER. AH: crit "Asian Handicap", outcome.label =
 * lagnamn, line tecknad per lag (hemma-perspektiv = hemmalagets line).
 */
function parseKambiTotalsAh(data, homeTeam, awayTeam) {
  const betOffers = Array.isArray(data?.betOffers) ? data.betOffers : [];
  const totals = [];
  const ah = [];
  const cornerTotals = [];
  const hN = String(homeTeam ?? "").toLowerCase();
  const aN = String(awayTeam ?? "").toLowerCase();
  const ok = (x) => (!x?.status || x.status === "OPEN") && Number(x?.odds) / 1000 > 1;
  // Hörn-total (Over/Under :: Total Corners) — samma form som mål-total. recon 2026-06-26.
  const parseOU = (outs) => {
    let over = null, under = null, line = null;
    for (const x of outs) {
      if (!ok(x)) continue;
      const odd = Number(x.odds) / 1000, ln = Number(x.line) / 1000;
      if (x.type === "OT_OVER" || /över|over/i.test(String(x.label))) { over = odd; if (line == null) line = ln; }
      else if (x.type === "OT_UNDER" || /under/i.test(String(x.label))) { under = odd; if (line == null) line = ln; }
    }
    return over > 1 && under > 1 && Number.isFinite(line) ? { line, over, under } : null;
  };
  for (const o of betOffers) {
    const type = String(o?.betOfferType?.englishName ?? "");
    const crit = String(o?.criterion?.englishLabel ?? "").trim().toLowerCase();
    const outs = Array.isArray(o?.outcomes) ? o.outcomes : [];
    if (type === "Over/Under" && crit === "total goals") {
      const t = parseOU(outs); if (t) totals.push(t);
    } else if (type === "Over/Under" && crit === "total corners") {
      const t = parseOU(outs); if (t) cornerTotals.push(t);
    } else if (crit === "asian handicap" && type === "Asian Handicap") {
      let home = null, away = null, homeLine = null;
      for (const x of outs) {
        if (!ok(x)) continue;
        const odd = Number(x.odds) / 1000, ln = Number(x.line) / 1000;
        const lbl = String(x.label ?? "").toLowerCase();
        if (hN && (hN.includes(lbl) || lbl.includes(hN))) { home = odd; homeLine = ln; }
        else if (aN && (aN.includes(lbl) || lbl.includes(aN))) { away = odd; }
      }
      if (home > 1 && away > 1 && Number.isFinite(homeLine)) ah.push({ line: homeLine, home, away });
    }
  }
  return { totals, ah, cornerTotals };
}

function readPreviousPayload() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function fetchRegionEvents(regionTerm) {
  const url = `${KAMBI_API_BASE}/${OFFERING}/listView/football/${regionTerm}.json?lang=sv_SE&market=SE`;
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
          referer: REFERER,
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
      if (response.status === 404) {
        // Vissa region-paths existerar inte för alla offerings → tom array, inte fel
        return { events: [], notFound: true };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      const data = await response.json();
      return { events: data?.events ?? [] };
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
  throw new Error(lastErr ?? "Kambi region fetch failed");
}

/**
 * Parse 1X2 från en Kambi listView betOffer. Identisk logik som
 * kambiMainOfferTriple + findKambiMatchMainOffer i vite.config.ts.
 */
function parseKambi1X2(betOffers) {
  if (!Array.isArray(betOffers) || betOffers.length === 0) return null;
  const isMatchFullTime = (offer) => {
    if (offer?.betOfferType?.englishName !== "Match") return false;
    const crit = String(offer?.criterion?.englishLabel ?? "").trim().toLowerCase();
    return crit === "full time" || crit === "fulltid";
  };
  const labelsStr = (offer) => (offer?.outcomes ?? []).map((o) => o?.label).join("|");

  const mainOffer =
    betOffers.find(
      (o) => isMatchFullTime(o) && labelsStr(o) === "1|X|2" && Array.isArray(o.tags) && o.tags.includes("MAIN"),
    ) ?? betOffers.find((o) => isMatchFullTime(o) && labelsStr(o) === "1|X|2");
  if (!mainOffer?.outcomes || mainOffer.outcomes.length !== 3) return null;

  // First pass: only OPEN outcomes
  const tryTriple = (allowSuspended) => {
    const oddsByLabel = {};
    for (const outcome of mainOffer.outcomes) {
      const active = allowSuspended ? true : outcome?.status === "OPEN" || outcome?.status == null;
      if (!active || !outcome?.label || outcome?.odds == null) continue;
      oddsByLabel[outcome.label] = Number(outcome.odds) / 1000;
    }
    const home = oddsByLabel["1"];
    const draw = oddsByLabel.X;
    const away = oddsByLabel["2"];
    if (home > 1 && draw > 1 && away > 1) return { home, draw, away };
    return null;
  };
  return tryTriple(false) ?? tryTriple(true);
}

/**
 * Parse 2-vägs moneyline (basket/tennis) från Kambi betOffers. Criterion
 * "Matchodds"/"Match Odds" med 2 outcomes (home, away positionellt — Kambi
 * listar home först).
 */
function parseKambiMoneyline2Way(betOffers) {
  if (!Array.isArray(betOffers) || betOffers.length === 0) return null;
  const is2Way = (o) => {
    const crit = String(o?.criterion?.englishLabel ?? o?.criterion?.label ?? "").trim().toLowerCase();
    const ok = o?.betOfferType?.englishName === "Match" || /match\s*odds|moneyline|head\s*to\s*head|to\s*win|winner/.test(crit);
    return ok && Array.isArray(o?.outcomes) && o.outcomes.length === 2;
  };
  const offer =
    betOffers.find((o) => is2Way(o) && Array.isArray(o.tags) && o.tags.includes("MAIN")) ??
    betOffers.find(is2Way);
  if (!offer?.outcomes || offer.outcomes.length !== 2) return null;
  const priceOf = (oc, allowSuspended) => {
    const active = allowSuspended ? true : oc?.status === "OPEN" || oc?.status == null;
    if (!active || oc?.odds == null) return null;
    const p = Number(oc.odds) / 1000;
    return p > 1 ? p : null;
  };
  const tryPair = (allowSuspended) => {
    // Mappa via Kambis outcome-label ("1" = home, "2" = away) — SAMMA kanoniska
    // markör som 1X2-parsern. Outcomes kan returneras i annan ordning än
    // event.homeName/awayName (sett på t.ex. ITF-tennis), så att mappa på
    // ARRAY-POSITION swappar oddsen mellan spelarna → falska "value bets".
    const byLabel = {};
    for (const oc of offer.outcomes) {
      const lbl = String(oc?.label ?? "").trim();
      if (lbl === "1" || lbl === "2") byLabel[lbl] = priceOf(oc, allowSuspended);
    }
    if (byLabel["1"] != null && byLabel["2"] != null) {
      return { home: byLabel["1"], away: byLabel["2"] };
    }
    // Fallback (inga "1"/"2"-labels): behåll legacy position-mappning.
    const prices = offer.outcomes.map((oc) => priceOf(oc, allowSuspended));
    if (prices.length === 2 && prices[0] != null && prices[1] != null) {
      return { home: prices[0], away: prices[1] };
    }
    return null;
  };
  return tryPair(false) ?? tryPair(true);
}

/**
 * Hämta + parsa 2-vägs events för en sport (basket/tennis) via top-level
 * listView/{sport}.json (ingen region-fan-out — returnerar alla matcher).
 */
async function fetchKambi2WaySport(sport, sportTag) {
  const url = `${KAMBI_API_BASE}/${OFFERING}/listView/${sport}.json?lang=sv_SE&market=SE`;
  let data = null;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": UA, referer: REFERER } });
      clearTimeout(timer);
      if ((r.status === 429 || r.status >= 500) && attempt < RETRY_MAX_ATTEMPTS) { await sleep(RETRY_BASE_DELAY_MS * attempt); continue; }
      if (!r.ok) return [];
      data = await r.json();
      break;
    } catch {
      clearTimeout(timer);
      if (attempt < RETRY_MAX_ATTEMPTS) { await sleep(RETRY_BASE_DELAY_MS * attempt); continue; }
      return [];
    }
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const out = [];
  for (const entry of events) {
    const event = entry?.event;
    if (!event?.id) continue;
    const odds = parseKambiMoneyline2Way(entry?.betOffers);
    if (!odds) continue;
    // KANONISK titel = "homeName - awayName" så titelns lag-ordning ALLTID matchar
    // odds.home/away (odds mappas via label "1"=home/"2"=away). event.name kan
    // lista spelarna i omvänd ordning (sett på ITF-tennis) → titel-splittande
    // konsumenter kopplade då fel odds till fel spelare = falska value bets.
    const homeName = event.homeName ? String(event.homeName).trim() : "";
    const awayName = event.awayName ? String(event.awayName).trim() : "";
    const canonicalTitle =
      homeName && awayName
        ? `${homeName} - ${awayName}`
        : String(event.name ?? event.englishName ?? "").trim();
    out.push({
      eventId: String(event.id),
      title: canonicalTitle,
      homeTeam: event.homeName ?? null,
      awayTeam: event.awayName ?? null,
      startTime: event.start ?? null,
      league: event.group ?? null,
      sport: sportTag,
      odds,
    });
  }
  return out;
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

async function main() {
  const startMs = Date.now();
  // Backstop: avsluta rent (exit 0) före jobbets timeout (5 min) om något hänger,
  // så commit-steget kör i stället för SIGKILL. Inget skrivs vid deadline → den
  // tidigare cachen bevaras orörd.
  const deadline = installHardDeadline({
    budgetMs: Number(process.env.ATG_DEADLINE_MS) || 4 * 60 * 1000,
    label: "atg",
  });
  console.log(`[kambi] start — fetching ${REGION_TERMS.length} regions (offering=${OFFERING}, concurrency=${REGION_CONCURRENCY})`);

  // Map<eventId, { event, betOffers }> för dedupe
  const eventsById = new Map();
  let totalFetchErrors = 0;
  let totalFetchedRegions = 0;

  // Enkel concurrency-bucket
  const queue = [...REGION_TERMS];
  const workers = Array.from({ length: REGION_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const regionTerm = queue.shift();
      if (!regionTerm) break;
      const t0 = Date.now();
      try {
        const { events, notFound } = await fetchRegionEvents(regionTerm);
        const ms = Date.now() - t0;
        if (notFound) {
          console.log(`[kambi] · ${regionTerm.padEnd(28)} ${ms}ms · 404 (region not supported by offering)`);
          continue;
        }
        let added = 0;
        for (const entry of events) {
          const id = entry?.event?.id;
          if (id == null) continue;
          if (!eventsById.has(id)) {
            eventsById.set(id, entry);
            added += 1;
          }
        }
        totalFetchedRegions += 1;
        console.log(`[kambi] ✓ ${regionTerm.padEnd(28)} ${ms}ms · ${events.length} events (added ${added} unique)`);
      } catch (e) {
        totalFetchErrors += 1;
        const ms = Date.now() - t0;
        console.error(`[kambi] ✗ ${regionTerm.padEnd(28)} ${ms}ms · ${e?.message ?? e}`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`[kambi] fetched ${eventsById.size} unique events from ${totalFetchedRegions}/${REGION_TERMS.length} regions (${totalFetchErrors} errors)`);

  // Parse 1X2 från embedded betOffers
  const parsed = [];
  let skippedNoOdds = 0;
  let skippedNotFootball = 0;
  for (const entry of eventsById.values()) {
    const event = entry?.event;
    if (!event?.id) continue;
    if (event.sport && event.sport !== "FOOTBALL") {
      skippedNotFootball += 1;
      continue;
    }
    const odds = parseKambi1X2(entry?.betOffers);
    if (!odds) {
      skippedNoOdds += 1;
      continue;
    }
    parsed.push({
      eventId: String(event.id),
      title: String(event.name ?? event.englishName ?? "").trim(),
      homeTeam: event.homeName ?? null,
      awayTeam: event.awayName ?? null,
      startTime: event.start ?? null,
      league: event.group ?? null,
      odds,
    });
  }

  // ── Totals + AH via BUNDNA detalj-anrop (/betoffer/event/{id}) ──
  // listView ger bara 1X2; detalj-endpointen ger alla marknader. Vi tar de N
  // matcher närmast avspark, strypt concurrency + delay → begränsad last.
  const nowMs = Date.now();
  const detailTargets = parsed
    .filter((e) => { const t = Date.parse(e.startTime ?? ""); return Number.isFinite(t) && t > nowMs; })
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
    .slice(0, KAMBI_DETAIL_MAX);
  let detailOk = 0, detailWithLines = 0;
  {
    const queue = [...detailTargets];
    const workers = Array.from({ length: KAMBI_DETAIL_CONCURRENCY }, async () => {
      while (queue.length) {
        const ev = queue.shift();
        if (!ev) break;
        const data = await fetchKambiDetail(ev.eventId);
        if (data) {
          detailOk += 1;
          const { totals, ah, cornerTotals } = parseKambiTotalsAh(data, ev.homeTeam, ev.awayTeam);
          if (totals.length) ev.totals = totals;
          if (ah.length) ev.ah = ah;
          if (cornerTotals.length) ev.corners = { totals: cornerTotals };
          if (totals.length || ah.length || cornerTotals.length) detailWithLines += 1;
        }
        await sleep(120);
      }
    });
    await Promise.all(workers);
  }
  console.log(`[kambi] detalj-anrop: ${detailOk}/${detailTargets.length} ok, ${detailWithLines} med totals/AH`);

  // Basket + tennis (2-vägs moneyline) — top-level listView, ingen region-fan-out.
  let eventsBasket = [];
  let eventsTennis = [];
  try { eventsBasket = await fetchKambi2WaySport("basketball", "basketball"); } catch (e) { console.warn("[kambi] basket failed:", e?.message ?? e); }
  try { eventsTennis = await fetchKambi2WaySport("tennis", "tennis"); } catch (e) { console.warn("[kambi] tennis failed:", e?.message ?? e); }
  console.log(`[kambi] 2-way: ${eventsBasket.length} basket + ${eventsTennis.length} tennis`);

  const status =
    totalFetchedRegions === 0 ? "error" : parsed.length === 0 ? "empty" : "active";

  // Cache-preserve: behåll föregående payload om vi inte kunde fetcha någonting
  if (status === "error") {
    const prev = readPreviousPayload();
    if (prev?.events?.length) {
      console.warn(`[kambi] alla regioner failade — behåller föregående payload (skapad ${prev.updatedAt})`);
      process.exit(2);
    }
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "github-actions",
    bookmaker: "atg",
    displayName: "ATG",
    group: "kambi",
    offering: OFFERING,
    status,
    fetchedRegions: totalFetchedRegions,
    failedRegions: totalFetchErrors,
    totalRegions: REGION_TERMS.length,
    uniqueEvents: eventsById.size,
    skippedNoOdds,
    skippedNotFootball,
    durationMs: Date.now() - startMs,
    events: parsed,
    eventsBasket,
    eventsTennis,
    basketEventsCount: eventsBasket.length,
    tennisEventsCount: eventsTennis.length,
    lastError: totalFetchErrors > 0 ? `${totalFetchErrors} region(s) failed` : null,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  deadline.cancel();
  atomicWriteString(OUTPUT_FILE, JSON.stringify(payload, null, 2) + "\n");

  console.log(
    `[kambi] done — ${parsed.length} parsed events (skipped noOdds=${skippedNoOdds}, notFootball=${skippedNotFootball}) in ${payload.durationMs}ms`,
  );
  console.log(`[kambi] wrote ${path.relative(process.cwd(), OUTPUT_FILE)}`);
}

main().catch((e) => {
  console.error(`[kambi] fatal: ${e?.message ?? e}`);
  process.exit(1);
});
