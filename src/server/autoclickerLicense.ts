/**
 * Autoclicker-licenser — filbaserad lagring (Render-ready).
 *
 * Env (Render persistent disk):
 *   AUTOCLICKER_DATA_DIR      → katalog för autoclicker-licenses.json
 *   AUTOCLICKER_DOWNLOAD_DIR  → katalog för autoclicker-share.zip
 *
 * Production paths på Render (disk mount: .matched-betting-cache):
 *   .../autoclicker-data/licenses/autoclicker-licenses.json
 *   .../autoclicker-data/downloads/autoclicker-share.zip
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  atomicWriteJson,
  backupCorruptJsonFile,
  ensureDir,
  initializeEmptyJsonArray,
  legacyDataPath,
  migrateLegacyJsonIfMissing,
  requirePersistentStorageOrFail,
} from "./persistentStorage";
import { makeZip } from "./miniZip";

/** Distributionsfiler som ingår i autoclicker-share.zip (källkoden ligger i autoclicker/). */
const AUTOCLICKER_DIST_FILES = [
  "playwright_bot.py",
  "license_client.py",
  "sites.json",
  "requirements.txt",
  "setup.sh",
  "run.sh",
  "setup-windows.bat",
  "run-windows.bat",
  "README.txt",
];

function autoclickerSourceDir(): string {
  return process.env.AUTOCLICKER_SOURCE_DIR?.trim() || path.resolve(process.cwd(), "autoclicker");
}

/** Custom error så API kan returnera 503 istället för 500 vid storage-misconfig. */
export class AutoclickerStorageNotConfiguredError extends Error {
  readonly missingEnvVars: string[];
  readonly httpStatus = 503;
  constructor(reason: string, missingEnvVars: string[]) {
    super(reason);
    this.name = "AutoclickerStorageNotConfiguredError";
    this.missingEnvVars = missingEnvVars;
  }
}

/** Hard-block mot writes i prod om AUTOCLICKER_DATA_DIR saknas. */
function assertPersistentStorageBeforeLicenseWrite(): void {
  const gate = requirePersistentStorageOrFail(["AUTOCLICKER_DATA_DIR"]);
  if (!gate.ok) {
    console.error(`[autoclicker-license] write refused: ${gate.reason}`);
    throw new AutoclickerStorageNotConfiguredError(gate.reason, gate.missingEnvVars);
  }
}

export type BotLicense = {
  id: string;
  license_key: string;
  username: string | null;
  customer_email: string | null;
  active: boolean;
  expires_at: string;
  device_id: string | null;
  max_devices: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type BotLicenseValidateResult =
  | { ok: true; expires_at: string; message: string }
  | { ok: false; message: string };

export type AutoclickerStorageStatus = {
  license_file_path: string;
  license_file_exists: boolean;
  license_count: number;
  active_license_count: number;
  zip_file_path: string;
  zip_exists: boolean;
  zip_file_size_bytes: number | null;
  data_dir: string;
  download_dir: string;
  using_env_data_dir: boolean;
  using_env_download_dir: boolean;
  persistent_disk_recommended: boolean;
};

const LICENSE_FILENAME = "autoclicker-licenses.json";
const ZIP_FILENAME = "autoclicker-share.zip";
const MAX_ZIP_UPLOAD_BYTES = 50 * 1024 * 1024;

function resolveDataDir(): string {
  const fromEnv = process.env.AUTOCLICKER_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "data");
}

function resolveDownloadDir(): string {
  const fromEnv = process.env.AUTOCLICKER_DOWNLOAD_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "private_downloads");
}

function licensesFilePath(): string {
  return path.join(resolveDataDir(), LICENSE_FILENAME);
}

function downloadFilePath(): string {
  return path.join(resolveDownloadDir(), ZIP_FILENAME);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function isBotLicense(x: unknown): x is BotLicense {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.license_key === "string" &&
    typeof o.active === "boolean" &&
    typeof o.expires_at === "string" &&
    typeof o.max_devices === "number" &&
    typeof o.created_at === "string" &&
    typeof o.updated_at === "string"
  );
}

function backupCorruptLicenseFile(filePath: string): void {
  backupCorruptJsonFile(filePath, "bot-license");
}

function migrateLicensesIfNeeded(): void {
  const target = licensesFilePath();
  const legacy = legacyDataPath(LICENSE_FILENAME);
  if (target === legacy) return;
  migrateLegacyJsonIfMissing(
    target,
    legacy,
    "Migrated licenses from data/autoclicker-licenses.json to persistent storage",
  );
}

function initializeLicenseFileIfMissing(): void {
  migrateLicensesIfNeeded();
  const filePath = licensesFilePath();
  initializeEmptyJsonArray(filePath, "bot-license");
}

function readAllLicenses(): BotLicense[] {
  initializeLicenseFileIfMissing();
  ensureDir(resolveDownloadDir());

  const filePath = licensesFilePath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[bot-license] Expected JSON array — resetting to empty list");
      backupCorruptLicenseFile(filePath);
      writeAllLicenses([]);
      return [];
    }
    return parsed.filter(isBotLicense);
  } catch (e) {
    console.warn("[bot-license] read failed:", e instanceof Error ? e.message : e);
    backupCorruptLicenseFile(filePath);
    try {
      writeAllLicenses([]);
    } catch {
      /* ignore secondary failure */
    }
    return [];
  }
}

function writeAllLicenses(licenses: BotLicense[]): void {
  atomicWriteJson(licensesFilePath(), licenses);
}

export function getAutoclickerStorageStatus(): AutoclickerStorageStatus {
  initializeLicenseFileIfMissing();
  ensureDir(resolveDownloadDir());

  const licensePath = licensesFilePath();
  const zipPath = downloadFilePath();
  const licenses = readAllLicenses();
  const now = Date.now();
  const activeCount = licenses.filter((l) => {
    if (!l.active) return false;
    const exp = Date.parse(l.expires_at);
    return Number.isFinite(exp) && exp >= now;
  }).length;

  const onRender = process.env.RENDER === "true";
  const usingEnv =
    Boolean(process.env.AUTOCLICKER_DATA_DIR?.trim()) ||
    Boolean(process.env.AUTOCLICKER_DOWNLOAD_DIR?.trim());

  let zipFileSize: number | null = null;
  if (fs.existsSync(zipPath)) {
    try {
      zipFileSize = fs.statSync(zipPath).size;
    } catch {
      zipFileSize = null;
    }
  }

  return {
    license_file_path: licensePath,
    license_file_exists: fs.existsSync(licensePath),
    license_count: licenses.length,
    active_license_count: activeCount,
    zip_file_path: zipPath,
    zip_exists: fs.existsSync(zipPath),
    zip_file_size_bytes: zipFileSize,
    data_dir: resolveDataDir(),
    download_dir: resolveDownloadDir(),
    using_env_data_dir: Boolean(process.env.AUTOCLICKER_DATA_DIR?.trim()),
    using_env_download_dir: Boolean(process.env.AUTOCLICKER_DOWNLOAD_DIR?.trim()),
    persistent_disk_recommended: onRender && !usingEnv,
  };
}

export function findLicenseByKey(licenseKey: string): BotLicense | null {
  const key = licenseKey.trim();
  return readAllLicenses().find((l) => l.license_key === key) ?? null;
}

export function findActiveLicenseForUsername(username: string): BotLicense | null {
  const now = Date.now();
  return (
    readAllLicenses().find((l) => {
      if (l.username !== username) return false;
      if (!l.active) return false;
      const exp = Date.parse(l.expires_at);
      if (!Number.isFinite(exp) || exp < now) return false;
      return true;
    }) ?? null
  );
}

function isExpired(license: BotLicense): boolean {
  const exp = Date.parse(license.expires_at);
  return !Number.isFinite(exp) || exp < Date.now();
}

export function validateBotLicense(
  licenseKey: string,
  deviceId: string,
): BotLicenseValidateResult {
  const key = licenseKey.trim();
  if (!key) {
    return { ok: false, message: "Missing license_key" };
  }

  const license = findLicenseByKey(key);
  if (!license || !license.active || isExpired(license)) {
    return { ok: false, message: "License inactive or expired" };
  }

  // Enhetslåsning BORTTAGEN (2026-06-17): en licens funkar på flera enheter.
  // Vi nekar aldrig en annan enhet längre. Sparar senast sedda device_id som
  // info (best-effort) men det påverkar inte valideringen.
  const device = deviceId.trim();
  if (device && (license.device_id?.trim() || null) !== device) {
    try {
      const all = readAllLicenses();
      const idx = all.findIndex((l) => l.id === license.id);
      if (idx >= 0) {
        all[idx] = { ...all[idx], device_id: device, updated_at: nowIso() };
        writeAllLicenses(all);
      }
    } catch {
      /* best-effort — får inte blockera en giltig licens */
    }
  }

  return {
    ok: true,
    expires_at: license.expires_at.slice(0, 10),
    message: "License active",
  };
}

export function listLicenses(): BotLicense[] {
  return readAllLicenses().sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
}

export function createLicense(input: {
  license_key: string;
  username?: string | null;
  customer_email?: string | null;
  active?: boolean;
  expires_at: string;
  max_devices?: number;
  notes?: string | null;
}): BotLicense | { error: string } {
  assertPersistentStorageBeforeLicenseWrite();
  const key = input.license_key.trim();
  if (!key) return { error: "license_key required" };
  if (findLicenseByKey(key)) return { error: "license_key already exists" };

  const ts = nowIso();
  const license: BotLicense = {
    id: `lic_${crypto.randomUUID()}`,
    license_key: key,
    username: input.username?.trim() || null,
    customer_email: input.customer_email?.trim() || null,
    active: input.active !== false,
    expires_at: input.expires_at,
    device_id: null,
    max_devices: input.max_devices ?? 1,
    notes: input.notes?.trim() || null,
    created_at: ts,
    updated_at: ts,
  };
  const all = readAllLicenses();
  all.push(license);
  writeAllLicenses(all);
  return license;
}

export function updateLicense(
  id: string,
  patch: Partial<
    Pick<
      BotLicense,
      "username" | "customer_email" | "active" | "expires_at" | "max_devices" | "notes"
    >
  >,
): BotLicense | { error: string } {
  assertPersistentStorageBeforeLicenseWrite();
  const all = readAllLicenses();
  const idx = all.findIndex((l) => l.id === id);
  if (idx < 0) return { error: "License not found" };

  const cur = all[idx];
  const next: BotLicense = {
    ...cur,
    username: patch.username !== undefined ? patch.username : cur.username,
    customer_email: patch.customer_email !== undefined ? patch.customer_email : cur.customer_email,
    active: patch.active !== undefined ? patch.active : cur.active,
    expires_at: patch.expires_at !== undefined ? patch.expires_at : cur.expires_at,
    max_devices: patch.max_devices !== undefined ? patch.max_devices : cur.max_devices,
    notes: patch.notes !== undefined ? patch.notes : cur.notes,
    updated_at: nowIso(),
  };
  all[idx] = next;
  writeAllLicenses(all);
  return next;
}

export function resetLicenseDevice(id: string): BotLicense | { error: string } {
  assertPersistentStorageBeforeLicenseWrite();
  const all = readAllLicenses();
  const idx = all.findIndex((l) => l.id === id);
  if (idx < 0) return { error: "License not found" };
  all[idx] = { ...all[idx], device_id: null, updated_at: nowIso() };
  writeAllLicenses(all);
  return all[idx];
}

/** Radera en licens via id. */
export function deleteLicense(id: string): { ok: true } | { error: string } {
  assertPersistentStorageBeforeLicenseWrite();
  const all = readAllLicenses();
  const remaining = all.filter((l) => l.id !== id);
  if (remaining.length === all.length) return { error: "License not found" };
  writeAllLicenses(remaining);
  return { ok: true };
}

/** Återkalla (radera) ALLA licenser kopplade till ett användarnamn. Returnerar antal. */
export function deleteLicensesForUsername(username: string): number {
  assertPersistentStorageBeforeLicenseWrite();
  const uname = username.trim();
  const all = readAllLicenses();
  const remaining = all.filter((l) => l.username !== uname);
  const removed = all.length - remaining.length;
  if (removed > 0) writeAllLicenses(remaining);
  return removed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("FILE_TOO_LARGE");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function splitBufferByDelimiter(buf: Buffer, delim: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let idx = buf.indexOf(delim, start);
  while (idx !== -1) {
    if (idx > start) parts.push(buf.subarray(start, idx));
    start = idx + delim.length;
    idx = buf.indexOf(delim, start);
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

function parseMultipartFileField(
  body: Buffer,
  contentType: string,
): { ok: true; filename: string; data: Buffer } | { ok: false; error: string } {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    return { ok: false, error: "Missing multipart boundary" };
  }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBufferByDelimiter(body, delimiter);

  for (const part of parts) {
    if (part.length < 8) continue;
    let trimmed = part;
    if (trimmed[0] === 0x0d && trimmed[1] === 0x0a) trimmed = trimmed.subarray(2);
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = trimmed.subarray(0, headerEnd).toString("utf-8");
    if (!/Content-Disposition:\s*form-data/i.test(headers)) continue;
    const filenameMatch =
      /filename="([^"]+)"/i.exec(headers) ?? /filename=([^\s\r\n;]+)/i.exec(headers);
    if (!filenameMatch) continue;
    let data = trimmed.subarray(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.subarray(0, data.length - 2);
    }
    return { ok: true, filename: filenameMatch[1], data };
  }

  return { ok: false, error: "No file in upload (use field name 'file')" };
}

function isZipFilename(filename: string): boolean {
  return filename.trim().toLowerCase().endsWith(".zip");
}

function looksLikeZip(data: Buffer): boolean {
  if (data.length < 4) return false;
  return data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);
}

function saveAutoclickerZipFile(data: Buffer): { ok: true; path: string; size: number } | { ok: false; error: string } {
  const dir = resolveDownloadDir();
  ensureDir(dir);
  const dest = downloadFilePath();
  const tmp = `${dest}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
    return { ok: true, path: dest, size: data.length };
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save zip" };
  }
}

/** Läs ihop källfilerna till en zip-buffer (eller null om inga finns). */
function readAutoclickerSourceEntries(): { name: string; data: Buffer }[] {
  const dir = autoclickerSourceDir();
  const entries: { name: string; data: Buffer }[] = [];
  for (const f of AUTOCLICKER_DIST_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) entries.push({ name: f, data: fs.readFileSync(p) });
  }
  return entries;
}

/** RAM-cachad zip byggd från källkoden — serveras direkt i /autoclicker/download.
 *  Byggs en gång per process; vid deploy/omstart byggs den om från ny källkod. */
let cachedSourceZip: Buffer | null = null;
export function getAutoclickerSourceZipBuffer(): Buffer | null {
  if (cachedSourceZip) return cachedSourceZip;
  try {
    const entries = readAutoclickerSourceEntries();
    if (entries.length === 0) return null;
    cachedSourceZip = makeZip(entries);
    return cachedSourceZip;
  } catch {
    return null;
  }
}

/** Bygg autoclicker-share.zip från källkoden i autoclicker/ och publicera den. */
export function buildAutoclickerZipFromSource():
  | { ok: true; size: number; files: string[]; path: string }
  | { ok: false; error: string } {
  try {
    const entries = readAutoclickerSourceEntries();
    if (entries.length === 0) {
      return { ok: false, error: `Inga autoclicker-källfiler hittades i ${autoclickerSourceDir()}` };
    }
    const zip = makeZip(entries);
    const saved = saveAutoclickerZipFile(zip);
    if (!saved.ok) return { ok: false, error: saved.error };
    return { ok: true, size: saved.size, files: entries.map((e) => e.name), path: saved.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Zip-bygge misslyckades" };
  }
}

function normalizeApiPath(url: string | undefined): string {
  const path = url?.split("?")[0] ?? "";
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/** GET /api/autoclicker/health — publik hälsokoll (kraschar aldrig). */
export function autoclickerHealthApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const url = normalizeApiPath(req.url);
  if (url !== "/api/autoclicker/health") {
    next();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "Use GET" });
    return;
  }

  try {
    const s = getAutoclickerStorageStatus();
    const issues: string[] = [];
    if (!s.license_file_exists) issues.push("license file missing");
    if (!s.zip_exists) issues.push("zip missing");
    if (s.persistent_disk_recommended) {
      issues.push("set AUTOCLICKER_DATA_DIR and AUTOCLICKER_DOWNLOAD_DIR on persistent disk");
    }

    sendJson(res, 200, {
      ok: true,
      license_file_exists: s.license_file_exists,
      license_count: s.license_count,
      active_license_count: s.active_license_count,
      zip_exists: s.zip_exists,
      expected_license_path: s.license_file_path,
      expected_zip_path: s.zip_file_path,
      data_dir: s.data_dir,
      download_dir: s.download_dir,
      message:
        issues.length === 0
          ? "Autoclicker storage OK"
          : `Autoclicker storage issues: ${issues.join("; ")}`,
    });
  } catch (e) {
    sendJson(res, 200, {
      ok: true,
      license_file_exists: false,
      license_count: 0,
      active_license_count: 0,
      zip_exists: false,
      expected_license_path: licensesFilePath(),
      expected_zip_path: downloadFilePath(),
      message: e instanceof Error ? e.message : "Health check degraded",
    });
  }
}

/** POST /api/bot-license — publik (botten), alltid JSON-svar. */
export async function botLicenseApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const url = normalizeApiPath(req.url);
  if (url !== "/api/bot-license") {
    next();
    return;
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "Use POST" });
    return;
  }

  let parsed: { license_key?: unknown; device_id?: unknown; bot_version?: unknown };
  try {
    const body = await readBody(req);
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    sendJson(res, 400, { ok: false, message: "Invalid JSON" });
    return;
  }

  const licenseKey = typeof parsed.license_key === "string" ? parsed.license_key : "";
  const deviceId = typeof parsed.device_id === "string" ? parsed.device_id : "";
  if (!licenseKey.trim() || !deviceId.trim()) {
    sendJson(res, 400, { ok: false, message: "Missing license_key or device_id" });
    return;
  }

  const result = validateBotLicense(licenseKey, deviceId);
  sendJson(res, 200, result);
}

/** GET /api/autoclicker/status — inloggad användare. */
export function autoclickerStatusApi(
  req: IncomingMessage,
  res: ServerResponse,
  username: string,
  next: () => void,
): void {
  const url = req.url?.split("?")[0];
  if (url !== "/api/autoclicker/status") {
    next();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Use GET" });
    return;
  }

  const license = findActiveLicenseForUsername(username);
  if (!license) {
    sendJson(res, 200, { ok: true, active: false });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    active: true,
    license_key: license.license_key,
    expires_at: license.expires_at,
  });
}

/** GET /api/autoclicker/download eller /autoclicker/download — zip om aktiv licens. */
export function autoclickerDownloadApi(
  req: IncomingMessage,
  res: ServerResponse,
  username: string,
  next: () => void,
): void {
  const url = req.url?.split("?")[0];
  if (url !== "/api/autoclicker/download" && url !== "/autoclicker/download") {
    next();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Use GET" });
    return;
  }

  const license = findActiveLicenseForUsername(username);
  if (!license) {
    sendJson(res, 403, { ok: false, error: "No active autoclicker license" });
    return;
  }

  // Serveras AUTOMATISKT från den medföljande källkoden (autoclicker/) → varje
  // kund får alltid den senaste boten, utan att admin behöver ladda upp/bygga zip.
  // Uppdateras automatiskt vid varje deploy (RAM-cachen byggs om vid omstart).
  const sourceZip = getAutoclickerSourceZipBuffer();
  if (sourceZip) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="autoclicker-share.zip"');
    res.setHeader("Content-Length", String(sourceZip.length));
    res.setHeader("Cache-Control", "no-store");
    res.end(sourceZip);
    return;
  }

  // Fallback: tidigare uppladdad/disk-sparad zip (om källkoden saknas).
  const zipPath = downloadFilePath();
  if (!fs.existsSync(zipPath)) {
    sendJson(res, 503, {
      ok: false,
      error: `Download file missing. Expected: ${zipPath}`,
    });
    return;
  }

  const stat = fs.statSync(zipPath);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="autoclicker-share.zip"');
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(zipPath).pipe(res);
}

const AUTOCLICKER_ZIP_UPLOAD_PATHS = new Set([
  "/api/admin/autoclicker-licenses/upload-zip",
  "/admin/autoclicker-licenses/upload-zip",
]);

/** POST upload — sparar autoclicker-share.zip (max 50 MB, endast .zip). */
export async function adminAutoclickerUploadZipApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "";
  if (!AUTOCLICKER_ZIP_UPLOAD_PATHS.has(url)) {
    next();
    return;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Use POST" });
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("multipart/form-data")) {
    sendJson(res, 400, {
      ok: false,
      error: "Expected multipart/form-data with a .zip file",
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBodyBuffer(req, MAX_ZIP_UPLOAD_BYTES + 256 * 1024);
  } catch (e) {
    if (e instanceof Error && e.message === "FILE_TOO_LARGE") {
      sendJson(res, 413, { ok: false, error: "File too large (max 50 MB)" });
      return;
    }
    sendJson(res, 400, { ok: false, error: "Failed to read upload" });
    return;
  }

  const parsed = parseMultipartFileField(body, contentType);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return;
  }

  if (!isZipFilename(parsed.filename)) {
    sendJson(res, 400, {
      ok: false,
      error: `Wrong file type: "${parsed.filename}" — only .zip files are accepted`,
    });
    return;
  }

  if (parsed.data.length === 0) {
    sendJson(res, 400, { ok: false, error: "Uploaded file is empty" });
    return;
  }

  if (parsed.data.length > MAX_ZIP_UPLOAD_BYTES) {
    sendJson(res, 413, { ok: false, error: "File too large (max 50 MB)" });
    return;
  }

  if (!looksLikeZip(parsed.data)) {
    sendJson(res, 400, {
      ok: false,
      error: "File does not look like a valid zip archive",
    });
    return;
  }

  const saved = saveAutoclickerZipFile(parsed.data);
  if (!saved.ok) {
    sendJson(res, 500, { ok: false, error: saved.error });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    message: "autoclicker-share.zip uploaded",
    path: saved.path,
    size_bytes: saved.size,
    storage: getAutoclickerStorageStatus(),
  });
}

/** Admin CRUD: /api/admin/autoclicker-licenses (+ storage i GET) */
export async function adminAutoclickerLicensesApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "";
  const base = "/api/admin/autoclicker-licenses";
  if (!url.startsWith(base)) {
    next();
    return;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Generera share-zip från den medföljande källkoden (autoclicker/) och publicera
  // den som kundernas nedladdning — ett klick, inget lokalt zip-bygge behövs.
  if (url === "/api/admin/autoclicker-licenses/build-zip" && req.method === "POST") {
    const r = buildAutoclickerZipFromSource();
    if (!r.ok) {
      sendJson(res, 500, { ok: false, error: r.error });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      message: `Byggde autoclicker-share.zip (${r.files.length} filer)`,
      size_bytes: r.size,
      files: r.files,
      storage: getAutoclickerStorageStatus(),
    });
    return;
  }

  const resetMatch = url.match(/^\/api\/admin\/autoclicker-licenses\/([^/]+)\/reset-device$/);
  if (resetMatch && req.method === "POST") {
    const result = resetLicenseDevice(resetMatch[1]);
    if ("error" in result) {
      sendJson(res, 404, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, license: result });
    return;
  }

  const idMatch = url.match(/^\/api\/admin\/autoclicker-licenses\/([^/]+)$/);
  if (idMatch && req.method === "PUT") {
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const result = updateLicense(idMatch[1], {
      username: typeof patch.username === "string" ? patch.username : patch.username === null ? null : undefined,
      customer_email:
        typeof patch.customer_email === "string"
          ? patch.customer_email
          : patch.customer_email === null
            ? null
            : undefined,
      active: typeof patch.active === "boolean" ? patch.active : undefined,
      expires_at: typeof patch.expires_at === "string" ? patch.expires_at : undefined,
      max_devices: typeof patch.max_devices === "number" ? patch.max_devices : undefined,
      notes:
        typeof patch.notes === "string" ? patch.notes : patch.notes === null ? null : undefined,
    });
    if ("error" in result) {
      sendJson(res, 404, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, license: result });
    return;
  }

  if (idMatch && req.method === "DELETE") {
    const result = deleteLicense(idMatch[1]);
    if ("error" in result) {
      sendJson(res, 404, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url === base && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      licenses: listLicenses(),
      storage: getAutoclickerStorageStatus(),
    });
    return;
  }

  if (url === base && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const expiresAt =
      typeof body.expires_at === "string"
        ? body.expires_at
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = createLicense({
      license_key: typeof body.license_key === "string" ? body.license_key : "",
      username: typeof body.username === "string" ? body.username : null,
      customer_email: typeof body.customer_email === "string" ? body.customer_email : null,
      active: typeof body.active === "boolean" ? body.active : true,
      expires_at: expiresAt,
      max_devices: typeof body.max_devices === "number" ? body.max_devices : 1,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    if ("error" in result) {
      sendJson(res, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 201, { ok: true, license: result });
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method not allowed" });
}

/** Init at server boot — skapar dirs/filer om de saknas. */
export function initAutoclickerStorage(): void {
  try {
    initializeLicenseFileIfMissing();
    ensureDir(resolveDownloadDir());
  } catch (e) {
    console.warn("[bot-license] init failed:", e instanceof Error ? e.message : e);
  }
}
