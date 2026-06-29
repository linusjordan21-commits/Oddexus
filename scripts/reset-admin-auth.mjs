#!/usr/bin/env node
/**
 * Reset admin-auth: ta bort data/admin-auth.json så appen faller tillbaka
 * till Render env-credentials (APP_USERNAME + APP_PASSWORD_HASH).
 *
 * Användning:
 *   node scripts/reset-admin-auth.mjs
 *
 * När att köra:
 *   - Du har glömt lösenordet du satte via /admin
 *   - Du vill rotera tillbaka till env-lösenordet
 *   - Du vill rensa cookies för alla användare (env har sessionVersion=0
 *     vilket invaliderar gamla file-cookies med v >= 1)
 *
 * Vad scriptet GÖR:
 *   1. Tar backup till data/admin-auth.backup.<timestamp>.json (mode 0600)
 *   2. Tar bort data/admin-auth.json
 *
 * Vad scriptet INTE gör:
 *   - Rör INTE några env vars (kan inte — environment är process-lokal)
 *   - Skriver INTE passwordHash till terminalen
 *   - Kraschar INTE om filen saknas (idempotent — säker att köra igen)
 */
import fs from "node:fs";
import path from "node:path";

// Matchar app:ens path (vite.config ADMIN_AUTH_FILE): persistenta disken om satt, annars data/.
const DATA_DIR = process.env.APP_USERS_DATA_DIR?.trim() || path.resolve(process.cwd(), "data");
const AUTH_FILE = path.join(DATA_DIR, "admin-auth.json");

function fmtTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function main() {
  if (!fs.existsSync(AUTH_FILE)) {
    console.log("");
    console.log("ℹ  No admin-auth.json found.");
    console.log("   App is already using env credentials (APP_USERNAME + APP_PASSWORD_HASH).");
    console.log("");
    process.exit(0);
  }

  // Läs metadata för att skriva ut authSource — vi loggar ALDRIG passwordHash.
  let metaSummary = "unknown";
  try {
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const username = typeof parsed.username === "string" ? parsed.username : "?";
    const sessionVersion = typeof parsed.sessionVersion === "number" ? parsed.sessionVersion : "?";
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "?";
    metaSummary = `username=${username}, sessionVersion=${sessionVersion}, updatedAt=${updatedAt}`;
  } catch {
    metaSummary = "(file unreadable — will still be backed up + removed)";
  }

  const backup = path.join(DATA_DIR, `admin-auth.backup.${fmtTimestamp()}.json`);
  try {
    // Kopiera bytes-för-bytes (inte JSON-omformatering) så backup är exakt
    // den filen vi tar bort.
    fs.copyFileSync(AUTH_FILE, backup);
    // Säkerställ samma restriktiva mode som original.
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      /* ignore — best effort */
    }
  } catch (e) {
    console.error("✗ Failed to write backup:", e instanceof Error ? e.message : e);
    console.error("  Aborting reset — admin-auth.json NOT removed.");
    process.exit(1);
  }

  try {
    fs.unlinkSync(AUTH_FILE);
  } catch (e) {
    console.error("✗ Failed to remove admin-auth.json:", e instanceof Error ? e.message : e);
    console.error("  Backup was created at:", backup);
    process.exit(1);
  }

  console.log("");
  console.log("✓ Admin auth reset.");
  console.log(`  Removed:  ${path.relative(process.cwd(), AUTH_FILE)}`);
  console.log(`  Backup:   ${path.relative(process.cwd(), backup)}`);
  console.log(`  Metadata: ${metaSummary}`);
  console.log("");
  console.log("  App will now use Render env credentials on next request:");
  console.log("    APP_USERNAME       (e.g. \"linus\")");
  console.log("    APP_PASSWORD_HASH  (scrypt hash, never plain text)");
  console.log("");
  console.log("  All existing login sessions are invalidated — every user must log in again.");
  console.log("");
}

main();
