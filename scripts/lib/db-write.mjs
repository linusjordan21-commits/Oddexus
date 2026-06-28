/**
 * db-write.mjs — tunna Supabase-skrivare för worker-scripts (PostgREST + service key).
 * Ingen dependency. Kastar aldrig okontrollerat — returnerar {ok, status, error}.
 */

const URL_BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const TIMEOUT_MS = Number(process.env.ODDS_DB_TIMEOUT_MS) || 15000;

export function dbEnabled() {
  return Boolean(URL_BASE && KEY);
}

const headers = () => ({
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
});

async function call(path, body, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method: "POST",
      headers: { ...headers(), ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 409) {
      return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
    }
    // Returnera ev. JSON-body (RPC:er returnerar t.ex. counts); tyst om tom/minimal.
    let data;
    try {
      const txt = await res.text();
      if (txt) data = JSON.parse(txt);
    } catch {
      /* ingen/icke-JSON body — ok */
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Insert rader i en tabell (batch). return=minimal. */
export async function dbInsert(table, rows) {
  if (!dbEnabled() || !rows?.length) return { ok: true, status: 0 };
  return call(`/rest/v1/${table}`, rows, { Prefer: "return=minimal" });
}

/** Upsert (on_conflict) rader i en tabell (batch), merge-duplicates. */
export async function dbUpsert(table, rows, onConflict) {
  if (!dbEnabled() || !rows?.length) return { ok: true, status: 0 };
  return call(`/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, rows, {
    Prefer: "resolution=merge-duplicates,return=minimal",
  });
}

/**
 * PATCH (UPDATE) rader som matchar filter-querystring (t.ex. "signal_id=eq.X").
 * Använd för partiella uppdateringar av befintliga rader (upsert skulle kräva
 * alla NOT NULL-kolumner). return=minimal.
 */
export async function dbPatch(table, matchQs, patch) {
  if (!dbEnabled()) return { ok: true, status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${matchQs}`, {
      method: "PATCH",
      headers: { ...headers(), Prefer: "return=minimal" },
      body: JSON.stringify(patch),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Anropa en Postgres-funktion (rpc). */
export async function dbRpc(fn, args) {
  if (!dbEnabled()) return { ok: true, status: 0 };
  return call(`/rest/v1/rpc/${fn}`, args);
}

/** DELETE rader som matchar filter-querystring (t.ex. "updated_at=lt.<iso>"). return=minimal. */
export async function dbDelete(table, matchQs) {
  if (!dbEnabled() || !matchQs) return { ok: true, status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/${table}?${matchQs}`, {
      method: "DELETE",
      headers: { ...headers(), Prefer: "return=minimal" },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text().catch(() => "")).slice(0, 300) };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Läs ALLA rader ur en tabell (paginerat, 1000/sida) med valfri filter-querystring
 * (t.ex. "&observed_at=gte.2026-07-01"). Returnerar [] vid fel/saknad tabell.
 */
export async function dbSelectAll(table, filterQs = "", pageSize = 1000) {
  if (!dbEnabled()) return [];
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let page;
    try {
      const res = await fetch(`${URL_BASE}/rest/v1/${table}?select=*${filterQs}`, {
        headers: { ...headers(), Range: `${offset}-${offset + pageSize - 1}`, "Range-Unit": "items", Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return out; // tabell saknas / fel → returnera vad vi har
      page = await res.json();
    } catch {
      return out;
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
