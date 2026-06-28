#!/usr/bin/env node
/**
 * Match-RESULTAT-hämtare (Sofascore) — GitHub Actions.
 *
 * Problem: Sofascore Cloudflare-blockar BÅDE Renders IP och rena API-anrop
 * från Actions-runners — även genom Mullvad-VPN (verifierat 2026-06-12:
 * HTTP 403 på .com/.app/www trots svensk Mullvad-exit). Ren HTTP-klient
 * räcker alltså inte oavsett IP.
 *
 * Lösning i två steg (samma som Betsson-scrapern, som passerar Cloudflare
 * dagligen): 1) försök billiga direkta API-anrop (om Cloudflare lättar är
 * det gratis), 2) annars stealth-Chromium som laddar www.sofascore.com
 * (löser ev. challenge, får cf_clearance + riktig TLS-fingerprint) och gör
 * API-anropen INIFRÅN sidan (same-origin fetch). Browser + VPN ≈ vanlig
 * besökare.
 *
 * Hämtar FÄRDIGA matcher (igår + idag UTC) för fotboll/basket/tennis och
 * publicerar data/match-results.json (+ Supabase-spegel via scrape-guard).
 * Render läser bara den publicerade filen — pratar aldrig med Sofascore.
 *
 * Robusthet: en dag/sport-nyckel som ger 0 i denna körning behåller
 * föregående körnings data (aldrig klottra över bra data med tomt).
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteString } from "./lib/scrape-guard.mjs";

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "match-results.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const DELAY_MS = 1_500;

const SOFASCORE_HOSTS = [
  "https://api.sofascore.com/api/v1",
  "https://api.sofascore.app/api/v1",
  "https://www.sofascore.com/api/v1",
];

/** Vårt interna sportKey → Sofascore-slug. */
const SPORTS = [
  { key: "soccer", slug: "football" },
  { key: "basketball", slug: "basketball" },
  { key: "tennis", slug: "tennis" },
];

// ── API-Sports (api-football.com / api-basketball.com) ──────────────────────
// Keyad gratiskälla (100 anrop/dag) som täcker nischligor Sofascore hade gett
// oss men låser. No-op utan API_SPORTS_KEY → ren tilläggskälla, bryter inget.
const API_SPORTS_KEY = (process.env.API_SPORTS_KEY || "").trim();
const API_SPORTS = {
  soccer: { host: "v3.football.api-sports.io", path: "fixtures" },
  basketball: { host: "v1.basketball.api-sports.io", path: "games" },
  // tennis stöds ej av API-Sports → faller tillbaka på övriga källor.
};

/** Hämta FÄRDIGA matcher för en dag+sport från API-Sports. Tom lista utan key. */
async function fetchDayApiSports(sportKey, date) {
  if (!API_SPORTS_KEY) return { events: [], diag: "ingen API_SPORTS_KEY" };
  const cfg = API_SPORTS[sportKey];
  if (!cfg) return { events: [], diag: "sport stöds ej av API-Sports" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const r = await fetch(`https://${cfg.host}/${cfg.path}?date=${date}`, {
      headers: { "x-apisports-key": API_SPORTS_KEY, Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { events: [], diag: `api-sports: HTTP ${r.status}` };
    const j = await r.json();
    const raw = Array.isArray(j?.response) ? j.response : [];
    const events = [];
    for (const item of raw) {
      let home, away, hs, as, finished, startTs, league;
      if (sportKey === "soccer") {
        // fixtures-shape: { teams:{home,away}, goals:{home,away}, fixture:{status,date}, league:{name} }
        home = String(item?.teams?.home?.name ?? "").trim();
        away = String(item?.teams?.away?.name ?? "").trim();
        hs = item?.goals?.home;
        as = item?.goals?.away;
        const st = String(item?.fixture?.status?.short ?? "");
        finished = ["FT", "AET", "PEN"].includes(st);
        startTs = item?.fixture?.date ?? null;
        league = item?.league?.name ?? null;
      } else {
        // games-shape (basketball): { teams:{home,away}, scores:{home:{total},away:{total}}, status:{short}, date, league:{name} }
        home = String(item?.teams?.home?.name ?? "").trim();
        away = String(item?.teams?.away?.name ?? "").trim();
        hs = item?.scores?.home?.total;
        as = item?.scores?.away?.total;
        const st = String(item?.status?.short ?? "");
        finished = st === "FT" || st === "AOT";
        startTs = item?.date ?? null;
        league = item?.league?.name ?? null;
      }
      if (!home || !away || !finished) continue;
      if (typeof hs !== "number" || typeof as !== "number") continue;
      events.push({ home, away, homeScore: hs, awayScore: as, startTs: startTs ?? null, league: league ?? null });
    }
    return { events, diag: `api-sports: HTTP 200, ${raw.length} rows (${events.length} finished)` };
  } catch (e) {
    return { events: [], diag: `api-sports: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readPreviousPayload() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return null;
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Normalisera Sofascores råa event-lista till FÄRDIGA matcher i resolverns form. */
function normalizeSofaEvents(raw) {
  const events = [];
  for (const ev of Array.isArray(raw) ? raw : []) {
    const home = String(ev?.homeTeam?.name ?? "").trim();
    const away = String(ev?.awayTeam?.name ?? "").trim();
    if (!home || !away) continue;
    if (ev?.status?.type !== "finished") continue; // bara slutresultat
    const hs = ev?.homeScore?.current ?? ev?.homeScore?.display;
    const as = ev?.awayScore?.current ?? ev?.awayScore?.display;
    if (typeof hs !== "number" || typeof as !== "number") continue;
    const startSec = Number(ev?.startTimestamp);
    const league =
      String(ev?.tournament?.uniqueTournament?.name ?? "").trim() ||
      String(ev?.tournament?.name ?? "").trim() ||
      null;
    events.push({
      home,
      away,
      homeScore: hs,
      awayScore: as,
      startTs: Number.isFinite(startSec) && startSec > 0 ? new Date(startSec * 1000).toISOString() : null,
      league,
    });
  }
  return events;
}

/** Steg 1: direkta API-anrop med värd-fallback. */
async function fetchDayDirect(slug, date) {
  const diag = [];
  for (const host of SOFASCORE_HOSTS) {
    const hostName = new URL(host).host;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const r = await fetch(`${host}/sport/${slug}/scheduled-events/${date}`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
          Referer: "https://www.sofascore.com/",
          Origin: "https://www.sofascore.com",
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        diag.push(`${hostName}: HTTP ${r.status}`);
        continue;
      }
      const j = await r.json();
      const raw = Array.isArray(j?.events) ? j.events : [];
      const events = normalizeSofaEvents(raw);
      diag.push(`${hostName}: HTTP 200, ${raw.length} events (${events.length} finished)`);
      return { events, diag: diag.join(" · ") };
    } catch (e) {
      diag.push(`${hostName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { events: [], diag: diag.join(" · ") };
}

/**
 * Steg 2: browser-fallback. Stealth-Chromium laddar sofascore.com (löser
 * Cloudflare-challenge) och gör same-origin-fetches inifrån sidan.
 * Returnerar Map key→{events, diag} för de nycklar som lyckades.
 */
async function fetchPendingViaBrowser(pending) {
  const out = new Map();
  let browser = null;
  try {
    const { chromium } = await import("playwright-extra");
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    chromium.use(StealthPlugin());

    console.log("[results] browser-fallback: startar stealth-Chromium…");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "sv-SE",
      userAgent: UA,
    });
    const page = await ctx.newPage();
    await page.goto("https://www.sofascore.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Ge en eventuell Cloudflare-challenge tid att lösa sig själv.
    await page.waitForTimeout(8_000);
    const title = await page.title().catch(() => "");
    console.log(`[results] browser-fallback: sidladdning klar (title="${title.slice(0, 60)}")`);

    for (const p of pending) {
      try {
        const res = await page.evaluate(async (apiPath) => {
          const r = await fetch(apiPath, { headers: { Accept: "application/json" } });
          if (!r.ok) return { status: r.status, events: null };
          const j = await r.json();
          return { status: r.status, events: Array.isArray(j?.events) ? j.events : [] };
        }, `/api/v1/sport/${p.slug}/scheduled-events/${p.date}`);
        if (res.events) {
          const events = normalizeSofaEvents(res.events);
          out.set(p.key, {
            events,
            diag: `browser: HTTP 200, ${res.events.length} events (${events.length} finished)`,
          });
        } else {
          out.set(p.key, { events: [], diag: `browser: HTTP ${res.status}` });
        }
      } catch (e) {
        out.set(p.key, { events: [], diag: `browser: ${e instanceof Error ? e.message : String(e)}` });
      }
      await sleep(1_200);
    }
  } catch (e) {
    console.warn(`[results] browser-fallback misslyckades: ${e instanceof Error ? e.message : e}`);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function main() {
  const now = new Date();
  const days = [isoDateUTC(new Date(now.getTime() - 86_400_000)), isoDateUTC(now)];
  const previous = readPreviousPayload();

  /** dayKey "YYYY-MM-DD::sportKey" → finished events */
  const daysOut = {};
  const diagOut = {};
  const pending = [];

  // Steg 1: direkta API-anrop (billigast — fungerar de är vi klara).
  for (const sport of SPORTS) {
    for (const date of days) {
      const key = `${date}::${sport.key}`;
      const { events, diag } = await fetchDayDirect(sport.slug, date);
      diagOut[key] = diag;
      if (events.length > 0) {
        daysOut[key] = events;
      } else {
        pending.push({ key, slug: sport.slug, date });
      }
      await sleep(DELAY_MS);
    }
  }

  // Steg 2: API-Sports (keyad gratiskälla) för nycklar utan data. Täcker
  // nischligor (fotboll + basket; ej tennis) som Sofascore hade gett oss.
  // No-op utan API_SPORTS_KEY → hoppar tyst över.
  if (API_SPORTS_KEY) {
    let stillPending = [];
    for (const p of pending) {
      const sportKey = p.key.split("::")[1];
      const { events, diag } = await fetchDayApiSports(sportKey, p.date);
      diagOut[p.key] += ` → ${diag}`;
      if (events.length > 0) daysOut[p.key] = events;
      else stillPending.push(p);
      await sleep(DELAY_MS);
    }
    pending.length = 0;
    pending.push(...stillPending);
  }

  // Steg 3: browser-fallback för nycklar som varken direkt-API eller API-Sports
  // fick data för (sista chansen för t.ex. tennis om Cloudflare lättat).
  if (pending.length > 0) {
    console.log(`[results] ${pending.length} nycklar utan data — provar browser-fallback`);
    const browserResults = await fetchPendingViaBrowser(pending);
    for (const p of pending) {
      const r = browserResults.get(p.key);
      if (!r) continue;
      diagOut[p.key] += ` → ${r.diag}`;
      if (r.events.length > 0) daysOut[p.key] = r.events;
    }
  }

  // Steg 4: behåll föregående data för nycklar som fortfarande saknar.
  let totalFinished = 0;
  for (const sport of SPORTS) {
    for (const date of days) {
      const key = `${date}::${sport.key}`;
      if (!daysOut[key]?.length && previous?.days?.[key]?.length) {
        daysOut[key] = previous.days[key];
        diagOut[key] += " → behöll föregående data";
      }
      totalFinished += daysOut[key]?.length ?? 0;
    }
  }

  for (const sport of SPORTS) {
    const n = days.reduce((acc, d) => acc + (daysOut[`${d}::${sport.key}`]?.length ?? 0), 0);
    console.log(`[results] ${sport.key}: ${n} färdiga matcher`);
  }

  if (totalFinished === 0 && previous) {
    console.warn("[results] 0 färdiga matcher totalt — behåller hela föregående fil orörd");
    console.warn(`[results] diag: ${JSON.stringify(diagOut)}`);
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "github-actions",
    days: daysOut,
    diag: diagOut,
  };
  // atomicWriteString speglar automatiskt till Supabase (odds_cache
  // source_id "match-results") — no-op utan secrets.
  atomicWriteString(OUTPUT_FILE, JSON.stringify(payload));
  console.log(
    `[results] skrev ${OUTPUT_FILE}: ${totalFinished} färdiga matcher över ${Object.keys(daysOut).length} dag/sport-nycklar`,
  );
}

main().catch((e) => {
  console.error("[results] fatal:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
