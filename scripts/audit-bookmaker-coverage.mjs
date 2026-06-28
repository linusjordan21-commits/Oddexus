#!/usr/bin/env node
/**
 * Bookmaker coverage audit.
 *
 * Läser alla data/<source>-rows.json + normaliserar shape per bookmaker så
 * vi kan jämföra row counts, leagues, time-span, missing-1X2 etc. på lika
 * villkor — oavsett om källan lagrar `rows[]`, `events[]`, `byFranchise`,
 * `byIntegration` eller `byBrand`.
 *
 * För varje bookmaker:
 *   parsedRows           events efter filtrering (= det som backend serverar)
 *   leagues              unika ligor/competitions/champs
 *   timeSpan             tidigaste → senaste startTime
 *   coverageLevel        full | partial | limited | unknown
 *   coverageReason       förklaring per källa
 *   warnings             tomma-fält / asymmetri / suspekt-låg-count
 *
 * Output: tabell + warnings. Exit code:
 *   0 = inga buggar identifierade
 *   1 = potentiella buggar (suspekt asymmetri, ej fixed)
 */
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");

function ansi(code, txt) {
  return process.stdout.isTTY === false ? txt : `\x1b[${code}m${txt}\x1b[0m`;
}

function readJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return { _parseError: e.message };
  }
}

function ageMin(updatedAt) {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 60_000) : null;
}

function uniqueLeagues(events, getLeague) {
  const s = new Set();
  for (const e of events) {
    const l = getLeague(e);
    if (l != null && l !== "") s.add(String(l));
  }
  return s.size;
}

function timeSpan(events, getStart) {
  let min = null;
  let max = null;
  for (const e of events) {
    const t = getStart(e);
    if (!t) continue;
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    if (min === null || ms < min) min = ms;
    if (max === null || ms > max) max = ms;
  }
  if (min === null || max === null) return null;
  const days = Math.round((max - min) / 86_400_000);
  return { days, earliest: new Date(min).toISOString().slice(0, 10), latest: new Date(max).toISOString().slice(0, 10) };
}

/**
 * Per-bookmaker spec — definierar hur datat ska tolkas per källa.
 * Coverage-strategy är dokumenterad här eftersom UI:t inte exponerar den.
 */
const SPECS = [
  {
    id: "pinnacle",
    name: "Pinnacle",
    file: "pinnacle-rows.json",
    coverageLevel: "full",
    coverageReason: "Sharp reference — fetches all major sports + markets via Pinnacle's API",
    extract: (d) => {
      const sportEntries = Object.entries(d?.bySport ?? {});
      const allEvents = sportEntries.flatMap(([sport, s]) =>
        (s.matchups ?? []).map((m) => ({ ...m, _sport: sport })),
      );
      const moneyline = (d?.bySport?.soccer?.markets ?? []).filter((m) => m.type === "moneyline");
      return {
        rawEvents: d?.summary?.totalMatchups ?? allEvents.length,
        parsedRows: moneyline.length,
        events: allEvents,
        getLeague: (e) => e?.league?.name ?? null,
        getStart: (e) => e?.startTime,
        extra: { soccerMoneyline: moneyline.length, totalMatchups: d?.summary?.totalMatchups, totalMarkets: d?.summary?.totalMarkets, sports: Object.keys(d?.bySport ?? {}).length },
      };
    },
  },
  {
    id: "sportybet_ng",
    name: "SportyBet NG",
    file: "sportybet-ng-rows.json",
    coverageLevel: "full",
    coverageReason: "pcUpcomingEvents bulk REST endpoint — full prematch football catalog",
    extract: (d) => ({
      rawEvents: d?.rows?.length ?? 0,
      parsedRows: d?.rows?.length ?? 0,
      events: d?.rows ?? [],
      getLeague: (e) => e?.tournament ?? e?.competitionName ?? null,
      getStart: (e) => e?.startTime ?? e?.estimateStartTime,
    }),
  },
  {
    id: "bet7",
    name: "Bet7",
    file: "bet7-rows.json",
    coverageLevel: "full",
    coverageReason: "Fan-out across all football tournaments (sports/1/tournaments)",
    extract: (d) => ({
      rawEvents: d?.eventsFromApi ?? d?.rows?.length ?? 0,
      parsedRows: d?.rows?.length ?? 0,
      events: d?.rows ?? [],
      getLeague: (e) => e?.tournamentName ?? e?.competitionName,
      getStart: (e) => e?.startTime,
      extra: { eventsFromApi: d?.eventsFromApi, kickoffBufferSkipped: d?.kickoffBufferSkipped },
    }),
  },
  {
    id: "bet9ja",
    name: "Bet9ja",
    file: "bet9ja-rows.json",
    coverageLevel: "partial",
    coverageReason: "Catalog (active leagues only) ∪ recommended highlights — Akamai-protected; broader endpoints require bot-cookies",
    extract: (d) => ({
      rawEvents: d?.eventsFromApi ?? d?.rows?.length ?? 0,
      parsedRows: d?.rows?.length ?? 0,
      events: d?.rows ?? [],
      getLeague: (e) => e?.tournamentName ?? e?.competitionName,
      getStart: (e) => e?.startTime,
      extra: {
        eventsFromApi: d?.eventsFromApi,
        eventsFromCatalog: d?.eventsFromCatalog,
        eventsFromHighlights: d?.eventsFromHighlights,
      },
    }),
  },
  {
    id: "comeon-group",
    name: "ComeOn group",
    file: "comeon-rows.json",
    coverageLevel: "partial",
    coverageReason: "RSocket per-event call after smart-search; brand-specific catalogs (Hajper > Snabbare > ComeOn)",
    extract: (d) => {
      const events = [];
      const byBrand = {};
      for (const [code, fr] of Object.entries(d?.byFranchise ?? {})) {
        byBrand[code] = fr?.events?.length ?? 0;
        for (const e of fr?.events ?? []) events.push({ ...e, _brand: code });
      }
      return {
        rawEvents: events.length,
        parsedRows: events.length,
        events,
        getLeague: (e) => e?.leagueId ?? null,
        getStart: (e) => e?.startTime ?? e?.startTs,
        extra: { byBrand },
      };
    },
  },
  {
    id: "betsson-group",
    name: "Betsson group",
    file: "betsson-rows.json",
    coverageLevel: "full",
    coverageReason: "Bulk Playtech accordion API — same backend serves Bethard/Spelklubben (identical 1X2)",
    extract: (d) => ({
      rawEvents: d?.events?.length ?? 0,
      parsedRows: d?.events?.length ?? 0,
      events: d?.events ?? [],
      getLeague: (e) => e?.competition ?? e?.tournament ?? null,
      getStart: (e) => e?.startTime,
    }),
  },
  {
    id: "vbet",
    name: "VBET",
    file: "vbet-rows.json",
    coverageLevel: "unknown",
    coverageReason: "Workflow paused — Cloudflare WAF blocks GitHub Actions IPs (conf.json + swarm-WS)",
    extract: (d) => ({
      rawEvents: 0,
      parsedRows: d?.events?.length ?? 0,
      events: d?.events ?? [],
      getLeague: () => null,
      getStart: (e) => e?.startTime,
      extra: { initialEmpty: d?.source === "initial-empty", queryCount: d?.queryCount },
    }),
  },
  {
    id: "kambi-unibet",
    name: "Unibet (Kambi)",
    file: "kambi-rows.json",
    coverageLevel: "partial",
    coverageReason: "Kambi listView fan-out across 8 regions; offering 'ubse' supports only ~2 (all/all + england/all)",
    extract: (d) => ({
      rawEvents: d?.uniqueEvents ?? d?.events?.length ?? 0,
      parsedRows: d?.events?.length ?? 0,
      events: d?.events ?? [],
      getLeague: (e) => e?.league,
      getStart: (e) => e?.startTime,
      extra: { offering: d?.offering, fetchedRegions: d?.fetchedRegions, failedRegions: d?.failedRegions, skippedNoOdds: d?.skippedNoOdds },
    }),
  },
  {
    id: "altenar-group",
    name: "Altenar group",
    file: "altenar-rows.json",
    coverageLevel: "full",
    coverageReason: "Bulk GetUpcoming widget per integration — full sportId=66 (football) prematch catalog",
    extract: (d) => {
      const events = [];
      const byIntegration = {};
      for (const [k, integ] of Object.entries(d?.byIntegration ?? {})) {
        byIntegration[k] = integ?.events?.length ?? 0;
        for (const e of integ?.events ?? []) events.push({ ...e, _integration: k });
      }
      return {
        rawEvents: events.length,
        parsedRows: events.length,
        events,
        getLeague: (e) => e?.league,
        getStart: (e) => e?.startTime,
        extra: { byIntegration },
      };
    },
  },
  {
    id: "paf-brand-group",
    name: "Paf-brand group",
    file: "paf-brand-rows.json",
    coverageLevel: "partial",
    coverageReason: "Search-based prewarm cache — coverage depends on configured queries (~47 strategic terms)",
    extract: (d) => {
      const events = [];
      const byBrand = {};
      const totals = {};
      for (const [k, br] of Object.entries(d?.byBrand ?? {})) {
        byBrand[k] = br?.events?.length ?? 0;
        totals[k] = { queriesTried: br?.queriesTried, queriesSucceeded: br?.queriesSucceeded, queriesFailed: br?.queriesFailed };
        for (const e of br?.events ?? []) events.push({ ...e, _brand: k });
      }
      return {
        rawEvents: events.length,
        parsedRows: events.length,
        events,
        getLeague: (e) => e?.league,
        getStart: (e) => e?.startTime,
        extra: { byBrand, queries: totals, queryCount: d?.queryCount },
      };
    },
  },
];

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

console.log(ansi("1", "═══ BOOKMAKER COVERAGE AUDIT ═══"));
console.log("");

const rows = [];
const warnings = [];

for (const spec of SPECS) {
  const data = readJson(spec.file);
  if (!data) {
    warnings.push(`${spec.name}: file missing (${spec.file})`);
    rows.push({ spec, missing: true });
    continue;
  }
  if (data._parseError) {
    warnings.push(`${spec.name}: parse error — ${data._parseError}`);
    continue;
  }
  const updatedAt = data.updatedAt ?? null;
  const age = ageMin(updatedAt);
  const ex = spec.extract(data);
  const span = timeSpan(ex.events, ex.getStart);
  const leagues = uniqueLeagues(ex.events, ex.getLeague);

  // Bug-detection
  if (spec.id === "comeon-group" && ex.extra?.byBrand) {
    const vals = Object.entries(ex.extra.byBrand);
    const hajper = ex.extra.byBrand.SWEDEN_HAJPER ?? 0;
    const snabbare = ex.extra.byBrand.SWEDEN_SNABBARE ?? 0;
    const comeon = ex.extra.byBrand.SWEDEN_COMEON ?? 0;
    if (comeon === 0 && hajper > 0) warnings.push(`ComeOn: SWEDEN_COMEON franchise returnerar 0 events (Hajper=${hajper}, Snabbare=${snabbare}) — möjlig brand-katalog-limitation`);
    if (Math.abs(hajper - snabbare) > hajper * 0.5) warnings.push(`ComeOn: Hajper (${hajper}) vs Snabbare (${snabbare}) skiljer >50% — kolla brand-katalog`);
  }
  if (spec.id === "altenar-group") {
    const counts = Object.values(ex.extra?.byIntegration ?? {});
    if (counts.length > 1 && new Set(counts).size > 1) warnings.push(`Altenar: integrationer har olika counts ${JSON.stringify(ex.extra.byIntegration)} — borde vara identiska (samma backend)`);
  }
  if (spec.id === "paf-brand-group") {
    const counts = Object.values(ex.extra?.byBrand ?? {});
    if (counts.length > 1) {
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      if ((max - min) / max > 0.1) warnings.push(`Paf-brand: variation ${min}-${max} (>10%) — kolla per-brand response`);
    }
  }
  if (spec.id === "bet9ja" && ex.parsedRows < 50) {
    warnings.push(`Bet9ja: bara ${ex.parsedRows} rows — endpoint är catalog ∪ highlights, broader feed kräver Akamai bot-cookies`);
  }
  if (spec.id === "kambi-unibet" && ex.extra?.fetchedRegions != null && ex.extra.fetchedRegions < 4) {
    warnings.push(`Kambi/Unibet: ${ex.extra.fetchedRegions}/8 regioner gav data (offering=ubse). Sannolikt all/all + england/all räcker för coverage.`);
  }
  if (ex.parsedRows === 0 && spec.coverageLevel !== "unknown") {
    warnings.push(`${spec.name}: 0 rows — verifiera workflow/parser`);
  }

  rows.push({
    spec,
    updatedAt,
    age,
    rawEvents: ex.rawEvents,
    parsedRows: ex.parsedRows,
    leagues,
    span,
    extra: ex.extra,
  });
}

// ----------------------------------------------------------------------
// Table
// ----------------------------------------------------------------------

const W = { source: 18, rows: 7, raw: 7, lg: 5, span: 10, cov: 9, age: 6 };
console.log(
  ansi("1", "Source".padEnd(W.source)) +
    " " + ansi("1", "Rows".padStart(W.rows)) +
    " " + ansi("1", "Raw".padStart(W.raw)) +
    " " + ansi("1", "Lg".padStart(W.lg)) +
    " " + ansi("1", "Span".padEnd(W.span)) +
    " " + ansi("1", "Coverage".padEnd(W.cov)) +
    " " + ansi("1", "Age".padStart(W.age)),
);
console.log("-".repeat(80));

for (const r of rows) {
  if (r.missing) {
    console.log(r.spec.name.padEnd(W.source) + " " + ansi("31", "MISSING".padStart(W.rows)));
    continue;
  }
  const covColor = r.spec.coverageLevel === "full" ? "32" : r.spec.coverageLevel === "partial" ? "33" : "31";
  console.log(
    r.spec.name.padEnd(W.source) +
      " " + String(r.parsedRows).padStart(W.rows) +
      " " + String(r.rawEvents).padStart(W.raw) +
      " " + String(r.leagues).padStart(W.lg) +
      " " + (r.span ? `${r.span.days}d`.padEnd(W.span) : "—".padEnd(W.span)) +
      " " + ansi(covColor, r.spec.coverageLevel.padEnd(W.cov)) +
      " " + (r.age != null ? `${r.age}m`.padStart(W.age) : "—".padStart(W.age)),
  );
}

console.log("");
console.log(ansi("1", "─── PER-GROUP BREAKDOWN ───"));
for (const r of rows) {
  if (r.missing || !r.extra) continue;
  if (r.extra.byBrand || r.extra.byIntegration) {
    console.log(`  ${ansi("1", r.spec.name)}: ${JSON.stringify(r.extra.byBrand ?? r.extra.byIntegration)}`);
  }
  if (r.extra.eventsFromCatalog != null || r.extra.eventsFromHighlights != null) {
    console.log(`  ${ansi("1", r.spec.name)}: catalog=${r.extra.eventsFromCatalog} + highlights=${r.extra.eventsFromHighlights} → ${r.parsedRows} after dedupe`);
  }
  if (r.extra.fetchedRegions != null) {
    console.log(`  ${ansi("1", r.spec.name)}: fetched ${r.extra.fetchedRegions}/8 regions, failed=${r.extra.failedRegions ?? 0}, skippedNoOdds=${r.extra.skippedNoOdds ?? 0}`);
  }
  if (r.extra.queries) {
    console.log(`  ${ansi("1", r.spec.name)}: queryCount=${r.extra.queryCount}; per-brand:`);
    for (const [k, q] of Object.entries(r.extra.queries)) {
      console.log(`    ${k.padEnd(12)} succeeded=${q.queriesSucceeded}/${q.queriesTried} failed=${q.queriesFailed}`);
    }
  }
}

console.log("");
console.log(ansi("1", "─── COVERAGE LEGEND ───"));
console.log(`  ${ansi("32", "full")}     — endpoint returnerar (eller borde returnera) hela prematch-katalogen`);
console.log(`  ${ansi("33", "partial")}  — endpoint är begränsad (search-based / region-fan-out / highlights+catalog)`);
console.log(`  ${ansi("33", "limited")}  — endpoint returnerar bara en delmängd (t.ex. promoted/recommended only)`);
console.log(`  ${ansi("31", "unknown")}  — workflow ej körd, blocked, eller initial-empty`);

console.log("");
if (warnings.length > 0) {
  console.log(ansi("1", `─── WARNINGS (${warnings.length}) ───`));
  for (const w of warnings) console.log("  " + ansi("33", "⚠"), w);
} else {
  console.log(ansi("32", "─── No warnings ───"));
}

console.log("");
console.log(ansi("1", "─── COVERAGE BY GROUP ───"));
const groupNotes = SPECS.map((s) => ({ id: s.id, name: s.name, level: s.coverageLevel, reason: s.coverageReason }));
for (const g of groupNotes) {
  const color = g.level === "full" ? "32" : g.level === "partial" ? "33" : "31";
  console.log(`  ${ansi(color, g.level.padEnd(8))} ${g.name.padEnd(18)} — ${g.reason}`);
}

process.exit(warnings.some((w) => /BUG|verifiera/i.test(w)) ? 1 : 0);
