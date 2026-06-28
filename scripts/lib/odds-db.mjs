/**
 * odds-db.mjs — valfri spegling av odds-payloads till Supabase (riktig databas).
 *
 * Detta är steg 2 i databas-planen (docs/database-plan.md): "dubbelskrivning".
 * Scrapers fortsätter skriva sina datafiler + committa till GitHub precis som
 * idag (det är fortfarande sanningskällan), men varje lyckad fil-write speglas
 * OCKSÅ till tabellen `odds_cache` i Supabase. När databasen bevisat sig kan
 * appen börja läsa därifrån (steg 3) och GitHub-pipelinen slutar vara taket
 * för hur ofta vi kan hämta (pinnacle var 30:e sekund blir då möjligt).
 *
 * Säkerhetsdesign — den här modulen får ALDRIG påverka fil-pipelinen:
 *   - Saknas SUPABASE_URL/SUPABASE_SERVICE_KEY → total no-op (tyst).
 *     Det betyder att modulen är helt inert tills secrets läggs in i GitHub.
 *   - Fire-and-forget med timeout: blockerar aldrig, kastar aldrig.
 *   - Misslyckad spegling loggas som varning; filen/committen är opåverkad.
 *   - Nyckeln loggas aldrig.
 *
 * Tabellschema (skapas av användaren via SQL i docs/database-plan.md):
 *   odds_cache(source_id text primary key, payload jsonb, updated_at timestamptz)
 *
 * OBS: updated_at skickas alltid explicit — Postgres `default now()` gäller bara
 * vid INSERT, inte vid upsert-UPDATE, så utan explicit värde skulle tidsstämpeln
 * frysa på första insättningen.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_KEY = (
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ""
).trim();
const TIMEOUT_MS = (() => {
  const raw = Number(process.env.ODDS_DB_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 15000;
})();

// SPEGLINGS-STRYPNING per källa: spegla odds_cache som mest var N:e ms per källa.
// Innan mirror-fixen abortade ALLA speglingar → nästan inga writes. Efter fixen
// skriver alla 17 källor varje scrape (pinnacle 6MB var ~20s) → Supabase-CPU 100%.
// 60s strypning skär den dominerande pinnacle/betfair-lasten ~3x utan att tappa
// färskhet (admin-tröskel 120s, valuebet-grind 3min). Tillstånd i tmpdir → delas
// mellan per-iteration-node-processer på samma runner. 0 = av.
const MIRROR_MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.ODDS_DB_MIRROR_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60000;
})();
function mirrorThrottleFile(sourceId) {
  return path.join(os.tmpdir(), `oddsmirror-${sourceId.replace(/[^a-z0-9_-]/gi, "_")}.ts`);
}
function recentlyMirrored(sourceId) {
  if (MIRROR_MIN_INTERVAL_MS <= 0) return false;
  try {
    const last = Number(fs.readFileSync(mirrorThrottleFile(sourceId), "utf8"));
    return Number.isFinite(last) && Date.now() - last < MIRROR_MIN_INTERVAL_MS;
  } catch {
    return false;
  }
}
function markMirrored(sourceId) {
  try {
    fs.writeFileSync(mirrorThrottleFile(sourceId), String(Date.now()));
  } catch {
    /* best-effort */
  }
}

// Pågående spegel-POSTar. Per-iteration-scrapers (npx vite-node per varv) exit:ar
// annars innan den fire-and-forget POSTen hinner klart → "This operation was
// aborted" + DB-raden uppdateras ALDRIG. Scrapern ska anropa flushOddsDbMirrors()
// före main() returnerar så processen hålls vid liv tills speglingen är klar.
const pendingMirrors = new Set();
export async function flushOddsDbMirrors(maxWaitMs = 20000) {
  if (pendingMirrors.size === 0) return;
  await Promise.race([
    Promise.allSettled([...pendingMirrors]),
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

/** True när både URL och nyckel är konfigurerade (annars no-op-läge). */
export function oddsDbEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Spegla en datafil till odds_cache. Anropas av scrape-guard direkt efter en
 * lyckad atomisk fil-write — fire-and-forget (returnerar omedelbart).
 *
 * @param {string} file            Filvägen som just skrevs (source_id härleds
 *                                 från basnamnet: data/pinnacle-rows.json →
 *                                 "pinnacle-rows").
 * @param {string|object} content  Den skrivna JSON-strängen eller payload-objektet.
 * @param {object} [opts]
 * @param {string} [opts.label]    Loggprefix.
 */
// GLOBAL PAUS: när data/mirror-paused.flag finns (eller ODDS_DB_MIRROR_DISABLED=1)
// skrivs INGET till Supabase. Looparna pullar flaggan via sin git-reset → nästa
// scrape-iteration ser den. Använd för att låta en överbelastad DB återhämta sig.
// Scraping/git/valuebets påverkas inte (admin/valuebets läser GitHub/disk).
const MIRROR_PAUSE_FLAG = path.resolve(process.cwd(), "data", "mirror-paused.flag");
function mirrorPaused() {
  if (process.env.ODDS_DB_MIRROR_DISABLED === "1") return true;
  try {
    return fs.existsSync(MIRROR_PAUSE_FLAG);
  } catch {
    return false;
  }
}

export function mirrorOddsFile(file, content, opts = {}) {
  try {
    if (!oddsDbEnabled()) return; // inga secrets → inert
    if (mirrorPaused()) return; // global paus-flagga aktiv
    const label = opts.label ?? "odds-db";
    const sourceId = path.basename(file, ".json");

    // Strypning: spegla som mest var MIRROR_MIN_INTERVAL_MS per källa (Supabase-CPU).
    if (recentlyMirrored(sourceId)) return;
    markMirrored(sourceId);

    // Acceptera både färdiga objekt och JSON-strängar. Ogiltig JSON (icke-odds-
    // fil) hoppas över tyst — databasen ska bara innehålla giltiga payloads.
    let payload = content;
    if (typeof content === "string") {
      try {
        payload = JSON.parse(content);
      } catch {
        return;
      }
    }
    if (payload === null || typeof payload !== "object") return;

    const body = JSON.stringify([
      { source_id: sourceId, payload, updated_at: new Date().toISOString() },
    ]);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();

    // PostgREST-upsert: on_conflict på primärnyckeln + merge-duplicates.
    // Promisen registreras i pendingMirrors så scrapern kan await:a flushen före
    // process-exit (annars abortas POSTen och DB-raden uppdateras aldrig).
    const p = fetch(`${SUPABASE_URL}/rest/v1/odds_cache?on_conflict=source_id`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body,
      signal: controller.signal,
    })
      .then(async (res) => {
        clearTimeout(timer);
        if (res.ok) {
          console.log(`[${label}] odds-db: ${sourceId} speglad (${body.length} bytes)`);
        } else {
          const text = await res.text().catch(() => "");
          console.warn(
            `[${label}] odds-db: HTTP ${res.status} för ${sourceId} (${text.slice(0, 200)}) — fil-pipelinen opåverkad`,
          );
        }
      })
      .catch((error) => {
        clearTimeout(timer);
        console.warn(
          `[${label}] odds-db: spegling misslyckades för ${sourceId} (${error?.message ?? error}) — fil-pipelinen opåverkad`,
        );
      })
      .finally(() => pendingMirrors.delete(p));
    pendingMirrors.add(p);
  } catch (error) {
    // Absolut sista skyddsnät — modulen får aldrig kasta in i scrapern.
    console.warn(`[odds-db] oväntat fel (${error?.message ?? error}) — ignoreras`);
  }
}
