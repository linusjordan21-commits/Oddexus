#!/usr/bin/env node
/**
 * Enkel health-endpoint för VPS-scrapers. Svarar med ålder per data-fil så
 * UptimeRobot (eller liknande) kan larma när någon scraper hänger.
 *
 * Körs som systemd-service (odds-health.service) på port 3001.
 * Ingen externa dependencies — bara Node:s inbyggda http.
 *
 * Endpoints:
 *   GET /health      → JSON med ålder per källa + overall ok/degraded
 *   GET /health?pretty → samma men formaterat
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.HEALTH_PORT ?? 3001);
const DATA_DIR = path.resolve(process.cwd(), "data");
// "Senast bekräftad på GitHub"-stämplar (skrivs av run-scraper efter lyckad
// push). Detta är sanningskällan: speglar GitHub-verkligheten, inte bara att
// scrapern kört lokalt. /run rensas vid reboot → faller då tillbaka på filålder
// tills första pushen skapat stämpeln igen.
const PUSH_DIR = "/run/odds-push";

// Källa → max tillåten ålder (sekunder) innan "stale".
const SOURCES = {
  "pinnacle-rows.json": 300,        // 5 min
  "kambi-rows.json": 900,           // 15 min
  "betsson-rows.json": 900,
  "comeon-rows.json": 900,
  "paf-brand-rows.json": 1800,      // 30 min
  "altenar-rows.json": 1800,
  "vbet-rows.json": 1800,
  // [PAUSAD 2026-05-31] sportybet-ng / bet7 / bet9ja — Nigeria-bokisar, ej i valuebets
  // [BORTTAGEN] football-com-drops — ej en bookmaker, borttagen på användarfråga
  "bet365-rows.json": 900,          // 15 min (skrapas var 5:e via BetsAPI)
};

// Valfria källor: saknas datafilen helt (t.ex. bet365 utan BETSAPI_TOKEN) →
// hoppas tyst i stället för att flagga "degraded". Annars skulle en icke-
// konfigurerad valfri källa ge evig HTTP 503 + self-heal-loop.
const OPTIONAL = new Set(["bet365-rows.json"]);

function buildHealth() {
  const now = Date.now();
  const sources = {};
  let degraded = false;
  for (const [file, maxAgeSec] of Object.entries(SOURCES)) {
    // Mät push-stämpeln (GitHub-verklighet). Saknas den (t.ex. precis efter
    // reboot innan första pushen) → fall tillbaka på datafilens ålder.
    let mtimeMs = null;
    let basis = "push";
    try {
      mtimeMs = fs.statSync(path.join(PUSH_DIR, file)).mtimeMs;
    } catch {
      try {
        mtimeMs = fs.statSync(path.join(DATA_DIR, file)).mtimeMs;
        basis = "file-fallback";
      } catch {
        mtimeMs = null;
      }
    }
    if (mtimeMs == null) {
      // Valfri källa utan datafil = ej konfigurerad → hoppa (ingen degraded).
      if (OPTIONAL.has(file)) {
        sources[file] = { skipped: "not-configured" };
        continue;
      }
      degraded = true;
      sources[file] = { error: "missing", stale: true };
      continue;
    }
    const ageSec = Math.round((now - mtimeMs) / 1000);
    const stale = ageSec > maxAgeSec;
    if (stale) degraded = true;
    sources[file] = { ageSeconds: ageSec, maxAgeSeconds: maxAgeSec, stale, basis };
  }
  return { ok: !degraded, status: degraded ? "degraded" : "healthy", checkedAt: new Date().toISOString(), sources };
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  if (url !== "/health") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const health = buildHealth();
  const pretty = (req.url ?? "").includes("pretty");
  res.writeHead(health.ok ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health, null, pretty ? 2 : 0));
});

server.listen(PORT, () => {
  console.log(`[odds-health] lyssnar på :${PORT}/health`);
});
