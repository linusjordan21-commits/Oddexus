/**
 * Prenumerationer (Free / Basic / Pro) — prenumerations-motorn.
 *
 * Designval:
 *   - Egen lagring (subscriptions.json) kopplad via konto-ID (stabilt), inte
 *     användarnamn-sträng → licens och konto kan aldrig glida isär.
 *   - Prenumerationen DRIVER befintlig åtkomst i stället för att skriva om den:
 *       • valuebets-flaggan på användaren
 *       • autoclicker-licensen (skapas/raderas automatiskt)
 *     Så inget i den känsliga inloggnings-/access-koden behöver ändras.
 *   - Automatisk utgång: en sweep nollställer premium när perioden gått ut.
 *
 * Stripe (Fas 2) skriver till samma setSubscription() via webhooks.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson, ensureDir } from "./persistentStorage";
import { getAppUserById, updateAppUser } from "./appUsers";
import {
  createLicense,
  deleteLicensesForUsername,
  findActiveLicenseForUsername,
} from "./autoclickerLicense";

export type PlanId = "free" | "basic" | "pro";

/** Vad varje nivå låser upp. Ändra fritt här — t.ex. lägg till fler system. */
export const PLANS: Record<PlanId, {
  id: PlanId;
  name: string;
  valuebets: boolean;     // Ithaca (value betting)
  autoclicker: boolean;   // Argos (desktop-bot, licens)
  priceEnv: string;       // namnet på env-var med Stripe Price-id (Fas 2)
}> = {
  free: { id: "free", name: "Free", valuebets: false, autoclicker: false, priceEnv: "" },
  basic: { id: "basic", name: "Basic", valuebets: true, autoclicker: false, priceEnv: "STRIPE_PRICE_BASIC" },
  pro: { id: "pro", name: "Pro", valuebets: true, autoclicker: true, priceEnv: "STRIPE_PRICE_PRO" },
};

export type SubStatus = "none" | "active" | "canceled" | "expired";

export type Subscription = {
  userId: string;
  plan: PlanId;
  status: SubStatus;
  currentPeriodEnd: string | null; // ISO
  autoRenew: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** Mollie (aktiv betalleverantör). Sätts av billing-flödet. */
  mollieCustomerId?: string | null;
  mollieSubscriptionId?: string | null;
  mollieMandateId?: string | null;
  updatedAt: string;
};

export type PlanPrice = { currency: string; value: string; label: string };

/**
 * Pris per nivå. Läses från env så du kan ändra utan ny deploy:
 *   MOLLIE_CURRENCY (default SEK), MOLLIE_PRICE_BASIC, MOLLIE_PRICE_PRO
 * Värden anges som decimaltal i hela valutan, t.ex. "199" eller "199.00".
 */
export function planPricing(): Record<PlanId, PlanPrice> {
  const currency = (process.env.MOLLIE_CURRENCY?.trim() || "SEK").toUpperCase();
  const fmt = (v: string, fallback: string): string => {
    const n = Number(String(v).replace(",", "."));
    return (Number.isFinite(n) && n > 0 ? n : Number(fallback)).toFixed(2);
  };
  return {
    free: { currency, value: "0.00", label: PLANS.free.name },
    basic: { currency, value: fmt(process.env.MOLLIE_PRICE_BASIC ?? "", "199"), label: PLANS.basic.name },
    pro: { currency, value: fmt(process.env.MOLLIE_PRICE_PRO ?? "", "399"), label: PLANS.pro.name },
  };
}

function dataDir(): string {
  const env = process.env.SUBSCRIPTIONS_DATA_DIR?.trim() || process.env.APP_USERS_DATA_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(process.cwd(), "data");
}
function subsFile(): string {
  return path.join(dataDir(), "subscriptions.json");
}

let cache: Subscription[] | null = null;
function readAll(): Subscription[] {
  if (cache) return cache;
  try {
    if (!fs.existsSync(subsFile())) {
      cache = [];
      return cache;
    }
    const raw = fs.readFileSync(subsFile(), "utf-8").trim();
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as Subscription[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}
function writeAll(subs: Subscription[]): void {
  cache = subs;
  ensureDir(dataDir());
  atomicWriteJson(subsFile(), subs);
}

function freeSub(userId: string): Subscription {
  return {
    userId,
    plan: "free",
    status: "none",
    currentPeriodEnd: null,
    autoRenew: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    updatedAt: new Date().toISOString(),
  };
}

export function getSubscription(userId: string): Subscription {
  return readAll().find((s) => s.userId === userId) ?? freeSub(userId);
}

export function listSubscriptions(): Subscription[] {
  return readAll();
}

/** Är prenumerationen aktiv just nu (status active + perioden inte passerad)? */
export function isSubActive(sub: Subscription): boolean {
  if (sub.status !== "active") return false;
  if (!sub.currentPeriodEnd) return false;
  return Date.parse(sub.currentPeriodEnd) > Date.now();
}

/** Effektiv nivå just nu (free om inte aktiv). */
export function effectivePlan(sub: Subscription): PlanId {
  return isSubActive(sub) ? sub.plan : "free";
}

/**
 * Tillämpa nivåns effekter på användaren: sätter valuebets-flaggan och ser till
 * att autoclicker-licens finns/tas bort. Idempotent.
 */
function applyEffects(userId: string): void {
  const user = getAppUserById(userId);
  if (!user) return;
  const sub = getSubscription(userId);
  const plan = PLANS[effectivePlan(sub)];

  // 1) valuebets-flagga
  if (Boolean(user.valuebets) !== plan.valuebets) {
    updateAppUser(userId, { valuebets: plan.valuebets });
  }

  // 2) autoclicker-licens
  const hasLicense = findActiveLicenseForUsername(user.username) != null;
  if (plan.autoclicker && !hasLicense) {
    const key = `AC-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}-${crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 4)
      .toUpperCase()}`;
    const expires = sub.currentPeriodEnd ?? new Date(Date.now() + 30 * 86400000).toISOString();
    createLicense({
      license_key: key,
      username: user.username,
      active: true,
      expires_at: expires,
      max_devices: 99,
      notes: `Auto via ${plan.name}-prenumeration`,
    });
  } else if (!plan.autoclicker && hasLicense) {
    deleteLicensesForUsername(user.username);
  }
}

function upsert(userId: string, patch: Partial<Subscription>): Subscription {
  const all = readAll();
  const idx = all.findIndex((s) => s.userId === userId);
  const base = idx >= 0 ? all[idx] : freeSub(userId);
  const next: Subscription = { ...base, ...patch, userId, updatedAt: new Date().toISOString() };
  if (idx >= 0) all[idx] = next;
  else all.push(next);
  writeAll(all);
  return next;
}

/** Sätt/uppdatera prenumeration och tillämpa effekter. */
export function setSubscription(
  userId: string,
  patch: Partial<
    Pick<
      Subscription,
      | "plan"
      | "status"
      | "currentPeriodEnd"
      | "autoRenew"
      | "stripeCustomerId"
      | "stripeSubscriptionId"
      | "mollieCustomerId"
      | "mollieSubscriptionId"
      | "mollieMandateId"
    >
  >,
): Subscription {
  const sub = upsert(userId, patch);
  applyEffects(userId);
  return getSubscription(userId);
}

/** Förläng (eller starta) prenumerationen med N dagar på vald nivå. */
export function extendSubscription(userId: string, days: number, plan?: PlanId): Subscription {
  const cur = getSubscription(userId);
  const from = cur.currentPeriodEnd && Date.parse(cur.currentPeriodEnd) > Date.now()
    ? Date.parse(cur.currentPeriodEnd)
    : Date.now();
  const end = new Date(from + days * 86400000).toISOString();
  return setSubscription(userId, {
    plan: plan ?? (cur.plan === "free" ? "basic" : cur.plan),
    status: "active",
    currentPeriodEnd: end,
  });
}

/** Avsluta direkt (återkalla premium nu). */
export function cancelSubscription(userId: string): Subscription {
  return setSubscription(userId, { status: "canceled", currentPeriodEnd: null, autoRenew: false });
}

/** Nollställ utgångna prenumerationer (auto-utgång). Returnerar antal utgångna. */
export function sweepExpiredSubscriptions(): number {
  const all = readAll();
  const now = Date.now();
  let expired = 0;
  for (const s of all) {
    if (s.status === "active" && s.currentPeriodEnd && Date.parse(s.currentPeriodEnd) <= now) {
      s.status = "expired";
      s.updatedAt = new Date().toISOString();
      expired++;
    }
  }
  if (expired > 0) {
    writeAll(all);
    for (const s of all) if (s.status === "expired") applyEffects(s.userId);
  }
  return expired;
}

export function subscriptionStats(): { total: number; active: number; expiringSoon: number } {
  const all = readAll();
  const now = Date.now();
  const soon = now + 7 * 86400000;
  let active = 0;
  let expiringSoon = 0;
  for (const s of all) {
    if (isSubActive(s)) {
      active++;
      const end = s.currentPeriodEnd ? Date.parse(s.currentPeriodEnd) : 0;
      if (end > now && end <= soon) expiringSoon++;
    }
  }
  return { total: all.length, active, expiringSoon };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** Starta auto-utgångs-sweepen (var 30:e min). */
export function startSubscriptionSweeper(): void {
  if (sweepTimer) return;
  const run = () => {
    try {
      const n = sweepExpiredSubscriptions();
      if (n > 0) console.log(`[subscriptions] ${n} prenumeration(er) utgångna — premium nollställt`);
    } catch (e) {
      console.warn("[subscriptions] sweep-fel:", e instanceof Error ? e.message : e);
    }
  };
  setTimeout(run, 10_000);
  sweepTimer = setInterval(run, 30 * 60_000);
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
}
