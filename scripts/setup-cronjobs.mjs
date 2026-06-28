#!/usr/bin/env node
/**
 * Auto-registrerar alla data-refresh-workflows som jobb på cron-job.org.
 *
 * Löser problemet att GitHub Actions cron bara kör ~7-10 ggr/dygn (best-effort
 * throttling på publika repos) istället för var 5:e minut. cron-job.org pingar
 * GitHub:s workflow_dispatch-API på pålitligt schema och tvingar igång varje
 * workflow.
 *
 * ANVÄNDNING:
 *   1. Skapa konto på https://cron-job.org → API-nyckel under Settings → API
 *   2. Skapa GitHub PAT (fine-grained) med Actions: Read and write på repot:
 *      https://github.com/settings/personal-access-tokens/new
 *   3. Kör:
 *        CRONJOB_API_KEY=xxx GITHUB_PAT=github_pat_xxx node scripts/setup-cronjobs.mjs
 *
 *   Lägg till --dry-run för att se vad som skulle skapas utan att skapa något.
 *   Lägg till --delete-existing för att först radera gamla jobb med samma titel.
 *
 * SÄKERHET: Skriptet skickar din GITHUB_PAT till cron-job.org (de lagrar den
 * som request-header). Det är så cron-job.org fungerar — de måste kunna
 * autentisera mot GitHub åt dig. Använd en token med MINSTA möjliga scope
 * (bara Actions: write på detta enda repo) och rotera var 90:e dag.
 */

const CRONJOB_API_BASE = "https://api.cron-job.org";
const GITHUB_OWNER = "Lilgunner24";
const GITHUB_REPO = "linusgan";

const apiKey = process.env.CRONJOB_API_KEY;
const githubPat = process.env.GITHUB_PAT;
const dryRun = process.argv.includes("--dry-run");
const deleteExisting = process.argv.includes("--delete-existing");

if (!apiKey) {
  console.error("FEL: sätt CRONJOB_API_KEY (från cron-job.org Settings → API)");
  process.exit(1);
}
if (!githubPat) {
  console.error("FEL: sätt GITHUB_PAT (GitHub fine-grained token med Actions: write)");
  process.exit(1);
}

/**
 * Workflow → önskad cadence. cron-job.org minimum är 1 minut på gratiskonto.
 * `everyMinutes: 1` = varje minut. `everyMinutes: 5` = minut 0,5,10,...,55.
 */
const WORKFLOWS = [
  { file: "pinnacle-fetch.yml",     title: "Pinnacle Odds Refresh",     everyMinutes: 1 },
  { file: "kambi-fetch.yml",        title: "Kambi (Unibet) Refresh",    everyMinutes: 5 },
  { file: "betsson-fetch.yml",      title: "Betsson Group Refresh",     everyMinutes: 5 },
  { file: "comeon-fetch.yml",       title: "ComeOn Group Refresh",      everyMinutes: 5 },
  { file: "paf-brand-fetch.yml",    title: "Paf-brand Refresh",         everyMinutes: 10 },
  { file: "altenar-fetch.yml",      title: "Altenar Group Refresh",     everyMinutes: 10 },
  { file: "vbet-fetch.yml",         title: "VBET Refresh",              everyMinutes: 10 },
];

/** Bygg minut-array för cron-job.org schedule. everyMinutes=1 → [-1] (varje minut). */
function minutesArray(everyMinutes) {
  if (everyMinutes <= 1) return [-1];
  const out = [];
  for (let m = 0; m < 60; m += everyMinutes) out.push(m);
  return out;
}

function buildJobPayload(wf) {
  return {
    job: {
      url: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${wf.file}/dispatches`,
      enabled: true,
      title: wf.title,
      saveResponses: true,
      requestMethod: 1, // POST
      schedule: {
        timezone: "Europe/Stockholm",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: minutesArray(wf.everyMinutes),
        months: [-1],
        wdays: [-1],
      },
      extendedData: {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubPat}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "cron-job.org-trigger",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    },
  };
}

async function cronjobApi(method, path, body) {
  const res = await fetch(`${CRONJOB_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`cron-job.org ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

async function listExistingJobs() {
  const data = await cronjobApi("GET", "/jobs");
  return data.jobs ?? [];
}

async function main() {
  console.log(`\ncron-job.org auto-setup för ${GITHUB_OWNER}/${GITHUB_REPO}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN (skapar inget)" : "LIVE"}\n`);

  let existing = [];
  if (dryRun) {
    console.log("(dry-run: hoppar över koll av befintliga jobb)\n");
  } else {
    try {
      existing = await listExistingJobs();
      console.log(`Hittade ${existing.length} befintliga jobb på kontot.\n`);
    } catch (e) {
      console.error("Kunde inte lista befintliga jobb (fel API-nyckel?):", e.message);
      process.exit(1);
    }
  }

  const existingByTitle = new Map(existing.map((j) => [j.title, j]));

  for (const wf of WORKFLOWS) {
    const already = existingByTitle.get(wf.title);
    const cadence = wf.everyMinutes === 1 ? "varje minut" : `var ${wf.everyMinutes}:e min`;

    if (already && deleteExisting) {
      if (!dryRun) await cronjobApi("DELETE", `/jobs/${already.jobId}`);
      console.log(`  raderade gammalt jobb: ${wf.title} (id ${already.jobId})`);
    } else if (already) {
      console.log(`  HOPPAR ÖVER (finns redan): ${wf.title} — kör --delete-existing för att återskapa`);
      continue;
    }

    const payload = buildJobPayload(wf);
    if (dryRun) {
      console.log(`  [dry-run] skulle skapa: ${wf.title} (${cadence}) → ${wf.file}`);
      continue;
    }
    try {
      const result = await cronjobApi("PUT", "/jobs", payload);
      console.log(`  ✓ skapade: ${wf.title} (${cadence}) — jobId ${result.jobId ?? "?"}`);
    } catch (e) {
      console.error(`  ✗ MISSLYCKADES: ${wf.title} — ${e.message}`);
    }
  }

  console.log("\nKlart. Verifiera på https://console.cron-job.org/jobs");
  console.log("Inom ~5 min ska Pinnacle vara fresh på matched-betting.onrender.com.\n");
}

main().catch((e) => {
  console.error("Oväntat fel:", e);
  process.exit(1);
});
