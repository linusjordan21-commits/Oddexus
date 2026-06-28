#!/usr/bin/env node
/**
 * Source freshness audit.
 *
 * Läser .github/workflows/*.yml + data/*-rows.json|*-drops.json|*-status.json
 * och skriver ut en tabell med "hur ofta vi hämtar / när senast / hur gamla
 * oddsen är just nu / är det stale?" för alla bakgrunds-scrape-källor.
 *
 * Output: tabell + flaggor (missing file, missing updatedAt, stale, etc).
 * Exit code:
 *   0 = alla källor fresh (eller info-only-status)
 *   1 = ≥1 källa är stale eller saknar data → CI kan failas vid behov
 *
 * Sources audited (matchar SOURCE_REGISTRY i vite.config.ts):
 *   - Pinnacle (sharp)
 *   - SportyBet NG, Bet7, Bet9ja (foreign bookmaker)
 *   - ComeOn, Betsson, VBET (svenska bookmakers)
 *   - Football.com (external drop signal)
 *
 * Bookmakers utan workflow (on-demand scrape via valuebets-pipelinen):
 *   - Unibet (Kambi), DBET/MrVegas/MegaRiches (Altenar), Hajper/Snabbare
 *     (delar comeon-workflow), X3000/Goldenbull/1x2/Speedybet (Paf-brand),
 *     Bethard/Spelklubben (Betsson-search)
 *   Dessa har ingen disk-cache, scrape:as per valuebet-request med 30-60s
 *   minne-cache. Listas separat i tabellen som "on_demand".
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const WF_DIR = path.join(ROOT, ".github/workflows");
const DATA_DIR = path.join(ROOT, "data");

// Single source of truth — synkad med SOURCE_REGISTRY i vite.config.ts.
const SOURCES = [
  {
    id: "pinnacle",
    name: "Pinnacle",
    type: "sharp",
    workflow: "pinnacle-fetch.yml",
    dataFile: "pinnacle-rows.json",
    statusFile: null,
    // Pinnacle primär refresh: extern cron-job.org pingar workflow_dispatch
    // var 60s. GHA-cron */5 är backup. Med Playwright browser-cache (added
    // 2026-05-15) går workflow runtime från ~120s till ~60s, vilket matchar
    // 60s extern cron-takt. Override så audit/maxAge inte räknar med backup-
    // cron 5min — den faktiska cadensen är 60s.
    effectiveIntervalSec: 60,
    staleAfterSec: 10 * 60, // 10 min — PINNACLE_FRESHNESS_THRESHOLD_MS
    backendCacheTtlSec: 5,
    note: "Reference book (no-vig). External cron ~60s + GHA backup. Gates valuebets if >10min stale.",
  },
  {
    id: "sportybet_ng",
    name: "SportyBet NG",
    type: "foreign_bookmaker",
    workflow: "sportybet-fetch.yml",
    dataFile: "sportybet-ng-rows.json",
    statusFile: null,
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 60,
    note: "Nigerian public API /api/ng/factsCenter",
  },
  {
    id: "bet7",
    name: "Bet7",
    type: "foreign_bookmaker",
    workflow: "bet7-fetch.yml",
    dataFile: "bet7-rows.json",
    statusFile: "bet7-status.json",
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 30,
    note: "iapi/sportsbook/v2 — via Mullvad VPN",
  },
  {
    id: "bet9ja",
    name: "Bet9ja",
    type: "foreign_bookmaker",
    workflow: "bet9ja-fetch.yml",
    dataFile: "bet9ja-rows.json",
    statusFile: "bet9ja-status.json",
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 30,
    note: "PalimpsestAjax catalog + highlights union",
  },
  {
    id: "comeon",
    name: "ComeOn",
    type: "foreign_bookmaker",
    workflow: "comeon-fetch.yml",
    dataFile: "comeon-rows.json",
    statusFile: null,
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 60,
    note: "Shared with Hajper/Snabbare (same backend franchise)",
  },
  {
    id: "betsson",
    name: "Betsson",
    type: "foreign_bookmaker",
    workflow: "betsson-fetch.yml",
    dataFile: "betsson-rows.json",
    statusFile: null,
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 60,
    note: "Shared with Bethard/Spelklubben",
  },
  {
    id: "vbet",
    name: "VBET",
    type: "foreign_bookmaker",
    workflow: "vbet-fetch.yml",
    dataFile: "vbet-rows.json",
    statusFile: null,
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 60,
    note: "Svensk bookmaker — public AddLine API",
  },
  {
    id: "altenar",
    name: "Altenar group",
    type: "foreign_bookmaker_group",
    workflow: "altenar-fetch.yml",
    dataFile: "altenar-rows.json",
    statusFile: null,
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 60,
    note: "DBET / MrVegas / MegaRiches share byIntegration cache",
  },
  {
    id: "unibet",
    name: "Unibet (Kambi)",
    type: "foreign_bookmaker",
    workflow: "kambi-fetch.yml",
    dataFile: "kambi-rows.json",
    statusFile: null,
    staleAfterSec: 30 * 60,
    backendCacheTtlSec: 60,
    note: "Kambi listView fan-out (ubse offering, embedded betOffers)",
  },
  {
    id: "paf-brand",
    name: "Paf-brand group",
    type: "foreign_bookmaker_group",
    workflow: "paf-brand-fetch.yml",
    dataFile: "paf-brand-rows.json",
    statusFile: null,
    staleAfterSec: 60 * 60,
    backendCacheTtlSec: 60,
    note: "X3000 / Golden Bull / 1x2 / Speedybet — search-based prewarm cache",
  },
];

// On-demand scrape-only — listas separat (ingen disk-cache att audita).
// Efter Fas 2: Hajper/Snabbare/Bethard/Spelklubben är shared via comeon/betsson cache.
// Efter Fas 3: DBET/MrVegas/MegaRiches är group via altenar-rows.json.
// Efter Fas 4: Unibet är cached via kambi-rows.json.
// Efter Fas 5: X3000/Golden Bull/1x2/Speedybet är prewarm via paf-brand-rows.json.
// → Alla bookmakers är nu antingen cached/shared/group eller har dokumenterad fallback.
const ON_DEMAND = [];

// Parse cron-uttryck från en YAML-fil. Returnerar { cron, intervalSec } eller null.
// Stödjer "every-N-minute" och "N * * * *"-mönster (täcker våra workflows).
function readWorkflow(filename) {
  const p = path.join(WF_DIR, filename);
  if (!fs.existsSync(p)) return { exists: false };
  const txt = fs.readFileSync(p, "utf8");
  const cronMatch = txt.match(/cron:\s*["']([^"']+)["']/);
  if (!cronMatch) return { exists: true, cron: null, intervalSec: null };
  const cron = cronMatch[1];
  const parts = cron.split(/\s+/);
  const minutePart = parts[0];
  let intervalSec = null;
  const everyMatch = minutePart.match(/^\*\/(\d+)$/);
  if (everyMatch) intervalSec = Number(everyMatch[1]) * 60;
  const manualDispatch = /workflow_dispatch:/.test(txt);
  const concurrency = (txt.match(/cancel-in-progress:\s*(true|false)/) ?? [])[1] ?? null;
  return {
    exists: true,
    cron,
    intervalSec,
    manualDispatch,
    cancelInProgress: concurrency,
  };
}

function readData(filename) {
  if (!filename) return null;
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) return { exists: false };
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    // Hitta updatedAt + row-count (shape-aware: ComeOn lagrar i byFranchise,
    // Betsson/VBET i events[], Bet7/Bet9ja/SportyBet/Pinnacle i rows[],
    // Football.com i signals[]). Saknad data → rowCount=0.
    const updatedAt = j.updatedAt ?? j.generatedAt ?? null;
    let rowCount = 0;
    let dataShape = "unknown";
    if (Array.isArray(j.rows)) {
      rowCount = j.rows.length;
      dataShape = "rows";
    } else if (j.byFranchise && typeof j.byFranchise === "object") {
      // ComeOn-shape: { byFranchise: { SWEDEN_HAJPER: { events: [...] }, ... } }
      for (const fr of Object.values(j.byFranchise)) {
        if (Array.isArray(fr?.events)) rowCount += fr.events.length;
      }
      dataShape = "byFranchise";
    } else if (j.byIntegration && typeof j.byIntegration === "object") {
      // Altenar-shape: { byIntegration: { dbet: { events: [...] }, ... } }
      for (const integ of Object.values(j.byIntegration)) {
        if (Array.isArray(integ?.events)) rowCount += integ.events.length;
      }
      dataShape = "byIntegration";
    } else if (j.byBrand && typeof j.byBrand === "object") {
      // Paf-brand-shape: { byBrand: { x3000: { events: [...] }, ... } }
      for (const brand of Object.values(j.byBrand)) {
        if (Array.isArray(brand?.events)) rowCount += brand.events.length;
      }
      dataShape = "byBrand";
    } else if (j.bySport && typeof j.bySport === "object") {
      // Pinnacle-shape: { bySport: { soccer: { matchups: [...] }, ... } }. Utan
      // den här grenen räknades pinnacle alltid som rowCount=0 → falsk EMPTY-
      // flagga trots 800+ matchups (vilket gav onödig watchdog-dispatch).
      for (const sp of Object.values(j.bySport)) {
        if (Array.isArray(sp?.matchups)) rowCount += sp.matchups.length;
      }
      dataShape = "bySport";
    } else if (Array.isArray(j.events)) {
      // Betsson/VBET-shape: { events: [...] }
      rowCount = j.events.length;
      dataShape = "events";
    } else if (Array.isArray(j.signals)) {
      rowCount = j.signals.length;
      dataShape = "signals";
    } else if (Array.isArray(j.drops)) {
      rowCount = j.drops.length;
      dataShape = "drops";
    } else if (Array.isArray(j)) {
      rowCount = j.length;
      dataShape = "array";
    }
    // initial-empty marker (VBET fetch-script sätter source="initial-empty"
    // när payloaden bara är en seed-fil utan riktig fetched data).
    const isInitialEmpty = j.source === "initial-empty";
    return {
      exists: true,
      updatedAt,
      rowCount,
      dataShape,
      source: j.source ?? null,
      blocked: j.blocked ?? false,
      lastError: j.lastError ?? null,
      isInitialEmpty,
      // Partiell körning: explicit flagga (nyare scrapers) eller härledd ur
      // source-taggen (".../partial-deadline"). Fräsch men reducerad täckning.
      partial: j.partial === true || String(j.source ?? "").includes("partial"),
      queryCount: typeof j.queryCount === "number" ? j.queryCount : null,
    };
  } catch (e) {
    return { exists: true, error: e.message };
  }
}

function readStatus(filename) {
  if (!filename) return null;
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function ageSeconds(updatedAt) {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.now() - ms) / 1000);
}

function fmtAge(sec) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function fmtInterval(sec) {
  if (sec == null) return "?";
  if (sec < 3600) return `*/${sec / 60}min`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function pad(s, w, right = false) {
  const x = String(s);
  if (x.length >= w) return x.slice(0, w);
  return right ? x.padStart(w) : x.padEnd(w);
}

function statusOf(src, data, ageSec) {
  if (!data || !data.exists) return "MISSING";
  if (data.error) return "ERROR";
  if (data.blocked) return "BLOCKED";
  // initial-empty: fetch-script har aldrig kört eller workflow är pausad
  // (t.ex. VBET med Cloudflare-block). Rapportera som NOT_CONFIGURED i stället
  // för EMPTY/NO_DATE eftersom det inte är ett databortfall.
  if (data.isInitialEmpty || (data.queryCount === 0 && !ageSec)) return "NOT_CONFIGURED";
  if (!ageSec && ageSec !== 0) return "NO_DATE";
  // STALE måste komma före EMPTY: gamla data men >0 rader = stale, inte empty.
  if (ageSec > src.staleAfterSec) return data.rowCount === 0 ? "EMPTY" : "STALE";
  if (data.rowCount === 0) return "EMPTY";
  return "FRESH";
}

function ansi(code, txt) {
  if (process.stdout.isTTY === false) return txt;
  return `\x1b[${code}m${txt}\x1b[0m`;
}

const STATUS_COLORS = {
  FRESH: 32, STALE: 33, EMPTY: 33, MISSING: 31, ERROR: 31, BLOCKED: 31, NO_DATE: 31,
};

function main() {
  console.log("");
  console.log(ansi(1, "═══ SOURCE FRESHNESS AUDIT ═══"));
  console.log(`generatedAt: ${new Date().toISOString()}`);
  console.log("");

  const rows = [];
  const warnings = [];

  for (const src of SOURCES) {
    const wf = readWorkflow(src.workflow);
    const data = readData(src.dataFile);
    const status = readStatus(src.statusFile);
    const age = ageSeconds(data?.updatedAt);
    const stat = statusOf(src, data, age);

    // Effective interval: registry-override (extern cron) trumfar workflow-cron.
    // Pinnacle har t.ex. */5 GHA cron som backup men extern cron-job.org pingar
    // workflow_dispatch var ~60s — det är den faktiska refresh-cadensen.
    const effectiveInterval = src.effectiveIntervalSec ?? wf?.intervalSec ?? null;
    rows.push({
      id: src.id,
      name: src.name,
      type: src.type,
      workflow: src.workflow,
      cron: wf?.cron ?? "—",
      cronIntervalSec: wf?.intervalSec ?? null,
      effectiveIntervalSec: effectiveInterval,
      manualDispatch: wf?.manualDispatch ?? false,
      cancelInProgress: wf?.cancelInProgress ?? null,
      dataFile: src.dataFile,
      dataExists: data?.exists ?? false,
      updatedAt: data?.updatedAt ?? null,
      ageSec: age,
      rowCount: data?.rowCount ?? 0,
      staleAfterSec: src.staleAfterSec,
      backendCacheTtlSec: src.backendCacheTtlSec,
      maxPossibleAgeSec:
        (effectiveInterval ?? 0) + 120 /* workflow run */ + src.backendCacheTtlSec,
      source: data?.source ?? null,
      partial: data?.partial ?? false,
      blocked: data?.blocked ?? false,
      lastError: data?.lastError ?? null,
      statusFile: status,
      status: stat,
      note: src.note,
    });

    if (!wf.exists) warnings.push(`${src.name}: workflow file MISSING (${src.workflow})`);
    if (wf.exists && !wf.cron) warnings.push(`${src.name}: workflow has no cron`);
    if (!data?.exists) warnings.push(`${src.name}: data file MISSING (${src.dataFile})`);
    if (data?.exists && !data.updatedAt) warnings.push(`${src.name}: data file has no updatedAt`);
    if (stat === "STALE") warnings.push(`${src.name}: STALE (${fmtAge(age)} > ${fmtAge(src.staleAfterSec)})`);
    if (stat === "EMPTY") warnings.push(`${src.name}: rowCount=0`);
    if (data?.blocked) warnings.push(`${src.name}: blocked=true`);
    if (data?.partial) warnings.push(`${src.name}: partial=true (färsk men reducerad täckning)`);
  }

  // Tabell
  const colWidths = [16, 22, 17, 8, 8, 11, 7, 9];
  const headers = ["ID", "NAME", "TYPE", "CRON", "ROWS", "UPDATED", "AGE", "STATUS"];
  console.log(headers.map((h, i) => pad(h, colWidths[i])).join(" "));
  console.log("─".repeat(colWidths.reduce((a, b) => a + b + 1, -1)));
  for (const r of rows) {
    const color = STATUS_COLORS[r.status] ?? 0;
    const updatedStr = r.updatedAt ? r.updatedAt.slice(5, 16).replace("T", " ") : "—";
    console.log(
      pad(r.id, colWidths[0]) + " " +
        pad(r.name, colWidths[1]) + " " +
        pad(r.type, colWidths[2]) + " " +
        pad(r.cron, colWidths[3]) + " " +
        pad(r.rowCount, colWidths[4], true) + " " +
        pad(updatedStr, colWidths[5]) + " " +
        pad(fmtAge(r.ageSec), colWidths[6], true) + " " +
        ansi(color, pad(r.status, colWidths[7])),
    );
  }

  console.log("");
  console.log(ansi(1, "─── DETAILS PER SOURCE ───"));
  for (const r of rows) {
    console.log(`\n  ${ansi(1, r.name)} (${r.id})`);
    console.log(`    type:                ${r.type}`);
    console.log(`    workflow:            ${r.workflow}  cron=${r.cron}  manual=${r.manualDispatch}  cancelInProgress=${r.cancelInProgress}`);
    console.log(`    cron interval:       ${fmtInterval(r.cronIntervalSec)}`);
    console.log(`    effective interval:  ${fmtInterval(r.effectiveIntervalSec)}${r.effectiveIntervalSec !== r.cronIntervalSec ? ansi(33, "  (override from registry — see note)") : ""}`);
    console.log(`    data file:           ${r.dataFile}  exists=${r.dataExists}  rows=${r.rowCount}`);
    console.log(`    updatedAt:           ${r.updatedAt ?? "—"}  age=${fmtAge(r.ageSec)}`);
    console.log(`    staleAfter:          ${fmtAge(r.staleAfterSec)}`);
    console.log(`    backend cache TTL:   ${r.backendCacheTtlSec}s`);
    console.log(`    max possible age:    ${fmtAge(r.maxPossibleAgeSec)} (interval + workflow + cache TTL)`);
    console.log(`    status:              ${ansi(STATUS_COLORS[r.status] ?? 0, r.status)}`);
    if (r.lastError) console.log(`    lastError:           ${r.lastError}`);
    if (r.statusFile?.lastError) console.log(`    status.lastError:    ${r.statusFile.lastError}`);
    console.log(`    note:                ${r.note}`);
  }

  console.log("");
  console.log(ansi(1, "─── ON-DEMAND BOOKMAKERS (no workflow / no disk cache) ───"));
  console.log(`  Skrapas live per valuebet-request via /api/valuebets-pipelinen,`);
  console.log(`  med 30-60s minne-cache. Ingen disk-persisted data att audita.\n`);
  for (const od of ON_DEMAND) {
    console.log(`  ${pad(od.id, 14)} ${pad(od.name, 14)} cache=${od.cacheTtlSec}s  ${od.note}`);
  }

  console.log("");
  console.log(ansi(1, "─── WARNINGS ───"));
  if (warnings.length === 0) {
    console.log("  ✓ No warnings");
  } else {
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }

  console.log("");
  const freshCount = rows.filter((r) => r.status === "FRESH").length;
  const staleCount = rows.filter((r) => r.status === "STALE").length;
  const otherCount = rows.length - freshCount - staleCount;
  console.log(`Summary: ${freshCount} fresh, ${staleCount} stale, ${otherCount} other (${rows.length} total tracked + ${ON_DEMAND.length} on-demand)`);

  // Skriv JSON-output för CI / scripted consumption
  fs.writeFileSync(
    path.join(DATA_DIR, "_audit-sources.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), rows, onDemand: ON_DEMAND, warnings }, null, 2),
  );
  console.log(`\n  ✓ Wrote data/_audit-sources.json`);

  // Exit code 1 om något är stale/missing (men ej blocked, det är ok)
  const hasBlocker = rows.some((r) => ["STALE", "MISSING", "ERROR", "NO_DATE"].includes(r.status));
  process.exit(hasBlocker ? 1 : 0);
}

main();
