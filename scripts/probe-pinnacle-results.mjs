#!/usr/bin/env node
/**
 * PROBE: finns Pinnacle-resultat/slutställning i gäst-API:t?
 *
 * Avgör om "Pinnacle settled results"-vägen är hållbar (inkl. tennis) INNAN vi
 * bygger den. Skriver INGEN datafil — all output går till stdout (Action-loggen).
 *
 * Utforskar:
 *   1. /0.1/sports/{id}/matchups — vilka fält finns? Hur många isLive?
 *   2. Full struktur av ett par LIVE/nyligen spelade matchups (mest troligt att
 *      bära score/status), inkl. ALLA top-level-nycklar.
 *   3. /0.1/matchups/{id} — detalj-endpoint, finns score där?
 *   4. Kandidat-endpoints för resultat (status-koll).
 *
 * Körs via Mullvad-VPN (GitHub Azure-IP är Cloudflare-blockad mot Pinnacle).
 */

const BASE = "https://guest.api.arcadia.pinnacle.com";
const API_KEY = "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SPORTS = [
  { id: 33, tag: "tennis" },
  { id: 29, tag: "soccer" },
  { id: 4, tag: "basketball" },
];

async function get(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
  try {
    const r = await fetch(url, {
      headers: { "x-api-key": API_KEY, "User-Agent": UA, Accept: "application/json", Referer: "https://www.pinnacle.com/" },
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    const text = await r.text();
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: r.status, body };
  } catch (e) {
    return { status: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Plocka ut potentiellt resultat-relaterade fält ur ett matchup-objekt. */
function scoreyFields(obj, prefix = "") {
  const hits = [];
  if (!obj || typeof obj !== "object") return hits;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (/score|status|result|winner|live|period|final|settl|state|elapsed|outcome/i.test(k)) {
      hits.push(`${key}=${JSON.stringify(v)?.slice(0, 120)}`);
    }
    if (v && typeof v === "object" && prefix.split(".").length < 2) {
      hits.push(...scoreyFields(v, key));
    }
  }
  return hits;
}

async function main() {
  for (const sport of SPORTS) {
    console.log(`\n========== ${sport.tag.toUpperCase()} (sportId ${sport.id}) ==========`);
    const res = await get(`/0.1/sports/${sport.id}/matchups`);
    console.log(`matchups: HTTP ${res.status}`);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      console.log("  (inget array-svar — hoppar)", typeof res.body === "string" ? res.body : "");
      continue;
    }
    const all = res.body;
    const live = all.filter((m) => m && m.isLive);
    console.log(`  totalt ${all.length} matchups · ${live.length} isLive`);

    // Top-level-nycklar på ett godtyckligt matchup-objekt.
    const sample = all[0];
    if (sample) console.log(`  top-level-nycklar: ${Object.keys(sample).join(", ")}`);

    // Visa score-relaterade fält för upp till 3 LIVE matchups (mest troligt
    // att bära poäng/status). Faller tillbaka på vanliga om inga live.
    const candidates = (live.length > 0 ? live : all).slice(0, 3);
    for (const m of candidates) {
      const names = Array.isArray(m.participants) ? m.participants.map((p) => p?.name).join(" vs ") : "?";
      const hits = scoreyFields(m);
      console.log(`  ── matchup ${m.id} [${m.isLive ? "LIVE" : "prematch"}] ${names}`);
      console.log(`     score-fält: ${hits.length ? hits.join(" | ") : "(inga)"}`);
    }

    // Detalj-endpoint för första matchup:t — finns mer där?
    if (sample?.id) {
      const det = await get(`/0.1/matchups/${sample.id}`);
      console.log(`  /matchups/${sample.id}: HTTP ${det.status}`);
      if (det.status === 200 && det.body && typeof det.body === "object") {
        console.log(`     detalj-nycklar: ${Object.keys(det.body).join(", ")}`);
        const dh = scoreyFields(det.body);
        if (dh.length) console.log(`     detalj score-fält: ${dh.join(" | ")}`);
      }
    }
  }

  // Kandidat-endpoints för resultat (bara status — finns de över huvud taget?).
  console.log(`\n========== KANDIDAT RESULTAT-ENDPOINTS ==========`);
  const candPaths = [
    "/0.1/sports/33/matchups/live",
    "/0.1/sports/33/scores",
    "/0.1/scores/33",
    "/0.1/sports/33/results",
    "/0.1/sports/33/matchups?brandId=0&withSpecials=false",
    "/0.1/sports/settled",
    "/0.1/sports/33/settled",
  ];
  for (const p of candPaths) {
    const r = await get(p);
    const shape = Array.isArray(r.body) ? `array[${r.body.length}]` : typeof r.body;
    console.log(`  ${p} → HTTP ${r.status} (${shape})`);
  }
  console.log("\n[probe] klar.");
}

main().catch((e) => {
  console.error("[probe] fatal:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
