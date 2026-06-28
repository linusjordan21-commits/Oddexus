/**
 * Server-side bet-store (per användare). Möjliggör server-side CLV-fångst +
 * auto-settle UTAN att kunden är inne — bakgrundsjobbet i vite.config.ts
 * itererar alla användares bets och uppdaterar closingFairOdds/result.
 *
 * Lagras som { [username]: StoredBet[] } i <APP_USERS_DATA_DIR>/user-bets.json
 * (samma persistent Render-disk som users/licenser). Klienten synkar sin
 * localStorage ↔ denna store via /api/user/bets.
 */
import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  ensureDir,
  requirePersistentStorageOrFail,
  backupCorruptJsonFile,
} from "./persistentStorage";

/** Lös typ — vi bevarar alla klient-fält (index signature) och rör bara dem vi behöver. */
export interface StoredBet {
  id: string;
  match?: string;
  outcome?: string;
  startTs?: string;
  sport?: string;
  bookOdds?: number;
  status?: string;
  closingFairOdds?: number;
  clvAuto?: boolean;
  result?: string;
  settledAt?: string;
  [key: string]: unknown;
}

function dataDir(): string {
  return (
    process.env.BET_STORE_DATA_DIR?.trim() ||
    process.env.APP_USERS_DATA_DIR?.trim() ||
    path.resolve(process.cwd(), "data")
  );
}
function storeFile(): string {
  return path.join(dataDir(), "user-bets.json");
}

function readAll(): Record<string, StoredBet[]> {
  const file = storeFile();
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, StoredBet[]>;
    }
    return {};
  } catch (e) {
    backupCorruptJsonFile(file, "bet-store");
    console.warn("[bet-store] kunde inte läsa user-bets.json:", e instanceof Error ? e.message : e);
    return {};
  }
}

function writeAll(data: Record<string, StoredBet[]>): void {
  // BUGGFIX 2026-06-15: krävde tidigare DEFAULT-listan (APP_USERS_DATA_DIR +
  // AUTOCLICKER_DATA_DIR + AUTOCLICKER_DOWNLOAD_DIR). Bet-storen behöver bara
  // sin egen dir. Om autoclicker-varianterna saknades på Render kastade VARJE
  // sparning → bets persisterades aldrig server-side (tom backup → bets kunde
  // försvinna utan räddning). Kräv bara det storen faktiskt använder.
  const gate = requirePersistentStorageOrFail(["APP_USERS_DATA_DIR"]);
  if (!gate.ok) throw new Error((gate as { reason?: string }).reason ?? "Persistent storage not configured");
  ensureDir(dataDir());
  atomicWriteJson(storeFile(), data);
}

export function getUserBets(username: string): StoredBet[] {
  return readAll()[username] ?? [];
}

export function setUserBets(username: string, bets: StoredBet[]): void {
  const all = readAll();
  const incoming = Array.isArray(bets) ? bets.slice(0, 5000) : [];
  const existing = all[username] ?? [];
  // SÄKERHETSNÄT: om klienten skickar FÄRRE bets än servern redan har (möjlig
  // oavsiktlig rensning / dataförlust i webbläsaren), spara en backup av hela
  // filen INNAN vi skriver över — så raderade bets kan återställas manuellt.
  if (existing.length > incoming.length) {
    try {
      const file = storeFile();
      if (fs.existsSync(file)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(file, `${file}.shrink-${stamp}.bak`);
        console.warn(
          `[bet-store] ${username}: ${existing.length}→${incoming.length} bets — backup sparad (${file}.shrink-${stamp}.bak)`,
        );
      }
    } catch (e) {
      console.warn("[bet-store] kunde inte spara shrink-backup:", e instanceof Error ? e.message : e);
    }
  }
  all[username] = incoming;
  writeAll(all);
}

/** Alla användares bets — för bakgrundsjobbet. */
export function allUserBets(): Record<string, StoredBet[]> {
  return readAll();
}

/**
 * Applicera patchar på flera bets i ett svep (för bakgrundsjobbet). patches:
 * Map<username, Map<betId, Partial<StoredBet>>>. Skriver bara om något ändrats.
 */
export function applyBetPatches(patches: Array<{ username: string; id: string; patch: Partial<StoredBet> }>): number {
  if (patches.length === 0) return 0;
  const all = readAll();
  let changed = 0;
  for (const { username, id, patch } of patches) {
    const list = all[username];
    if (!Array.isArray(list)) continue;
    const i = list.findIndex((b) => b.id === id);
    if (i < 0) continue;
    list[i] = { ...list[i], ...patch };
    changed += 1;
  }
  if (changed > 0) writeAll(all);
  return changed;
}
