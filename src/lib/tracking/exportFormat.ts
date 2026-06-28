/**
 * exportFormat.ts — pure byggare för Claude Analysis Package (fas 1c).
 *
 * CSV-serialisering (RFC4180-escaping), summary-beräkning och den färdiga
 * claude_analysis_prompt.txt. Pure + testbar; I/O ligger i
 * scripts/export-analysis-package.mjs.
 */

export type Row = Record<string, unknown>;

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s: string;
  if (Array.isArray(v) || (typeof v === "object")) s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialisera rader → CSV. Kolumner = unionen av alla nycklar (stabil ordning) om ej angivet. */
export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns ?? Array.from(rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set<string>()));
  const header = cols.map(csvCell).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return rows.length ? `${header}\n${body}\n` : `${header}\n`;
}

/**
 * Market Trust Layer (§11): lyft liquidity/sharp-fälten ur `extra`-jsonb till
 * egna top-level-kolumner så CSV:n blir analyserbar (annars ligger allt som en
 * JSON-klump i en cell). Saknas trust-data → raden returneras oförändrad.
 */
export function flattenTrustFields(row: Row): Row {
  const extra = row.extra;
  if (!extra || typeof extra !== "object") return row;
  const e = extra as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const sc = obj(e.sharp_consensus);
  const sp = obj(e.sharp_prices);
  const bf = obj(e.betfair);
  const sf = obj(e.source_freshness);
  const sfS = obj(sf.sbobet);
  const sfB = obj(sf.betfair);
  const flat: Row = {};
  const put = (k: string, v: unknown) => { if (v != null) flat[k] = v; };
  put("lq_pinnacle_limit", e.pinnacle_limit);
  put("lq_liquidity_score", e.liquidity_score);
  put("lq_liquidity_grade", e.liquidity_grade);
  put("bf_matched_volume", bf.matched_volume);
  put("bf_spread_pct", bf.spread_pct);
  put("bf_liquidity_factor", bf.liquidity_factor);
  put("bf_back", bf.back); // §2 rå börspris
  put("bf_lay", bf.lay);
  put("bf_mid", bf.mid);
  put("sbobet_age_sec", sfS.age_sec); // §3 per-källa freshness
  put("sbobet_fresh", sfS.fresh);
  put("betfair_age_sec", sfB.age_sec);
  put("betfair_fresh", sfB.fresh);
  put("sharp_consensus_score", sc.consensus_score);
  put("sharp_disagreement_score", sc.disagreement_score);
  put("sharp_sources_count", sc.sources_count);
  put("sharp_price_spread_pct", sc.price_spread_pct);
  put("primary_sharp_source", sc.primary_source);
  put("pinnacle_fair_odds", sp.pinnacle);
  put("sbobet_fair_odds", sp.sbobet);
  put("betfair_fair_odds", sp.betfair);
  if (Array.isArray(e.trust_flags) && e.trust_flags.length) flat.trust_flags = (e.trust_flags as unknown[]).join("|");
  return Object.keys(flat).length ? { ...row, ...flat } : row;
}

function avg(nums: number[]): number | null {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(nums: number[]): number | null {
  const v = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface ExportSummary {
  date_from: string | null;
  date_to: string | null;
  num_signals: number;
  num_snapshots: number;
  num_logged_bets: number;
  num_skipped: number;
  num_outcomes: number;
  avg_ev: number | null;
  avg_clv: number | null;
  median_clv: number | null;
  clv_success_rate: number | null; // andel outcomes med clv > 0
  top_books_by_signals: { book: string; n: number }[];
  top_timing_buckets: { bucket: string; n: number }[];
  data_quality_notes: string[];
  not_enough_data: boolean;
}

export interface ExportInput {
  signals: Row[];
  snapshots: Row[];
  decisions: Row[];
  loggedBets: Row[];
  outcomes: Row[];
  dateFrom?: string | null;
  dateTo?: string | null;
  minSampleSize?: number;
}

function topCount(rows: Row[], key: string, n = 8): { book: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === "") continue;
    m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([book, count]) => ({ book, n: count }));
}

export function computeSummary(input: ExportInput): ExportSummary {
  const minSample = input.minSampleSize ?? 20;
  const evs = input.signals.map((s) => Number(s.ev_at_detection ?? s.current_ev)).filter(Number.isFinite);
  // CLV: föredra outcome-nivå (fas 3b); fall tillbaka på signal-nivå CLV
  // (fas 3a, clv_status=settled) så avg_clv populeras innan riktiga outcomes finns.
  const outcomeClvs = input.outcomes.map((o) => Number(o.clv_pct)).filter(Number.isFinite);
  const signalClvs = input.signals
    .filter((s) => String(s.clv_status) === "settled")
    .map((s) => Number(s.clv_pct))
    .filter(Number.isFinite);
  const clvs = outcomeClvs.length ? outcomeClvs : signalClvs;
  const skipped = input.decisions.filter((d) => String(d.decision_type ?? "").startsWith("skipped") || String(d.decision_type ?? "").startsWith("rejected"));
  const notes: string[] = [];
  if (input.signals.length < minSample) notes.push(`Få signaler (${input.signals.length} < ${minSample}) — dra inga starka slutsatser.`);
  if (input.outcomes.length < minSample) notes.push(`Få outcomes (${input.outcomes.length}) — CLV-statistik är preliminär.`);
  return {
    date_from: input.dateFrom ?? null,
    date_to: input.dateTo ?? null,
    num_signals: input.signals.length,
    num_snapshots: input.snapshots.length,
    num_logged_bets: input.loggedBets.length,
    num_skipped: skipped.length,
    num_outcomes: input.outcomes.length,
    avg_ev: avg(evs),
    avg_clv: avg(clvs),
    median_clv: median(clvs),
    clv_success_rate: clvs.length ? clvs.filter((c) => c > 0).length / clvs.length : null,
    top_books_by_signals: topCount(input.signals, "soft_bookmaker"),
    top_timing_buckets: topCount(input.signals, "timing_bucket_sweden").map((x) => ({ bucket: x.book, n: x.n } as unknown as { book: string; n: number })),
    data_quality_notes: notes,
    not_enough_data: input.signals.length < minSample,
  };
}

/** Färdig prompt som ber Claude analysera paketet (fil-för-fil, kopplat via IDs). */
export function buildClaudeAnalysisPrompt(summary: ExportSummary): string {
  return `# Oddexus valuebet-learning — analysuppdrag

Du får ett dataexport-paket (CSV + full_history.json) från ett valuebet-learning-system.
Period: ${summary.date_from ?? "?"} → ${summary.date_to ?? "?"}.
Volym: ${summary.num_signals} signaler, ${summary.num_snapshots} snapshots, ${summary.num_logged_bets} loggade bets, ${summary.num_skipped} skippade, ${summary.num_outcomes} outcomes.

## Filer & koppling
Alla rader kopplas via stabila IDs:
  raw_odds_observations → movement_events → valuebet_signals(signal_id) → decision_snapshots(snapshot_id)
  → user_decisions/logged_bets(decision_id/bet_id) → bet_outcomes(outcome_id).
Nycklar: observation_id, market_key, movement_id, signal_id, snapshot_id, decision_id, bet_id, outcome_id, strategy_id.

## Analysera (var konkret, kvantifiera, och flagga låg sample size)
1. Vilka signaler/bets gav bäst CLV? Vilka var fake value?
2. Vilka bookmakers är långsammast (stale-line) och bäst för CLV?
3. Vilka markets/sporter ger bäst respektive bör undvikas?
4. När på dygnet (svensk tid) + vilka time-to-start-buckets var bäst (mätt med CLV, inte bara volym)?
5. Vilka strategier hade fungerat bäst om de följts konsekvent? Vilka hade för liten sample size?
6. Var uppstod market mismatch? Vilka alerts var mest användbara?
7. Bör man spela direkt eller vänta? Vilka stale windows var mest värdefulla?
8. Hur ska scoring, staking och alerts förbättras för att minska false positives?
9. Vilka case studies bör studeras för att lära sig känna igen bra valuebets manuellt?

## Likviditet & sharp-consensus (Market Trust Layer)
valuebet_signals/decision_snapshots har nu utplattade kolumner (utöver extra-jsonb):
  lq_liquidity_grade (A–D, PRIOR — ej CLV-kalibrerad), lq_liquidity_score, lq_pinnacle_limit,
  bf_matched_volume, bf_spread_pct, bf_liquidity_factor, sharp_consensus_score,
  sharp_disagreement_score, sharp_sources_count, sharp_price_spread_pct, primary_sharp_source,
  pinnacle_fair_odds, sbobet_fair_odds, betfair_fair_odds, trust_flags (pipe-separerade).
Analysera även (mätt med CLV):
  A. CLV per lq_liquidity_grade — ger A bättre CLV än D? (kalibrera grade-trösklarna)
  B. high EV + låg liquidity (lågt lq_liquidity_score / trust_flags innehåller high_ev_weak_liquidity)
     — oftare fake value (negativ CLV)?
  C. single-source (sharp_sources_count=1 / trust_flags ~ pinnacle_only) vs multi-source — CLV-skillnad?
  D. vilka trust_flags förutspår negativ CLV? (= äkta varningssignaler vs brus)
  E. ger hög lq_pinnacle_limit / låg bf_spread_pct bättre CLV → underlag för stake-justering?

## Viktigt
- Skilj process från resultat (good process/lost ≠ bad process/won).
- Använd CLV som primärt kvalitetsmått, inte enskilda matchresultat.
- ${summary.not_enough_data ? "OBS: liten datamängd — håll slutsatser preliminära." : "Datamängden räcker för riktade slutsatser, men flagga celler med få observationer."}
${summary.data_quality_notes.map((n) => `- ${n}`).join("\n")}
`;
}
