import crypto from "node:crypto";

/** scrypt$N$r$p$saltBase64$hashBase64 — samma format som admin-auth. */
export function hashPasswordScrypt(password: string): string {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPasswordHash(password: string, hash: string): boolean {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  try {
    const derived = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function validateNewPassword(pw: string): string | null {
  if (typeof pw !== "string") return "Password required";
  if (pw.length < 10) return "Password must be at least 10 characters";
  if (!/[0-9]/.test(pw)) return "Password must include at least one digit";
  if (!/[a-zA-Z]/.test(pw)) return "Password must include at least one letter";
  if (pw.length > 200) return "Password too long";
  return null;
}
