/**
 * Mollie-betalning (Swish + kort + Klarna via en integration).
 *
 * Status: FÄRDIGBYGGD men VILANDE tills du lägger in din nyckel.
 *   - Utan MOLLIE_API_KEY i miljön gör endpoints inget destruktivt: de
 *     svarar "betalning ej aktiverad ännu" istället för att krascha.
 *   - När du skapat ett Mollie-konto och satt env-variablerna i Render
 *     funkar hela flödet direkt — ingen kodändring behövs.
 *
 * Flöde (återkommande månadsbetalning):
 *   1) Kund väljer nivå på /billing → POST /api/billing/checkout
 *   2) Vi skapar en Mollie-kund + en "första betalning" (sequenceType=first)
 *      och skickar kunden till Mollies betalsida (checkoutUrl).
 *   3) När betalningen är klar ringer Mollie vår webhook (/api/billing/webhook).
 *      Då skapar vi en Mollie-prenumeration (drar automatiskt varje månad)
 *      och aktiverar kundens nivå i vårt system.
 *   4) Varje månadsdragning ringer webhooken igen → vi förlänger 30 dagar.
 *
 * Env-variabler (sätts i Render, ALDRIG i koden):
 *   MOLLIE_API_KEY        – test_xxx eller live_xxx (obligatorisk för att slå på)
 *   MOLLIE_CURRENCY       – default "SEK"
 *   MOLLIE_PRICE_BASIC    – t.ex. "199"  (per månad)
 *   MOLLIE_PRICE_PRO      – t.ex. "399"  (per månad)
 *   PUBLIC_BASE_URL       – t.ex. https://oddexus.se (för redirect/webhook;
 *                           härleds annars från request-headers)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getAppUserByUsername } from "./appUsers";
import {
  PLANS,
  type PlanId,
  planPricing,
  getSubscription,
  setSubscription,
  extendSubscription,
} from "./subscriptions";

const MOLLIE_API = "https://api.mollie.com/v2";

export function isMollieConfigured(): boolean {
  return Boolean(process.env.MOLLIE_API_KEY?.trim());
}

function apiKey(): string {
  return process.env.MOLLIE_API_KEY?.trim() ?? "";
}

type MollieJson = Record<string, unknown>;

async function mollie(
  method: string,
  pathSuffix: string,
  body?: MollieJson,
): Promise<MollieJson> {
  const res = await fetch(`${MOLLIE_API}${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as MollieJson) : {};
  if (!res.ok) {
    const detail =
      (json.detail as string | undefined) ?? (json.title as string | undefined) ?? `HTTP ${res.status}`;
    throw new Error(`Mollie ${method} ${pathSuffix}: ${detail}`);
  }
  return json;
}

function publicBaseUrl(req: IncomingMessage): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ||
    (req.headers.host as string | undefined) ||
    "localhost";
  return `${proto}://${host}`;
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

export type BillingApiContext = {
  getAuthUsername: (req: IncomingMessage) => string | null;
};

/** Vad /billing-sidan behöver för att rendera nivåer + nuvarande status. */
function publicPlans() {
  const pricing = planPricing();
  return (["free", "basic", "pro"] as PlanId[]).map((id) => ({
    id,
    name: PLANS[id].name,
    valuebets: PLANS[id].valuebets,
    autoclicker: PLANS[id].autoclicker,
    price: pricing[id],
  }));
}

/**
 * Skapa Mollie-prenumerationen efter att första betalningen gått igenom.
 * Första månaden är redan betald (aktiveringsbetalningen), så vi låter de
 * automatiska dragningarna börja om 1 månad → ingen dubbeldebitering.
 */
async function startRecurring(
  baseUrl: string,
  customerId: string,
  userId: string,
  plan: PlanId,
): Promise<string | null> {
  const pricing = planPricing();
  const price = pricing[plan];
  const start = new Date(Date.now() + 30 * 86400000);
  const startDate = start.toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const sub = await mollie("POST", `/customers/${customerId}/subscriptions`, {
      amount: { currency: price.currency, value: price.value },
      interval: "1 month",
      startDate,
      description: `Oddexus ${PLANS[plan].name} – ${userId} – ${Date.now()}`,
      webhookUrl: `${baseUrl}/api/billing/webhook`,
      metadata: { userId, plan, kind: "recurring" },
    });
    return (sub.id as string | undefined) ?? null;
  } catch (e) {
    // Mandat kanske inte hunnit bli giltigt direkt — nivån är ändå aktiverad
    // för innevarande månad; sweepern och nästa webhook reder ut resten.
    console.warn("[billing] kunde inte skapa Mollie-prenumeration:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function handleBillingApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  ctx: BillingApiContext,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "";
  if (!url.startsWith("/api/billing")) {
    next();
    return;
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ---- Webhook (Mollie anropar, ingen cookie). Måste ligga först. ----
  if (url === "/api/billing/webhook" && req.method === "POST") {
    // Svara alltid 200 snabbt så Mollie inte spammar retries; allt arbete
    // sker här men fel loggas bara.
    try {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const paymentId = params.get("id");
      if (paymentId && isMollieConfigured()) {
        await handleWebhookPayment(publicBaseUrl(req), paymentId);
      }
    } catch (e) {
      console.warn("[billing] webhook-fel:", e instanceof Error ? e.message : e);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- Allt nedan kräver inloggad medlem ----
  const username = ctx.getAuthUsername(req);
  if (!username) {
    sendJson(res, 401, { ok: false, error: "Not authenticated" });
    return;
  }
  const user = getAppUserByUsername(username);

  // Status + nivåer för /billing-sidan.
  if (url === "/api/billing/me" && req.method === "GET") {
    const sub = user ? getSubscription(user.id) : null;
    sendJson(res, 200, {
      ok: true,
      configured: isMollieConfigured(),
      plans: publicPlans(),
      subscription: sub
        ? {
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.currentPeriodEnd,
            autoRenew: sub.autoRenew,
            viaMollie: Boolean(sub.mollieSubscriptionId),
          }
        : null,
    });
    return;
  }

  // Starta köp → returnerar Mollie checkoutUrl.
  if (url === "/api/billing/checkout" && req.method === "POST") {
    if (!isMollieConfigured()) {
      sendJson(res, 503, {
        ok: false,
        error: "Betalning är inte aktiverad ännu. Försök igen senare.",
      });
      return;
    }
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
    const planRaw = typeof body.plan === "string" ? body.plan : "";
    if (planRaw !== "basic" && planRaw !== "pro") {
      sendJson(res, 400, { ok: false, error: "plan must be basic or pro" });
      return;
    }
    const plan: PlanId = planRaw;

    try {
      const baseUrl = publicBaseUrl(req);
      const sub = getSubscription(user.id);

      // Återanvänd Mollie-kund om den finns, annars skapa.
      let customerId = sub.mollieCustomerId ?? null;
      if (!customerId) {
        const customer = await mollie("POST", "/customers", { name: user.username });
        customerId = (customer.id as string | undefined) ?? null;
        if (customerId) setSubscription(user.id, { mollieCustomerId: customerId });
      }
      if (!customerId) throw new Error("Kunde inte skapa Mollie-kund");

      const price = planPricing()[plan];
      const payment = await mollie("POST", "/payments", {
        amount: { currency: price.currency, value: price.value },
        customerId,
        sequenceType: "first",
        description: `Oddexus ${PLANS[plan].name} – aktivering`,
        redirectUrl: `${baseUrl}/billing?status=klar`,
        webhookUrl: `${baseUrl}/api/billing/webhook`,
        metadata: { userId: user.id, plan, kind: "first" },
      });
      const links = payment._links as Record<string, { href?: string }> | undefined;
      const checkoutUrl = links?.checkout?.href;
      if (!checkoutUrl) throw new Error("Mollie returnerade ingen checkout-länk");
      sendJson(res, 200, { ok: true, checkoutUrl });
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Unknown billing route" });
}

/** Hämta betalningen från Mollie och uppdatera vår prenumeration. */
async function handleWebhookPayment(baseUrl: string, paymentId: string): Promise<void> {
  const payment = await mollie("GET", `/payments/${encodeURIComponent(paymentId)}`);
  const status = payment.status as string | undefined;
  if (status !== "paid") return; // bara betalda räknas

  const meta = (payment.metadata as Record<string, unknown> | undefined) ?? {};
  const userId = typeof meta.userId === "string" ? meta.userId : "";
  const planRaw = typeof meta.plan === "string" ? meta.plan : "";
  const kind = typeof meta.kind === "string" ? meta.kind : "";
  const plan: PlanId | null = planRaw === "basic" || planRaw === "pro" ? planRaw : null;
  const customerId = (payment.customerId as string | undefined) ?? null;
  const mandateId = (payment.mandateId as string | undefined) ?? null;
  if (!userId || !plan) return;

  if (kind === "first") {
    // Aktivera nivån för innevarande månad …
    extendSubscription(userId, 30, plan);
    if (customerId) setSubscription(userId, { mollieCustomerId: customerId, mollieMandateId: mandateId });
    // … och starta de automatiska månadsdragningarna.
    if (customerId) {
      const subId = await startRecurring(baseUrl, customerId, userId, plan);
      if (subId) setSubscription(userId, { mollieSubscriptionId: subId, autoRenew: true });
    }
  } else {
    // Återkommande dragning lyckades → förläng en månad till.
    extendSubscription(userId, 30, plan);
  }
}

/**
 * Avbryt en Mollie-prenumeration (anropas när admin avslutar). Best-effort:
 * loggar men kastar inte vidare, så admin-avslut alltid lyckas lokalt.
 */
export async function cancelMollieSubscription(
  customerId: string | null | undefined,
  subscriptionId: string | null | undefined,
): Promise<void> {
  if (!isMollieConfigured() || !customerId || !subscriptionId) return;
  try {
    await mollie("DELETE", `/customers/${customerId}/subscriptions/${subscriptionId}`);
  } catch (e) {
    console.warn("[billing] kunde inte avbryta Mollie-prenumeration:", e instanceof Error ? e.message : e);
  }
}
