/**
 * scrape-guard.mjs — delade robusthets-primitiver för alla odds-scrapers.
 *
 * Bakgrund: varje scraper körs i ett GitHub Actions-jobb (eller VPS-timer) med
 * en hård `timeout-minutes`. Om själva scrapen hänger (långsam Mullvad-relay,
 * site som svarar segt, Cloudflare-challenge som aldrig löser) når jobbet sin
 * timeout och dödas med SIGKILL — INNAN commit-steget hinner köra. Resultatet:
 * datan som faktiskt hämtades sparas aldrig, och källan blir stale trots att
 * den egentligen fungerade.
 *
 * Den här modulen ger tre byggstenar som gör scrapers durabelt motståndskraftiga:
 *
 *   1. installHardDeadline() — en intern deadline som löser ut FÖRE jobbets
 *      timeout, skriver den partiella datan som hunnit samlas in och avslutar
 *      rent (exit 0) så commit-steget kör. Aldrig mer "allt-eller-inget"-SIGKILL.
 *
 *   2. writeJsonPreservingCache() — atomisk write som vägrar klottra över en
 *      icke-tom cache med tom data. En misslyckad körning förstör aldrig en
 *      tidigare lyckad cache.
 *
 *   3. readJsonSafe() — läser befintlig cache utan att kasta (för guards ovan).
 *
 * Designprincip: dessa är rena hjälpfunktioner utan beroenden, så att VARJE
 * scraper (Playwright, swarm-WS, REST) kan dra nytta av samma skydd.
 */

import fs from "node:fs";
import path from "node:path";
import { mirrorOddsFile } from "./odds-db.mjs";

/**
 * Installerar en intern deadline som löser ut innan jobbets hårda timeout.
 *
 * När deadline:n nås anropas `onDeadline` (som typiskt skriver partiell data
 * eller bevarar cachen) och därefter avslutas processen rent med exit-kod 0 —
 * så att efterföljande commit-steg kör. Detta är skillnaden mellan "scrapen
 * hängde → SIGKILL → ingen commit → stale" och "scrapen hängde → vi sparade
 * det vi hann → commit → källan färsk(are)".
 *
 * @param {object} opts
 * @param {number} opts.budgetMs   Millisekunder från nu tills deadline löser ut.
 *                                  Sätt till ~75-80% av jobbets timeout-minutes.
 * @param {string} opts.label      Loggprefix, t.ex. "betsson-action".
 * @param {() => (void|Promise<void>)} [opts.onDeadline]  Körs vid deadline,
 *                                  före exit(0). Bör spara partiell data.
 * @returns {{ cancel: () => void }}  Anropa cancel() vid normal slutförd körning.
 */
export function installHardDeadline({ budgetMs, label, onDeadline }) {
  const start = Date.now();
  let fired = false;

  const timer = setTimeout(async () => {
    fired = true;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.warn(
      `[${label}] ⏱  HARD DEADLINE nådd efter ${elapsed}s (budget ${(budgetMs / 1000).toFixed(0)}s) — ` +
        `sparar partiell data och avslutar rent (exit 0) innan job-timeout SIGKILL.`,
    );
    try {
      if (onDeadline) await onDeadline();
    } catch (error) {
      console.error(`[${label}] onDeadline-fel:`, error?.message ?? error);
    }
    // exit 0 så att commit-steget kör. Vi har medvetet bevarat/sparat data.
    process.exit(0);
  }, budgetMs);

  // Låt inte timern hålla event-loopen vid liv om allt annat är klart.
  timer.unref?.();

  return {
    cancel() {
      if (!fired) clearTimeout(timer);
    },
  };
}

/**
 * Adaptiv query-budget: läser förra körningens utfall (sparat i datafilens
 * `_tuning`-fält) och beslutar hur många queries DEN HÄR körningen ska köra.
 *
 * Självreglerande loop som gör scrapern uthållig oavsett dagsform på site/VPN:
 *   - Träffade förra körningen hard-deadline (partiell)? → krymp budgeten 20 %
 *     (ner till minLimit) så vi hinner klart nästa gång.
 *   - Klarade förra körningen sig på <60 % av budgeten? → väx 15 % (upp till
 *     maxLimit) och återta täckning när det går snabbt igen.
 *   - Annars: behåll.
 *
 * @returns {{ limit: number, note: string, prevTuning: object|null }}
 */
export function readAdaptiveLimit({ file, defaultLimit, minLimit, maxLimit, label = "scrape-guard" }) {
  const clamp = (n) => Math.min(maxLimit, Math.max(minLimit, Math.round(n)));
  const t = readJsonSafe(file)?._tuning;
  if (!t || typeof t.limitUsed !== "number") {
    return { limit: clamp(defaultLimit), note: "ingen tidigare tuning → default", prevTuning: null };
  }
  let next = t.limitUsed;
  let note;
  if (t.hitDeadline) {
    next = Math.max(minLimit, Math.floor(t.limitUsed * 0.8));
    note = `förra körningen träffade deadline (${Math.round((t.runMs ?? 0) / 1000)}s) → krymper ${t.limitUsed}→${clamp(next)}`;
  } else if (
    typeof t.runMs === "number" &&
    typeof t.deadlineMs === "number" &&
    t.runMs < t.deadlineMs * 0.6
  ) {
    next = Math.min(maxLimit, Math.ceil(t.limitUsed * 1.15));
    note = `förra körningen klar på ${Math.round(t.runMs / 1000)}s (<60% budget) → växer ${t.limitUsed}→${clamp(next)}`;
  } else {
    note = `förra körningen klar inom budget → behåller ${clamp(next)}`;
  }
  const limit = clamp(next);
  console.log(`[${label}] adaptiv query-budget: ${limit} (${note})`);
  return { limit, note, prevTuning: t };
}

/**
 * Bygger `_tuning`-objektet som sparas i datafilen så nästa körning kan läsa
 * utfallet via readAdaptiveLimit.
 */
export function buildTuning({ limitUsed, runStart, deadlineMs, hitDeadline }) {
  return {
    limitUsed,
    runMs: Date.now() - runStart,
    deadlineMs,
    hitDeadline: !!hitDeadline,
    decidedAt: new Date().toISOString(),
  };
}

/**
 * Atomisk write av en redan serialiserad sträng (temp-fil + rename). Garanterar
 * att en avbruten/SIGKILL:ad write aldrig lämnar en halvskriven, trasig fil på
 * målplatsen — läsaren ser antingen den gamla kompletta filen eller den nya.
 *
 * Behåller exakt de bytes anroparen ger (inklusive ev. avslutande newline) så
 * att befintlig output-formatering bevaras. För cache-bevarande logik, använd
 * writeJsonPreservingCache; den här är den råa atomiska primitiven.
 */
export function atomicWriteString(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
  // Spegla till odds-databasen (Supabase) — se docs/database-plan.md. Detta är
  // den ENDA kopplingspunkten: alla scrapers skriver via den här funktionen
  // (direkt eller via writeJsonPreservingCache), så en lyckad fil-write speglas
  // automatiskt. Fire-and-forget; total no-op utan SUPABASE-secrets; kan aldrig
  // kasta eller blockera fil-pipelinen.
  mirrorOddsFile(file, content);
}

/**
 * Filtrerar ett events[]-fält till ett tidsfönster (default 24h framåt).
 *
 * Bakgrund: valuebettern bryr sig om imminenta matcher. Att skrapa/behålla
 * matcher som startar långt fram (48–72h) späder ut fokus och — för betalda
 * Scrapfly-källor — gör att vi lägger renderbudget på odds som ändå rör sig
 * innan spel. Genom att kapa fönstret till 24h kan vi i stället lägga budgeten
 * på FREKVENS (färskhet) i 24h-fönstret.
 *
 * PREMATCH-ONLY (default): grace bakåt = 0 → redan startade/live events tappas.
 * Vi följer inga live-matcher just nu, så allt som redan sparkat igång filtreras bort.
 *
 * Tappar:
 *   - events som startar mer än `windowHours` fram i tiden
 *   - events som redan startat (startTime < nu − graceHours)
 *   - (om dropUnknown) events utan parsebar startTime (live visar ofta löpande klocka
 *     i st f starttid → okänd starttid = sannolikt live på prematch-sidor)
 *
 * @param {Array<object>} events    Lista med events; läser `startTime` (ISO/ms).
 * @param {object} [opts]
 * @param {number} [opts.windowHours=24]  Hur långt fram vi behåller.
 * @param {number} [opts.graceHours=0]    Hur långt bak vi behåller (0 = ingen live).
 * @param {boolean} [opts.dropUnknown=false]  Tappa events med okänd starttid (= ev. live).
 * @param {string} [opts.nowIso]          Override för "nu" (test); default Date.now().
 * @returns {{ kept: Array<object>, dropped: number }}
 */
export function filterToWindowHours(events, opts = {}) {
  if (!Array.isArray(events)) return { kept: [], dropped: 0 };
  const windowHours = opts.windowHours ?? 24;
  const graceHours = opts.graceHours ?? 0;
  const dropUnknown = opts.dropUnknown ?? false;
  const now = opts.nowIso ? Date.parse(opts.nowIso) : Date.now();
  const hiMs = now + windowHours * 3600 * 1000;
  const loMs = now - graceHours * 3600 * 1000;
  let dropped = 0;
  const kept = events.filter((ev) => {
    const t = Date.parse(ev?.startTime ?? "");
    if (!Number.isFinite(t)) { if (dropUnknown) { dropped++; return false; } return true; }
    if (t > hiMs || t < loMs) { dropped++; return false; }
    return true;
  });
  return { kept, dropped };
}

/**
 * Läser en JSON-fil utan att kasta. Returnerar `fallback` (default null) om
 * filen saknas eller är trasig.
 */
export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

/**
 * Atomisk JSON-write (skriv till temp-fil + rename) som vägrar klottra över en
 * icke-tom cache med tom data.
 *
 * Skyddet: om den nya payloaden bedöms "tom" (via `isEmpty`) MEN den befintliga
 * cachen har data, hoppas write:en över och cachen bevaras. Så en transient
 * fail (block, timeout, 0 events) raderar aldrig en tidigare lyckad hämtning.
 *
 * @param {string} file            Målfil.
 * @param {object} payload         Ny payload att skriva.
 * @param {object} [opts]
 * @param {string} [opts.label]    Loggprefix.
 * @param {(p:object)=>boolean} [opts.isEmpty]  Bedömer om payload är "tom".
 *                                 Default: payload.events är tom array.
 * @param {(p:object)=>number} [opts.countOf]   Räknar element för logg.
 * @returns {{ written: boolean, preserved: boolean }}
 */
export function writeJsonPreservingCache(file, payload, opts = {}) {
  const label = opts.label ?? "scrape-guard";
  const isEmpty = opts.isEmpty ?? ((p) => !Array.isArray(p?.events) || p.events.length === 0);
  const countOf = opts.countOf ?? ((p) => (Array.isArray(p?.events) ? p.events.length : 0));

  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (isEmpty(payload)) {
    const existing = readJsonSafe(file);
    if (existing && !isEmpty(existing)) {
      console.warn(
        `[${label}] Ny payload är tom (${countOf(payload)}) men cachen har ${countOf(existing)} ` +
          `— bevarar befintlig cache istället för att klottra över med tomt.`,
      );
      return { written: false, preserved: true };
    }
  }

  atomicWriteString(file, JSON.stringify(payload, null, 2));
  console.log(`[${label}] Skrev ${countOf(payload)} element → ${path.basename(file)}`);
  return { written: true, preserved: false };
}
