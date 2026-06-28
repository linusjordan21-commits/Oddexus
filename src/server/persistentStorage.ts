/**
 * Gemensamma hjälpare för filbaserad persistent lagring (Render disk).
 *
 * Production-säkerhet: i NODE_ENV=production måste APP_USERS_DATA_DIR +
 * AUTOCLICKER_DATA_DIR + AUTOCLICKER_DOWNLOAD_DIR vara satta och peka på
 * en persistent Render disk. Annars faller koden TYST tillbaka till
 * data/users.json som är EPHEMERAL → user/licens-data försvinner vid
 * varje deploy.
 *
 * Tre lager skydd implementerade:
 *   1. requirePersistentStorageOrFail() vid alla create/update-write
 *   2. disk_writable-test i /api/admin/storage/health (skapa+ta-bort testfil)
 *   3. migrate-säkerhet: aldrig överskriv persistent target som EXISTERAR
 */

import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function legacyDataPath(filename: string): string {
  return path.resolve(process.cwd(), "data", filename);
}

/**
 * Avgör om appen kör i ett "deploy-känsligt" läge där ephemeral storage
 * leder till dataförlust. Render-deploys regenererar fs så data/ försvinner.
 */
export function isProductionDeploy(): boolean {
  return process.env.NODE_ENV === "production" || process.env.RENDER === "true";
}

export type PersistentStorageGate =
  | { ok: true }
  | { ok: false; reason: string; missingEnvVars: string[] };

/**
 * Kollar att alla persistent-storage env-vars är satta i prod.
 * Använd som gate FÖRE varje write-operation:
 *
 *   const gate = requirePersistentStorageOrFail();
 *   if (!gate.ok) throw new Error(gate.reason);
 *
 * I dev/test: alltid ok (tillåter data/users.json fallback).
 */
export function requirePersistentStorageOrFail(
  requiredVars: string[] = ["APP_USERS_DATA_DIR", "AUTOCLICKER_DATA_DIR", "AUTOCLICKER_DOWNLOAD_DIR"],
): PersistentStorageGate {
  if (!isProductionDeploy()) return { ok: true };
  const missing = requiredVars.filter((name) => !process.env[name]?.trim());
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    missingEnvVars: missing,
    reason:
      `Persistent storage not configured (missing env vars: ${missing.join(", ")}). ` +
      "Refusing to write since data would be lost on next deploy. " +
      "Configure Render dashboard → Environment → Add the missing variables, " +
      "and mount the persistent disk on /opt/render/project/src/.matched-betting-cache.",
  };
}

/**
 * Testar att en katalog är writable genom att skapa+ta bort en testfil.
 * Returns ok:true om allt funkar, annars reason.
 */
export function checkDirectoryWritable(dir: string): { ok: boolean; reason?: string } {
  try {
    ensureDir(dir);
    const testFile = path.join(dir, `.write-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.writeFileSync(testFile, "test", { mode: 0o600 });
    fs.unlinkSync(testFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function backupCorruptJsonFile(filePath: string, label: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${filePath}.corrupt.${stamp}.bak`;
    fs.copyFileSync(filePath, backup);
    console.warn(`[${label}] Corrupt JSON backed up to ${backup}`);
  } catch (e) {
    console.warn(
      `[${label}] Failed to backup corrupt file:`,
      e instanceof Error ? e.message : e,
    );
  }
}

export function migrateLegacyJsonIfMissing(
  targetPath: string,
  legacyPath: string,
  logMessage: string,
): void {
  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(legacyPath)) return;
  try {
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(legacyPath, targetPath);
    console.log(`[storage] ${logMessage}`);
    console.log(`[storage]   from: ${legacyPath}`);
    console.log(`[storage]   to:   ${targetPath}`);
  } catch (e) {
    console.warn(
      `[storage] Migration failed (${logMessage}):`,
      e instanceof Error ? e.message : e,
    );
  }
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function initializeEmptyJsonArray(filePath: string, label: string): void {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]\n", { mode: 0o600 });
    console.log(`[${label}] Created empty ${filePath}`);
  }
}
