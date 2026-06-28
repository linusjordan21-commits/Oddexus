/**
 * scripts/settle-clv.ts — fyller closing line + räknar CLV på gamla shadow-
 * beslut i data/clv-log.jsonl. Closing source = Pinnacle (snapshot).
 *
 * Kör:  npx vite-node scripts/settle-clv.ts [closingFile]
 *   closingFile = closing-snapshot (default: data/pinnacle-closing.json om den
 *                 finns, annars data/pinnacle-rows.json)
 *
 * Skriver settlement-rader (append) till samma jsonl. Kör om är säkert —
 * redan settlade hoppar över (ALREADY_SETTLED). Inga live-beslut/secrets.
 */

import { readFile, appendFile, access } from "node:fs/promises";
import {
  parseClvLines,
  mergeClvLines,
  serializeLine,
  readClvLog,
  DEFAULT_CLV_LOG_PATH,
} from "../src/lib/odds/clvLogger.ts";
import { parseClosingSnapshotFile } from "../src/lib/odds/clvCapture.ts";
import { buildClosingIndex, planSettlements } from "../src/lib/odds/clvSettle.ts";
import { buildClvReport } from "../src/lib/odds/clvAnalysis.ts";
import { recommendTrustChanges } from "../src/lib/odds/trustFeedback.ts";

const DATA_DIR = "data";

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function readJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (err) { console.warn(`[settle] kunde inte läsa ${path}: ${(err as NodeJS.ErrnoException).code ?? ""}`); return null; }
}

async function main(): Promise<void> {
  // 1) Läs logg.
  const lines = await readClvLog(DEFAULT_CLV_LOG_PATH);
  if (lines.length === 0) { console.warn(`[settle] tom/saknad logg (${DEFAULT_CLV_LOG_PATH}) — inget att settla.`); return; }
  const merged = mergeClvLines(lines);

  // 2) Closing source = dedikerad kickoff-snapshot (pinnacle-closing.json).
  //    INGEN fallback till future-only pinnacle-rows.json — hellre unsettled
  //    än gissning mot fel linje.
  const closingFile = process.argv[2] ?? `${DATA_DIR}/pinnacle-closing.json`;
  if (!(await exists(closingFile))) {
    console.warn(`[settle] ingen closing-snapshot (${closingFile}) — lämnar allt unsettled. Kör capture-pinnacle-closing.ts nära avspark först.`);
    return;
  }
  const closingJson = await readJson(closingFile);
  if (!closingJson) { console.error(`[settle] closing source kunde inte läsas (${closingFile}) — avbryter.`); return; }
  const closingIndex = buildClosingIndex(parseClosingSnapshotFile(closingJson));
  console.log(`[settle] closing source: ${closingFile} · closing-events: ${closingIndex.size} · open decisions: ${merged.length}`);

  // 3) Planera + skriv settlements.
  const plan = planSettlements(merged, closingIndex);
  if (plan.settlements.length > 0) {
    await appendFile(DEFAULT_CLV_LOG_PATH, plan.settlements.map(serializeLine).join(""), "utf8");
  }

  // 4) Summary.
  console.log("[settle] === SAMMANFATTNING ===");
  console.log(`  open decisions:   ${plan.stats.open}`);
  console.log(`  settled (nya):    ${plan.stats.settled}`);
  console.log(`  skipped:          ${plan.stats.skipped} → ${JSON.stringify(plan.stats.bySkipReason)}`);
  console.log(`  avgCLV / median:  ${fmt(plan.stats.avgClvPct)} / ${fmt(plan.stats.medianClvPct)} %`);

  // 5) Breakdown per decision/scenario/source (efter settlement).
  const after = mergeClvLines(parseClvLines((await readFile(DEFAULT_CLV_LOG_PATH, "utf8"))));
  const report = buildClvReport(after); // default DEDUPAD
  console.log(`  råa open-rader:    ${report.rawDecisions} → dedupade samples: ${report.totalDecisions}`);
  console.log(`  totalt settled:   ${report.settledDecisions}/${report.totalDecisions} (dedupad)`);
  // Breakdown körs på DEDUPAD data (report.byScenario/bySource), inte rå.
  console.log("  per scenario (dedupad):");
  for (const [k, s] of Object.entries(report.byScenario)) {
    if (s.settledSamples > 0) console.log(`    ${k}: n=${s.settledSamples} avgCLV=${fmt(s.avgClvPct)} hit=${pct(s.hitRate)} fp=${pct(s.falsePositiveRate)}`);
  }
  console.log("  per benchmark-source (dedupad):");
  for (const [k, s] of Object.entries(report.bySource)) {
    if (s.settledSamples > 0) console.log(`    ${k}: n=${s.settledSamples} avgCLV=${fmt(s.avgClvPct)} hit=${pct(s.hitRate)}`);
  }

  // 6) Trust-feedback (rekommendationer, inga ändringar).
  const recs = recommendTrustChanges(report.perSource).filter((r) => r.recommendation !== "INSUFFICIENT_DATA");
  if (recs.length) {
    console.log("  trust-feedback (rekommendationer):");
    for (const r of recs) console.log(`    ${r.recommendation} ${r.cell}: ${r.reasons.join("; ")}`);
  } else {
    console.log("  trust-feedback: INSUFFICIENT_DATA på alla celler (fortsätt samla).");
  }
  console.log("[settle] shadow mode — inga live-beslut/secrets, inget auto-bet.");
}

function fmt(x: number | null): string { return x == null ? "—" : x.toFixed(2); }
function pct(x: number | null): string { return x == null ? "—" : (x * 100).toFixed(0) + "%"; }

main().catch((err) => { console.error("[settle] oväntat fel (ignoreras):", err); });
