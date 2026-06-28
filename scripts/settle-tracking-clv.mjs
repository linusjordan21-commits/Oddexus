/**
 * settle-tracking-clv.mjs — beräknar CLV (closing line value) på spårade signaler.
 *
 * Körs i shadow-clv-loopen DÄR Pinnacle closing-line redan finns på disk
 * (data/pinnacle-closing.json, återställd från actions/cache). Påverkar INGEN
 * prissättning — läser bara closing + Supabase-signaler och skriver CLV tillbaka.
 *
 * CLV = slog vi den sanna closing-linjen? = soft_odds_at_detection * fairProb_close - 1.
 * Positivt → vi tog ett bättre pris än Pinnacles no-vig closing (= äkta value).
 *
 * MARKETS som stöds (steg 2):
 *   - moneyline / 1x2  → ML closing (rec.fairProb[HOME|DRAW|AWAY])
 *   - total (O/U, inkl Asian quarter-linjer om de finns) → rec.totalsLines (overProb per linje)
 *   - ah (Asian handicap) → rec.ahLines (homeProb per HEMMA-perspektiv-linje)
 * eh3/corners hoppas över (ingen Pinnacle-closing fångad för dem ännu) → faller
 * till no_closing efter rimlig tid så lifecyclen inte fastnar.
 *
 * MATCHNING: exakt event_id + exakt linje (epsilon) + selection. Live odds blandas
 * ALDRIG med closing — vi läser bara closing-snapshotfilen. Fallback (lag+tid) i steg 3.
 *
 * Idempotent: signaler med clv_status satt hoppas över. Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 */

import { readFile } from "node:fs/promises";
import { closingFairProb, computeClv, findClosingFallback } from "../src/lib/tracking/closingClv.ts";
import { splitMatch, snapshotFromSignalRow } from "../src/lib/tracking/signalMapping.ts";
import { normalizeTeamName } from "../src/lib/odds/matching.ts";
import { dbSelectAll, dbPatch, dbInsert, dbEnabled } from "./lib/db-write.mjs";

const CLOSING_PATH = "data/pinnacle-closing.json";
// no_closing är TERMINALT (settle hoppar över satt clv_status). Sätt det aldrig för
// tidigt: marknader som BORDE ha Pinnacle-closing (1x2/moneyline/total/ah) får lång
// frist så att closing-capture-lag (opålitlig GitHub Actions-kadens) inte ger falsk
// no_closing. Marknader UTAN closing (eh3/corners → closingFairProb alltid null) ger
// upp snabbt så lifecyclen inte fastnar i 'expired'.
const NO_CLOSING_AFTER_MS = 30 * 60 * 1000; // eh3/corners (ingen closing finns)
const NO_CLOSING_SUPPORTED_AFTER_MS = 120 * 60 * 1000; // 1x2/moneyline/total/ah (closing borde komma)
const CLOSING_SUPPORTED = new Set(["moneyline", "1x2", "total", "ah"]);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function main() {
  if (!dbEnabled()) {
    console.log("[settle-clv-tracking] SUPABASE_* saknas → no-op.");
    return;
  }
  const closing = await readJson(CLOSING_PATH);
  const events = closing?.events ?? {};
  const nEvents = Object.keys(events).length;
  if (nEvents === 0) {
    console.log("[settle-clv-tracking] ingen closing-data ännu → no-op.");
    return;
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // ALLA osettlade signaler vars avspark passerat (oavsett market — vi dispatchar nedan).
  const signals = await dbSelectAll(
    "valuebet_signals",
    `&clv_status=is.null&start_time=lt.${encodeURIComponent(nowIso)}&order=start_time.asc`,
  );
  console.log(`[settle-clv-tracking] ${signals.length} osettlade signaler, ${nEvents} closing-events.`);

  const byMarket = {};
  const closingSnapshots = [];
  let settled = 0, noClosing = 0, pending = 0, fallbackHits = 0;
  for (const s of signals) {
    const mt = String(s.market_type || "").toLowerCase();
    const betOdds = num(s.soft_odds_at_detection);

    // HUVUDVÄG: exakt event_id. FALLBACK (steg 3, robusthets-layer): saknas event_id
    // → matcha på normaliserade lag + avspark ± tolerans (unik träff, annars hoppa).
    let rec = s.event_id ? events[s.event_id] : null;
    let matchMethod = rec ? "exact" : null;
    if (!rec) {
      const { home, away } = splitMatch(s.match || "");
      const startMs = s.start_time ? Date.parse(s.start_time) : NaN;
      const fb = findClosingFallback(normalizeTeamName(home || ""), normalizeTeamName(away || ""), startMs, events);
      if (fb) { rec = fb.rec; matchMethod = "fallback_team_time"; }
    }

    if (rec && betOdds != null) {
      const fp = closingFairProb(rec, mt, s.selection, num(s.line));
      if (fp != null) {
        const { closingFairOdds, clvPct } = computeClv(betOdds, fp);
        const r = await dbPatch("valuebet_signals", `signal_id=eq.${encodeURIComponent(s.signal_id)}`, {
          clv_status: "settled",
          clv_settled_at: nowIso,
          closing_captured_at: rec.capturedAt ?? null,
          closing_fair_odds: Number(closingFairOdds.toFixed(4)),
          clv_pct: Number(clvPct.toFixed(4)),
          clv_bet_odds: betOdds,
          clv_match_method: matchMethod,
        });
        if (r.ok) {
          settled++; byMarket[mt] = (byMarket[mt] ?? 0) + 1;
          if (matchMethod === "fallback_team_time") fallbackHits++;
          // closing_captured-snapshot: en beslutspunkt på tidslinjen när closing fångades.
          closingSnapshots.push(snapshotFromSignalRow(s, nowIso, "closing_captured", {
            clv_pct: Number(clvPct.toFixed(4)),
            closing_fair_odds: Number(closingFairOdds.toFixed(4)),
            clv_bet_odds: betOdds,
            match_method: matchMethod,
          }));
        }
        else if (settled + noClosing < 3) console.warn(`[settle-clv-tracking] patch-fel (${r.status}): ${r.error ?? ""}`);
        continue;
      }
    }

    // Ingen closing (saknad event, omatchad linje, eller market utan closing) och
    // avsparket passerat tillräckligt länge → no_closing (slutar retrya, lifecyclen
    // resolvar). Frist beror på om marknaden alls KAN ha closing (se konstanterna).
    const startMs = s.start_time ? Date.parse(s.start_time) : NaN;
    const graceMs = CLOSING_SUPPORTED.has(mt) ? NO_CLOSING_SUPPORTED_AFTER_MS : NO_CLOSING_AFTER_MS;
    if (Number.isFinite(startMs) && nowMs - startMs > graceMs) {
      const r = await dbPatch("valuebet_signals", `signal_id=eq.${encodeURIComponent(s.signal_id)}`, {
        clv_status: "no_closing",
        clv_settled_at: nowIso,
      });
      if (r.ok) noClosing++;
    } else {
      pending++;
    }
  }

  // closing_captured-snapshots (batch om 500). Dubbletter (samma snapshot_id) ger 409 → tyst ok.
  let snapOk = 0;
  for (let i = 0; i < closingSnapshots.length; i += 500) {
    const batch = closingSnapshots.slice(i, i + 500);
    const r = await dbInsert("decision_snapshots", batch);
    if (r.ok) snapOk += batch.length;
    else console.warn(`[settle-clv-tracking] snapshot-insert fel (${r.status}): ${r.error ?? ""}`);
  }

  console.log(`[settle-clv-tracking] klart: ${settled} settlade ${JSON.stringify(byMarket)} (varav ${fallbackHits} via lag+tid-fallback), ${snapOk} closing-snapshots, ${noClosing} utan closing, ${pending} väntar.`);
}

main().catch((e) => {
  console.error("[settle-clv-tracking] Fatal:", e.message);
  process.exit(1);
});
