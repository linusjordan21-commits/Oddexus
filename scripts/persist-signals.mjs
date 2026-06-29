/**
 * persist-signals.mjs — persisterar visade valuebets → Supabase (fas 1b).
 *
 * Körs av en worker var ~5 min (persist-signals.yml). Webben DRIVER inte analysen:
 * scriptet HÄMTAR den redan-beräknade /api/valuebets (cachad på servern) och skriver
 * ner signaler + decision_snapshots. DEDUP över böcker (en signal per market_key).
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  — DB-skrivning (annars no-op).
 *   VALUEBETS_URL                       — bas-URL till appen (default oddexus.com).
 *   VALUEBETS_HOURS                     — fönster (default 72).
 */

import {
  groupByMarketKey,
  buildSignalRecord,
  buildSnapshotRecord,
  classifySnapshotTrigger,
  snapshotFromSignalRow,
  deriveSignalId,
} from "../src/lib/tracking/signalMapping.ts";
import { dbRpc, dbInsert, dbUpsert, dbSelectAll, dbDelete, dbEnabled } from "./lib/db-write.mjs";

const BASE = (process.env.VALUEBETS_URL || "https://oddexus.com").replace(/\/+$/, "");
// 24h matchar serverns warmade cache (RESPONSE_WARM_HEAVY värmer valuebets(24h)).
// Då serveras workerns request DIREKT ur cachen utan en tung server-side
// omberäkning → ingen OOM-risk. 72h tvingade en färsk 72h-build per varv (tyngre
// än warmen → kunde spränga heapen igen). Höj via VALUEBETS_HOURS när 72h också
// warmats/bevisats säkert.
const HOURS = process.env.VALUEBETS_HOURS || "24";
// Server-till-server-token för att passera valuebetsAccessMiddleware (auth-gaten).
const INTERNAL_TOKEN = (process.env.VALUEBETS_INTERNAL_TOKEN || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function fetchValuebets() {
  const url = `${BASE}/api/valuebets?hours=${HOURS}`;
  console.log(`[persist-debug] fetch ${url} (token ${INTERNAL_TOKEN ? "satt" : "SAKNAS"})`);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 90000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "persist-signals", "X-Internal-Token": INTERNAL_TOKEN }, signal: controller.signal });
    const dur = Date.now() - t0;
    console.log(`[persist-debug] HTTP ${res.status} på ${dur}ms`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    console.log(`[persist-debug] response ${text.length} bytes`);
    const json = JSON.parse(text);
    const vbs = Array.isArray(json?.valueBets) ? json.valueBets : Array.isArray(json) ? json : [];
    console.log(`[persist-debug] valuebets i response: ${vbs.length}${json?.note ? ` | note: ${json.note}` : ""}`);
    return vbs;
  } catch (e) {
    console.error(`[persist-debug] fetch FEL efter ${Date.now() - t0}ms: ${e.name}: ${e.message}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  if (!dbEnabled()) {
    console.log("[persist-signals] SUPABASE_* saknas → no-op.");
    return;
  }
  const nowIso = new Date().toISOString();
  let valuebets;
  try {
    valuebets = await fetchValuebets();
  } catch (e) {
    console.error(`[persist-signals] kunde ej hämta valuebets: ${e.message}`);
    process.exit(1);
  }
  console.log(`[persist-signals] ${valuebets.length} valuebets hämtade.`);

  const groups = groupByMarketKey(valuebets);
  console.log(`[persist-signals] ${groups.size} unika signaler efter dedup över böcker.`);

  // Förra tickets persisterade tillstånd för aktiva signaler → trigger-klassning
  // (value_appeared/sharp_drop/ev_changed_materially…) + value_disappeared nedan.
  const prevActive = await dbSelectAll("valuebet_signals", "&status=eq.active");
  const prevById = new Map(prevActive.map((s) => [s.signal_id, s]));

  let signalsOk = 0;
  let signalsFail = 0;
  const snapshots = [];
  const warnings = [];
  const triggerCounts = {};
  const seen = new Set();
  for (const group of groups.values()) {
    const sig = buildSignalRecord(group, nowIso);
    seen.add(sig.signal_id);
    const r = await dbRpc("upsert_valuebet_signal", { s: sig });
    if (r.ok) signalsOk++;
    else {
      signalsFail++;
      if (signalsFail <= 3) console.warn(`[persist-signals] signal-upsert fel (${r.status}): ${r.error ?? ""}`);
    }
    const { trigger, extra } = classifySnapshotTrigger(prevById.get(sig.signal_id), {
      ev: sig.current_ev,
      sharp_fair_odds: sig.sharp_fair_odds,
    });
    triggerCounts[trigger] = (triggerCounts[trigger] ?? 0) + 1;
    snapshots.push(buildSnapshotRecord(sig.signal_id, group, nowIso, trigger, extra));
    // market_mismatch_warnings: signaler flaggade för manuell granskning (needsReview)
    // loggas så de kan analyseras (full cross-source-detektering kommer i fas 2).
    if (sig.market_mismatch_risk) {
      warnings.push({
        warning_id: `mmw_${sig.signal_id}_${nowIso.slice(0, 16)}`,
        market_key: sig.market_key,
        signal_id: sig.signal_id,
        event_id: sig.event_id,
        codes: ["NEEDS_REVIEW"],
        soft_bookmaker: sig.soft_bookmaker,
        severity: "medium",
        detail: sig.reason_summary ?? null,
      });
    }
  }
  if (warnings.length) {
    const w = await dbUpsert("market_mismatch_warnings", warnings, "warning_id");
    if (!w.ok) console.warn(`[persist-signals] mismatch-warning fel (${w.status}): ${w.error ?? ""}`);
  }

  // value_disappeared: aktiva signaler från förra tick som inte syns i denna feed men
  // vars avspark fortfarande är i framtiden (= value försvann FÖRE kickoff, inte pga
  // kickoff). Avspark passerat → lifecycle-sweepen resolvar dem, ingen snapshot här.
  const nowMs = Date.parse(nowIso);
  for (const s of prevActive) {
    if (seen.has(s.signal_id)) continue;
    const startMs = s.start_time ? Date.parse(s.start_time) : NaN;
    if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
    snapshots.push(snapshotFromSignalRow(s, nowIso, "value_disappeared", { last_ev: s.current_ev ?? null }));
    triggerCounts.value_disappeared = (triggerCounts.value_disappeared ?? 0) + 1;
  }

  // Snapshots i batchar om 500.
  let snapOk = 0;
  for (let i = 0; i < snapshots.length; i += 500) {
    const batch = snapshots.slice(i, i + 500);
    const r = await dbInsert("decision_snapshots", batch);
    if (r.ok) snapOk += batch.length;
    else console.warn(`[persist-signals] snapshot-insert fel (${r.status}): ${r.error ?? ""}`);
  }

  console.log(
    `[persist-signals] klart: ${signalsOk} signaler upsertade (${signalsFail} fel), ${snapOk} snapshots ${JSON.stringify(triggerCounts)}.`,
  );

  // LIFECYCLE-SWEEP: flytta signaler vars avspark passerat ur 'active' → expired/
  // closed_* så Strategy Lab/timing/dashboards inte räknar gamla valuebets som
  // aktiva. Set-baserad RPC (en query). Fel loggas men stoppar inte workern.
  const sweep = await dbRpc("sweep_signal_lifecycle", {});
  if (sweep.ok) console.log(`[persist-signals] lifecycle-sweep: ${JSON.stringify(sweep.data ?? {})}`);
  else console.warn(`[persist-signals] lifecycle-sweep fel (${sweep.status}): ${sweep.error ?? ""}`);

  // HOUSEKEEPING: rensa döda odds_cache-rader (>7 dygn utan uppdatering) så
  // färskhets-panelen inte fylls av retirerade scrapers. Utfallskällan
  // (match-results) uppdateras sällan och skyddas. Levande källor (sek–min) rörs
  // aldrig. Idempotent, no-op de flesta varv.
  const pruneCutoff = new Date(Date.now() - 7 * 864e5).toISOString();
  const prune = await dbDelete(
    "odds_cache",
    `updated_at=lt.${encodeURIComponent(pruneCutoff)}&source_id=not.in.(match-results,match_results)`,
  );
  if (!prune.ok) console.warn(`[persist-signals] odds_cache-prune fel (${prune.status}): ${prune.error ?? ""}`);
}

main().catch((e) => {
  console.error("[persist-signals] Fatal:", e.message);
  process.exit(1);
});
