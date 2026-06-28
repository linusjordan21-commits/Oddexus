/**
 * export-analysis-package.mjs — genererar Claude Analysis Package (fas 1c).
 *
 * Läser tracking-tabellerna ur Supabase (paginerat, valfritt date-filter), skriver
 * CSV-filer + summary + full_history.json + claude_analysis_prompt.txt till en mapp.
 * Körs av export-analysis.yml och laddas upp som artifact.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   EXPORT_DIR    (default ./export-out)
 *   EXPORT_FROM   ISO-datum (default 30 dagar bakåt)  — filtrerar på de tabeller som har tid
 *   EXPORT_TO     ISO-datum (default nu)
 */

import fs from "node:fs";
import path from "node:path";
import { dbSelectAll, dbEnabled } from "./lib/db-write.mjs";
import { toCsv, computeSummary, buildClaudeAnalysisPrompt, flattenTrustFields } from "../src/lib/tracking/exportFormat.ts";

const OUT = process.env.EXPORT_DIR || "./export-out";
const TO = process.env.EXPORT_TO || new Date().toISOString();
const FROM = process.env.EXPORT_FROM || new Date(Date.now() - 30 * 864e5).toISOString();

// tabell → tidskolumn att filtrera på (null = ingen filtrering)
const TABLES = [
  ["valuebet_signals", "first_detected_at"],
  ["decision_snapshots", "taken_at"],
  ["user_decisions", "decided_at"],
  ["logged_bets", "created_at"],
  ["bet_outcomes", "created_at"],
  ["raw_odds_observations", "observed_at"],
  ["movement_events", "timestamp"],
  ["market_mismatch_warnings", "detected_at"],
  ["stale_windows", null],
  ["fake_drop_candidates", null],
  ["strategy_definitions", null],
  ["strategy_backtest_results", null],
  ["bonus_promos", null],
  ["normalized_markets", null],
  ["scrape_runs", "started_at"],
];

function qsFor(timeCol) {
  if (!timeCol) return "";
  return `&${timeCol}=gte.${encodeURIComponent(FROM)}&${timeCol}=lte.${encodeURIComponent(TO)}`;
}

async function main() {
  if (!dbEnabled()) {
    console.error("[export] SUPABASE_* saknas.");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const data = {};
  for (const [table, timeCol] of TABLES) {
    const rows = await dbSelectAll(table, qsFor(timeCol));
    data[table] = rows;
    fs.writeFileSync(path.join(OUT, `${table}.csv`), toCsv(rows.map(flattenTrustFields))); // §11: liquidity/sharp-kolumner
    console.log(`[export] ${table}: ${rows.length} rader`);
  }

  const summary = computeSummary({
    signals: data.valuebet_signals ?? [],
    snapshots: data.decision_snapshots ?? [],
    decisions: data.user_decisions ?? [],
    loggedBets: data.logged_bets ?? [],
    outcomes: data.bet_outcomes ?? [],
    dateFrom: FROM,
    dateTo: TO,
  });
  fs.writeFileSync(path.join(OUT, "summary_metrics.csv"), toCsv([summary]));
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, "full_history.json"), JSON.stringify({ generatedAt: TO, dateFrom: FROM, dateTo: TO, data }, null, 2));
  fs.writeFileSync(path.join(OUT, "claude_analysis_prompt.txt"), buildClaudeAnalysisPrompt(summary));

  console.log(`[export] klart → ${OUT} (${TABLES.length} CSV + summary + full_history.json + prompt).`);
  console.log(`[export] signaler=${summary.num_signals} outcomes=${summary.num_outcomes} avgCLV=${summary.avg_clv ?? "—"}`);
}

main().catch((e) => {
  console.error("[export] Fatal:", e.message);
  process.exit(1);
});
