#!/usr/bin/env node
/**
 * Skapar testlicens TEST-OK-123 om den inte finns.
 *
 *   node scripts/seed-autoclicker-license.mjs [username]
 *   node scripts/seed-autoclicker-license.mjs --reset-device
 *   node scripts/seed-autoclicker-license.mjs --email kund@example.com
 *
 * Respekterar AUTOCLICKER_DATA_DIR (samma som servern).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const TEST_KEY = "TEST-OK-123";

function resolveDataDir() {
  const fromEnv = process.env.AUTOCLICKER_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "data");
}

const LICENSES_FILE = path.join(resolveDataDir(), "autoclicker-licenses.json");

function readAll() {
  if (!fs.existsSync(LICENSES_FILE)) return [];
  const raw = fs.readFileSync(LICENSES_FILE, "utf-8").trim();
  if (!raw) return [];
  return JSON.parse(raw);
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(LICENSES_FILE), { recursive: true });
  const tmp = `${LICENSES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, LICENSES_FILE);
}

const args = process.argv.slice(2);

if (args.includes("--reset-device")) {
  const all = readAll();
  const idx = all.findIndex((l) => l.license_key === TEST_KEY);
  if (idx < 0) {
    console.log(`ℹ  ${TEST_KEY} finns inte i ${LICENSES_FILE}`);
    console.log("   Kör utan flagga för att skapa.");
    process.exit(0);
  }
  all[idx] = { ...all[idx], device_id: null, updated_at: new Date().toISOString() };
  writeAll(all);
  console.log(`✓ Nollställde device_id för ${TEST_KEY}`);
  console.log(`  Fil: ${LICENSES_FILE}`);
  process.exit(0);
}

const emailArg = args.find((a) => a.startsWith("--email="))?.slice("--email=".length);
const positional = args.filter((a) => !a.startsWith("--"));
const username = positional[0]?.trim() || process.env.APP_USERNAME || "linus";
const customerEmail = emailArg?.trim() || null;

const all = readAll();
const existing = all.find((l) => l.license_key === TEST_KEY);
if (existing) {
  console.log(`ℹ  ${TEST_KEY} finns redan i ${LICENSES_FILE}`);
  console.log(`   username=${existing.username ?? "—"} expires=${existing.expires_at?.slice(0, 10)}`);
  console.log(`   device_id=${existing.device_id ?? "null"}`);
  process.exit(0);
}

const expires = new Date();
expires.setDate(expires.getDate() + 30);
const now = new Date().toISOString();

all.push({
  id: `lic_${crypto.randomUUID()}`,
  license_key: TEST_KEY,
  username,
  customer_email: customerEmail,
  active: true,
  expires_at: expires.toISOString(),
  device_id: null,
  max_devices: 1,
  notes: "Seed test license",
  created_at: now,
  updated_at: now,
});

writeAll(all);
console.log(`✓ Skapade ${TEST_KEY}`);
console.log(`  username: ${username}`);
console.log(`  customer_email: ${customerEmail ?? "—"}`);
console.log(`  active: true`);
console.log(`  expires_at: ${expires.toISOString().slice(0, 10)}`);
console.log(`  device_id: null`);
console.log(`  max_devices: 1`);
console.log(`  Fil: ${LICENSES_FILE}`);
