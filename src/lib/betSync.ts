/**
 * Synkar bet-loggen mellan localStorage och server-store (/api/user/bets).
 *
 * - pull: hämtar serverns bets och MERGAR in serverns auto-uppdateringar
 *   (closingFairOdds/CLV + auto-settle status/result) i de lokala. Server vinner
 *   bara för dessa fält och bara när lokalt fortfarande saknar dem / är "open".
 *   Övriga fält (stake, notes, manuell settle) ägs av klienten.
 * - push: skickar hela lokala listan till servern så bakgrundsjobbet ser dem.
 *
 * Kräver inloggad användare (cookie-session). Vid 401/fel: tyst no-op (appen
 * fungerar localStorage-only som tidigare).
 */
import { apiUrl } from "./apiUrl";
import type { LoggedBet } from "./betLogTypes";
import { loadBets, persistAllBets } from "./betLogStorage";

async function getServerBets(): Promise<LoggedBet[] | null> {
  try {
    const res = await fetch(apiUrl("/api/user/bets"), { credentials: "include" });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; bets?: LoggedBet[] };
    return json?.ok && Array.isArray(json.bets) ? json.bets : null;
  } catch {
    return null;
  }
}

export async function pushBetsToServer(bets?: LoggedBet[]): Promise<void> {
  try {
    await fetch(apiUrl("/api/user/bets"), {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bets: bets ?? loadBets() }),
    });
  } catch {
    /* tyst — localStorage är fortfarande sanningskälla lokalt */
  }
}

/**
 * Mergar serverns auto-uppdateringar in i lokala bets. Returnerar true om något
 * ändrades lokalt (så anroparen kan refresha UI:t).
 */
export async function pullAndMergeBets(): Promise<boolean> {
  const server = await getServerBets();
  if (!server) return false;
  const local = loadBets();
  const byId = new Map(local.map((b) => [b.id, b]));
  let changed = false;

  for (const s of server) {
    const l = byId.get(s.id);
    if (!l) {
      // Bet finns på servern men inte lokalt (annan enhet) → lägg till.
      byId.set(s.id, s);
      changed = true;
      continue;
    }
    const patch: Partial<LoggedBet> = {};
    // CLV auto-fångad på servern men saknas lokalt.
    if (l.closingFairOdds == null && s.closingFairOdds != null) {
      patch.closingFairOdds = s.closingFairOdds;
      patch.clvAuto = s.clvAuto;
    }
    // Auto-settlad på servern medan lokalt fortfarande öppet.
    if (l.status === "open" && s.status && s.status !== "open") {
      patch.status = s.status;
      patch.result = s.result;
      patch.settledAt = s.settledAt;
    }
    if (Object.keys(patch).length > 0) {
      byId.set(s.id, { ...l, ...patch });
      changed = true;
    }
  }

  if (changed) persistAllBets([...byId.values()]);
  return changed;
}

/** Engångs-synk: pulla+merga, sen pusha sammanslagningen så servern är ikapp. */
export async function syncBets(): Promise<boolean> {
  const changed = await pullAndMergeBets();
  await pushBetsToServer();
  return changed;
}
