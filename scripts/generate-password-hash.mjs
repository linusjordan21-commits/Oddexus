#!/usr/bin/env node
/**
 * Generera APP_PASSWORD_HASH för Render env vars.
 *
 * Användning:
 *   node scripts/generate-password-hash.mjs 'mitt-lösenord'
 *
 * Skriver ut: scrypt$N$r$p$saltBase64$hashBase64
 * Klistra in värdet i Render dashboard som APP_PASSWORD_HASH.
 *
 * Säkerhet: detta script kör BARA lokalt på din maskin. Lösenordet skickas
 * aldrig någonstans — det körs genom Node:s scrypt-implementation och
 * resultatet skrivs ut i terminalen.
 */
import crypto from "node:crypto";

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: node scripts/generate-password-hash.mjs 'your-password'");
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(pw, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });

const formatted = `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;

console.log("");
console.log("APP_PASSWORD_HASH:");
console.log(formatted);
console.log("");
console.log("SESSION_SECRET (random 32 bytes hex, generate ONCE — never rotate without re-login):");
console.log(crypto.randomBytes(32).toString("hex"));
console.log("");
console.log("Klistra in dessa två i Render → Service → Environment → Add Environment Variable.");
console.log("Sätt även APP_USERNAME till önskat användarnamn.");
