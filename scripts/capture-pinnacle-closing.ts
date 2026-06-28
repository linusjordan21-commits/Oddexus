/**
 * scripts/capture-pinnacle-closing.ts — fångar Pinnacle closing line nära
 * avspark och merge:ar in i data/pinnacle-closing.json (behåller snapshot
 * närmast avspark per event). Körs schemalagt (t.ex. var ~5:e minut).
 *
 * Kör:  npx vite-node scripts/capture-pinnacle-closing.ts [minBefore] [maxAfter]
 *   minBefore = minuter före avspark att börja fånga (default 15)
 *   maxAfter  = minuter efter avspark att sluta fånga (default 2)
 *
 * Inga live-beslut/secrets/frontend-ändringar. Kraschar inte om filer saknas.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { parsePinnacleSoccer } from "../src/lib/odds/shadowConsensus.ts";
import { runCapture, type ClosingFile, type CaptureWindow, type ClosingLadders } from "../src/lib/odds/clvCapture.ts";
import { parsePinnacleLineLadders } from "../src/lib/odds/pinnacleLines.ts";

const DATA_DIR = "data";
const CLOSING_PATH = `${DATA_DIR}/pinnacle-closing.json`;

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
async function readJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (err) { console.warn(`[capture] kunde inte läsa ${path}: ${(err as NodeJS.ErrnoException).code ?? ""}`); return null; }
}

async function main(): Promise<void> {
  const window: CaptureWindow = {
    minBeforeMin: Number(process.argv[2] ?? 15),
    maxAfterMin: Number(process.argv[3] ?? 2),
  };

  const pinJson = await readJson(`${DATA_DIR}/pinnacle-rows.json`);
  if (!pinJson) { console.error("[capture] Pinnacle-data saknas — avbryter."); return; }
  const pinnacle = parsePinnacleSoccer(pinJson);

  // AH/totals-stegar (Pinnacle no-vig) per eventId — ADDITIVT till ML-closing så
  // CLV kan beräknas på AH/totals. Rör inte ML-prissättningen.
  const ladders = new Map<string, ClosingLadders>();
  try {
    for (const [eventId, l] of parsePinnacleLineLadders(pinJson, "soccer")) {
      ladders.set(eventId, {
        totals: l.totals.points.map((p) => ({ line: p.line, prob: p.prob })),
        ah: l.ah.points.map((p) => ({ line: p.line, prob: p.prob })),
      });
    }
  } catch (err) {
    console.warn(`[capture] AH/totals-ladder-parse misslyckades (ignoreras): ${(err as Error)?.message ?? err}`);
  }

  const existing = (await exists(CLOSING_PATH)) ? (await readJson(CLOSING_PATH)) as ClosingFile | null : null;

  const result = runCapture({ pinnacle, existing, window, ladders });

  // Skriv merged closing-fil (merge, inte overwrite av äldre events).
  await writeFile(CLOSING_PATH, JSON.stringify(result.merged), "utf8");

  const near = result.stats.nearestKickoffDiffMin;
  console.log("[capture] === SAMMANFATTNING ===");
  console.log(`  fönster:            [${window.minBeforeMin} min före, ${window.maxAfterMin} min efter] avspark`);
  console.log(`  events scannade:    ${result.stats.scanned}`);
  console.log(`  captured (nya):     ${result.stats.captured}`);
  console.log(`  updated (närmare):  ${result.stats.updated}`);
  console.log(`  kept (gammal närmare): ${result.stats.keptExisting}`);
  console.log(`  skipped:            ${result.stats.skipped} → ${JSON.stringify(result.stats.bySkipReason)}`);
  console.log(`  närmaste kickoff:   ${near == null ? "—" : near.toFixed(1) + " min"}`);
  console.log(`  closing-events tot: ${Object.keys(result.merged.events).length} → ${CLOSING_PATH}`);
  console.log("[capture] shadow mode — inga live-beslut/secrets.");
}

main().catch((err) => { console.error("[capture] oväntat fel (ignoreras):", err); });
