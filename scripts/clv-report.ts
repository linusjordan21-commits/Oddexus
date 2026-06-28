/**
 * scripts/clv-report.ts — skriver ut en omfattande, DEDUPAD CLV-rapport från
 * data/clv-log.jsonl. Shadow-only, läser bara loggen, påverkar inga live-beslut.
 *
 * Kör:  npx vite-node scripts/clv-report.ts
 *
 * OBS: CLV-staten lever i actions/cache (inte i repot), så detta ger meningsfull
 * data först när loggen finns på disk — t.ex. i clv-report.yml-workflowen som
 * återställer cachen innan den kör detta. Lokalt utan logg → tom rapport.
 */

import { readClvLog, mergeClvLines, DEFAULT_CLV_LOG_PATH } from "../src/lib/odds/clvLogger.ts";
import { buildFullClvReport, formatReport } from "../src/lib/odds/clvReport.ts";
import { recommendTrustChanges } from "../src/lib/odds/trustFeedback.ts";

async function main(): Promise<void> {
  const path = process.argv[2] ?? DEFAULT_CLV_LOG_PATH;
  const lines = await readClvLog(path);
  if (lines.length === 0) {
    console.warn(`[clv-report] tom/saknad logg (${path}) — inget att rapportera.`);
    return;
  }
  const merged = mergeClvLines(lines);
  const report = buildFullClvReport(merged); // DEDUPAR default

  console.log(formatReport(report));

  // TrustFeedback kräver fortfarande min sample count (rekommendationer separat
  // från preliminära rapportsiffror).
  console.log("");
  console.log("── TRUST-FEEDBACK (kräver min sample count) ──");
  const recs = recommendTrustChanges(report.perSource).filter((r) => r.recommendation !== "INSUFFICIENT_DATA");
  if (recs.length === 0) {
    console.log("  INSUFFICIENT_DATA på alla celler (fortsätt samla).");
  } else {
    for (const r of recs) console.log(`  ${r.recommendation} ${r.cell}: ${r.reasons.join("; ")}`);
  }
  console.log("[clv-report] shadow-only — inga live-beslut/secrets, inget auto-bet.");
}

main().catch((err) => {
  console.error("[clv-report] oväntat fel (ignoreras):", err);
});
