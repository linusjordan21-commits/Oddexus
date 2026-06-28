/**
 * scripts/clv-calibrate.ts — gör trust MÄTT: läser CLV-loggen, mäter per källa hur
 * väl dess öppningspris förutspår stängningslinjen, och skriver empiriska
 * clvMultipliers till data/clv-multipliers.json. Consensus + sharpBlend läser den
 * filen och justerar källvikterna därefter (default 1.0 = ingen justering).
 *
 * Kör:  npx vite-node scripts/clv-calibrate.ts [clv-log-path] [--min N]
 *
 * Shadow-only: läser loggen, skriver en multiplikator-fil. Inga live-beslut.
 * Som clv-report kräver detta att loggen finns på disk (actions/cache-workflow).
 */

import { writeFile } from "node:fs/promises";
import { readClvLog, mergeClvLines, DEFAULT_CLV_LOG_PATH } from "../src/lib/odds/clvLogger.ts";
import { deriveClvMultipliers } from "../src/lib/odds/clvCalibration.ts";

const OUT_PATH = "data/clv-multipliers.json";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--")) ?? DEFAULT_CLV_LOG_PATH;
  const minIdx = args.indexOf("--min");
  const minSamples = minIdx >= 0 ? Number(args[minIdx + 1]) : 40;

  const lines = await readClvLog(path);
  if (lines.length === 0) {
    console.warn(`[clv-calibrate] tom/saknad logg (${path}) — skriver INTE multiplikatorer (behåller ev. befintliga).`);
    return;
  }
  const merged = mergeClvLines(lines);
  const settled = merged.filter((r) => r.settled && r.closingFairProb != null);
  const res = deriveClvMultipliers(merged, { minSamples });

  console.log(`[clv-calibrate] ${lines.length} loggrader · ${merged.length} beslut · ${settled.length} settled (closing känd)`);
  console.log(`[clv-calibrate] baslinje-RMSE=${res.baselineRmse?.toFixed(4) ?? "n/a"} · ${res.qualifiedSources} kvalificerade källor (min ${minSamples} samples)`);
  console.log("[clv-calibrate] per källa (rmse mot closing → multiplikator):");
  for (const s of Object.values(res.skill).sort((a, b) => (a.rmse ?? 9) - (b.rmse ?? 9))) {
    const m = res.multipliers[s.sourceId];
    const flag = s.samples < minSamples ? " (för få → 1.0)" : "";
    console.log(`  ${s.sourceId.padEnd(10)} n=${String(s.samples).padStart(5)} rmse=${s.rmse?.toFixed(4) ?? "n/a"} avgCLV=${s.avgClvPct?.toFixed(2) ?? "n/a"}% → ×${m.toFixed(3)}${flag}`);
  }

  await writeFile(OUT_PATH, JSON.stringify({ updatedAt: res.generatedAt, minSamples, baselineRmse: res.baselineRmse, multipliers: res.multipliers }, null, 2), "utf8");
  console.log(`[clv-calibrate] skrev ${OUT_PATH} (${Object.keys(res.multipliers).length} källor). Consensus/sharpBlend plockar upp den nästa cykel.`);
  console.log("[clv-calibrate] shadow-only — inga live-beslut/secrets, inget auto-bet.");
}

main().catch((err) => {
  console.error("[clv-calibrate] oväntat fel (ignoreras):", err);
});
