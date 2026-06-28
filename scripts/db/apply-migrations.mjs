#!/usr/bin/env node
/**
 * apply-migrations.mjs — applicerar supabase/migrations/*.sql i ordning.
 *
 * Använder ENBART inbyggd fetch + din befintliga SUPABASE_SERVICE_KEY (ingen ny
 * dependency, ingen ny secret). DDL körs via RPC:n public.exec_sql, och vilka
 * migrationer som körts bokförs i public.schema_migrations.
 *
 * FÖRUTSÄTTNING (en gång): kör supabase/migrations/0000_bootstrap.sql manuellt i
 * Supabase SQL Editor. Den skapar schema_migrations + exec_sql. Allt därefter är
 * automatiskt (CI: .github/workflows/db-migrate.yml).
 *
 * Idempotent: alla migrationer använder `create ... if not exists` / `on conflict
 * do nothing`, så en ofullständig körning är säker att köra om.
 *
 * Env:
 *   SUPABASE_URL          — projektets URL (https://xxx.supabase.co)
 *   SUPABASE_SERVICE_KEY  — service-role-nyckeln (eller SUPABASE_SERVICE_ROLE_KEY)
 *   DRY_RUN=1             — lista bara pending migrationer, kör inget
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL_BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const DRY_RUN = process.env.DRY_RUN === "1";

if (!URL_BASE || !KEY) {
  console.error("[migrate] SUPABASE_URL och SUPABASE_SERVICE_KEY krävs.");
  process.exit(1);
}

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL("../../supabase/migrations", import.meta.url)));
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const BOOTSTRAP_HINT =
  "Kör supabase/migrations/0000_bootstrap.sql EN gång i Supabase SQL Editor först " +
  "(skapar schema_migrations + exec_sql). Se supabase/README.md.";

async function appliedVersions() {
  const res = await fetch(`${URL_BASE}/rest/v1/schema_migrations?select=version`, { headers: { ...H, Accept: "application/json" } });
  if (res.status === 404 || res.status === 401 || res.status === 406) {
    throw new Error(`schema_migrations kunde inte läsas (HTTP ${res.status}). ${BOOTSTRAP_HINT}`);
  }
  if (!res.ok) throw new Error(`schema_migrations-läsning HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = await res.json();
  return new Set(rows.map((r) => r.version));
}

async function execSql(sql) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/exec_sql`, { method: "POST", headers: H, body: JSON.stringify({ query: sql }) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text.includes("exec_sql") && (res.status === 404 || res.status === 400)) {
      throw new Error(`exec_sql saknas (HTTP ${res.status}). ${BOOTSTRAP_HINT}`);
    }
    throw new Error(`exec_sql HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function recordVersion(version) {
  const res = await fetch(`${URL_BASE}/rest/v1/schema_migrations`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ version }),
  });
  // 409 = redan bokförd (idempotent) → ok.
  if (!res.ok && res.status !== 409) {
    throw new Error(`bokföring av ${version} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function main() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const pendingAll = files.map((f) => ({ file: f, version: f.replace(/\.sql$/, "") }));

  const applied = await appliedVersions();
  // 0000_bootstrap körs manuellt → hoppa alltid över den i auto-applikatorn.
  const pending = pendingAll.filter((m) => m.version !== "0000_bootstrap" && !applied.has(m.version));

  if (pending.length === 0) {
    console.log(`[migrate] Inga nya migrationer (${applied.size} redan körda).`);
    return;
  }

  console.log(`[migrate] ${pending.length} pending: ${pending.map((p) => p.version).join(", ")}`);
  if (DRY_RUN) {
    console.log("[migrate] DRY_RUN=1 → kör inget.");
    return;
  }

  for (const { file, version } of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    process.stdout.write(`[migrate] kör ${version} ... `);
    await execSql(sql);
    await recordVersion(version);
    console.log("OK");
  }
  console.log(`[migrate] Klart — ${pending.length} migration(er) körda.`);
}

main().catch((e) => {
  console.error("[migrate] FEL:", e.message);
  process.exit(1);
});
