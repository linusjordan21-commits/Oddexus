/**
 * probe-coolbet-alts.mjs — letar ALTERNATIVA vägar till Coolbet-odds som INTE
 * sitter bakom samma Imperva-edge som www.coolbet.com. Plain fetch (snabb, ingen
 * browser) mot en bred lista kandidat-hosts/domäner/endpoints. För varje:
 * status, content-type, om Imperva-signatur finns, body-snutt. Dumpar till
 * data/_coolbet-alts.json. Svarar konkret på "finns det en annan väg?".
 */

import fs from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OUT = path.resolve(process.cwd(), "data", "_coolbet-alts.json");
const HEAD = 1200;

// Hosts att testa: app/sportsbook-backends + regionala domäner (Coolbet HQ = Estland).
const HOSTS = [
  "www.coolbet.com", "api.coolbet.com", "sb-api.coolbet.com", "sb.coolbet.com",
  "sportsbook.coolbet.com", "m.coolbet.com", "mobile.coolbet.com", "app.coolbet.com",
  "offering.coolbet.com", "eu-offering.coolbet.com", "cdn.coolbet.com", "static.coolbet.com",
  "www.coolbet.ee", "coolbet.ee", "api.coolbet.ee",
  "www.coolbet.eu", "api.coolbet.eu",
];

// Endpoint-paths (sportsbook-API-mönster) att prova per host.
const PATHS = [
  "/api/sb/v2/sports?language=sv-SE&country=SE",
  "/api/sb/v2/config",
  "/api/sb/v2/matches?sport=soccer",
  "/api/sb/v1/sports",
  "/sb/api/v2/sports",
  "/v2/sports",
  "/api/sportsbook/v1/sports",
  "/",
];

function impervaSig(body) {
  if (!body) return null;
  if (/Pardon Our Interruption/i.test(body)) return "pardon-interruption";
  if (/_Incapsula_Resource|Incapsula/i.test(body)) return "incapsula";
  if (/Request unsuccessful/i.test(body)) return "incapsula-unsuccessful";
  return null;
}

async function probe(host, p) {
  const url = `https://${host}${p}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const rec = { url, status: 0, ct: null, len: 0, imperva: null, json: false, snippet: null, error: null };
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json,text/html,*/*", "user-agent": UA, "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" },
    });
    clearTimeout(timer);
    rec.status = r.status;
    rec.ct = r.headers.get("content-type");
    const body = await r.text();
    rec.len = body.length;
    rec.imperva = impervaSig(body);
    rec.json = /json/i.test(rec.ct || "") && !rec.imperva;
    rec.snippet = body.slice(0, HEAD);
  } catch (e) {
    clearTimeout(timer);
    rec.error = e?.message ?? String(e);
  }
  return rec;
}

async function main() {
  const results = { ranAt: new Date().toISOString(), hostsAlive: {}, promising: [], all: [] };

  // Steg 1: är hosten överhuvudtaget upp? (HEAD/GET "/")
  for (const host of HOSTS) {
    const root = await probe(host, "/");
    results.hostsAlive[host] = { status: root.status, imperva: root.imperva, error: root.error, ct: root.ct };
    const alive = root.status > 0 && !root.error;
    console.log(`[alts] ${host.padEnd(28)} root=${root.status} imperva=${root.imperva || "-"} ${root.error || ""}`);
    if (!alive) continue;

    // Steg 2: prova API-paths bara på levande hosts.
    for (const p of PATHS) {
      if (p === "/") continue;
      const rec = await probe(host, p);
      results.all.push(rec);
      const promising = rec.json && rec.status >= 200 && rec.status < 500 && !rec.imperva && rec.len > 50;
      console.log(`[alts]   ${p.padEnd(42)} ${rec.status} json=${rec.json} imperva=${rec.imperva || "-"} len=${rec.len}`);
      if (promising) results.promising.push(rec);
    }
  }

  results.summary = {
    hostsProbed: HOSTS.length,
    hostsAlive: Object.values(results.hostsAlive).filter((h) => h.status > 0).length,
    hostsWithoutImperva: Object.entries(results.hostsAlive).filter(([, h]) => h.status > 0 && !h.imperva).map(([k]) => k),
    promisingCount: results.promising.length,
    promisingUrls: results.promising.map((r) => r.url),
  };

  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`[alts] KLART → ${results.promising.length} lovande endpoints, hosts utan Imperva: ${results.summary.hostsWithoutImperva.join(",") || "inga"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
