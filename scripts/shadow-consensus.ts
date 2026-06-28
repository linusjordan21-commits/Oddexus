/**
 * scripts/shadow-consensus.ts — kör sharp-consensus-mellanlagret i SHADOW MODE
 * mot riktiga Pinnacle-data + mockad Betfair, och loggar besluten till
 * data/clv-log.jsonl för senare CLV-analys.
 *
 * Kör:  npx vite-node scripts/shadow-consensus.ts [source|all] [franchise]
 *   source    = filnamn utan suffix i data/ (t.ex. "comeon"); "all"/utelämnat
 *               → ALLA soft-källor (SOURCES nedan) mot samma Pinnacle-ankare.
 *   franchise = (endast enskild byFranchise-källa) t.ex. "SWEDEN_COMEON"
 *
 * Påverkar INGA live-beslut: läser bara *-rows.json, skriver bara clv-log.jsonl.
 * Kraschar inte på saknad/omatchad data — loggar reason-koder per källa.
 */

import { readFile, appendFile, access } from "node:fs/promises";
import {
  parsePinnacleSoccer,
  parseSoftBook,
  parseBetfairRowsMap,
  parseBetfairLineRowsMap,
  parseSbobetRowsMap,
  parseSbobetAhRowsMap,
  buildMockBetfairMap,
  runShadow,
} from "../src/lib/odds/shadowConsensus.ts";
import { parsePinnacleLineLadders } from "../src/lib/odds/pinnacleLines.ts";
import { serializeLine } from "../src/lib/odds/clvLogger.ts";

const DATA_DIR = "data";
const CLV_LOG = `${DATA_DIR}/clv-log.jsonl`;

/**
 * Alla soft-källor som ska följas mot Pinnacle-ankaret. `file` defaultar till
 * `${book}-rows.json`. Pinnacle + SBOBET är SKARPA benchmarks (ej kandidater)
 * och ligger därför inte här. Lägg till nya soft-källor här när de finns.
 */
const SOURCES: Array<{ book: string; file?: string; franchise?: string }> = [
  { book: "altenar" },
  { book: "comeon" },
  { book: "kambi" },
  { book: "paf", file: "paf-brand" },
  { book: "vbet" },
  { book: "betsson" },
  { book: "smarkets" },
];

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.warn(`[shadow] kunde inte läsa ${path}: ${e.code ?? e.message}`);
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
  const target = (args[0] ?? "all").toLowerCase();
  const franchiseArg = args[1];
  const mockBetfair = flags.has("--mock-betfair");

  const pinJson = await readJson(`${DATA_DIR}/pinnacle-rows.json`);
  if (!pinJson) {
    console.error("[shadow] Pinnacle-data saknas — avbryter utan att skriva.");
    return;
  }
  const pinnacle = parsePinnacleSoccer(pinJson);
  // Pinnacle totals/AH-stegar (skarpt ankare för linje-marknader). Samma
  // pinnacle-rows.json som redan lästs in → ingen extra IO.
  const pinnacleLines = parsePinnacleLineLadders(pinJson, "soccer");
  const withLines = [...pinnacleLines.values()].filter((l) => l.totals.points.length || l.ah.points.length).length;
  console.log(`[shadow] Pinnacle: ${pinnacle.length} 1X2-events · ${withLines} events med totals/AH-stegar`);

  if (pinnacle.length === 0) {
    console.warn("[shadow] tom Pinnacle — inget ankare att utvärdera mot.");
    return;
  }

  // Betfair-källa: riktig data/betfair-rows.json om den finns, annars mock
  // bara med explicit --mock-betfair, annars PINNACLE-ONLY (ren CLV).
  let betfairMarkets: Map<string, import("../src/lib/odds/betfairAdapter.ts").BetfairMarket> | undefined;
  let betfairLines: Map<string, import("../src/lib/odds/betfairAdapter.ts").BetfairMarket[]> | undefined;
  if (await exists(`${DATA_DIR}/betfair-rows.json`)) {
    const bfJson = await readJson(`${DATA_DIR}/betfair-rows.json`);
    betfairMarkets = bfJson ? parseBetfairRowsMap(bfJson) : undefined;
    betfairLines = bfJson ? parseBetfairLineRowsMap(bfJson) : undefined;
    const bfTotals = [...(betfairLines?.values() ?? [])].reduce((n, ms) => n + ms.filter((m) => m.marketType === "TOTALS").length, 0);
    const bfAh = [...(betfairLines?.values() ?? [])].reduce((n, ms) => n + ms.filter((m) => m.marketType === "AH").length, 0);
    console.log(`[shadow] Betfair-källa: data/betfair-rows.json (${betfairMarkets?.size ?? 0} 1X2-events · ${bfTotals} totals-linjer · ${bfAh} AH-linjer)`);
  } else if (mockBetfair) {
    betfairMarkets = buildMockBetfairMap(pinnacle);
    console.log(`[shadow] Betfair-källa: MOCK (--mock-betfair, ${betfairMarkets.size} events) — endast demo`);
  } else {
    console.log("[shadow] Betfair-källa: ingen → PINNACLE-ONLY (ren CLV-attribution)");
  }

  // Empiriska CLV-multiplikatorer (från clv-calibrate) — skalar källvikterna efter
  // uppmätt träffsäkerhet mot stängningslinjen. Saknas → alla 1.0 (prior-vikt).
  let clvMultipliers: Record<string, number> | undefined;
  if (await exists(`${DATA_DIR}/clv-multipliers.json`)) {
    const mj = (await readJson(`${DATA_DIR}/clv-multipliers.json`)) as { multipliers?: Record<string, number> } | null;
    clvMultipliers = mj?.multipliers ?? undefined;
    if (clvMultipliers) console.log(`[shadow] CLV-multiplikatorer: ${Object.entries(clvMultipliers).map(([k, v]) => `${k}×${v.toFixed(2)}`).join(" ")}`);
  }

  // SBOBET-källa: riktig data/sbobet-rows.json om den finns (andra sharp-källan).
  // 1X2-marknader (PINNACLE_ANCHOR-blandning) + AH-stegar (asiatiskt handikapp).
  let sbobet: Map<string, import("../src/lib/odds/sbobetScrapeParse.ts").SbobetMarket> | undefined;
  let sbobetAh: Map<string, import("../src/lib/odds/sbobetScrapeParse.ts").SbobetMarket[]> | undefined;
  if (await exists(`${DATA_DIR}/sbobet-rows.json`)) {
    const sboJson = await readJson(`${DATA_DIR}/sbobet-rows.json`);
    sbobet = sboJson ? parseSbobetRowsMap(sboJson) : undefined;
    sbobetAh = sboJson ? parseSbobetAhRowsMap(sboJson) : undefined;
    console.log(`[shadow] SBOBET-källa: data/sbobet-rows.json (${sbobet?.size ?? 0} 1X2-events · ${sbobetAh?.size ?? 0} AH-events)`);
  }

  // Vilka källor ska köras? "all"/utelämnat → SOURCES; annars exakt en (med
  // valfri franchise, bakåtkompatibelt med den gamla enskild-källa-signaturen).
  const toRun = target === "all"
    ? SOURCES
    : [{ book: target, file: target, franchise: franchiseArg }];

  const allEntries: ReturnType<typeof runShadow>["entries"] = [];
  let grandMatched = 0;
  let grandLineDecisions = 0;

  for (const src of toRun) {
    const file = `${DATA_DIR}/${src.file ?? src.book}-rows.json`;
    if (!(await exists(file))) { console.log(`[shadow] ${src.book}: ${file} saknas — hoppar över.`); continue; }
    const softJson = await readJson(file);
    if (!softJson) { console.log(`[shadow] ${src.book}: kunde inte läsa ${file} — hoppar.`); continue; }
    const candidates = parseSoftBook(softJson, src.book, src.franchise);
    if (candidates.length === 0) { console.log(`[shadow] ${src.book}: 0 kandidat-events — hoppar.`); continue; }

    const withTotals = candidates.filter((c) => c.totals?.length).length;
    const withAh = candidates.filter((c) => c.ah?.length).length;
    const result = runShadow({ pinnacle, candidates, betfairMarkets, betfairLines, sbobet, sbobetAh, pinnacleLines, clvMultipliers });
    const lineDecisions = result.entries.filter((e) => e.marketType === "TOTAL" || e.marketType === "AH").length;
    allEntries.push(...result.entries);
    grandMatched += result.stats.matched;
    grandLineDecisions += lineDecisions;
    console.log(
      `[shadow] ${src.book.padEnd(9)} kandidater=${String(candidates.length).padStart(4)}` +
      ` (totals ${withTotals}/AH ${withAh}) · matchade=${result.stats.matched}/${result.stats.candidates}` +
      ` · beslut=${result.stats.decisions} (linje: ${lineDecisions})` +
      ` · skip=${JSON.stringify(result.stats.bySkipReason)}`,
    );
  }

  // Skriv alla ClvOpenEntry till loggen (append, en rad per beslut).
  if (allEntries.length > 0) {
    await appendFile(CLV_LOG, allEntries.map(serializeLine).join(""), "utf8");
  }

  console.log("[shadow] === SAMMANFATTNING ===");
  console.log(`  källor körda:      ${toRun.length}`);
  console.log(`  matchade events:   ${grandMatched}`);
  console.log(`  beslut loggade:    ${allEntries.length} → ${CLV_LOG} (varav linje-beslut: ${grandLineDecisions})`);
  console.log("[shadow] shadow mode — inga live-beslut påverkade, inget auto-bet.");
}

main().catch((err) => {
  // Krascha aldrig hårt — logga och avsluta rent.
  console.error("[shadow] oväntat fel (ignoreras):", err);
});
