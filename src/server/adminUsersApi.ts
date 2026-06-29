/**
 * Admin API: /api/admin/users
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createAppUser,
  deleteAppUser,
  getAppUserById,
  listAppUsers,
  updateAppUser,
  type AppUser,
} from "./appUsers";
import {
  createLicense,
  deleteLicensesForUsername,
  findActiveLicenseForUsername,
  listLicenses,
  resetLicenseDevice,
} from "./autoclickerLicense";
import { validateNewPassword } from "./password";
import {
  PLANS,
  type PlanId,
  getSubscription,
  setSubscription,
  extendSubscription,
  cancelSubscription,
  subscriptionStats,
  effectivePlan,
  isSubActive,
} from "./subscriptions";
import { cancelMollieSubscription } from "./mollie";

export type AdminUsersApiContext = {
  getAuthUsername: (req: IncomingMessage) => string | null;
  isAdminUsername: (username: string) => boolean;
};

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

function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminUsersApiContext,
): string | null {
  const user = ctx.getAuthUsername(req);
  if (!user || !ctx.isAdminUsername(user)) {
    sendJson(res, 403, { ok: false, error: "Admin access required" });
    return null;
  }
  return user;
}

function publicUser(u: AppUser) {
  return {
    id: u.id,
    username: u.username,
    active: u.active,
    valuebets: u.valuebets === true,
    bonusFinder: u.bonusFinder === true,
    bonusOptimizer: u.bonusOptimizer === true,
    athena: u.athena === true,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

function licenseSummaryForUsername(username: string): {
  has_license: boolean;
  license_id: string | null;
  license_key: string | null;
  active: boolean;
  expires_at: string | null;
  device_id: string | null;
} {
  const licenses = listLicenses().filter((l) => l.username === username);
  const active = licenses.find((l) => {
    if (!l.active) return false;
    const exp = Date.parse(l.expires_at);
    return Number.isFinite(exp) && exp >= Date.now();
  });
  const any = active ?? licenses[0] ?? null;
  if (!any) {
    return {
      has_license: false,
      license_id: null,
      license_key: null,
      active: false,
      expires_at: null,
      device_id: null,
    };
  }
  return {
    has_license: true,
    license_id: any.id,
    license_key: any.license_key,
    active: any.active,
    expires_at: any.expires_at,
    device_id: any.device_id,
  };
}

function subscriptionSummaryForUser(userId: string): {
  plan: PlanId;
  effective_plan: PlanId;
  status: string;
  active: boolean;
  current_period_end: string | null;
  auto_renew: boolean;
  via_mollie: boolean;
} {
  const sub = getSubscription(userId);
  return {
    plan: sub.plan,
    effective_plan: effectivePlan(sub),
    status: sub.status,
    active: isSubActive(sub),
    current_period_end: sub.currentPeriodEnd,
    auto_renew: sub.autoRenew,
    via_mollie: Boolean(sub.mollieSubscriptionId),
  };
}

function generateLicenseKey(): string {
  const a = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const b = crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
  return `AC-${a}-${b}`;
}

function defaultExpires30Days(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString();
}

export async function adminUsersApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  ctx: AdminUsersApiContext,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "";
  const base = "/api/admin/users";
  if (!url.startsWith(base)) {
    next();
    return;
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!requireAdmin(req, res, ctx)) return;

  const licenseMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/autoclicker-license$/);
  if (licenseMatch && req.method === "POST") {
    const user = getAppUserById(licenseMatch[1]);
    if (!user) {
      sendJson(res, 404, { ok: false, error: "User not found" });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    const existing = findActiveLicenseForUsername(user.username);
    if (existing && body.replace_existing !== true) {
      sendJson(res, 409, {
        ok: false,
        error: "User already has an active license — set replace_existing=true to create another",
        license: existing,
      });
      return;
    }

    const result = createLicense({
      license_key: typeof body.license_key === "string" && body.license_key.trim()
        ? body.license_key.trim()
        : generateLicenseKey(),
      username: user.username,
      customer_email: typeof body.customer_email === "string" ? body.customer_email : null,
      active: true,
      expires_at:
        typeof body.expires_at === "string"
          ? body.expires_at
          : defaultExpires30Days(),
      max_devices: 1,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    if ("error" in result) {
      sendJson(res, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 201, { ok: true, license: result, user: publicUser(user) });
    return;
  }

  // Återkalla licens — personen har då ingen licensnyckel längre.
  if (licenseMatch && req.method === "DELETE") {
    const user = getAppUserById(licenseMatch[1]);
    if (!user) {
      sendJson(res, 404, { ok: false, error: "User not found" });
      return;
    }
    const removed = deleteLicensesForUsername(user.username);
    sendJson(res, 200, {
      ok: true,
      removed,
      user: { ...publicUser(user), license: licenseSummaryForUsername(user.username) },
    });
    return;
  }

  const resetDeviceMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/reset-license-device$/);
  if (resetDeviceMatch && req.method === "POST") {
    const user = getAppUserById(resetDeviceMatch[1]);
    if (!user) {
      sendJson(res, 404, { ok: false, error: "User not found" });
      return;
    }
    const lic =
      listLicenses().find((l) => l.username === user.username && l.active) ??
      listLicenses().find((l) => l.username === user.username);
    if (!lic) {
      sendJson(res, 404, { ok: false, error: "No license for this user" });
      return;
    }
    const result = resetLicenseDevice(lic.id);
    if ("error" in result) {
      sendJson(res, 404, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, license: result });
    return;
  }

  // Prenumeration: sätt nivå / förläng / avsluta
  const subMatch = url.match(/^\/api\/admin\/users\/([^/]+)\/subscription$/);
  if (subMatch && req.method === "POST") {
    const user = getAppUserById(subMatch[1]);
    if (!user) {
      sendJson(res, 404, { ok: false, error: "User not found" });
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }

    const action = typeof body.action === "string" ? body.action : "set";
    const planRaw = typeof body.plan === "string" ? body.plan : "";
    const plan: PlanId | undefined =
      planRaw === "free" || planRaw === "basic" || planRaw === "pro" ? planRaw : undefined;

    // Avsluta hos Mollie också (stoppa framtida dragningar) innan vi nollar lokalt.
    const stopMollie = async () => {
      const cur = getSubscription(user.id);
      await cancelMollieSubscription(cur.mollieCustomerId, cur.mollieSubscriptionId);
      setSubscription(user.id, { mollieSubscriptionId: null, autoRenew: false });
    };

    try {
      if (action === "extend") {
        const days = typeof body.days === "number" && body.days > 0 ? body.days : 30;
        extendSubscription(user.id, days, plan);
      } else if (action === "cancel") {
        await stopMollie();
        cancelSubscription(user.id);
      } else {
        // "set": ange exakt nivå. free = avsluta premium direkt.
        if (!plan) {
          sendJson(res, 400, { ok: false, error: "plan required (free|basic|pro)" });
          return;
        }
        if (plan === "free") {
          await stopMollie();
          cancelSubscription(user.id);
        } else {
          const days = typeof body.days === "number" && body.days > 0 ? body.days : 30;
          const end = new Date(Date.now() + days * 86400000).toISOString();
          setSubscription(user.id, { plan, status: "active", currentPeriodEnd: end });
        }
      }
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      user: {
        ...publicUser(user),
        license: licenseSummaryForUsername(user.username),
        subscription: subscriptionSummaryForUser(user.id),
      },
    });
    return;
  }

  const idMatch = url.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (idMatch && req.method === "PUT") {
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      return;
    }
    const update: { active?: boolean; password?: string; valuebets?: boolean; bonusFinder?: boolean; bonusOptimizer?: boolean; athena?: boolean } = {};
    if (typeof patch.active === "boolean") update.active = patch.active;
    if (typeof patch.valuebets === "boolean") update.valuebets = patch.valuebets;
    if (typeof patch.bonusFinder === "boolean") update.bonusFinder = patch.bonusFinder;
    if (typeof patch.bonusOptimizer === "boolean") update.bonusOptimizer = patch.bonusOptimizer;
    if (typeof patch.athena === "boolean") update.athena = patch.athena;
    if (typeof patch.password === "string" && patch.password.length > 0) {
      const pwErr = validateNewPassword(patch.password);
      if (pwErr) {
        sendJson(res, 400, { ok: false, error: pwErr });
        return;
      }
      update.password = patch.password;
    }
    const result = updateAppUser(idMatch[1], update);
    if ("error" in result) {
      sendJson(res, 404, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      user: {
        ...publicUser(result),
        license: licenseSummaryForUsername(result.username),
        subscription: subscriptionSummaryForUser(result.id),
      },
    });
    return;
  }

  if (idMatch && req.method === "DELETE") {
    const target = getAppUserById(idMatch[1]);
    if (!target) {
      sendJson(res, 404, { ok: false, error: "User not found" });
      return;
    }
    const me = ctx.getAuthUsername(req);
    if (me && target.username === me) {
      sendJson(res, 400, { ok: false, error: "Du kan inte radera ditt eget konto." });
      return;
    }
    if (ctx.isAdminUsername(target.username)) {
      sendJson(res, 400, { ok: false, error: "Kan inte radera ett admin-konto." });
      return;
    }
    const result = deleteAppUser(idMatch[1]);
    if ("error" in result) {
      sendJson(res, 404, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, deleted: result.username });
    return;
  }

  if (url === `${base}/subscription-stats` && req.method === "GET") {
    sendJson(res, 200, { ok: true, stats: subscriptionStats(), plans: PLANS });
    return;
  }

  if (url === base && req.method === "GET") {
    const users = listAppUsers().map((u) => ({
      ...publicUser(u),
      license: licenseSummaryForUsername(u.username),
      subscription: subscriptionSummaryForUser(u.id),
    }));
    sendJson(res, 200, { ok: true, users });
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
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      sendJson(res, 400, { ok: false, error: "username and password required" });
      return;
    }
    // Det env/admin-konfigurerade användarnamnet är RESERVERAT. En app-user med samma namn
    // kolliderar med admin-identiteten i auth-valideringen och låser ut admin permanent
    // (root cause 2026-06-29: så här uppstod den ursprungliga lockouten). Blockera här.
    if (ctx.isAdminUsername(username.trim())) {
      sendJson(res, 400, { ok: false, error: "username reserved (admin) — välj ett annat" });
      return;
    }
    const pwErr = validateNewPassword(password);
    if (pwErr) {
      sendJson(res, 400, { ok: false, error: pwErr });
      return;
    }
    let result;
    try {
      result = createAppUser({
        username,
        password,
        active: typeof body.active === "boolean" ? body.active : true,
        valuebets: body.valuebets === true,
      });
    } catch (e) {
      // PersistentStorageNotConfiguredError → 503 så frontend kan visa
      // "konfigurera Render disk innan du skapar users" istället för 500.
      const err = e as { httpStatus?: number; message?: string; missingEnvVars?: string[] };
      const status = err?.httpStatus ?? 500;
      sendJson(res, status, {
        ok: false,
        error: err?.message ?? "Unknown error",
        missingEnvVars: err?.missingEnvVars,
      });
      return;
    }
    if ("error" in result) {
      sendJson(res, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 201, {
      ok: true,
      user: {
        ...publicUser(result),
        license: licenseSummaryForUsername(result.username),
        subscription: subscriptionSummaryForUser(result.id),
      },
    });
    return;
  }

  sendJson(res, 405, { ok: false, error: "Method not allowed" });
}
