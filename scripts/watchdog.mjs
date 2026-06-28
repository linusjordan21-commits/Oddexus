#!/usr/bin/env node
/**
 * Source watchdog — self-healing freshness monitor.
 *
 * Körs av .github/workflows/watchdog.yml var ~5:e minut. Syfte: ingen källa
 * ska kunna dö i tysthet (jfr ComeOn/VBET som låg stale i 3 dygn innan någon
 * märkte det manuellt).
 *
 * Pipeline:
 *   1. Kör audit-source-freshness.mjs → skriver data/_audit-sources.json
 *      (per källa: status, ageSec, workflow, manualDispatch, staleAfterSec...).
 *   2. För varje källa som behöver uppmärksamhet (STALE/EMPTY/MISSING/NO_DATE/
 *      ERROR) → dispatch:a källans fetch-workflow via Actions-API:t, SÅVIDA
 *      inte en run redan är queued/in_progress (undvik pileup).
 *   3. Underhåll data/source-health.json (consecutiveStale, lastHealthyAt,
 *      dispatchCount, issueNumber per källa).
 *   4. Eskalering: om en källa är stale ESCALATE_AFTER kontroller i rad →
 *      öppna ett GitHub-issue. När källan återhämtar sig → stäng issuet.
 *   5. Committa source-health.json — men BARA när något materiellt ändrats
 *      (status-övergång, dispatch, eskalering) så vi inte spammar git-historik
 *      med en heartbeat-commit var 5:e minut.
 *
 * Env (sätts av GitHub Actions):
 *   GITHUB_TOKEN       — för Actions-dispatch + issues (permissions i yml)
 *   GITHUB_REPOSITORY  — "owner/repo"
 *   WATCHDOG_DRY_RUN   — "1" → logga vad som skulle hända, ingen API-write
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const AUDIT_JSON = path.join(DATA_DIR, "_audit-sources.json");
const HEALTH_JSON = path.join(DATA_DIR, "source-health.json");

const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || ""; // "owner/repo"
const DRY_RUN = process.env.WATCHDOG_DRY_RUN === "1";
// MONITOR-ONLY som default (2026-06-19): watchdogen ska BARA auditera + föra
// hälsobok + öppna/stänga issues. DISPATCH är keepalivens ENDA ansvar — att låta
// båda dispatcha samma källor (utan delad cooldown) skapade kollisioner/churn.
// Sätt WATCHDOG_DISPATCH=1 om du nån gång vill att watchdogen också ska dispatcha.
const WATCHDOG_DISPATCH_ON = process.env.WATCHDOG_DISPATCH === "1";

// Status som betyder "källan behöver hjälp och en omstart kan lösa det".
// BLOCKED/NOT_CONFIGURED är kända lägen som auto-dispatch inte fixar — de
// eskaleras till issue men dispatch:as inte (kräver människa: secret/IP/conf).
const DISPATCHABLE = new Set(["STALE", "EMPTY", "MISSING", "NO_DATE", "ERROR"]);
const ATTENTION = new Set([...DISPATCHABLE, "BLOCKED", "NOT_CONFIGURED"]);

// Hur många kontroller i rad en källa får vara i attention-läge innan vi
// öppnar ett issue. Med */5 cron ≈ 15 min innan eskalering (men dispatch
// sker direkt vid första kontrollen).
const ESCALATE_AFTER = 3;

// Minsta tid mellan auto-dispatchar av SAMMA källa. Utan detta hamrar watchdogen
// (som körs var 5:e min) en långsam källa var 5:e min — t.ex. Betsson (~4-5 min/
// run + runner-kö-latens). I GitHubs kö hinner då nya dispatchar superseda de
// gamla innan de startar, så körningarna avbryts som "pending" och källan blir
// ALDRIG färsk (en självgående storm). 15 min ger en körning tid att slutföra.
const DISPATCH_COOLDOWN_MS = 15 * 60 * 1000;

const ISSUE_LABEL = "source-stale";

// ── KEEPALIVE-ZOMBIE-REAPER ────────────────────────────────────────────────
// Keepalive (keepalive.yml) är flottans dispatcher + LOOP-OMSTART-skyddsnät. Om
// dess runner HÄNGER SIG (lost runner, in_progress men gör inget) faller hela
// nätet: ingenting håller källorna färska eller startar om stale loop-källor,
// och keepalivens egen efterföljare sitter fast PENDING bakom zombien
// (cancel-in-progress:false). Watchdog kör oberoende var 5:e min (kort run, ingen
// egen zombie-risk) och är därför rätt plats att reapa en hängd keepalive.
// Signal: keepalive committar data/source-tolerance.json som heartbeat var ~5 min.
// Är heartbeaten > STALE gammal OCH en keepalive-run är in_progress = zombie.
const KEEPALIVE_WORKFLOW = "keepalive.yml";
const KEEPALIVE_HEARTBEAT_FILE = path.join(DATA_DIR, "source-tolerance.json");
const KEEPALIVE_HEARTBEAT_STALE_MS = 13 * 60 * 1000; // > 2 missade heartbeats (5 min) + marginal

function log(...a) {
  console.log(...a);
}

/**
 * Render keep-awake — REDUNDANT path utöver keepalive.yml.
 * Hela bakgrundsflottan hängde tidigare på EN workflow (keepalive). Dog den över
 * natten slutade Render pingas → instansen somnade → kallstart + sega sidor på
 * morgonen. Watchdogen kör var ~5:e min (< Renders 15-min sömngräns), så att
 * pinga härifrån också ger en oberoende livlina: instansen somnar bara om BÅDE
 * keepalive OCH watchdog är nere samtidigt. Tyst no-op om RENDER_PING_URL=off.
 */
async function pingRenderKeepAwake() {
  const raw = (process.env.RENDER_PING_URL || "").trim();
  const url =
    raw === ""
      ? "https://matched-betting.onrender.com/api/autoclicker/health"
      : raw.toLowerCase() === "off"
        ? ""
        : raw;
  if (!url) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": "linusgan-watchdog-render-ping" },
    });
    log(`[watchdog] render keep-awake ping → HTTP ${res.status}`);
  } catch (e) {
    log(`[watchdog] ⚠ render keep-awake ping misslyckades: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function runAudit() {
  // audit-scriptet exit:ar 1 när något är stale — det är förväntat, inte ett
  // fel för oss. Vi bryr oss bara om att _audit-sources.json skrivs.
  try {
    execFileSync("node", ["scripts/audit-source-freshness.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    /* exit 1 = stale-källor finns, det är hela poängen */
  }
  if (!fs.existsSync(AUDIT_JSON)) {
    throw new Error(`Audit producerade ingen ${AUDIT_JSON}`);
  }
  return JSON.parse(fs.readFileSync(AUDIT_JSON, "utf8"));
}

function loadHealth() {
  if (!fs.existsSync(HEALTH_JSON)) return { sources: {} };
  try {
    return JSON.parse(fs.readFileSync(HEALTH_JSON, "utf8"));
  } catch {
    return { sources: {} };
  }
}

async function gh(method, urlPath, body) {
  if (!TOKEN) throw new Error("GITHUB_TOKEN saknas");
  const res = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "linusgan-watchdog",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.message || text || res.statusText;
    throw new Error(`GitHub API ${method} ${urlPath} → ${res.status}: ${msg}`);
  }
  return json;
}

// Returnerar true om en run för workflow:n redan är queued eller in_progress.
async function hasActiveRun(workflowFile) {
  if (DRY_RUN) return false; // anta inte aktiv → visa "would dispatch"
  try {
    const q = `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=10`;
    const data = await gh("GET", q);
    return (data?.workflow_runs || []).some(
      (r) => r.status === "queued" || r.status === "in_progress",
    );
  } catch (e) {
    log(`  ⚠ kunde inte kolla aktiva runs för ${workflowFile}: ${e.message}`);
    return false; // hellre dispatch:a än att missa en recovery
  }
}

async function dispatchWorkflow(workflowFile) {
  if (DRY_RUN) {
    log(`  [dry-run] skulle dispatch:a ${workflowFile}`);
    return true;
  }
  await gh(
    "POST",
    `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    { ref: "main" },
  );
  return true;
}

/** Äldsta in_progress-run för en workflow (eller null). */
async function getOldestInProgressRun(workflowFile) {
  try {
    const q = `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?status=in_progress&per_page=10`;
    const data = await gh("GET", q);
    const runs = data?.workflow_runs || [];
    if (!runs.length) return null;
    runs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    return runs[0];
  } catch (e) {
    log(`  ⚠ kunde inte hämta keepalive-runs: ${e.message}`);
    return null;
  }
}

async function cancelRun(runId) {
  await gh("POST", `/repos/${REPO}/actions/runs/${runId}/cancel`);
}

/** Keepalivens heartbeat = updatedAt i tolerans-filen (committas var ~5 min). */
function readKeepaliveHeartbeatAgeMs() {
  try {
    const obj = JSON.parse(fs.readFileSync(KEEPALIVE_HEARTBEAT_FILE, "utf8"));
    const ts = Date.parse(obj.updatedAt);
    return Number.isFinite(ts) ? Date.now() - ts : null;
  } catch {
    return null; // ingen fil ännu → hoppa (keepalive har kanske aldrig kört rampen)
  }
}

/**
 * Reapa en hängd keepalive: om heartbeaten är gammal OCH en keepalive-run är
 * in_progress, avbryt den (zombie) och starta om. Körs varje watchdog-tick.
 */
async function reapHungKeepalive() {
  const ageMs = readKeepaliveHeartbeatAgeMs();
  if (ageMs === null || ageMs < KEEPALIVE_HEARTBEAT_STALE_MS) return; // färsk heartbeat → keepalive lever
  const run = await getOldestInProgressRun(KEEPALIVE_WORKFLOW);
  const ageMin = Math.round(ageMs / 60000);
  if (run) {
    log(`☠ KEEPALIVE-ZOMBIE: heartbeat ${ageMin} min gammal, run ${run.id} in_progress → avbryter + startar om`);
    if (!DRY_RUN) {
      try { await cancelRun(run.id); } catch (e) { log(`  ⚠ cancel-fel: ${e.message}`); }
    } else {
      log(`  [dry-run] skulle avbryta run ${run.id}`);
    }
  } else {
    log(`⚠ keepalive-heartbeat ${ageMin} min gammal men ingen in_progress-run → startar om`);
  }
  // Starta alltid en färsk (efterföljaren kan ligga fast pending bakom zombien).
  try { await dispatchWorkflow(KEEPALIVE_WORKFLOW); } catch (e) { log(`  ⚠ keepalive-dispatch-fel: ${e.message}`); }
}

async function findOpenIssue(sourceId) {
  if (DRY_RUN) return null;
  try {
    const issues = await gh(
      "GET",
      `/repos/${REPO}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`,
    );
    const marker = `<!-- watchdog:${sourceId} -->`;
    return (issues || []).find((i) => (i.body || "").includes(marker)) || null;
  } catch (e) {
    log(`  ⚠ kunde inte söka issues för ${sourceId}: ${e.message}`);
    return null;
  }
}

async function openIssue(row, h) {
  if (DRY_RUN) {
    log(`  [dry-run] skulle öppna issue för ${row.id}`);
    return null;
  }
  const body =
    `<!-- watchdog:${row.id} -->\n` +
    `**Källa:** ${row.name} (\`${row.id}\`)\n` +
    `**Status:** \`${row.status}\`\n` +
    `**Ålder:** ${row.ageSec == null ? "—" : Math.round(row.ageSec / 60) + " min"} ` +
    `(stale-gräns: ${Math.round(row.staleAfterSec / 60)} min)\n` +
    `**Rader:** ${row.rowCount}\n` +
    `**Workflow:** \`${row.workflow}\`\n` +
    `**Stale i rad:** ${h.consecutiveStale} kontroller\n\n` +
    `Watchdogen har auto-omstartat fetch-workflow:n men källan är fortfarande ` +
    `inte färsk. ${
      DISPATCHABLE.has(row.status)
        ? "Kan kräva manuell felsökning (scraper-bug, upstream-ändring)."
        : "Status kräver människa (saknad secret, geo-block eller felaktig conf)."
    }\n\n` +
    `_Issuet stängs automatiskt när källan blir färsk igen._`;
  const issue = await gh("POST", `/repos/${REPO}/issues`, {
    title: `🔴 Källa stale: ${row.name} (${row.id})`,
    body,
    labels: [ISSUE_LABEL],
  });
  return issue?.number ?? null;
}

async function closeIssue(sourceId, issueNumber) {
  if (DRY_RUN) {
    log(`  [dry-run] skulle stänga issue #${issueNumber} för ${sourceId}`);
    return;
  }
  try {
    await gh("POST", `/repos/${REPO}/issues/${issueNumber}/comments`, {
      body: `✅ \`${sourceId}\` är färsk igen — stänger automatiskt.`,
    });
    await gh("PATCH", `/repos/${REPO}/issues/${issueNumber}`, { state: "closed" });
  } catch (e) {
    log(`  ⚠ kunde inte stänga issue #${issueNumber}: ${e.message}`);
  }
}

// Plocka ut det "materiella" tillståndet (det som motiverar en commit) så vi
// kan jämföra mot förra körningen och hoppa över heartbeat-commits.
function materialSnapshot(health) {
  const out = {};
  for (const [id, s] of Object.entries(health.sources)) {
    out[id] = {
      status: s.status,
      consecutiveStale: s.consecutiveStale,
      dispatchCount: s.dispatchCount,
      issueNumber: s.issueNumber ?? null,
    };
  }
  return JSON.stringify(out);
}

async function main() {
  const now = new Date().toISOString();
  await pingRenderKeepAwake();
  // Reapa en ev. hängd keepalive FÖRST — den är flottans dispatcher, så en zombie
  // där är allvarligare än enskilda stale källor (och orsakar dem).
  await reapHungKeepalive();
  const audit = runAudit();
  const prev = loadHealth();
  const prevMaterial = materialSnapshot(prev);

  const health = { generatedAt: now, sources: {} };
  let attentionCount = 0;
  let dispatched = 0;

  for (const row of audit.rows) {
    const p = prev.sources[row.id] || {};
    const isAttention = ATTENTION.has(row.status);
    const isFresh = row.status === "FRESH";

    const s = {
      name: row.name,
      status: row.status,
      partial: row.partial ?? false,
      ageSec: row.ageSec,
      updatedAt: row.updatedAt,
      rowCount: row.rowCount,
      staleAfterSec: row.staleAfterSec,
      workflow: row.workflow,
      lastCheck: now,
      lastHealthyAt: isFresh ? now : p.lastHealthyAt ?? null,
      consecutiveStale: isAttention ? (p.consecutiveStale ?? 0) + 1 : 0,
      dispatchCount: p.dispatchCount ?? 0,
      lastDispatchAt: p.lastDispatchAt ?? null,
      issueNumber: p.issueNumber ?? null,
    };

    if (isAttention) {
      attentionCount++;
      log(`\n▶ ${row.name} (${row.id}): ${row.status} — stale ${s.consecutiveStale}x i rad`);

      // 1) Auto-omstart — ENDAST om watchdog-dispatch uttryckligen är på. Default
      //    av: keepaliven är ensam dispatcher (ingen kollision). Watchdogen
      //    eskalerar i stället via issue (steg 2) om en källa ligger stale länge.
      if (WATCHDOG_DISPATCH_ON && DISPATCHABLE.has(row.status) && row.manualDispatch) {
        // s.lastDispatchAt håller här FÖRRA dispatchens tid (sätts om nedan).
        const sinceLastDispatch = s.lastDispatchAt
          ? Date.now() - Date.parse(s.lastDispatchAt)
          : Infinity;
        const active = await hasActiveRun(row.workflow);
        if (active) {
          log(`  ↳ hoppar dispatch — en run är redan queued/in_progress`);
        } else if (sinceLastDispatch < DISPATCH_COOLDOWN_MS) {
          log(
            `  ↳ hoppar dispatch — dispatchad för ${Math.round(sinceLastDispatch / 60000)} min sedan ` +
              `(cooldown ${DISPATCH_COOLDOWN_MS / 60000} min — undviker supersede-storm)`,
          );
        } else {
          try {
            await dispatchWorkflow(row.workflow);
            s.dispatchCount++;
            s.lastDispatchAt = now;
            dispatched++;
            log(`  ↳ dispatch:ade ${row.workflow} (omstart #${s.dispatchCount})`);
          } catch (e) {
            log(`  ↳ dispatch misslyckades: ${e.message}`);
          }
        }
      } else {
        log(`  ↳ ingen auto-dispatch (status=${row.status}, manualDispatch=${row.manualDispatch})`);
      }

      // 2) Eskalering till issue efter ESCALATE_AFTER kontroller i rad
      if (s.consecutiveStale >= ESCALATE_AFTER && !s.issueNumber) {
        const existing = await findOpenIssue(row.id);
        if (existing) {
          s.issueNumber = existing.number;
          log(`  ↳ issue finns redan: #${existing.number}`);
        } else {
          const num = await openIssue(row, s);
          if (num) {
            s.issueNumber = num;
            log(`  ↳ öppnade larm-issue #${num}`);
          }
        }
      }
    } else if (isFresh && s.issueNumber) {
      // 3) Recovery — stäng eventuellt öppet issue
      log(`\n✅ ${row.name} (${row.id}): FRESH igen — stänger issue #${s.issueNumber}`);
      await closeIssue(row.id, s.issueNumber);
      s.issueNumber = null;
    }

    health.sources[row.id] = s;
  }

  // Summering
  const fresh = audit.rows.filter((r) => r.status === "FRESH").length;
  health.summary = {
    total: audit.rows.length,
    fresh,
    attention: attentionCount,
    dispatched,
  };

  fs.writeFileSync(HEALTH_JSON, JSON.stringify(health, null, 2) + "\n");
  log(
    `\nWatchdog klar: ${fresh}/${audit.rows.length} fresh, ` +
      `${attentionCount} behöver uppmärksamhet, ${dispatched} omstartade.`,
  );

  // Signalera till workflow:n om vi ska committa (bara vid materiell ändring)
  const changed = materialSnapshot(health) !== prevMaterial || !fs.existsSync(HEALTH_JSON);
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    fs.appendFileSync(ghOut, `health_changed=${changed ? "true" : "false"}\n`);
  }
  log(changed ? "Materiell ändring → committa source-health.json" : "Ingen materiell ändring → ingen commit");
}

main().catch((e) => {
  console.error("Watchdog FEL:", e);
  process.exit(1);
});
