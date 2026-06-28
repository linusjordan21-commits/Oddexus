/**
 * recon-atg-coolbet.mjs — ENGÅNGS-rekon (körs i GitHub Actions där internet är
 * öppet; vår sandlåda blockerar atg.se/coolbet.com via egress-allowlist).
 *
 * Mål: bekräfta ATG:s Kambi-offering-kod + upptäcka Coolbets sportsbook-API-form,
 * så vi kan bygga riktiga scrapers mot VERKLIG data (ingen gissning). Dumpar
 * status + trunkerad body för varje kandidat-URL till data/_recon-atg-coolbet.json
 * som committas av workflowen. INGA secrets behövs (publika feeds).
 */

import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_recon-atg-coolbet.json");
const HEAD = 4000; // hur mycket av varje body vi sparar

async function probe(label, url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const rec = { label, url, ok: false, status: 0, contentType: null, bodyLength: 0, bodyHead: null, error: null };
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json,text/html,*/*", "user-agent": UA, "accept-language": "sv-SE,sv;q=0.9,en;q=0.8", ...headers },
    });
    clearTimeout(timer);
    rec.status = r.status;
    rec.ok = r.ok;
    rec.contentType = r.headers.get("content-type");
    const body = await r.text();
    rec.bodyLength = body.length;
    rec.bodyHead = body.slice(0, HEAD);
  } catch (e) {
    clearTimeout(timer);
    rec.error = e?.message ?? String(e);
  }
  console.log(`[recon] ${label.padEnd(40)} ${rec.status || rec.error} (${rec.bodyLength}b)`);
  return rec;
}

// Extrahera /api/...-mönster + ev. API-bas ur HTML (för Coolbet-upptäckt).
function extractApiHints(html) {
  if (!html) return [];
  const hints = new Set();
  for (const m of html.matchAll(/["'`](\/api\/[a-zA-Z0-9/_\-.?=&{}]+)["'`]/g)) hints.add(m[1]);
  for (const m of html.matchAll(/https?:\/\/[a-zA-Z0-9.\-]+\/api\/[a-zA-Z0-9/_\-.]+/g)) hints.add(m[0]);
  for (const m of html.matchAll(/["'`](https?:\/\/[a-zA-Z0-9.\-]*(?:sb|sportsbook|odds|offering)[a-zA-Z0-9.\-/_]*)["'`]/gi)) hints.add(m[1]);
  return [...hints].slice(0, 60);
}

async function main() {
  const results = { ranAt: new Date().toISOString(), atg: {}, coolbet: {} };

  // ── ATG via Kambi ────────────────────────────────────────────────────
  // ATG Sport drivs av Kambi. Prova trolig offering-kod + host-varianter.
  const kambiHosts = [
    "https://eu-offering-api.kambicdn.com/offering/v2018",
    "https://e0-api.aws.kambicdn.com/offering/v2018",
  ];
  const atgOfferings = ["atg", "atgse", "atgsport", "atgse_se"];
  results.atg.listView = [];
  let atgEventId = null, atgOffering = null, atgHost = null;
  for (const host of kambiHosts) {
    for (const off of atgOfferings) {
      const url = `${host}/${off}/listView/football/all/all.json?lang=sv_SE&market=SE`;
      const rec = await probe(`atg listView ${off} @${host.includes("eu-") ? "eu" : "e0"}`, url, {
        referer: "https://www.atg.se/sport",
      });
      results.atg.listView.push(rec);
      if (rec.ok && !atgEventId) {
        try {
          const j = JSON.parse(rec.bodyHead.length >= HEAD ? "{}" : rec.bodyHead);
          const ev = j?.events?.[0]?.event;
          if (ev?.id) { atgEventId = ev.id; atgOffering = off; atgHost = host; }
        } catch { /* body trunkerad → hämta full nedan */ }
        if (!atgEventId) { atgOffering = off; atgHost = host; } // markera funnen offering ändå
      }
    }
  }
  // Om vi hittade en fungerande offering: hämta FULL listView + ett betoffer-detalj.
  if (atgOffering && atgHost) {
    const fullUrl = `${atgHost}/${atgOffering}/listView/football/all/all.json?lang=sv_SE&market=SE`;
    const full = await probe(`atg listView FULL ${atgOffering}`, fullUrl, { referer: "https://www.atg.se/sport" });
    // spara hela bodyn denna gång
    try {
      const r = await fetch(fullUrl, { headers: { accept: "application/json", "user-agent": UA } });
      const j = await r.json();
      const ev = j?.events?.[0]?.event;
      results.atg.firstEventSample = j?.events?.[0] ?? null;
      results.atg.eventsCount = Array.isArray(j?.events) ? j.events.length : 0;
      if (ev?.id) {
        const detUrl = `${atgHost}/${atgOffering}/betoffer/event/${ev.id}.json?lang=sv_SE&market=SE`;
        const det = await probe(`atg betoffer detail ${ev.id}`, detUrl, { referer: "https://www.atg.se/sport" });
        results.atg.detailSample = det;
      }
    } catch (e) { results.atg.fullError = e?.message ?? String(e); }
    results.atg.fullListView = full;
    results.atg.chosenOffering = atgOffering;
    results.atg.chosenHost = atgHost;
  }

  // ── Coolbet (in-house sportsbook) ────────────────────────────────────
  // Hämta odds-sidan + leta API-hintar, prova sen kandidat-endpoints.
  const page = await probe("coolbet odds page (html)", "https://www.coolbet.com/sv/odds/recommendations", {
    accept: "text/html,application/xhtml+xml",
  });
  results.coolbet.page = page;
  results.coolbet.apiHints = extractApiHints(page.bodyHead);

  const coolbetCandidates = [
    ["sports", "https://www.coolbet.com/api/sb/v2/sports?language=sv-SE&country=SE"],
    ["config", "https://www.coolbet.com/api/sb/v2/configs"],
    ["categories football", "https://www.coolbet.com/api/sb/v2/categories?language=sv-SE&country=SE"],
    ["matches", "https://www.coolbet.com/api/sb/v2/matches?language=sv-SE&country=SE&sport=soccer"],
    ["sportsbook-v1 sports", "https://www.coolbet.com/api/sb/v1/sports?language=sv-SE"],
    ["recommendations", "https://www.coolbet.com/api/sb/v2/recommendations?language=sv-SE&country=SE"],
  ];
  results.coolbet.candidates = [];
  for (const [lbl, url] of coolbetCandidates) {
    results.coolbet.candidates.push(await probe(`coolbet ${lbl}`, url, { referer: "https://www.coolbet.com/sv/odds" }));
  }

  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`[recon] skrev ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
