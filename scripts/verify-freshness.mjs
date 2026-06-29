// verify-freshness.mjs — kör i GitHub Actions (SUPABASE_* secrets finns där) och
// bevisar fleet-freshness DB-sidigt: odds_cache per-källa ålder, valuebet_signals
// (färska + market_type/CLV-breakdown) och decision_snapshots. Läs-only.
// Användning: node scripts/verify-freshness.mjs   (kräver SUPABASE_URL + SUPABASE_SERVICE_KEY)

const URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!URL || !KEY) { console.error("FEL: SUPABASE_URL/SUPABASE_SERVICE_KEY saknas"); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const isoAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

async function q(path, { count = false } = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: count ? { ...H, Prefer: "count=exact" } : H,
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`${res.status} ${path} :: ${(await res.text()).slice(0, 200)}`);
  const total = count ? Number((res.headers.get("content-range") || "0/0").split("/")[1] || 0) : null;
  return { rows: await res.json(), total };
}
const fmtAge = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };

(async () => {
  console.log(`\n===== FLEET FRESHNESS VERIFY @ ${new Date().toISOString()} =====`);

  // 1) odds_cache per-källa ålder (= source-panel-datan)
  try {
    const { rows } = await q("odds_cache?select=source_id,updated_at&order=source_id.asc&limit=200");
    const live = rows.filter((r) => r.source_id && !r.source_id.startsWith("_"));
    console.log(`\n-- ODDS_CACHE (${live.length} källor) --`);
    for (const r of live.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))) {
      const ageMs = Date.now() - Date.parse(r.updated_at);
      const grade = ageMs > 6 * 3600e3 ? "DEAD" : ageMs > 30 * 60e3 ? "STALE" : ageMs > 5 * 60e3 ? "WARN" : "FRESH";
      console.log(`   ${grade.padEnd(5)} ${String(r.source_id).padEnd(28)} ${fmtAge(Date.parse(r.updated_at))}`);
    }
    const fresh = live.filter((r) => Date.now() - Date.parse(r.updated_at) < 5 * 60e3).length;
    console.log(`   → ${fresh}/${live.length} < 5min`);
  } catch (e) { console.log("   ODDS_CACHE FEL:", e.message); }

  // 2) valuebet_signals: färska + market_type/CLV-breakdown (24h)
  try {
    const max = (await q("valuebet_signals?select=first_detected_at&order=first_detected_at.desc.nullslast&limit=1")).rows[0]?.first_detected_at;
    const last30 = (await q(`valuebet_signals?select=signal_id&first_detected_at=gte.${isoAgo(30)}`, { count: true })).total;
    console.log(`\n-- VALUEBET_SIGNALS --`);
    console.log(`   senaste first_detected_at: ${max || "(ingen)"} | nya senaste 30m: ${last30}`);
    const { rows } = await q(`valuebet_signals?select=market_type,event_id,clv_status,clv_pct,status,start_time,signal_id,selection,line&first_detected_at=gte.${isoAgo(24 * 60)}&limit=20000`);
    const g = {};
    const sc = {};
    for (const r of rows) {
      const k = r.market_type || "(null)";
      g[k] = g[k] || { n: 0, ev: 0, settled: 0, no_closing: 0, pending: 0, clvs: [] };
      g[k].n++; if (r.event_id) g[k].ev++;
      if (r.clv_status === "settled") g[k].settled++;
      else if (r.clv_status === "no_closing") g[k].no_closing++;
      else g[k].pending++; // null/pending
      if (typeof r.clv_pct === "number") g[k].clvs.push(r.clv_pct);
      const sk = `${r.status || "?"} / ${r.clv_status || "pending"}`;
      sc[sk] = (sc[sk] || 0) + 1;
    }
    console.log(`   market_type (24h):  n | evt_id | evt%% | settled | no_closing | pending | avg_clv`);
    for (const [k, v] of Object.entries(g).sort((a, b) => b[1].n - a[1].n)) {
      const avg = v.clvs.length ? (v.clvs.reduce((a, b) => a + b, 0) / v.clvs.length).toFixed(3) : "—";
      const pct = v.n ? (100 * v.ev / v.n).toFixed(0) : "0";
      console.log(`     ${k.padEnd(12)} ${String(v.n).padStart(5)} | ${String(v.ev).padStart(6)} | ${pct.padStart(4)} | ${String(v.settled).padStart(7)} | ${String(v.no_closing).padStart(10)} | ${String(v.pending).padStart(7)} | ${avg}`);
    }
    console.log(`   status / clv_status (24h):`);
    for (const [k, n] of Object.entries(sc).sort((a, b) => b[1] - a[1])) console.log(`     ${k.padEnd(34)} ${n}`);
    // Exempel-signaler vars avspark PASSERAT (där closing borde finnas)
    const nowMs = Date.now();
    const passed = rows.filter((r) => r.start_time && Date.parse(r.start_time) < nowMs).sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).slice(0, 6);
    console.log(`   EXEMPEL passerade signaler (avspark < nu): ${passed.length}`);
    for (const r of passed) console.log(`     ${r.market_type}/${r.selection ?? "?"}${r.line != null ? `@${r.line}` : ""} evt=${r.event_id ?? "SAKNAS"} clv=${r.clv_status ?? "pending"} kickoff=${r.start_time}`);
  } catch (e) { console.log("   VALUEBET_SIGNALS FEL:", e.message); }

  // 3) decision_snapshots
  try {
    const max = (await q("decision_snapshots?select=created_at&order=created_at.desc.nullslast&limit=1")).rows[0]?.created_at;
    const last30 = (await q(`decision_snapshots?select=signal_id&created_at=gte.${isoAgo(30)}`, { count: true })).total;
    console.log(`\n-- DECISION_SNAPSHOTS --`);
    console.log(`   senaste created_at: ${max || "(ingen)"} | nya senaste 30m: ${last30}`);
  } catch (e) { console.log("   DECISION_SNAPSHOTS FEL:", e.message); }

  console.log(`\n===== SLUT =====\n`);
})();
