/**
 * GET /api/admin/storage/health — admin-only lagringsstatus (inga känsliga data).
 *
 * Visar live var users/licenser sparas, om persistent disk är konfigurerad,
 * om paths är writable, vilka env vars som används, och varningar.
 *
 * Använd från Render-konsol via curl eller från Admin-sidan för att verifiera
 * att persistent storage är korrekt konfigurerad innan du litar på den.
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getAutoclickerStorageStatus } from "./autoclickerLicense";
import { getAppUsersStorageStatus } from "./appUsers";
import { checkDirectoryWritable, isProductionDeploy, requirePersistentStorageOrFail } from "./persistentStorage";

export type StorageHealthResponse = {
  ok: true;
  /** Övergripande hälsa: false = data riskerar att försvinna vid deploy. */
  healthy: boolean;
  warnings: string[];
  // Users
  users_file_exists: boolean;
  users_count: number;
  users_path: string;
  users_data_dir: string;
  users_dir_writable: boolean;
  users_dir_writable_reason?: string;
  using_persistent_users_dir: boolean;
  // Licenses
  licenses_file_exists: boolean;
  license_count: number;
  licenses_path: string;
  licenses_data_dir: string;
  licenses_dir_writable: boolean;
  licenses_dir_writable_reason?: string;
  using_persistent_licenses_dir: boolean;
  // Downloads (autoclicker zip)
  zip_exists: boolean;
  download_path: string;
  // Env + runtime info (utan känsliga secrets)
  env: {
    NODE_ENV: string | null;
    RENDER: string | null;
    APP_USERS_DATA_DIR: string | null;
    AUTOCLICKER_DATA_DIR: string | null;
    AUTOCLICKER_DOWNLOAD_DIR: string | null;
  };
  process_cwd: string;
  // Render-disk-detektion
  expected_render_disk_path: string;
  /** Legacy alias för expected_mount_exists. */
  render_disk_path_exists: boolean;
  expected_mount_path: string;
  expected_mount_exists: boolean;
  expected_mount_is_directory: boolean;
  expected_mount_writable: boolean;
  expected_mount_writable_reason?: string;
  download_dir_writable: boolean;
  download_dir_writable_reason?: string;
  /** True om ALLA tre persistent paths ligger under expected_mount_path. */
  paths_are_under_expected_mount: boolean;
  persistent_disk_recommended: boolean;
  /** Varm svars-cache (valuebets/bonus/optimizer). Överlever recycle om den
   *  ligger på en monterad persistent disk (CACHE_DIR satt ELLER under mount). */
  cache_dir: string;
  cache_dir_env_set: boolean;
  /** True om cachen persisterar (env-satt ELLER under den monterade disken). */
  cache_dir_persistent: boolean;
  cache_dir_writable: boolean;
  cache_dir_writable_reason?: string;
  /** Process-runtime. Låg uptime varje gång du kollar = instansen somnar/recyclas
   *  (warmers + spårning stoppas då, och sidorna byggs om kallt vid återkomst). */
  process_uptime_seconds: number;
  process_started_at: string;
  /** "ok" → write-safety är aktiverad. "blocked" → prod misconfig → writes refuseras. */
  write_gate: "ok" | "blocked";
  write_gate_reason?: string;
  write_gate_missing_env?: string[];
};

const EXPECTED_RENDER_DISK = "/opt/render/project/src/.matched-betting-cache";

function isUnderPersistentDisk(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return normalized.startsWith(EXPECTED_RENDER_DISK + path.sep) || normalized === EXPECTED_RENDER_DISK;
}

export function getStorageHealth(): StorageHealthResponse {
  const users = getAppUsersStorageStatus();
  const licenses = getAutoclickerStorageStatus();
  const downloadDir = process.env.AUTOCLICKER_DOWNLOAD_DIR?.trim() ?? null;

  // Disk writable-test (skapa+ta-bort fil) per konfigurerad dir
  const usersDirCheck = checkDirectoryWritable(users.users_data_dir);
  const licensesDirCheck = checkDirectoryWritable(licenses.data_dir);
  const downloadDirCheck = downloadDir
    ? checkDirectoryWritable(downloadDir)
    : { ok: false, reason: "AUTOCLICKER_DOWNLOAD_DIR not set" };

  // Write-gate (samma logik som blockerar create i prod)
  const gate = requirePersistentStorageOrFail();
  const writeGateOk = gate.ok;

  // Varm svars-cache-dir — SAMMA logik som BONUS_CACHE_DIR i vite.config.ts.
  // Persistent om CACHE_DIR är satt ELLER om default-sökvägen råkar ligga UNDER
  // den monterade disken (vanligt på Render: disken monteras på cwd/.matched-
  // betting-cache, vilket ÄR default-sökvägen → cacherna persisterar redan).
  // Bara om sökvägen varken är env-satt eller under disken är den efemär.
  const cacheDirEnv = (process.env.CACHE_DIR || process.env.RENDER_CACHE_DIR || "").trim();
  const cacheDir = cacheDirEnv
    ? path.resolve(cacheDirEnv)
    : path.resolve(process.cwd(), ".matched-betting-cache");
  const cacheDirCheck = checkDirectoryWritable(cacheDir);
  const cacheDirUnderMount = isUnderPersistentDisk(cacheDir);
  const cacheDirPersistent = cacheDirEnv !== "" || cacheDirUnderMount;

  // Render disk mount-detektion — använder ren fs (inte require() som
  // krasch:ar i ESM). Tre nivåer av check:
  //   1. existsSync(mount root)
  //   2. statSync().isDirectory()
  //   3. writable test (skapa+ta-bort fil i mount root)
  let expectedMountExists = false;
  let expectedMountIsDir = false;
  try {
    expectedMountExists = fs.existsSync(EXPECTED_RENDER_DISK);
    if (expectedMountExists) {
      try {
        expectedMountIsDir = fs.statSync(EXPECTED_RENDER_DISK).isDirectory();
      } catch {
        expectedMountIsDir = false;
      }
    }
  } catch {
    expectedMountExists = false;
  }
  const expectedMountWritableCheck = expectedMountExists
    ? checkDirectoryWritable(EXPECTED_RENDER_DISK)
    : { ok: false, reason: "mount path does not exist" };

  // Är ALLA tre persistent paths under expected mount?
  const pathsAreUnderExpectedMount =
    (users.using_env_data_dir ? isUnderPersistentDisk(users.users_data_dir) : false) &&
    (licenses.using_env_data_dir ? isUnderPersistentDisk(licenses.data_dir) : false) &&
    (downloadDir ? isUnderPersistentDisk(downloadDir) : false);

  // Warnings — praktisk bedömning. Om alla tre child-dirs är writable och
  // ligger under mount, är allt OK ÄVEN om root-existsSync misslyckas
  // (kan hända med ovanlig permission-config). Vi visar bara root-warning
  // när vi har EN REAL anledning att tro att mount saknas (writable-test
  // failar på alla child-dirs).
  const warnings: string[] = [];
  const childDirsAllOk = usersDirCheck.ok && licensesDirCheck.ok && downloadDirCheck.ok;
  if (isProductionDeploy()) {
    if (!users.using_env_data_dir) warnings.push("APP_USERS_DATA_DIR not set in production — users will be lost on next deploy");
    if (!licenses.using_env_data_dir) warnings.push("AUTOCLICKER_DATA_DIR not set in production — licenses will be lost on next deploy");
    if (!downloadDir) warnings.push("AUTOCLICKER_DOWNLOAD_DIR not set in production — autoclicker zip will not persist");
    if (users.using_env_data_dir && !isUnderPersistentDisk(users.users_data_dir)) warnings.push(`Users dir is set but NOT under ${EXPECTED_RENDER_DISK} — may be ephemeral`);
    if (licenses.using_env_data_dir && !isUnderPersistentDisk(licenses.data_dir)) warnings.push(`Licenses dir is set but NOT under ${EXPECTED_RENDER_DISK} — may be ephemeral`);
    if (downloadDir && !isUnderPersistentDisk(downloadDir)) warnings.push(`Download dir is set but NOT under ${EXPECTED_RENDER_DISK} — may be ephemeral`);
    // Mount root-warning visas ENDAST om vi har en RIKTIG anledning att tro
    // att mount saknas. Om child-dirs är writable + under mount = mount finns
    // de facto. Vi visar då bara en INFO-rad, inte en blockerande varning.
    if (!expectedMountExists && !childDirsAllOk) {
      warnings.push(`Expected Render disk mount missing: ${EXPECTED_RENDER_DISK}`);
    }
    if (expectedMountExists && !expectedMountIsDir) {
      warnings.push(`Expected Render disk mount path exists but is not a directory: ${EXPECTED_RENDER_DISK}`);
    }
  }
  if (!usersDirCheck.ok) warnings.push(`Users dir NOT writable: ${usersDirCheck.reason ?? "unknown"}`);
  if (!licensesDirCheck.ok) warnings.push(`Licenses dir NOT writable: ${licensesDirCheck.reason ?? "unknown"}`);
  if (downloadDir && !downloadDirCheck.ok) warnings.push(`Download dir NOT writable: ${downloadDirCheck.reason ?? "unknown"}`);
  if (!writeGateOk) warnings.push(`WRITE GATE BLOCKED: ${gate.ok === false ? gate.reason : ""}`);

  return {
    ok: true,
    healthy: warnings.length === 0,
    warnings,
    users_file_exists: users.users_file_exists,
    users_count: users.users_count,
    users_path: users.users_file_path,
    users_data_dir: users.users_data_dir,
    users_dir_writable: usersDirCheck.ok,
    users_dir_writable_reason: usersDirCheck.reason,
    using_persistent_users_dir: users.using_env_data_dir,
    licenses_file_exists: licenses.license_file_exists,
    license_count: licenses.license_count,
    licenses_path: licenses.license_file_path,
    licenses_data_dir: licenses.data_dir,
    licenses_dir_writable: licensesDirCheck.ok,
    licenses_dir_writable_reason: licensesDirCheck.reason,
    using_persistent_licenses_dir: licenses.using_env_data_dir,
    zip_exists: licenses.zip_exists,
    download_path: licenses.zip_file_path,
    env: {
      NODE_ENV: process.env.NODE_ENV ?? null,
      RENDER: process.env.RENDER ?? null,
      APP_USERS_DATA_DIR: process.env.APP_USERS_DATA_DIR ?? null,
      AUTOCLICKER_DATA_DIR: process.env.AUTOCLICKER_DATA_DIR ?? null,
      AUTOCLICKER_DOWNLOAD_DIR: process.env.AUTOCLICKER_DOWNLOAD_DIR ?? null,
    },
    process_cwd: process.cwd(),
    expected_render_disk_path: EXPECTED_RENDER_DISK,
    render_disk_path_exists: expectedMountExists, // legacy alias
    expected_mount_path: EXPECTED_RENDER_DISK,
    expected_mount_exists: expectedMountExists,
    expected_mount_is_directory: expectedMountIsDir,
    expected_mount_writable: expectedMountWritableCheck.ok,
    expected_mount_writable_reason: expectedMountWritableCheck.ok ? undefined : expectedMountWritableCheck.reason,
    download_dir_writable: downloadDirCheck.ok,
    download_dir_writable_reason: downloadDirCheck.ok ? undefined : downloadDirCheck.reason,
    paths_are_under_expected_mount: pathsAreUnderExpectedMount,
    persistent_disk_recommended:
      users.persistent_disk_recommended || licenses.persistent_disk_recommended,
    cache_dir: cacheDir,
    cache_dir_env_set: cacheDirEnv !== "",
    cache_dir_persistent: cacheDirPersistent,
    cache_dir_writable: cacheDirCheck.ok,
    cache_dir_writable_reason: cacheDirCheck.ok ? undefined : cacheDirCheck.reason,
    process_uptime_seconds: Math.round(process.uptime()),
    process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    write_gate: writeGateOk ? "ok" : "blocked",
    write_gate_reason: gate.ok ? undefined : gate.reason,
    write_gate_missing_env: gate.ok ? undefined : gate.missingEnvVars,
  };
}

/**
 * Startup-logg som visar persistent storage-konfiguration vid app-init.
 * Tydligt synlig i Render service-logs så admin kan verifiera konfigurationen.
 */
export function logStorageConfigOnStartup(): void {
  const h = getStorageHealth();
  console.log("════════════════════════════════════════════════════════════════");
  console.log("[storage] Persistent storage config:");
  console.log("[storage]   APP_USERS_DATA_DIR        =", h.env.APP_USERS_DATA_DIR ?? "(unset)");
  console.log("[storage]   AUTOCLICKER_DATA_DIR      =", h.env.AUTOCLICKER_DATA_DIR ?? "(unset)");
  console.log("[storage]   AUTOCLICKER_DOWNLOAD_DIR  =", h.env.AUTOCLICKER_DOWNLOAD_DIR ?? "(unset)");
  console.log("[storage]   NODE_ENV                  =", h.env.NODE_ENV ?? "(unset)");
  console.log("[storage]   RENDER                    =", h.env.RENDER ?? "(unset)");
  console.log("[storage]   process.cwd()             =", h.process_cwd);
  console.log("[storage]");
  console.log("[storage]   users_path                =", h.users_path);
  console.log("[storage]   users_count               =", h.users_count);
  console.log("[storage]   users_dir_writable        =", h.users_dir_writable, h.users_dir_writable_reason ?? "");
  console.log("[storage]   licenses_path             =", h.licenses_path);
  console.log("[storage]   license_count             =", h.license_count);
  console.log("[storage]   licenses_dir_writable     =", h.licenses_dir_writable, h.licenses_dir_writable_reason ?? "");
  console.log("[storage]");
  console.log("[storage]   expected disk mount       =", h.expected_mount_path);
  console.log("[storage]   mount exists              =", h.expected_mount_exists);
  console.log("[storage]   mount is directory        =", h.expected_mount_is_directory);
  console.log("[storage]   mount writable            =", h.expected_mount_writable, h.expected_mount_writable_reason ?? "");
  console.log("[storage]   download dir writable     =", h.download_dir_writable, h.download_dir_writable_reason ?? "");
  console.log("[storage]   paths under expected mount=", h.paths_are_under_expected_mount);
  console.log("[storage]   write_gate                =", h.write_gate);
  if (h.write_gate_reason) console.log("[storage]   write_gate_reason         =", h.write_gate_reason);
  console.log("[storage]");
  console.log("[storage]   cache_dir (warm responses)=", h.cache_dir);
  console.log("[storage]   cache_dir_persistent      =", h.cache_dir_persistent, h.cache_dir_env_set ? "(CACHE_DIR set)" : "(under disk mount)");
  console.log("[storage]   cache_dir_writable        =", h.cache_dir_writable, h.cache_dir_writable_reason ?? "");
  console.log("[storage]   process uptime (s)        =", h.process_uptime_seconds);
  if (!h.cache_dir_persistent) {
    console.log(
      "[storage]   ⚠ CACHE_DIR ej satt → varma cacher (valuebets/bonus/optimizer) är EFEMÄRA och",
    );
    console.log(
      "[storage]     försvinner vid varje recycle/sömn. Sätt CACHE_DIR till en monterad persistent disk",
    );
    console.log(
      "[storage]     (t.ex. /var/data) så laddar sidorna direkt även efter omstart.",
    );
  }
  if (h.warnings.length > 0) {
    console.log("[storage] WARNINGS:");
    for (const w of h.warnings) console.log("[storage]   ⚠", w);
  } else {
    console.log("[storage] healthy ✓ — no warnings");
  }
  console.log("════════════════════════════════════════════════════════════════");
}

export type StorageHealthApiContext = {
  isAdminUsername: (username: string) => boolean;
  getAuthUsername: (req: IncomingMessage) => string | null;
};

export function storageHealthApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  ctx: StorageHealthApiContext,
): void {
  const url = req.url?.split("?")[0] ?? "";
  if (url !== "/api/admin/storage/health" && url !== "/api/storage/health") {
    next();
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }

  const user = ctx.getAuthUsername(req);
  if (!user || !ctx.isAdminUsername(user)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ ok: false, error: "Admin access required" }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify(getStorageHealth()));
}
