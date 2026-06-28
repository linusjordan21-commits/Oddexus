/**
 * App-användare (kunder) — filbaserad lagring.
 *
 * Env (Render persistent disk):
 *   APP_USERS_DATA_DIR → katalog för users.json
 *
 * Fallback (lokal dev):
 *   data/users.json
 *
 * Production path på Render:
 *   APP_USERS_DATA_DIR/users.json
 *   t.ex. /opt/render/project/src/.matched-betting-cache/app-data/users/users.json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hashPasswordScrypt, verifyPasswordHash } from "./password";
import {
  atomicWriteJson,
  backupCorruptJsonFile,
  ensureDir,
  initializeEmptyJsonArray,
  legacyDataPath,
  migrateLegacyJsonIfMissing,
  requirePersistentStorageOrFail,
} from "./persistentStorage";

export type AppUser = {
  id: string;
  username: string;
  passwordHash: string;
  active: boolean;
  /** Per-användare-behörighet: åtkomst till valuebets-sektionen (default false). */
  valuebets?: boolean;
  /** Per-användare-behörighet: Bonus Finder (default false). */
  bonusFinder?: boolean;
  /** Per-användare-behörighet: Bonus Optimizer (default false). */
  bonusOptimizer?: boolean;
  /** Per-användare-behörighet: Athena AI-assistent (default false). */
  athena?: boolean;
  sessionVersion: number;
  created_at: string;
  updated_at: string;
};

export type AppUsersStorageStatus = {
  users_file_path: string;
  users_file_exists: boolean;
  users_count: number;
  users_data_dir: string;
  using_env_data_dir: boolean;
  persistent_disk_recommended: boolean;
};

const USERS_FILENAME = "users.json";
const STORAGE_LABEL = "app-users";

function resolveUsersDataDir(): string {
  const fromEnv = process.env.APP_USERS_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "data");
}

export function resolveUsersFilePath(): string {
  const fileOverride = process.env.APP_USERS_FILE?.trim();
  if (fileOverride) return path.resolve(fileOverride);
  return path.join(resolveUsersDataDir(), USERS_FILENAME);
}

function legacyUsersFilePath(): string {
  return legacyDataPath(USERS_FILENAME);
}

function migrateUsersIfNeeded(): void {
  const target = resolveUsersFilePath();
  const legacy = legacyUsersFilePath();
  if (target === legacy) return;
  migrateLegacyJsonIfMissing(
    target,
    legacy,
    "Migrated users from data/users.json to persistent storage",
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function isAppUser(x: unknown): x is AppUser {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.username === "string" &&
    typeof o.passwordHash === "string" &&
    typeof o.active === "boolean" &&
    // behörighetsflaggor är optional (äldre users saknar dem) men måste vara boolean om satta
    (o.valuebets === undefined || typeof o.valuebets === "boolean") &&
    (o.bonusFinder === undefined || typeof o.bonusFinder === "boolean") &&
    (o.bonusOptimizer === undefined || typeof o.bonusOptimizer === "boolean") &&
    (o.athena === undefined || typeof o.athena === "boolean") &&
    typeof o.sessionVersion === "number" &&
    typeof o.created_at === "string" &&
    typeof o.updated_at === "string"
  );
}

/**
 * In-memory-cache av användarlistan. PROBLEM (fix 2026-06-13): readAllUsers()
 * gör en SYNKRON disk-läsning (+ migrate/init-fs-anrop) av users.json, och den
 * anropas via getAuthFromRequest() på VARJE inloggad API-request — ofta två
 * gånger för /api/admin/*. På Renders nätverksanslutna persistent-disk är varje
 * sådan läsning långsam OCH blockerar Nodes event-loop → hela den inloggade
 * upplevelsen (källor, valuebets, polls) blev seg. users.json ändras däremot
 * extremt sällan (bara när admin skapar/ändrar en user), så en kort TTL-cache
 * eliminerar i praktiken all per-request-disk-I/O. Single-instance på Render
 * (samma antagande som rate-limit-mappen) → in-memory är säkert.
 *
 * Writes uppdaterar cachen synkront med exakt den skrivna listan, så läsningar
 * direkt efter en write alltid ser färska data (ingen TTL-fördröjning vid skriv).
 */
let usersCache: { at: number; users: AppUser[] } | null = null;
const USERS_CACHE_TTL_MS = Number(process.env.APP_USERS_CACHE_TTL_MS) || 5_000;

function readAllUsers(): AppUser[] {
  const cached = usersCache;
  if (cached && Date.now() - cached.at < USERS_CACHE_TTL_MS) {
    // Returnera en kopia så att callers som muterar arrayen (.sort/.push i
    // listAppUsers/createAppUser) aldrig korrumperar den delade cachen.
    return cached.users.slice();
  }
  const users = loadUsersFromDisk();
  usersCache = { at: Date.now(), users };
  return users.slice();
}

function loadUsersFromDisk(): AppUser[] {
  migrateUsersIfNeeded();
  const filePath = resolveUsersFilePath();
  initializeEmptyJsonArray(filePath, STORAGE_LABEL);

  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[${STORAGE_LABEL}] Expected JSON array — resetting to empty list`);
      backupCorruptJsonFile(filePath, STORAGE_LABEL);
      writeAllUsers([]);
      return [];
    }
    return parsed.filter(isAppUser);
  } catch (e) {
    console.warn(`[${STORAGE_LABEL}] read failed:`, e instanceof Error ? e.message : e);
    backupCorruptJsonFile(filePath, STORAGE_LABEL);
    try {
      writeAllUsers([]);
    } catch {
      /* ignore secondary failure */
    }
    return [];
  }
}

function writeAllUsers(users: AppUser[]): void {
  atomicWriteJson(resolveUsersFilePath(), users);
  // Håll cachen i synk med disk så efterföljande läsningar är omedelbart färska.
  usersCache = { at: Date.now(), users: users.slice() };
}

/**
 * Custom error class för storage-misconfig så API-lager kan returnera 503
 * "service unavailable" istället för 500. Märker requests så frontend kan
 * visa felmeddelandet till admin.
 */
export class PersistentStorageNotConfiguredError extends Error {
  readonly missingEnvVars: string[];
  readonly httpStatus = 503;
  constructor(reason: string, missingEnvVars: string[]) {
    super(reason);
    this.name = "PersistentStorageNotConfiguredError";
    this.missingEnvVars = missingEnvVars;
  }
}

/**
 * Hard-block mot writes i prod om APP_USERS_DATA_DIR saknas. Bättre att
 * neka create än att spara på ephemeral disk och förlora data vid deploy.
 */
function assertPersistentStorageBeforeWrite(): void {
  const gate = requirePersistentStorageOrFail(["APP_USERS_DATA_DIR"]);
  if (!gate.ok) {
    console.error(`[${STORAGE_LABEL}] write refused: ${gate.reason}`);
    throw new PersistentStorageNotConfiguredError(gate.reason, gate.missingEnvVars);
  }
}

export function getAppUsersStorageStatus(): AppUsersStorageStatus {
  migrateUsersIfNeeded();
  const filePath = resolveUsersFilePath();
  initializeEmptyJsonArray(filePath, STORAGE_LABEL);
  ensureDir(resolveUsersDataDir());

  const users = readAllUsers();
  const onRender = process.env.RENDER === "true";
  const usingEnv = Boolean(process.env.APP_USERS_DATA_DIR?.trim());

  return {
    users_file_path: filePath,
    users_file_exists: fs.existsSync(filePath),
    users_count: users.length,
    users_data_dir: resolveUsersDataDir(),
    using_env_data_dir: usingEnv,
    persistent_disk_recommended: onRender && !usingEnv,
  };
}

export function initAppUsersStorage(): void {
  try {
    migrateUsersIfNeeded();
    readAllUsers();
  } catch (e) {
    console.warn(`[${STORAGE_LABEL}] init failed:`, e instanceof Error ? e.message : e);
  }
}

export function listAppUsers(): AppUser[] {
  return readAllUsers().sort((a, b) => a.username.localeCompare(b.username));
}

export function getAppUserByUsername(username: string): AppUser | null {
  const u = username.trim().toLowerCase();
  return readAllUsers().find((x) => x.username.toLowerCase() === u) ?? null;
}

export function getAppUserById(id: string): AppUser | null {
  return readAllUsers().find((x) => x.id === id) ?? null;
}

export function verifyAppUserLogin(username: string, password: string): AppUser | null {
  const user = getAppUserByUsername(username);
  if (!user || !user.active) return null;
  if (!verifyPasswordHash(password, user.passwordHash)) return null;
  return user;
}

export function createAppUser(input: {
  username: string;
  password: string;
  active?: boolean;
  valuebets?: boolean;
  bonusFinder?: boolean;
  bonusOptimizer?: boolean;
  athena?: boolean;
}): AppUser | { error: string } {
  assertPersistentStorageBeforeWrite();
  const username = input.username.trim();
  if (!username) return { error: "username required" };
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username)) {
    return { error: "username: 2–64 tecken, bokstäver/siffror . _ -" };
  }
  if (getAppUserByUsername(username)) return { error: "username already exists" };

  const ts = nowIso();
  const user: AppUser = {
    id: `usr_${crypto.randomUUID()}`,
    username,
    passwordHash: hashPasswordScrypt(input.password),
    active: input.active !== false,
    valuebets: input.valuebets === true,
    bonusFinder: input.bonusFinder === true,
    bonusOptimizer: input.bonusOptimizer === true,
    athena: input.athena === true,
    sessionVersion: 1,
    created_at: ts,
    updated_at: ts,
  };
  const all = readAllUsers();
  all.push(user);
  writeAllUsers(all);
  return user;
}

export function updateAppUser(
  id: string,
  patch: { active?: boolean; password?: string; valuebets?: boolean; bonusFinder?: boolean; bonusOptimizer?: boolean; athena?: boolean },
): AppUser | { error: string } {
  assertPersistentStorageBeforeWrite();
  const all = readAllUsers();
  const idx = all.findIndex((u) => u.id === id);
  if (idx < 0) return { error: "User not found" };

  const cur = all[idx];
  const next: AppUser = {
    ...cur,
    active: patch.active !== undefined ? patch.active : cur.active,
    valuebets: patch.valuebets !== undefined ? patch.valuebets : cur.valuebets,
    bonusFinder: patch.bonusFinder !== undefined ? patch.bonusFinder : cur.bonusFinder,
    bonusOptimizer: patch.bonusOptimizer !== undefined ? patch.bonusOptimizer : cur.bonusOptimizer,
    athena: patch.athena !== undefined ? patch.athena : cur.athena,
    updated_at: nowIso(),
  };
  if (patch.password) {
    next.passwordHash = hashPasswordScrypt(patch.password);
    next.sessionVersion = cur.sessionVersion + 1;
  }
  all[idx] = next;
  writeAllUsers(all);
  return next;
}

export function deleteAppUser(id: string): { ok: true; username: string } | { error: string } {
  assertPersistentStorageBeforeWrite();
  const all = readAllUsers();
  const idx = all.findIndex((u) => u.id === id);
  if (idx < 0) return { error: "User not found" };
  const removed = all[idx];
  all.splice(idx, 1);
  writeAllUsers(all);
  return { ok: true, username: removed.username };
}

export function bumpAppUserSessionVersion(id: string): AppUser | { error: string } {
  assertPersistentStorageBeforeWrite();
  const all = readAllUsers();
  const idx = all.findIndex((u) => u.id === id);
  if (idx < 0) return { error: "User not found" };
  all[idx] = {
    ...all[idx],
    sessionVersion: all[idx].sessionVersion + 1,
    updated_at: nowIso(),
  };
  writeAllUsers(all);
  return all[idx];
}
