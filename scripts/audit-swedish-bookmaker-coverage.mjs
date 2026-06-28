#!/usr/bin/env node
/**
 * Swedish bookmaker coverage audit.
 *
 * Fokuserad audit som mäter VARJE svensk bookmakers täckning mot Pinnacle:
 *   matchCoveragePct = matchedPinnacleEvents / totalPinnacleFootballEvents
 *
 * Detta är viktigare än bara rows — en sajt med 100 rows som matchar
 * 80 Pinnacle-events är värd mer än 500 rows där bara 20 matchar.
 *
 * Identifierar:
 *   - Top missing leagues per source (för Paf-brand query-förbättring)
 *   - Shared odds-groups (Betsson/Bethard/Spelklubben har identical 1X2)
 *   - Priority-klass per source (egen marginal vs shared)
 *
 * Output: tabell + per-grupp breakdown + missing-leagues-rapport.
 *
 * Title-matching: enkel token-Jaccard på normaliserade lag-namn. Inte lika
 * sofistikerad som vite.config.ts isLikelySameMatch (som har stopwords +
 * city-normalize), men tillräcklig för coverage-uppskattning på ±5%.
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
  } catch {
    return null;
  }
}

function ageMin(updatedAt) {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 60_000) : null;
}

// ----------------------------------------------------------------------
// Title matching (simplified — enough for coverage estimation)
// ----------------------------------------------------------------------

const STOPWORDS = new Set([
  "fc", "fk", "if", "ik", "bk", "ac", "afc", "cd", "sc", "rcd", "club", "team",
  "the", "of", "och", "och", "sk", "fsv", "vfl", "fsv", "vfb", "tsg", "1fc",
  "ca", "cf", "atletico", "real",
]);

function normalizeTeam(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(name) {
  return normalizeTeam(name)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function tokenSimilarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect += 1;
  return intersect / Math.min(ta.size, tb.size);
}

/** Är titlar likely samma match? Token-overlap ≥ 0.5 på BÅDA lagen. */
function isLikelySameMatch(homeA, awayA, homeB, awayB) {
  if (!homeA || !awayA || !homeB || !awayB) return false;
  return tokenSimilarity(homeA, homeB) >= 0.5 && tokenSimilarity(awayA, awayB) >= 0.5;
}

// ----------------------------------------------------------------------
// Pinnacle reference
// ----------------------------------------------------------------------

function extractPinnacleFootball() {
  const d = readJson("pinnacle-rows.json");
  if (!d) return { events: [], leagues: new Set() };
  const soccer = d.bySport?.soccer;
  if (!soccer) return { events: [], leagues: new Set() };
  const matchupsById = new Map();
  for (const m of soccer.matchups ?? []) {
    if (!m?.id) continue;
    const home = m.participants?.find((p) => p.alignment === "home")?.name;
    const away = m.participants?.find((p) => p.alignment === "away")?.name;
    if (!home || !away) continue;
    matchupsById.set(m.id, { id: m.id, home, away, startTime: m.startTime, league: m.league?.name ?? "" });
  }
  // Only count matches with moneyline market
  const events = [];
  const seen = new Set();
  for (const mk of soccer.markets ?? []) {
    if (mk.type !== "moneyline" || mk.period !== 0) continue;
    const evt = matchupsById.get(mk.matchupId);
    if (!evt || seen.has(evt.id)) continue;
    seen.add(evt.id);
    events.push(evt);
  }
  const leagues = new Set(events.map((e) => e.league));
  return { events, leagues, updatedAt: d.updatedAt };
}

// ----------------------------------------------------------------------
// Per-bookmaker extractor
// ----------------------------------------------------------------------

const SWEDISH_BOOKMAKERS = [
  {
    id: "comeon", name: "ComeOn", group: "comeon",
    file: "comeon-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByFranchise(d, "SWEDEN_COMEON"),
  },
  {
    id: "hajper", name: "Hajper", group: "comeon",
    file: "comeon-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByFranchise(d, "SWEDEN_HAJPER"),
  },
  {
    id: "snabbare", name: "Snabbare", group: "comeon",
    file: "comeon-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByFranchise(d, "SWEDEN_SNABBARE"),
  },
  {
    id: "betsson", name: "Betsson", group: "betsson",
    file: "betsson-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: ["bethard", "spelklubben"],
    extract: (d) => extractBetssonEvents(d),
  },
  {
    id: "bethard", name: "Bethard", group: "betsson",
    file: "betsson-rows.json",
    priority: "medium", uniqueOdds: false,
    sharedOddsWith: ["betsson", "spelklubben"],
    extract: (d) => extractBetssonEvents(d),
  },
  {
    id: "spelklubben", name: "Spelklubben", group: "betsson",
    file: "betsson-rows.json",
    priority: "medium", uniqueOdds: false,
    sharedOddsWith: ["betsson", "bethard"],
    extract: (d) => extractBetssonEvents(d),
  },
  {
    id: "unibet", name: "Unibet", group: "kambi",
    file: "kambi-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractKambiEvents(d),
  },
  {
    id: "dbet", name: "DBET", group: "altenar",
    file: "altenar-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByIntegration(d, "dbet"),
  },
  {
    id: "mrvegas", name: "MrVegas", group: "altenar",
    file: "altenar-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByIntegration(d, "mrvegasse"),
  },
  {
    id: "megariches", name: "MegaRiches", group: "altenar",
    file: "altenar-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByIntegration(d, "megarichesse"),
  },
  {
    id: "x3000", name: "X3000", group: "paf-brand",
    file: "paf-brand-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByBrand(d, "x3000"),
  },
  {
    id: "goldenbull", name: "Golden Bull", group: "paf-brand",
    file: "paf-brand-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByBrand(d, "goldenbull"),
  },
  {
    id: "1x2", name: "1x2", group: "paf-brand",
    file: "paf-brand-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByBrand(d, "oneTwo"),
  },
  {
    id: "speedybet", name: "Speedybet", group: "paf-brand",
    file: "paf-brand-rows.json",
    priority: "high", uniqueOdds: true,
    sharedOddsWith: [],
    extract: (d) => extractByBrand(d, "speedybet"),
  },
  {
    id: "vbet", name: "VBET", group: "vbet",
    file: "vbet-rows.json",
    priority: "low", uniqueOdds: false,
    sharedOddsWith: [],
    note: "workflow paused (Cloudflare-block)",
    extract: (d) => (Array.isArray(d?.events) ? d.events : []),
  },
];

function extractByFranchise(d, code) {
  const evts = d?.byFranchise?.[code]?.events ?? [];
  return evts.map((e) => ({
    home: e.homeTeam,
    away: e.awayTeam,
    startTime: e.startTime ?? null,
    league: e.leagueId ?? null,
  }));
}

function extractBetssonEvents(d) {
  return (d?.events ?? []).map((e) => ({
    home: e.homeTeam ?? e.title?.split(" - ")[0],
    away: e.awayTeam ?? e.title?.split(" - ")[1],
    startTime: e.startTime ?? null,
    league: e.competition ?? null,
  }));
}

function extractKambiEvents(d) {
  return (d?.events ?? []).map((e) => ({
    home: e.homeTeam,
    away: e.awayTeam,
    startTime: e.startTime ?? null,
    league: e.league ?? null,
  }));
}

function extractByIntegration(d, key) {
  const evts = d?.byIntegration?.[key]?.events ?? [];
  return evts.map((e) => ({ home: e.homeTeam, away: e.awayTeam, startTime: e.startTime, league: e.league }));
}

function extractByBrand(d, key) {
  const evts = d?.byBrand?.[key]?.events ?? [];
  return evts.map((e) => ({ home: e.homeTeam, away: e.awayTeam, startTime: e.startTime, league: e.league }));
}

// ----------------------------------------------------------------------
// Coverage calculation
// ----------------------------------------------------------------------

function computeCoverage(bookmakerEvents, pinnacleEvents) {
  const matchedPinnacleIds = new Set();
  const missingPinnacleEvents = [];
  for (const pe of pinnacleEvents) {
    let matched = false;
    for (const be of bookmakerEvents) {
      if (isLikelySameMatch(pe.home, pe.away, be.home, be.away)) {
        matched = true;
        break;
      }
    }
    if (matched) matchedPinnacleIds.add(pe.id);
    else missingPinnacleEvents.push(pe);
  }
  return {
    matchedCount: matchedPinnacleIds.size,
    missingPinnacleEvents,
  };
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

console.log(ansi("1", "═══ SWEDISH BOOKMAKER COVERAGE AUDIT ═══"));
console.log("");

const pin = extractPinnacleFootball();
console.log(`Pinnacle reference: ${pin.events.length} football matches with moneyline (${pin.leagues.size} leagues)`);
console.log(`Pinnacle updatedAt: ${pin.updatedAt ?? "—"} (${ageMin(pin.updatedAt) ?? "—"}min ago)`);
console.log("");

// Compute per-bookmaker
const results = [];
for (const bm of SWEDISH_BOOKMAKERS) {
  const data = readJson(bm.file);
  if (!data) {
    results.push({ ...bm, rows: 0, matched: 0, missing: [], age: null, missingFile: true });
    continue;
  }
  const events = bm.extract(data) ?? [];
  const cov = computeCoverage(events, pin.events);
  results.push({
    ...bm,
    rows: events.length,
    matched: cov.matchedCount,
    missing: cov.missingPinnacleEvents,
    age: ageMin(data.updatedAt),
  });
}

// ----------------------------------------------------------------------
// Table
// ----------------------------------------------------------------------

const W = { name: 13, group: 11, rows: 6, matched: 9, pct: 7, prio: 7, shared: 18 };
console.log(
  ansi("1", "Bookmaker".padEnd(W.name)) +
    " " + ansi("1", "Group".padEnd(W.group)) +
    " " + ansi("1", "Rows".padStart(W.rows)) +
    " " + ansi("1", "Matched".padStart(W.matched)) +
    " " + ansi("1", "Pct".padStart(W.pct)) +
    " " + ansi("1", "Prio".padEnd(W.prio)) +
    " " + ansi("1", "Shared with"),
);
console.log("-".repeat(95));

const sorted = [...results].sort((a, b) => b.matched - a.matched);
for (const r of sorted) {
  const pct = pin.events.length > 0 ? Math.round((r.matched / pin.events.length) * 100) : 0;
  const pctStr = pct + "%";
  const pctColor = pct >= 40 ? "32" : pct >= 20 ? "33" : pct === 0 ? "31" : "33";
  const prioColor = r.priority === "high" ? "32" : r.priority === "medium" ? "33" : "31";
  const shared = (r.sharedOddsWith ?? []).length > 0 ? r.sharedOddsWith.join(", ") : "—";
  console.log(
    r.name.padEnd(W.name) +
      " " + r.group.padEnd(W.group) +
      " " + String(r.rows).padStart(W.rows) +
      " " + String(r.matched).padStart(W.matched) +
      " " + ansi(pctColor, pctStr.padStart(W.pct)) +
      " " + ansi(prioColor, r.priority.padEnd(W.prio)) +
      " " + shared.substring(0, W.shared),
  );
}

// ----------------------------------------------------------------------
// Per-group analysis
// ----------------------------------------------------------------------

console.log("");
console.log(ansi("1", "─── PER-GROUP ANALYSIS ───"));
const groupBy = (key) => {
  const map = new Map();
  for (const r of results) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
};
const byGroup = groupBy("group");
for (const [group, rs] of byGroup.entries()) {
  const totalRows = rs.reduce((s, r) => s + r.rows, 0);
  const max = Math.max(...rs.map((r) => r.matched));
  const min = Math.min(...rs.map((r) => r.matched));
  const symmetric = max === min || (max > 0 && (max - min) / max < 0.05);
  console.log(`  ${ansi("1", group.padEnd(12))} ${rs.length} sites, ${totalRows} total rows, matched range ${min}-${max} ${symmetric ? ansi("32", "(symmetric)") : ansi("33", "(asymmetric)")}`);
}

// ----------------------------------------------------------------------
// Top missing leagues per partial-coverage source
// ----------------------------------------------------------------------

console.log("");
console.log(ansi("1", "─── TOP MISSING LEAGUES (för partial-coverage sources) ───"));
const partialResults = results.filter((r) => {
  const pct = pin.events.length > 0 ? r.matched / pin.events.length : 0;
  return pct < 0.5 && r.rows > 0;
});
for (const r of partialResults) {
  const leagueCounts = new Map();
  for (const e of r.missing) {
    const k = e.league || "(unknown)";
    leagueCounts.set(k, (leagueCounts.get(k) ?? 0) + 1);
  }
  const top = [...leagueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`  ${ansi("1", r.name)}: top missing leagues:`);
  for (const [league, count] of top) {
    console.log(`    ${String(count).padStart(3)}  ${league}`);
  }
}

// ----------------------------------------------------------------------
// Recommendation: top teams missing across all Swedish sources
// ----------------------------------------------------------------------

console.log("");
console.log(ansi("1", "─── PROPOSED QUERY ADDITIONS (för Paf-brand prewarm) ───"));
const swedish = results.filter((r) => r.group !== "vbet" && r.rows > 0);
// Aggregate: hur ofta missar Pinnacle-events över alla svenska källor?
const missMap = new Map(); // homeTeam → miss count
const pinEventsById = new Map(pin.events.map((e) => [e.id, e]));
const missCountById = new Map();
for (const r of swedish) {
  for (const m of r.missing) {
    missCountById.set(m.id, (missCountById.get(m.id) ?? 0) + 1);
  }
}
// Sortera Pinnacle-events efter hur många svenska källor som missar dem
const universalMisses = [...missCountById.entries()]
  .filter(([_, c]) => c === swedish.length) // missas av ALLA svenska källor
  .map(([id]) => pinEventsById.get(id))
  .filter(Boolean);

if (universalMisses.length === 0) {
  console.log(ansi("32", "  ✓ Inga Pinnacle-matcher missas av ALLA svenska källor — coverage är distribuerad."));
} else {
  console.log(`  ${universalMisses.length} Pinnacle-matcher missas av ALLA ${swedish.length} svenska källor.`);
  console.log(`  Topp 10 (ligor representerade flest gånger):`);
  const leagueAgg = new Map();
  for (const e of universalMisses) {
    const k = e.league || "(unknown)";
    leagueAgg.set(k, (leagueAgg.get(k) ?? 0) + 1);
  }
  const topLeagues = [...leagueAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [league, count] of topLeagues) {
    console.log(`    ${String(count).padStart(3)}  ${league}`);
  }
}

// ----------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------

console.log("");
console.log(ansi("1", "─── PRIORITY SUMMARY ───"));
const high = results.filter((r) => r.priority === "high");
const medium = results.filter((r) => r.priority === "medium");
const low = results.filter((r) => r.priority === "low");
console.log(`  ${ansi("32", "high")}   (unik marginal, värt scrape):    ${high.length} källor — ${high.map((r) => r.name).join(", ")}`);
console.log(`  ${ansi("33", "medium")} (delar odds-feed):               ${medium.length} källor — ${medium.map((r) => r.name).join(", ")}`);
console.log(`  ${ansi("31", "low")}    (paused/unavailable):            ${low.length} källor — ${low.map((r) => r.name).join(", ")}`);

console.log("");
const avg = swedish.length > 0
  ? Math.round((swedish.reduce((s, r) => s + r.matched, 0) / swedish.length / pin.events.length) * 100)
  : 0;
console.log(`Average Swedish-source coverage of Pinnacle football matches: ${ansi(avg >= 30 ? "32" : "33", avg + "%")}`);
console.log(`(${swedish.length} Swedish sources × ${pin.events.length} Pinnacle football matches with moneyline)`);
