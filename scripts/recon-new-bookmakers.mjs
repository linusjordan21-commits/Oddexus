/**
 * recon-new-bookmakers.mjs — hitta exakta integrations-koder för nya sajter.
 *
 * Körs i GitHub Actions (GHA-runners når kambicdn + Altenar; vår lokala sandlåda
 * gör det inte). Provar kandidat-koder per brand och rapporterar vilka som ger
 * RIKTIG fotbollsdata → då vet vi den exakta offering/integration-koden att wira in.
 *
 *  - Kambi:   GET eu-offering-api.kambicdn.com/offering/v2018/{offering}/listView/football/all/all/all.json
 *             ?lang=sv_SE&market=SE  → events[] med betOffers (1X2). Bekräftar plattform + slug.
 *  - Altenar: GET sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming?integration={slug}&sportId=66…
 *             → events[] för fotboll. Bekräftar integration-slug.
 *
 * Output: data/_recon-new-bookmakers.json (rapport). Dispatch-only workflow.
 */

import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.cwd(), "data", "_recon-new-bookmakers.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Kandidat-offerings per Kambi-brand. Re-probe: bara de oklara (429-throttlade)
// brandsen + unibet-sanity. Bekräftade: expektse, betmgmse, megafortunese.
const KAMBI_CANDIDATES = {
  unibet: ["ubse"], // sanity-check (känd bra)
  leovegas: ["lvse", "leovegasse", "leovegascom", "leo", "leovegas"],
  "888sport": ["888se", "ott888se", "888sportse", "v888se", "888sweden", "888sport"],
  mrgreen: ["mrgreense", "mrgreen", "mgrse", "mrgreencom"],
};

// Altenar bekräftad (megafortunese) — ingen re-probe behövs.
const ALTENAR_CANDIDATES = {};

async function getJson(url, timeoutMs = 20000) {
  // Retry på 429 (rate-limit) med backoff — så vi skiljer "throttlad" från "ogiltig".
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": UA } });
      const text = await r.text();
      if (r.status === 429 && attempt < 4) { clearTimeout(t); await new Promise((res) => setTimeout(res, attempt * 3000)); continue; }
      let json = null;
      try { json = JSON.parse(text); } catch { /* */ }
      return { status: r.status, json, len: text.length };
    } catch (e) {
      if (attempt >= 4) return { status: 0, json: null, len: 0, err: String(e).slice(0, 120) };
    } finally { clearTimeout(t); }
  }
  return { status: 0, json: null, len: 0, err: "retries uttömda" };
}

async function probeKambi(offering) {
  const url = `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/listView/football/all/all/all.json?lang=sv_SE&market=SE`;
  const { status, json, err } = await getJson(url);
  const events = Array.isArray(json?.events) ? json.events : [];
  // räkna events med 1X2-betoffer
  let withOdds = 0;
  for (const ev of events) {
    const bos = ev?.betOffers || ev?.mainBetOffer ? [ev.mainBetOffer, ...(ev.betOffers || [])].filter(Boolean) : [];
    if (bos.some((b) => Array.isArray(b?.outcomes) && b.outcomes.length === 3)) withOdds += 1;
  }
  return { offering, status, events: events.length, withOdds, err: err || null };
}

async function probeAltenar(integration) {
  const url =
    "https://sb2frontend-altenar2.biahosted.com/api/widget/GetUpcoming?" +
    new URLSearchParams({
      culture: "sv-SE", timezoneOffset: "-120", integration, deviceType: "1",
      numFormat: "en-GB", countryCode: "SE", sportId: "66",
    }).toString();
  const { status, json, err } = await getJson(url);
  const events = Array.isArray(json?.events) ? json.events : [];
  return { integration, status, events: events.length, err: err || null };
}

async function main() {
  const report = { ranAt: new Date().toISOString(), kambi: {}, altenar: {} };

  for (const [brand, slugs] of Object.entries(KAMBI_CANDIDATES)) {
    report.kambi[brand] = [];
    for (const slug of slugs) {
      const r = await probeKambi(slug);
      report.kambi[brand].push(r);
      console.log(`[kambi] ${brand} ${slug} → http=${r.status} events=${r.events} 1x2=${r.withOdds}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  for (const [brand, slugs] of Object.entries(ALTENAR_CANDIDATES)) {
    report.altenar[brand] = [];
    for (const slug of slugs) {
      const r = await probeAltenar(slug);
      report.altenar[brand].push(r);
      console.log(`[altenar] ${brand} ${slug} → http=${r.status} events=${r.events}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  // Sammanfatta: bästa slug per brand (flest 1x2/events, http 200).
  report.verdicts = {};
  for (const [brand, rows] of Object.entries(report.kambi)) {
    const ok = rows.filter((x) => x.status === 200 && (x.withOdds > 0 || x.events > 0)).sort((a, b) => b.withOdds - a.withOdds || b.events - a.events)[0];
    report.verdicts[brand] = ok ? { platform: "kambi", code: ok.offering, events: ok.events, withOdds: ok.withOdds } : { platform: "kambi", code: null, note: "ingen kandidat gav data" };
  }
  for (const [brand, rows] of Object.entries(report.altenar)) {
    const ok = rows.filter((x) => x.status === 200 && x.events > 0).sort((a, b) => b.events - a.events)[0];
    report.verdicts[brand] = ok ? { platform: "altenar", code: ok.integration, events: ok.events } : { platform: "altenar", code: null, note: "ingen kandidat gav data" };
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log("[recon] klart →", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
