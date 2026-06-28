#!/usr/bin/env node
/**
 * Fas A test-script för cross-book odds-adapter.
 *
 * Kör (Node 22+ med --experimental-strip-types):
 *   node --experimental-strip-types scripts/test-odds-adapter.mjs
 *
 * Eller utan flagga om Node 24+ (där strip-types är default-stöttat):
 *   node scripts/test-odds-adapter.mjs
 *
 * Vad det gör:
 *   1. Skapar PinnacleAdapter (läser data/pinnacle-rows.json från disk)
 *   2. Skapar Bet365Adapter i mock-läge (läser fixtures/bet365-mock.json)
 *   3. Hämtar normaliserade odds från båda
 *   4. Matchar (event, market, line, selection) över adapters
 *   5. Räknar edge mot Pinnacles no-vig fair prob
 *   6. Skriver ut sammanfattning + topp 10 + value-flaggade
 *
 * Inga ändringar i befintliga pipelines/data/scripts. Bara läsning.
 *
 * Notering om TS-import: scriptet importerar .ts-filer direkt. Node ≥ 22
 * stripper TypeScript-syntax inbyggt via --experimental-strip-types
 * (default i Node 24). Inga build-steg eller extra dependencies krävs.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const projectRoot = process.cwd();
const PIN_FILE = resolve(projectRoot, "data", "pinnacle-rows.json");
const MOCK_FILE = resolve(projectRoot, "src", "lib", "odds", "fixtures", "bet365-mock.json");

if (!existsSync(PIN_FILE)) {
  console.error(`[test] Pinnacle-data saknas: ${PIN_FILE}`);
  process.exit(1);
}
if (!existsSync(MOCK_FILE)) {
  console.error(`[test] Mock-data saknas: ${MOCK_FILE}`);
  process.exit(1);
}

// ── Import av TS-moduler via inbyggd Node strip-types ────────────────────

async function importTs(relativePath) {
  const url = pathToFileURL(resolve(projectRoot, relativePath)).href;
  return await import(url);
}

const typesMod = await importTs("src/lib/odds/types.ts");
const pinnacleMod = await importTs("src/lib/odds/adapters/pinnacleAdapter.ts");
const bet365Mod = await importTs("src/lib/odds/adapters/bet365Adapter.ts");
const matchingMod = await importTs("src/lib/odds/matching.ts");
const edgeMod = await importTs("src/lib/odds/edge.ts");

// ── Setup adapters ──────────────────────────────────────────────────────

const pinnacleAdapter = pinnacleMod.createPinnacleAdapter(async () => {
  return JSON.parse(readFileSync(PIN_FILE, "utf-8"));
});

const bet365Adapter = bet365Mod.createBet365Adapter({
  loadMock: async () => JSON.parse(readFileSync(MOCK_FILE, "utf-8")),
});

// ── Kör adapters + matching + edge ──────────────────────────────────────

console.log("=========================================");
console.log("  Fas A: Cross-book odds-adapter test");
console.log("=========================================\n");

const pinOdds = await pinnacleAdapter.fetchOdds();
const pinMeta = await pinnacleAdapter.getSnapshotMeta();
console.log(`Pinnacle (${pinMeta.source}): ${pinOdds.length} normaliserade odds`);
console.log(`  updatedAt: ${pinMeta.updatedAt ?? "?"}`);

const bet365Odds = await bet365Adapter.fetchOdds();
const bet365Meta = await bet365Adapter.getSnapshotMeta();
console.log(`Bet365   (${bet365Meta.source}): ${bet365Odds.length} normaliserade odds`);
console.log(`  updatedAt: ${bet365Meta.updatedAt ?? "?"}`);

const byMarket = bet365Odds.reduce((acc, o) => {
  acc[o.market] = (acc[o.market] ?? 0) + 1;
  return acc;
}, {});
console.log(`  market-fördelning:`, byMarket);

// ── Matching ────────────────────────────────────────────────────────────

const matched = matchingMod.matchEvents(pinOdds, bet365Odds);
console.log(`\nMatching: ${matched.length} matchade odds (Pinnacle ↔ Bet365)`);

if (matched.length === 0) {
  console.log("\n⚠️  Inga real-data-matchningar — Bet365 mock-events överlappar inte");
  console.log("    Pinnacles aktuella fönster. Det är förväntat med statisk mock.");
  console.log("    Synthetic sanity check nedan visar att pipelinen ändå fungerar.\n");
}

// ── Edge (på real-data) ─────────────────────────────────────────────────

const sorted = edgeMod.sortByEdgeDesc(matched);
const valueBets = sorted.filter((m) => m.isValue);

console.log(`Value-flaggade (> ${typesMod.VALUE_EDGE_THRESHOLD_PCT}% edge): ${valueBets.length}`);

if (matched.length > 0) {
console.log(`\nTopp 10 edge opportunities:`);
console.log("─".repeat(120));
console.log(
  ["Edge%", "isValue", "Match", "Market/Line/Sel", "Bet365 odds", "Pinn odds", "Pinn fair p."]
    .map((s, i) => s.padEnd(i === 2 ? 38 : i === 3 ? 22 : 12))
    .join("│ "),
);
console.log("─".repeat(120));

for (const m of sorted.slice(0, 10)) {
  const ref = m.reference;
  const cand = m.candidate;
  const matchStr = `${ref.homeTeam} - ${ref.awayTeam}`.slice(0, 36);
  const lineStr = ref.line != null ? ` ${ref.line}` : "";
  const marketStr = `${ref.market}${lineStr} ${ref.selection}`.slice(0, 20);
  const edgeStr = `${m.edgePct > 0 ? "+" : ""}${m.edgePct.toFixed(2)}%`;
  const fairProbStr = `${(m.referenceFairProb * 100).toFixed(1)}%`;
  console.log(
    [
      edgeStr.padEnd(12),
      (m.isValue ? "✓ VALUE" : "").padEnd(12),
      matchStr.padEnd(38),
      marketStr.padEnd(22),
      cand.odds.toFixed(2).padEnd(12),
      ref.odds.toFixed(2).padEnd(12),
      fairProbStr.padEnd(12),
    ].join("│ "),
  );
}

  if (valueBets.length > 0) {
    console.log(`\n${"─".repeat(120)}`);
    console.log("Value-flaggade detaljer:");
    console.log("─".repeat(120));
    for (const m of valueBets.slice(0, 20)) {
      console.log(
        `  • ${m.reference.homeTeam} vs ${m.reference.awayTeam} | ${m.reference.market}${m.reference.line != null ? ` ${m.reference.line}` : ""} ${m.reference.selection}`,
      );
      console.log(
        `    Bet365 ${m.candidate.odds.toFixed(2)}  vs  Pinnacle ${m.reference.odds.toFixed(2)} (fair ${(m.referenceFairProb * 100).toFixed(1)}%) → edge ${m.edgePct.toFixed(2)}%`,
      );
    }
  }
} // end if (matched.length > 0)

// ── Synthetic sanity check ──────────────────────────────────────────────
//
// För att bevisa att pipelinen (adapter → normalize → match → edge) är
// korrekt även när mock-events INTE överlappar med Pinnacles fönster,
// genererar vi ett "synthetic Bet365" från Pinnacle-data direkt: vi
// plockar slumpmässiga moneyline-matchups, kopierar dem, och perturberar
// odds ±3% för att simulera en konkurrerande book.
//
// Med synthetic-data ska matchEvents() träffa 100% (samma team, samma
// startTime, samma market) och edge ska variera kring 0 ±3%.

console.log(`\n${"=".repeat(120)}`);
console.log("Synthetic sanity check (Bet365 genererat från Pinnacle-moneyline)");
console.log("=".repeat(120));

const pinMoneylines = pinOdds.filter((o) => o.market === "1X2");
const matchupGroups = new Map();
for (const o of pinMoneylines) {
  const k = `${o.homeTeam}::${o.awayTeam}::${o.startTime}`;
  if (!matchupGroups.has(k)) matchupGroups.set(k, []);
  matchupGroups.get(k).push(o);
}
const completeMatchups = [...matchupGroups.values()].filter((arr) => arr.length === 3);
console.log(`Plockar 10 av ${completeMatchups.length} kompletta moneyline-matcher`);

// Perturbera odds: candidate = pinnacle * (1 + rand[-0.03, 0.03])
// Detta producerar edge i intervallet roughly ±3% mot Pinnacle no-vig fair.
const synthBet365 = [];
const sample = completeMatchups.slice(0, 10);
const synthTs = new Date().toISOString();
for (const matchup of sample) {
  for (const o of matchup) {
    const perturbation = (Math.random() - 0.5) * 0.06; // ±3%
    const newOdds = Math.max(1.01, o.odds * (1 + perturbation));
    synthBet365.push({
      ...o,
      bookmaker: "bet365",
      odds: Number(newOdds.toFixed(3)),
      timestamp: synthTs,
    });
  }
}
console.log(`Synthetic Bet365: ${synthBet365.length} odds (10 matcher × 3 selections)`);

const synthMatched = matchingMod.matchEvents(pinOdds, synthBet365);
console.log(`Synthetic matching: ${synthMatched.length} matchade (förväntat ${synthBet365.length})`);

const synthSorted = edgeMod.sortByEdgeDesc(synthMatched);
const synthValueBets = synthSorted.filter((m) => m.isValue);
console.log(`Synthetic value-flaggade (> ${typesMod.VALUE_EDGE_THRESHOLD_PCT}% edge): ${synthValueBets.length}`);

console.log(`\nTopp 5 synthetic edges (neutral perturbation ±3 %):`);
for (const m of synthSorted.slice(0, 5)) {
  console.log(
    `  ${m.isValue ? "✓ VALUE" : "      "}  ` +
    `${m.reference.homeTeam} - ${m.reference.awayTeam}  ` +
    `${m.reference.market} ${m.reference.selection}  ` +
    `bet365=${m.candidate.odds.toFixed(2)} pin=${m.reference.odds.toFixed(2)} ` +
    `fair=${(m.referenceFairProb * 100).toFixed(1)}% → edge ${m.edgePct > 0 ? "+" : ""}${m.edgePct.toFixed(2)}%`,
  );
}
console.log(
  "\n  (Förväntade negativa edges: när candidate ≈ pinnacle och Pinnacle har vig,",
);
console.log(
  "  hamnar edge mot fair-line nära −vig/n. Det är matematiskt korrekt.)",
);

// ── Boost-scenario: verifiera att isValue slår till ─────────────────────
// Vi tar 5 random Pinnacle-matchups och boostar bet365-odds med +7 %
// (well above 2 % threshold). Förväntar oss att ALLA dessa flaggas som
// value, vilket bekräftar att edge-tröskel-koden fungerar.

console.log(`\n${"─".repeat(120)}`);
console.log("Boost-scenario (+7 % candidate odds — alla ska bli VALUE-flaggade)");
console.log("─".repeat(120));

const boostSample = completeMatchups.slice(10, 15); // andra 5 matchups
const boostBet365 = boostSample.flatMap((matchup) =>
  matchup.map((o) => ({
    ...o,
    bookmaker: "bet365",
    odds: Number((o.odds * 1.07).toFixed(3)),
    timestamp: synthTs,
  })),
);
const boostMatched = matchingMod.matchEvents(pinOdds, boostBet365);
const boostValueBets = boostMatched.filter((m) => m.isValue);
console.log(
  `Boost matched: ${boostMatched.length}, value-flaggade: ${boostValueBets.length} ` +
    `(förväntar = ${boostMatched.length})`,
);
for (const m of edgeMod.sortByEdgeDesc(boostMatched).slice(0, 5)) {
  console.log(
    `  ${m.isValue ? "✓ VALUE" : "✗ MISS "}  ` +
    `${m.reference.homeTeam} - ${m.reference.awayTeam}  ` +
    `${m.reference.market} ${m.reference.selection}  ` +
    `bet365=${m.candidate.odds.toFixed(2)} pin=${m.reference.odds.toFixed(2)} ` +
    `→ edge ${m.edgePct > 0 ? "+" : ""}${m.edgePct.toFixed(2)}%`,
  );
}

console.log(`\n${"─".repeat(120)}`);
console.log("Klart.");
