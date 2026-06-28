#!/usr/bin/env node
/**
 * keepalive.mjs — håller HELA odds-flottan färsk med EN runner.
 *
 * Problem: GitHub:s `schedule` throttlas till ~2h på publika repos, så källor
 * som bara triggas av cron glider förbi sina färskhets-trösklar i steady-state.
 * Pinnacle + betsson har egna interna loopar; resten (kambi, altenar, vbet,
 * comeon, paf) gör inte det.
 *
 * Lösning: en kontinuerlig loop som var ~90:e sekund kollar varje källas ålder
 * och PROAKTIVT workflow_dispatch:ar den som närmar sig sin tröskel — INNAN den
 * blir stale. workflow_dispatch är det uttryckliga undantaget från GitHub:s
 * GITHUB_TOKEN-rekursionsspärr, så detta skapar riktiga runs.
 *
 * Smart & billig:
 *   - EN runner täcker alla källor (i stället för en loop per källa).
 *   - hasActiveRun-guard → dispatchar aldrig en källa som redan kör (så pinnacle/
 *     betsson med egna loopar hoppas automatiskt över, och vi dubblar aldrig).
 *   - Proaktiv tröskel (default 60% av staleAfter) → källan refreshas innan den
 *     ens hinner bli stale.
 *   - In-memory cooldown → ingen dispatch-storm medan en run startar.
 *
 * Körs i en ~5h-loop av keepalive.yml; schedule/push startar om den.
 */

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || ""; // "owner/repo"
const AUDIT_JSON = "data/_audit-sources.json";

const LOOP_MAX_MS = Number(process.env.KEEPALIVE_LOOP_MAX_MS) || 5 * 60 * 60 * 1000; // ~5h
const CHECK_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS) || 60_000; // 60s (mer responsiv ramp + render-ping)
const PROACTIVE_FRACTION = Number(process.env.KEEPALIVE_PROACTIVE_FRACTION) || 0.5; // dispatcha vid 50% av tröskeln (lead-time för körtiden)
const COOLDOWN_MS = Number(process.env.KEEPALIVE_COOLDOWN_MS) || 120_000; // 2 min per källa
const DRY_RUN = process.env.KEEPALIVE_DRY_RUN === "1";

// Render-webbtjänsten somnar efter ~15 min utan inbound-trafik (kallstart 30-60s
// = "sidan laddar inte"). Vi pingar dess publika health-endpoint varje varv
// (~90s) så den aldrig hinner somna. Tom/osatt RENDER_PING_URL → default-URL.
// Sätt repo-variabeln RENDER_PING_URL till "off" för att stänga av, eller till en
// annan URL om domänen skiljer sig.
const RENDER_PING_URL_RAW = (process.env.RENDER_PING_URL || "").trim();
const RENDER_PING_URL =
  RENDER_PING_URL_RAW === ""
    ? "https://matched-betting.onrender.com/api/autoclicker/health"
    : RENDER_PING_URL_RAW.toLowerCase() === "off"
      ? ""
      : RENDER_PING_URL_RAW;

// Källor med EGEN intern loop sköter sin egen färskhet — keepalive ska ALDRIG
// dispatcha dem (annars köar dispatch:ar bakom deras 5h-loop och cancellerar
// varandra; hasActiveRun har timing-glapp under den churn:en). Explicit skip är
// robustare än att lita på hasActiveRun för dessa.
const LOOP_SOURCES = new Set(
  (process.env.KEEPALIVE_SKIP || "pinnacle,betsson,comeon,vbet,smarkets").split(",").map((s) => s.trim()).filter(Boolean),
);

const log = (m) => console.log(`[keepalive] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(method, urlPath, body) {
  if (!TOKEN) throw new Error("GITHUB_TOKEN saknas");
  const res = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "linusgan-keepalive",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GitHub API ${method} ${urlPath} → ${res.status}: ${json?.message || text}`);
  return json;
}

// True om en run för workflow:n redan är queued eller in_progress (→ hoppa över;
// täcker även pinnacle/betsson som alltid kör sina egna loopar).
async function hasActiveRun(workflowFile) {
  try {
    const data = await gh(
      "GET",
      `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=10`,
    );
    return (data?.workflow_runs || []).some((r) => r.status === "queued" || r.status === "in_progress");
  } catch (e) {
    log(`⚠ kunde inte kolla aktiva runs för ${workflowFile}: ${e.message}`);
    return true; // vid osäkerhet: anta aktiv → dispatcha INTE (undvik dubbletter)
  }
}

// Hälsa för en workflow från de senaste körningarna: är någon aktiv, och hur
// många av de senast AVSLUTADE failade? Återanvänder ETT API-anrop (samma som
// hasActiveRun) så vi inte dubblar rate-limit-trafiken i ramp-loopen.
async function getWorkflowRunHealth(workflowFile) {
  try {
    const data = await gh(
      "GET",
      `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=10`,
    );
    const runs = data?.workflow_runs || [];
    const active = runs.some((r) => r.status === "queued" || r.status === "in_progress");
    const completed = runs.filter((r) => r.status === "completed").slice(0, 5);
    const recentFailures = completed.filter((r) => r.conclusion && r.conclusion !== "success").length;
    return { active, recentFailures, recentTotal: completed.length };
  } catch (e) {
    log(`⚠ kunde inte läsa run-hälsa för ${workflowFile}: ${e.message}`);
    // Osäkert → anta aktiv (skippa dispatch), ingen block-signal (rör inte rampen).
    return { active: true, recentFailures: 0, recentTotal: 0 };
  }
}

// Äldsta pågående (in_progress/queued) run för en workflow → {id, ageMs} eller null.
// Används av zombie-reapern: en loop-källa som är stale LÄNGE men har en run
// "in_progress" = lost runner som inte gör något → cancel:a den.
async function getActiveRunInfo(workflowFile) {
  try {
    const data = await gh(
      "GET",
      `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=10`,
    );
    const runs = (data?.workflow_runs || []).filter((r) => r.status === "in_progress" || r.status === "queued");
    if (runs.length === 0) return null;
    runs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const oldest = runs[0];
    return { id: oldest.id, ageMs: Date.now() - Date.parse(oldest.created_at), status: oldest.status };
  } catch {
    return null;
  }
}

async function cancelWorkflowRun(runId) {
  await gh("POST", `/repos/${REPO}/actions/runs/${runId}/cancel`);
}

async function dispatchWorkflow(workflowFile) {  if (DRY_RUN) {
    log(`[dry-run] skulle dispatcha ${workflowFile}`);
    return;
  }
  await gh("POST", `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, {
    ref: "main",
  });
}

// Själv-omstart: GitHubs schedule kan dröja TIMMAR med att starta nästa
// keepalive-pass på publika/throttlade repos → en lucka där varken scrapers
// eller Render-pingen körs. workflow_dispatch är undantaget från throttlingen
// och GITHUB_TOKEN-rekursionsspärren, så vi köar ett färskt pass själva precis
// innan detta avslutas → obruten bevakning dygnet runt.
const KEEPALIVE_WORKFLOW = process.env.KEEPALIVE_WORKFLOW || "keepalive.yml";
async function selfRedispatch() {
  // Detta är den ENDA länken som håller bevakningen igång dygnet runt (schedule
  // är throttlad till timmar på publika repos). Ett enda misslyckat anrop bryter
  // kedjan → Render slutar pingas → instansen somnar → "allt ligger nere".
  // Därför: retry med backoff i stället för att ge upp efter ett försök.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await dispatchWorkflow(KEEPALIVE_WORKFLOW);
      log(`↻ själv-omstart köad (${KEEPALIVE_WORKFLOW}, försök ${attempt}) — ingen lucka i bevakningen`);
      return;
    } catch (e) {
      log(`⚠ själv-omstart försök ${attempt}/6 misslyckades: ${e.message}`);
      if (attempt < 6) await sleep(attempt * 5000);
    }
  }
  log("⚠ KRITISKT: kunde inte själv-omstarta keepalive efter 6 försök — schedule/push får ta vid (lucka möjlig)");
}

// Hämta senaste committade data så audit:n mäter GitHub-verkligheten, inte en
// gammal lokal checkout. Rör bara tracked filer (untracked _audit-sources.json
// överlever reset).
function refreshFromRemote() {
  try {
    execFileSync("git", ["fetch", "origin", "main"], { stdio: "ignore" });
    execFileSync("git", ["reset", "--hard", "origin/main"], { stdio: "ignore" });
  } catch (e) {
    log(`⚠ git refresh-fel: ${e.message}`);
  }
}

function runAudit() {
  try {
    execFileSync("node", ["scripts/audit-source-freshness.mjs"], { stdio: "ignore" });
  } catch {
    /* exit 1 = stale-källor finns — förväntat */
  }
  return JSON.parse(fs.readFileSync(AUDIT_JSON, "utf8"));
}

/**
 * EXPERIMENT (2026-06-11): per-källa MÅL-CADENS i sekunder — hur tätt vi vill
 * hämta. Stegvis nedtrappning för att hitta varje sidas tolerans utan att
 * trigga bot-vakterna. Källor som saknas här får defaulten (50% av staleAfter
 * ≈ 15 min). Vid block-signaler (failade runs / 0 events / 403/429) → backa
 * den källan ett steg. Id:n = audit-registrets id:n (unibet = kambi).
 */
const PROACTIVE_TARGET_SEC = {
  unibet: 420, // öppet API, scrape ~1s — lågrisk
  altenar: 420, // öppet API — lågrisk
  "paf-brand": 900, // tyngre search-scrape (från ~30 min)
};

// =====================================================================
// FAS B2 — Adaptiv polling-ramp (säker, auto-backoff).
// =====================================================================
// Mål: trappa NER intervallen (hämta oftare) tills vi närmar oss varje källas
// block-gräns, och BACKA automatiskt vid minsta block-signal — så vi nuddar
// gränsen försiktigt i stället för att slå i den (en permanent ban dödar datan).
// Vi startar från de KONSERVATIVA värdena ovan och ramper ned mot ett per-källa-
// golv; öppna API:er får aggressivt golv, VPN/tunga sidor försiktigt.
// PÅ som default (2026-06-19, åter): staleness berodde på reaper-buggen (nu
// permanent AV), INTE på pollning. Rampen trappar ned intervallen, BACKAR
// automatiskt vid äkta block-signal, och committar varje källas uppmätta gräns
// till data/source-tolerance.json (syns i admin) = "exakt hur ofta vi kan polla".
// Stäng av med POLLING_RAMP_ENABLED=0 om du vill tillbaka till konservativa mål.
const RAMP_ON = process.env.POLLING_RAMP_ENABLED !== "0";
const RAMP_STATE_FILE = "data/_polling-state.json"; // untracked → överlever git reset i loopen
// Hårda golv = absolut snabbast vi tillåter (säkerhetsnät). Det INLÄRDA golvet
// (discoveredFloorSec) hamnar oftast högre — det är källans verkliga gräns. I
// praktiken begränsas takten ändå av workflow-körtiden (~60-120s) + tick-takten.
const RAMP_CONFIG = {
  unibet: { floorSec: 60, ceilSec: 600, step: 0.85 },        // kambi: 30s gav 4 backoffs → verklig gräns ~60s
  altenar: { floorSec: 30, ceilSec: 600, step: 0.85 },       // klarar 30s rent (0 backoffs) — snabbast
  "paf-brand": { floorSec: 240, ceilSec: 2400, step: 0.9 },  // tung search-scrape (upptäckt golv ~558s)
};
const RAMP_DEFAULT = { floorSec: 180, ceilSec: 1800, step: 0.9 };
const RAMP_BACKOFF = 1.4;                       // tillfällig återhämtnings-backoff vid block
const RAMP_EDGE_MARGIN = 1.05;                  // sitt 5% ovanför senaste friska takt = "precis på kanten"
const RAMP_HEALTHY_TICKS = 3;                   // friska kontroller i rad innan ett steg ned
const RAMP_BACKOFF_COOLDOWN_MS = 12 * 60_000;   // vila efter backoff innan vi ramper ned igen
// Re-probe: gränsen kan lossna (eller en blockering var transient). Efter lång
// frisk tid vid det inlärda golvet provar vi försiktigt lite snabbare igen, så
// vi inte fastnar onödigt konservativt efter en enstaka blockering.
const RAMP_REPROBE_AFTER_MS = 2 * 3600_000;     // 2h friskt vid golvet → prova snabbare
const RAMP_REPROBE_STEP = 0.95;                 // sänk inlärt golv 5% vid re-probe
const rampCfgFor = (id) => RAMP_CONFIG[id] ?? RAMP_DEFAULT;

// Människoläsbar tolerans-fil — COMMITTAS så du kan se varje källas gräns i
// admin (och i repot). Skrivs vid materiell ändring, debouncad.
const TOLERANCE_FILE = "data/source-tolerance.json";
let lastToleranceCommit = 0;
let lastToleranceSnapshot = "";

const rampState = new Map(); // id -> { targetSec, discoveredFloorSec, lastHealthyTargetSec, healthyStreak, backoffCount, lastBackoffAt, lastStatus, lastSeenAt }
/**
 * Seed:a ramp-minnet från den COMMITTADE tolerans-filen (data/source-tolerance.json)
 * när den untracked _polling-state.json saknas — t.ex. på en FÄRSK runner efter en
 * omstart. Utan detta nollställdes experimentet vid varje omstart (state-filen är
 * untracked → följer inte med i checkouten). Tolerans-filen är trackad, så en ny
 * runner kan återuppta från de redan inlärda golven i stället för konservativa start-
 * värden → mätningen konvergerar mycket snabbare.
 */
function seedRampFromToleranceFile() {
  try {
    if (!fs.existsSync(TOLERANCE_FILE)) return false;
    const obj = JSON.parse(fs.readFileSync(TOLERANCE_FILE, "utf8"));
    let seeded = 0;
    for (const [id, v] of Object.entries(obj.sources || {})) {
      if (!v || typeof v.currentIntervalSec !== "number") continue;
      // discoveredFloorSec seedas BARA om en backoff faktiskt skett (en VERKLIG
      // gräns hittades). Nådde källan bara det konfigurerade hårda golvet utan
      // block (backoffCount 0) var toleranceFloorSec = hård-golvet, inte en
      // upptäckt gräns — seedar vi det skulle en sänkning av hård-golvet inte
      // få effekt. Då lämnar vi discoveredFloorSec=0 så nya golvet styr.
      const realDiscovered =
        (v.backoffCount || 0) > 0 && typeof v.toleranceFloorSec === "number" ? v.toleranceFloorSec : 0;
      rampState.set(id, {
        targetSec: v.currentIntervalSec,
        discoveredFloorSec: realDiscovered,
        lastHealthyTargetSec: realDiscovered,
        backoffCount: typeof v.backoffCount === "number" ? v.backoffCount : 0,
        healthyStreak: 0,
        lastBackoffAt: v.lastBackoffAt ? Date.parse(v.lastBackoffAt) || 0 : 0,
        lastReprobeAt: 0,
        lastStatus: v.lastStatus || null,
        lastSeenAt: 0,
      });
      seeded++;
    }
    if (seeded > 0) log(`ramp-state seedad från tolerans-filen (${seeded} källor — inga inlärda golv tappade vid omstart)`);
    return seeded > 0;
  } catch {
    return false;
  }
}
function loadRampState() {
  try {
    if (!fs.existsSync(RAMP_STATE_FILE)) {
      // Untracked state saknas (färsk runner) → återuppta från den committade tolerans-filen.
      seedRampFromToleranceFile();
      return;
    }
    const obj = JSON.parse(fs.readFileSync(RAMP_STATE_FILE, "utf8"));
    for (const [id, v] of Object.entries(obj.sources || {})) {
      if (v && typeof v.targetSec === "number") {
        rampState.set(id, {
          targetSec: v.targetSec,
          discoveredFloorSec: typeof v.discoveredFloorSec === "number" ? v.discoveredFloorSec : 0,
          lastHealthyTargetSec: typeof v.lastHealthyTargetSec === "number" ? v.lastHealthyTargetSec : 0,
          backoffCount: typeof v.backoffCount === "number" ? v.backoffCount : 0,
          healthyStreak: 0,
          lastBackoffAt: typeof v.lastBackoffAt === "number" ? v.lastBackoffAt : 0,
          lastReprobeAt: typeof v.lastReprobeAt === "number" ? v.lastReprobeAt : 0,
          lastStatus: v.lastStatus || null,
          lastSeenAt: 0,
        });
      }
    }
    log(`ramp-state inläst (${rampState.size} källor)`);
  } catch { /* börja från konservativa startvärden */ }
}
function saveRampState() {
  try {
    const sources = {};
    for (const [id, s] of rampState) {
      sources[id] = {
        targetSec: s.targetSec,
        discoveredFloorSec: s.discoveredFloorSec || 0,
        lastHealthyTargetSec: s.lastHealthyTargetSec || 0,
        backoffCount: s.backoffCount || 0,
        lastBackoffAt: s.lastBackoffAt || 0,
        lastReprobeAt: s.lastReprobeAt || 0,
        lastStatus: s.lastStatus || null,
      };
    }
    fs.writeFileSync(RAMP_STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), sources }, null, 2));
  } catch { /* best-effort, observability bara */ }
}
function getRamp(id, startSec) {
  let s = rampState.get(id);
  if (!s) {
    s = { targetSec: startSec, discoveredFloorSec: 0, lastHealthyTargetSec: 0, healthyStreak: 0, backoffCount: 0, lastBackoffAt: 0, lastReprobeAt: 0, lastStatus: null, lastSeenAt: 0 };
    rampState.set(id, s);
  }
  return s;
}

/** Skriv + committa den människoläsbara tolerans-filen (debounced, conflict-free). */
function commitToleranceIfChanged() {
  const sources = {};
  for (const [id, s] of rampState) {
    const cfg = rampCfgFor(id);
    sources[id] = {
      currentIntervalSec: s.targetSec,
      // "Exakt tolerans" = finaste takt som hållit sig frisk (källans gräns).
      toleranceFloorSec: Math.max(cfg.floorSec, s.discoveredFloorSec || 0),
      hardFloorSec: cfg.floorSec,
      ceilingSec: cfg.ceilSec,
      backoffCount: s.backoffCount || 0,
      lastBackoffAt: s.lastBackoffAt ? new Date(s.lastBackoffAt).toISOString() : null,
      lastStatus: s.lastStatus || null,
    };
  }
  // Materiell ändring = intervall/tolerans/backoff-räknare ändrades.
  const snapshot = JSON.stringify(
    Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, `${v.currentIntervalSec}|${v.toleranceFloorSec}|${v.backoffCount}`])),
  );
  // HEARTBEAT: filen committas också om ≥5 min passerat även UTAN materiell ändring,
  // så `updatedAt` fungerar som keepalivens livstecken. watchdog.mjs reapar en hängd
  // keepalive om heartbeaten blir > ~13 min gammal (annars kunde en zombie-keepalive
  // ta ned hela LOOP-OMSTART-skyddsnätet i tysthet).
  const HEARTBEAT_MS = 5 * 60_000;
  const sinceLastCommit = Date.now() - lastToleranceCommit;
  const material = snapshot !== lastToleranceSnapshot;
  const heartbeatDue = lastToleranceCommit !== 0 && sinceLastCommit >= HEARTBEAT_MS;
  if (!material && !heartbeatDue) return;                 // inget nytt och ingen heartbeat förfallen
  if (material && sinceLastCommit < 60_000 && lastToleranceCommit !== 0) return; // committade precis — vänta
  lastToleranceSnapshot = snapshot;
  lastToleranceCommit = Date.now();
  try {
    fs.writeFileSync(TOLERANCE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), sources }, null, 2) + "\n");
    // Conflict-free publicering (reset-reapply) — samma mönster som pinnacle/watchdog.
    const fresh = fs.readFileSync(TOLERANCE_FILE, "utf8");
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        execFileSync("git", ["fetch", "origin", "main"], { stdio: "ignore" });
        execFileSync("git", ["reset", "--hard", "origin/main"], { stdio: "ignore" });
        fs.writeFileSync(TOLERANCE_FILE, fresh);
        execFileSync("git", ["add", TOLERANCE_FILE], { stdio: "ignore" });
        try { execFileSync("git", ["commit", "-m", `chore(keepalive): source polling tolerance ${new Date().toISOString()}`], { stdio: "ignore" }); }
        catch { return; } // inget att committa
        execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "ignore" });
        log("tolerans-fil committad (data/source-tolerance.json)");
        return;
      } catch {
        if (attempt < 4) continue;
      }
    }
  } catch (e) {
    log(`⚠ kunde inte committa tolerans-fil: ${e.message}`);
  }
}

const lastDispatch = new Map();

/** Pinga Render-webbtjänsten så den inte somnar (kallstart-skydd). */
async function pingRender() {
  if (!RENDER_PING_URL) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(RENDER_PING_URL, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": "linusgan-keepalive-render-ping" },
    });
    log(`render-ping → HTTP ${res.status}`);
  } catch (e) {
    log(`⚠ render-ping misslyckades: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loop-källornas omstarts-skydd: deras 5h-pass tar slut och GitHubs throttlade
 * schedule kan dröja TIMMAR med att starta nästa (observerat: betsson tyst
 * 2h+ 2026-06-11). Cooldown längre än vanliga källors eftersom ett nystartat
 * pass behöver setup-tid innan första datan landar.
 *
 * 20 min (2026-06-11): höjt från 10. VBET är den långsammaste loop-källan —
 * dispatch→första-commit mättes till ~11-20 min (npm install + WireGuard-setup
 * ~8 min + swarm-scrape ~3 min + ibland trög git-push). Med 10-min-cooldown
 * hann keepalive flagga vbet som "död" och starta om den INNAN ett färskt pass
 * ens hunnit committa → omstart-spiral. Varje omstart öppnar dessutom nya
 * swarm-WS-anslutningar från den delade Mullvad-relay-IP:n, vilket triggar
 * VBET:s Cloudflare-WAF hårdare (ond cirkel: fler omstarter → mer block → färre
 * events → snabbare stale → fler omstarter). 20 min > vbets kallstart-till-
 * commit, så ett omstartat pass får committa innan vi ens överväger nästa
 * omstart. hasActiveRun-guarden skyddar fortfarande ett levande pass oavsett.
 */
const LOOP_RESTART_COOLDOWN_MS = Number(process.env.KEEPALIVE_LOOP_COOLDOWN_MS) || 20 * 60_000;
// Zombie-reaper: en loop-källa som är stale ≥ detta MEN har en "in_progress"-run
// = lost runner som håller concurrency-slotten utan att leverera → cancel:as.
// 45 min: VBET är den långsammaste loopen och pushar till origin var ~13-17 min
// (under push-konkurrens med 11 andra committers kan en enskild push dröja).
// Tidigare 25 min reapade en FRISK-men-långsam vbet precis innan dess push →
// commiten (som syntes lokalt i runnern) nådde aldrig origin → källan såg stale
// ut → reapern dödade nästa run också (självförevigande). 45 min ligger klart
// över vbets värsta push-intervall men fångar fortfarande äkta fleratimmars-
// zombies (t.ex. den 7,5h smarkets-runnern som höll slotten).
const LOOP_ZOMBIE_REAP_SEC = Number(process.env.KEEPALIVE_ZOMBIE_REAP_SEC) || 45 * 60;
// 45 min run-ålder: en frisk loop hinner pusha minst en gång inom så lång tid;
// bara en genuint hängd runner når hit utan att leverera till origin.
const LOOP_ZOMBIE_RUN_AGE_MS = Number(process.env.KEEPALIVE_ZOMBIE_RUN_AGE_MS) || 45 * 60_000;
// PER-KÄLLA reap-tröskel (sek) — efter varje loops NORMALTAKT, inte en platt 45 min.
// En fastnad run (in_progress men committar inte) startas om när BÅDE datan är stale
// OCH runnen kört längre än källans tröskel. pinnacle committar var ~2 min → 10 min
// stale = garanterat fastnad; vbet committar var ~15 min med långsam kallstart →
// behöver hög tröskel för att inte reapa en frisk-men-långsam run. Platt 45 min lät
// pinnacle (kritisk, 3-min-gate) ligga stale upp till 45 min innan omstart.
const LOOP_REAP_STALE_SEC = {
  pinnacle: 600,   // ~10 min (takt ~2 min)
  smarkets: 900,   // ~15 min (takt ~6 min)
  betsson: 1200,   // ~20 min (takt ~10 min)
  comeon: 2100,    // ~35 min (takt ~15 min — långsammast)
  vbet: 2400,      // ~40 min (takt ~15 min + långsam kallstart)
};
const reapStaleSecFor = (id) => LOOP_REAP_STALE_SEC[id] ?? LOOP_ZOMBIE_REAP_SEC;
// PÅ med säkra trösklar (stäng av med KEEPALIVE_ZOMBIE_REAPER=0). Fångar hängda
// loopar utan att svälta friska — den tidigare stormen var en TRÖSKEL-bugg.
const ZOMBIE_REAPER_ON = process.env.KEEPALIVE_ZOMBIE_REAPER !== "0";

async function tick() {
  refreshFromRemote();
  const audit = runAudit();
  let dispatched = 0;
  let watched = 0;
  // Syskonbrands (t.ex. betsson/bethard/spelklubben, comeon/hajper/snabbare) delar
  // SAMMA workflow-fil och samma datafärskhet. Cooldown/active-run-guarderna nedan
  // är nycklade per brand-id, och GitHubs API har propageringslag (en just köad run
  // syns inte direkt) → utan detta dispatchas EN workflow-fil en gång PER stale
  // syskonbrand i samma tick (5 dispatch:ar av comeon-fetch på sekunder → de avbryter
  // varandra → källan committar aldrig → stale). Denna per-tick-dedupe på workflow-fil
  // garanterar max EN dispatch per fil och tick, oavsett hur många syskon som är stale.
  const dispatchedWorkflowsThisTick = new Set();
  for (const r of audit.rows || []) {
    if (!r.manualDispatch || !r.workflow) continue; // bara dispatch:bara källor
    if (dispatchedWorkflowsThisTick.has(r.workflow)) continue; // syskonbrand delar fil → redan hanterad denna tick
    if (LOOP_SOURCES.has(r.id)) {
      // Loop-källor (pinnacle/betsson/comeon/vbet) sköter sin egen cadens — MEN
      // om passet dött (ingen aktiv run) och källan blivit STALE startar vi om
      // dess workflow. Täpper luckan när schedule-throttlingen lämnar källan
      // utan pass i timmar. Lever passet rörs ingenting (ingen churn).
      if (typeof r.ageSec !== "number" || typeof r.staleAfterSec !== "number") continue;
      if (r.ageSec < r.staleAfterSec) continue; // inom normal drift → rör ej
      const active = await getActiveRunInfo(r.workflow);
      if (active) {
        // ZOMBIE-REAPER — PÅ med SÄKRA trösklar. En run avbryts BARA om BÅDA:
        //   1) datan är stale > LOOP_ZOMBIE_REAP_SEC (25 min — ÖVER varje loops
        //      commit-cadens, comeon längst ~15 min → en FRISK loop kan aldrig
        //      råka reapas), OCH
        //   2) den körande runnen själv kört > LOOP_ZOMBIE_RUN_AGE_MS (20 min —
        //      över comeons ~15 min till första commit → en färsk/långsam-startande
        //      run reapas inte).
        // Detta fångar en HÄNGD loop (committat en gång sen död) UTAN att skapa
        // dispatch-storm. (Den tidigare stormen kom av 10-min utan run-ålderskrav.)
        if (
          ZOMBIE_REAPER_ON &&
          r.ageSec >= reapStaleSecFor(r.id) &&
          active.status === "in_progress" &&
          active.ageMs >= reapStaleSecFor(r.id) * 1000
        ) {
          try {
            await cancelWorkflowRun(active.id);
            await dispatchWorkflow(r.workflow); // köa en färsk om ingen efterföljare fanns
            lastDispatch.set(r.id, Date.now());
            dispatchedWorkflowsThisTick.add(r.workflow);
            dispatched++;
            log(`☠ ZOMBIE-REAP ${r.workflow} (${r.id}: run ${active.id} in_progress ${Math.round(active.ageMs / 60000)}min, data ${Math.round(r.ageSec / 60)}min stale → avbruten, ny köad)`);
          } catch (e) {
            log(`⚠ zombie-reap-fel ${r.workflow}: ${e.message}`);
          }
        }
        continue; // annars: en run pågår → rör den ALDRIG (concurrency:false låter den committa)
      }
      const sinceLoop = Date.now() - (lastDispatch.get(r.id) || 0);
      if (sinceLoop < LOOP_RESTART_COOLDOWN_MS) continue; // nystartat pass behöver tid
      try {
        await dispatchWorkflow(r.workflow);
        lastDispatch.set(r.id, Date.now());
        dispatchedWorkflowsThisTick.add(r.workflow);
        dispatched++;
        log(`⟳ LOOP-OMSTART ${r.workflow} (${r.id}: ${r.ageSec}s stale > ${r.staleAfterSec}s, inget aktivt pass)`);
      } catch (e) {
        log(`⚠ loop-omstart-fel ${r.workflow}: ${e.message}`);
      }
      continue;
    }
    if (typeof r.ageSec !== "number" || typeof r.staleAfterSec !== "number") continue;
    watched++;

    // Konservativt STARTvärde (samma som förr) — rampen trappar ned därifrån.
    const startSec = PROACTIVE_TARGET_SEC[r.id] ?? r.staleAfterSec * PROACTIVE_FRACTION;
    let proactiveSec = startSec;

    if (RAMP_ON) {
      const cfg = rampCfgFor(r.id);
      const ramp = getRamp(r.id, startSec);
      // Inlärt golv = den finaste takt som hållit sig FRISK (källans verkliga
      // tolerans). Vi går ALDRIG under det igen → rampen konvergerar i stället
      // för att gång på gång trycka källan stale.
      const effectiveFloor = Math.max(cfg.floorSec, ramp.discoveredFloorSec || 0);
      ramp.targetSec = Math.max(effectiveFloor, Math.min(cfg.ceilSec, ramp.targetSec));
      ramp.lastSeenAt = Date.now();

      const status = String(r.status || "").toUpperCase();
      ramp.lastStatus = status;
      const rh = await getWorkflowRunHealth(r.workflow);
      const blockedByStatus = ["EMPTY", "ERROR", "BLOCKED"].includes(status) || r.partial === true;
      const blockedByRuns = rh.recentTotal >= 3 && rh.recentFailures >= Math.ceil(rh.recentTotal * 0.6);
      // Skilj RATE-LIMIT (block) från RUNTIME-TAK (workflowen hinner bara inte snabbare):
      const dispatchedRecently = Date.now() - (lastDispatch.get(r.id) || 0) < 10 * 60_000;
      const staleDespiteDispatch = status === "STALE" && r.ageSec > r.staleAfterSec && dispatchedRecently;
      // blockedByStale = rate-limit: stale TROTS nyligt dispatch OCH körningar failar →
      //   våra anrop ger inte färsk data → backa (sitt på gränsen).
      const blockedByStale = staleDespiteDispatch && rh.recentFailures > 0;
      // runtimeCeiling = stale TROTS dispatch MEN körningarna LYCKAS → workflow-körtiden
      //   är helt enkelt längre än målet (t.ex. kambi ~5 min). Det är INTE ett block — att
      //   backa gav falska, uppblåsta tolerenser (kambi → 17 min). Lär in körtiden som golv
      //   utan straff-backoff i stället, så panelen visar den verkligt uppnåbara takten.
      const runtimeCeiling = staleDespiteDispatch && rh.recentFailures === 0 && !blockedByStatus && !blockedByRuns;
      const healthy = status === "FRESH" && r.partial !== true && rh.recentFailures === 0;

      if (blockedByStatus || blockedByRuns || blockedByStale) {
        // Nuvarande takt var FÖR aggressiv. Toleransen = strax ovanför den senast
        // BEVISAT-friska takten (liten kant-marginal) = "precis på gränsen".
        const provenGood = ramp.lastHealthyTargetSec || Math.round(ramp.targetSec * RAMP_BACKOFF);
        const tolerance = Math.max(cfg.floorSec, Math.round(provenGood * RAMP_EDGE_MARGIN));
        ramp.discoveredFloorSec = tolerance; // får både höjas och (via re-probe) sänkas
        const before = ramp.targetSec;
        // Tillfällig extra backoff så ev. straff-läge hinner släppa; ramper sedan
        // tillbaka NED till tolerans-golvet (sitter kvar precis på kanten).
        ramp.targetSec = Math.min(cfg.ceilSec, Math.max(tolerance, Math.round(ramp.targetSec * RAMP_BACKOFF)));
        ramp.backoffCount = (ramp.backoffCount || 0) + 1;
        ramp.healthyStreak = 0;
        ramp.lastBackoffAt = Date.now();
        ramp.lastReprobeAt = Date.now();
        log(`⤴ BACKOFF ${r.id}: ${before}s → ${ramp.targetSec}s (status=${status}, fails=${rh.recentFailures}/${rh.recentTotal}) — tolerans ≈ ${tolerance}s`);
      } else if (runtimeCeiling) {
        // Workflow-körtiden är golvet, inte rate-limit. Höj golvet gradvis mot den
        // verkligt uppnåbara takten (data-åldern), men max 1.5× per tick så en
        // tillfällig spik inte blåser upp värdet. INGEN backoffCount/overshoot.
        const reach = Math.max(cfg.floorSec, Math.min(Math.round(r.ageSec || ramp.targetSec), Math.round(ramp.targetSec * 1.5)));
        const before = ramp.targetSec;
        if (reach > (ramp.discoveredFloorSec || 0)) ramp.discoveredFloorSec = reach;
        ramp.targetSec = Math.min(cfg.ceilSec, Math.max(ramp.targetSec, reach));
        ramp.healthyStreak = 0;
        if (ramp.targetSec !== before) log(`⏱ RUNTIME-TAK ${r.id}: ${before}s → ${ramp.targetSec}s (körningar lyckas men hinner ej snabbare — golv lärt, ingen backoff)`);
      } else if (healthy) {
        ramp.lastHealthyTargetSec = ramp.targetSec; // denna takt är bevisat OK
        ramp.healthyStreak = (ramp.healthyStreak || 0) + 1;
        let effFloor = Math.max(cfg.floorSec, ramp.discoveredFloorSec || 0);
        // RE-PROBE: efter lång frisk tid vid det inlärda golvet → prova lite
        // snabbare (gränsen kan ha lossnat / blockeringen var transient).
        const sinceEdge = Date.now() - Math.max(ramp.lastBackoffAt || 0, ramp.lastReprobeAt || 0);
        if (ramp.targetSec <= effFloor && effFloor > cfg.floorSec && sinceEdge > RAMP_REPROBE_AFTER_MS) {
          ramp.discoveredFloorSec = Math.max(cfg.floorSec, Math.round(effFloor * RAMP_REPROBE_STEP));
          ramp.lastReprobeAt = Date.now();
          effFloor = Math.max(cfg.floorSec, ramp.discoveredFloorSec);
          log(`🔬 re-probe ${r.id}: provar snabbare, golv ${effFloor}s`);
        }
        if (
          ramp.healthyStreak >= RAMP_HEALTHY_TICKS &&
          Date.now() - (ramp.lastBackoffAt || 0) > RAMP_BACKOFF_COOLDOWN_MS &&
          ramp.targetSec > effFloor
        ) {
          const before = ramp.targetSec;
          ramp.targetSec = Math.max(effFloor, Math.round(ramp.targetSec * cfg.step));
          ramp.healthyStreak = 0;
          if (ramp.targetSec !== before) log(`⤵ ramp-ned ${r.id}: ${before}s → ${ramp.targetSec}s (friskt, golv ${effFloor}s)`);
        }
      }
      proactiveSec = ramp.targetSec;

      if (r.ageSec < proactiveSec) continue; // fortfarande färsk nog
      const since = Date.now() - (lastDispatch.get(r.id) || 0);
      // Cooldown följer målet (men aldrig under 60s) så aggressiva golv inte blockeras.
      const cooldown = Math.max(60_000, Math.min(COOLDOWN_MS, proactiveSec * 1000));
      if (since < cooldown) continue;
      if (rh.active) continue; // kör redan
      try {
        await dispatchWorkflow(r.workflow);
        lastDispatch.set(r.id, Date.now());
        dispatchedWorkflowsThisTick.add(r.workflow);
        dispatched++;
        log(`↻ dispatch ${r.workflow} (${r.id}: ${r.ageSec}s > mål ${Math.round(proactiveSec)}s [tolerans-golv ${effectiveFloor}s])`);
      } catch (e) {
        log(`⚠ dispatch-fel ${r.workflow}: ${e.message}`);
      }
      continue;
    }

    // Ramp av → gamla statiska beteendet.
    if (r.ageSec < proactiveSec) continue;
    const since = Date.now() - (lastDispatch.get(r.id) || 0);
    if (since < COOLDOWN_MS) continue;
    if (await hasActiveRun(r.workflow)) continue;
    try {
      await dispatchWorkflow(r.workflow);
      lastDispatch.set(r.id, Date.now());
      dispatchedWorkflowsThisTick.add(r.workflow);
      dispatched++;
      log(`↻ proaktiv dispatch ${r.workflow} (${r.id}: ${r.ageSec}s > ${Math.round(proactiveSec)}s av ${r.staleAfterSec}s)`);
    } catch (e) {
      log(`⚠ dispatch-fel ${r.workflow}: ${e.message}`);
    }
  }
  if (RAMP_ON) {
    saveRampState();
    commitToleranceIfChanged();
    const summary = [...rampState.entries()]
      .map(([id, s]) => `${id}=${s.targetSec}s${s.discoveredFloorSec ? `(tol≥${s.discoveredFloorSec})` : ""}`)
      .join(" ");
    if (summary) log(`ramp-mål: ${summary}`);
  }
  if (dispatched > 0) log(`tick klar: ${dispatched} dispatchade (${watched} dispatch:bara källor bevakade)`);
}

(async () => {
  if (!TOKEN || !REPO) {
    log("GITHUB_TOKEN/GITHUB_REPOSITORY saknas — avslutar");
    process.exit(1);
  }
  const start = Date.now();
  log(
    `start — proaktiv dispatch vid ${Math.round(PROACTIVE_FRACTION * 100)}% av staleAfter, ` +
      `intervall ${CHECK_INTERVAL_MS / 1000}s, cooldown ${COOLDOWN_MS / 1000}s, loop ~${(LOOP_MAX_MS / 3600000).toFixed(1)}h`,
  );
  if (RENDER_PING_URL) {
    log(`render keep-alive på: ${RENDER_PING_URL} (varje ~${CHECK_INTERVAL_MS / 1000}s)`);
    if (RENDER_PING_URL_RAW === "") {
      log(
        "⚠ RENDER_PING_URL är inte satt → använder default (matched-betting.onrender.com). " +
          "Sätt repo-variabeln RENDER_PING_URL till din RIKTIGA Render-origin " +
          "(https://<tjänst>.onrender.com/api/autoclicker/health) så att rätt instans hålls vaken. " +
          "Pinga origin-URL:en (.onrender.com), inte custom-domänen, så den når Render direkt.",
      );
    }
  } else {
    log("⚠ render keep-alive AVSTÄNGD (RENDER_PING_URL=off) → instansen kan somna när du är inaktiv.");
  }
  if (RAMP_ON) {
    loadRampState();
    log("polling-ramp PÅ — trappar ned mot per-källa-golv med auto-backoff vid block-signaler (stäng av: POLLING_RAMP_ENABLED=0).");
  } else {
    log("polling-ramp AV (POLLING_RAMP_ENABLED=0) — statiska mål.");
  }
  await pingRender(); // väck direkt vid start
  // Säkerhetsmarginal: köa efterföljaren ~10 min INNAN budgeten tar slut. Då
  // finns redan ett köat pass även om den slutgiltiga själv-omstarten skulle
  // missa (runner-preemption, GitHub-incident, timeout). Concurrency-gruppen
  // hindrar överlapp → det köade passet tar vid när detta avslutas.
  let successorQueued = false;
  let tickCount = 0;
  while (Date.now() - start < LOOP_MAX_MS) {
    try {
      await tick();
    } catch (e) {
      log(`tick-fel: ${e.message}`);
    }
    await pingRender();
    tickCount++;
    // BULLETPROOF: köa efterföljaren TIDIGT (efter 2 tick ≈ 3 min), inte bara nära
    // budgetslut. Keepalive är HELA flottans dispatcher → kraschar den mitt i loopen
    // (runner-preemption/GitHub-incident) fanns det förut inget köat pass, så allt
    // drev stale tills den throttlade cronen (~2h) råkade starta om den. Med ett
    // PENDING-pass redan från start tar efterföljaren omedelbart över oavsett när vi
    // dör. Concurrency cancel-in-progress:false håller det pending (pinnacle-mönstret).
    if (!successorQueued && tickCount >= 2) {
      successorQueued = true;
      log("↻ köar efterföljaren tidigt (≈3 min in) — överlever mid-run-krasch.");
      await selfRedispatch();
    }
    await sleep(CHECK_INTERVAL_MS);
  }
  // Om marginalen inte hann köa (kort budget) → köa nu.
  if (!successorQueued) await selfRedispatch();
  log("loop-budget nådd — avslutar rent (själv-omstart köad).");
})();
