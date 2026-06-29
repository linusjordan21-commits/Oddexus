import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { load } from "cheerio";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { componentTagger } from "lovable-tagger";
import { DEFAULT_ANALYTICS_CONFIG, mergeConfigRows, setAnalyticsConfig } from "./src/lib/config/analyticsConfig.ts";
import { toCsv as buildTrackingCsv, computeSummary as computeTrackingSummary, buildClaudeAnalysisPrompt as buildTrackingClaudePrompt, flattenTrustFields } from "./src/lib/tracking/exportFormat.ts";
import {
  BONUS_BOOKMAKER_NAMES,
  BONUS_OUTCOMES,
  DEFAULT_BONUS_PORTFOLIO,
  optimizeContinuationMatch,
  optimizeBonusMatch,
  optimizeBonusMatchSplit,
  softSpreadPenaltyPct,
  DEFAULT_DISTRIBUTION_TOLERANCE,
  type BonusMatch,
  type BonusOptimizationPlan,
  type BonusPortfolio,
  type BonusBookmakerId,
  type ContinuationPlan,
  type DistributionTolerance,
  type FreebetVoucher,
  type OddsTriple,
  type Outcome,
  type OptimizationMethod,
  type WageringAccount,
} from "./src/lib/bonusOptimizer";
import {
  adminAutoclickerLicensesApi,
  adminAutoclickerUploadZipApi,
  autoclickerDownloadApi,
  autoclickerHealthApi,
  autoclickerStatusApi,
  botLicenseApi,
  initAutoclickerStorage,
} from "./src/server/autoclickerLicense";
import { adminUsersApi } from "./src/server/adminUsersApi";
import { buildSharpIndex, blendNativeFair, type SharpIndex, type BetfairLiquidityInfo } from "./src/lib/odds/sharpBlend";
import { computeTrustFlags, computeLiquidityScore, computeRecommendation } from "./src/lib/tracking/signalMapping";
import { passesLiquidityFilters, parseLiquidityFilters } from "./src/lib/tracking/liquidityFilters";
import { computeTotalsValuebets } from "./src/lib/odds/totalsValuebets";
import { computeAhValuebets } from "./src/lib/odds/ahValuebets";
import { computeEh3Valuebets } from "./src/lib/odds/eh3Valuebets";
import { computeCornersValuebets } from "./src/lib/odds/cornersValuebets";
import { parseSmarketsAhRowsMap } from "./src/lib/odds/smarketsAdapter";
import { parseBetfairLineRowsMap, parseSbobetAhRowsMap, parsePinnacleSoccer, type PinnacleEvent } from "./src/lib/odds/shadowConsensus";
import { parsePinnacleLineLadders, type PinnacleLineLadders } from "./src/lib/odds/pinnacleLines";
import { startSubscriptionSweeper } from "./src/server/subscriptions";
import { handleBillingApi } from "./src/server/mollie";
import { getAppUserByUsername, initAppUsersStorage, verifyAppUserLogin } from "./src/server/appUsers";
import { hashPasswordScrypt, validateNewPassword, verifyPasswordHash } from "./src/server/password";
import { isPublicApiPath, logAutoclickerRouteManifest } from "./src/server/publicApiPaths";
import { logStorageConfigOnStartup, storageHealthApi } from "./src/server/storageHealth";
import { bonusFinderApi } from "./src/server/bonusFinderApi";
import { handleAthenaApi } from "./src/server/athena";
import { getUserBets, setUserBets, allUserBets, applyBetPatches } from "./src/server/betStore";
import type { MatchData as BonusFinderMatchData } from "./src/server/bonusFinder";

const BET_LOG_DATA_FILE = path.resolve(process.cwd(), ".matched-betting-logs.json");

/** Gemensam timeout för Kambi CDN, oddsportal, Betsson, ComeOn-sök m.m. */
const UPSTREAM_HTTP_TIMEOUT_MS = 14_000;

/** Dev-only: samma fil oavsett om du öppnar localhost, 127.0.0.1 eller LAN-IP (samma port). */
function betLogsDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/bet-logs") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET") {
    try {
      if (fs.existsSync(BET_LOG_DATA_FILE)) {
        const data = fs.readFileSync(BET_LOG_DATA_FILE, "utf-8");
        JSON.parse(data);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(data);
        return;
      }
    } catch (e) {
      console.error("[api/bet-logs] read error:", e);
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end("[]");
    return;
  }

  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(body) as unknown;
        if (!Array.isArray(parsed)) {
          res.statusCode = 400;
          res.end("expected JSON array");
          return;
        }
        fs.mkdirSync(path.dirname(BET_LOG_DATA_FILE), { recursive: true });
        fs.writeFileSync(BET_LOG_DATA_FILE, body, "utf-8");
        res.statusCode = 200;
        res.end("ok");
      } catch (e) {
        res.statusCode = 400;
        res.end("invalid json");
      }
    });
    return;
  }

  next();
}

/** Lättvikts hälsokoll för uptime / Node (t.ex. Render, load balancers). */
function apiHealthDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/health") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET or HEAD" }));
    return;
  }
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      service: "matched-betting-api",
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      nativeWebSocket: typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function",
      timeouts: {
        upstreamHttpMs: UPSTREAM_HTTP_TIMEOUT_MS,
        fetchAltenarMs: UPSTREAM_HTTP_TIMEOUT_MS,
        vbetConfigMs: 12_000,
        vbetSwarmRpcMs: 25_000,
        stakeFetchMs: 14_000,
        pinnacleFetchMs: 25_000,
        scrapePerBookmakerMs: 28_000,
        bookmakerMatchCacheRaceMs: 42_000,
      },
    }),
  );
}

// =====================================================================
// AUTH: simple username/password + signed-cookie session
// =====================================================================
// Skydd för hela appen. Server-side gate på alla /api/*-endpoints utom
// /api/auth/* och /api/health. Frontend redirectar till /login om
// /api/auth/me returnerar 401.
//
// Env vars (sätts i Render dashboard):
//   APP_USERNAME            — required
//   APP_PASSWORD_HASH       — preferred (scrypt format "scrypt$N$r$p$salt$hash" base64)
//   APP_PASSWORD            — fallback (plain text — generera APP_PASSWORD_HASH istället)
//   SESSION_SECRET          — required, min 32 random bytes hex
//
// Genererat hash via: node -e "const c=require('crypto');const pw=process.argv[1];const salt=c.randomBytes(16);const N=16384,r=8,p=1;const hash=c.scryptSync(pw,salt,32,{N,r,p,maxmem:64*1024*1024});console.log('scrypt$'+N+'$'+r+'$'+p+'$'+salt.toString('base64')+'$'+hash.toString('base64'))" 'mypassword'
//
// Säkerhetsegenskaper:
//   - Timing-safe lösenordsjämförelse (crypto.timingSafeEqual)
//   - HMAC-SHA256-signerade cookies (kan inte forgas utan SESSION_SECRET)
//   - HttpOnly + Secure (prod) + SameSite=Lax → ingen XSS-läckage, ingen CSRF på GET
//   - Rate limit på /api/auth/login: 5 försök per IP per 15 min
//   - Felmeddelandet är alltid "Invalid credentials" — avslöjar inte vilket fält som var fel

const AUTH_COOKIE_NAME = "pp_session";
const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dagar
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const AUTH_RATE_LIMIT_MAX = 5;

function authIsEnabled(): boolean {
  // I dev kan vi explicit slå av med APP_AUTH_DISABLED=true. I prod är auth
  // alltid på om SESSION_SECRET är satt; saknas secret → fail-closed (alla
  // skyddade endpoints returnerar 401).
  if (process.env.APP_AUTH_DISABLED === "true") return false;
  return true;
}

function getSessionSecret(): string | null {
  return process.env.SESSION_SECRET || null;
}

// =====================================================================
// Admin auth file: data/admin-auth.json (file > env priority)
// =====================================================================
// Tillåter admin att byta lösenord via /admin utan att rotera env vars.
// File-format:
//   {
//     "username": "linus",
//     "passwordHash": "scrypt$N$r$p$saltB64$hashB64",
//     "sessionVersion": 1,                    // bumpas av /api/admin/logout-all
//     "updatedAt": "2026-05-18T12:34:56.789Z"
//   }
//
// VIKTIGT om Render persistent disk: utan persistent disk konfigurerad är
// data/-mappen ephemeral och försvinner vid redeploy. Då faller authen
// tillbaka till env (APP_USERNAME + APP_PASSWORD_HASH). UI:t på /admin
// visar warning om detta.

type AdminAuthFile = {
  username: string;
  passwordHash: string;
  sessionVersion?: number;
  updatedAt: string;
};

// admin-auth.json MÅSTE ligga på den PERSISTENTA disken (APP_USERS_DATA_DIR), annars wipas
// den vid varje Render-omstart/deploy → admin-lösenordet (satt via /admin) försvinner och man
// låses ut (faller tillbaka till env-credentials med annat lösenord). 2026-06-29: flyttat från
// efemära data/ till APP_USERS_DATA_DIR (samma persistenta disk som users.json) så lösenordet
// överlever omstarter. Dev/utan env → data/ som förr.
const ADMIN_AUTH_FILE = path.join(
  process.env.APP_USERS_DATA_DIR?.trim() || path.resolve(process.cwd(), "data"),
  "admin-auth.json",
);

/**
 * In-memory-cache av admin-auth.json (fix 2026-06-13). readAdminAuthFile() gör
 * en synkron disk-läsning, och getAuthCredentials()/isAdminUsername() anropar
 * den FLERA gånger per inloggad admin-request → på Renders nätverks-disk en
 * stor del av den inloggade segheten. Filen ändras bara vid lösenordsbyte/
 * logout-all (writeAdminAuthFile, som uppdaterar cachen). Kort TTL eliminerar
 * per-request-I/O. Sentinel-objekt {value:null} skiljer "cachat: ingen fil"
 * från "ej cachat än".
 */
let adminAuthCache: { at: number; value: AdminAuthFile | null } | null = null;
const ADMIN_AUTH_CACHE_TTL_MS = Number(process.env.ADMIN_AUTH_CACHE_TTL_MS) || 5_000;

function readAdminAuthFile(): AdminAuthFile | null {
  const cached = adminAuthCache;
  if (cached && Date.now() - cached.at < ADMIN_AUTH_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = loadAdminAuthFromDisk();
  adminAuthCache = { at: Date.now(), value };
  return value;
}

function loadAdminAuthFromDisk(): AdminAuthFile | null {
  try {
    if (!fs.existsSync(ADMIN_AUTH_FILE)) return null;
    const raw = fs.readFileSync(ADMIN_AUTH_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.username === "string" &&
      typeof parsed.passwordHash === "string" &&
      parsed.username.length > 0 &&
      parsed.passwordHash.startsWith("scrypt$")
    ) {
      return {
        username: parsed.username,
        passwordHash: parsed.passwordHash,
        sessionVersion: typeof parsed.sessionVersion === "number" ? parsed.sessionVersion : 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    }
    console.warn("[auth] admin-auth.json malformed — falling back to env");
    return null;
  } catch (e) {
    console.warn("[auth] admin-auth.json read failed — falling back to env:", e instanceof Error ? e.message : e);
    return null;
  }
}

function writeAdminAuthFile(payload: AdminAuthFile): void {
  fs.mkdirSync(path.dirname(ADMIN_AUTH_FILE), { recursive: true });
  // Atomisk write: skriv till .tmp + rename så att en process som läser
  // mitt i en skrivning aldrig ser en halv fil.
  const tmp = `${ADMIN_AUTH_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, ADMIN_AUTH_FILE);
  // Håll cachen i synk så efterföljande auth-checks ser nya credentials direkt.
  adminAuthCache = { at: Date.now(), value: payload };
}

type ActiveCredentials = {
  username: string;
  passwordHash: string | null;
  passwordPlain: string | null;
  source: "file" | "env";
  sessionVersion: number;
  updatedAt: string | null;
};

function getAuthCredentials(): ActiveCredentials | null {
  // 1. File (admin-editable, takes priority)
  const file = readAdminAuthFile();
  if (file) {
    return {
      username: file.username,
      passwordHash: file.passwordHash,
      passwordPlain: null,
      source: "file",
      sessionVersion: file.sessionVersion ?? 1,
      updatedAt: file.updatedAt,
    };
  }
  // 2. Env (Render bootstrap default)
  const username = process.env.APP_USERNAME;
  if (!username) return null;
  return {
    username,
    passwordHash: process.env.APP_PASSWORD_HASH || null,
    passwordPlain: process.env.APP_PASSWORD || null,
    source: "env",
    sessionVersion: 0, // env source har ingen logout-all-version
    updatedAt: null,
  };
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k && rest.length > 0) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

// Cookie payload: { u: username, exp: epochMs, v: sessionVersion }
// v invalideras när admin trycker "Logout all sessions" (bumpas i file).
function signSessionToken(payload: { u: string; exp: number; v: number }, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySessionToken(token: string, secret: string): { u: string; exp: number; v: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig, "base64url");
  const b = Buffer.from(expected, "base64url");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload?.u !== "string" || typeof payload?.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    // v är optional för bakåtkompatibilitet med gamla cookies utan version.
    // Saknas v → behandlas som v=0 (vilket bara fungerar mot env-source).
    const v = typeof payload.v === "number" ? payload.v : 0;
    return { u: payload.u, exp: payload.exp, v };
  } catch {
    return null;
  }
}

function verifyPasswordPlain(password: string, expectedPlain: string): boolean {
  const a = Buffer.from(password, "utf8");
  const b = Buffer.from(expectedPlain, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Rate-limit: in-memory map keyed by IP. Räcker för dev + en-instans Render
// (Render Standard kör 1 instans default). Om vi skalar horisontellt behöver
// vi byta till delad store.
type RateLimitBucket = { count: number; resetAt: number };
const authRateLimitBuckets = new Map<string, RateLimitBucket>();

function getClientIp(req: IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string") return xf.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function checkAuthRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterMs: number } {
  const ip = getClientIp(req);
  const now = Date.now();
  const b = authRateLimitBuckets.get(ip);
  if (!b || b.resetAt < now) {
    authRateLimitBuckets.set(ip, { count: 1, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (b.count >= AUTH_RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterMs: b.resetAt - now };
  }
  b.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

function resetAuthRateLimit(req: IncomingMessage): void {
  authRateLimitBuckets.delete(getClientIp(req));
}

function buildSessionCookie(token: string, isProd: boolean): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(AUTH_SESSION_TTL_MS / 1000)}`,
  ];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

function buildClearCookie(isProd: boolean): string {
  const parts = [`${AUTH_COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

function isProdAuth(): boolean {
  return process.env.NODE_ENV === "production" || process.env.RENDER === "true";
}

function isAdminUsername(username: string): boolean {
  const creds = getAuthCredentials();
  return creds?.username === username;
}

/** Returns { ok, user } or null if not authenticated. */
function getAuthFromRequest(req: IncomingMessage): { user: string } | null {
  if (!authIsEnabled()) return { user: "anonymous" };
  const secret = getSessionSecret();
  if (!secret) return null;
  const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
  const token = cookies[AUTH_COOKIE_NAME];
  if (!token) return null;
  const payload = verifySessionToken(token, secret);
  if (!payload) return null;

  const appUser = getAppUserByUsername(payload.u);
  if (appUser) {
    if (!appUser.active) return null;
    if (payload.v < appUser.sessionVersion) return null;
    return { user: appUser.username };
  }

  const creds = getAuthCredentials();
  if (creds && payload.u === creds.username) {
    if (payload.v < creds.sessionVersion) return null;
    return { user: creds.username };
  }
  return null;
}

/** Normalize path for auth routing (strip query + optional trailing slash). */
function normalizeRequestPath(url: string): string {
  const path = url.split("?")[0] ?? "";
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function isPublicPath(url: string): boolean {
  return isPublicApiPath(url);
}

/**
 * Delad server-till-server-token. Trackingsworkern (persist-signals) hämtar
 * /api/valuebets med denna i X-Internal-Token. Default = SUPABASE_SERVICE_KEY
 * (workern + Render har den redan → ingen ny secret). Sätt VALUEBETS_INTERNAL_TOKEN
 * för en dedikerad token. Returnerar true om requesten bär en giltig token.
 */
function hasValidInternalToken(req: IncomingMessage): boolean {
  const internalToken = (
    process.env.VALUEBETS_INTERNAL_TOKEN ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();
  if (!internalToken) return false;
  const reqToken = req.headers["x-internal-token"];
  return typeof reqToken === "string" && reqToken === internalToken;
}

/** Middleware: gate alla /api/*-paths utom whitelistade. */
function authGateMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = normalizeRequestPath(req.url ?? "");
  // Bara /api/* skyddas server-side. Frontend HTML/JS serveras av Vite/static
  // — och redirectar själv till /login om /api/auth/me returnerar 401.
  if (!url.startsWith("/api/")) {
    // Skyddad zip-nedladdning (kräver cookie — hanteras före SPA)
    if (url === "/autoclicker/download") {
      const auth = getAuthFromRequest(req);
      if (!auth) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: "Not authenticated" }));
        return;
      }
      autoclickerDownloadApi(req, res, auth.user, next);
      return;
    }
    if (url === "/admin/autoclicker-licenses/upload-zip") {
      if (authIsEnabled()) {
        const auth = getAuthFromRequest(req);
        if (!auth) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: "Not authenticated" }));
          return;
        }
        if (!isAdminUsername(auth.user)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: "Admin access required" }));
          return;
        }
      }
      void adminAutoclickerUploadZipApi(req, res, next);
      return;
    }
    next();
    return;
  }
  if (isPublicPath(url)) {
    next();
    return;
  }
  // INTERN WORKER-BYPASS: server-till-server-anrop (persist-signals-workern) bär
  // X-Internal-Token. Auth-gaten kör FÖRE valuebetsAccessMiddleware, så bypassen
  // måste finnas HÄR — annars 401:as workern innan den når valuebets-bypassen.
  if (hasValidInternalToken(req)) {
    (req as IncomingMessage & { __internalToken?: boolean }).__internalToken = true;
    next();
    return;
  }
  if (!authIsEnabled()) {
    next();
    return;
  }
  const auth = getAuthFromRequest(req);
  if (!auth) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "Not authenticated" }));
    return;
  }
  // Tagga req så downstream-handlers kan logga vem som anropar (optional).
  (req as IncomingMessage & { __authUser?: string }).__authUser = auth.user;
  next();
}

/** Block /api/admin/* for non-admin users (kunder). */
function adminOnlyMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = normalizeRequestPath(req.url ?? "");
  if (!url.startsWith("/api/admin/")) {
    next();
    return;
  }
  if (!authIsEnabled()) {
    next();
    return;
  }
  const auth = getAuthFromRequest(req);
  if (!auth || !isAdminUsername(auth.user)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "Admin access required" }));
    return;
  }
  next();
}

/**
 * Block /api/valuebets* för kunder UTAN per-användare-behörigheten `valuebets`
 * (sätts av admin i /admin/users). Admin har alltid åtkomst. Frontend-spärren
 * (ValuebetsRoute) är bara UX — detta är det riktiga skyddet, så en kund inte
 * kan läsa valuebets-datan genom att anropa API:t direkt.
 */
function valuebetsAccessMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = normalizeRequestPath(req.url ?? "");
  // /api/tracking/* har samma datakänslighet som valuebets → samma åtkomstgrind.
  const isTracking = url.startsWith("/api/tracking/");
  if (url !== "/api/valuebets" && !url.startsWith("/api/valuebets/") && !isTracking) {
    next();
    return;
  }
  if (!authIsEnabled()) {
    next();
    return;
  }
  // INTERN WORKER-BYPASS: trackingsworkern (persist-signals) hämtar /api/valuebets
  // server-till-server med en delad token i X-Internal-Token. Default = SUPABASE_SERVICE_KEY
  // (workern + Render har den redan → ingen ny secret). Sätt VALUEBETS_INTERNAL_TOKEN för en
  // dedikerad token. Skickas ALDRIG till klienter — bara server→server över HTTPS.
  const internalToken = (process.env.VALUEBETS_INTERNAL_TOKEN || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const reqToken = req.headers["x-internal-token"];
  if (internalToken && typeof reqToken === "string" && reqToken === internalToken) {
    next();
    return;
  }
  const auth = getAuthFromRequest(req);
  if (!auth) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "Not authenticated" }));
    return;
  }
  if (isAdminUsername(auth.user)) {
    next();
    return;
  }
  const appUser = getAppUserByUsername(auth.user);
  if (appUser?.valuebets !== true) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "Valuebets access required" }));
    return;
  }
  next();
}

/**
 * DIAGNOSTIK: oautentiserad ping för att verifiera vilken kod Render kör + om
 * worker-token-env:en är satt. Avslöjar INGA hemligheter (bara bool + längd).
 * Öppna i webbläsaren: /api/internal/ping
 */
function internalPingDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/internal/ping") { next(); return; }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    ok: true,
    ts: new Date().toISOString(),
    build: "fas1-bypass-v2", // markör: bekräftar att DENNA kod är live på Render
    hasInternalToken: Boolean((process.env.VALUEBETS_INTERNAL_TOKEN || "").trim()),
    internalTokenLen: (process.env.VALUEBETS_INTERNAL_TOKEN || "").trim().length,
    hasServiceKey: Boolean((process.env.SUPABASE_SERVICE_KEY || "").trim()),
    hasServiceRoleKey: Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()),
  }));
}

/**
 * TRACKING-LÄS-API (fas 1, consumption-sidan). Workern (persist-signals) SKRIVER
 * valuebet_signals + decision_snapshots till Supabase; dessa endpoints LÄSER dem
 * så dashboarden kan visa den always-on-spårade datan. Skrivs aldrig härifrån.
 *
 *   GET /api/tracking/signals?status=active&limit=200&sport=&min_ev=
 *       → deduppade signaler (en per opportunity) ordnade efter max_ev.
 *   GET /api/tracking/series?signal=<signal_id>
 *       → decision_snapshots (EV/odds-tidsserie) för en signal, kronologiskt.
 *   GET /api/tracking/freshness
 *       → senaste updated_at per odds-källa + ålder (stale-flaggning i UI).
 *
 * Auth: gatas av valuebetsAccessMiddleware (admin / valuebets-flagga / intern token).
 */
async function trackingApiDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0] ?? "";
  if (!url.startsWith("/api/tracking/")) { next(); return; }
  const sendJson = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") { sendJson(405, { ok: false, error: "Use GET" }); return; }
  if (!ODDS_DB_URL || !ODDS_DB_KEY) { sendJson(200, { ok: true, configured: false, rows: [] }); return; }

  const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const clampInt = (raw: string | null, def: number, min: number, max: number) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
  };
  // Datakvalitets-filter (steg 6) → PostgREST-fragment. clean = null/clean/ok (null =
  // ingen känd brist, räknas rent). uncertain = gult. issue = hårt dålig kvalitet.
  const qualityClause = (raw: string | null): string => {
    const q = (raw || "all").replace(/[^a-z_]/gi, "");
    if (q === "clean") return "&or=(data_quality_flag.is.null,data_quality_flag.in.(clean,ok))";
    if (q === "uncertain") return "&data_quality_flag=eq.uncertain";
    if (q === "issue") return "&status=eq.data_quality_issue";
    return ""; // all
  };

  try {
    if (url === "/api/tracking/signals") {
      const status = (params.get("status") || "active").replace(/[^a-z_]/gi, "");
      const limit = clampInt(params.get("limit"), 200, 1, 1000);
      const sport = params.get("sport");
      const minEv = params.get("min_ev");
      let q = `/rest/v1/valuebet_signals?select=*&order=max_ev.desc.nullslast&limit=${limit}`;
      if (status && status !== "all") q += `&status=eq.${encodeURIComponent(status)}`;
      if (sport) q += `&sport=eq.${encodeURIComponent(sport)}`;
      if (minEv && Number.isFinite(Number(minEv))) q += `&max_ev=gte.${encodeURIComponent(minEv)}`;
      q += qualityClause(params.get("quality")); // default all → visa allt med kvalitets-badge i UI
      const { status: httpStatus, rows } = await trackingDbList(q);
      sendJson(200, { ok: httpStatus === 200, configured: true, count: rows.length, rows });
      return;
    }
    if (url === "/api/tracking/series") {
      const signal = params.get("signal");
      if (!signal) { sendJson(400, { ok: false, error: "signal-param krävs" }); return; }
      const limit = clampInt(params.get("limit"), 1000, 1, 5000);
      const q =
        `/rest/v1/decision_snapshots?select=taken_at,taken_at_sweden,trigger,soft_odds,sharp_fair_odds,ev,time_to_start_sec,time_to_start_bucket,market_mismatch_risk` +
        `&signal_id=eq.${encodeURIComponent(signal)}&order=taken_at.asc&limit=${limit}`;
      const { status: httpStatus, rows } = await trackingDbList(q);
      sendJson(200, { ok: httpStatus === 200, signal, count: rows.length, rows });
      return;
    }
    if (url === "/api/tracking/analytics") {
      // Aggregat över spårade signaler — beräknas server-side så UI:t är lätt och
      // täcker HELA datasetet (ej bara den sidvisade listan). Inga outcomes krävs:
      // detta är "var/när/hur dyker value upp"-analys (timing intelligence m.m.).
      const hours = clampInt(params.get("hours"), 168, 1, 8760);
      const sinceIso = new Date(Date.now() - hours * 3600_000).toISOString();
      const q =
        `/rest/v1/valuebet_signals?select=soft_bookmaker,market_type,max_ev,ev_at_detection,` +
        `time_to_start_bucket,hour_of_day_sweden,weekday_sweden,duration_sec,status,first_detected_at,clv_status,clv_pct,data_quality_flag` +
        `&first_detected_at=gte.${encodeURIComponent(sinceIso)}&limit=10000`;
      const { rows } = await trackingDbList(q);
      type Row = {
        soft_bookmaker?: string | null; market_type?: string | null; max_ev?: number | null;
        ev_at_detection?: number | null; time_to_start_bucket?: string | null;
        hour_of_day_sweden?: number | null; weekday_sweden?: number | null;
        duration_sec?: number | null; status?: string | null;
        clv_status?: string | null; clv_pct?: number | null; data_quality_flag?: string | null;
      };
      const data = rows as Row[];
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      // Datakvalitets-filter (steg 7): default 'clean' så lärandet inte pollueras av
      // suspekt/osäker data. byQuality nedan räknas alltid över ALLT så fördelningen syns.
      const quality = (params.get("quality") || "clean").replace(/[^a-z_]/gi, "");
      const isClean = (r: Row) => r.data_quality_flag == null || r.data_quality_flag === "clean" || r.data_quality_flag === "ok";
      const filtered =
        quality === "all" ? data
        : quality === "uncertain" ? data.filter((r) => r.data_quality_flag === "uncertain")
        : quality === "issue" ? data.filter((r) => r.status === "data_quality_issue")
        : data.filter(isClean);
      // groupAgg: per nyckel → antal + snitt-EV + CLV (settlade, snitt-CLV, andel som slog linjen).
      const groupAgg = (src: Row[], keyFn: (r: Row) => string | null) => {
        const m = new Map<string, { count: number; evSum: number; evN: number; maxEv: number; clvSum: number; clvN: number; beatN: number }>();
        for (const r of src) {
          const k = keyFn(r);
          if (!k) continue;
          const e = num(r.max_ev);
          const cur = m.get(k) ?? { count: 0, evSum: 0, evN: 0, maxEv: 0, clvSum: 0, clvN: 0, beatN: 0 };
          cur.count += 1;
          if (e != null) { cur.evSum += e; cur.evN += 1; cur.maxEv = Math.max(cur.maxEv, e); }
          if (r.clv_status === "settled") {
            const c = num(r.clv_pct);
            if (c != null) { cur.clvSum += c; cur.clvN += 1; if (c > 0) cur.beatN += 1; }
          }
          m.set(k, cur);
        }
        return [...m.entries()]
          .map(([key, v]) => ({
            key, count: v.count,
            avgEv: v.evN ? v.evSum / v.evN : null, maxEv: v.maxEv || null,
            settled: v.clvN, avgClv: v.clvN ? v.clvSum / v.clvN : null, beatPct: v.clvN ? v.beatN / v.clvN : null,
          }))
          .sort((a, b) => b.count - a.count);
      };
      // EV-histogram (på max_ev) — filtrerat.
      const evBuckets = [
        { label: "2–5%", lo: 0.02, hi: 0.05 },
        { label: "5–10%", lo: 0.05, hi: 0.1 },
        { label: "10–15%", lo: 0.1, hi: 0.15 },
        { label: "15–25%", lo: 0.15, hi: 0.25 },
        { label: "25%+", lo: 0.25, hi: Infinity },
      ].map((b) => ({ label: b.label, count: 0 }));
      const evVals: number[] = [];
      for (const r of filtered) {
        const e = num(r.max_ev);
        if (e == null) continue;
        evVals.push(e);
        const idx = e < 0.05 ? 0 : e < 0.1 ? 1 : e < 0.15 ? 2 : e < 0.25 ? 3 : 4;
        evBuckets[idx].count += 1;
      }
      evVals.sort((a, b) => a - b);
      const median = evVals.length ? evVals[Math.floor(evVals.length / 2)] : null;
      const avg = evVals.length ? evVals.reduce((s, v) => s + v, 0) / evVals.length : null;
      // Signal-livslängd (steg 7): hur länge value består (duration_sec) — filtrerat.
      const durs = filtered.map((r) => num(r.duration_sec)).filter((v): v is number => v != null && v >= 0).sort((a, b) => a - b);
      const lifespan = {
        count: durs.length,
        avgSec: durs.length ? durs.reduce((s, v) => s + v, 0) / durs.length : null,
        medianSec: durs.length ? durs[Math.floor(durs.length / 2)] : null,
        histogram: [
          { label: "<5m", lo: 0, hi: 300 }, { label: "5–15m", lo: 300, hi: 900 },
          { label: "15–60m", lo: 900, hi: 3600 }, { label: "1–3h", lo: 3600, hi: 10800 },
          { label: "3h+", lo: 10800, hi: Infinity },
        ].map((b) => ({ label: b.label, count: durs.filter((v) => v >= b.lo && v < b.hi).length })),
      };
      // Tid-till-avspark i kanonisk ordning (bär nu CLV → bet-now-vs-wait).
      const ttsOrder = ["<15m", "15-60m", "1-3h", "3-6h", "6-12h", "12-24h", "24h+"];
      const byTts = groupAgg(filtered, (r) => r.time_to_start_bucket ?? null)
        .sort((a, b) => {
          const ia = ttsOrder.indexOf(a.key); const ib = ttsOrder.indexOf(b.key);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
      const byHour = Array.from({ length: 24 }, (_, h) => ({ key: String(h), count: 0 }));
      const byWeekday = Array.from({ length: 7 }, (_, d) => ({ key: String(d + 1), count: 0 }));
      for (const r of filtered) {
        const h = num(r.hour_of_day_sweden);
        if (h != null && h >= 0 && h < 24) byHour[h].count += 1;
        const wd = num(r.weekday_sweden);
        if (wd != null && wd >= 1 && wd <= 7) byWeekday[wd - 1].count += 1;
      }
      // CLV: settlade signaler + andel som slog closing-linjen + snitt-CLV — filtrerat.
      const clvSettled = filtered.filter((r) => r.clv_status === "settled" && num(r.clv_pct) != null);
      const clvVals = clvSettled.map((r) => r.clv_pct as number);
      const clvAvg = clvVals.length ? clvVals.reduce((s, v) => s + v, 0) / clvVals.length : null;
      const clvBeat = clvVals.filter((v) => v > 0).length;
      const clvHist = [
        { label: "< -5%", lo: -Infinity, hi: -0.05 },
        { label: "-5–0%", lo: -0.05, hi: 0 },
        { label: "0–5%", lo: 0, hi: 0.05 },
        { label: "5–10%", lo: 0.05, hi: 0.1 },
        { label: "10%+", lo: 0.1, hi: Infinity },
      ].map((b) => ({ label: b.label, count: clvVals.filter((v) => v >= b.lo && v < b.hi).length }));
      sendJson(200, {
        ok: true,
        windowHours: hours,
        quality,
        total: filtered.length,
        totalAll: data.length,
        avgEv: avg,
        medianEv: median,
        lifespan,
        clv: {
          settled: clvSettled.length,
          noClosing: filtered.filter((r) => r.clv_status === "no_closing").length,
          pending: filtered.filter((r) => !r.clv_status).length,
          avgClvPct: clvAvg,
          beatPct: clvVals.length ? clvBeat / clvVals.length : null,
          histogram: clvHist,
        },
        byBook: groupAgg(filtered, (r) => r.soft_bookmaker ?? null),
        byMarket: groupAgg(filtered, (r) => r.market_type ?? null),
        // Datakvalitets-fördelning (steg 6): över ALLT (ofiltrerat) så split:en syns.
        byQuality: groupAgg(data, (r) => r.data_quality_flag ?? "clean"),
        byTimeToStart: byTts,
        byHourSweden: byHour,
        byWeekdaySweden: byWeekday,
        evHistogram: evBuckets,
      });
      return;
    }
    if (url === "/api/tracking/strategy") {
      // Strategy Lab: filtrera spårade signaler (server-side PostgREST) och mät
      // utfallet — EV + CLV (slog vi closing-linjen). Backtest utan matchresultat:
      // CLV är target. Filter: book, market, min_ev, tts-bucket, timme, veckodag.
      const days = clampInt(params.get("days"), 60, 1, 365);
      const fromIso = new Date(Date.now() - days * 864e5).toISOString();
      let f = `&first_detected_at=gte.${encodeURIComponent(fromIso)}`;
      const book = params.get("book");
      const market = params.get("market");
      const minEv = params.get("min_ev");
      const maxEv = params.get("max_ev");
      const tts = params.get("tts");
      const hourMin = params.get("hour_min");
      const hourMax = params.get("hour_max");
      const weekday = params.get("weekday");
      if (book) f += `&soft_bookmaker=eq.${encodeURIComponent(book)}`;
      if (market) f += `&market_type=eq.${encodeURIComponent(market)}`;
      if (minEv && Number.isFinite(Number(minEv))) f += `&max_ev=gte.${encodeURIComponent(minEv)}`;
      if (maxEv && Number.isFinite(Number(maxEv))) f += `&max_ev=lt.${encodeURIComponent(maxEv)}`;
      if (tts) f += `&time_to_start_bucket=eq.${encodeURIComponent(tts)}`;
      if (hourMin && Number.isFinite(Number(hourMin))) f += `&hour_of_day_sweden=gte.${encodeURIComponent(hourMin)}`;
      if (hourMax && Number.isFinite(Number(hourMax))) f += `&hour_of_day_sweden=lte.${encodeURIComponent(hourMax)}`;
      if (weekday && Number.isFinite(Number(weekday))) f += `&weekday_sweden=eq.${encodeURIComponent(weekday)}`;
      // Default 'clean' → backtest exkluderar suspekt/osäker data om inte du väljer all.
      f += qualityClause(params.get("quality") || "clean");
      const rowsAll = await trackingDbListAll("valuebet_signals", `${f}&order=first_detected_at.desc`);
      // §8 Market Trust Layer-filter (liquidity/consensus) på extra-jsonb — i JS
      // eftersom PostgREST inte numerik-jämför jsonb-fält pålitligt. Tomma filter → allt.
      const liqFilters = parseLiquidityFilters((k) => params.get(k));
      const rows = rowsAll.filter((r) => passesLiquidityFilters(r.extra, liqFilters));
      const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const evs = rows.map((r) => fin(r.max_ev)).filter((v): v is number => v != null);
      const settled = rows.filter((r) => r.clv_status === "settled" && fin(r.clv_pct) != null);
      const clvs = settled.map((r) => r.clv_pct as number);
      const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
      const med = (a: number[]) => {
        if (!a.length) return null;
        const s = [...a].sort((x, y) => x - y);
        return s[Math.floor(s.length / 2)];
      };
      const clvHist = [
        { label: "< -5%", lo: -Infinity, hi: -0.05 },
        { label: "-5–0%", lo: -0.05, hi: 0 },
        { label: "0–5%", lo: 0, hi: 0.05 },
        { label: "5–10%", lo: 0.05, hi: 0.1 },
        { label: "10%+", lo: 0.1, hi: Infinity },
      ].map((b) => ({ label: b.label, count: clvs.filter((v) => v >= b.lo && v < b.hi).length }));
      const sample = rows.slice(0, 25).map((r) => ({
        signal_id: r.signal_id, match: r.match, soft_bookmaker: r.soft_bookmaker,
        market_type: r.market_type, selection: r.selection, max_ev: r.max_ev,
        clv_status: r.clv_status, clv_pct: r.clv_pct, first_detected_at: r.first_detected_at,
      }));
      sendJson(200, {
        ok: true,
        windowDays: days,
        quality: params.get("quality") || "clean",
        count: rows.length,
        avgEv: mean(evs),
        medianEv: med(evs),
        clvSettled: settled.length,
        avgClv: mean(clvs),
        medianClv: med(clvs),
        beatPct: clvs.length ? clvs.filter((v) => v > 0).length / clvs.length : null,
        clvHistogram: clvHist,
        sample,
      });
      return;
    }
    if (url === "/api/tracking/export") {
      // Bygger Claude-analyspaketet on-demand och returnerar EN nedladdningsbar JSON
      // (CSV-strängar + summary + färdig analys-prompt). Samma byggare som
      // export-analysis-package.mjs (GHA-artefakten), men direkt i webläsaren.
      const days = clampInt(params.get("days"), 30, 1, 365);
      const fromIso = new Date(Date.now() - days * 864e5).toISOString();
      const toIso = new Date().toISOString();
      const [signals, snapshots, warnings] = await Promise.all([
        trackingDbListAll("valuebet_signals", `&first_detected_at=gte.${encodeURIComponent(fromIso)}&order=first_detected_at.asc`),
        trackingDbListAll("decision_snapshots", `&taken_at=gte.${encodeURIComponent(fromIso)}&order=taken_at.asc`),
        trackingDbListAll("market_mismatch_warnings", `&detected_at=gte.${encodeURIComponent(fromIso)}&order=detected_at.asc`),
      ]);
      const summary = computeTrackingSummary({
        signals, snapshots, decisions: [], loggedBets: [], outcomes: [], dateFrom: fromIso, dateTo: toIso,
      });
      const bundle = {
        generatedAt: toIso,
        dateFrom: fromIso,
        dateTo: toIso,
        summary,
        claude_analysis_prompt: buildTrackingClaudePrompt(summary),
        csv: {
          // §11: platta ut liquidity/sharp-fält ur extra → egna CSV-kolumner.
          valuebet_signals: buildTrackingCsv(signals.map(flattenTrustFields)),
          decision_snapshots: buildTrackingCsv(snapshots.map(flattenTrustFields)),
          market_mismatch_warnings: buildTrackingCsv(warnings),
        },
        counts: { signals: signals.length, snapshots: snapshots.length, warnings: warnings.length },
      };
      const fname = `oddexus-analys-${toIso.slice(0, 10)}.json`;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(bundle));
      return;
    }
    if (url === "/api/tracking/freshness") {
      const { status: httpStatus, rows } = await trackingDbList(
        `/rest/v1/odds_cache?select=source_id,updated_at&order=source_id.asc&limit=200`,
      );
      const nowMs = Date.now();
      const INACTIVE_SEC = 6 * 3600; // >6h utan uppdatering = inaktiv/död källa, inte "stale"
      // Visa BARA levande odds-källor i färskhets-panelen. Filtrera bort:
      //  - diagnostik (_-prefix, t.ex. _sbobet-diag)
      //  - icke-odds (match-results = utfallskälla, uppdateras sällan)
      //  - döda källor (>6h gamla, t.ex. retirerade scrapers) → räknas, visas ej.
      const isLiveOddsId = (id: string | null | undefined) =>
        !!id && !id.startsWith("_") && id !== "match-results" && id !== "match_results";
      const sources: Array<{ source_id: string | null; updated_at: string | null; age_sec: number | null; status: string }> = [];
      let inactiveCount = 0;
      for (const r of rows as Array<{ source_id?: string; updated_at?: string }>) {
        const id = r.source_id ?? null;
        if (!isLiveOddsId(id)) continue;
        const ms = r.updated_at ? Date.parse(r.updated_at) : NaN;
        const ageSec = Number.isFinite(ms) ? Math.round((nowMs - ms) / 1000) : null;
        if (ageSec == null || ageSec > INACTIVE_SEC) { inactiveCount++; continue; }
        // Sharps gatar valuebets vid 3 min; flagga stale strax under det.
        sources.push({ source_id: id, updated_at: r.updated_at ?? null, age_sec: ageSec, status: ageSec > 180 ? "stale" : "fresh" });
      }
      sendJson(200, { ok: httpStatus === 200, ts: new Date().toISOString(), sources, inactiveCount });
      return;
    }
    sendJson(404, { ok: false, error: "okänd tracking-endpoint" });
  } catch (error) {
    sendJson(500, { ok: false, error: error instanceof Error ? error.message : "fel" });
  }
}

/**
 * Generisk per-funktion-åtkomstvakt (samma mönster som valuebetsAccessMiddleware).
 * Admin ELLER kund med rätt per-användare-flagga släpps igenom; övriga → 403.
 * Detta är det RIKTIGA skyddet — frontend-routegaten är bara UX.
 */
function featureAccessMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
  opts: { match: (url: string) => boolean; flag: "bonusFinder" | "bonusOptimizer" | "athena"; label: string },
) {
  const url = normalizeRequestPath(req.url ?? "");
  if (!opts.match(url)) {
    next();
    return;
  }
  if (!authIsEnabled()) {
    next();
    return;
  }
  const auth = getAuthFromRequest(req);
  if (!auth) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "Not authenticated" }));
    return;
  }
  if (isAdminUsername(auth.user)) {
    next();
    return;
  }
  const appUser = getAppUserByUsername(auth.user);
  if (appUser?.[opts.flag] !== true) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error: `${opts.label} access required` }));
    return;
  }
  next();
}

function bonusOptimizerAccessMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  featureAccessMiddleware(req, res, next, {
    match: (url) => url === "/api/best-bonus-matches" || url === "/api/bonus-continuation-matches",
    flag: "bonusOptimizer",
    label: "Bonus optimizer",
  });
}

function bonusFinderAccessMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  featureAccessMiddleware(req, res, next, {
    match: (url) => url.startsWith("/api/bonus-finder/"),
    flag: "bonusFinder",
    label: "Bonus finder",
  });
}

function athenaAccessMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  featureAccessMiddleware(req, res, next, {
    // Bara medlems-endpoints; /api/admin/athena/* lämnas till adminOnlyMiddleware.
    match: (url) => url.startsWith("/api/athena"),
    flag: "athena",
    label: "Athena",
  });
}

async function authLoginDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/auth/login") {
    next();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }

  const rl = checkAuthRateLimit(req);
  if (!rl.allowed) {
    res.statusCode = 429;
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    res.end(JSON.stringify({ ok: false, error: "Too many login attempts. Try again later." }));
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
    return;
  }
  let parsed: { username?: unknown; password?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    return;
  }
  const username = typeof parsed.username === "string" ? parsed.username : "";
  const password = typeof parsed.password === "string" ? parsed.password : "";
  if (!username || !password) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Missing credentials" }));
    return;
  }

  const secret = getSessionSecret();
  if (!secret) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: "Auth not configured" }));
    return;
  }

  const appUser = verifyAppUserLogin(username, password);
  if (appUser) {
    resetAuthRateLimit(req);
    const token = signSessionToken(
      { u: appUser.username, exp: Date.now() + AUTH_SESSION_TTL_MS, v: appUser.sessionVersion },
      secret,
    );
    res.setHeader("Set-Cookie", buildSessionCookie(token, isProdAuth()));
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        user: { username: appUser.username, isAdmin: false, valuebets: appUser.valuebets === true },
      }),
    );
    return;
  }

  const creds = getAuthCredentials();
  if (!creds) {
    // Auth-config saknas: fail closed. Aldrig avslöja vilket env-var som saknas.
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: "Auth not configured" }));
    return;
  }

  // Timing-safe username check
  const userMatch = (() => {
    const a = Buffer.from(username, "utf8");
    const b = Buffer.from(creds.username, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  })();

  let passwordMatch = false;
  if (creds.passwordHash) {
    passwordMatch = verifyPasswordHash(password, creds.passwordHash);
  } else if (creds.passwordPlain) {
    // Konsumera ändå hash-verifieringstiden om username inte matchar (timing).
    passwordMatch = verifyPasswordPlain(password, creds.passwordPlain);
  }

  if (!userMatch || !passwordMatch) {
    res.statusCode = 401;
    // Avsiktligt vag — avslöjar inte om username eller password var fel.
    res.end(JSON.stringify({ ok: false, error: "Invalid credentials" }));
    return;
  }

  // Lyckat login → reset rate-limit för IP:n, sätt cookie med aktuell
  // sessionVersion så framtida logout-all kan invalidera.
  resetAuthRateLimit(req);
  const token = signSessionToken(
    { u: creds.username, exp: Date.now() + AUTH_SESSION_TTL_MS, v: creds.sessionVersion },
    secret,
  );
  res.setHeader("Set-Cookie", buildSessionCookie(token, isProdAuth()));
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, user: { username: creds.username, isAdmin: true } }));
}

function authLogoutDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/auth/logout") {
    next();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }
  res.setHeader("Set-Cookie", buildClearCookie(isProdAuth()));
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}

function authMeDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/auth/me") {
    next();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }
  if (!authIsEnabled()) {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        authenticated: true,
        authDisabled: true,
        user: { username: "dev", isAdmin: true },
      }),
    );
    return;
  }
  const auth = getAuthFromRequest(req);
  if (!auth) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, authenticated: false }));
    return;
  }
  // Inkludera isAdmin så frontend kan rolla-baserat gömma/visa funktioner
  // (vanliga kunder → bara Autoclicker; admin → hela sajten). Kunder kan
  // dessutom ha per-användare-behörigheten `valuebets` (sätts i /admin/users).
  const isAdmin = isAdminUsername(auth.user);
  const meAppUser = isAdmin ? null : getAppUserByUsername(auth.user);
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      authenticated: true,
      user: {
        username: auth.user,
        isAdmin,
        valuebets: isAdmin || meAppUser?.valuebets === true,
        bonusFinder: isAdmin || meAppUser?.bonusFinder === true,
        bonusOptimizer: isAdmin || meAppUser?.bonusOptimizer === true,
        athena: isAdmin || meAppUser?.athena === true,
      },
    }),
  );
}

// =====================================================================
// ADMIN: change password + logout all sessions
// =====================================================================
// Endpoints kräver inloggad användare (skyddas av authGateMiddleware).
// Tillåter admin att rotera lösenord utan att röra Render env vars.

const ADMIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_RATE_LIMIT_MAX = 5;
const adminRateLimitBuckets = new Map<string, RateLimitBucket>();

function checkAdminRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterMs: number } {
  const ip = getClientIp(req);
  const now = Date.now();
  const b = adminRateLimitBuckets.get(ip);
  if (!b || b.resetAt < now) {
    adminRateLimitBuckets.set(ip, { count: 1, resetAt: now + ADMIN_RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (b.count >= ADMIN_RATE_LIMIT_MAX) return { allowed: false, retryAfterMs: b.resetAt - now };
  b.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

function adminAuthSettingsDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/admin/auth-settings") {
    next();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }
  const creds = getAuthCredentials();
  if (!creds) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: "Auth not configured" }));
    return;
  }
  // Aldrig returnera passwordHash till frontend.
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      username: creds.username,
      authSource: creds.source,
      sessionVersion: creds.sessionVersion,
      updatedAt: creds.updatedAt,
      // Heuristisk varning: Render free-tier har ephemeral disk.
      persistentDiskWarning:
        creds.source === "env"
          ? "No password file yet — using env credentials."
          : "Password stored in data/admin-auth.json. On Render free/standard without persistent disk this file is reset on redeploy. Configure a persistent disk to keep changes permanent.",
    }),
  );
}

async function adminChangePasswordDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/admin/change-password") {
    next();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }
  const rl = checkAdminRateLimit(req);
  if (!rl.allowed) {
    res.statusCode = 429;
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    res.end(JSON.stringify({ ok: false, error: "Too many attempts. Try again later." }));
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
    return;
  }
  let parsed: { currentPassword?: unknown; newPassword?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    return;
  }
  const currentPassword = typeof parsed.currentPassword === "string" ? parsed.currentPassword : "";
  const newPassword = typeof parsed.newPassword === "string" ? parsed.newPassword : "";

  // Aldrig logga lösenord. Logga bara metadata om något misslyckas.
  const validationErr = validateNewPassword(newPassword);
  if (validationErr) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: validationErr }));
    return;
  }

  const creds = getAuthCredentials();
  if (!creds) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: "Auth not configured" }));
    return;
  }

  // Verifiera nuvarande lösenord mot active source.
  let currentMatches = false;
  if (creds.passwordHash) {
    currentMatches = verifyPasswordHash(currentPassword, creds.passwordHash);
  } else if (creds.passwordPlain) {
    currentMatches = verifyPasswordPlain(currentPassword, creds.passwordPlain);
  }
  if (!currentMatches) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: "Current password is incorrect" }));
    return;
  }

  // Hasha nytt lösenord + skriv fil. Bevarar sessionVersion (vi tvingar
  // INTE re-login av andra sessioner vid lösenordsbyte — admin kan trycka
  // "Logout all" separat om de vill).
  const newHash = hashPasswordScrypt(newPassword);
  const fileExisting = readAdminAuthFile();
  const nextPayload: AdminAuthFile = {
    username: creds.username,
    passwordHash: newHash,
    sessionVersion: fileExisting?.sessionVersion ?? 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeAdminAuthFile(nextPayload);
  } catch (e) {
    console.error("[admin] write admin-auth.json failed:", e instanceof Error ? e.message : e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: "Failed to persist new password" }));
    return;
  }

  // Re-issue cookie för INLOGGAD admin så de inte slängs ut av att authSource
  // bytte från env → file (eller av sessionVersion-bump).
  const secret = getSessionSecret();
  if (secret) {
    const token = signSessionToken(
      { u: nextPayload.username, exp: Date.now() + AUTH_SESSION_TTL_MS, v: nextPayload.sessionVersion ?? 1 },
      secret,
    );
    res.setHeader("Set-Cookie", buildSessionCookie(token, isProdAuth()));
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, updatedAt: nextPayload.updatedAt, authSource: "file" }));
}

function adminLogoutAllDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/admin/logout-all") {
    next();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }
  const creds = getAuthCredentials();
  if (!creds) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: "Auth not configured" }));
    return;
  }
  // Kräver att vi har en file (annars finns ingen sessionVersion att bumpa).
  // Om source=env och file saknas → migrera env-credentials till en file med
  // bumpad sessionVersion. Detta gör att alla gamla cookies (v=0) invalideras
  // automatiskt.
  let fileExisting = readAdminAuthFile();
  if (!fileExisting) {
    if (!creds.passwordHash) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          ok: false,
          error: "Cannot logout-all: env auth has no APP_PASSWORD_HASH. Use change-password first.",
        }),
      );
      return;
    }
    fileExisting = {
      username: creds.username,
      passwordHash: creds.passwordHash,
      sessionVersion: 1,
      updatedAt: new Date().toISOString(),
    };
  }
  const bumped: AdminAuthFile = {
    ...fileExisting,
    sessionVersion: (fileExisting.sessionVersion ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeAdminAuthFile(bumped);
  } catch (e) {
    console.error("[admin] logout-all write failed:", e instanceof Error ? e.message : e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: "Failed to persist session version" }));
    return;
  }

  // Re-issue cookie för INLOGGAD admin med ny version (annars slängs hen ut
  // omedelbart av sin egen logout-all).
  const secret = getSessionSecret();
  if (secret) {
    const token = signSessionToken(
      { u: bumped.username, exp: Date.now() + AUTH_SESSION_TTL_MS, v: bumped.sessionVersion ?? 1 },
      secret,
    );
    res.setHeader("Set-Cookie", buildSessionCookie(token, isProdAuth()));
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, sessionVersion: bumped.sessionVersion, updatedAt: bumped.updatedAt }));
}

// =====================================================================
// END AUTH / ADMIN
// =====================================================================

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = 1_500_000;
  return await new Promise((resolve, reject) => {
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Mappar readRequestBody-fel (t.ex. för stor kropp) till HTTP-status. */
function jsonErrorFromUnknown(error: unknown, fallbackMessage: string): { status: number; payload: { ok: false; error: string } } {
  if (error instanceof Error && error.message === "Request body too large") {
    return { status: 413, payload: { ok: false, error: error.message } };
  }
  return {
    status: 500,
    payload: { ok: false, error: error instanceof Error ? error.message : fallbackMessage },
  };
}

function normalizeOdd(raw: string): number | null {
  const n = Number.parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) && n > 1 ? n : null;
}

function parseOddsRowsFromHtml(html: string) {
  const $ = load(html);
  const rows: Array<{ bookmaker: string; home: number; draw: number; away: number }> = [];

  $("tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 4) return;
    const texts = tds
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (texts.length < 4) return;

    const nums = texts.map(normalizeOdd);
    const candidates: number[] = [];
    for (const v of nums) {
      if (v != null) candidates.push(v);
      if (candidates.length === 3) break;
    }
    if (candidates.length !== 3) return;

    const bookmaker = texts.find((t) => !normalizeOdd(t) && t.length >= 2) ?? "";
    if (!bookmaker) return;

    rows.push({
      bookmaker,
      home: candidates[0],
      draw: candidates[1],
      away: candidates[2],
    });
  });

  return rows;
}

const ODDS_PORTAL_AES_KEY = "J*8sQ!p$7aD_fR2yW@gHn*3bVp#sAdLd_k";
const ODDS_PORTAL_AES_SALT = "5b9a8f2c3e6d1a4b7c8e9d0f1a2b3c4d";

function decryptOddsPortalPayload(payload: string): string {
  const outer = Buffer.from(payload.trim(), "base64").toString("utf-8");
  const [encryptedBase64, ivHex] = outer.split(":");
  if (!encryptedBase64 || !ivHex) throw new Error("Unexpected encrypted odds payload");

  const iv = Buffer.from(ivHex.match(/.{1,2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
  const key = crypto.pbkdf2Sync(
    Buffer.from(ODDS_PORTAL_AES_KEY),
    Buffer.from(ODDS_PORTAL_AES_SALT),
    1000,
    32,
    "sha256",
  );
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final(),
  ]);

  const unzipped =
    decrypted.length >= 2 && decrypted[0] === 0x1f && decrypted[1] === 0x8b
      ? zlib.gunzipSync(decrypted)
      : decrypted;
  return unzipped.toString("utf-8");
}

function extractPrematchOddsUrl(html: string): string | null {
  const decoded = html.replace(/&quot;/g, '"').replace(/\\\//g, "/");
  const match = /"requestPreMatch":\{"url":"([^"]+)"/.exec(decoded);
  if (!match) return null;
  return new URL(`${match[1]}${Date.now()}`, "https://www.oddsportal.com").toString();
}

function formatBookmakerNameFromSlug(slug: string): string {
  const known: Record<string, string> = {
    "10bet": "10bet",
    bet365: "Bet365",
    betfury: "BetFury",
    betmgm: "BetMGM",
    "betmgm-se": "BetMGM",
    bets: "Bets.io",
    "bets-io": "Bets.io",
    betsson: "Betsson",
    pinnacle: "Pinnacle",
    ps3838: "PS3838",
    smarkets: "Smarkets",
    expektse: "Expekt",
    nordicbet: "NordicBet",
    shuffle: "Shuffle",
    unibetse: "Unibet",
  };
  if (known[slug]) return known[slug];
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseBookmakerNamesFromBetslipUrls(bs?: Record<string, string[]>): Record<string, string> {
  const names: Record<string, string> = {};
  if (!bs) return names;

  for (const [id, urls] of Object.entries(bs)) {
    const url = urls.find(Boolean) ?? "";
    const slug = /\/bookmaker\/([^/]+)\//.exec(url)?.[1];
    if (slug) names[id] = formatBookmakerNameFromSlug(slug);
  }
  return names;
}

function parseOddsRowsFromMatchEventData(data: unknown) {
  const root = data as {
    d?: {
      oddsdata?: {
        back?: Record<string, { odds?: Record<string, Record<string, number>>; bs?: Record<string, string[]> }>;
      };
    };
  };
  const market = root.d?.oddsdata?.back?.["E-1-2-0-0-0"];
  if (!market?.odds) return [];

  const bookmakerNames = parseBookmakerNamesFromBetslipUrls(market.bs);
  return Object.entries(market.odds)
    .map(([bookmakerId, odds]) => ({
      bookmaker: bookmakerNames[bookmakerId] ?? `Bookmaker ${bookmakerId}`,
      home: Number(odds["0"] ?? 0),
      draw: Number(odds["1"] ?? 0),
      away: Number(odds["2"] ?? 0),
    }))
    .filter((row) => row.home > 1 && row.draw > 1 && row.away > 1);
}

async function parseOddsRowsFromOddsPortalMatch(html: string, sourceUrl: string) {
  const prematchUrl = extractPrematchOddsUrl(html);
  if (!prematchUrl) return [];

  const encrypted = await fetchHtml(prematchUrl, sourceUrl);
  const decrypted = decryptOddsPortalPayload(encrypted);
  const data = JSON.parse(decrypted) as unknown;
  return parseOddsRowsFromMatchEventData(data);
}

function extractKambiEventId(url: string): string | null {
  return /(?:#|\/)event\/(\d+)/i.exec(url)?.[1] ?? null;
}

const KAMBI_OFFERING_BY_HOSTNAME: Array<{ pattern: RegExp; offering: string; referer: string }> = [
  { pattern: /(^|\.)1x2\.se$/i, offering: "pafpre1x2se", referer: "https://www.1x2.se/betting" },
  { pattern: /speedybet\.com$/i, offering: "pafpre1x2se", referer: "https://www.speedybet.com/betting" },
  { pattern: /goldenbull\.se$/i, offering: "pafpre1x2se", referer: "https://www.goldenbull.se/betting" },
  { pattern: /x3000\.com$/i, offering: "pafpre1x2se", referer: "https://www.x3000.com/betting" },
  { pattern: /unibet\.se$/i, offering: "ubse", referer: "https://www.unibet.se/betting/sports/home" },
  { pattern: /leovegas\.com$/i, offering: "lvse", referer: "https://www.leovegas.com/sv-se/betting" },
  { pattern: /expekt\.se$/i, offering: "expektse", referer: "https://www.expekt.se/sports" },
  { pattern: /betmgm\.se$/i, offering: "betmgmse", referer: "https://www.betmgm.se/sport" },
];

function getKambiOfferingForHostname(hostname: string) {
  return KAMBI_OFFERING_BY_HOSTNAME.find((entry) => entry.pattern.test(hostname));
}

function isOneXTwoKambiUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return Boolean(getKambiOfferingForHostname(hostname));
  } catch {
    return false;
  }
}

function isBetssonSportsbookUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes("spelklubben.se") || hostname.includes("bethard.com") || hostname.includes("betsson.com") || hostname.includes("nordicbet.com") || hostname.includes("betsafe.com");
  } catch {
    return false;
  }
}

type OddsRow = { bookmaker: string; home: number; draw: number; away: number };
type BookmakerScrapeStatus = "found" | "not_found" | "blocked" | "error";
type BookmakerScrapeResult = {
  bookmakerId: string;
  bookmaker: string;
  status: BookmakerScrapeStatus;
  title?: string;
  home?: number;
  draw?: number;
  away?: number;
  sourceUrl?: string;
  error?: string;
  stale?: boolean;
  cachedAt?: string;
  mirroredFromBookmakerId?: string;
  mirroredFromBookmaker?: string;
};

const BOOKMAKER_SCRAPERS = [
  { id: "bet365", name: "Bet365", group: "unsupported" },
  { id: "unibet", name: "Unibet", group: "kambi", origin: "https://www.unibet.se", offering: "ubse", eventPath: "/betting/sports/event" },
  // Kambi-systerbrands (samma compilade Kambi-odds som Unibet → delar kambi-rows.json
  // via tryKambiFromGithubCache). Värdet = egna välkomstbonusar. offering bekräftad i
  // recon: expektse/betmgmse (200); lvse 429-throttlad men känd LeoVegas-slug.
  { id: "leovegas", name: "LeoVegas", group: "kambi", origin: "https://www.leovegas.com", offering: "lvse", eventPath: "/sv-se/betting/sports/event" },
  { id: "expekt", name: "Expekt", group: "kambi", origin: "https://www.expekt.se", offering: "expektse", eventPath: "/sports/event" },
  { id: "betmgm", name: "BetMGM", group: "kambi", origin: "https://www.betmgm.se", offering: "betmgmse", eventPath: "/sport/event" },
  { id: "hajper", name: "Hajper", group: "comeon", origin: "https://www.hajper.com", franchiseCode: "SWEDEN_HAJPER", pathPrefix: "hajper" },
  { id: "dbet", name: "DBET", group: "altenar", integration: "dbet", sportsUrl: "https://www.dbet.com/sv/sports/#/overview" },
  { id: "mrvegas", name: "MrVegas", group: "altenar", integration: "mrvegasse", sportsUrl: "https://www.mrvegas.com/sv/sports/#/overview" },
  { id: "megariches", name: "MegaRiches", group: "altenar", integration: "megarichesse", sportsUrl: "https://www.megariches.com/sv/sports/#/overview" },
  { id: "happycasino", name: "Happy Casino", group: "altenar", integration: "happycasino", sportsUrl: "https://happycasino.se/sports" },
  { id: "lucky", name: "Lucky", group: "altenar", integration: "luckycasino", sportsUrl: "https://www.luckycasino.com/sv/sports" },
  { id: "betinia", name: "Betinia", group: "altenar", integration: "betiniase2", sportsUrl: "https://betinia.se/sv/sportsbook" },
  { id: "quick", name: "Quick", group: "altenar", integration: "quickcasinose", sportsUrl: "https://quickcasino.se/sv/sportsbook" },
  { id: "megafortune", name: "MegaFortune", group: "altenar", integration: "megafortunese", sportsUrl: "https://www.megafortune.com/sv/sportsbook" },
  { id: "videoslots", name: "Videoslots", group: "altenar", integration: "videoslotsse", sportsUrl: "https://www.videoslots.com/sv/sports/#/overview/" },
  { id: "kungaslottet", name: "Kungaslottet", group: "altenar", integration: "kungaslottetse", sportsUrl: "https://www.kungaslottet.se/sports/#/overview/" },
  { id: "campobet", name: "CampoBet", group: "altenar", integration: "campose", sportsUrl: "https://campobet.se/sv/" },
  { id: "betsson", name: "Betsson", group: "betsson", origin: "https://www.betsson.com", basePath: "/sv/sport" },
  { id: "x3000", name: "X3000", group: "paf-brand", origin: "https://www.x3000.com", eventPath: "/betting#event" },
  { id: "goldenbull", name: "Golden Bull", group: "paf-brand", origin: "https://www.goldenbull.se", eventPath: "/betting#event" },
  { id: "1x2", name: "1x2", group: "paf-brand", origin: "https://www.1x2.se", eventPath: "/betting#event" },
  { id: "vbet", name: "VBET", group: "vbet", origin: "https://www.vbet.se" },
  { id: "coolbet", name: "Coolbet", group: "coolbet", origin: "https://www.coolbet.com" },
  { id: "svenskaspel", name: "Svenska Spel (Oddset)", group: "svenskaspel", origin: "https://spela.svenskaspel.se" },
  { id: "888sport", name: "888sport", group: "spectate888", origin: "https://www.888sport.se" },
  { id: "prontosport", name: "ProntoSport", group: "prontosport", origin: "https://www.prontosport.se" },
  { id: "tipwin", name: "Tipwin", group: "tipwin", origin: "https://tipwin.se" },
  { id: "10bet", name: "10bet", group: "tenbet", origin: "https://www.10bet.se" },
  { id: "speedybet", name: "Speedybet", group: "paf-brand", origin: "https://www.speedybet.com", eventPath: "/betting#event" },
  { id: "snabbare", name: "Snabbare", group: "comeon", origin: "https://www.snabbare.com", franchiseCode: "SWEDEN_SNABBARE", pathPrefix: "snabbare" },
  { id: "comeon", name: "ComeOn", group: "comeon", origin: "https://www.comeon.com", franchiseCode: "SWEDEN_COMEON", pathPrefix: "comeon" },
  { id: "casinostugan", name: "Casinostugan", group: "comeon", origin: "https://www.casinostugan.com", franchiseCode: "SWEDEN_CASINOSTUGAN", pathPrefix: "casinostugan" },
  { id: "lyllo", name: "Lyllo", group: "comeon", origin: "https://www.lyllocasino.com", franchiseCode: "SWEDEN_LYLLO", pathPrefix: "lyllo" },
  { id: "bethard", name: "Bethard", group: "betsson", origin: "https://www.bethard.com", basePath: "/sv/sports/sok" },
  { id: "spelklubben", name: "Spelklubben", group: "betsson", origin: "https://www.spelklubben.se", basePath: "/sv/betting/" },
  { id: "nordicbet", name: "NordicBet", group: "betsson", origin: "https://www.nordicbet.com", basePath: "/sv/sportsbook" },
  { id: "betsafe", name: "Betsafe", group: "betsson", origin: "https://www.betsafe.com", basePath: "/sv/sportsbook" },
] as const;

/**
 * SOURCE_REGISTRY — single source of truth för "hur ofta hämtas / hur gamla
 * kan oddsen bli". Synkad med scripts/audit-source-freshness.mjs.
 *
 * Konsumeras av /api/sources/status och /api/sources/audit för att exponera
 * stale-status till frontend och CLI-audit-script.
 *
 * Workflow / cron / stale-threshold MÅSTE uppdateras manuellt här när vi
 * ändrar .github/workflows/*.yml. Audit-scriptet flaggar diff mot YAML.
 */
type SourceRegistryEntry = {
  id: string;
  name: string;
  type:
    | "sharp"
    | "foreign_bookmaker"
    | "foreign_bookmaker_shared"
    | "foreign_bookmaker_group"
    | "external_drop_signal"
    | "on_demand";
  workflow?: string;
  cron?: string;
  fetchIntervalSeconds?: number;
  dataFile?: string;
  statusFile?: string;
  staleAfterSeconds: number;
  backendCacheTtlSeconds: number;
  note: string;
  /**
   * För foreign_bookmaker_shared: pekare till den master-cachefil som denna
   * källa delar med en annan bookmaker (samma sportsbook-backend).
   * Exempel:
   *   Hajper/Snabbare delar comeon-rows.json (samma RSocket /v4/events-API)
   *   Bethard/Spelklubben delar betsson-rows.json (samma group-search-API)
   *
   * För foreign_bookmaker_group: pekare till group-cachefilen som ÄR ägd
   * av gruppen (peer-relationship, ingen master).
   * Exempel: DBET/MrVegas/MegaRiches delar altenar-rows.json
   */
  sharedDataFile?: string;
  /**
   * För foreign_bookmaker_shared med dataShape="byFranchise":
   * vilken nyckel i `byFranchise` denna bookmakers events ligger under.
   */
  franchiseKey?: string;
  /**
   * För foreign_bookmaker_group med dataShape="byIntegration":
   * vilken nyckel i `byIntegration` denna bookmakers events ligger under.
   */
  integrationKey?: string;
  /**
   * Master-källans id (den bookmaker som workflow:n faktiskt fetchar).
   * Används för UI-rendering ("via Betsson cache") och så status-endpointen
   * vet vart den ska kolla för senaste error/status.
   */
  sharedWith?: string;
  /**
   * För foreign_bookmaker_group: gruppens id (t.ex. "altenar"). Används för
   * att gruppera UI och i debug-endpoints.
   */
  group?: string;
  /**
   * Coverage-klass: hur fullständigt täcker källan sina events?
   *   full    — bulk-endpoint eller fan-out som returnerar hela prematch-katalogen
   *   partial — endpoint är begränsad (search-baserad / region-fan-out / highlights+catalog)
   *   limited — endpoint returnerar bara delmängd (t.ex. promoted/recommended only)
   *   unknown — workflow inte konfigurerad / blocked / aldrig fetchad
   */
  coverageLevel?: "full" | "partial" | "limited" | "unknown";
  /** Människo-läsbar förklaring av coverage-strategin (visas i UI-tooltip). */
  coverageReason?: string;
  /**
   * Svensk-fokus-prioritet (vi prioriterar svenska sajter eftersom appen
   * är primärt för svensk match-betting):
   *   high   — svensk-licensierad sajt med egen marginal (unique odds)
   *   medium — svensk-licensierad men delar odds-feed med högre-prio sajt
   *   low    — paused/unavailable
   *   none   — icke-svensk (t.ex. Pinnacle ref)
   */
  swedishPriority?: "high" | "medium" | "low" | "none";
  /**
   * Andra källor som returnerar IDENTICAL odds (samma sportsbook-backend).
   * Visas i UI så användaren förstår att odds är duplicerade.
   * Exempel: Bethard.sharedOddsWith = ["betsson", "spelklubben"]
   */
  sharedOddsWith?: string[];
  /**
   * Senast uppmätt match-coverage mot Pinnacle (uppdateras av
   * scripts/audit-swedish-bookmaker-coverage.mjs). Snapshot-värde — för
   * realtids-coverage använd /api/debug/coverage.
   */
  matchCoveragePct?: number;
  matchedPinnacleEvents?: number;
};

const SOURCE_REGISTRY: SourceRegistryEntry[] = [
  {
    id: "pinnacle",
    name: "Pinnacle",
    type: "sharp",
    workflow: "pinnacle-fetch.yml",
    // Primär refresh: extern cron-job.org triggar workflow_dispatch var ~60s.
    // GitHub-cron */5 är BACKUP (GHA-minimum är 5 min). Effektiv data-cadens
    // ~60-120s. Sharp reference book — får ALDRIG vara så gammal som de
    // foreign bookmakers (där 30 min är OK).
    cron: "external 60s + GHA */5 backup",
    fetchIntervalSeconds: 60,
    dataFile: "pinnacle-rows.json",
    // Hard freshness gate: 3 min. /api/valuebets returnerar 0 valuebets om
    // Pinnacle är >3 min gammal (PINNACLE_FRESHNESS_THRESHOLD_MS).
    staleAfterSeconds: 3 * 60,
    backendCacheTtlSeconds: 5,
    note: "Reference book (no-vig). External cron 60s + Playwright cache → ~60-75s real cadence. Gates valuebets if >3min stale.",
  },
  {
    id: "sbobet",
    name: "SBOBET",
    type: "sharp",
    workflow: "sbobet-fetch.yml",
    // Självdrivande loop (~30s cadens, scrape→DB-spegling+commit) + */20-reseed.
    // SHARP: pollas mycket ofta så fair-price-blandningen aldrig blir stale.
    cron: "*/20 * * * * + självdrivande ~30s loop",
    fetchIntervalSeconds: 30,
    dataFile: "sbobet-rows.json",
    // ANVÄNDARVAL 2026-06-26: 60s. OBS: styr BARA admin-statusen. Den funktionella
    // valuebet-grinden använder SHARP_FRESHNESS_THRESHOLD_MS (oförändrad). MÄTT efter
    // speedup: en full sbobet-scrape tar ~8s (durationMs 7771, parallella vyer) → pollar
    // var ~20s (CADENCE-golvet) → DB speglas var ~20s → visad ålder ~40s i värsta fall.
    // 60s är därför tryggt under golvet (ingen VPN här). Display-cachen sänkt 30s→10s.
    // 120s: DB-spegeln ger ~20-30s när den lyckas, men GitHub-fallbacken (när DB
    // missar) går i git-commit-takt ~75s. 120s täcker fallbacken så admin aldrig
    // falsk-flaggar — rött = faktiskt avbrott (>2 min utan ny data).
    staleAfterSeconds: 120,
    backendCacheTtlSeconds: 15,
    note: "Andra sharp-källan (DOM-skrapa, ingen VPN). 1X2 + Asian Handicap — komplement till Pinnacle i fair price (vikt 0.95 på AH). Pollas ~20s (scrape ~8s, parallella vyer).",
  },
  {
    id: "betfair",
    name: "Betfair Exchange",
    type: "sharp",
    workflow: "betfair-fetch.yml",
    // Självdrivande loop via UK Mullvad-VPN (geo-blockerad i SE/US), ~30s cadens.
    // SHARP: katalog-enum + PARALLELL readonly/bymarket per iteration (~20-25s) → DB
    // speglas varje scrape så börsen är mycket färsk.
    cron: "*/20 * * * * + självdrivande ~30s loop (UK VPN)",
    fetchIntervalSeconds: 30,
    dataFile: "betfair-rows.json",
    // ANVÄNDARVAL 2026-06-27: 75s. OBS: styr BARA admin-statusen. Den funktionella
    // valuebet-grinden använder SHARP_FRESHNESS_THRESHOLD_MS (oförändrad). MÄTT efter
    // speedup: full scrape ~31s (durationMs 31205), varav bymarket-fetch bara ~2.4s
    // (fetchMs 2363 → UK-VPN är snabb). Pollar var ~31s → DB speglas var ~31s → visad
    // ålder ~51s i värsta fall. 75s = tät övervakning med marginal mot en enstaka
    // sid-laddnings-stall (goto kan hänga mot sin 60s-timeout). Ej 60s pga den risken.
    // 120s: DB-spegeln ger ~30s när den lyckas, men över UK-VPN kan den missa →
    // GitHub-fallbacken (git-commit-takt ~75s) tar över. 120s täcker fallbacken så
    // admin aldrig falsk-flaggar — rött = faktiskt avbrott (>2 min utan ny data).
    staleAfterSeconds: 120,
    backendCacheTtlSeconds: 15,
    note: "Börs (back/lay + djup + matchad volym). 1X2 + Over/Under + Asian Handicap via publik readonly-feed över UK-VPN, ~156 events. Likviditetsvägd. Pollas ~40-60s (UK-VPN är golvet).",
  },
  {
    id: "comeon",
    name: "ComeOn",
    type: "foreign_bookmaker",
    workflow: "comeon-fetch.yml",
    cron: "*/10 * * * *",
    fetchIntervalSeconds: 10 * 60,
    dataFile: "comeon-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared backend with Hajper/Snabbare",
  },
  {
    id: "betsson",
    name: "Betsson",
    type: "foreign_bookmaker",
    workflow: "betsson-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    dataFile: "betsson-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared backend with Bethard/Spelklubben",
  },
  {
    id: "coolbet",
    name: "Coolbet",
    type: "foreign_bookmaker",
    workflow: "coolbet-fetch.yml",
    cron: "*/3 * * * *",
    fetchIntervalSeconds: 3 * 60,
    dataFile: "coolbet-rows.json",
    // 45 min: coolbet pollas budget-pacat i paid-loopen (var 2:a cykel ≈ 14 min normalt).
    // 30 min flaggade falskt så fort en cykel slank (mjuk bok → behöver ej sharp-färskhet;
    // valuebets gatas på PINNACLE-färskhet, ej coolbet). 45 min = 3 cadens-marginal → rött
    // betyder faktiskt avbrott, inte normal budget-takt.
    staleAfterSeconds: 45 * 60,
    backendCacheTtlSeconds: 60,
    note: "VPS stealth-browser (Playwright): REST-katalog + pris-websocket. Förbi Imperva.",
  },
  {
    id: "svenskaspel",
    name: "Svenska Spel (Oddset)",
    type: "foreign_bookmaker",
    workflow: "svenskaspel-fetch.yml",
    cron: "*/10 * * * *",
    fetchIntervalSeconds: 10 * 60,
    dataFile: "svenskaspel-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Oddset (Kambi offering=svenskaspel). 1X2 + totals/AH via per-event detalj. Bonus-bookmaker (egna odds, ej Unibets).",
  },
  {
    id: "888sport",
    name: "888sport",
    type: "foreign_bookmaker",
    workflow: "888sport-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    dataFile: "888sport-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Spectate prematch-1X2 (getUpcomingEvents) via Mullvad. Bonus-bookmaker.",
  },
  {
    id: "prontosport",
    name: "ProntoSport",
    type: "foreign_bookmaker",
    workflow: "prontosport-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    dataFile: "prontosport-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "ABM/Euro prematch-1X2 DOM-skrapad (/sv/euro/sport/soccer) via Mullvad.",
  },
  {
    id: "tipwin",
    name: "Tipwin",
    type: "foreign_bookmaker",
    workflow: "tipwin-fetch.yml",
    cron: "*/30 * * * *",
    fetchIntervalSeconds: 30 * 60,
    dataFile: "tipwin-rows.json",
    staleAfterSeconds: 60 * 60,
    backendCacheTtlSeconds: 60,
    note: "GP/NSoft offer/data (gzip+base62-filter) via Scrapfly. 1X2+totals. Bonus-bookmaker.",
  },
  {
    id: "10bet",
    name: "10bet",
    type: "foreign_bookmaker",
    workflow: "10bet-fetch.yml",
    cron: "*/30 * * * *",
    fetchIntervalSeconds: 30 * 60,
    dataFile: "10bet-rows.json",
    staleAfterSeconds: 60 * 60,
    backendCacheTtlSeconds: 60,
    note: "Playtech Vision-widget DOM-skrapad (scroll-burst+settle, MRES=1X2) via Scrapfly. Bonus-bookmaker.",
  },
  {
    id: "smarkets",
    name: "Smarkets",
    type: "foreign_bookmaker",
    workflow: "smarkets-fetch.yml",
    cron: "*/10 * * * *",
    fetchIntervalSeconds: 10 * 60,
    dataFile: "smarkets-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Betting-börs (back + lay, 2% kommission). Öppet API, ingen VPN.",
  },
  {
    id: "vbet",
    name: "VBET",
    type: "foreign_bookmaker",
    workflow: "vbet-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    dataFile: "vbet-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Svensk bookmaker — swarm-WS via Mullvad VPN (Cloudflare blockar Azure)",
  },
  // Foreign bookmaker shared cache: bokmakare som delar workflow + cachefil
  // med en annan master-källa. Ingen ny scraping krävs — vi läser ut den brand-
  // specifika del av masterns cache som redan finns.
  //
  // Hajper/Snabbare: ComeOn-workflow:n fetchar 3 franchises samtidigt
  //   (SWEDEN_HAJPER, SWEDEN_SNABBARE, SWEDEN_COMEON) och sparar i byFranchise.
  //   Cache-first-vägen tryComeOnFromGithubCache() är redan implementerad i
  //   scrapeComeOnBookmaker.
  // Bethard/Spelklubben: Betsson-gruppen returnerar identiska 1X2-odds för alla
  //   3 sajter (dokumenterat i SAME_ODDS_FALLBACK_GROUPS). Cache-first via
  //   tryBetssonFromGithubCache() är redan implementerad.
  {
    id: "hajper",
    name: "Hajper",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "comeon-rows.json",
    franchiseKey: "SWEDEN_HAJPER",
    sharedWith: "comeon",
    fetchIntervalSeconds: 10 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via comeon-fetch.yml (byFranchise.SWEDEN_HAJPER)",
  },
  {
    id: "snabbare",
    name: "Snabbare",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "comeon-rows.json",
    franchiseKey: "SWEDEN_SNABBARE",
    sharedWith: "comeon",
    fetchIntervalSeconds: 10 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via comeon-fetch.yml (byFranchise.SWEDEN_SNABBARE)",
  },
  {
    id: "casinostugan",
    name: "Casinostugan",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "comeon-rows.json",
    franchiseKey: "SWEDEN_CASINOSTUGAN",
    sharedWith: "comeon",
    fetchIntervalSeconds: 10 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via comeon-fetch.yml (byFranchise.SWEDEN_CASINOSTUGAN)",
  },
  {
    id: "lyllo",
    name: "Lyllo",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "comeon-rows.json",
    franchiseKey: "SWEDEN_LYLLO",
    sharedWith: "comeon",
    fetchIntervalSeconds: 10 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via comeon-fetch.yml (byFranchise.SWEDEN_LYLLO)",
  },
  {
    id: "bethard",
    name: "Bethard",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "betsson-rows.json",
    sharedWith: "betsson",
    fetchIntervalSeconds: 15 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via betsson-fetch.yml (same group backend, identical 1X2)",
  },
  {
    id: "spelklubben",
    name: "Spelklubben",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "betsson-rows.json",
    sharedWith: "betsson",
    fetchIntervalSeconds: 15 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via betsson-fetch.yml (same group backend, identical 1X2)",
  },
  {
    id: "nordicbet",
    name: "NordicBet",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "betsson-rows.json",
    sharedWith: "betsson",
    fetchIntervalSeconds: 15 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via betsson-fetch.yml (Betsson Group unified sportsbook, identical 1X2)",
  },
  {
    id: "betsafe",
    name: "Betsafe",
    type: "foreign_bookmaker_shared",
    sharedDataFile: "betsson-rows.json",
    sharedWith: "betsson",
    fetchIntervalSeconds: 15 * 60,
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Shared cache via betsson-fetch.yml (Betsson Group unified sportsbook, identical 1X2)",
  },
  // Altenar-gruppen: workflow .github/workflows/altenar-fetch.yml fetchar
  // alla 3 integrationer i en bulk-payload. Backend cache-first via
  // tryAltenarFromGithubCache() med 30min max-age policy innan on-demand
  // fallback tar över.
  {
    id: "dbet",
    name: "DBET",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "dbet",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.dbet)",
  },
  {
    id: "mrvegas",
    name: "MrVegas",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "mrvegasse",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.mrvegasse)",
  },
  {
    id: "megariches",
    name: "MegaRiches",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 15 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "megarichesse",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.megarichesse)",
  },
  {
    id: "happycasino",
    name: "Happy Casino",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "happycasino",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.happycasino)",
  },
  {
    id: "lucky",
    name: "Lucky",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "luckycasino",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.luckycasino)",
  },
  {
    id: "betinia",
    name: "Betinia",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "betiniase2",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.betiniase2)",
  },
  {
    id: "quick",
    name: "Quick",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "quickcasinose",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.quickcasinose)",
  },
  {
    id: "videoslots",
    name: "Videoslots",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "videoslotsse",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.videoslotsse) — Videoslots Ltd",
  },
  {
    id: "kungaslottet",
    name: "Kungaslottet",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "kungaslottetse",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.kungaslottetse) — Videoslots Ltd, syster till Videoslots",
  },
  {
    id: "campobet",
    name: "CampoBet",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "campose",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.campose) — finder-only bonus-bookmaker",
  },
  {
    id: "megafortune",
    name: "MegaFortune",
    type: "foreign_bookmaker_group",
    group: "altenar",
    workflow: "altenar-fetch.yml",
    cron: "*/15 * * * *",
    fetchIntervalSeconds: 5 * 60,
    sharedDataFile: "altenar-rows.json",
    integrationKey: "megafortunese",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Altenar group cache (byIntegration.megafortunese) — Immense-grupp, syster till MegaRiches",
  },
  // Kambi-gruppen (Unibet — ubse-offering): workflow .github/workflows/kambi-
  // fetch.yml fetchar listView/football/{region}.json fan-out var 10:e min
  // och sparar i events[]-shape. Cache-first via tryKambiFromGithubCache.
  {
    id: "unibet",
    name: "Unibet",
    type: "foreign_bookmaker",
    workflow: "kambi-fetch.yml",
    cron: "*/10 * * * *",
    fetchIntervalSeconds: 10 * 60,
    dataFile: "kambi-rows.json",
    staleAfterSeconds: 30 * 60,
    backendCacheTtlSeconds: 60,
    note: "Kambi listView/football fan-out (ubse offering, embedded betOffers)",
  },
  // Paf-brand-gruppen: workflow .github/workflows/paf-brand-fetch.yml kör ~47
  // strategiska queries per brand var 20:e min. Search-based "prewarm cache"
  // — inte full coverage. Cache-miss → live smart-search fallback.
  {
    id: "x3000",
    name: "X3000",
    type: "foreign_bookmaker_group",
    group: "paf-brand",
    workflow: "paf-brand-fetch.yml",
    cron: "*/20 * * * *",
    fetchIntervalSeconds: 20 * 60,
    sharedDataFile: "paf-brand-rows.json",
    integrationKey: "x3000",
    staleAfterSeconds: 60 * 60,
    backendCacheTtlSeconds: 60,
    note: "Paf-brand prewarm cache (search-based, ~47 queries per brand)",
  },
  {
    id: "goldenbull",
    name: "Golden Bull",
    type: "foreign_bookmaker_group",
    group: "paf-brand",
    workflow: "paf-brand-fetch.yml",
    cron: "*/20 * * * *",
    fetchIntervalSeconds: 20 * 60,
    sharedDataFile: "paf-brand-rows.json",
    integrationKey: "goldenbull",
    staleAfterSeconds: 60 * 60,
    backendCacheTtlSeconds: 60,
    note: "Paf-brand prewarm cache (search-based, ~47 queries per brand)",
  },
  {
    id: "1x2",
    name: "1x2",
    type: "foreign_bookmaker_group",
    group: "paf-brand",
    workflow: "paf-brand-fetch.yml",
    cron: "*/20 * * * *",
    fetchIntervalSeconds: 20 * 60,
    sharedDataFile: "paf-brand-rows.json",
    integrationKey: "oneTwo",
    staleAfterSeconds: 60 * 60,
    backendCacheTtlSeconds: 60,
    note: "Paf-brand prewarm cache (search-based, ~47 queries per brand)",
  },
  {
    id: "speedybet",
    name: "Speedybet",
    type: "foreign_bookmaker_group",
    group: "paf-brand",
    workflow: "paf-brand-fetch.yml",
    cron: "*/20 * * * *",
    fetchIntervalSeconds: 20 * 60,
    sharedDataFile: "paf-brand-rows.json",
    integrationKey: "speedybet",
    staleAfterSeconds: 60 * 60,
    backendCacheTtlSeconds: 60,
    note: "Paf-brand prewarm cache (search-based, ~47 queries per brand)",
  },
];

function getSourceMeta(id: string): SourceRegistryEntry | undefined {
  return SOURCE_REGISTRY.find((s) => s.id === id);
}

// Coverage-klass per källa — baseras på faktisk endpoint-typ + audit-resultat
// från scripts/audit-bookmaker-coverage.mjs. Visas transparent i UI så
// användaren förstår VARFÖR vissa källor har färre rows än andra.
const SOURCE_COVERAGE: Record<string, { level: NonNullable<SourceRegistryEntry["coverageLevel"]>; reason: string }> = {
  // full — bulk/fan-out som returnerar hela katalogen
  pinnacle: {
    level: "full",
    reason: "Sharp reference — bulk fetch across all major sports + markets",
  },
  betsson: {
    level: "full",
    reason: "Bulk Playtech accordion API — same backend serves Bethard/Spelklubben (identical 1X2)",
  },
  bethard: {
    level: "full",
    reason: "Inherits Betsson group cache — identical 1X2 odds across all 3 sites",
  },
  spelklubben: {
    level: "full",
    reason: "Inherits Betsson group cache — identical 1X2 odds across all 3 sites",
  },
  nordicbet: {
    level: "full",
    reason: "Inherits Betsson group cache — Betsson Group unified sportsbook, identical 1X2",
  },
  betsafe: {
    level: "full",
    reason: "Inherits Betsson group cache — Betsson Group unified sportsbook, identical 1X2",
  },
  dbet: {
    level: "full",
    reason: "Bulk Altenar GetUpcoming widget — full sportId=66 (football) prematch catalog",
  },
  mrvegas: {
    level: "full",
    reason: "Bulk Altenar GetUpcoming widget — full sportId=66 (football) prematch catalog",
  },
  megariches: {
    level: "full",
    reason: "Bulk Altenar GetUpcoming widget — full sportId=66 (football) prematch catalog",
  },
  comeon: {
    level: "partial",
    reason: "Smart-search + per-event RSocket — ComeOn brand catalog itself is small (~0 events typical), Hajper/Snabbare have larger catalogs (~60-100 events).",
  },
  hajper: {
    level: "partial",
    reason: "Smart-search + per-event RSocket — brand-specific catalog (~90 events typical, more than ComeOn/Snabbare since brand markets PL/major leagues).",
  },
  snabbare: {
    level: "partial",
    reason: "Smart-search + per-event RSocket — brand-specific catalog (~60 events typical, smaller than Hajper since brand has Sweden-focus).",
  },
  casinostugan: {
    level: "partial",
    reason: "Smart-search + per-event RSocket — ComeOn-group brand (SWEDEN_CASINOSTUGAN), brand-specifik katalog.",
  },
  lyllo: {
    level: "partial",
    reason: "Smart-search + per-event RSocket — ComeOn-group brand (SWEDEN_LYLLO), brand-specifik katalog.",
  },
  unibet: {
    level: "partial",
    reason: "Kambi listView fan-out across 8 region paths — 'ubse' offering only supports ~2 regions (all/all + england/all). Typical ~140-160 events.",
  },
  x3000: {
    level: "partial",
    reason: "Search-based prewarm cache — coverage depends on ~47 configured queries (top leagues + teams). Live fallback handles cache misses.",
  },
  goldenbull: {
    level: "partial",
    reason: "Search-based prewarm cache — coverage depends on ~47 configured queries (top leagues + teams). Live fallback handles cache misses.",
  },
  "1x2": {
    level: "partial",
    reason: "Search-based prewarm cache — coverage depends on ~47 configured queries (top leagues + teams). Live fallback handles cache misses.",
  },
  speedybet: {
    level: "partial",
    reason: "Search-based prewarm cache — coverage depends on ~47 configured queries (top leagues + teams). Live fallback handles cache misses.",
  },
  // partial — swarm-WS search-baserad via Mullvad VPN
  vbet: {
    level: "partial",
    reason: "Swarm WebSocket per Pinnacle-team via Mullvad VPN (Cloudflare blockar GitHub Azure-IPs direkt). ~13 events lokalt test.",
  },
};

// Populera coverage-fälten på alla registry-entries.
for (const meta of SOURCE_REGISTRY) {
  const cov = SOURCE_COVERAGE[meta.id];
  if (cov) {
    meta.coverageLevel = cov.level;
    meta.coverageReason = cov.reason;
  } else {
    meta.coverageLevel = "unknown";
    meta.coverageReason = "Coverage level not classified yet";
  }
}

// Svensk-fokus: vilka sajter är licensierade i Sverige + har egen marginal?
// Audit-baserad coverage% snapshot från scripts/audit-swedish-bookmaker-coverage.mjs
// (uppdateras vid major changes). Inkluderas så Home-UI kan filtrera/sortera
// efter svensk relevans.
const SWEDISH_METADATA: Record<string, {
  priority: NonNullable<SourceRegistryEntry["swedishPriority"]>;
  sharedOddsWith?: string[];
  matchCoveragePct?: number;
}> = {
  // Altenar-gruppen — best Pinnacle-coverage (79%), egen marginal per integration
  dbet:       { priority: "high", matchCoveragePct: 79 },
  mrvegas:    { priority: "high", matchCoveragePct: 79 },
  megariches: { priority: "high", matchCoveragePct: 79 },
  // Paf-brand prewarm — 49% coverage (efter query-utökning 2026-05-19)
  x3000:      { priority: "high", matchCoveragePct: 49 },
  goldenbull: { priority: "high", matchCoveragePct: 49 },
  "1x2":      { priority: "high", matchCoveragePct: 49 },
  speedybet:  { priority: "high", matchCoveragePct: 49 },
  // Betsson-gruppen — Betsson har egen marginal, Bethard/Spelklubben delar feed
  betsson:    { priority: "high",   matchCoveragePct: 23, sharedOddsWith: ["bethard", "spelklubben"] },
  bethard:    { priority: "medium", matchCoveragePct: 23, sharedOddsWith: ["betsson", "spelklubben"] },
  spelklubben:{ priority: "medium", matchCoveragePct: 23, sharedOddsWith: ["betsson", "bethard"] },
  nordicbet:  { priority: "medium", matchCoveragePct: 23, sharedOddsWith: ["betsson", "bethard", "spelklubben"] },
  betsafe:    { priority: "medium", matchCoveragePct: 23, sharedOddsWith: ["betsson", "bethard", "spelklubben", "nordicbet"] },
  // ComeOn-gruppen — varje brand har egen marginal men brand-specifika kataloger
  hajper:     { priority: "high", matchCoveragePct: 19 },
  unibet:     { priority: "high", matchCoveragePct: 16 },
  snabbare:   { priority: "high", matchCoveragePct: 13 },
  comeon:     { priority: "high", matchCoveragePct: 0 },
  casinostugan: { priority: "high", matchCoveragePct: 0 },
  lyllo:      { priority: "high", matchCoveragePct: 0 },
  // VBET — re-enabled 2026-05-25 via Mullvad VPN
  vbet:       { priority: "high", matchCoveragePct: 5 },
  // Icke-svenska — markera som "none" så UI kan filtrera bort
  pinnacle:     { priority: "none" },
};

for (const meta of SOURCE_REGISTRY) {
  const sw = SWEDISH_METADATA[meta.id];
  if (sw) {
    meta.swedishPriority = sw.priority;
    if (sw.sharedOddsWith) meta.sharedOddsWith = sw.sharedOddsWith;
    if (sw.matchCoveragePct != null) meta.matchCoveragePct = sw.matchCoveragePct;
  }
}

const SAME_ODDS_FALLBACK_GROUPS = [
  /** Playtech/Betsson — identisk 1X2-widget för Bethard/Spelklubben/Betsson. */
  ["betsson", "bethard", "spelklubben", "nordicbet", "betsafe"],
  /** ComeOn / Hajper / Snabbare — samma sportsbook-API. */
  ["comeon", "hajper", "snabbare", "casinostugan", "lyllo"],
  /** PAF / Kambi SE — samma prematch-event och 1X2 mellan varumärkena (ubse/Unibet utelämnad pga annan marginal). */
  ["x3000", "goldenbull", "1x2", "speedybet"],
  /** Altenar SE — ofta samma rader mellan varumärkena (speglas bara vid fel/not_found). */
  ["dbet", "mrvegas", "megariches", "happycasino", "lucky", "betinia", "quick", "videoslots", "kungaslottet", "campobet"],
] as const;

function isCompleteBonusOddsTriple(t: Partial<Record<Outcome, number>> | undefined): t is OddsTriple {
  return Boolean(t && t["1"] > 1 && t.X > 1 && t["2"] > 1);
}

/**
 * När minst en syster-bookmaker i samma odds-grupp har 1X2, kopiera till saknade ID:n.
 * Kompenserar för att inte alla scrapers alltid returnerar KOMPLETTA rader per brand.
 *
 * VIKTIGT (2026-06-19, fix): fyll BARA ett brand som redan returnerat NÅGOT för
 * matchen (en post finns = brandet listar matchen, men skrapet blev ofullständigt).
 * Hitta ALDRIG på odds för ett brand som SAKNAR post helt — det skapade "spök-odds"
 * för matcher brandet inte ens har (t.ex. Golden Bull-odds på en match som inte
 * finns på Golden Bull). Bonus-optimeraren visade då odds som inte existerar.
 */
function fillBonusOddsMatrixFromFallbackGroups(
  odds: Partial<Record<BonusBookmakerId, OddsTriple>>,
): Partial<Record<BonusBookmakerId, OddsTriple>> {
  const out: Partial<Record<BonusBookmakerId, OddsTriple>> = { ...odds };
  for (const group of SAME_ODDS_FALLBACK_GROUPS) {
    const sourceRaw = group.find((id) => isCompleteBonusOddsTriple(out[id as BonusBookmakerId]));
    if (!sourceRaw) continue;
    const triple = out[sourceRaw as BonusBookmakerId]!;
    for (const rawId of group) {
      const id = rawId as BonusBookmakerId;
      if (isCompleteBonusOddsTriple(out[id])) continue;
      // Brandet saknar post helt → täcker inte matchen → fyll INTE (annars spök-odds).
      if (out[id] === undefined) continue;
      out[id] = { "1": triple["1"], X: triple.X, "2": triple["2"] };
    }
  }
  return out;
}

/**
 * SANITY-FILTER (2026-06-19) för Bonus-optimeraren: släng bookmaker-odds som
 * grovt motsäger konsensus bland övriga bookmakers för matchen — det fångar
 * datafel och hemma/borta-FLIP (t.ex. en bok visar "1"=1.29 när alla andra har
 * ~3.0, eller en flippad triple där 1↔2 hamnat fel). Valuebettern filtrerar
 * sådant via Pinnacle-verifiering; optimeraren gjorde inte det och rankade då
 * felaktiga odds högst (de ser ut som bäst värde). Kräver ≥3 bookmakers för en
 * meningsfull median; annars rörs inget.
 */
function dropMisalignedBookmakerOdds(
  odds: Partial<Record<BonusBookmakerId, OddsTriple>>,
): Partial<Record<BonusBookmakerId, OddsTriple>> {
  const entries = Object.entries(odds).filter(
    (e): e is [string, OddsTriple] => isCompleteBonusOddsTriple(e[1]),
  );
  if (entries.length < 3) return odds; // för få för konsensus → rör inget
  const median = (vals: number[]): number => {
    const s = [...vals].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const med: Record<Outcome, number> = {
    "1": median(entries.map(([, t]) => t["1"])),
    X: median(entries.map(([, t]) => t.X)),
    "2": median(entries.map(([, t]) => t["2"])),
  };
  // En boks odds för ett utfall får inte vara < 0.55× eller > 1.85× medianen.
  // Ett flip ger BÅDE en låg och en hög avvikare i samma triple → fångas.
  const LO = 0.55, HI = 1.85;
  const out: Partial<Record<BonusBookmakerId, OddsTriple>> = {};
  for (const [id, t] of Object.entries(odds)) {
    if (!isCompleteBonusOddsTriple(t)) { out[id as BonusBookmakerId] = t; continue; }
    const bad = (["1", "X", "2"] as Outcome[]).some((o) => {
      const m = med[o];
      return m > 1 && (t[o] < m * LO || t[o] > m * HI);
    });
    if (!bad) out[id as BonusBookmakerId] = t; // behåll bara rimliga odds
  }
  return out;
}

function makeBookmakerResult(
  spec: (typeof BOOKMAKER_SCRAPERS)[number],
  status: BookmakerScrapeStatus,
  details: Partial<BookmakerScrapeResult> = {},
): BookmakerScrapeResult {
  return {
    bookmakerId: spec.id,
    bookmaker: spec.name,
    status,
    ...details,
  };
}

function isComeOnSportsbookUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes("comeon.com") || hostname.includes("hajper.com") || hostname.includes("snabbare.com") || hostname.includes("casinostugan.com") || hostname.includes("lyllocasino.com");
  } catch {
    return false;
  }
}

function kambiMainOfferLineActive(status: unknown, allowSuspended: boolean): boolean {
  const s = String(status ?? "").trim().toUpperCase();
  if (!s || s === "OPEN") return true;
  return allowSuspended && s === "SUSPENDED";
}

function kambiMainOfferTriple(
  mainOffer: { outcomes?: Array<{ label?: string; odds?: number; status?: string }> },
  allowSuspended: boolean,
): { home: number; draw: number; away: number } | null {
  if (!mainOffer.outcomes || mainOffer.outcomes.length !== 3) return null;
  const oddsByLabel = Object.fromEntries(
    mainOffer.outcomes
      .filter(
        (outcome) =>
          kambiMainOfferLineActive(outcome.status, allowSuspended) && outcome.label && outcome.odds != null,
      )
      .map((outcome) => [outcome.label, Number(outcome.odds) / 1000]),
  );
  const home = oddsByLabel["1"];
  const draw = oddsByLabel.X;
  const away = oddsByLabel["2"];
  if (!(home > 1 && draw > 1 && away > 1)) return null;
  return { home, draw, away };
}

/**
 * 2-vägs (tennis, basketball, baseball, MMA, boxing, hockey-incl-OT) — bara
 * home/away, ingen draw. Hittas i Kambi-svar med outcomes.length === 2 där
 * labels är "1" och "2" (eller OT_ONE/OT_TWO i type-fältet).
 */
function kambiMainOfferPair(
  mainOffer: { outcomes?: Array<{ label?: string; type?: string; odds?: number; status?: string }> },
  allowSuspended: boolean,
): { home: number; away: number } | null {
  if (!mainOffer.outcomes || mainOffer.outcomes.length !== 2) return null;
  const findOdds = (predicate: (o: { label?: string; type?: string }) => boolean) => {
    const outcome = mainOffer.outcomes!.find(
      (o) => predicate(o) && kambiMainOfferLineActive(o.status, allowSuspended) && o.odds != null,
    );
    return outcome ? Number(outcome.odds) / 1000 : NaN;
  };
  // Föredra label-matchning ("1"/"2") med fallback till type-fältet
  // (OT_ONE/OT_TWO används i tennis/basketball).
  const home =
    findOdds((o) => o.label === "1") ||
    findOdds((o) => o.type === "OT_ONE");
  const away =
    findOdds((o) => o.label === "2") ||
    findOdds((o) => o.type === "OT_TWO");
  if (!(home > 1 && away > 1)) return null;
  return { home, away };
}

type KambiMainBetOffer = {
  betOfferType?: { englishName?: string };
  criterion?: { englishLabel?: string };
  outcomes?: Array<{ label?: string; odds?: number; status?: string; type?: string }>;
  tags?: string[];
};

/** Hitta huvudmarknad 1X2 — tolererar saknad MAIN-tagg eller etiketten Fulltid. */
function findKambiMatchMainOffer(betOffers: KambiMainBetOffer[] | undefined): KambiMainBetOffer | null {
  if (!betOffers?.length) return null;
  const labelsStr = (offer: KambiMainBetOffer) => (offer.outcomes ?? []).map((o) => o.label).join("|");
  const isMatchFullTime = (offer: KambiMainBetOffer) => {
    if (offer.betOfferType?.englishName !== "Match") return false;
    const crit = String(offer.criterion?.englishLabel ?? "").trim().toLowerCase();
    return crit === "full time" || crit === "fulltid";
  };
  return (
    betOffers.find((o) => isMatchFullTime(o) && labelsStr(o) === "1|X|2" && o.tags?.includes("MAIN")) ??
    betOffers.find((o) => isMatchFullTime(o) && labelsStr(o) === "1|X|2")
  );
}

function parseKambiMainOffer(data: unknown) {
  const root = data as { betOffers?: KambiMainBetOffer[] };
  const mainOffer = findKambiMatchMainOffer(root.betOffers);
  if (!mainOffer?.outcomes || mainOffer.outcomes.length !== 3) return null;
  return kambiMainOfferTriple(mainOffer, false) ?? kambiMainOfferTriple(mainOffer, true);
}

/**
 * Multi-sport stöd (Phase 2). Sport → Kambi URL-path, Altenar sportId,
 * och marknadstyp (1X2 vs ML2). Karta över sporter Bonus Finder stödjer.
 *
 * För ice-hockey väljer vi "ML2 inkl. förlängning" (Kambi `ice_hockey`
 * med MAIN-flaggad 2-utfalls-marknad) för att alla rader ska kunna hedge:as
 * med sina 2-vägs motsvarigheter hos andra bookmakers.
 */
type SportKey = "tennis" | "ice-hockey" | "basketball" | "baseball" | "mma" | "boxing";

const MULTI_SPORT_CATALOG: Record<SportKey, {
  kambiPath: string;
  altenarSportId: number;
  marketType: "ML2";
  label: string;
}> = {
  tennis:       { kambiPath: "tennis",     altenarSportId: 68,  marketType: "ML2", label: "Tennis" },
  "ice-hockey": { kambiPath: "ice_hockey", altenarSportId: 70,  marketType: "ML2", label: "Ishockey" },
  basketball:   { kambiPath: "basketball", altenarSportId: 67,  marketType: "ML2", label: "Basket" },
  baseball:     { kambiPath: "baseball",   altenarSportId: 76,  marketType: "ML2", label: "Baseball" },
  mma:          { kambiPath: "ufc_mma",    altenarSportId: 84,  marketType: "ML2", label: "MMA" },
  boxing:       { kambiPath: "boxing",     altenarSportId: 71,  marketType: "ML2", label: "Boxning" },
};

const MULTI_SPORT_KEYS: SportKey[] = ["tennis", "ice-hockey", "basketball", "baseball", "mma", "boxing"];

/**
 * Detektera 2-vägs main-marknad i Kambi-betoffer-svar.
 * Använd `tags: ["MAIN"]`-flaggan plus outcome.type (OT_ONE/OT_TWO) eller
 * labels "1"/"2" som primär identifierare. Robust över sporter.
 */
function findKambiTwoWayMainOffer(betOffers: KambiMainBetOffer[] | undefined): KambiMainBetOffer | null {
  if (!betOffers?.length) return null;
  const isMatch = (offer: KambiMainBetOffer) => offer.betOfferType?.englishName === "Match";
  const hasTwoOutcomes = (offer: KambiMainBetOffer) => (offer.outcomes?.length ?? 0) === 2;
  const labelsAreOneTwo = (offer: KambiMainBetOffer) => {
    const labels = (offer.outcomes ?? []).map((o) => o.label).sort();
    return labels.length === 2 && labels[0] === "1" && labels[1] === "2";
  };
  return (
    betOffers.find((o) => isMatch(o) && hasTwoOutcomes(o) && labelsAreOneTwo(o) && o.tags?.includes("MAIN")) ??
    betOffers.find((o) => isMatch(o) && hasTwoOutcomes(o) && labelsAreOneTwo(o)) ??
    betOffers.find((o) => isMatch(o) && hasTwoOutcomes(o) && o.tags?.includes("MAIN")) ??
    null
  );
}

/**
 * Parsea 2-vägs main-marknad ur Kambi /betoffer/event/{id}-svar.
 * Returnerar { home, away } eller null.
 */
function parseKambiTwoWayMainOffer(data: unknown): { home: number; away: number } | null {
  const root = data as { betOffers?: KambiMainBetOffer[] };
  const mainOffer = findKambiTwoWayMainOffer(root.betOffers);
  if (!mainOffer) return null;
  return kambiMainOfferPair(mainOffer, false) ?? kambiMainOfferPair(mainOffer, true);
}

function parseOneXTwoRowsFromKambiEvent(data: unknown) {
  const root = data as { betOffers?: KambiMainBetOffer[] };
  const mainOffer = findKambiMatchMainOffer(root.betOffers);
  if (!mainOffer?.outcomes || mainOffer.outcomes.length !== 3) return [];

  const triple = kambiMainOfferTriple(mainOffer, false) ?? kambiMainOfferTriple(mainOffer, true);
  if (!triple) return [];
  const { home, draw, away } = triple;

  return [
    { bookmaker: "1x2", home, draw, away },
    { bookmaker: "Speedybet", home, draw, away },
    { bookmaker: "Golden Bull", home, draw, away },
    { bookmaker: "X3000", home, draw, away },
  ];
}

async function parseOddsRowsFromOneXTwoKambi(url: string) {
  const eventId = extractKambiEventId(url);
  if (!eventId) return { rows: [], title: "" };

  const hostname = new URL(url).hostname.toLowerCase();
  const pafBrand = PAF_BRAND_BY_HOSTNAME.find((entry) => entry.pattern.test(hostname));
  if (pafBrand) {
    return await parseOddsRowsFromPafBrandEvent(pafBrand.origin, pafBrand.bookmakerName, eventId);
  }
  const config = getKambiOfferingForHostname(hostname) ?? KAMBI_OFFERING_BY_HOSTNAME[0];
  return await parseOddsRowsFromKambiEvent(config.offering, eventId, config.referer);
}

const PAF_BRAND_BY_HOSTNAME: Array<{ pattern: RegExp; origin: string; bookmakerName: string }> = [
  { pattern: /(^|\.)1x2\.se$/i, origin: "https://www.1x2.se", bookmakerName: "1x2" },
  { pattern: /speedybet\.com$/i, origin: "https://www.speedybet.com", bookmakerName: "Speedybet" },
  { pattern: /goldenbull\.se$/i, origin: "https://www.goldenbull.se", bookmakerName: "Golden Bull" },
  { pattern: /x3000\.com$/i, origin: "https://www.x3000.com", bookmakerName: "X3000" },
];

async function parseOddsRowsFromPafBrandEvent(origin: string, bookmakerName: string, eventId: string) {
  const json = await fetchHtml(
    `${origin}/api/betting/event/${encodeURIComponent(eventId)}`,
    `${origin}/betting#event/${eventId}`,
  );
  const data = JSON.parse(json) as {
    name?: string;
    participants?: { home?: { name?: string }; away?: { name?: string } };
    betOffers?: { match?: { one?: { odds?: string }; cross?: { odds?: string }; two?: { odds?: string } } };
  };
  const title =
    data.name ?? [data.participants?.home?.name, data.participants?.away?.name].filter(Boolean).join(" - ");
  const home = normalizeOdd(data.betOffers?.match?.one?.odds ?? "");
  const draw = normalizeOdd(data.betOffers?.match?.cross?.odds ?? "");
  const away = normalizeOdd(data.betOffers?.match?.two?.odds ?? "");
  if (home && draw && away) return { title, rows: [{ bookmaker: bookmakerName, home, draw, away }] };
  return { title, rows: [] };
}

async function parseOddsRowsFromKambiEvent(offering: string, eventId: string, referer: string) {
  const apiUrl = `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`;
  const json = await fetchHtml(apiUrl, referer);
  const data = JSON.parse(json) as { events?: Array<{ name?: string; englishName?: string }> };
  const event = data.events?.[0];
  const odds = parseKambiMainOffer(data);
  const title = event?.name ?? event?.englishName ?? "";
  if (!odds) return { rows: [], title };
  const offeringToBookmaker: Record<string, string> = { ubse: "Unibet" };
  return { title, rows: [{ bookmaker: offeringToBookmaker[offering] ?? offering, ...odds }] };
}

function getComeOnBrand(url: string) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname.includes("hajper.com")) return { name: "Hajper", franchiseCode: "SWEDEN_HAJPER" };
  if (hostname.includes("snabbare.com")) return { name: "Snabbare", franchiseCode: "SWEDEN_SNABBARE" };
  if (hostname.includes("casinostugan.com")) return { name: "Casinostugan", franchiseCode: "SWEDEN_CASINOSTUGAN" };
  if (hostname.includes("lyllocasino.com")) return { name: "Lyllo", franchiseCode: "SWEDEN_LYLLO" };
  return { name: "ComeOn", franchiseCode: "SWEDEN_COMEON" };
}

function extractComeOnEventId(url: string): string | null {
  return /\/events\/([^/?#-]+)/i.exec(url)?.[1] ?? null;
}

function normalizeComeOnEventId(eventId: string) {
  return /^\d+$/.test(eventId) ? Number(eventId) : eventId;
}

function createRSocketJsonRequest(streamId: number, route: string, payload: unknown) {
  const routeMetadata = Buffer.concat([Buffer.from([route.length]), Buffer.from(route)]);
  const data = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + 2 + 4 + 3 + routeMetadata.length + data.length);
  let offset = 0;
  frame.writeUInt32BE(streamId, offset);
  offset += 4;
  frame[offset] = 0x19;
  frame[offset + 1] = 0x00;
  offset += 2;
  frame.writeUInt32BE(100000, offset);
  offset += 4;
  frame.writeUIntBE(routeMetadata.length, offset, 3);
  offset += 3;
  routeMetadata.copy(frame, offset);
  offset += routeMetadata.length;
  data.copy(frame, offset);
  return frame;
}

function extractJsonPayloadFromRSocketFrame(data: ArrayBuffer | Buffer) {
  const text = Buffer.from(data).toString("utf-8");
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  return JSON.parse(text.slice(start)) as unknown;
}

function comeOnEventTitle(event?: {
  eventName?: string;
  primaryParticipants?: Record<string, { name?: string; venueRole?: string; order?: number }>;
}) {
  if (!event) return "";
  const participants = Object.values(event.primaryParticipants ?? {});
  const home = participants.find((p) => (p.venueRole ?? "").toLowerCase() === "home")?.name;
  const away = participants.find((p) => (p.venueRole ?? "").toLowerCase() === "away")?.name;
  if (home && away) return `${home} - ${away}`;
  if (participants.length >= 2) {
    const ordered = [...participants].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (ordered[0]?.name && ordered[1]?.name) return `${ordered[0].name} - ${ordered[1].name}`;
  }
  return event.eventName ?? "";
}

function normalizeComeOnOutcomeKey(outcomeType: string | undefined): "Home" | "Tie" | "Away" | null {
  const s = (outcomeType ?? "").trim().toLowerCase();
  if (s === "home" || s === "h" || s === "1") return "Home";
  if (s === "tie" || s === "draw" || s === "x") return "Tie";
  if (s === "away" || s === "a" || s === "2") return "Away";
  if (/\bhome\b|hem|hemma|hemmalag/.test(s)) return "Home";
  if (/\baway\b|bort|bortalag/.test(s)) return "Away";
  if (/\b(draw|tie|oavgjort|lika)\b/.test(s)) return "Tie";
  return null;
}

/** Match odds-priset kan ligga i flera fält beroende på API-version. */
function comeOnSelectionDecimalOdds(selection: { trueOdds?: unknown; odds?: unknown; decimalOdds?: unknown }): number | null {
  const raw = selection.trueOdds ?? selection.odds ?? selection.decimalOdds;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/**
 * Request filtrerar redan marketGroupIds [1]; saknad eller sträng-"1" för marketTypeId
 * gav tidigare att alla urval filtrerades bort → ComeOn/Snabbare såg tomma ut.
 */
function isComeOnMainMatchOddsMarket(marketTypeId: unknown): boolean {
  if (marketTypeId === undefined || marketTypeId === null) return true;
  if (typeof marketTypeId === "string" && marketTypeId.trim() === "") return true;
  const n = Number(marketTypeId);
  return Number.isFinite(n) && n === 1;
}

function parseComeOnRowsFromEventPayload(data: unknown, bookmaker: string) {
  const root = data as Array<{
    payload?: {
      events?: Array<{
        eventName?: string;
        primaryParticipants?: Record<string, { name?: string; venueRole?: string; order?: number }>;
      }>;
      selections?: Array<{
        marketTypeId?: number | string;
        outcomeType?: string;
        trueOdds?: number;
        odds?: number;
        decimalOdds?: number;
        status?: string;
      }>;
    };
  }>;
  const payload = root[0]?.payload;
  const title = comeOnEventTitle(payload?.events?.[0]);
  const selections = payload?.selections ?? [];
  const oddsByOutcome: Partial<Record<"Home" | "Tie" | "Away", number>> = {};
  for (const selection of selections) {
    if (!isComeOnMainMatchOddsMarket(selection.marketTypeId)) continue;
    const price = comeOnSelectionDecimalOdds(selection);
    if (price == null) continue;
    const st = String(selection.status ?? "").trim().toLowerCase();
    if (st && /^(closed|settled|suspended|void|inactive|cancel|cancelled|disabled)$/i.test(st)) continue;
    const key = normalizeComeOnOutcomeKey(selection.outcomeType);
    if (!key) continue;
    oddsByOutcome[key] = price;
  }
  const home = oddsByOutcome.Home;
  const draw = oddsByOutcome.Tie;
  const away = oddsByOutcome.Away;
  if (!(home && draw && away && home > 1 && draw > 1 && away > 1)) return { rows: [], title };

  return {
    rows: [{ bookmaker, home, draw, away }],
    title,
  };
}

async function openComeOnBinaryWebSocket(websocketUrl: string) {
  const GlobalWS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof GlobalWS === "function") {
    const socket = new GlobalWS(websocketUrl);
    socket.binaryType = "arraybuffer";
    return {
      close: () => socket.close(),
      sendFrames: (setup: Buffer, request: Buffer) => {
        socket.send(new Uint8Array(setup));
        socket.send(new Uint8Array(request));
      },
      onOpen: (cb: () => void) => {
        socket.addEventListener("open", cb);
      },
      onMessage: (cb: (buf: Buffer) => void) => {
        socket.addEventListener("message", (ev: MessageEvent) => {
          const d = ev.data as ArrayBuffer | ArrayBufferView | Blob;
          if (d instanceof ArrayBuffer) cb(Buffer.from(d));
          else if (typeof Blob !== "undefined" && d instanceof Blob)
            void d.arrayBuffer().then((ab) => cb(Buffer.from(ab)));
          else if (d instanceof ArrayBufferView) cb(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
        });
      },
      onError: (cb: () => void) => {
        socket.addEventListener("error", () => cb());
      },
    };
  }
  const { default: WSNode } = await import("ws");
  const socket = new WSNode(websocketUrl);
  return {
    close: () => socket.close(),
    sendFrames: (setup: Buffer, request: Buffer) => {
      socket.send(setup);
      socket.send(request);
    },
    onOpen: (cb: () => void) => {
      socket.on("open", cb);
    },
    onMessage: (cb: (buf: Buffer) => void) => {
      socket.on("message", (data: Buffer | ArrayBuffer) => {
        cb(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      });
    },
    onError: (cb: () => void) => {
      socket.on("error", () => cb());
    },
  };
}

async function requestComeOnEventsPayload(
  origin: string,
  franchiseCode: string,
  payload: unknown,
  timeoutMs = 14_000,
) {
  const setupFrame = Buffer.from(
    "000000000400000100000000ea600001d4c01c6d6573736167652f782e72736f636b65742e726f7574696e672e7630106170706c69636174696f6e2f6a736f6e",
    "hex",
  );
  const requestFrame = createRSocketJsonRequest(1, "/v4/events", payload);

  const websocketUrl = `wss://${new URL(origin).hostname}/sportsbook-api/websocket?franchiseCode=${franchiseCode}&locale=sv`;
  const socket = await openComeOnBinaryWebSocket(websocketUrl);
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("ComeOn websocket timed out"));
    }, timeoutMs);
    socket.onOpen(() => {
      socket.sendFrames(setupFrame, requestFrame);
    });
    socket.onError(() => {
      clearTimeout(timeout);
      reject(new Error("ComeOn websocket failed"));
    });
    socket.onMessage((buf) => {
      try {
        const data = extractJsonPayloadFromRSocketFrame(buf);
        if (!data) return;
        clearTimeout(timeout);
        socket.close();
        resolve(data);
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error);
      }
    });
  });
}

async function parseOddsRowsFromComeOnSportsbook(url: string) {
  const brand = getComeOnBrand(url);
  const eventId = extractComeOnEventId(url);
  if (!eventId) return { rows: [], title: "" };

  const data = await requestComeOnEventsPayload(new URL(url).origin, brand.franchiseCode, {
    filters: {
      eventIds: [normalizeComeOnEventId(eventId)],
      marketGroupIds: [1],
      includeEntities: ["MARKET", "SELECTION"],
    },
    orders: [null],
  });
  return parseComeOnRowsFromEventPayload(data, brand.name);
}

function extractJsonObjectAfterAssignment(html: string, assignment: string): string | null {
  const start = html.indexOf(assignment);
  if (start < 0) return null;
  const objectStart = html.indexOf("{", start + assignment.length);
  if (objectStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < html.length; i += 1) {
    const char = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return html.slice(objectStart, i + 1);
  }
  return null;
}

type BetssonSportsbookContext = {
  baseUrl: string;
  iframeUrl: string;
  headers: Record<string, string>;
};

function extractBetssonIframeUrl(pageHtml: string): string | null {
  const iframeSrc = /<iframe[^>]+src=["']([^"']*playground\.net[^"']+)["']/i.exec(pageHtml)?.[1];
  if (!iframeSrc) return null;
  return iframeSrc.replace(/&amp;/g, "&");
}

function extractBetssonEventId(url: string): string | null {
  try {
    return new URL(url).searchParams.get("eventId");
  } catch {
    return null;
  }
}

function parseBetssonRowsFromAccordion(data: unknown) {
  const odds = parseBetssonOddsFromAccordion(data);
  if (!odds) return [];
  return [
    { bookmaker: "Spelklubben", ...odds },
    { bookmaker: "Bethard", ...odds },
  ];
}

function parseBetssonOddsFromAccordion(data: unknown): { home: number; draw: number; away: number } | null {
  const root = data as {
    data?: {
      accordions?: Record<
        string,
        {
          selections?: Array<{
            odds?: number;
            status?: string;
            selectionTemplateId?: string;
          }>;
        }
      >;
    };
  };
  const accordions = root.data?.accordions ?? {};
  const accordionKeys = [...new Set(["MW3W", ...Object.keys(accordions)])];

  const tryParseSelections = (selections: Array<{ odds?: number; status?: string; selectionTemplateId?: string }>, allowSuspended: boolean) => {
    const oddsByTemplate = Object.fromEntries(
      selections
        .filter((selection) => {
          const st = String(selection.status ?? "").trim();
          if (!selection.selectionTemplateId || selection.odds == null) return false;
          if (/^open$/i.test(st)) return true;
          return allowSuspended && /^suspended$/i.test(st);
        })
        .map((selection) => [String(selection.selectionTemplateId).toUpperCase(), Number(selection.odds)]),
    );
    const home = oddsByTemplate.HOME;
    const draw = oddsByTemplate.DRAW;
    const away = oddsByTemplate.AWAY;
    if (!(home > 1 && draw > 1 && away > 1)) return null;
    return { home, draw, away };
  };

  for (const key of accordionKeys) {
    const selections = accordions[key]?.selections ?? [];
    if (selections.length === 0) continue;
    const odds = tryParseSelections(selections, false) ?? tryParseSelections(selections, true);
    if (odds) return odds;
  }
  return null;
}

function parseBetssonTitleFromEvent(data: unknown) {
  const root = data as {
    data?: {
      event?: {
        label?: string;
        participants?: Array<{ label?: string; sortOrder?: number }>;
      };
    };
  };
  const participants = root.data?.event?.participants
    ?.slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((participant) => participant.label?.trim())
    .filter(Boolean);
  if (participants && participants.length >= 2) return participants.join(" - ");
  return root.data?.event?.label ?? "";
}

function betssonContextCacheFile(hostname: string) {
  return path.join(BONUS_CACHE_DIR, `betsson-context-${hostname.replace(/[^a-z0-9.-]/gi, "_")}.json`);
}

function readBetssonSportsbookContextFromDisk(url: string): BetssonSportsbookContext | null {
  try {
    const hostname = new URL(url).hostname;
    const file = betssonContextCacheFile(hostname);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      cachedAt?: number;
      context?: BetssonSportsbookContext;
    };
    if (!parsed.cachedAt || !parsed.context) return null;
    if (Date.now() - parsed.cachedAt > LAST_GOOD_BOOKMAKER_ODDS_TTL_MS) return null;
    return parsed.context;
  } catch {
    return null;
  }
}

function writeBetssonSportsbookContextToDisk(url: string, context: BetssonSportsbookContext) {
  try {
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    const hostname = new URL(url).hostname;
    fs.writeFileSync(
      betssonContextCacheFile(hostname),
      JSON.stringify({ cachedAt: Date.now(), context }),
      "utf-8",
    );
  } catch (error) {
    console.warn("[betsson-context] disk write failed", error);
  }
}

async function getBetssonSportsbookContext(url: string) {
  let pageHtml = "";
  try {
    pageHtml = await fetchHtml(url);
  } catch (error) {
    const cachedContext = readBetssonSportsbookContextFromDisk(url);
    if (cachedContext) return cachedContext;
    throw error;
  }
  const iframeUrl = extractBetssonIframeUrl(pageHtml);
  if (!iframeUrl) return readBetssonSportsbookContextFromDisk(url);

  let iframeHtml = "";
  try {
    iframeHtml = await fetchHtml(iframeUrl, url);
  } catch (error) {
    const cachedContext = readBetssonSportsbookContextFromDisk(url);
    if (cachedContext) return cachedContext;
    throw error;
  }
  const configJson = extractJsonObjectAfterAssignment(iframeHtml, "window.obgClientEnvironmentConfig =");
  if (!configJson) return readBetssonSportsbookContextFromDisk(url);

  const startupContext = (JSON.parse(configJson) as {
    startupContext?: {
      appContext?: { version?: string };
      brandId?: string;
      contextId?: { staticContextId?: string; userContextId?: string; sessionToken?: string };
      market?: { slug?: string };
      userContext?: {
        contextInformation?: {
          channel?: string;
          countryCode?: string;
          currencyCode?: string;
          deviceType?: string;
          frameAncestors?: string;
          interfaceSettings?: Record<string, string>;
          jurisdiction?: string;
          languageCode?: string;
          segmentId?: string;
        };
      };
    };
  }).startupContext;
  if (!startupContext) return null;

  const context = startupContext.userContext?.contextInformation ?? {};
  const headers: Record<string, string> = {
    brandid: startupContext.brandId ?? "",
    correlationid: crypto.randomUUID(),
    marketcode: startupContext.market?.slug ?? "sv",
    origin: new URL(iframeUrl).origin,
    "x-obg-channel": context.channel ?? "Web",
    "x-obg-device": context.deviceType ?? "Desktop",
    "x-sb-app-version": startupContext.appContext?.version ?? "",
    "x-sb-channel": context.channel ?? "Web",
    "x-sb-content-id": context.interfaceSettings?.["content-ID"] ?? startupContext.brandId ?? "",
    "x-sb-country-code": context.countryCode ?? "SE",
    "x-sb-currency-code": context.currencyCode ?? "SEK",
    "x-sb-device-type": context.deviceType ?? "Desktop",
    "x-sb-frame-ancestors": context.frameAncestors ?? new URL(url).origin,
    "x-sb-jurisdiction": context.jurisdiction ?? "",
    "x-sb-language-code": context.languageCode ?? "sv",
    "x-sb-segment-id": context.segmentId ?? "",
    "x-sb-static-context-id": startupContext.contextId?.staticContextId ?? "",
    "x-sb-type": "b2b",
    "x-sb-user-context-id": startupContext.contextId?.userContextId ?? "",
    ...(startupContext.contextId?.sessionToken ? { sessiontoken: startupContext.contextId.sessionToken } : {}),
  };

  const sportsbookContext = {
    baseUrl: new URL(iframeUrl).origin,
    iframeUrl,
    headers,
  };
  writeBetssonSportsbookContextToDisk(url, sportsbookContext);
  return sportsbookContext;
}

function buildBestByOutcome(rows: Array<{ bookmaker: string; home: number; draw: number; away: number }>) {
  return {
    "1": rows.reduce<{ bookmaker: string; odds: number } | null>((best, row) => {
      if (!best || row.home > best.odds) return { bookmaker: row.bookmaker, odds: row.home };
      return best;
    }, null),
    X: rows.reduce<{ bookmaker: string; odds: number } | null>((best, row) => {
      if (!best || row.draw > best.odds) return { bookmaker: row.bookmaker, odds: row.draw };
      return best;
    }, null),
    "2": rows.reduce<{ bookmaker: string; odds: number } | null>((best, row) => {
      if (!best || row.away > best.odds) return { bookmaker: row.bookmaker, odds: row.away };
      return best;
    }, null),
  };
}

function mergeOddsRows(rows: Array<{ bookmaker: string; home: number; draw: number; away: number }>) {
  const byBookmaker = new Map<string, { bookmaker: string; home: number; draw: number; away: number }>();
  for (const row of rows) {
    const key = row.bookmaker.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!byBookmaker.has(key)) byBookmaker.set(key, row);
  }
  return [...byBookmaker.values()];
}

function getSearchTokens(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(vs?|odds|predictions|h2h|speltips|tips|betting|online|fc|afc|cf|sc|fk|sk|bk|if|ff|ac|cd|rc|sv|as|us|ssc|vfb)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
}

function scoreTitleMatch(candidate: string, target: string) {
  const candidateTokens = new Set(getSearchTokens(candidate));
  const targetTokens = [...new Set(getSearchTokens(target))];
  if (targetTokens.length === 0) return 0;
  const candidateHasPsg =
    candidateTokens.has("psg") ||
    (candidateTokens.has("paris") && candidateTokens.has("saint") && candidateTokens.has("germain"));
  let base = targetTokens.reduce((score, token) => {
    if (candidateTokens.has(token)) return score + 1;
    if (token === "psg" && candidateHasPsg) return score + 1;
    return score;
  }, 0);

  const candNorm = candidate
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const tgtNorm = target
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (tgtNorm.length >= 6 && candNorm.includes(tgtNorm)) base += 2;
  const targetParts = tgtNorm.split(/\s+(?:vs?\.?|mot|-)\s+/);
  for (const part of targetParts) {
    const p = part.trim();
    if (p.length >= 4 && candNorm.includes(p)) base += 1;
  }

  return base;
}

function minSearchScore(query: string) {
  return getSearchTokens(query).length >= 2 ? 2 : 1;
}

function buildEventSearchQueries(title: string, fallbackQuery?: string) {
  const sideQueries = getMatchSideTokens(title).map((tokens) => tokens.join(" ")).filter(Boolean);
  const tokenQueries = getSearchTokens(title);
  const aliasQueries: string[] = [];
  if (tokenQueries.includes("psg")) {
    aliasQueries.push(
      title.replace(/\bpsg\b/gi, "Paris Saint-Germain"),
      fallbackQuery?.replace(/\bpsg\b/gi, "Paris Saint-Germain") ?? "",
      "Paris Saint-Germain",
    );
  }
  return [
    ...new Set(
      [
        title,
        fallbackQuery,
        ...sideQueries,
        ...aliasQueries,
        ...tokenQueries,
        tokenQueries.slice(0, 2).join(" "),
        tokenQueries.slice(-2).join(" "),
      ]
        .map((query) => query?.trim())
        .filter(Boolean),
    ),
  ];
}

function buildSmartSearchQueryGroups(title: string, fallbackQuery?: string) {
  const sideQueries = getMatchSideTokens(title).map((tokens) => tokens.join(" ")).filter(Boolean);
  const tokenQueries = getSearchTokens(title);
  const exactQueries = buildEventSearchQueries(title, fallbackQuery);
  const groups = [
    exactQueries,
    sideQueries.slice(0, 1),
    sideQueries.slice(1, 2),
    tokenQueries,
  ];
  return groups
    .map((group) => [...new Set(group.map((query) => query?.trim()).filter(Boolean))])
    .filter((group) => group.length > 0);
}

function scoreAgainstAnyQuery(candidate: string, queries: string[]) {
  return Math.max(0, ...queries.map((query) => scoreTitleMatch(candidate, query)));
}

function getMatchSideTokens(title: string) {
  const cleaned = title
    .replace(/\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}\s*$/, "")
    .replace(/\s+\|\s+.*$/i, "")
    .replace(/\s+betting odds.*$/i, "")
    .replace(/\b(Odds|Predictions|H2H).*$/i, "")
    .replace(/\b(fc|afc|cf|sc|fk|sk|bk|if|ff|ac|cd|rc|sv|as|us|ssc|vfb)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sides = cleaned.split(/\s+(?:vs?\.?|mot)\s+|\s+-\s+/i).slice(0, 2);
  return sides.map(getSearchTokens).filter((tokens) => tokens.length > 0);
}

function sideMatches(candidateTokens: string[], targetTokens: string[]) {
  if (targetTokens.length === 0) return false;
  const candidateSet = new Set(candidateTokens);
  const targetSet = new Set(targetTokens);
  const hasPsg = (tokens: Set<string>) =>
    tokens.has("psg") || (tokens.has("paris") && tokens.has("saint") && tokens.has("germain"));
  if (hasPsg(candidateSet) && hasPsg(targetSet)) return true;
  return targetTokens.some((targetToken) =>
    candidateTokens.some(
      (candidateToken) =>
        candidateToken === targetToken ||
        (Math.min(candidateToken.length, targetToken.length) >= 5 &&
          (candidateToken.startsWith(targetToken) || targetToken.startsWith(candidateToken))),
    ),
  );
}

/**
 * Bygg ett lag-token-index för snabb kandidatsökning vid titel-matchning.
 * Returnerar en lookup(title) som ger en DELMÄNGD av rows i ursprunglig ordning
 * — en superset av allt som kan matcha isLikelySameMatch (exakt token,
 * 5-tecken-prefix enligt sideMatches-regeln, samt PSG-specialfallet). Kör sedan
 * exakt samma isLikelySameMatch/predikat på resultatet → identiskt utfall, men
 * utan att skanna alla rader per match (O(M×P) → ~O(M×k)). Rader utan 2 tydliga
 * sidor hamnar i en "ambiguous"-hink och tas alltid med.
 */
function buildTitleTokenIndex<T>(rows: T[], getTitle: (row: T) => string): (title: string) => T[] {
  const PSG = "__psg__";
  const flatTokens = (title: string): string[] => {
    let sides: string[][];
    try {
      sides = getMatchSideTokens(title);
    } catch {
      return [];
    }
    if (sides.length < 2) return [];
    return sides.flat();
  };
  const isPsg = (toks: string[]): boolean => {
    const s = new Set(toks);
    return s.has("psg") || (s.has("paris") && s.has("saint") && s.has("germain"));
  };
  const index = new Map<string, number[]>();
  const ambiguous: number[] = [];
  const add = (key: string, i: number) => {
    let a = index.get(key);
    if (!a) {
      a = [];
      index.set(key, a);
    }
    a.push(i);
  };
  rows.forEach((row, i) => {
    const flat = flatTokens(getTitle(row));
    if (flat.length === 0) {
      ambiguous.push(i);
      return;
    }
    const seen = new Set<string>();
    for (const tok of flat) {
      const e = "e:" + tok;
      if (!seen.has(e)) {
        seen.add(e);
        add(e, i);
      }
      if (tok.length >= 5) {
        const p = "p:" + tok.slice(0, 5);
        if (!seen.has(p)) {
          seen.add(p);
          add(p, i);
        }
      }
    }
    if (isPsg(flat) && !seen.has(PSG)) {
      seen.add(PSG);
      add(PSG, i);
    }
  });
  return (title: string): T[] => {
    const flat = flatTokens(title);
    if (flat.length === 0) return rows; // sällsynt: titel utan 2 sidor → exakt fallback
    const hit = new Set<number>(ambiguous);
    for (const t of flat) {
      const ex = index.get("e:" + t);
      if (ex) for (const i of ex) hit.add(i);
      if (t.length >= 5) {
        const pr = index.get("p:" + t.slice(0, 5));
        if (pr) for (const i of pr) hit.add(i);
      }
    }
    if (isPsg(flat)) {
      const pg = index.get(PSG);
      if (pg) for (const i of pg) hit.add(i);
    }
    return [...hit].sort((a, b) => a - b).map((i) => rows[i]);
  };
}

/** Per-side alignment strength: how well candidate side tokens cover the reference side (for orientation scoring). */
function sideOrientationCoverage(candidateTokens: string[], targetTokens: string[]): number {
  if (targetTokens.length === 0 || candidateTokens.length === 0) return 0;
  let score = 0;
  for (const tt of targetTokens) {
    const matched = candidateTokens.some(
      (ct) =>
        ct === tt ||
        (Math.min(ct.length, tt.length) >= 5 && (ct.startsWith(tt) || tt.startsWith(ct))),
    );
    if (matched) score += 3;
  }
  return score;
}

/**
 * Returns true for titles that are fantasy/esports/cyber-live where each side has player tags
 * inside parentheses, like "Chelsea (Cofi111) - Liverpool (hit)". These show up in Kambi feeds and
 * must not be matched against real-league fixtures.
 */
function looksLikeFantasyOrEsportsTitle(title: string): boolean {
  const matches = [...title.matchAll(/\(([^)]+)\)/g)];
  for (const m of matches) {
    const inside = m[1].trim();
    if (!inside) continue;
    if (/^(d|w|dam|damer|herr|herrar|m|men|II|III|IV)$/i.test(inside)) continue;
    if (/^U\d{1,2}$/i.test(inside)) continue;
    if (/^[A-Z]{1,4}$/.test(inside)) continue;
    return true;
  }
  if (/\b(esport|cyber\s?live|fifa\s?\d{2}|cs2|csgo|fantasy)\b/i.test(title)) return true;
  return false;
}

function isWomensTitle(title: string): boolean {
  return /\(d\)|\(k\)|\(w\)|\(dam(?:er)?\)|\bdamer\b|\bkvinn(?:or)?\b|\bwomen\b|wfc|\bwsl\b/i.test(title);
}

function isJuniorTitle(title: string): boolean {
  return /\bU\s?-?\s?(?:1[5-9]|2[0-3])\b|\byouth\b|\bjunior\b|\bjuniors\b|\bp1[5-9]\b|\bp2[0-3]\b/i.test(title);
}

/**
 * Returns false when the candidate appears to be from a different audience than the target — e.g.
 * candidate is women's/junior/fantasy but target is the regular senior match. This prevents Kambi
 * from offering "Chelsea (Cofi111) - Liverpool (hit)" when user wants real "Liverpool - Chelsea".
 */
function isAudienceMismatch(candidate: string, target: string): boolean {
  if (looksLikeFantasyOrEsportsTitle(candidate) && !looksLikeFantasyOrEsportsTitle(target)) return true;
  if (isWomensTitle(candidate) && !isWomensTitle(target)) return true;
  if (isJuniorTitle(candidate) && !isJuniorTitle(target)) return true;
  return false;
}

/**
 * Tidsfönster för att klassa två annonserade speltider som "samma match". Generös tolerans
 * eftersom olika bookmakers ibland skiljer sig på enstaka minuter (t.ex. timezone-fel,
 * preliminära tider, "kickoff vs spelstart"). >3h apart = säkert olika matcher.
 */
const SAME_MATCH_TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000;

function normalizeLeagueKey(value: string | undefined | null): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function leagueTokensSet(value: string | undefined | null): Set<string> {
  return new Set(
    normalizeLeagueKey(value)
      .split(/\s+/)
      .filter((tok) => tok.length >= 3),
  );
}

/**
 * Veto-helper: returnera true bara när vi är **säkra** på att ligorna skiljer sig.
 * Saknad eller tom data -> false (ingen blockering, behåll nuvarande sökbredd).
 * Delar bara ett enda gemensamt token -> samma liga.
 */
function leagueLooksDifferent(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b) return false;
  const aT = leagueTokensSet(a);
  const bT = leagueTokensSet(b);
  if (aT.size === 0 || bT.size === 0) return false;
  for (const tok of aT) if (bT.has(tok)) return false;
  return true;
}

/**
 * Veto-helper: två kickoff-tider som skiljer sig med mer än `SAME_MATCH_TIME_TOLERANCE_MS`
 * kan inte vara samma match. Saknade/oparserbara värden = ingen blockering.
 */
function startTsConflict(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  return Math.abs(aMs - bMs) > SAME_MATCH_TIME_TOLERANCE_MS;
}

type SameMatchContext = {
  candidateStartTs?: string | null;
  targetStartTs?: string | null;
  candidateLeague?: string | null;
  targetLeague?: string | null;
};

/**
 * `ctx` är en valfri veto-mekanism: när både kandidat och mål har kickoff/liga och dessa
 * **säger emot varandra** (>3h tidsdiff eller helt skilda liga-tokens), avvisas matchningen
 * även om team-namnen är identiska. Saknad data -> ingen blockering, samma sökbredd som tidigare.
 */
function isLikelySameMatch(candidate: string, target: string, ctx?: SameMatchContext) {
  if (isAudienceMismatch(candidate, target)) return false;

  if (ctx) {
    if (startTsConflict(ctx.candidateStartTs, ctx.targetStartTs)) return false;
    if (leagueLooksDifferent(ctx.candidateLeague, ctx.targetLeague)) return false;
  }

  const targetSides = getMatchSideTokens(target);
  const candidateSides = getMatchSideTokens(candidate);
  if (targetSides.length < 2 || candidateSides.length < 2) {
    return scoreTitleMatch(candidate, target) >= Math.min(2, getSearchTokens(target).length);
  }

  const direct =
    sideMatches(candidateSides[0], targetSides[0]) && sideMatches(candidateSides[1], targetSides[1]);
  const reversed =
    sideMatches(candidateSides[0], targetSides[1]) && sideMatches(candidateSides[1], targetSides[0]);
  return direct || reversed;
}

function alignOddsRowsToTargetTitle(
  rows: Array<{ bookmaker: string; home: number; draw: number; away: number }>,
  sourceTitle: string,
  targetTitle?: string,
) {
  if (!targetTitle || !sourceTitle) return rows;
  const targetSides = getMatchSideTokens(targetTitle);
  const sourceSides = getMatchSideTokens(sourceTitle);
  if (targetSides.length < 2 || sourceSides.length < 2) return rows;

  const directScore =
    sideOrientationCoverage(sourceSides[0], targetSides[0]) + sideOrientationCoverage(sourceSides[1], targetSides[1]);
  const reversedScore =
    sideOrientationCoverage(sourceSides[0], targetSides[1]) + sideOrientationCoverage(sourceSides[1], targetSides[0]);

  if (reversedScore <= directScore) return rows;
  return rows.map((row) => ({ ...row, home: row.away, away: row.home }));
}

function getTargetMatchTitle(query: string, matches: Array<{ title: string; url: string }>, targetTitle?: string) {
  return targetTitle || matches[0]?.title || query;
}

function shouldUseKnownPsgBayernPartnerLinks(query: string, matches: Array<{ title: string; url: string }>, targetTitle?: string) {
  const haystack = `${query} ${targetTitle ?? matches[0]?.title ?? ""}`.toLowerCase();
  return /(psg|paris|bayern|munchen|münchen)/i.test(haystack);
}

const KNOWN_PSG_BAYERN_PARTNER_URLS = [
  "https://www.1x2.se/betting#event/1027334694",
  "https://www.speedybet.com/betting#event/1027334694",
  "https://www.goldenbull.se/betting#event/1027334694",
  "https://www.x3000.com/betting#event/1027334694",
  "https://www.spelklubben.se/sv/betting/sok?eventId=f-lGGIMROeykmUeY-bc5dXoA&fs=true&eti=0",
  "https://www.bethard.com/sv/sports/sok?eventId=f-lGGIMROeykmUeY-bc5dXoA&fs=true&eti=0",
  "https://www.comeon.com/sv/sportsbook/sport/1-fotboll/leagues/501-int-klubb-champions-league/events/3202550-paris-saint-germain-bayern-munchen",
  "https://www.hajper.com/sv/sportsbook/sport/1-fotboll/leagues/501-int-klubb-champions-league/events/3202550-paris-saint-germain-bayern-munchen",
  "https://www.snabbare.com/sv/sportsbook/sport/1-fotboll/leagues/501-int-klubb-champions-league/events/3202550-paris-saint-germain-bayern-munchen",
];

const KAMBI_FOOTBALL_REGION_TERMS = [
  "all/all",
  "england/all",
  "europe/all",
  "international/all",
  "international-clubs/all",
  "club-international/all",
  "world/all",
  "spain/all",
  "germany/all",
  "italy/all",
  "france/all",
  "uefa/all",
  "uefa-europa-league/all",
  "uefa-europa-conference-league/all",
  "europe/uefa-europa-league",
  "europe/uefa-europa-conference-league",
  "europe/champions-league",
  "europe/champions_league",
  "international-clubs/uefa-europa-league",
  "international-clubs/uefa-europa-conference-league",
  "europa-league/all",
  "europa_league/all",
  "europa-conference-league/all",
  "europa_conference_league/all",
  "champions-league/all",
  "champions_league/all",
  "sweden/all",
  "netherlands/all",
  "portugal/all",
  "scotland/all",
  "turkey/all",
  "denmark/all",
  "norway/all",
  "uefa_europa_league/all",
  "uefa_champions_league/all",
];

const KAMBI_CACHE_TTL_MS = 60_000;
type KambiEventEntry = {
  event?: {
    id?: number;
    name?: string;
    englishName?: string;
    homeName?: string;
    awayName?: string;
    start?: string;
    group?: string;
  };
};
const kambiFootballEventsCache = new Map<string, { expiresAt: number; events: KambiEventEntry[] }>();
const kambiFootballEventsInflight = new Map<string, Promise<KambiEventEntry[]>>();
const kambiSearchEventsCache = new Map<string, { expiresAt: number; events: KambiEventEntry[] }>();
type OneXTwoSearchEvent = {
  eventId?: string;
  name?: string;
  link?: string;
  participants?: {
    home?: { name?: string };
    away?: { name?: string };
  };
  betOffers?: {
    match?: {
      one?: { odds?: string };
      cross?: { odds?: string };
      two?: { odds?: string };
    };
  };
};
const oneXTwoBettingSearchCache = new Map<string, { expiresAt: number; events: OneXTwoSearchEvent[] }>();

function getKambiOfferingReferer(offering: string) {
  const config = KAMBI_OFFERING_BY_HOSTNAME.find((entry) => entry.offering === offering);
  return config?.referer ?? "https://www.1x2.se/betting";
}

async function fetchKambiFootballEvents(offering = "pafpre1x2se") {
  const now = Date.now();
  const cached = kambiFootballEventsCache.get(offering);
  if (cached && cached.expiresAt > now) return cached.events;
  const inflight = kambiFootballEventsInflight.get(offering);
  if (inflight) return inflight;

  const referer = getKambiOfferingReferer(offering);
  const promise = (async () => {
    const settled = await Promise.allSettled(
      KAMBI_FOOTBALL_REGION_TERMS.map(async (regionTerm) => {
        const apiUrl = `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/listView/football/${regionTerm}.json?lang=sv_SE&market=SE`;
        const json = await fetchHtml(apiUrl, referer);
        return (JSON.parse(json) as { events?: KambiEventEntry[] }).events ?? [];
      }),
    );
    const events = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    kambiFootballEventsCache.set(offering, { expiresAt: now + KAMBI_CACHE_TTL_MS, events });
    kambiFootballEventsInflight.delete(offering);
    return events;
  })();
  kambiFootballEventsInflight.set(offering, promise);
  return promise;
}

/**
 * Multi-sport variant. Hämtar events från Kambis listView för en specifik
 * sport (tennis, ice_hockey, basketball, baseball, ufc_mma, boxing).
 * Cache per (offering, sport).
 */
const kambiSportEventsCache = new Map<string, { expiresAt: number; events: KambiEventEntry[] }>();
const kambiSportEventsInflight = new Map<string, Promise<KambiEventEntry[]>>();

async function fetchKambiEventsForSport(offering: string, sport: SportKey): Promise<KambiEventEntry[]> {
  const cfg = MULTI_SPORT_CATALOG[sport];
  if (!cfg) return [];
  const cacheKey = `${offering}::${sport}`;
  const now = Date.now();
  const cached = kambiSportEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.events;
  const inflight = kambiSportEventsInflight.get(cacheKey);
  if (inflight) return inflight;

  const referer = getKambiOfferingReferer(offering);
  const promise = (async () => {
    try {
      // För icke-fotboll räcker en region-fetch (`all`) — tennis/basket
      // är inte regionalt indelade på samma vis som fotbollen.
      const apiUrl = `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/listView/${cfg.kambiPath}/all.json?lang=sv_SE&market=SE`;
      const json = await fetchHtml(apiUrl, referer);
      const events = (JSON.parse(json) as { events?: KambiEventEntry[] }).events ?? [];
      kambiSportEventsCache.set(cacheKey, { expiresAt: now + KAMBI_CACHE_TTL_MS, events });
      kambiSportEventsInflight.delete(cacheKey);
      return events;
    } catch (error) {
      console.warn(`[kambi-multi-sport] ${offering}/${sport} fetch failed`, error);
      kambiSportEventsCache.set(cacheKey, { expiresAt: now + KAMBI_CACHE_TTL_MS, events: [] });
      kambiSportEventsInflight.delete(cacheKey);
      return [];
    }
  })();
  kambiSportEventsInflight.set(cacheKey, promise);
  return promise;
}

/**
 * Hämtar 2-vägs-odds för ett specifikt Kambi-event. Används av multi-sport
 * pipelinen — försöker först 2-vägs huvudmarknad (ML2), fallback till 3-vägs.
 */
async function parseOddsRowsFromKambiEventForSport(
  offering: string,
  eventId: string,
  referer: string,
): Promise<{ title: string; home?: number; draw?: number; away: number } | null> {
  const apiUrl = `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`;
  try {
    const json = await fetchHtml(apiUrl, referer);
    const data = JSON.parse(json) as { events?: Array<{ name?: string; englishName?: string }> };
    const event = data.events?.[0];
    const title = event?.name ?? event?.englishName ?? "";
    if (!title) return null;
    // 2-vägs först (tennis/basket/etc), fallback 3-vägs (ice-hockey reg time)
    const twoWay = parseKambiTwoWayMainOffer(data);
    if (twoWay) return { title, home: twoWay.home, away: twoWay.away };
    const threeWay = parseKambiMainOffer(data);
    if (threeWay) return { title, home: threeWay.home, draw: threeWay.draw, away: threeWay.away };
    return null;
  } catch (error) {
    console.warn(`[kambi-multi-sport] event ${eventId} parse failed`, error);
    return null;
  }
}

async function fetchKambiSearchEvents(query: string, offering = "pafpre1x2se") {
  const cacheKey = `${offering}::${query.toLowerCase().trim()}`;
  const cached = kambiSearchEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.events;

  const endpoints = [
    `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/search.json?lang=sv_SE&market=SE&query=${encodeURIComponent(query)}`,
    `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/search/${encodeURIComponent(query)}.json?lang=sv_SE&market=SE`,
    `https://eu-offering-api.kambicdn.com/offering/v2018/${offering}/event/search.json?lang=sv_SE&market=SE&query=${encodeURIComponent(query)}`,
  ];
  const referer = getKambiOfferingReferer(offering);
  const settled = await Promise.allSettled(
    endpoints.map(async (apiUrl) => {
      const json = await fetchHtml(apiUrl, referer);
      const data = JSON.parse(json) as { events?: KambiEventEntry[] };
      return data.events ?? [];
    }),
  );
  const events = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  kambiSearchEventsCache.set(cacheKey, { expiresAt: Date.now() + KAMBI_CACHE_TTL_MS, events });
  return events;
}

async function fetchOneXTwoBettingSearchEvents(query: string) {
  return fetchPafBrandSearchEvents("https://www.1x2.se", query);
}

const pafBrandSearchCache = new Map<string, { expiresAt: number; events: OneXTwoSearchEvent[] }>();

/**
 * Each PAF Sweden brand (1x2.se, x3000.com, goldenbull.se, speedybet.com) exposes a brand-specific
 * Kambi-mirror at /api/betting/search?q= that returns the same JSON shape but with each brand's
 * actual margin applied. We must call each brand individually — copying odds from one to the others
 * gives slightly wrong numbers (often 0.01-0.10 off).
 */
async function fetchPafBrandSearchEvents(origin: string, query: string) {
  const cacheKey = `${origin}::${query.toLowerCase().trim()}`;
  const cached = pafBrandSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.events;

  const json = await fetchHtml(
    `${origin}/api/betting/search?q=${encodeURIComponent(query)}`,
    `${origin}/betting`,
  );
  const data = JSON.parse(json) as Array<{
    sport?: string;
    competitions?: Array<{ title?: string; sportId?: string; events?: OneXTwoSearchEvent[] }>;
  }>;
  const events = data
    .flatMap((sport) => sport.competitions ?? [])
    .filter((competition) => competition.sportId === "FOOTBALL")
    .filter((competition) => !/cyber\s?live|esport|fantasy|simulated/i.test(competition.title ?? ""))
    .flatMap((competition) => competition.events ?? []);
  pafBrandSearchCache.set(cacheKey, { expiresAt: Date.now() + KAMBI_CACHE_TTL_MS, events });
  return events;
}

function oneXTwoSearchEventTitle(event: OneXTwoSearchEvent) {
  /** Alltid hem–borta i samma ordning som API:t mappar one/cross/two så att alignment inte speglar fel odds. */
  const home = event.participants?.home?.name?.trim();
  const away = event.participants?.away?.name?.trim();
  if (home && away) return `${home} - ${away}`;
  return (
    event.name ||
    [event.participants?.home?.name, event.participants?.away?.name].filter(Boolean).join(" - ")
  );
}

function oneXTwoSearchEventOdds(event: OneXTwoSearchEvent) {
  const home = normalizeOdd(event.betOffers?.match?.one?.odds ?? "");
  const draw = normalizeOdd(event.betOffers?.match?.cross?.odds ?? "");
  const away = normalizeOdd(event.betOffers?.match?.two?.odds ?? "");
  return home && draw && away ? { home, draw, away } : null;
}

function scoreKambiEvent(item: {
  event?: { id?: number; name?: string; englishName?: string; homeName?: string; awayName?: string; group?: string };
}, targetTitle: string) {
  const event = item.event;
  const title = [event?.name, event?.englishName, event?.homeName, event?.awayName].filter(Boolean).join(" ");
  return { id: event?.id, title, score: scoreTitleMatch(title, targetTitle) };
}

async function discoverKambiPartnerUrls(query: string, matches: Array<{ title: string; url: string }>, targetTitleOverride?: string) {
  const targetTitle = getTargetMatchTitle(query, matches, targetTitleOverride);
  const best = await discoverKambiEventForTitle(targetTitle);
  return best?.id ? [`https://www.1x2.se/betting#event/${best.id}`] : [];
}

async function discoverKambiEventForTitle(targetTitle: string, offering = "pafpre1x2se") {
  for (const searchQueries of buildSmartSearchQueryGroups(targetTitle).map((group) => group.slice(0, 10))) {
    if (offering === "pafpre1x2se") {
      const oneXTwoEvents = (
        await Promise.allSettled(searchQueries.map((query) => fetchOneXTwoBettingSearchEvents(query)))
      ).flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      const bestOneXTwo = oneXTwoEvents
        .map((event) => {
          const title = oneXTwoSearchEventTitle(event);
          return {
            id: event.eventId,
            title,
            score: scoreTitleMatch(title, targetTitle),
            odds: oneXTwoSearchEventOdds(event),
          };
        })
        .filter((item) => item.id && item.odds && isLikelySameMatch(item.title, targetTitle))
        .sort((a, b) => b.score - a.score)[0];
      if (bestOneXTwo) return bestOneXTwo;
    }

    const searchedEvents = (
      await Promise.allSettled(searchQueries.map((query) => fetchKambiSearchEvents(query, offering)))
    ).flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const bestSearch = searchedEvents
      .map((item) => scoreKambiEvent(item, targetTitle))
      .filter((item) => item.id && isLikelySameMatch(item.title, targetTitle))
      .sort((a, b) => b.score - a.score)[0];
    if (bestSearch) return bestSearch;
  }

  const events = await fetchKambiFootballEvents(offering);
  return events
    .map((item) => scoreKambiEvent(item, targetTitle))
    .filter((item) => item.id && isLikelySameMatch(item.title, targetTitle))
    .sort((a, b) => b.score - a.score)[0];
}

async function discoverKambiMatchLinks(query: string) {
  const events = await fetchKambiFootballEvents();
  const seen = new Set<string>();
  const minimumScore = minSearchScore(query);
  return events
    .map((item) => {
      const event = item.event;
      const title = event?.name ?? event?.englishName ?? "";
      const score = scoreTitleMatch([title, event?.homeName, event?.awayName].filter(Boolean).join(" "), query);
      const isEsports = /esport|cyber live/i.test(event?.group ?? "");
      return {
        title,
        url: event?.id ? `https://www.1x2.se/betting#event/${event.id}` : "",
        score,
        isEsports,
      };
    })
    .filter((item) => item.url && item.title && item.score >= minimumScore)
    .filter((item) => !item.isEsports)
    .filter((item) => !isAudienceMismatch(item.title, query))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .filter((item) => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30)
    .map(({ title, url }) => ({ title, url }));
}

async function fetchComeOnSearchEvents(origin: string, franchiseCode: string, query: string) {
  const url = `${origin}/sportsbook-search-service/public/search?franchiseCode=${encodeURIComponent(franchiseCode)}&locale=sv&query=${encodeURIComponent(query)}&eventTypes=Fixture&sportIds=1`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_HTTP_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  // Diagnos vid 4xx/5xx — skiljer Render-IP-block från andra fel.
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    bookmakerDebugLog(
      `comeon-search:${franchiseCode}:http-${response.status}`,
      `[bookmaker-debug] comeon-search franchise=${franchiseCode} step=http-error status=${response.status} contentType="${truncForLog(contentType, 80)}" url=${truncForLog(url, 200)} query=${truncForLog(query, 80)} bodyPrefix=${truncForLog(body, 400)}`,
    );
    return [];
  }
  // OK-svar: läs som text så vi kan logga vid parse-fel eller tomma events.
  const text = await response.text();
  let data: {
    events?: Array<{ id?: number | string; eventId?: number | string; sportId?: number; leagueId?: number }>;
  };
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    bookmakerDebugLog(
      `comeon-search:${franchiseCode}:json-parse-fail`,
      `[bookmaker-debug] comeon-search franchise=${franchiseCode} step=json-parse-fail status=${response.status} contentType="${truncForLog(contentType, 80)}" bodyPrefix=${truncForLog(text, 400)}`,
    );
    return [];
  }
  const events = data.events ?? [];
  // Loggar response-shape vid första empty-events per franchise/cykel — hjälper skilja A/B/C.
  if (events.length === 0) {
    const keys = Object.keys(data).slice(0, 10).join(",");
    bookmakerDebugLog(
      `comeon-search:${franchiseCode}:empty-events`,
      `[bookmaker-debug] comeon-search franchise=${franchiseCode} step=empty-events status=${response.status} contentType="${truncForLog(contentType, 80)}" responseKeys=[${keys}] eventsType=${typeof data.events} query=${truncForLog(query, 80)} bodyPrefix=${truncForLog(text, 400)}`,
    );
  }
  return events.filter((event) => (event.sportId == null || event.sportId === 1) && (event.id || event.eventId));
}

async function fetchComeOnSearchEventIds(origin: string, franchiseCode: string, query: string) {
  return (await fetchComeOnSearchEvents(origin, franchiseCode, query))
    .map((event) => String(event.id ?? event.eventId))
    .filter(Boolean)
    .slice(0, 30);
}

async function fetchComeOnLeagueEventIds(origin: string, franchiseCode: string, leagueId: number) {
  const data = (await requestComeOnEventsPayload(
    origin,
    franchiseCode,
    {
      filters: {
        leagueIds: [leagueId],
        marketTypeFilters: [{ marketTypeIds: [1] }],
        includeEntities: ["MARKET", "SELECTION"],
      },
      orders: [null],
      pageSize: 50,
    },
    6000,
  )) as Array<{ payload?: { events?: Array<{ id?: number | string }> } }>;
  return (data[0]?.payload?.events ?? [])
    .map((event) => String(event.id))
    .filter(Boolean);
}

async function fetchComeOnCandidateEventIds(origin: string, franchiseCode: string, query: string) {
  const searchEvents = await fetchComeOnSearchEvents(origin, franchiseCode, query);
  const searchIds = searchEvents.map((event) => String(event.id ?? event.eventId)).filter(Boolean);
  const leagueIds = [...new Set(searchEvents.map((event) => event.leagueId).filter((id): id is number => Number.isFinite(id)))];
  const leagueIdsFromEvents = (
    await Promise.allSettled(
      leagueIds.slice(0, 8).map((leagueId) => fetchComeOnLeagueEventIds(origin, franchiseCode, leagueId)),
    )
  ).flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  return [...new Set([...searchIds, ...leagueIdsFromEvents])].slice(0, 40);
}

async function discoverComeOnPartnerUrls(query: string, matches: Array<{ title: string; url: string }>, targetTitleOverride?: string) {
  const targetTitle = getTargetMatchTitle(query, matches, targetTitleOverride);
  const searchQuery = getSearchTokens(targetTitle).slice(0, 2).join(" ") || query;
  const brands = [
    { origin: "https://www.comeon.com", franchiseCode: "SWEDEN_COMEON", pathPrefix: "comeon" },
    { origin: "https://www.hajper.com", franchiseCode: "SWEDEN_HAJPER", pathPrefix: "hajper" },
    { origin: "https://www.snabbare.com", franchiseCode: "SWEDEN_SNABBARE", pathPrefix: "snabbare" },
  ];

  const searchQueries = buildEventSearchQueries(targetTitle, query).slice(0, 10);
  const eventIds = [
    ...new Set(
      (
        await Promise.allSettled(
          searchQueries.map((candidateQuery) =>
            fetchComeOnCandidateEventIds(brands[0].origin, brands[0].franchiseCode, candidateQuery),
          ),
        )
      ).flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    ),
  ].slice(0, 20);
  let bestEventId = "";
  let bestScore = 0;
  for (const eventId of eventIds) {
    try {
      const parsed = await parseOddsRowsFromComeOnSportsbook(`${brands[0].origin}/sv/sportsbook/events/${eventId}`);
      const score = scoreTitleMatch(parsed.title, targetTitle);
      if (isLikelySameMatch(parsed.title, targetTitle) && score > bestScore && parsed.rows.length > 0) {
        bestScore = score;
        bestEventId = eventId;
      }
    } catch {
      // Ignore individual search candidates.
    }
  }

  if (!bestEventId || bestScore < 1) return [];
  return brands.map((brand) => `${brand.origin}/sv/sportsbook/events/${bestEventId}-${brand.pathPrefix}`);
}

async function discoverComeOnMatchLinks(query: string) {
  const origin = "https://www.comeon.com";
  for (const searchQueries of buildSmartSearchQueryGroups(query).map((group) => group.slice(0, 10))) {
    const eventIds = [
      ...new Set(
        (
          await Promise.allSettled(
            searchQueries.map((searchQuery) => fetchComeOnCandidateEventIds(origin, "SWEDEN_COMEON", searchQuery)),
          )
        ).flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      ),
    ];
    const settled = await Promise.allSettled(
      eventIds.slice(0, 12).map(async (eventId) => {
        const parsed = await parseOddsRowsFromComeOnSportsbook(`${origin}/sv/sportsbook/events/${eventId}`);
        return {
          title: parsed.title,
          url: `https://www.comeon.com/sv/sportsbook/events/${eventId}-comeon`,
          score: scoreAgainstAnyQuery(parsed.title, searchQueries),
        };
      }),
    );
    const matches = settled
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .filter((item) => item.title && item.score >= 1)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 12)
      .map(({ title, url }) => ({ title, url }));
    if (matches.length > 0) return matches;
  }
  return [];
}

async function fetchBetssonSearchEventIds(
  context: { baseUrl: string; iframeUrl: string; headers: Record<string, string> },
  searchText: string,
) {
  const data = (await fetchBetssonJson(
    `${context.baseUrl}/api/sb/v2/search/suggestions?searchText=${encodeURIComponent(searchText)}`,
    context.iframeUrl,
    context.headers,
  )) as {
    matches?: Array<{
      categoryName?: string;
      state?: { eventIds?: string[] };
    }>;
  };

  return [
    ...new Set(
      (data.matches ?? [])
        .filter((match) => match.categoryName?.toLowerCase() === "fotboll")
        .flatMap((match) => match.state?.eventIds ?? []),
    ),
  ];
}

async function discoverBetssonPartnerUrls(query: string, matches: Array<{ title: string; url: string }>, targetTitleOverride?: string) {
  const targetTitle = getTargetMatchTitle(query, matches, targetTitleOverride);
  const sideSearches = getMatchSideTokens(targetTitle)
    .map((tokens) => tokens[0])
    .filter(Boolean);
  const searchQueries = [...new Set([...sideSearches, getSearchTokens(targetTitle)[0], query].filter(Boolean))].slice(0, 3);
  const basePageUrl = "https://www.spelklubben.se/sv/betting/?eventId=f-tToyXelaiEyhGVb_LFHRNA&fs=true&eti=0";
  const context = await getBetssonSportsbookContext(basePageUrl);
  if (!context) return [];

  const eventIds = [
    ...new Set(
      (
        await Promise.allSettled(searchQueries.map((searchQuery) => fetchBetssonSearchEventIds(context, searchQuery)))
      ).flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    ),
  ].slice(0, 18);

  let bestEventId = "";
  let bestScore = 0;
  for (const eventId of eventIds) {
    try {
      const eventData = await fetchBetssonJson(
        `${context.baseUrl}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`,
        context.iframeUrl,
        context.headers,
      );
      const title = parseBetssonTitleFromEvent(eventData);
      const score = scoreTitleMatch(title, targetTitle);
      if (isLikelySameMatch(title, targetTitle) && score > bestScore) {
        bestScore = score;
        bestEventId = eventId;
      }
    } catch {
      // Ignore individual search candidates.
    }
  }

  if (!bestEventId) return [];
  return [`https://www.spelklubben.se/sv/betting/?eventId=${encodeURIComponent(bestEventId)}&fs=true&eti=0`];
}

async function discoverBetssonMatchLinks(query: string) {
  const basePageUrl = "https://www.spelklubben.se/sv/betting/?eventId=f-tToyXelaiEyhGVb_LFHRNA&fs=true&eti=0";
  const context = await getBetssonSportsbookContext(basePageUrl);
  if (!context) return [];

  for (const searchQueries of buildSmartSearchQueryGroups(query).map((group) => group.slice(0, 10))) {
    const eventIds = [
      ...new Set(
        (
          await Promise.allSettled(searchQueries.map((searchQuery) => fetchBetssonSearchEventIds(context, searchQuery)))
        ).flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      ),
    ].slice(0, 24);
    const settled = await Promise.allSettled(
      eventIds.map(async (eventId) => {
        const eventData = await fetchBetssonJson(
          `${context.baseUrl}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`,
          context.iframeUrl,
          context.headers,
        );
        const title = parseBetssonTitleFromEvent(eventData);
        return {
          title,
          url: `https://www.spelklubben.se/sv/betting/?eventId=${encodeURIComponent(eventId)}&fs=true&eti=0`,
          score: scoreAgainstAnyQuery(title, searchQueries),
        };
      }),
    );
    const matches = settled
      .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      .filter((item) => item.title && item.score >= 1)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 12)
      .map(({ title, url }) => ({ title, url }));
    if (matches.length > 0) return matches;
  }
  return [];
}

function mergeMatchLinks(matches: Array<{ title: string; url: string }>) {
  const merged: Array<{ title: string; url: string }> = [];
  for (const match of matches) {
    if (merged.some((existing) => isLikelySameMatch(match.title, existing.title))) continue;
    merged.push(match);
  }
  return merged;
}

async function discoverPartnerMatchLinks(query: string) {
  const settled = await Promise.allSettled([
    discoverKambiMatchLinks(query),
    discoverComeOnMatchLinks(query),
    discoverBetssonMatchLinks(query),
    discoverVbetMatchLinks(query),
  ]);
  const all = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const filtered = all.filter(
    (m) => m.title && !looksLikeFantasyOrEsportsTitle(m.title) && !isAudienceMismatch(m.title, query),
  );
  return mergeMatchLinks(filtered)
    .sort((a, b) => scoreTitleMatch(b.title, query) - scoreTitleMatch(a.title, query) || a.title.localeCompare(b.title))
    .slice(0, 50);
}

async function discoverPartnerUrlsForSearch(
  query: string,
  matches: Array<{ title: string; url: string }>,
  targetTitle?: string,
) {
  const discovered = await Promise.allSettled([
    discoverKambiPartnerUrls(query, matches, targetTitle),
    discoverComeOnPartnerUrls(query, matches, targetTitle),
    discoverBetssonPartnerUrls(query, matches, targetTitle),
  ]);
  return discovered.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

function firstAlignedRow(
  rows: OddsRow[],
  sourceTitle: string,
  targetTitle: string,
): OddsRow | null {
  if (!sourceTitle || !isLikelySameMatch(sourceTitle, targetTitle)) return null;
  return alignOddsRowsToTargetTitle(rows, sourceTitle, targetTitle)[0] ?? null;
}

async function scrapeKambiBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "kambi" }>,
  targetTitle: string,
) {
  // Steg 1: GitHub-cache (workflow .github/workflows/kambi-fetch.yml).
  // Snabb path — användare belastar inte upstream API per request. Cache
  // innehåller events MED inbäddade betOffers så vi slipper extra event-call.
  const cacheHit = await tryKambiFromGithubCache(spec, targetTitle);
  if (cacheHit) return cacheHit;

  try {
    const offering = spec.offering;
    const event = await discoverKambiEventForTitle(targetTitle, offering);
    if (!event?.id) return makeBookmakerResult(spec, "not_found", { error: "Match not found on Kambi feed" });

    const sourceUrl = `${spec.origin}${spec.eventPath}/${event.id}`;
    const referer = getKambiOfferingReferer(offering);
    const parsed = await parseOddsRowsFromKambiEvent(offering, String(event.id), referer);
    const row = firstAlignedRow(parsed.rows, parsed.title, targetTitle);
    if (!row) {
      return makeBookmakerResult(spec, "not_found", {
        title: parsed.title,
        sourceUrl,
        error: "Found event did not match selected teams",
      });
    }
    return makeBookmakerResult(spec, "found", {
      title: parsed.title,
      sourceUrl,
      home: row.home,
      draw: row.draw,
      away: row.away,
    });
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : "Unknown Kambi error",
    });
  }
}

/**
 * Calls the brand-specific /api/betting/search endpoint and finds the best matching real-football
 * event (cyber-live and esports already filtered out at the source). Each PAF brand returns its
 * own marginalised odds, so we MUST query each brand individually rather than reusing one set.
 */
async function scrapePafBrandBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "paf-brand" }>,
  targetTitle: string,
  fallbackQuery: string,
) {
  // Steg 1: GitHub-cache (workflow .github/workflows/paf-brand-fetch.yml).
  // Prewarm-cache med ~47 strategiska queries per brand. Cache-miss → live
  // smart-search nedan (många matcher finns inte i prewarm).
  const cacheHit = await tryPafBrandFromGithubCache(spec, targetTitle);
  if (cacheHit) return cacheHit;

  try {
    let best: { eventId: string; title: string; odds: { home: number; draw: number; away: number }; score: number } | null = null;

    for (const searchQueries of buildSmartSearchQueryGroups(targetTitle, fallbackQuery).map((group) => group.slice(0, 10))) {
      const events = (
        await Promise.allSettled(searchQueries.map((q) => fetchPafBrandSearchEvents(spec.origin, q)))
      ).flatMap((result) => (result.status === "fulfilled" ? result.value : []));
      for (const event of events) {
        const title = oneXTwoSearchEventTitle(event);
        const odds = oneXTwoSearchEventOdds(event);
        if (!event.eventId || !odds || !title) continue;
        if (!isLikelySameMatch(title, targetTitle)) continue;
        const score = scoreTitleMatch(title, targetTitle);
        if (!best || score > best.score) best = { eventId: String(event.eventId), title, odds, score };
      }
      if (best && best.score >= 2) break;
    }

    if (!best) {
      return makeBookmakerResult(spec, "not_found", { error: "Match not found on brand search" });
    }

    const sourceUrl = `${spec.origin}${spec.eventPath}/${best.eventId}`;
    const row = firstAlignedRow([{ bookmaker: spec.name, ...best.odds }], best.title, targetTitle);
    if (!row) {
      return makeBookmakerResult(spec, "not_found", {
        title: best.title,
        sourceUrl,
        error: "Found event did not match selected teams",
      });
    }
    return makeBookmakerResult(spec, "found", {
      title: best.title,
      sourceUrl,
      home: row.home,
      draw: row.draw,
      away: row.away,
    });
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : "Unknown PAF-brand error",
    });
  }
}

const ALTENAR_FRONTEND_API = "https://sb2frontend-altenar2.biahosted.com/api";
const ALTENAR_CACHE_TTL_MS = 30 * 1000;

type AltenarUpcoming = {
  events?: Array<{
    id?: number;
    name?: string;
    marketIds?: number[];
    sportId?: number;
    catId?: number;
    champId?: number;
    startDate?: string;
  }>;
  markets?: Array<{ id?: number; typeId?: number; name?: string; oddIds?: number[] }>;
  odds?: Array<{ id?: number; typeId?: number; price?: number; oddStatus?: number; name?: string }>;
  categories?: Array<{ id?: number; name?: string }>;
  champs?: Array<{ id?: number; name?: string }>;
};

const altenarUpcomingCache = new Map<string, { expiresAt: number; data: AltenarUpcoming }>();

async function fetchAltenarUpcoming(integration: string, sportId: number = 66) {
  // Cache-nyckel inkluderar sportId — samma integration kan ha helt olika
  // event-set för olika sporter.
  const cacheKey = `${integration}::${sportId}`;
  const cached = altenarUpcomingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const url =
    `${ALTENAR_FRONTEND_API}/widget/GetUpcoming?` +
    new URLSearchParams({
      culture: "sv-SE",
      timezoneOffset: "-120",
      integration,
      deviceType: "1",
      numFormat: "en-GB",
      countryCode: "SE",
      sportId: String(sportId),
    }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_HTTP_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`Altenar HTTP ${response.status}`);
  const data = (await response.json()) as AltenarUpcoming;
  altenarUpcomingCache.set(cacheKey, { expiresAt: Date.now() + ALTENAR_CACHE_TTL_MS, data });
  return data;
}

/**
 * Parsea 2-vägs main-marknad ur Altenar GetUpcoming-svar för icke-fotbolls-event.
 * För tennis/basket/etc: typeId 186/219/etc. För 2-vägs har vi typeId 1+3
 * (home/away, ingen draw på typeId 2).
 */
function parseAltenarTwoWay(data: AltenarUpcoming, eventId: number): { home: number; away: number } | null {
  const event = (data.events ?? []).find((item) => item.id === eventId);
  if (!event?.marketIds) return null;
  const marketsById = new Map((data.markets ?? []).map((market) => [market.id, market]));
  const oddsById = new Map((data.odds ?? []).map((odd) => [odd.id, odd]));

  const candidates = event.marketIds
    .map((id) => marketsById.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.oddIds?.length));

  // Föredra MAIN-flaggade marknader; fallback: hitta 2-utfalls-marknad
  // (oddIds.length === 2). Per-sport-typeId är 186/219/251/406 — vi tar
  // första 2-utfalls-marknad oavsett.
  const market =
    candidates.find((m) => (m.oddIds?.length ?? 0) === 2 && /vinnare|winner|moneyline|inkl/i.test(String(m.name ?? ""))) ??
    candidates.find((m) => (m.oddIds?.length ?? 0) === 2);
  if (!market?.oddIds) return null;

  const odds = market.oddIds.map((id) => oddsById.get(id)).filter(Boolean);
  // typeId 1 = home, typeId 3 = away (för 2-vägs marknader)
  const byType = Object.fromEntries(
    odds
      .filter((odd) => typeof odd.price === "number" && odd.price > 1)
      .filter((odd) => odd.oddStatus === 0 || odd.oddStatus == null)
      .map((odd) => [odd!.typeId, odd!.price]),
  );
  const home = byType[1];
  const away = byType[3] ?? byType[2]; // vissa sporter använder typeId 2 för away
  if (home > 1 && away > 1) return { home, away };

  // Fallback: namn-baserad matchning
  let h: number | undefined;
  let a: number | undefined;
  for (const odd of odds) {
    if (typeof odd?.price !== "number" || !(odd.price > 1)) continue;
    if (odd.oddStatus != null && odd.oddStatus !== 0) continue;
    const nm = String(odd.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (/^1$|^w1$|home|hem/.test(nm) || nm === event.name?.split(/[-–]/)[0].trim().toLowerCase()) h ??= odd.price;
    else if (/^2$|^w2$|away|bort/.test(nm) || nm === event.name?.split(/[-–]/)[1]?.trim().toLowerCase()) a ??= odd.price;
  }
  if (h != null && a != null) return { home: h, away: a };
  return null;
}

function parseAltenarOneXTwo(data: AltenarUpcoming, eventId: number) {
  const event = (data.events ?? []).find((item) => item.id === eventId);
  if (!event?.marketIds) return null;
  const marketsById = new Map((data.markets ?? []).map((market) => [market.id, market]));
  const oddsById = new Map((data.odds ?? []).map((odd) => [odd.id, odd]));

  const candidates = event.marketIds
    .map((id) => marketsById.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.oddIds?.length));

  /** typeId 1 = fullständig match 1X2 i Altenars fotbolls-flöde; välj uttalad 1x2-marknad om flera kandidater finns. */
  const market =
    candidates.find((m) => m.typeId === 1 && /\b1x2\b/i.test(String(m.name ?? ""))) ??
    candidates.find((m) => m.typeId === 1 && /full\s*time|fulltid|match\s*result|^\s*mw\s*$/i.test(String(m.name ?? ""))) ??
    candidates.find((m) => m.typeId === 1);

  if (!market?.oddIds) return null;

  const odds = market.oddIds.map((id) => oddsById.get(id)).filter(Boolean);
  const byType = Object.fromEntries(
    odds
      .filter((odd) => typeof odd.price === "number" && odd.price > 1 && odd.typeId != null)
      .filter((odd) => odd.oddStatus === 0 || odd.oddStatus == null)
      .map((odd) => [odd!.typeId, odd!.price]),
  );
  const home = byType[1];
  const draw = byType[2];
  const away = byType[3];
  if (home > 1 && draw > 1 && away > 1) return { home, draw, away };

  let h: number | undefined;
  let d: number | undefined;
  let a: number | undefined;
  for (const odd of odds) {
    if (typeof odd?.price !== "number" || !(odd.price > 1)) continue;
    if (odd.oddStatus != null && odd.oddStatus !== 0) continue;
    const nm = String(odd.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (/^1$|^w1$|^hem|home\b|^h$/.test(nm)) h = odd.price;
    else if (/^x$|^w?x$|draw|oavgjort|tie\b/.test(nm)) d = odd.price;
    else if (/^2$|^w2$|^bort|away\b|^a$/.test(nm)) a = odd.price;
  }
  if (h != null && d != null && a != null && h > 1 && d > 1 && a > 1) return { home: h, draw: d, away: a };

  return null;
}

async function scrapeAltenarBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "altenar" }>,
  targetTitle: string,
  fallbackQuery: string,
) {
  // Steg 1: GitHub-cache (workflow .github/workflows/altenar-fetch.yml).
  // Snabb path för Render — användare belastar inte upstream API per request.
  // Live-fallback nedan tar över om cachen saknas, är >30min gammal eller
  // matchen inte finns i cachen (t.ex. ny obscure-liga sedan senaste fetch).
  const cacheHit = await tryAltenarFromGithubCache(spec, targetTitle);
  if (cacheHit) return cacheHit;

  try {
    const data = await fetchAltenarUpcoming(spec.integration);
    const candidates = (data.events ?? [])
      .filter((event) => event.id && event.name && event.sportId === 66)
      .filter((event) => !isAudienceMismatch(event.name ?? "", targetTitle))
      .map((event) => ({
        id: Number(event.id),
        title: String(event.name ?? "").replace(/\s+/g, " ").trim(),
        score: scoreTitleMatch(String(event.name ?? ""), targetTitle),
      }))
      .filter((event) => isLikelySameMatch(event.title, targetTitle))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best) return makeBookmakerResult(spec, "not_found", { error: "Match not found on Altenar upcoming feed" });

    const odds = parseAltenarOneXTwo(data, best.id);
    const sourceUrl = spec.sportsUrl;
    if (!odds) {
      return makeBookmakerResult(spec, "not_found", {
        title: best.title,
        sourceUrl,
        error: "1X2 odds not found on Altenar event",
      });
    }

    const row = firstAlignedRow([{ bookmaker: spec.name, ...odds }], best.title, targetTitle);
    if (!row) {
      return makeBookmakerResult(spec, "not_found", {
        title: best.title,
        sourceUrl,
        error: "Found event did not match selected teams",
      });
    }

    return makeBookmakerResult(spec, "found", {
      title: best.title,
      sourceUrl,
      home: row.home,
      draw: row.draw,
      away: row.away,
    });
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : "Unknown Altenar error",
    });
  }
}

async function discoverComeOnEventForBrand(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "comeon" }>,
  targetTitle: string,
  fallbackQuery: string,
) {
  for (const searchQueries of buildSmartSearchQueryGroups(targetTitle, fallbackQuery).map((group) => group.slice(0, 10))) {
    const eventIds = [
      ...new Set(
        (
          await Promise.allSettled(
            searchQueries.map((candidateQuery) =>
              fetchComeOnCandidateEventIds(spec.origin, spec.franchiseCode, candidateQuery),
            ),
          )
        ).flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      ),
    ].slice(0, 20);

    let best: { eventId: string; score: number; title: string } | null = null;
    for (const eventId of eventIds) {
      try {
        const parsed = await parseOddsRowsFromComeOnSportsbook(`${spec.origin}/sv/sportsbook/events/${eventId}`);
        const score = scoreTitleMatch(parsed.title, targetTitle);
        if (parsed.rows.length > 0 && isLikelySameMatch(parsed.title, targetTitle) && (!best || score > best.score)) {
          best = { eventId, score, title: parsed.title };
        }
      } catch {
        // Ignore individual search candidates.
      }
    }
    if (best) return best;
  }
  return null;
}

/** Begränsa logg-strängar till max ~1500 tecken så vi inte spammar Render-loggar. */
function truncForLog(value: unknown, maxLen = 1500): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) + `…(+${s.length - maxLen})` : s;
}

/**
 * Loggar samma (bookmaker, step, result) max en gång per pre-warm-pass.
 * Set rensas i prewarmBestBonusMatchesCache vid pre-warm-start, så varje
 * 10-min cykel ger oss en frisk vy. Behåller räknare så vi vet hur ofta
 * felet faktiskt inträffade — viktigt för att skilja systemfel från
 * enstaka matcher.
 */
const bookmakerDebugSeen = new Map<string, number>();
function bookmakerDebugLog(key: string, message: string) {
  const seen = bookmakerDebugSeen.get(key) ?? 0;
  bookmakerDebugSeen.set(key, seen + 1);
  if (seen === 0) console.warn(message);
}
function resetBookmakerDebugLog() {
  // Innan reset: skriv en rad per (bookmaker, step) med totalt antal i denna pre-warm-cykel.
  for (const [key, count] of bookmakerDebugSeen) {
    if (count > 1) console.warn(`[bookmaker-debug] summary key=${key} occurrences=${count}`);
  }
  bookmakerDebugSeen.clear();
}

// ====================================================================
// ComeOn-gruppens GitHub-cache-integration
// ====================================================================
// Odds-databasen (Supabase) — läs-sidan. Steg 3 i docs/database-plan.md.
//
// Scrapers SPEGLAR redan varje lyckad fil-write till tabellen odds_cache
// (scripts/lib/odds-db.mjs). Här är motsvarande läsare: backend försöker
// hämta payloaden från databasen FÖRST (färskare än GitHub-commit-vägen,
// inga rate-limits), och faller tillbaka på exakt den gamla disk/GitHub-
// vägen om databasen saknas/är stale/inte är konfigurerad.
//
// Säkerhetsdesign: utan SUPABASE_URL/SUPABASE_SERVICE_KEY i env är detta en
// total no-op → beteendet är identiskt med idag tills Render får nycklarna.
// ====================================================================

const ODDS_DB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const ODDS_DB_KEY = (
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ""
).trim();
/** Kort RAM-cache per källa så en burst av API-requests inte hamrar databasen. */
const ODDS_DB_READ_TTL_MS = 10_000;
const ODDS_DB_READ_TIMEOUT_MS = 5_000;
const oddsDbReadCache = new Map<
  string,
  { checkedAt: number; updatedAt: string | null; payload: unknown }
>();
const oddsDbReadInflight = new Map<string, Promise<unknown>>();

/** Liten fetch-hjälpare med timeout + PostgREST-objektsvar (406 = rad saknas). */
async function oddsDbGet(pathAndQuery: string): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ODDS_DB_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${ODDS_DB_URL}${pathAndQuery}`, {
      headers: {
        apikey: ODDS_DB_KEY,
        Authorization: `Bearer ${ODDS_DB_KEY}`,
        Accept: "application/vnd.pgrst.object+json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, json: null };
    return { status: res.status, json: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lista-läsare mot PostgREST (returnerar en array, till skillnad från oddsDbGet
 * som hämtar ETT objekt). Används av tracking-läs-endpoints. No-op (tom array)
 * utan SUPABASE_*. pathAndQuery ska inkludera ?select=…&order=… osv.
 */
async function trackingDbList(pathAndQuery: string): Promise<{ status: number; rows: unknown[] }> {
  if (!ODDS_DB_URL || !ODDS_DB_KEY) return { status: 0, rows: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ODDS_DB_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${ODDS_DB_URL}${pathAndQuery}`, {
      headers: {
        apikey: ODDS_DB_KEY,
        Authorization: `Bearer ${ODDS_DB_KEY}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, rows: [] };
    const json = await res.json();
    return { status: res.status, rows: Array.isArray(json) ? json : [] };
  } catch (error) {
    console.warn(`[tracking-db] läs misslyckades:`, error instanceof Error ? error.message : error);
    return { status: 0, rows: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Paginerad lista-läsare (Range-header, 1000/sida) för export — hämtar ALLA rader
 * ur en tabell med valfri filter-querystring. PostgREST cappar enskild request,
 * så vi sidräknar. Returnerar [] vid fel/saknad tabell.
 */
async function trackingDbListAll(table: string, filterQs = "", pageSize = 1000, maxRows = 50000): Promise<Record<string, unknown>[]> {
  if (!ODDS_DB_URL || !ODDS_DB_KEY) return [];
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${ODDS_DB_URL}/rest/v1/${table}?select=*${filterQs}`, {
        headers: {
          apikey: ODDS_DB_KEY,
          Authorization: `Bearer ${ODDS_DB_KEY}`,
          Accept: "application/json",
          Range: `${offset}-${offset + pageSize - 1}`,
          "Range-Unit": "items",
        },
        signal: controller.signal,
      });
      if (!res.ok) return out;
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      out.push(...page);
      if (page.length < pageSize) break;
    } catch {
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/**
 * Hämta senaste payloaden för en källa ur odds_cache. Returnerar null om
 * databasen inte är konfigurerad, raden saknas eller anropet failar — callern
 * faller då tillbaka på disk/GitHub precis som tidigare.
 *
 * PRESTANDA (fix 2026-06-11): payloads är stora (altenar ~2 MB, totalt ~3.7 MB
 * för flottan) och hämtades tidigare i sin helhet vid varje cache-miss (var
 * 10:e s under aktiv användning) → segt UI + onödig egress. Nu görs en BILLIG
 * updated_at-prob (~100 B) först; hela payloaden laddas BARA när datan faktiskt
 * ändrats sedan förra hämtningen. Vid transienta fel returneras senaste kända
 * payload (loaderns åldersgrind skyddar ändå mot stale).
 */
async function fetchOddsDbPayload(sourceId: string): Promise<unknown> {
  if (!ODDS_DB_URL || !ODDS_DB_KEY) return null;
  const cached = oddsDbReadCache.get(sourceId);
  if (cached && Date.now() - cached.checkedAt < ODDS_DB_READ_TTL_MS) return cached.payload;
  const inflight = oddsDbReadInflight.get(sourceId);
  if (inflight) return inflight;

  const base = `/rest/v1/odds_cache?source_id=eq.${encodeURIComponent(sourceId)}`;
  const promise = (async (): Promise<unknown> => {
    try {
      // 1) Billig prob när vi redan HAR en payload: bara updated_at (~100 B).
      //    Oförändrad → återanvänd cachen utan stor transfer.
      if (cached && cached.updatedAt) {
        const probe = await oddsDbGet(`${base}&select=updated_at`);
        if (probe.status === 406) {
          // Raden borta → glöm cachen.
          oddsDbReadCache.set(sourceId, { checkedAt: Date.now(), updatedAt: null, payload: null });
          return null;
        }
        const probedAt = (probe.json as { updated_at?: string } | null)?.updated_at ?? null;
        if (probe.status === 200 && probedAt && probedAt === cached.updatedAt) {
          oddsDbReadCache.set(sourceId, { ...cached, checkedAt: Date.now() });
          return cached.payload;
        }
        if (probe.status !== 200) {
          // Transient fel → behåll senaste kända payload (åldersgrinden skyddar).
          console.warn(`[odds-db] prob ${sourceId}: HTTP ${probe.status} — återanvänder cache`);
          oddsDbReadCache.set(sourceId, { ...cached, checkedAt: Date.now() });
          return cached.payload;
        }
        // updated_at ändrad → fall igenom till full hämtning.
      }

      // 2) Full hämtning: payload + updated_at (första gången eller efter ändring).
      const res = await oddsDbGet(`${base}&select=payload,updated_at`);
      if (res.status !== 200) {
        if (res.status !== 406) console.warn(`[odds-db] läs ${sourceId}: HTTP ${res.status}`);
        oddsDbReadCache.set(sourceId, { checkedAt: Date.now(), updatedAt: null, payload: null });
        return null;
      }
      const row = res.json as { payload?: unknown; updated_at?: string } | null;
      const payload = row?.payload ?? null;
      oddsDbReadCache.set(sourceId, {
        checkedAt: Date.now(),
        updatedAt: row?.updated_at ?? null,
        payload,
      });
      return payload;
    } catch (error) {
      console.warn(
        `[odds-db] läs ${sourceId} misslyckades:`,
        error instanceof Error ? error.message : error,
      );
      // Transient nätverksfel → behåll senaste kända payload om vi har en.
      if (cached) {
        oddsDbReadCache.set(sourceId, { ...cached, checkedAt: Date.now() });
        return cached.payload;
      }
      oddsDbReadCache.set(sourceId, { checkedAt: Date.now(), updatedAt: null, payload: null });
      return null;
    } finally {
      oddsDbReadInflight.delete(sourceId);
    }
  })();
  oddsDbReadInflight.set(sourceId, promise);
  return promise;
}

/** Ålder i ms från en payloads updatedAt-fält (null om saknas/ogiltig). */
function oddsDbPayloadAgeMs(payload: unknown): number | null {
  const updatedAt = (payload as { updatedAt?: string } | null)?.updatedAt;
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

/**
 * GENERISK GitHub-fallback för odds-rows-filer. KRITISKT: DB-speglingen
 * (mirrorOddsFile) är fire-and-forget och abortas när en per-iteration-scraper
 * exit:ar innan POSTen hinner klart → DB-raden blir aldrig färsk för bl.a.
 * betfair/sbobet. Git-filen är dock ALLTID färsk (committas var ~75s). Hämtar den
 * via GitHub Contents-API (ocachad → färsk) med raw.githubusercontent som backup.
 * Exakt samma mönster som comeon/betsson/altenar/kambi m.fl. redan använder för att
 * inte drivа stale. 30s in-memory-cache så vi inte hamrar GitHub per request.
 */
const ODDS_GH_CACHE_TTL_MS = 30_000;
const oddsGithubCache = new Map<string, { at: number; payload: unknown }>();
const oddsGithubInflight = new Map<string, Promise<unknown>>();

async function fetchRowsFromGithub(sourceId: string): Promise<unknown> {
  const cached = oddsGithubCache.get(sourceId);
  if (cached && Date.now() - cached.at < ODDS_GH_CACHE_TTL_MS) return cached.payload;
  const existing = oddsGithubInflight.get(sourceId);
  if (existing) return existing;
  const apiUrl = `https://api.github.com/repos/Lilgunner24/linusgan/contents/data/${sourceId}.json?ref=main`;
  const rawUrl = `https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/${sourceId}.json`;
  const tryFetch = async (url: string, headers: Record<string, string>): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "matched-betting-render", ...headers }, signal: controller.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(apiUrl, apiHeaders);
    if (!data) data = await tryFetch(rawUrl, {});
    if (data) oddsGithubCache.set(sourceId, { at: Date.now(), payload: data });
    return data;
  })().finally(() => oddsGithubInflight.delete(sourceId));
  oddsGithubInflight.set(sourceId, promise);
  return promise;
}

/**
 * SBOBET-payload för /api/sources/status (sharp komplement, DOM-skrapa). Speglas
 * till Supabase som "sbobet-rows" + ligger på disk i data/sbobet-rows.json. DB
 * först om färsk (<45 min), annars GitHub (alltid färsk git-fil), annars disk.
 * OBS: `events` är en OBJEKT-map (eventId → event), inte en array.
 */
type SbobetStatusPayload = {
  updatedAt?: string | null;
  events?: Record<string, unknown>;
  source?: string;
  blocked?: boolean;
  lastError?: string | null;
};

function loadSbobetPayloadFromDisk(): SbobetStatusPayload | null {
  try {
    const file = path.resolve(process.cwd(), "data", "sbobet-rows.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SbobetStatusPayload;
  } catch {
    return null;
  }
}

async function loadSbobetPayloadWithMeta(): Promise<{ payload: SbobetStatusPayload | null; source: string }> {
  const db = (await fetchOddsDbPayload("sbobet-rows")) as SbobetStatusPayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  // DB föredras BARA om genuint färsk (<90s). Förut <45min → en stale DB-rad (t.ex.
  // 6 min, från innan mirror-fixen) returnerades och GitHub-fallbacken nåddes ALDRIG.
  if (db && dbAge !== null && dbAge < 90_000) return { payload: db, source: "db" };
  // DB stale/saknas (spegling abortar vid scrape-process-exit) → hämta ALLTID-färska
  // git-filen via GitHub. Render-disken är deploy-fryst → får ej vara primär fallback.
  const gh = (await fetchRowsFromGithub("sbobet-rows")) as SbobetStatusPayload | null;
  const ghAge = oddsDbPayloadAgeMs(gh);
  if (gh && ghAge !== null && ghAge < 45 * 60_000) return { payload: gh, source: "github" };
  const disk = loadSbobetPayloadFromDisk();
  if (disk) return { payload: disk, source: "disk" };
  if (gh) return { payload: gh, source: "github" };
  if (db) return { payload: db, source: "db" };
  return { payload: null, source: "empty" };
}

/**
 * Betfair-payload för /api/sources/status (börs, sharp komplement via UK-VPN).
 * Speglas till Supabase som "betfair-rows" + ligger på disk i data/betfair-rows.json.
 * DB först om färsk (<60 min), annars disk. `events` är en OBJEKT-map
 * (betfairEventId → ParsedBetfairEvent) → räkna med Object.keys.
 */
type BetfairStatusPayload = {
  updatedAt?: string | null;
  events?: Record<string, unknown>;
  source?: string;
  blocked?: boolean;
  lastError?: string | null;
};

function loadBetfairPayloadFromDisk(): BetfairStatusPayload | null {
  try {
    const file = path.resolve(process.cwd(), "data", "betfair-rows.json");
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as BetfairStatusPayload;
  } catch {
    return null;
  }
}

async function loadBetfairPayloadWithMeta(): Promise<{ payload: BetfairStatusPayload | null; source: string }> {
  const db = (await fetchOddsDbPayload("betfair-rows")) as BetfairStatusPayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  // DB föredras BARA om genuint färsk (<90s). Förut <60min → en stale DB-rad (t.ex.
  // 6 min, från innan mirror-fixen) returnerades och GitHub-fallbacken nåddes ALDRIG.
  if (db && dbAge !== null && dbAge < 90_000) return { payload: db, source: "db" };
  // DB stale/saknas (spegling abortar vid scrape-process-exit, ev. + VPN) → hämta
  // ALLTID-färska git-filen via GitHub. Render-disken är deploy-fryst → ej primär.
  const gh = (await fetchRowsFromGithub("betfair-rows")) as BetfairStatusPayload | null;
  const ghAge = oddsDbPayloadAgeMs(gh);
  if (gh && ghAge !== null && ghAge < 60 * 60_000) return { payload: gh, source: "github" };
  const disk = loadBetfairPayloadFromDisk();
  if (disk) return { payload: disk, source: "disk" };
  if (gh) return { payload: gh, source: "github" };
  if (db) return { payload: db, source: "db" };
  return { payload: null, source: "empty" };
}

// ====================================================================
// Bakgrunds-värmare: håll ALLA odds-payloads varma i RAM kontinuerligt.
//
// Utan denna hämtas en payload först när en request behöver den (cache-miss)
// → användaren VÄNTAR på en MB-transfer mitt i sidladdningen. Med värmaren
// sker probandet/hämtningen i bakgrunden var ~8:e sekund (under läs-TTL:en
// på 10 s) → request-handlers träffar alltid RAM och svarar direkt. Tack
// vare updated_at-proben kostar en varm cykel ~10 × 100 B; hela payloads
// flyttas bara när datan faktiskt ändrats — dvs. samma totala datamängd som
// förut, men flyttad till bakgrunden där ingen väntar på den.
// ====================================================================

const ODDS_DB_SOURCE_IDS = [
  "pinnacle-rows",
  "kambi-rows",
  "altenar-rows",
  "comeon-rows",
  "betsson-rows",
  "vbet-rows",
  "paf-brand-rows",
] as const;
const ODDS_DB_WARM_INTERVAL_MS = 8_000;
let oddsDbWarmerStarted = false;

function startOddsDbWarmer(): void {
  if (oddsDbWarmerStarted || !ODDS_DB_URL || !ODDS_DB_KEY) return;
  oddsDbWarmerStarted = true;
  const warm = () => {
    // Parallellt + fire-and-forget; fetchOddsDbPayload kastar aldrig och
    // dedupar inflight, så detta kan inte stapla sig.
    for (const id of ODDS_DB_SOURCE_IDS) void fetchOddsDbPayload(id);
  };
  warm(); // värm direkt vid serverstart så första sidladdningen är snabb
  const timer = setInterval(warm, ODDS_DB_WARM_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  console.log(
    `[odds-db] bakgrunds-värmare igång: ${ODDS_DB_SOURCE_IDS.length} källor var ${ODDS_DB_WARM_INTERVAL_MS / 1000}s (payload hämtas bara vid ändring)`,
  );
}
startOddsDbWarmer();

// ====================================================================
//
// Render-IP är blockerad av Cloudflare WAF för comeon.com / hajper.com /
// snabbare.com (HTTP 403 text/html). Lösning: GitHub Actions-workflow
// .github/workflows/comeon-fetch.yml kör scripts/fetch-comeon-github-action.mjs
// på Azure-runners (passerar Cloudflare), commit:ar data/comeon-rows.json
// tillbaka till repot. Render läser via GitHub API contents endpoint
// (raw fallback) — samma mönster som Pinnacle, men hela payloaden är liten
// (några kB) så vi har inga rate-limit-bekymmer ens på anonymt API.
//
// Lokal direkt-scrape (discoverComeOnEventForBrand → live RSocket) behålls
// som fallback: när cache saknar matchen eller är tom används den befintliga
// vägen — fungerar lokalt under utveckling, misslyckas tyst på Render där
// vi då bara markerar matchen som not_found.

const COMEON_DATA_FILE = path.resolve(process.cwd(), "data", "comeon-rows.json");
const COMEON_GITHUB_API_URL =
  process.env.COMEON_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/comeon-rows.json?ref=main";
const COMEON_RAW_GITHUB_URL =
  process.env.COMEON_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/comeon-rows.json";
/** TTL för in-memory cache av hela payloaden — undvik refetch per request. */
const COMEON_GITHUB_CACHE_TTL_MS = 60 * 1000;
/** Disk anses användbar i 60 min (workflow:n uppdaterar var 10 min). */
const COMEON_DISK_MAX_AGE_MS = 60 * 60 * 1000;
/** Föredra GitHub om disk-fil är äldre än 5 min — Render-deploy kan ha gammal disk. */
const COMEON_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;

type ComeOnCacheEvent = {
  eventId: string;
  leagueId: number | null;
  title: string;
  homeTeam: string;
  awayTeam: string;
  odds: { home: number; draw: number; away: number };
  foundBy?: string;
};
type ComeOnCachePayload = {
  updatedAt?: string | null;
  source?: string;
  testQueries?: string[];
  concurrency?: number;
  byFranchise?: Record<
    string,
    {
      bookmaker?: string;
      events?: ComeOnCacheEvent[];
    }
  >;
};

let comeonGithubInflight: Promise<ComeOnCachePayload | null> | null = null;
let comeonGithubCachedAt = 0;
let comeonGithubCachedPayload: ComeOnCachePayload | null = null;
let comeonLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchComeOnFromGithub(): Promise<ComeOnCachePayload | null> {
  const now = Date.now();
  if (comeonGithubCachedPayload && now - comeonGithubCachedAt < COMEON_GITHUB_CACHE_TTL_MS) {
    return comeonGithubCachedPayload;
  }
  if (comeonGithubInflight) return comeonGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<ComeOnCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "matched-betting-render",
          ...extraHeaders,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(
          `[comeon-cache] ${label} HTTP ${response.status}${
            remaining ? ` (rate-limit remaining=${remaining})` : ""
          }`,
        );
        return null;
      }
      const data = (await response.json()) as ComeOnCachePayload;
      console.log(
        `[comeon-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, franchises=${
          Object.keys(data?.byFranchise ?? {}).length
        })`,
      );
      return data;
    } catch (error) {
      console.warn(
        `[comeon-cache] ${label} fetch failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) {
      apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    let data = await tryFetch(COMEON_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) {
      comeonLastFetchSource = "github-api";
    } else {
      data = await tryFetch(COMEON_RAW_GITHUB_URL, "github-raw");
      if (data) comeonLastFetchSource = "github-raw";
    }
    if (data) {
      comeonGithubCachedPayload = data;
      comeonGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    comeonGithubInflight = null;
  });
  comeonGithubInflight = promise;
  return promise;
}

function loadComeOnPayloadFromDisk(): ComeOnCachePayload | null {
  try {
    if (!fs.existsSync(COMEON_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(COMEON_DATA_FILE, "utf-8")) as ComeOnCachePayload;
    if (parsed?.source === "initial-empty") return null;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > COMEON_DISK_MAX_AGE_MS) {
      console.warn(
        `[comeon-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn(
      `[comeon-cache] disk read failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function comeonPayloadAgeMs(payload: ComeOnCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

/**
 * Hämtar ComeOn-payloaden med samma val-strategi som Pinnacle:
 *   1. Disk om < 5 min gammal (snabbt, lokal-vänligt).
 *   2. Annars GitHub API/raw (Render-vägen).
 *   3. Fallback: disk även om gammal (hellre stale data än ingen).
 */
async function loadComeOnPayloadWithMeta(): Promise<{
  payload: ComeOnCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  // Databas först (se odds-db-sektionen) — färsk DB-payload vinner, annars
  // exakt den gamla disk/GitHub-vägen.
  const db = (await fetchOddsDbPayload("comeon-rows")) as ComeOnCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < COMEON_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadComeOnPayloadFromDisk();
  const diskAge = comeonPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < COMEON_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchComeOnFromGithub();
  if (fromGithub) {
    return {
      payload: fromGithub,
      source: comeonLastFetchSource === "github-raw" ? "github-raw" : "github-api",
    };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

/**
 * Försöker hitta matchen i GitHub-cache-payloaden för aktuell franchise.
 * Använder samma title-matching (isLikelySameMatch + scoreTitleMatch) som
 * live-pipelinen så vi får konsekvent beteende mellan cache och live.
 */
function findComeOnEventInCache(
  payload: ComeOnCachePayload | null,
  franchiseCode: string,
  targetTitle: string,
): { event: ComeOnCacheEvent; score: number } | null {
  const events = payload?.byFranchise?.[franchiseCode]?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  let best: { event: ComeOnCacheEvent; score: number } | null = null;
  for (const event of events) {
    const candidateTitle = event.title || `${event.homeTeam} - ${event.awayTeam}`;
    if (!candidateTitle) continue;
    if (!isLikelySameMatch(candidateTitle, targetTitle)) continue;
    const score = scoreTitleMatch(candidateTitle, targetTitle);
    if (!best || score > best.score) best = { event, score };
  }
  return best;
}

/**
 * Cache-first scrape-väg för ComeOn-gruppen. Returnerar ett färdigt
 * BookmakerScrapeResult om matchen hittas i cachen, annars null så att
 * caller faller tillbaka på live-scrape.
 */
async function tryComeOnFromGithubCache(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "comeon" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult | null> {
  let meta: Awaited<ReturnType<typeof loadComeOnPayloadWithMeta>>;
  try {
    meta = await loadComeOnPayloadWithMeta();
  } catch (error) {
    console.warn(
      `[comeon-cache] payload load crashed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const match = findComeOnEventInCache(meta.payload, spec.franchiseCode, targetTitle);
  if (!match) return null;

  const sourceUrl = `${spec.origin}/sv/sportsbook/events/${match.event.eventId}-${spec.pathPrefix}`;
  console.log(
    `[comeon-cache] ${spec.id}: hit (source=${meta.source}) eventId=${match.event.eventId} score=${match.score} title="${truncForLog(match.event.title, 80)}"`,
  );
  return makeBookmakerResult(spec, "found", {
    title: match.event.title,
    sourceUrl,
    home: match.event.odds.home,
    draw: match.event.odds.draw,
    away: match.event.odds.away,
  });
}

async function scrapeComeOnBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "comeon" }>,
  targetTitle: string,
  fallbackQuery: string,
) {
  // Steg 1: försök GitHub-cache (workflow:n .github/workflows/comeon-fetch.yml).
  // På Render är detta enda fungerande väg eftersom Cloudflare blockar IP:n.
  // Lokalt: cachen kan vara up-to-date (workflow har redan kört), då slipper
  // vi även lokalt en dyr Chromium-discovery.
  const cacheHit = await tryComeOnFromGithubCache(spec, targetTitle);
  if (cacheHit) return cacheHit;

  // Steg 2: fallback till live-scrape. Fungerar lokalt; misslyckas på Render
  // (Cloudflare 403) och ger då not_found-result med diagnostik-logg.
  try {
    const event = await discoverComeOnEventForBrand(spec, targetTitle, fallbackQuery);
    if (!event) {
      // Diagnostik: vilka franchise/queries gav tom search? Logga första gången per pre-warm-pass.
      const searchSample = truncForLog(
        JSON.stringify({
          targetTitle: truncForLog(targetTitle, 80),
          fallbackQuery: truncForLog(fallbackQuery, 80),
          firstQueryGroup: buildSmartSearchQueryGroups(targetTitle, fallbackQuery)[0]?.slice(0, 6),
        }),
        700,
      );
      bookmakerDebugLog(
        `comeon:${spec.id}:search-discover:not_found`,
        `[bookmaker-debug] comeon bookmaker=${spec.id} franchise=${spec.franchiseCode} step=search-discover result=not_found queries=${searchSample}`,
      );
      return makeBookmakerResult(spec, "not_found", { error: "Match not found on sportsbook search" });
    }

    const sourceUrl = `${spec.origin}/sv/sportsbook/events/${event.eventId}-${spec.pathPrefix}`;
    const parsed = await parseOddsRowsFromComeOnSportsbook(sourceUrl);
    const row = firstAlignedRow(parsed.rows, parsed.title, targetTitle);
    if (!row) {
      bookmakerDebugLog(
        `comeon:${spec.id}:align-row:not_found`,
        `[bookmaker-debug] comeon bookmaker=${spec.id} franchise=${spec.franchiseCode} step=align-row result=not_found eventId=${event.eventId} parsedTitle=${truncForLog(parsed.title, 80)} parsedRows=${parsed.rows.length} target=${truncForLog(targetTitle, 80)} url=${truncForLog(sourceUrl, 200)}`,
      );
      return makeBookmakerResult(spec, "not_found", {
        title: parsed.title,
        sourceUrl,
        error: "Found event did not match selected teams",
      });
    }
    return makeBookmakerResult(spec, "found", {
      title: parsed.title,
      sourceUrl,
      home: row.home,
      draw: row.draw,
      away: row.away,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown ComeOn error";
    const stack = error instanceof Error && error.stack ? truncForLog(error.stack, 800) : "";
    bookmakerDebugLog(
      `comeon:${spec.id}:exception`,
      `[bookmaker-debug] comeon bookmaker=${spec.id} franchise=${spec.franchiseCode} step=exception err="${truncForLog(msg, 200)}" stack="${stack}"`,
    );
    return makeBookmakerResult(spec, "error", {
      error: msg,
    });
  }
}

// ====================================================================
// Betsson-grupp GitHub-cache-integration (Bethard + Spelklubben)
// ====================================================================
//
// Render-IP är blockerad av Cloudflare/Akamai WAF för Betsson-domänerna
// (HTTP 403 på HTML-sidan). Lösning: GitHub Actions-workflow
// .github/workflows/betsson-fetch.yml kör scripts/fetch-betsson-github-
// action.mjs på Azure-runners (stealth-Chromium klarar clearance) och
// commit:ar data/betsson-rows.json. Render läser via GitHub API contents
// endpoint (raw fallback) — samma mönster som Pinnacle och ComeOn-gruppen.
//
// En enda cache-fil för båda Bethard + Spelklubben — de delar Betsson-grupp-
// API och returnerar identiska odds. findBetssonEventInCache är spec-
// oberoende; backend slår upp samma events för båda bookmaker-id.
//
// Live-fallback (befintlig getBetssonSportsbookContext + REST) behålls för
// lokal utveckling. På Render misslyckas live-vägen med 403, så cache-vägen
// är enda som fungerar.

const BETSSON_DATA_FILE = path.resolve(process.cwd(), "data", "betsson-rows.json");
const BETSSON_GITHUB_API_URL =
  process.env.BETSSON_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/betsson-rows.json?ref=main";
const BETSSON_RAW_GITHUB_URL =
  process.env.BETSSON_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/betsson-rows.json";
const BETSSON_GITHUB_CACHE_TTL_MS = 60 * 1000;
const BETSSON_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const BETSSON_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;

type BetssonCacheEvent = {
  eventId: string;
  title: string;
  homeTeam: string;
  awayTeam: string;
  odds: { home: number; draw: number; away: number };
  foundBy?: string;
};
type BetssonCachePayload = {
  updatedAt?: string | null;
  source?: string;
  queryStrategy?: string;
  queryLookaheadHours?: number;
  queryCount?: number;
  contextLabel?: string;
  brandId?: string;
  events?: BetssonCacheEvent[];
};

let betssonGithubInflight: Promise<BetssonCachePayload | null> | null = null;
let betssonGithubCachedAt = 0;
let betssonGithubCachedPayload: BetssonCachePayload | null = null;
let betssonLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchBetssonFromGithub(): Promise<BetssonCachePayload | null> {
  const now = Date.now();
  if (betssonGithubCachedPayload && now - betssonGithubCachedAt < BETSSON_GITHUB_CACHE_TTL_MS) {
    return betssonGithubCachedPayload;
  }
  if (betssonGithubInflight) return betssonGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<BetssonCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(
          `[betsson-cache] ${label} HTTP ${response.status}${
            remaining ? ` (rate-limit remaining=${remaining})` : ""
          }`,
        );
        return null;
      }
      const data = (await response.json()) as BetssonCachePayload;
      console.log(
        `[betsson-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, events=${
          data?.events?.length ?? 0
        })`,
      );
      return data;
    } catch (error) {
      console.warn(
        `[betsson-cache] ${label} fetch failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) {
      apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    let data = await tryFetch(BETSSON_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) {
      betssonLastFetchSource = "github-api";
    } else {
      data = await tryFetch(BETSSON_RAW_GITHUB_URL, "github-raw");
      if (data) betssonLastFetchSource = "github-raw";
    }
    if (data) {
      betssonGithubCachedPayload = data;
      betssonGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    betssonGithubInflight = null;
  });
  betssonGithubInflight = promise;
  return promise;
}

function loadBetssonPayloadFromDisk(): BetssonCachePayload | null {
  try {
    if (!fs.existsSync(BETSSON_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(BETSSON_DATA_FILE, "utf-8")) as BetssonCachePayload;
    if (parsed?.source === "initial-empty") return null;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > BETSSON_DISK_MAX_AGE_MS) {
      console.warn(
        `[betsson-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn(
      "[betsson-cache] disk read failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function betssonPayloadAgeMs(payload: BetssonCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

async function loadBetssonPayloadWithMeta(): Promise<{
  payload: BetssonCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  // Databas först — färsk DB-payload vinner, annars gamla disk/GitHub-vägen.
  const db = (await fetchOddsDbPayload("betsson-rows")) as BetssonCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < BETSSON_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadBetssonPayloadFromDisk();
  const diskAge = betssonPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < BETSSON_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchBetssonFromGithub();
  if (fromGithub) {
    return {
      payload: fromGithub,
      source: betssonLastFetchSource === "github-raw" ? "github-raw" : "github-api",
    };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

function findBetssonEventInCache(
  payload: BetssonCachePayload | null,
  targetTitle: string,
): { event: BetssonCacheEvent; score: number } | null {
  const events = payload?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  let best: { event: BetssonCacheEvent; score: number } | null = null;
  for (const event of events) {
    const candidateTitle = event.title || `${event.homeTeam} - ${event.awayTeam}`;
    if (!candidateTitle) continue;
    if (!isLikelySameMatch(candidateTitle, targetTitle)) continue;
    const score = scoreTitleMatch(candidateTitle, targetTitle);
    if (!best || score > best.score) best = { event, score };
  }
  return best;
}

async function tryBetssonFromGithubCache(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "betsson" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult | null> {
  let meta: Awaited<ReturnType<typeof loadBetssonPayloadWithMeta>>;
  try {
    meta = await loadBetssonPayloadWithMeta();
  } catch (error) {
    console.warn(
      "[betsson-cache] payload load crashed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const match = findBetssonEventInCache(meta.payload, targetTitle);
  if (!match) return null;

  const sourceUrl = `${spec.origin}${spec.basePath}?eventId=${encodeURIComponent(match.event.eventId)}&fs=true&eti=0`;
  console.log(
    `[betsson-cache] ${spec.id}: hit (source=${meta.source}) eventId=${match.event.eventId} score=${match.score} title="${truncForLog(match.event.title, 80)}"`,
  );
  return makeBookmakerResult(spec, "found", {
    title: match.event.title,
    sourceUrl,
    home: match.event.odds.home,
    draw: match.event.odds.draw,
    away: match.event.odds.away,
  });
}

async function scrapeBetssonBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "betsson" }>,
  targetTitle: string,
  fallbackQuery: string,
) {
  // Steg 1: GitHub-cache (workflow .github/workflows/betsson-fetch.yml).
  // På Render är detta enda fungerande väg — Cloudflare/Akamai 403 på HTML-
  // fetchen gör att live-fallback nedan alltid misslyckas där.
  const cacheHit = await tryBetssonFromGithubCache(spec, targetTitle);
  if (cacheHit) return cacheHit;

  // Steg 2: live-fallback. Fungerar lokalt under utveckling; faller tyst
  // på Render och resulterar i blocked/not_found med befintlig diagnostik.
  bookmakerDebugLog(
    `betsson:${spec.id}:cache:miss`,
    `[bookmaker-debug] betsson bookmaker=${spec.id} step=cache result=miss target=${truncForLog(targetTitle, 80)} — fallback till live-scrape`,
  );

  try {
    const contextUrls = [
      `${spec.origin}${spec.basePath}?eventId=f-tToyXelaiEyhGVb_LFHRNA&fs=true&eti=0`,
      `${spec.origin}${spec.basePath}`,
      /** Spelklubben's iframe can be CloudFront-blocked while the same public Betsson-group API is reachable via Bethard. */
      "https://www.bethard.com/sv/sports/sok",
      "https://www.bethard.com/sv/sports/sok?eventId=f-tToyXelaiEyhGVb_LFHRNA&fs=true&eti=0",
      "https://www.bethard.com/sv/sports",
      "https://www.spelklubben.se/sv/betting/sok",
      "https://www.spelklubben.se/sv/betting/sok?eventId=f-tToyXelaiEyhGVb_LFHRNA&fs=true&eti=0",
      "https://www.spelklubben.se/sv/betting/",
      "https://www.betsson.com/sv/sport",
    ];
    let context: Awaited<ReturnType<typeof getBetssonSportsbookContext>> | null = null;
    let contextError = "";
    for (const contextUrl of [...new Set(contextUrls)]) {
      try {
        context = await getBetssonSportsbookContext(contextUrl);
        if (context) break;
      } catch (error) {
        contextError = error instanceof Error ? error.message : "Unknown context error";
      }
    }
    if (!context) {
      return makeBookmakerResult(spec, "blocked", { error: contextError || "Could not load sportsbook context" });
    }

    let best: { eventId: string; title: string; score: number } | null = null;
    for (const searchQueries of buildSmartSearchQueryGroups(targetTitle, fallbackQuery).map((group) => group.slice(0, 10))) {
      const eventIds = [
        ...new Set(
          (
            await Promise.allSettled(searchQueries.map((searchQuery) => fetchBetssonSearchEventIds(context, searchQuery)))
          ).flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
        ),
      ].slice(0, 24);

      for (const eventId of eventIds) {
        try {
          const eventData = await fetchBetssonJson(
            `${context.baseUrl}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`,
            context.iframeUrl,
            context.headers,
          );
          const title = parseBetssonTitleFromEvent(eventData);
          const score = scoreTitleMatch(title, targetTitle);
          if (isLikelySameMatch(title, targetTitle) && (!best || score > best.score)) {
            best = { eventId, title, score };
          }
        } catch {
          // Ignore individual candidates.
        }
      }
      if (best) break;
    }

    if (!best) return makeBookmakerResult(spec, "not_found", { error: "Match not found on sportsbook search" });

    let odds: ReturnType<typeof parseBetssonOddsFromAccordion> = null;
    const accordionUrls = [
      `${context.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(best.eventId)}&groupableId=MW3W`,
      `${context.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(best.eventId)}`,
    ];
    for (const accUrl of accordionUrls) {
      try {
        const accordionData = await fetchBetssonJson(accUrl, context.iframeUrl, context.headers);
        odds = parseBetssonOddsFromAccordion(accordionData);
        if (odds) break;
      } catch {
        // prova nästa URL (vissa brands levererar MW3W först vid groupableId=all)
      }
    }
    if (!odds) {
      return makeBookmakerResult(spec, "not_found", {
        title: best.title,
        sourceUrl: `${spec.origin}${spec.basePath}?eventId=${encodeURIComponent(best.eventId)}&fs=true&eti=0`,
        error: "1X2 odds not found",
      });
    }

    const row = firstAlignedRow([{ bookmaker: spec.name, ...odds }], best.title, targetTitle);
    if (!row) return makeBookmakerResult(spec, "not_found", { title: best.title, error: "Found event did not match selected teams" });

    return makeBookmakerResult(spec, "found", {
      title: best.title,
      sourceUrl: `${spec.origin}${spec.basePath}?eventId=${encodeURIComponent(best.eventId)}&fs=true&eti=0`,
      home: row.home,
      draw: row.draw,
      away: row.away,
    });
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : "Unknown Betsson-group error",
    });
  }
}

const VBET_CONF_URL = "https://www.vbet.se/desktop/conf.json";
const VBET_SWARM_WS = "wss://eu-swarm-newm.vbet.se";
const VBET_CONF_TTL_MS = 5 * 60 * 1000;

let vbetConfigCache: { value: { siteId: number; releaseDate: string }; expiresAt: number } | null = null;

async function getVbetConfig() {
  const now = Date.now();
  if (vbetConfigCache && vbetConfigCache.expiresAt > now) return vbetConfigCache.value;
  const upstream = await fetch(VBET_CONF_URL, {
    signal: AbortSignal.timeout(UPSTREAM_HTTP_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!upstream.ok) throw new Error(`VBET config HTTP ${upstream.status}`);
  const conf = (await upstream.json()) as { preferences?: { siteId?: number }; releaseDate?: string };
  const siteId = conf.preferences?.siteId;
  const releaseDate = conf.releaseDate;
  if (!siteId || !releaseDate) throw new Error("VBET config missing siteId or releaseDate");
  vbetConfigCache = { value: { siteId, releaseDate }, expiresAt: now + VBET_CONF_TTL_MS };
  return vbetConfigCache.value;
}

function vbetLikePredicate(term: string): { "@like": { pred: string; swe: string } } {
  const t = term.trim();
  return { "@like": { pred: t, swe: t } };
}

function vbetGameTitle(team1: string, team2: string) {
  return `${team1} - ${team2}`;
}

function isVbetSpecialEvent(team1: string, team2: string) {
  return /\bmanager\b|\bfantasy\b|special offer|\boutright\b|\bwinner\b|\bto win\b|\bgrupp\b|\bgroup\b|\bttv\b/i.test(
    `${team1} ${team2}`,
  );
}

function parseVbetGameSearchPayload(
  msg: unknown,
): Array<{ id: number; team1: string; team2: string; startTs?: number }> {
  const root = msg as {
    data?: {
      data?: {
        game?: Record<
          string,
          { id?: number; team1_name?: string; team2_name?: string; start_ts?: number }
        >;
      };
    };
  };
  const games = root?.data?.data?.game;
  if (!games || typeof games !== "object") return [];
  return Object.values(games)
    .map((g) => ({
      id: Number(g.id),
      team1: String(g.team1_name ?? "").trim(),
      team2: String(g.team2_name ?? "").trim(),
      startTs: typeof g.start_ts === "number" ? g.start_ts : undefined,
    }))
    .filter((g) => Number.isFinite(g.id) && g.team1.length > 0 && g.team2.length > 0)
    .filter((g) => !isVbetSpecialEvent(g.team1, g.team2));
}

function parseVbetMatchResultOdds(msg: unknown): { home: number; draw: number; away: number } | null {
  const root = msg as {
    data?: {
      data?: {
        market?: Record<
          string,
          {
            market_type?: string;
            display_key?: string;
            name?: string;
            event?: Record<string, { name?: string; price?: number; order?: number }>;
          }
        >;
      };
    };
  };
  const markets = root?.data?.data?.market;
  if (!markets || typeof markets !== "object") return null;

  const isMainThreeWay = (m: { market_type?: string; display_key?: string; name?: string }) => {
    const t = (m.market_type ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const dk = (m.display_key ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const nm = (m.name ?? "").toLowerCase();
    if (t === "matchresult" || t === "p1xp2" || t === "threeway" || t === "classicmatchresult") return true;
    if ((t.includes("winner") || t.includes("match")) && (t.includes("full") || t.includes("time"))) return true;
    if (dk.includes("matchresult") || dk.includes("1x2") || dk === "mw") return true;
    if (/\b1\s*[x×]\s*2\b/.test(nm) || nm.includes("fulltid") || nm.includes("match odds")) return true;
    return false;
  };

  for (const m of Object.values(markets)) {
    if (!isMainThreeWay(m)) continue;
    const events = m.event;
    if (!events || typeof events !== "object") continue;

    const triple = Object.values(events)
      .map((ev) => ({
        name: ev.name ?? "",
        price: ev.price,
        order: typeof ev.order === "number" ? ev.order : 999,
      }))
      .filter((ev) => typeof ev.price === "number" && ev.price > 1);

    if (triple.length === 3) {
      const hasUsableOrder = triple.some((ev) => ev.order < 100);
      if (hasUsableOrder) {
        triple.sort((a, b) => a.order - b.order);
        return { home: triple[0].price, draw: triple[1].price, away: triple[2].price };
      }
    }

    let home: number | undefined;
    let draw: number | undefined;
    let away: number | undefined;
    for (const ev of Object.values(events)) {
      const name = (ev.name ?? "").trim();
      const price = ev.price;
      if (typeof price !== "number" || !(price > 1)) continue;
      const n = name.toLowerCase();
      if (name === "W1" || name === "1" || n === "hemma" || n === "home") home = price;
      else if (name === "W2" || name === "2" || n === "borta" || n === "away") away = price;
      else if (name === "Oavgjort" || name === "Draw" || name === "X" || n === "lika" || n === "tie") draw = price;
    }
    if (home != null && draw != null && away != null) return { home, draw, away };
  }
  return null;
}

async function createVbetSwarmSocket(url: string): Promise<{
  send: (payload: string) => void;
  close: () => void;
  addOpenListener: (cb: () => void) => void;
  addMessageListener: (cb: (text: string) => void) => void;
  addErrorListener: (cb: () => void) => void;
}> {
  const GlobalWS = (globalThis as { WebSocket?: new (u: string) => WebSocket }).WebSocket;
  if (typeof GlobalWS === "function") {
    const ws = new GlobalWS(url);
    return {
      send: (payload) => ws.send(payload),
      close: () => ws.close(),
      addOpenListener: (cb) => ws.addEventListener("open", cb),
      addMessageListener: (cb) =>
        ws.addEventListener("message", (ev: MessageEvent) => {
          cb(String(ev.data));
        }),
      addErrorListener: (cb) => ws.addEventListener("error", () => cb()),
    };
  }
  const { default: WSNode } = await import("ws");
  const ws = new WSNode(url);
  return {
    send: (payload) => ws.send(payload),
    close: () => ws.close(),
    addOpenListener: (cb) => {
      ws.on("open", cb);
    },
    addMessageListener: (cb) => {
      ws.on("message", (data: string | Buffer) => {
        cb(typeof data === "string" ? data : data.toString("utf8"));
      });
    },
    addErrorListener: (cb) => {
      ws.on("error", () => cb());
    },
  };
}

async function withVbetSwarmSession<T>(
  siteId: number,
  releaseDate: string,
  run: (rpc: (cmd: { command: string; params: Record<string, unknown> }, rid: number) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const socket = await createVbetSwarmSocket(VBET_SWARM_WS);

  return await new Promise<T>((resolve, reject) => {
    let sessionReady = false;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
      reject(error);
    };

    const ok = (value: T) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
      resolve(value);
    };

    socket.addErrorListener(() => fail(new Error("VBET WebSocket error")));

    socket.addOpenListener(() => {
      socket.send(
        JSON.stringify({
          command: "request_session",
          params: {
            afec: "",
            source: 0,
            language: "swe",
            site_id: siteId,
            release_date: releaseDate,
          },
        }),
      );
    });

    socket.addMessageListener((text) => {
      let msg: { code?: number; rid?: number | string; msg?: string; data?: unknown };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (!sessionReady) {
        const sid = (msg.data as { sid?: string } | undefined)?.sid;
        if (msg.code === 0 && sid) {
          sessionReady = true;
          void (async () => {
            try {
              const rpc = async (cmd: { command: string; params: Record<string, unknown> }, rid: number) => {
                return await new Promise<unknown>((resolveRpc, rejectRpc) => {
                  const timer = setTimeout(() => {
                    pending.delete(rid);
                    rejectRpc(new Error("VBET swarm request timed out"));
                  }, 25000);
                  pending.set(rid, {
                    resolve: (v) => {
                      clearTimeout(timer);
                      resolveRpc(v);
                    },
                    reject: (e) => {
                      clearTimeout(timer);
                      rejectRpc(e);
                    },
                  });
                  socket.send(JSON.stringify({ rid, ...cmd }));
                });
              };

              const result = await run((cmd, rid) => rpc(cmd, rid));
              ok(result);
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          })();
        } else if (msg.code != null && msg.code !== 0) {
          fail(new Error(msg.msg || `VBET session failed (${msg.code})`));
        }
        return;
      }

      const ridRaw = msg.rid;
      const rid = typeof ridRaw === "string" ? Number.parseInt(ridRaw, 10) : Number(ridRaw);
      if (!Number.isFinite(rid) || rid === 0) return;

      const waiter = pending.get(rid);
      if (!waiter) return;

      pending.delete(rid);
      if (msg.code != null && msg.code !== 0) {
        waiter.reject(new Error(msg.msg || `VBET swarm error (${msg.code})`));
      } else {
        waiter.resolve(msg);
      }
    });
  });
}

type VbetGameCandidate = { id: number; team1: string; team2: string; startTs?: number; score: number };
type VbetRpc = (cmd: { command: string; params: Record<string, unknown> }, rid: number) => Promise<unknown>;

async function vbetSearchGames(rpc: VbetRpc, ridSeed: { value: number }, term: string, sportAlias?: string) {
  const where: Record<string, unknown> = {
    game: {
      "@node_limit": 120,
      "@or": [{ team1_name: vbetLikePredicate(term) }, { team2_name: vbetLikePredicate(term) }],
    },
  };
  if (sportAlias) where.sport = { alias: sportAlias };
  const resp = await rpc(
    {
      command: "get",
      params: {
        source: "betting",
        subscribe: true,
        what: { game: ["id", "team1_name", "team2_name", "start_ts"] },
        where,
      },
    },
    ridSeed.value++,
  );
  return parseVbetGameSearchPayload(resp);
}

function vbetUrlForGame(gameId: number) {
  return `https://www.vbet.se/sv/sport/prematch/4/Football/${gameId}`;
}

async function vbetFindBestMatchingGame(
  rpc: VbetRpc,
  ridSeed: { value: number },
  targetTitle: string,
  fallbackQuery: string,
  sportAlias = "Soccer",
): Promise<VbetGameCandidate | null> {
  let best: VbetGameCandidate | null = null;
  const seenIds = new Set<number>();
  const sportAliases = [...new Set([sportAlias, "Football", "Soccer", undefined])];

  for (const searchQueries of buildSmartSearchQueryGroups(targetTitle, fallbackQuery).map((group) => group.slice(0, 10))) {
    for (const rawQuery of searchQueries) {
      const term = rawQuery.trim();
      if (term.length < 3) continue;
      for (const alias of sportAliases) {
        let rows: Array<{ id: number; team1: string; team2: string; startTs?: number }>;
        try {
          rows = await vbetSearchGames(rpc, ridSeed, term, alias);
        } catch {
          continue;
        }
        for (const row of rows) {
          if (seenIds.has(row.id)) continue;
          seenIds.add(row.id);
          const title = vbetGameTitle(row.team1, row.team2);
          if (!isLikelySameMatch(title, targetTitle)) continue;
          const score = scoreTitleMatch(title, targetTitle);
          if (!best || score > best.score) best = { ...row, score };
        }
        if (best && best.score >= 3) break;
      }
      if (best && best.score >= 3) break;
    }
    if (best && best.score >= 2) break;
  }

  return best;
}

async function vbetFetchMatchResultOdds(rpc: VbetRpc, ridSeed: { value: number }, gameId: number) {
  const whereVariants: Array<Record<string, unknown>> = [
    { game: { id: gameId }, market: { market_type: "MatchResult" } },
    { game: { id: gameId }, market: { market_type: "matchresult" } },
    { game: { id: gameId } },
  ];
  for (const where of whereVariants) {
    const resp = await rpc(
      {
        command: "get",
        params: {
          source: "betting",
          what: {
            market: ["id", "name", "market_type", "display_key"],
            event: ["name", "price", "order"],
          },
          where,
        },
      },
      ridSeed.value++,
    );
    const odds = parseVbetMatchResultOdds(resp);
    if (odds) return odds;
  }
  return null;
}

async function discoverVbetMatchLinks(query: string): Promise<Array<{ title: string; url: string }>> {
  try {
    const { siteId, releaseDate } = await getVbetConfig();
    return await withVbetSwarmSession(siteId, releaseDate, async (rpc) => {
      const ridSeed = { value: 1 };
      const aggregated = new Map<number, { title: string; url: string; score: number; startTs?: number }>();

      const groups = buildSmartSearchQueryGroups(query).map((group) => group.slice(0, 6));
      for (const group of groups) {
        for (const rawQuery of group) {
          const term = rawQuery.trim();
          if (term.length < 3) continue;
          let rows: Array<{ id: number; team1: string; team2: string; startTs?: number }>;
          try {
            rows = await vbetSearchGames(rpc, ridSeed, term, "Soccer");
          } catch {
            continue;
          }
          for (const row of rows) {
            const title = vbetGameTitle(row.team1, row.team2);
            if (isAudienceMismatch(title, query)) continue;
            const score = scoreTitleMatch(title, query);
            if (score < 1) continue;
            const existing = aggregated.get(row.id);
            if (!existing || score > existing.score) {
              aggregated.set(row.id, {
                title,
                url: vbetUrlForGame(row.id),
                score,
                startTs: row.startTs,
              });
            }
          }
          if (aggregated.size >= 20) break;
        }
        if (aggregated.size > 0) break;
      }

      return [...aggregated.values()]
        .sort((a, b) => b.score - a.score || (a.startTs ?? 0) - (b.startTs ?? 0) || a.title.localeCompare(b.title))
        .slice(0, 20)
        .map(({ title, url }) => ({ title, url }));
    });
  } catch {
    return [];
  }
}

// ====================================================================
// VBET GitHub-cache-integration
// ====================================================================
//
// Render-IP är blockerad av Cloudflare WAF för www.vbet.se (HTTP 403 redan
// på conf.json-fetch). Lösning: GitHub Actions-workflow .github/workflows/
// vbet-fetch.yml kör scripts/fetch-vbet-github-action.mjs på Azure-runners
// och commit:ar data/vbet-rows.json. Render läser via GitHub API contents
// endpoint (raw fallback) — samma mönster som Pinnacle och ComeOn-gruppen.
//
// Live-fallback (befintlig getVbetConfig + withVbetSwarmSession) behålls:
// när cache saknar matchen används den ursprungliga vägen (failar tyst på
// Render med 403, fungerar lokalt under utveckling).

const VBET_DATA_FILE = path.resolve(process.cwd(), "data", "vbet-rows.json");
const VBET_GITHUB_API_URL =
  process.env.VBET_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/vbet-rows.json?ref=main";
const VBET_RAW_GITHUB_URL =
  process.env.VBET_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/vbet-rows.json";
const VBET_GITHUB_CACHE_TTL_MS = 60 * 1000;
const VBET_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const VBET_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;

type VbetCacheEvent = {
  gameId: number;
  title: string;
  homeTeam: string;
  awayTeam: string;
  startTs?: number;
  odds: { home: number; draw: number; away: number };
  foundBy?: string;
};
type VbetCachePayload = {
  updatedAt?: string | null;
  source?: string;
  queryStrategy?: string;
  queryLookaheadHours?: number;
  queryCount?: number;
  siteId?: number;
  events?: VbetCacheEvent[];
};

let vbetGithubInflight: Promise<VbetCachePayload | null> | null = null;
let vbetGithubCachedAt = 0;
let vbetGithubCachedPayload: VbetCachePayload | null = null;
let vbetLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchVbetFromGithub(): Promise<VbetCachePayload | null> {
  const now = Date.now();
  if (vbetGithubCachedPayload && now - vbetGithubCachedAt < VBET_GITHUB_CACHE_TTL_MS) {
    return vbetGithubCachedPayload;
  }
  if (vbetGithubInflight) return vbetGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<VbetCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(
          `[vbet-cache] ${label} HTTP ${response.status}${
            remaining ? ` (rate-limit remaining=${remaining})` : ""
          }`,
        );
        return null;
      }
      const data = (await response.json()) as VbetCachePayload;
      console.log(
        `[vbet-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, events=${
          data?.events?.length ?? 0
        })`,
      );
      return data;
    } catch (error) {
      console.warn(
        `[vbet-cache] ${label} fetch failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) {
      apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    let data = await tryFetch(VBET_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) {
      vbetLastFetchSource = "github-api";
    } else {
      data = await tryFetch(VBET_RAW_GITHUB_URL, "github-raw");
      if (data) vbetLastFetchSource = "github-raw";
    }
    if (data) {
      vbetGithubCachedPayload = data;
      vbetGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    vbetGithubInflight = null;
  });
  vbetGithubInflight = promise;
  return promise;
}

function loadVbetPayloadFromDisk(): VbetCachePayload | null {
  try {
    if (!fs.existsSync(VBET_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(VBET_DATA_FILE, "utf-8")) as VbetCachePayload;
    if (parsed?.source === "initial-empty") return null;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > VBET_DISK_MAX_AGE_MS) {
      console.warn(
        `[vbet-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn(
      "[vbet-cache] disk read failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function vbetPayloadAgeMs(payload: VbetCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

async function loadVbetPayloadWithMeta(): Promise<{
  payload: VbetCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  // Databas först — färsk DB-payload vinner, annars gamla disk/GitHub-vägen.
  const db = (await fetchOddsDbPayload("vbet-rows")) as VbetCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < VBET_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadVbetPayloadFromDisk();
  const diskAge = vbetPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < VBET_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchVbetFromGithub();
  if (fromGithub) {
    return {
      payload: fromGithub,
      source: vbetLastFetchSource === "github-raw" ? "github-raw" : "github-api",
    };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

function findVbetEventInCache(
  payload: VbetCachePayload | null,
  targetTitle: string,
): { event: VbetCacheEvent; score: number } | null {
  const events = payload?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  let best: { event: VbetCacheEvent; score: number } | null = null;
  for (const event of events) {
    const candidateTitle = event.title || `${event.homeTeam} - ${event.awayTeam}`;
    if (!candidateTitle) continue;
    if (!isLikelySameMatch(candidateTitle, targetTitle)) continue;
    const score = scoreTitleMatch(candidateTitle, targetTitle);
    if (!best || score > best.score) best = { event, score };
  }
  return best;
}

async function tryVbetFromGithubCache(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "vbet" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult | null> {
  let meta: Awaited<ReturnType<typeof loadVbetPayloadWithMeta>>;
  try {
    meta = await loadVbetPayloadWithMeta();
  } catch (error) {
    console.warn(
      "[vbet-cache] payload load crashed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const match = findVbetEventInCache(meta.payload, targetTitle);
  if (!match) return null;

  const sourceUrl = vbetUrlForGame(match.event.gameId);
  console.log(
    `[vbet-cache] ${spec.id}: hit (source=${meta.source}) gameId=${match.event.gameId} score=${match.score} title="${truncForLog(match.event.title, 80)}"`,
  );
  return makeBookmakerResult(spec, "found", {
    title: match.event.title,
    sourceUrl,
    home: match.event.odds.home,
    draw: match.event.odds.draw,
    away: match.event.odds.away,
  });
}

async function scrapeVbetBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "vbet" }>,
  targetTitle: string,
  fallbackQuery: string,
): Promise<BookmakerScrapeResult> {
  // Steg 1: GitHub-cache (workflow .github/workflows/vbet-fetch.yml).
  // På Render är detta enda fungerande väg — Cloudflare 403 på conf.json
  // gör att live-fallback nedan alltid misslyckas där.
  const cacheHit = await tryVbetFromGithubCache(spec, targetTitle);
  if (cacheHit) return cacheHit;

  // Steg 2: live-fallback. Fungerar lokalt under utveckling; faller tyst
  // på Render och resulterar i error/not_found med befintlig diagnostik.
  bookmakerDebugLog(
    `vbet:${spec.id}:cache:miss`,
    `[bookmaker-debug] vbet bookmaker=${spec.id} step=cache result=miss target=${truncForLog(targetTitle, 80)} — fallback till live-scrape`,
  );

  let stage = "init";
  try {
    stage = "config";
    const { siteId, releaseDate } = await getVbetConfig();
    stage = "swarm-session";
    return await withVbetSwarmSession(siteId, releaseDate, async (rpc) => {
      stage = "find-game";
      const ridSeed = { value: 1 };
      const best = await vbetFindBestMatchingGame(rpc, ridSeed, targetTitle, fallbackQuery);
      if (!best) {
        bookmakerDebugLog(
          `vbet:${spec.id}:find-game:not_found`,
          `[bookmaker-debug] vbet bookmaker=${spec.id} step=find-game result=not_found target=${truncForLog(targetTitle, 80)} fallback=${truncForLog(fallbackQuery, 80)}`,
        );
        return makeBookmakerResult(spec, "not_found", { error: "Match not found on VBET search" });
      }

      const matchTitle = vbetGameTitle(best.team1, best.team2);
      const sourceUrl = vbetUrlForGame(best.id);
      stage = "fetch-odds";
      const odds = await vbetFetchMatchResultOdds(rpc, ridSeed, best.id);
      if (!odds) {
        bookmakerDebugLog(
          `vbet:${spec.id}:fetch-odds:not_found`,
          `[bookmaker-debug] vbet bookmaker=${spec.id} step=fetch-odds result=not_found gameId=${best.id} matchTitle=${truncForLog(matchTitle, 80)}`,
        );
        return makeBookmakerResult(spec, "not_found", {
          title: matchTitle,
          sourceUrl,
          error: "1X2 (MatchResult) odds not found",
        });
      }

      stage = "align-row";
      const row = firstAlignedRow([{ bookmaker: spec.name, ...odds }], matchTitle, targetTitle);
      if (!row) {
        bookmakerDebugLog(
          `vbet:${spec.id}:align-row:not_found`,
          `[bookmaker-debug] vbet bookmaker=${spec.id} step=align-row result=not_found gameId=${best.id} matchTitle=${truncForLog(matchTitle, 80)} target=${truncForLog(targetTitle, 80)}`,
        );
        return makeBookmakerResult(spec, "not_found", {
          title: matchTitle,
          sourceUrl,
          error: "Found event did not match selected teams",
        });
      }

      return makeBookmakerResult(spec, "found", {
        title: matchTitle,
        sourceUrl,
        home: row.home,
        draw: row.draw,
        away: row.away,
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown VBET error";
    const errName = error instanceof Error ? error.name : "unknown";
    const stack = error instanceof Error && error.stack ? truncForLog(error.stack, 800) : "";
    bookmakerDebugLog(
      `vbet:${spec.id}:${stage}:exception`,
      `[bookmaker-debug] vbet bookmaker=${spec.id} step=${stage} result=exception errName=${errName} err="${truncForLog(msg, 200)}" stack="${stack}"`,
    );
    return makeBookmakerResult(spec, "error", {
      error: msg,
    });
  }
}

// ====================================================================
// Altenar GitHub-cache-integration (delas av DBET/MrVegas/MegaRiches)
// ====================================================================
//
// Bulk-API per integration returnerar ~500 events. Workflow:n .github/
// workflows/altenar-fetch.yml fetchar alla 3 integrationer var 15:e min
// och sparar i byIntegration-shape. cache-first via tryAltenarFromGithub-
// Cache. Live-fallback (fetchAltenarUpcoming → parseAltenarOneXTwo) finns
// kvar för match-not-in-cache och dev.

const ALTENAR_DATA_FILE = path.resolve(process.cwd(), "data", "altenar-rows.json");
const ALTENAR_GITHUB_API_URL =
  process.env.ALTENAR_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/altenar-rows.json?ref=main";
const ALTENAR_RAW_GITHUB_URL =
  process.env.ALTENAR_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/altenar-rows.json";
const ALTENAR_GITHUB_CACHE_TTL_MS = 60 * 1000;
const ALTENAR_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const ALTENAR_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
/** Cache max-age innan vi släpper igenom till on-demand fallback. */
const ALTENAR_CACHE_MAX_AGE_FOR_VALUEBETS_MS = 30 * 60 * 1000;

type AltenarCacheEvent = {
  eventId: string;
  title: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: string | null;
  league: string | null;
  odds: { home: number; draw: number; away: number };
};

type AltenarIntegrationCache = {
  displayName: string;
  updatedAt: string | null;
  events?: AltenarCacheEvent[];
  eventsCount?: number;
  skippedNoOdds?: number | null;
  rawEventsCount?: number | null;
  lastError?: string | null;
};

type AltenarCachePayload = {
  updatedAt?: string | null;
  source?: string;
  bookmaker?: string;
  displayName?: string;
  status?: string;
  totalEvents?: number;
  failedIntegrations?: number;
  durationMs?: number;
  byIntegration?: Record<string, AltenarIntegrationCache>;
};

let altenarGithubInflight: Promise<AltenarCachePayload | null> | null = null;
let altenarGithubCachedAt = 0;
let altenarGithubCachedPayload: AltenarCachePayload | null = null;
let altenarLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchAltenarFromGithub(): Promise<AltenarCachePayload | null> {
  const now = Date.now();
  if (altenarGithubCachedPayload && now - altenarGithubCachedAt < ALTENAR_GITHUB_CACHE_TTL_MS) {
    return altenarGithubCachedPayload;
  }
  if (altenarGithubInflight) return altenarGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<AltenarCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(
          `[altenar-cache] ${label} HTTP ${response.status}${remaining ? ` (rate-limit remaining=${remaining})` : ""}`,
        );
        return null;
      }
      const data = (await response.json()) as AltenarCachePayload;
      const total = data?.totalEvents ?? 0;
      console.log(
        `[altenar-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, total=${total})`,
      );
      return data;
    } catch (error) {
      console.warn(
        `[altenar-cache] ${label} fetch failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(ALTENAR_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) altenarLastFetchSource = "github-api";
    else {
      data = await tryFetch(ALTENAR_RAW_GITHUB_URL, "github-raw");
      if (data) altenarLastFetchSource = "github-raw";
    }
    if (data) {
      altenarGithubCachedPayload = data;
      altenarGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    altenarGithubInflight = null;
  });
  altenarGithubInflight = promise;
  return promise;
}

function loadAltenarPayloadFromDisk(): AltenarCachePayload | null {
  try {
    if (!fs.existsSync(ALTENAR_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(ALTENAR_DATA_FILE, "utf-8")) as AltenarCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > ALTENAR_DISK_MAX_AGE_MS) {
      console.warn(
        `[altenar-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn("[altenar-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function altenarPayloadAgeMs(payload: AltenarCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

async function loadAltenarPayloadWithMeta(): Promise<{
  payload: AltenarCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  // Databas först — färsk DB-payload vinner, annars gamla disk/GitHub-vägen.
  const db = (await fetchOddsDbPayload("altenar-rows")) as AltenarCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < ALTENAR_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadAltenarPayloadFromDisk();
  const diskAge = altenarPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < ALTENAR_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchAltenarFromGithub();
  if (fromGithub) {
    return {
      payload: fromGithub,
      source: altenarLastFetchSource === "github-raw" ? "github-raw" : "github-api",
    };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

/**
 * Försöker hitta matchen i Altenar-cachen för aktuell integration.
 * Använder samma title-matching som live-pipelinen (isLikelySameMatch +
 * scoreTitleMatch) för konsistens.
 */
function findAltenarEventInCache(
  payload: AltenarCachePayload | null,
  integrationKey: string,
  targetTitle: string,
): { event: AltenarCacheEvent; score: number } | null {
  const events = payload?.byIntegration?.[integrationKey]?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  let best: { event: AltenarCacheEvent; score: number } | null = null;
  for (const event of events) {
    const candidateTitle =
      event.title || (event.homeTeam && event.awayTeam ? `${event.homeTeam} - ${event.awayTeam}` : "");
    if (!candidateTitle) continue;
    if (!isLikelySameMatch(candidateTitle, targetTitle)) continue;
    const score = scoreTitleMatch(candidateTitle, targetTitle);
    if (!best || score > best.score) best = { event, score };
  }
  return best;
}

/**
 * Cache-first scrape-väg för Altenar-gruppen. Returnerar färdigt
 * BookmakerScrapeResult om matchen hittas + cache är inom max-age.
 * Annars null → caller faller tillbaka till live-scrape.
 */
async function tryAltenarFromGithubCache(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "altenar" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult | null> {
  let meta: Awaited<ReturnType<typeof loadAltenarPayloadWithMeta>>;
  try {
    meta = await loadAltenarPayloadWithMeta();
  } catch (error) {
    bookmakerDebugLog(
      `altenar:${spec.id}:cache:load-error`,
      `[bookmaker-debug] altenar bookmaker=${spec.id} step=cache result=load-error err=${truncForLog(error instanceof Error ? error.message : String(error), 150)}`,
    );
    return null;
  }
  const payload = meta.payload;
  if (!payload) {
    bookmakerDebugLog(
      `altenar:${spec.id}:cache:empty`,
      `[bookmaker-debug] altenar bookmaker=${spec.id} step=cache result=empty (no payload from ${meta.source})`,
    );
    return null;
  }

  // Policy: cache äldre än ALTENAR_CACHE_MAX_AGE_FOR_VALUEBETS_MS → låt
  // live-fallback ta över. Då blir on-demand "safety net" om workflow:n
  // hänger >30min, samtidigt som vi inte tappar coverage.
  const ageMs = altenarPayloadAgeMs(payload) ?? Infinity;
  if (ageMs > ALTENAR_CACHE_MAX_AGE_FOR_VALUEBETS_MS) {
    bookmakerDebugLog(
      `altenar:${spec.id}:cache:too-stale`,
      `[bookmaker-debug] altenar bookmaker=${spec.id} step=cache result=too-stale ageMin=${Math.round(ageMs / 60_000)} threshold=${ALTENAR_CACHE_MAX_AGE_FOR_VALUEBETS_MS / 60_000}min — fallback till live`,
    );
    return null;
  }

  const hit = findAltenarEventInCache(payload, spec.integration, targetTitle);
  if (!hit) {
    bookmakerDebugLog(
      `altenar:${spec.id}:cache:miss`,
      `[bookmaker-debug] altenar bookmaker=${spec.id} integration=${spec.integration} step=cache result=miss target=${truncForLog(targetTitle, 80)}`,
    );
    return null;
  }

  const sourceUrl = spec.sportsUrl;
  const row = firstAlignedRow(
    [{ bookmaker: spec.name, home: hit.event.odds.home, draw: hit.event.odds.draw, away: hit.event.odds.away }],
    hit.event.title,
    targetTitle,
  );
  if (!row) {
    return makeBookmakerResult(spec, "not_found", {
      title: hit.event.title,
      sourceUrl,
      error: "Cache hit but row alignment failed",
    });
  }
  bookmakerDebugLog(
    `altenar:${spec.id}:cache:hit`,
    `[bookmaker-debug] altenar bookmaker=${spec.id} integration=${spec.integration} step=cache result=hit score=${hit.score} title=${truncForLog(hit.event.title, 80)}`,
  );
  return makeBookmakerResult(spec, "found", {
    title: hit.event.title,
    sourceUrl,
    home: row.home,
    draw: row.draw,
    away: row.away,
  });
}

// ====================================================================
// Kambi (Unibet) GitHub-cache-integration
// ====================================================================
//
// Workflow:n .github/workflows/kambi-fetch.yml fetchar Unibet/Kambi listView
// per region var 10:e min och sparar i events[]-shape. cache-first via
// tryKambiFromGithubCache. Live-fallback (scrapeKambiBookmaker → discoverKambi-
// EventForTitle + parseOddsRowsFromKambiEvent) finns kvar för match-not-in-
// cache och dev.

const KAMBI_DATA_FILE = path.resolve(process.cwd(), "data", "kambi-rows.json");
const KAMBI_GITHUB_API_URL =
  process.env.KAMBI_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/kambi-rows.json?ref=main";
const KAMBI_RAW_GITHUB_URL =
  process.env.KAMBI_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/kambi-rows.json";
const KAMBI_GITHUB_CACHE_TTL_MS = 60 * 1000;
const KAMBI_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const KAMBI_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
/** Cache max-age innan vi släpper igenom till on-demand fallback. */
const KAMBI_CACHE_MAX_AGE_FOR_VALUEBETS_MS = 30 * 60 * 1000;

type KambiCacheEvent = {
  eventId: string;
  title: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: string | null;
  league: string | null;
  odds: { home: number; draw: number; away: number };
};

type KambiCachePayload = {
  updatedAt?: string | null;
  source?: string;
  bookmaker?: string;
  displayName?: string;
  group?: string;
  offering?: string;
  status?: string;
  events?: KambiCacheEvent[];
  uniqueEvents?: number;
  fetchedRegions?: number;
  failedRegions?: number;
  skippedNoOdds?: number;
  lastError?: string | null;
};

let kambiGithubInflight: Promise<KambiCachePayload | null> | null = null;
let kambiGithubCachedAt = 0;
let kambiGithubCachedPayload: KambiCachePayload | null = null;
let kambiLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchKambiFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (kambiGithubCachedPayload && now - kambiGithubCachedAt < KAMBI_GITHUB_CACHE_TTL_MS) {
    return kambiGithubCachedPayload;
  }
  if (kambiGithubInflight) return kambiGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(
          `[kambi-cache] ${label} HTTP ${response.status}${remaining ? ` (rate-limit remaining=${remaining})` : ""}`,
        );
        return null;
      }
      const data = (await response.json()) as KambiCachePayload;
      console.log(
        `[kambi-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, events=${data?.events?.length ?? 0})`,
      );
      return data;
    } catch (error) {
      console.warn(`[kambi-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(KAMBI_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) kambiLastFetchSource = "github-api";
    else {
      data = await tryFetch(KAMBI_RAW_GITHUB_URL, "github-raw");
      if (data) kambiLastFetchSource = "github-raw";
    }
    if (data) {
      kambiGithubCachedPayload = data;
      kambiGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    kambiGithubInflight = null;
  });
  kambiGithubInflight = promise;
  return promise;
}

function loadKambiPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(KAMBI_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(KAMBI_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > KAMBI_DISK_MAX_AGE_MS) {
      console.warn(
        `[kambi-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn("[kambi-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function kambiPayloadAgeMs(payload: KambiCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

async function loadKambiPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  // Databas först — färsk DB-payload vinner, annars gamla disk/GitHub-vägen.
  const db = (await fetchOddsDbPayload("kambi-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < KAMBI_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadKambiPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < KAMBI_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchKambiFromGithub();
  if (fromGithub) {
    return {
      payload: fromGithub,
      source: kambiLastFetchSource === "github-raw" ? "github-raw" : "github-api",
    };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

// ── ATG Sport (Kambi-plattform, offering=atg) ────────────────────────────────
// ATG Sport drivs av Kambi → IDENTISK payload-form som Unibet/Kambi (group "kambi").
// Återanvänder KambiCachePayload-typen; egen DB→disk→GitHub-fallback mot atg-rows.json.
const ATG_DATA_FILE = path.resolve(process.cwd(), "data", "atg-rows.json");
const ATG_GITHUB_API_URL =
  process.env.ATG_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/atg-rows.json?ref=main";
const ATG_RAW_GITHUB_URL =
  process.env.ATG_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/atg-rows.json";
const ATG_GITHUB_CACHE_TTL_MS = 60 * 1000;
const ATG_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const ATG_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
const ATG_CACHE_MAX_AGE_FOR_VALUEBETS_MS = 30 * 60 * 1000;

let atgGithubInflight: Promise<KambiCachePayload | null> | null = null;
let atgGithubCachedAt = 0;
let atgGithubCachedPayload: KambiCachePayload | null = null;
let atgLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchAtgFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (atgGithubCachedPayload && now - atgGithubCachedAt < ATG_GITHUB_CACHE_TTL_MS) {
    return atgGithubCachedPayload;
  }
  if (atgGithubInflight) return atgGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(`[atg-cache] ${label} HTTP ${response.status}${remaining ? ` (rate-limit remaining=${remaining})` : ""}`);
        return null;
      }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[atg-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[atg-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(ATG_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) atgLastFetchSource = "github-api";
    else {
      data = await tryFetch(ATG_RAW_GITHUB_URL, "github-raw");
      if (data) atgLastFetchSource = "github-raw";
    }
    if (data) {
      atgGithubCachedPayload = data;
      atgGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    atgGithubInflight = null;
  });
  atgGithubInflight = promise;
  return promise;
}

function loadAtgPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(ATG_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(ATG_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > ATG_DISK_MAX_AGE_MS) {
      console.warn(`[atg-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[atg-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadAtgPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("atg-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < ATG_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadAtgPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < ATG_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchAtgFromGithub();
  if (fromGithub) {
    return { payload: fromGithub, source: atgLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

// ── Svenska Spel / Oddset (Kambi-plattform, offering=svenskaspel) ─────────────
// Oddset drivs av Kambi (recon 2026-06-26) → IDENTISK payload-form som Unibet/ATG
// (group "kambi"). Egen DB→disk→GitHub-fallback mot svenskaspel-rows.json.
const SVENSKASPEL_DATA_FILE = path.resolve(process.cwd(), "data", "svenskaspel-rows.json");
const SVENSKASPEL_GITHUB_API_URL =
  process.env.SVENSKASPEL_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/svenskaspel-rows.json?ref=main";
const SVENSKASPEL_RAW_GITHUB_URL =
  process.env.SVENSKASPEL_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/svenskaspel-rows.json";
const SVENSKASPEL_GITHUB_CACHE_TTL_MS = 60 * 1000;
const SVENSKASPEL_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const SVENSKASPEL_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;

let svenskaspelGithubInflight: Promise<KambiCachePayload | null> | null = null;
let svenskaspelGithubCachedAt = 0;
let svenskaspelGithubCachedPayload: KambiCachePayload | null = null;
let svenskaspelLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchSvenskaspelFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (svenskaspelGithubCachedPayload && now - svenskaspelGithubCachedAt < SVENSKASPEL_GITHUB_CACHE_TTL_MS) {
    return svenskaspelGithubCachedPayload;
  }
  if (svenskaspelGithubInflight) return svenskaspelGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(`[svenskaspel-cache] ${label} HTTP ${response.status}${remaining ? ` (rate-limit remaining=${remaining})` : ""}`);
        return null;
      }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[svenskaspel-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[svenskaspel-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(SVENSKASPEL_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) svenskaspelLastFetchSource = "github-api";
    else {
      data = await tryFetch(SVENSKASPEL_RAW_GITHUB_URL, "github-raw");
      if (data) svenskaspelLastFetchSource = "github-raw";
    }
    if (data) {
      svenskaspelGithubCachedPayload = data;
      svenskaspelGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    svenskaspelGithubInflight = null;
  });
  svenskaspelGithubInflight = promise;
  return promise;
}

function loadSvenskaspelPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(SVENSKASPEL_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(SVENSKASPEL_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > SVENSKASPEL_DISK_MAX_AGE_MS) {
      console.warn(`[svenskaspel-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[svenskaspel-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadSvenskaspelPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("svenskaspel-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < SVENSKASPEL_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadSvenskaspelPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < SVENSKASPEL_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchSvenskaspelFromGithub();
  if (fromGithub) {
    return { payload: fromGithub, source: svenskaspelLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

// ── Coolbet (sbgate) ─────────────────────────────────────────────────────────
// Coolbet skrapas av en VPS-stealth-browser (scripts/fetch-coolbet-github-action.mjs)
// som joinar REST-katalog + pris-websocket → coolbet-rows.json med SAMMA events-form
// som ATG (KambiCachePayload-kompatibel: events[].odds.{home,draw,away,totals,ah}).
// Återanvänder därför KambiCachePayload-typen + samma DB→disk→GitHub-fallback.
const COOLBET_DATA_FILE = path.resolve(process.cwd(), "data", "coolbet-rows.json");
const COOLBET_GITHUB_API_URL =
  process.env.COOLBET_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/coolbet-rows.json?ref=main";
const COOLBET_RAW_GITHUB_URL =
  process.env.COOLBET_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/coolbet-rows.json";
const COOLBET_GITHUB_CACHE_TTL_MS = 60 * 1000;
const COOLBET_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const COOLBET_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;

let coolbetGithubInflight: Promise<KambiCachePayload | null> | null = null;
let coolbetGithubCachedAt = 0;
let coolbetGithubCachedPayload: KambiCachePayload | null = null;
let coolbetLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchCoolbetFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (coolbetGithubCachedPayload && now - coolbetGithubCachedAt < COOLBET_GITHUB_CACHE_TTL_MS) {
    return coolbetGithubCachedPayload;
  }
  if (coolbetGithubInflight) return coolbetGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(`[coolbet-cache] ${label} HTTP ${response.status}${remaining ? ` (rate-limit remaining=${remaining})` : ""}`);
        return null;
      }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[coolbet-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[coolbet-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(COOLBET_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) coolbetLastFetchSource = "github-api";
    else {
      data = await tryFetch(COOLBET_RAW_GITHUB_URL, "github-raw");
      if (data) coolbetLastFetchSource = "github-raw";
    }
    if (data) {
      coolbetGithubCachedPayload = data;
      coolbetGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    coolbetGithubInflight = null;
  });
  coolbetGithubInflight = promise;
  return promise;
}

function loadCoolbetPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(COOLBET_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(COOLBET_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > COOLBET_DISK_MAX_AGE_MS) {
      console.warn(`[coolbet-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[coolbet-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

// ── 888sport (Spectate) ───────────────────────────────────────────────────────
// 888sport-rows.json (Spectate prematch-1X2, KambiCachePayload-kompatibel) hämtas av
// .github/workflows/888sport-fetch.yml (Mullvad). Samma DB→disk→GitHub-fallback.
const S888_DATA_FILE = path.resolve(process.cwd(), "data", "888sport-rows.json");
const S888_GITHUB_API_URL =
  process.env.S888_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/888sport-rows.json?ref=main";
const S888_RAW_GITHUB_URL =
  process.env.S888_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/888sport-rows.json";
const S888_GITHUB_CACHE_TTL_MS = 60 * 1000;
const S888_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const S888_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
let s888GithubInflight: Promise<KambiCachePayload | null> | null = null;
let s888GithubCachedAt = 0;
let s888GithubCachedPayload: KambiCachePayload | null = null;
let s888LastFetchSource: "github-api" | "github-raw" | null = null;

async function fetch888FromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (s888GithubCachedPayload && now - s888GithubCachedAt < S888_GITHUB_CACHE_TTL_MS) return s888GithubCachedPayload;
  if (s888GithubInflight) return s888GithubInflight;
  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { headers: { "User-Agent": "matched-betting-render", ...extraHeaders }, signal: controller.signal });
      if (!response.ok) { console.warn(`[888sport-cache] ${label} HTTP ${response.status}`); return null; }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[888sport-cache] hämtade från ${label} (events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[888sport-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally { clearTimeout(timer); }
  };
  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(S888_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) s888LastFetchSource = "github-api";
    else { data = await tryFetch(S888_RAW_GITHUB_URL, "github-raw"); if (data) s888LastFetchSource = "github-raw"; }
    if (data) { s888GithubCachedPayload = data; s888GithubCachedAt = Date.now(); }
    return data;
  })().finally(() => { s888GithubInflight = null; });
  s888GithubInflight = promise;
  return promise;
}

function load888PayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(S888_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(S888_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > S888_DISK_MAX_AGE_MS) {
      console.warn(`[888sport-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[888sport-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function load888PayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("888sport-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < S888_PREFER_GITHUB_AFTER_MS) return { payload: db, source: "db" };
  const disk = load888PayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  if (disk && diskAge !== null && diskAge < S888_PREFER_GITHUB_AFTER_MS) return { payload: disk, source: "disk" };
  const fromGithub = await fetch888FromGithub();
  if (fromGithub) return { payload: fromGithub, source: s888LastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

// 888sport som BONUS-bookmaker: matcha candidate-titeln mot Spectate-cachen (1X2).
async function scrape888Bookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "spectate888" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult> {
  let meta: Awaited<ReturnType<typeof load888PayloadWithMeta>>;
  try { meta = await load888PayloadWithMeta(); }
  catch (error) { return makeBookmakerResult(spec, "error", { error: error instanceof Error ? error.message : "888sport payload load failed" }); }
  const match = findKambiEventInCache(meta.payload, targetTitle);
  if (!match) return makeBookmakerResult(spec, "not_found", { error: "Match not found in 888sport cache" });
  const o = match.event.odds;
  const title = match.event.title || `${match.event.homeTeam ?? ""} - ${match.event.awayTeam ?? ""}`.trim();
  if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) return makeBookmakerResult(spec, "not_found", { title, error: "1X2-odds saknas i 888sport-event" });
  return makeBookmakerResult(spec, "found", { title, home: o.home, draw: o.draw, away: o.away });
}

// ── ProntoSport (ABM/"Euro", DOM-skrapad) ────────────────────────────────────
// prontosport-rows.json (1X2, KambiCachePayload-kompatibel) via prontosport-fetch.yml.
const PRONTO_DATA_FILE = path.resolve(process.cwd(), "data", "prontosport-rows.json");
const PRONTO_GITHUB_API_URL =
  process.env.PRONTO_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/prontosport-rows.json?ref=main";
const PRONTO_RAW_GITHUB_URL =
  process.env.PRONTO_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/prontosport-rows.json";
const PRONTO_GITHUB_CACHE_TTL_MS = 60 * 1000;
const PRONTO_DISK_MAX_AGE_MS = 60 * 60 * 1000;
const PRONTO_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
let prontoGithubInflight: Promise<KambiCachePayload | null> | null = null;
let prontoGithubCachedAt = 0;
let prontoGithubCachedPayload: KambiCachePayload | null = null;
let prontoLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchProntoFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (prontoGithubCachedPayload && now - prontoGithubCachedAt < PRONTO_GITHUB_CACHE_TTL_MS) return prontoGithubCachedPayload;
  if (prontoGithubInflight) return prontoGithubInflight;
  const tryFetch = async (url: string, label: "github-api" | "github-raw", extraHeaders: Record<string, string> = {}): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { headers: { "User-Agent": "matched-betting-render", ...extraHeaders }, signal: controller.signal });
      if (!response.ok) { console.warn(`[prontosport-cache] ${label} HTTP ${response.status}`); return null; }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[prontosport-cache] hämtade från ${label} (events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[prontosport-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally { clearTimeout(timer); }
  };
  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(PRONTO_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) prontoLastFetchSource = "github-api";
    else { data = await tryFetch(PRONTO_RAW_GITHUB_URL, "github-raw"); if (data) prontoLastFetchSource = "github-raw"; }
    if (data) { prontoGithubCachedPayload = data; prontoGithubCachedAt = Date.now(); }
    return data;
  })().finally(() => { prontoGithubInflight = null; });
  prontoGithubInflight = promise;
  return promise;
}

function loadProntoPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(PRONTO_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(PRONTO_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > PRONTO_DISK_MAX_AGE_MS) {
      console.warn(`[prontosport-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[prontosport-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadProntoPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("prontosport-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < PRONTO_PREFER_GITHUB_AFTER_MS) return { payload: db, source: "db" };
  const disk = loadProntoPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  if (disk && diskAge !== null && diskAge < PRONTO_PREFER_GITHUB_AFTER_MS) return { payload: disk, source: "disk" };
  const fromGithub = await fetchProntoFromGithub();
  if (fromGithub) return { payload: fromGithub, source: prontoLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

async function scrapeProntoBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "prontosport" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult> {
  let meta: Awaited<ReturnType<typeof loadProntoPayloadWithMeta>>;
  try { meta = await loadProntoPayloadWithMeta(); }
  catch (error) { return makeBookmakerResult(spec, "error", { error: error instanceof Error ? error.message : "prontosport payload load failed" }); }
  const match = findKambiEventInCache(meta.payload, targetTitle);
  if (!match) return makeBookmakerResult(spec, "not_found", { error: "Match not found in prontosport cache" });
  const o = match.event.odds;
  const title = match.event.title || `${match.event.homeTeam ?? ""} - ${match.event.awayTeam ?? ""}`.trim();
  if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) return makeBookmakerResult(spec, "not_found", { title, error: "1X2-odds saknas i prontosport-event" });
  return makeBookmakerResult(spec, "found", { title, home: o.home, draw: o.draw, away: o.away });
}

// ── Tipwin (GP/NSoft offer/data via Scrapfly) ────────────────────────────────
// tipwin-rows.json (1X2+totals, KambiCachePayload-kompatibel) via tipwin-fetch.yml.
const TIPWIN_DATA_FILE = path.resolve(process.cwd(), "data", "tipwin-rows.json");
const TIPWIN_GITHUB_API_URL =
  process.env.TIPWIN_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/tipwin-rows.json?ref=main";
const TIPWIN_RAW_GITHUB_URL =
  process.env.TIPWIN_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/tipwin-rows.json";
const TIPWIN_GITHUB_CACHE_TTL_MS = 60 * 1000;
const TIPWIN_DISK_MAX_AGE_MS = 90 * 60 * 1000;
const TIPWIN_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
let tipwinGithubInflight: Promise<KambiCachePayload | null> | null = null;
let tipwinGithubCachedAt = 0;
let tipwinGithubCachedPayload: KambiCachePayload | null = null;
let tipwinLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchTipwinFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (tipwinGithubCachedPayload && now - tipwinGithubCachedAt < TIPWIN_GITHUB_CACHE_TTL_MS) return tipwinGithubCachedPayload;
  if (tipwinGithubInflight) return tipwinGithubInflight;
  const tryFetch = async (url: string, label: "github-api" | "github-raw", extraHeaders: Record<string, string> = {}): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { headers: { "User-Agent": "matched-betting-render", ...extraHeaders }, signal: controller.signal });
      if (!response.ok) { console.warn(`[tipwin-cache] ${label} HTTP ${response.status}`); return null; }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[tipwin-cache] hämtade från ${label} (events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[tipwin-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally { clearTimeout(timer); }
  };
  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(TIPWIN_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) tipwinLastFetchSource = "github-api";
    else { data = await tryFetch(TIPWIN_RAW_GITHUB_URL, "github-raw"); if (data) tipwinLastFetchSource = "github-raw"; }
    if (data) { tipwinGithubCachedPayload = data; tipwinGithubCachedAt = Date.now(); }
    return data;
  })().finally(() => { tipwinGithubInflight = null; });
  tipwinGithubInflight = promise;
  return promise;
}

function loadTipwinPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(TIPWIN_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(TIPWIN_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > TIPWIN_DISK_MAX_AGE_MS) {
      console.warn(`[tipwin-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[tipwin-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadTipwinPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("tipwin-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < TIPWIN_PREFER_GITHUB_AFTER_MS) return { payload: db, source: "db" };
  const disk = loadTipwinPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  if (disk && diskAge !== null && diskAge < TIPWIN_PREFER_GITHUB_AFTER_MS) return { payload: disk, source: "disk" };
  const fromGithub = await fetchTipwinFromGithub();
  if (fromGithub) return { payload: fromGithub, source: tipwinLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

async function scrapeTipwinBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "tipwin" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult> {
  let meta: Awaited<ReturnType<typeof loadTipwinPayloadWithMeta>>;
  try { meta = await loadTipwinPayloadWithMeta(); }
  catch (error) { return makeBookmakerResult(spec, "error", { error: error instanceof Error ? error.message : "tipwin payload load failed" }); }
  const match = findKambiEventInCache(meta.payload, targetTitle);
  if (!match) return makeBookmakerResult(spec, "not_found", { error: "Match not found in tipwin cache" });
  const o = match.event.odds;
  const title = match.event.title || `${match.event.homeTeam ?? ""} - ${match.event.awayTeam ?? ""}`.trim();
  if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) return makeBookmakerResult(spec, "not_found", { title, error: "1X2-odds saknas i tipwin-event" });
  return makeBookmakerResult(spec, "found", { title, home: o.home, draw: o.draw, away: o.away });
}

// ── 10bet (Playtech Vision DOM-skrap via Scrapfly) ───────────────────────────
// 10bet-rows.json (1X2, KambiCachePayload-kompatibel) via 10bet-fetch.yml.
const TENBET_DATA_FILE = path.resolve(process.cwd(), "data", "10bet-rows.json");
const TENBET_GITHUB_API_URL =
  process.env.TENBET_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/10bet-rows.json?ref=main";
const TENBET_RAW_GITHUB_URL =
  process.env.TENBET_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/10bet-rows.json";
const TENBET_GITHUB_CACHE_TTL_MS = 60 * 1000;
const TENBET_DISK_MAX_AGE_MS = 90 * 60 * 1000;
const TENBET_PREFER_GITHUB_AFTER_MS = 5 * 60 * 1000;
let tenbetGithubInflight: Promise<KambiCachePayload | null> | null = null;
let tenbetGithubCachedAt = 0;
let tenbetGithubCachedPayload: KambiCachePayload | null = null;
let tenbetLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchTenbetFromGithub(): Promise<KambiCachePayload | null> {
  const now = Date.now();
  if (tenbetGithubCachedPayload && now - tenbetGithubCachedAt < TENBET_GITHUB_CACHE_TTL_MS) return tenbetGithubCachedPayload;
  if (tenbetGithubInflight) return tenbetGithubInflight;
  const tryFetch = async (url: string, label: "github-api" | "github-raw", extraHeaders: Record<string, string> = {}): Promise<KambiCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { headers: { "User-Agent": "matched-betting-render", ...extraHeaders }, signal: controller.signal });
      if (!response.ok) { console.warn(`[10bet-cache] ${label} HTTP ${response.status}`); return null; }
      const data = (await response.json()) as KambiCachePayload;
      console.log(`[10bet-cache] hämtade från ${label} (events=${data?.events?.length ?? 0})`);
      return data;
    } catch (error) {
      console.warn(`[10bet-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally { clearTimeout(timer); }
  };
  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(TENBET_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) tenbetLastFetchSource = "github-api";
    else { data = await tryFetch(TENBET_RAW_GITHUB_URL, "github-raw"); if (data) tenbetLastFetchSource = "github-raw"; }
    if (data) { tenbetGithubCachedPayload = data; tenbetGithubCachedAt = Date.now(); }
    return data;
  })().finally(() => { tenbetGithubInflight = null; });
  tenbetGithubInflight = promise;
  return promise;
}

function loadTenbetPayloadFromDisk(): KambiCachePayload | null {
  try {
    if (!fs.existsSync(TENBET_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(TENBET_DATA_FILE, "utf-8")) as KambiCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > TENBET_DISK_MAX_AGE_MS) {
      console.warn(`[10bet-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`);
    }
    return parsed;
  } catch (error) {
    console.warn("[10bet-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadTenbetPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("10bet-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < TENBET_PREFER_GITHUB_AFTER_MS) return { payload: db, source: "db" };
  const disk = loadTenbetPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  if (disk && diskAge !== null && diskAge < TENBET_PREFER_GITHUB_AFTER_MS) return { payload: disk, source: "disk" };
  const fromGithub = await fetchTenbetFromGithub();
  if (fromGithub) return { payload: fromGithub, source: tenbetLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

async function scrapeTenbetBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "tenbet" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult> {
  let meta: Awaited<ReturnType<typeof loadTenbetPayloadWithMeta>>;
  try { meta = await loadTenbetPayloadWithMeta(); }
  catch (error) { return makeBookmakerResult(spec, "error", { error: error instanceof Error ? error.message : "10bet payload load failed" }); }
  const match = findKambiEventInCache(meta.payload, targetTitle);
  if (!match) return makeBookmakerResult(spec, "not_found", { error: "Match not found in 10bet cache" });
  const o = match.event.odds;
  const title = match.event.title || `${match.event.homeTeam ?? ""} - ${match.event.awayTeam ?? ""}`.trim();
  if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) return makeBookmakerResult(spec, "not_found", { title, error: "1X2-odds saknas i 10bet-event" });
  return makeBookmakerResult(spec, "found", { title, home: o.home, draw: o.draw, away: o.away });
}

async function loadCoolbetPayloadWithMeta(): Promise<{
  payload: KambiCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("coolbet-rows")) as KambiCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < COOLBET_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadCoolbetPayloadFromDisk();
  const diskAge = kambiPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < COOLBET_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchCoolbetFromGithub();
  if (fromGithub) {
    return { payload: fromGithub, source: coolbetLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

function findKambiEventInCache(
  payload: KambiCachePayload | null,
  targetTitle: string,
): { event: KambiCacheEvent; score: number } | null {
  const events = payload?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  let best: { event: KambiCacheEvent; score: number } | null = null;
  for (const event of events) {
    const candidateTitle =
      event.title || (event.homeTeam && event.awayTeam ? `${event.homeTeam} - ${event.awayTeam}` : "");
    if (!candidateTitle) continue;
    if (!isLikelySameMatch(candidateTitle, targetTitle)) continue;
    const score = scoreTitleMatch(candidateTitle, targetTitle);
    if (!best || score > best.score) best = { event, score };
  }
  return best;
}

/**
 * Coolbet (sbgate via Scrapfly) som BONUS-bookmaker för 1X2-valuebets + bonus-
 * optimeraren. Coolbet-payloaden (KambiCachePayload, samma form som ATG) bär redan
 * event.odds.{home,draw,away}; vi matchar candidate-titeln mot cachen (samma fuzzy-
 * matchning som Kambi). Ren cache-väg — ingen live-fallback behövs (skrapern fyller
 * coolbet-rows.json var 15:e min via GitHub Actions).
 */
async function scrapeCoolbetBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "coolbet" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult> {
  let meta: Awaited<ReturnType<typeof loadCoolbetPayloadWithMeta>>;
  try {
    meta = await loadCoolbetPayloadWithMeta();
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : "Coolbet payload load failed",
    });
  }
  const match = findKambiEventInCache(meta.payload, targetTitle);
  if (!match) return makeBookmakerResult(spec, "not_found", { error: "Match not found in Coolbet cache" });
  const o = match.event.odds;
  const title = match.event.title || `${match.event.homeTeam ?? ""} - ${match.event.awayTeam ?? ""}`.trim();
  if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) {
    return makeBookmakerResult(spec, "not_found", { title, error: "1X2-odds saknas i Coolbet-event" });
  }
  console.log(`[coolbet-cache] ${spec.id}: hit (source=${meta.source}) score=${match.score} title="${truncForLog(title, 80)}"`);
  return makeBookmakerResult(spec, "found", { title, home: o.home, draw: o.draw, away: o.away });
}

// Svenska Spel / Oddset (Kambi offering=svenskaspel) — egen rows-cache (egna odds,
// EJ Unibets) → cache-baserad 1X2-scrape precis som Coolbet (KambiCachePayload-form).
async function scrapeSvenskaspelBookmaker(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "svenskaspel" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult> {
  let meta: Awaited<ReturnType<typeof loadSvenskaspelPayloadWithMeta>>;
  try {
    meta = await loadSvenskaspelPayloadWithMeta();
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : "Svenska Spel payload load failed",
    });
  }
  const match = findKambiEventInCache(meta.payload, targetTitle);
  if (!match) return makeBookmakerResult(spec, "not_found", { error: "Match not found in Svenska Spel cache" });
  const o = match.event.odds;
  const title = match.event.title || `${match.event.homeTeam ?? ""} - ${match.event.awayTeam ?? ""}`.trim();
  if (!o || !(o.home > 1) || !(o.draw > 1) || !(o.away > 1)) {
    return makeBookmakerResult(spec, "not_found", { title, error: "1X2-odds saknas i Svenska Spel-event" });
  }
  console.log(`[svenskaspel-cache] ${spec.id}: hit (source=${meta.source}) score=${match.score} title="${truncForLog(title, 80)}"`);
  return makeBookmakerResult(spec, "found", { title, home: o.home, draw: o.draw, away: o.away });
}

/**
 * Cache-first scrape-väg för Kambi-gruppen (Unibet idag, fler offerings möjliga).
 * Returnerar färdigt BookmakerScrapeResult om matchen hittas + cache är inom
 * max-age. Annars null → caller faller tillbaka till live-scrape.
 */
async function tryKambiFromGithubCache(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "kambi" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult | null> {
  let meta: Awaited<ReturnType<typeof loadKambiPayloadWithMeta>>;
  try {
    meta = await loadKambiPayloadWithMeta();
  } catch (error) {
    bookmakerDebugLog(
      `kambi:${spec.id}:cache:load-error`,
      `[bookmaker-debug] kambi bookmaker=${spec.id} step=cache result=load-error err=${truncForLog(error instanceof Error ? error.message : String(error), 150)}`,
    );
    return null;
  }
  const payload = meta.payload;
  if (!payload) {
    bookmakerDebugLog(
      `kambi:${spec.id}:cache:empty`,
      `[bookmaker-debug] kambi bookmaker=${spec.id} step=cache result=empty (no payload from ${meta.source})`,
    );
    return null;
  }

  // Policy: cache äldre än KAMBI_CACHE_MAX_AGE_FOR_VALUEBETS_MS → låt
  // live-fallback ta över så vi inte serverar mossiga odds.
  const ageMs = kambiPayloadAgeMs(payload) ?? Infinity;
  if (ageMs > KAMBI_CACHE_MAX_AGE_FOR_VALUEBETS_MS) {
    bookmakerDebugLog(
      `kambi:${spec.id}:cache:too-stale`,
      `[bookmaker-debug] kambi bookmaker=${spec.id} step=cache result=too-stale ageMin=${Math.round(ageMs / 60_000)} threshold=${KAMBI_CACHE_MAX_AGE_FOR_VALUEBETS_MS / 60_000}min — fallback till live`,
    );
    return null;
  }

  const hit = findKambiEventInCache(payload, targetTitle);
  if (!hit) {
    bookmakerDebugLog(
      `kambi:${spec.id}:cache:miss`,
      `[bookmaker-debug] kambi bookmaker=${spec.id} offering=${spec.offering} step=cache result=miss target=${truncForLog(targetTitle, 80)}`,
    );
    return null;
  }

  const sourceUrl = `${spec.origin}${spec.eventPath}/${hit.event.eventId}`;
  const row = firstAlignedRow(
    [{ bookmaker: spec.name, home: hit.event.odds.home, draw: hit.event.odds.draw, away: hit.event.odds.away }],
    hit.event.title,
    targetTitle,
  );
  if (!row) {
    return makeBookmakerResult(spec, "not_found", {
      title: hit.event.title,
      sourceUrl,
      error: "Cache hit but row alignment failed",
    });
  }
  bookmakerDebugLog(
    `kambi:${spec.id}:cache:hit`,
    `[bookmaker-debug] kambi bookmaker=${spec.id} step=cache result=hit score=${hit.score} title=${truncForLog(hit.event.title, 80)}`,
  );
  return makeBookmakerResult(spec, "found", {
    title: hit.event.title,
    sourceUrl,
    home: row.home,
    draw: row.draw,
    away: row.away,
  });
}

// ====================================================================
// Paf-brand prewarm cache (X3000 / Golden Bull / 1x2 / Speedybet)
// ====================================================================
//
// Workflow .github/workflows/paf-brand-fetch.yml kör ~47 strategiska queries
// per brand var 20:e min och sparar deduperade events i byBrand-shape.
// Search-based → "prewarm cache" (inte full cache). Cache-miss → live-
// fallback i scrapePafBrandBookmaker (samma endpoint men smart per-match-
// search).
//
// Brand-keys i payload:
//   x3000        → X3000 (BOOKMAKER_SCRAPERS.id)
//   goldenbull   → Golden Bull
//   oneTwo       → 1x2
//   speedybet    → Speedybet

const PAF_BRAND_DATA_FILE = path.resolve(process.cwd(), "data", "paf-brand-rows.json");
const PAF_BRAND_GITHUB_API_URL =
  process.env.PAF_BRAND_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/paf-brand-rows.json?ref=main";
const PAF_BRAND_RAW_GITHUB_URL =
  process.env.PAF_BRAND_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/paf-brand-rows.json";
const PAF_BRAND_GITHUB_CACHE_TTL_MS = 60 * 1000;
const PAF_BRAND_DISK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const PAF_BRAND_PREFER_GITHUB_AFTER_MS = 10 * 60 * 1000;
const PAF_BRAND_CACHE_MAX_AGE_FOR_VALUEBETS_MS = 60 * 60 * 1000;

/** BOOKMAKER_SCRAPERS.id → byBrand-nyckel i cachen. */
const PAF_BRAND_ID_TO_KEY: Record<string, string> = {
  x3000: "x3000",
  goldenbull: "goldenbull",
  "1x2": "oneTwo",
  speedybet: "speedybet",
};

type PafBrandCacheEvent = {
  eventId: string;
  title: string;
  homeTeam: string | null;
  awayTeam: string | null;
  startTime: string | null;
  league: string | null;
  odds: { home: number; draw: number; away: number };
  matchedQuery?: string;
};

type PafBrandCacheBrand = {
  displayName: string;
  baseUrl: string;
  updatedAt: string | null;
  queriesTried?: number;
  queriesSucceeded?: number;
  queriesFailed?: number;
  eventsFound?: number;
  durationMs?: number;
  events?: PafBrandCacheEvent[];
  lastError?: string | null;
};

type PafBrandCachePayload = {
  updatedAt?: string | null;
  source?: string;
  bookmaker?: string;
  displayName?: string;
  cacheType?: string;
  status?: string;
  queryCount?: number;
  totalEvents?: number;
  brandsFailed?: number;
  brandsFetched?: number;
  note?: string;
  byBrand?: Record<string, PafBrandCacheBrand>;
};

let pafBrandGithubInflight: Promise<PafBrandCachePayload | null> | null = null;
let pafBrandGithubCachedAt = 0;
let pafBrandGithubCachedPayload: PafBrandCachePayload | null = null;
let pafBrandLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchPafBrandFromGithub(): Promise<PafBrandCachePayload | null> {
  const now = Date.now();
  if (pafBrandGithubCachedPayload && now - pafBrandGithubCachedAt < PAF_BRAND_GITHUB_CACHE_TTL_MS) {
    return pafBrandGithubCachedPayload;
  }
  if (pafBrandGithubInflight) return pafBrandGithubInflight;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<PafBrandCachePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "matched-betting-render", ...extraHeaders },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        console.warn(
          `[paf-brand-cache] ${label} HTTP ${response.status}${remaining ? ` (rate-limit remaining=${remaining})` : ""}`,
        );
        return null;
      }
      const data = (await response.json()) as PafBrandCachePayload;
      console.log(
        `[paf-brand-cache] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"}, total=${data?.totalEvents ?? 0})`,
      );
      return data;
    } catch (error) {
      console.warn(`[paf-brand-cache] ${label} fetch failed:`, error instanceof Error ? error.message : error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(PAF_BRAND_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) pafBrandLastFetchSource = "github-api";
    else {
      data = await tryFetch(PAF_BRAND_RAW_GITHUB_URL, "github-raw");
      if (data) pafBrandLastFetchSource = "github-raw";
    }
    if (data) {
      pafBrandGithubCachedPayload = data;
      pafBrandGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    pafBrandGithubInflight = null;
  });
  pafBrandGithubInflight = promise;
  return promise;
}

function loadPafBrandPayloadFromDisk(): PafBrandCachePayload | null {
  try {
    if (!fs.existsSync(PAF_BRAND_DATA_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(PAF_BRAND_DATA_FILE, "utf-8")) as PafBrandCachePayload;
    const updatedMs = parsed?.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (Number.isFinite(updatedMs) && updatedMs > 0 && Date.now() - updatedMs > PAF_BRAND_DISK_MAX_AGE_MS) {
      console.warn(
        `[paf-brand-cache] disk är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå`,
      );
    }
    return parsed;
  } catch (error) {
    console.warn("[paf-brand-cache] disk read failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

function pafBrandPayloadAgeMs(payload: PafBrandCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

async function loadPafBrandPayloadWithMeta(): Promise<{
  payload: PafBrandCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  // Databas först — färsk DB-payload vinner, annars gamla disk/GitHub-vägen.
  const db = (await fetchOddsDbPayload("paf-brand-rows")) as PafBrandCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < PAF_BRAND_PREFER_GITHUB_AFTER_MS) {
    return { payload: db, source: "db" };
  }
  const disk = loadPafBrandPayloadFromDisk();
  const diskAge = pafBrandPayloadAgeMs(disk);
  const diskFresh = diskAge !== null && diskAge < PAF_BRAND_PREFER_GITHUB_AFTER_MS;
  if (disk && diskFresh) return { payload: disk, source: "disk" };

  const fromGithub = await fetchPafBrandFromGithub();
  if (fromGithub) {
    return {
      payload: fromGithub,
      source: pafBrandLastFetchSource === "github-raw" ? "github-raw" : "github-api",
    };
  }
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

function findPafBrandEventInCache(
  payload: PafBrandCachePayload | null,
  brandKey: string,
  targetTitle: string,
): { event: PafBrandCacheEvent; score: number } | null {
  const events = payload?.byBrand?.[brandKey]?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  let best: { event: PafBrandCacheEvent; score: number } | null = null;
  for (const event of events) {
    const candidateTitle =
      event.title || (event.homeTeam && event.awayTeam ? `${event.homeTeam} - ${event.awayTeam}` : "");
    if (!candidateTitle) continue;
    if (!isLikelySameMatch(candidateTitle, targetTitle)) continue;
    const score = scoreTitleMatch(candidateTitle, targetTitle);
    if (!best || score > best.score) best = { event, score };
  }
  return best;
}

/**
 * Cache-first scrape-väg för Paf-brand. Returnerar färdigt BookmakerScrape-
 * Result om matchen hittas inom 60min max-age. Annars null → live-fallback
 * (smart per-match-search) tar över. Det här är viktigt för Paf-brand
 * eftersom prewarm-cachen INTE är full coverage — många obscure ligor
 * faller utanför query-listan.
 */
async function tryPafBrandFromGithubCache(
  spec: Extract<(typeof BOOKMAKER_SCRAPERS)[number], { group: "paf-brand" }>,
  targetTitle: string,
): Promise<BookmakerScrapeResult | null> {
  const brandKey = PAF_BRAND_ID_TO_KEY[spec.id];
  if (!brandKey) return null;

  let meta: Awaited<ReturnType<typeof loadPafBrandPayloadWithMeta>>;
  try {
    meta = await loadPafBrandPayloadWithMeta();
  } catch (error) {
    bookmakerDebugLog(
      `paf-brand:${spec.id}:cache:load-error`,
      `[bookmaker-debug] paf-brand bookmaker=${spec.id} step=cache result=load-error err=${truncForLog(error instanceof Error ? error.message : String(error), 150)}`,
    );
    return null;
  }
  const payload = meta.payload;
  if (!payload) {
    bookmakerDebugLog(
      `paf-brand:${spec.id}:cache:empty`,
      `[bookmaker-debug] paf-brand bookmaker=${spec.id} step=cache result=empty (no payload from ${meta.source})`,
    );
    return null;
  }

  const ageMs = pafBrandPayloadAgeMs(payload) ?? Infinity;
  if (ageMs > PAF_BRAND_CACHE_MAX_AGE_FOR_VALUEBETS_MS) {
    bookmakerDebugLog(
      `paf-brand:${spec.id}:cache:too-stale`,
      `[bookmaker-debug] paf-brand bookmaker=${spec.id} step=cache result=too-stale ageMin=${Math.round(ageMs / 60_000)} threshold=${PAF_BRAND_CACHE_MAX_AGE_FOR_VALUEBETS_MS / 60_000}min — fallback till live-search`,
    );
    return null;
  }

  const hit = findPafBrandEventInCache(payload, brandKey, targetTitle);
  if (!hit) {
    bookmakerDebugLog(
      `paf-brand:${spec.id}:cache:miss`,
      `[bookmaker-debug] paf-brand bookmaker=${spec.id} brandKey=${brandKey} step=cache result=miss (likely outside prewarm queries) target=${truncForLog(targetTitle, 80)}`,
    );
    return null;
  }

  const sourceUrl = `${spec.origin}${spec.eventPath}/${hit.event.eventId}`;
  const row = firstAlignedRow(
    [{ bookmaker: spec.name, home: hit.event.odds.home, draw: hit.event.odds.draw, away: hit.event.odds.away }],
    hit.event.title,
    targetTitle,
  );
  if (!row) {
    return makeBookmakerResult(spec, "not_found", {
      title: hit.event.title,
      sourceUrl,
      error: "Cache hit but row alignment failed",
    });
  }
  bookmakerDebugLog(
    `paf-brand:${spec.id}:cache:hit`,
    `[bookmaker-debug] paf-brand bookmaker=${spec.id} brandKey=${brandKey} step=cache result=hit score=${hit.score} matchedQuery=${hit.event.matchedQuery ?? "?"} title=${truncForLog(hit.event.title, 80)}`,
  );
  return makeBookmakerResult(spec, "found", {
    title: hit.event.title,
    sourceUrl,
    home: row.home,
    draw: row.draw,
    away: row.away,
  });
}

// ── Smarkets (betting-börs) — loader ───────────────────────────────────────
// Öppet API, fil-baserad källa (smarkets-fetch.yml). Payloaden bär footballRows
// + tennisRows med RÅ back-odds (odds) + lay-odds (layOdds) + commission.
const SMARKETS_DATA_FILE = path.resolve(process.cwd(), "data", "smarkets-rows.json");
const SMARKETS_GITHUB_API_URL =
  process.env.SMARKETS_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/smarkets-rows.json?ref=main";
const SMARKETS_RAW_GITHUB_URL =
  process.env.SMARKETS_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/smarkets-rows.json";
const SMARKETS_GITHUB_CACHE_TTL_MS = 30 * 1000;
const SMARKETS_PREFER_GITHUB_AFTER_MS = 3 * 60 * 1000;

type SmarketsOddsTriple = { home: number; draw?: number | null; away: number };
type SmarketsRow = {
  eventId: string;
  sport?: string;
  league?: string | null;
  homeTeam: string;
  awayTeam: string;
  title: string;
  startTime: string;
  odds: SmarketsOddsTriple;
  layOdds?: { home: number | null; draw?: number | null; away: number | null };
};
type SmarketsCachePayload = {
  updatedAt?: string | null;
  source?: string;
  bookmaker?: string;
  displayName?: string;
  isExchange?: boolean;
  commission?: number;
  blocked?: boolean;
  lastError?: string | null;
  countsBySport?: Record<string, number>;
  rows?: SmarketsRow[];        // ALLA sporter (varje rad bär .sport)
  footballRows?: SmarketsRow[]; // bakåtkompat
  tennisRows?: SmarketsRow[];   // bakåtkompat
};

/** Alla Smarkets-rader oavsett payload-version (ny `rows` eller äldre per-sport). */
function smarketsAllRows(p: SmarketsCachePayload | null | undefined): SmarketsRow[] {
  if (!p) return [];
  if (Array.isArray(p.rows) && p.rows.length) return p.rows;
  return [...(p.footballRows ?? []), ...(p.tennisRows ?? [])];
}

let smarketsGithubInflight: Promise<SmarketsCachePayload | null> | null = null;
let smarketsGithubCachedAt = 0;
let smarketsGithubCachedPayload: SmarketsCachePayload | null = null;
let smarketsLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchSmarketsFromGithub(): Promise<SmarketsCachePayload | null> {
  const now = Date.now();
  if (smarketsGithubCachedPayload && now - smarketsGithubCachedAt < SMARKETS_GITHUB_CACHE_TTL_MS) {
    return smarketsGithubCachedPayload;
  }
  if (smarketsGithubInflight) return smarketsGithubInflight;
  const tryFetch = async (url: string, label: "github-api" | "github-raw", extra: Record<string, string> = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "matched-betting-render", ...extra }, signal: controller.signal });
      if (!r.ok) { console.warn(`[smarkets-cache] ${label} HTTP ${r.status}`); return null; }
      return (await r.json()) as SmarketsCachePayload;
    } catch (e) {
      console.warn(`[smarkets-cache] ${label} failed:`, e instanceof Error ? e.message : e);
      return null;
    } finally { clearTimeout(timer); }
  };
  const promise = (async () => {
    const apiHeaders: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
    if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    let data = await tryFetch(SMARKETS_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) smarketsLastFetchSource = "github-api";
    else { data = await tryFetch(SMARKETS_RAW_GITHUB_URL, "github-raw"); if (data) smarketsLastFetchSource = "github-raw"; }
    if (data) { smarketsGithubCachedPayload = data; smarketsGithubCachedAt = Date.now(); }
    return data;
  })().finally(() => { smarketsGithubInflight = null; });
  smarketsGithubInflight = promise;
  return promise;
}

function loadSmarketsFromDisk(): SmarketsCachePayload | null {
  try {
    if (!fs.existsSync(SMARKETS_DATA_FILE)) return null;
    return JSON.parse(fs.readFileSync(SMARKETS_DATA_FILE, "utf-8")) as SmarketsCachePayload;
  } catch (e) {
    console.warn("[smarkets-cache] disk read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

function smarketsPayloadAgeMs(payload: SmarketsCachePayload | null): number | null {
  if (!payload?.updatedAt) return null;
  const ms = Date.parse(payload.updatedAt);
  return Number.isFinite(ms) && ms > 0 ? Date.now() - ms : null;
}

async function loadSmarketsPayloadWithMeta(): Promise<{
  payload: SmarketsCachePayload | null;
  source: "db" | "disk" | "github-api" | "github-raw" | "empty";
}> {
  const db = (await fetchOddsDbPayload("smarkets-rows")) as SmarketsCachePayload | null;
  const dbAge = oddsDbPayloadAgeMs(db);
  if (db && dbAge !== null && dbAge < SMARKETS_PREFER_GITHUB_AFTER_MS) return { payload: db, source: "db" };
  const disk = loadSmarketsFromDisk();
  const diskAge = smarketsPayloadAgeMs(disk);
  if (disk && diskAge !== null && diskAge < SMARKETS_PREFER_GITHUB_AFTER_MS) return { payload: disk, source: "disk" };
  const fromGithub = await fetchSmarketsFromGithub();
  if (fromGithub) return { payload: fromGithub, source: smarketsLastFetchSource === "github-raw" ? "github-raw" : "github-api" };
  if (disk) return { payload: disk, source: "disk" };
  return { payload: null, source: "empty" };
}

async function scrapeBookmakerForMatch(
  spec: (typeof BOOKMAKER_SCRAPERS)[number],
  targetTitle: string,
  fallbackQuery: string,
): Promise<BookmakerScrapeResult> {
  const health = bookmakerSourceHealth.get(spec.id);
  if (health && health.blockedUntil > Date.now()) {
    const cached = lastGoodBookmakerResult(spec, targetTitle, health.lastError);
    if (cached) return cached;
  }

  let result: BookmakerScrapeResult;
  if (spec.group === "kambi") result = await scrapeKambiBookmaker(spec, targetTitle);
  else if (spec.group === "paf-brand") result = await scrapePafBrandBookmaker(spec, targetTitle, fallbackQuery);
  else if (spec.group === "altenar") result = await scrapeAltenarBookmaker(spec, targetTitle, fallbackQuery);
  else if (spec.group === "comeon") result = await scrapeComeOnBookmaker(spec, targetTitle, fallbackQuery);
  else if (spec.group === "betsson") result = await scrapeBetssonBookmaker(spec, targetTitle, fallbackQuery);
  else if (spec.group === "vbet") result = await scrapeVbetBookmaker(spec, targetTitle, fallbackQuery);
  else if (spec.group === "coolbet") result = await scrapeCoolbetBookmaker(spec, targetTitle);
  else if (spec.group === "svenskaspel") result = await scrapeSvenskaspelBookmaker(spec, targetTitle);
  else if (spec.group === "spectate888") result = await scrape888Bookmaker(spec, targetTitle);
  else if (spec.group === "prontosport") result = await scrapeProntoBookmaker(spec, targetTitle);
  else if (spec.group === "tipwin") result = await scrapeTipwinBookmaker(spec, targetTitle);
  else if (spec.group === "tenbet") result = await scrapeTenbetBookmaker(spec, targetTitle);
  else {
    result = makeBookmakerResult(spec, "blocked", {
      error: "Separate scraper not implemented for this bookmaker yet",
    });
  }

  if (isCompleteFoundResult(result)) {
    rememberLastGoodBookmakerResult(spec, targetTitle, result);
    bookmakerSourceHealth.delete(spec.id);
    return result;
  }

  if (result.status === "blocked" || result.status === "error") {
    bookmakerSourceHealth.set(spec.id, {
      blockedUntil: Date.now() + BOOKMAKER_SOURCE_BACKOFF_MS,
      lastError: result.error ?? result.status,
    });
    return lastGoodBookmakerResult(spec, targetTitle, result.error ?? result.status) ?? result;
  }

  if (result.status === "not_found" && spec.group === "betsson") {
    return lastGoodBookmakerResult(spec, targetTitle, result.error ?? result.status) ?? result;
  }

  return result;
}

const BOOKMAKER_MATCH_CACHE_TTL_MS = 15 * 60 * 1000;
const LAST_GOOD_BOOKMAKER_ODDS_TTL_MS = 6 * 60 * 60 * 1000;
const BOOKMAKER_SOURCE_BACKOFF_MS = 15 * 60 * 1000;
const bookmakerMatchCache = new Map<string, { expiresAt: number; promise: Promise<BookmakerScrapeResult[]> }>();
const lastGoodBookmakerOddsCache = new Map<
  string,
  { expiresAt: number; cachedAt: number; result: BookmakerScrapeResult }
>();
const bookmakerSourceHealth = new Map<string, { blockedUntil: number; lastError: string }>();

function lastGoodBookmakerOddsFile() {
  return path.join(BONUS_CACHE_DIR, "last-good-bookmaker-odds.json");
}

let lastGoodBookmakerOddsLoaded = false;

function loadLastGoodBookmakerOddsFromDisk() {
  if (lastGoodBookmakerOddsLoaded) return;
  lastGoodBookmakerOddsLoaded = true;
  try {
    const file = lastGoodBookmakerOddsFile();
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Array<[
      string,
      { expiresAt: number; cachedAt: number; result: BookmakerScrapeResult },
    ]>;
    for (const [key, value] of parsed) {
      if (value.expiresAt > Date.now()) lastGoodBookmakerOddsCache.set(key, value);
    }
  } catch (error) {
    console.warn("[last-good-odds] disk read failed", error);
  }
}

function writeLastGoodBookmakerOddsToDisk() {
  try {
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    const entries = [...lastGoodBookmakerOddsCache.entries()].filter(([, value]) => value.expiresAt > Date.now());
    fs.writeFileSync(lastGoodBookmakerOddsFile(), JSON.stringify(entries), "utf-8");
  } catch (error) {
    console.warn("[last-good-odds] disk write failed", error);
  }
}

function normalizeScrapeCacheTitle(title: string) {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

function bookmakerResultCacheKey(bookmakerId: string, targetTitle: string) {
  return `${bookmakerId}::${normalizeScrapeCacheTitle(targetTitle)}`;
}

function isCompleteFoundResult(
  result: BookmakerScrapeResult,
): result is BookmakerScrapeResult & { home: number; draw: number; away: number } {
  return result.status === "found" && result.home != null && result.draw != null && result.away != null;
}

function rememberLastGoodBookmakerResult(
  spec: (typeof BOOKMAKER_SCRAPERS)[number],
  targetTitle: string,
  result: BookmakerScrapeResult,
) {
  loadLastGoodBookmakerOddsFromDisk();
  lastGoodBookmakerOddsCache.set(bookmakerResultCacheKey(spec.id, targetTitle), {
    expiresAt: Date.now() + LAST_GOOD_BOOKMAKER_ODDS_TTL_MS,
    cachedAt: Date.now(),
    result: { ...result, stale: false, cachedAt: undefined },
  });
  writeLastGoodBookmakerOddsToDisk();
}

function lastGoodBookmakerResult(
  spec: (typeof BOOKMAKER_SCRAPERS)[number],
  targetTitle: string,
  reason: string,
): BookmakerScrapeResult | null {
  loadLastGoodBookmakerOddsFromDisk();
  const cached = lastGoodBookmakerOddsCache.get(bookmakerResultCacheKey(spec.id, targetTitle));
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return {
    ...cached.result,
    stale: true,
    cachedAt: new Date(cached.cachedAt).toISOString(),
    error: `Använder senast lyckade odds efter fel: ${reason}`,
  };
}

function applySameOddsFallbacks(results: BookmakerScrapeResult[]) {
  const byId = new Map(results.map((result) => [result.bookmakerId, result]));
  const specsById = new Map(BOOKMAKER_SCRAPERS.map((spec) => [spec.id, spec]));

  for (const group of SAME_ODDS_FALLBACK_GROUPS) {
    const sources = group
      .map((id) => byId.get(id))
      .filter((result): result is BookmakerScrapeResult & { home: number; draw: number; away: number } =>
        Boolean(result && isCompleteFoundResult(result)),
      )
      .sort((a, b) => Number(Boolean(a.stale)) - Number(Boolean(b.stale)));

    const source = sources[0];
    if (!source) continue;

    for (const targetId of group) {
      const current = byId.get(targetId);
      if (!current || isCompleteFoundResult(current)) continue;
      const incompleteFound = current.status === "found" && !isCompleteFoundResult(current);
      if (
        current.status !== "blocked" &&
        current.status !== "error" &&
        current.status !== "not_found" &&
        !incompleteFound
      )
        continue;

      const targetSpec = specsById.get(targetId);
      if (!targetSpec) continue;

      const reason =
        current.status === "not_found"
          ? `matchen hittades inte (${current.error ?? "not_found"})`
          : incompleteFound
            ? `saknade giltig 1X2 (${current.error ?? "ofullständiga odds"})`
            : (current.error ?? current.status);
      byId.set(targetId, {
        ...source,
        bookmakerId: targetSpec.id,
        bookmaker: targetSpec.name,
        status: "found",
        mirroredFromBookmakerId: source.bookmakerId,
        mirroredFromBookmaker: source.bookmaker,
        error: `Odds speglade från ${source.bookmaker}: ${reason}`,
      });
    }
  }

  return results.map((result) => byId.get(result.bookmakerId) ?? result);
}

/** En bookmaker-scrape får inte hänga obegränsat — annars fryser hela bonus-index på Render. */
const SCRAPE_SINGLE_BOOKMAKER_MS = 28_000;

async function scrapeBookmakerForMatchBounded(
  spec: (typeof BOOKMAKER_SCRAPERS)[number],
  targetTitle: string,
  fallbackQuery: string,
): Promise<BookmakerScrapeResult> {
  try {
    return await Promise.race([
      scrapeBookmakerForMatch(spec, targetTitle, fallbackQuery),
      new Promise<BookmakerScrapeResult>((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout ${SCRAPE_SINGLE_BOOKMAKER_MS}ms`)), SCRAPE_SINGLE_BOOKMAKER_MS);
      }),
    ]);
  } catch (error) {
    return makeBookmakerResult(spec, "error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function scrapeBookmakersForMatch(
  targetTitle: string,
  fallbackQuery: string,
  bookmakerIds?: string[],
) {
  loadLastGoodBookmakerOddsFromDisk();
  const allowedIds = bookmakerIds ? new Set(bookmakerIds) : null;
  const specs = BOOKMAKER_SCRAPERS.filter((spec) => !allowedIds || allowedIds.has(spec.id));
  const cacheKey = [
    specs.map((spec) => spec.id).sort().join(","),
    normalizeScrapeCacheTitle(targetTitle),
    normalizeScrapeCacheTitle(fallbackQuery),
  ].join("::");
  const cached = bookmakerMatchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      return await Promise.race([
        cached.promise,
        new Promise<BookmakerScrapeResult[]>((_, reject) => {
          setTimeout(() => reject(new Error("bookmaker-match-cache-timeout")), 42_000);
        }),
      ]);
    } catch {
      bookmakerMatchCache.delete(cacheKey);
    }
  }

  const settled = await Promise.allSettled(
    specs.map((spec) => scrapeBookmakerForMatchBounded(spec, targetTitle, fallbackQuery)),
  );
  const rawResults = settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : makeBookmakerResult(specs[index], "error", {
          error: result.reason instanceof Error ? result.reason.message : "Unknown scrape error",
        }),
  );
  const promise = Promise.resolve(applySameOddsFallbacks(rawResults));
  bookmakerMatchCache.set(cacheKey, { expiresAt: Date.now() + BOOKMAKER_MATCH_CACHE_TTL_MS, promise });
  return promise;
}

function rowsFromBookmakerResults(results: BookmakerScrapeResult[]): Array<OddsRow & { bookmakerId: string }> {
  return results
    .filter(
      (result): result is BookmakerScrapeResult & { home: number; draw: number; away: number } =>
        result.status === "found" && result.home != null && result.draw != null && result.away != null,
    )
    .map((result) => ({
      bookmakerId: result.bookmakerId,
      bookmaker: result.bookmaker,
      home: result.home,
      draw: result.draw,
      away: result.away,
    }));
}

function summarizeBookmakerScrapeResults(results: BookmakerScrapeResult[]) {
  return {
    found: results.filter((r) => r.status === "found").length,
    mirrored: results.filter((r) => Boolean(r.mirroredFromBookmakerId)).length,
    error: results.filter((r) => r.status === "error").length,
    notFound: results.filter((r) => r.status === "not_found").length,
    blocked: results.filter((r) => r.status === "blocked").length,
  };
}

function oddsMatrixFromRows(rows: Array<OddsRow & { bookmakerId: string }>): Partial<Record<BonusBookmakerId, OddsTriple>> {
  const matrix: Partial<Record<BonusBookmakerId, OddsTriple>> = {};
  for (const row of rows) {
    matrix[row.bookmakerId as BonusBookmakerId] = {
      "1": row.home,
      X: row.draw,
      "2": row.away,
    };
  }
  return matrix;
}

function requiredBonusBookmakerIds(portfolio: BonusPortfolio): BonusBookmakerId[] {
  return [...new Set([
    ...portfolio.matched.filter((bonus) => bonus.enabled).map((bonus) => bonus.id),
    ...portfolio.freebets.filter((bonus) => bonus.enabled).map((bonus) => bonus.id),
  ])];
}

function missingBonusBookmakerIds(match: BonusMatch, portfolio: BonusPortfolio) {
  return requiredBonusBookmakerIds(portfolio).filter((id) => {
    const odds = match.odds[id];
    return !odds || !(odds["1"] > 1 && odds.X > 1 && odds["2"] > 1);
  });
}

function disabledBonusPortfolio(portfolio: BonusPortfolio, disabledIds: BonusBookmakerId[]): BonusPortfolio {
  const disabled = new Set(disabledIds);
  return {
    matched: portfolio.matched.map((bonus) => (disabled.has(bonus.id) ? { ...bonus, enabled: false } : bonus)),
    freebets: portfolio.freebets.map((bonus) => (disabled.has(bonus.id) ? { ...bonus, enabled: false } : bonus)),
  };
}

function unavailableBonusBookmakerIds(results: BookmakerScrapeResult[], missingIds: BonusBookmakerId[]) {
  const byId = new Map(results.map((result) => [result.bookmakerId, result]));
  return missingIds.filter((id) => {
    const result = byId.get(id);
    return result?.status === "error" || result?.status === "blocked";
  });
}

function missingMatchedBonusBookmakerIds(match: BonusMatch, portfolio: BonusPortfolio) {
  return portfolio.matched
    .filter((bonus) => bonus.enabled)
    .map((bonus) => bonus.id)
    .filter((id) => {
      const odds = match.odds[id];
      return !odds || !(odds["1"] > 1 && odds.X > 1 && odds["2"] > 1);
    });
}

type ExternalComplementBet = {
  outcome: Outcome;
  bookmakerId: string;
  bookmaker: string;
  stake: number;
  odds: number;
  grossReturn: number;
};

type ExternalComplementPlan = {
  bets: ExternalComplementBet[];
  totalStake: number;
  paybackPerOutcome: Record<Outcome, number>;
  accountReturnPerOutcome: Record<Outcome, number>;
  stakeMinusReturnPerOutcome: Record<Outcome, number>;
  minPayback: number;
  averagePayback: number;
  worstCaseEdgePct: number;
  averageEdgePct: number;
  outcomeSpread: number;
  improvementWorstEdgePct: number;
  improvementMinPayback: number;
};

function bestExternalOddsByOutcome(rows: Array<OddsRow & { bookmakerId: string }>) {
  const best: Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>> = {};
  for (const row of rows) {
    const candidates: Array<[Outcome, number]> = [
      ["1", row.home],
      ["X", row.draw],
      ["2", row.away],
    ];
    for (const [outcome, odds] of candidates) {
      if (!(odds > 1)) continue;
      if (!best[outcome] || odds > best[outcome]!.odds) {
        best[outcome] = { bookmakerId: row.bookmakerId, bookmaker: row.bookmaker, odds };
      }
    }
  }
  return best as Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>;
}

type FairValueReference = {
  source: "pinnacle-smarkets" | "market-consensus";
  score: number;
  fairOdds: Partial<Record<Outcome, number>>;
};

function fairValueReferenceFromRows(rows: Array<OddsRow & { bookmakerId?: string }>): FairValueReference | null {
  const usable = rows.filter((row) => row.home > 1 && row.draw > 1 && row.away > 1);
  if (usable.length === 0) return null;
  const sharpRows = usable.filter((row) => /pinnacle|ps3838|smarkets|betfair|matchbook/i.test(row.bookmaker));
  const referenceRows = sharpRows.length > 0 ? sharpRows : usable;
  const implied = BONUS_OUTCOMES.map((outcome) => {
    const key = outcome === "1" ? "home" : outcome === "X" ? "draw" : "away";
    return referenceRows.reduce((sum, row) => sum + 1 / row[key], 0) / referenceRows.length;
  });
  const overround = implied.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(overround) || overround <= 0) return null;
  const fairOdds = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome, index) => [outcome, 1 / (implied[index] / overround)]),
  ) as Record<Outcome, number>;
  const best = buildBestByOutcome(usable);
  const ratios = BONUS_OUTCOMES.map((outcome) => {
    const bestOdds = outcome === "1" ? best["1"]?.odds : outcome === "X" ? best.X?.odds : best["2"]?.odds;
    const fair = fairOdds[outcome];
    return bestOdds && fair ? bestOdds / fair : 0;
  }).filter((value) => value > 0);
  if (ratios.length === 0) return null;
  return {
    source: sharpRows.length > 0 ? "pinnacle-smarkets" : "market-consensus",
    score: ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    fairOdds,
  };
}

type NoVigOutcome = {
  outcome: string;
  marketOdds: number;
  impliedProb: number;
  fairProb: number;
  fairOdds: number;
};

type NoVigResult = {
  outcomes: NoVigOutcome[];
  overround: number;
  vig: number;
};

/**
 * Tar bort bookmaker-vig genom normalisering enligt specen:
 *   p_i = 1 / odds_i
 *   S = sum(p_i)
 *   fair_p_i = p_i / S
 *   fair_odds_i = 1 / fair_p_i
 * Returnerar null om indata inte är en giltig 2-way eller 3-way marknad.
 */
function computeNoVig(odds: Record<string, number>): NoVigResult | null {
  const entries = Object.entries(odds).filter(([, v]) => Number.isFinite(v) && v > 1);
  if (entries.length < 2) return null;
  const implied = entries.map(([key, value]) => ({ key, prob: 1 / value, marketOdds: value }));
  const overround = implied.reduce((sum, item) => sum + item.prob, 0);
  if (!(overround > 0)) return null;
  const outcomes: NoVigOutcome[] = implied.map((item) => {
    const fairProb = item.prob / overround;
    return {
      outcome: item.key,
      marketOdds: item.marketOdds,
      impliedProb: item.prob,
      fairProb,
      fairOdds: 1 / fairProb,
    };
  });
  return { outcomes, overround, vig: overround - 1 };
}

function continuationRequiredBookmakerIds(accounts: WageringAccount[], vouchers: FreebetVoucher[]) {
  const directIds = [...accounts.map((account) => account.bookmakerId), ...vouchers.map((voucher) => voucher.bookmakerId)];
  // Expandera varje krävd bookmaker till HELA sin systergrupp (SAME_ODDS_FALLBACK_GROUPS)
  // så de odds-identiska systerbrandsen också scrapas. Annars kan applySameOddsFallbacks
  // inte spegla in odds när en krävd sajt (t.ex. Snabbare) missade matchen själv — och då
  // tappas det kontot helt ur Dag 2/3-planen fast pengarna ligger kvar och måste omsättas.
  const expanded = new Set<string>(directIds);
  for (const id of directIds) {
    const group = SAME_ODDS_FALLBACK_GROUPS.find((g) => g.includes(id as BonusBookmakerId));
    if (group) for (const member of group) expanded.add(member);
  }
  return [...expanded];
}

function continuationSortableMetrics(plan: ContinuationPlan) {
  return {
    worstCaseEdgePct: plan.worstCaseEdgePct,
    averageEdgePct: plan.averageEdgePct,
    minPayback: plan.minPayback,
    outcomeSpread: plan.outcomeSpread,
    averagePayback: plan.averagePayback,
  };
}

function compareContinuationPlans(a: ContinuationPlan, b: ContinuationPlan) {
  const am = continuationSortableMetrics(a);
  const bm = continuationSortableMetrics(b);
  const aMeetsWorst = am.worstCaseEdgePct >= -5;
  const bMeetsWorst = bm.worstCaseEdgePct >= -5;
  if (aMeetsWorst !== bMeetsWorst) return aMeetsWorst ? -1 : 1;
  return (
    bm.worstCaseEdgePct - am.worstCaseEdgePct ||
    bm.averageEdgePct - am.averageEdgePct ||
    am.outcomeSpread - bm.outcomeSpread ||
    bm.averagePayback - am.averagePayback ||
    bm.minPayback - am.minPayback
  );
}

function evaluateComplementedPayback(
  basePayback: Record<Outcome, number>,
  baseStake: number,
  bets: ExternalComplementBet[],
): Omit<ExternalComplementPlan, "bets" | "improvementWorstEdgePct" | "improvementMinPayback"> {
  const totalComplementStake = bets.reduce((sum, bet) => sum + bet.stake, 0);
  const totalStake = baseStake + totalComplementStake;
  const paybackPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => {
      const winReturn = bets
        .filter((bet) => bet.outcome === outcome)
        .reduce((sum, bet) => sum + bet.grossReturn, 0);
      return [outcome, basePayback[outcome] + winReturn - totalComplementStake];
    }),
  ) as Record<Outcome, number>;
  const accountReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, paybackPerOutcome[outcome] + totalStake]),
  ) as Record<Outcome, number>;
  const stakeMinusReturnPerOutcome = Object.fromEntries(
    BONUS_OUTCOMES.map((outcome) => [outcome, totalStake - accountReturnPerOutcome[outcome]]),
  ) as Record<Outcome, number>;
  const values = BONUS_OUTCOMES.map((outcome) => paybackPerOutcome[outcome]);
  const minPayback = Math.min(...values);
  const averagePayback = values.reduce((sum, value) => sum + value, 0) / values.length;
  const outcomeSpread = Math.max(...values) - minPayback;
  return {
    totalStake: totalComplementStake,
    paybackPerOutcome,
    accountReturnPerOutcome,
    stakeMinusReturnPerOutcome,
    minPayback,
    averagePayback,
    worstCaseEdgePct: totalStake > 0 ? (minPayback / totalStake) * 100 : 0,
    averageEdgePct: totalStake > 0 ? (averagePayback / totalStake) * 100 : 0,
    outcomeSpread,
  };
}

function buildExternalComplementPlan(
  plan: BonusOptimizationPlan,
  rows: Array<OddsRow & { bookmakerId: string }>,
): ExternalComplementPlan | null {
  const bestOdds = bestExternalOddsByOutcome(rows);
  if (!BONUS_OUTCOMES.every((outcome) => bestOdds[outcome]?.odds > 1)) return null;

  const basePayback = plan.paybackPerOutcome;
  const baseStake = plan.totalStakePlaced;
  const baseWorst = plan.worstCaseEdgePct;
  const baseMin = plan.minPayback;
  const minBase = Math.min(...BONUS_OUTCOMES.map((outcome) => basePayback[outcome]));
  const maxBase = Math.max(...BONUS_OUTCOMES.map((outcome) => basePayback[outcome]));
  const maxComplementStake = Math.min(Math.max(1000, baseStake * 0.6), 8000);

  let bestPlan: ExternalComplementPlan | null = null;
  for (let target = minBase + 100; target <= maxBase + 1000; target += 100) {
    let totalStakeGuess = 0;
    let bets: ExternalComplementBet[] = [];
    for (let iter = 0; iter < 8; iter++) {
      bets = [];
      for (const outcome of BONUS_OUTCOMES) {
        const required = target + totalStakeGuess - basePayback[outcome];
        if (required <= 0) continue;
        const odds = bestOdds[outcome];
        const stake = Math.ceil((required / odds.odds) / 10) * 10;
        if (stake > 0) {
          bets.push({
            outcome,
            bookmakerId: odds.bookmakerId,
            bookmaker: odds.bookmaker,
            stake,
            odds: odds.odds,
            grossReturn: stake * odds.odds,
          });
        }
      }
      const nextStake = bets.reduce((sum, bet) => sum + bet.stake, 0);
      if (Math.abs(nextStake - totalStakeGuess) < 1) break;
      totalStakeGuess = nextStake;
      if (totalStakeGuess > maxComplementStake) break;
    }
    const complementStake = bets.reduce((sum, bet) => sum + bet.stake, 0);
    if (bets.length === 0 || complementStake > maxComplementStake) continue;
    const evaluated = evaluateComplementedPayback(basePayback, baseStake, bets);
    const candidate: ExternalComplementPlan = {
      bets,
      ...evaluated,
      improvementWorstEdgePct: evaluated.worstCaseEdgePct - baseWorst,
      improvementMinPayback: evaluated.minPayback - baseMin,
    };
    if (candidate.improvementWorstEdgePct <= 0.25 && candidate.improvementMinPayback <= 0) continue;
    if (
      !bestPlan ||
      candidate.worstCaseEdgePct > bestPlan.worstCaseEdgePct ||
      (candidate.worstCaseEdgePct === bestPlan.worstCaseEdgePct && candidate.totalStake < bestPlan.totalStake)
    ) {
      bestPlan = candidate;
    }
  }

  return bestPlan;
}

function isMajorBonusCandidateLeague(categoryName = "", champName = "") {
  const haystack = `${categoryName} ${champName}`;
  if (/women|kvinn|damer|\([dkw]\)|u20|u21|u19|youth|junior/i.test(haystack)) return false;
  const majorCountry = /England|Spanien|Tyskland|Italien|Frankrike|Europa|Sverige|Nederländerna|Portugal|Skottland|Norge|Danmark|Belgien|Österrike|Schweiz|Grekland|Turkiet|Polen|Tjeckien|Kroatien|Serbien|USA|Argentina|Brasilien|Mexiko/i.test(categoryName);
  const majorLeague =
    /Premier League|La Liga|Bundesliga|2\. Bundesliga|Serie A|Serie B|Ligue 1|Ligue 2|Champions League|Europa League|Conference League|Allsvenskan|Superettan|Eredivisie|Liga Portugal|Championship|League One|League Two|FA Cup|EFL Cup|Copa del Rey|Coppa Italia|DFB Pokal|Eliteserien|Superliga|Pro League|Bundesliga|Super League|Süper Lig|Ekstraklasa|MLS|Brasileiro|Liga MX|Primera/i.test(
      champName,
    );
  return majorCountry && majorLeague;
}

function isUsableBonusCandidateLeague(categoryName = "", champName = "") {
  const haystack = `${categoryName} ${champName}`.trim();
  if (!haystack) return false;
  if (/women|kvinn|damer|\([dkw]\)|u20|u21|u19|youth|junior|esport|cyber|fantasy|simulated|friendly|vänskaps/i.test(haystack)) {
    return false;
  }
  // Tidigare krävde vi BÅDE categoryName && champName, men det filtrerade bort
  // legit-matcher där en Altenar-feed bara skickar champ-namnet (eller tvärtom).
  // Räcker med att något av dem finns och inte är ett skräp-segment.
  return true;
}

function bonusLeaguePriority(league: string) {
  const lower = league.toLowerCase();
  if (/champions league|europa league|conference league/i.test(league)) return 0;
  if (/england.*premier league|premier league.*england/i.test(league)) return 0;
  if (/spanien.*la liga|la liga.*spanien|tyskland.*bundesliga|bundesliga.*tyskland|italien.*serie a|serie a.*italien|frankrike.*ligue 1|ligue 1.*frankrike/i.test(league)) {
    return 1;
  }
  if (/mls|usa.*major league soccer|major league soccer|brasileiro serie a|brasilien.*brasileiro|liga mx|mexiko.*liga mx/i.test(league)) return 1;
  if (/championship|eredivisie|liga portugal|allsvenskan|eliteserien|superliga|serie b|ligue 2|2\. bundesliga|süper lig|scotland.*premier/i.test(league)) {
    return 2;
  }
  if (/kanada|australien|hongkong|singapore|kazakstan|ukraina|queensland|victoria|nsw/i.test(lower)) return 4;
  return 3;
}

function buildBonusCandidateMatchesFromAltenar(data: AltenarUpcoming, hoursWindow = 72, limit = 140) {
  const now = Date.now();
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const categories = new Map((data.categories ?? []).map((item) => [item.id, item.name ?? ""]));
  const champs = new Map((data.champs ?? []).map((item) => [item.id, item.name ?? ""]));

  return (data.events ?? [])
    .filter((event) => event.id && event.name && event.sportId === 66 && event.startDate)
    .map((event) => {
      const startMs = Date.parse(event.startDate ?? "");
      const league = [categories.get(event.catId), champs.get(event.champId)].filter(Boolean).join(" - ");
      return {
        title: String(event.name ?? "").replace(/\s+/g, " ").trim(),
        startTs: event.startDate,
        startMs,
        league,
        categoryName: categories.get(event.catId) ?? "",
        champName: champs.get(event.champId) ?? "",
      };
    })
    .filter((event) => Number.isFinite(event.startMs) && event.startMs >= now - 60 * 60 * 1000 && event.startMs <= latest)
    .filter((event) => !looksLikeFantasyOrEsportsTitle(event.title) && !isWomensTitle(event.title) && !isJuniorTitle(event.title))
    .filter((event) => isUsableBonusCandidateLeague(event.categoryName, event.champName))
    .sort((a, b) => bonusLeaguePriority(a.league) - bonusLeaguePriority(b.league) || a.startMs - b.startMs || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ title, startTs, league }) => ({ title, startTs, league }));
}

async function buildBonusCandidateMatches(hoursWindow = 72, limit = 140) {
  const merged: Array<{ title: string; startTs?: string; league?: string; startMs: number }> = [];
  const addCandidate = (candidate: { title: string; startTs?: string; league?: string }) => {
    const startMs = Date.parse(candidate.startTs ?? "");
    if (!candidate.title || !Number.isFinite(startMs)) return;
    if (
      merged.some((item) =>
        isLikelySameMatch(item.title, candidate.title, {
          candidateStartTs: candidate.startTs,
          targetStartTs: item.startTs,
          candidateLeague: candidate.league,
          targetLeague: item.league,
        }),
      )
    )
      return;
    merged.push({ ...candidate, startMs });
  };

  const integrations = ["dbet", "mrvegasse", "megarichesse", "megafortunese", "happycasino", "luckycasino", "betiniase2", "quickcasinose", "videoslotsse", "kungaslottetse", "campose"];
  for (const integration of integrations) {
    try {
      const seed = await fetchAltenarUpcoming(integration);
      const candidates = buildBonusCandidateMatchesFromAltenar(seed, hoursWindow, limit);
      candidates.forEach(addCandidate);
    } catch (error) {
      console.warn(`[bonus-candidates] Altenar ${integration} failed`, error);
    }
  }

  try {
    const now = Date.now();
    const latest = now + hoursWindow * 60 * 60 * 1000;
    const events = await fetchKambiFootballEvents("pafpre1x2se");
    for (const entry of events) {
      const event = entry.event;
      const startMs = Date.parse(event?.start ?? "");
      const title = (event?.name || [event?.homeName, event?.awayName].filter(Boolean).join(" - ")).replace(/\s+/g, " ").trim();
      if (!title || !Number.isFinite(startMs) || startMs < now - 60 * 60 * 1000 || startMs > latest) continue;
      if (looksLikeFantasyOrEsportsTitle(title) || isWomensTitle(title) || isJuniorTitle(title)) continue;
      const league = event?.group ?? "";
      addCandidate({ title, startTs: event?.start, league });
    }
  } catch (error) {
    console.warn("[bonus-candidates] Kambi fallback failed", error);
  }

  // Kambi ubse (Unibet Sweden) — bredare seed för att fånga matcher som
  // Altenar/Paf-pre1x2se inte exponerar. Unibet täcker fler ligor + cuper.
  // Viktigast för Bonus Finder: utan ubse-seeden hittade vi t.ex. inga
  // Unibet-odds i indexet (matchtitlar mismatcha:de). Med ubse blir varje
  // Unibet-matchtitel också en candidate-titel → 1:1 hit i scrape-fasen.
  try {
    const now = Date.now();
    const latest = now + hoursWindow * 60 * 60 * 1000;
    const events = await fetchKambiFootballEvents("ubse");
    for (const entry of events) {
      const event = entry.event;
      const startMs = Date.parse(event?.start ?? "");
      const title = (event?.name || [event?.homeName, event?.awayName].filter(Boolean).join(" - ")).replace(/\s+/g, " ").trim();
      if (!title || !Number.isFinite(startMs) || startMs < now - 60 * 60 * 1000 || startMs > latest) continue;
      if (looksLikeFantasyOrEsportsTitle(title) || isWomensTitle(title) || isJuniorTitle(title)) continue;
      const league = event?.group ?? "";
      addCandidate({ title, startTs: event?.start, league });
    }
  } catch (error) {
    console.warn("[bonus-candidates] Kambi ubse fallback failed", error);
  }

  return merged
    .sort((a, b) => bonusLeaguePriority(a.league ?? "") - bonusLeaguePriority(b.league ?? "") || a.startMs - b.startMs || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ title, startTs, league }) => ({ title, startTs, league }));
}

/**
 * Multi-sport Bonus Finder matcher (Phase 2). Parallell pipeline vid sidan
 * av buildBonusOddsIndex för fotbolls-1X2. Returnerar MatchData[] med
 * marketType="ML2" för tennis/hockey/basket/baseball/MMA/boxning.
 *
 * Sources i denna iteration:
 *   - Unibet via Kambi listView/{sport}/all + betoffer/event
 *   - DBET, MrVegas, MegaRiches via Altenar GetUpcoming?sportId=X
 *   - Betsson-gruppen (Betsson/Bethard/Spelklubben/NordicBet/Betsafe) + VBET
 *     via deras cachade eventsBasket/eventsTennis (samma 2-vägs-data som
 *     valuebets-pipelinen redan läser). Endast basket + tennis — de övriga
 *     2-vägs-sporterna (hockey/baseball/MMA/boxning) scrapas inte av dem.
 *
 * Phase 2d kommer lägga till Paf-brand + ComeOn-group.
 */
type MultiSportMatch = {
  title: string;
  startTs?: string;
  league?: string;
  sport: string;
  marketType: "ML2";
  oddsRows: Array<{ bookmakerId: string; bookmaker: string; home: number; away: number }>;
};

const ALTENAR_MULTI_SPORT_INTEGRATIONS: Array<{ id: string; name: string; integration: string }> = [
  { id: "dbet",       name: "DBET",        integration: "dbet" },
  { id: "mrvegas",    name: "MrVegas",     integration: "mrvegasse" },
  { id: "megariches", name: "MegaRiches",  integration: "megarichesse" },
  { id: "happycasino", name: "Happy Casino", integration: "happycasino" },
  { id: "lucky", name: "Lucky", integration: "luckycasino" },
  { id: "betinia", name: "Betinia", integration: "betiniase2" },
  { id: "quick", name: "Quick", integration: "quickcasinose" },
  { id: "megafortune", name: "MegaFortune", integration: "megafortunese" },
  { id: "videoslots", name: "Videoslots", integration: "videoslotsse" },
  { id: "kungaslottet", name: "Kungaslottet", integration: "kungaslottetse" },
  { id: "campobet", name: "CampoBet", integration: "campose" },
];

/**
 * Cachad 2-vägs-källa (Betsson-grupp / VBET): per bookmaker-brand de förparsade
 * basket/tennis-events deras scraper redan producerar (eventsBasket/eventsTennis).
 */
type TwoWayCacheEvent = {
  title?: string;
  homeTeam?: string;
  awayTeam?: string;
  startTime?: string | null;
  odds?: { home?: number; away?: number };
};
type TwoWayCacheBrand = { brandId: string; brandName: string; basket: TwoWayCacheEvent[]; tennis: TwoWayCacheEvent[] };

/** Läs eventsBasket/eventsTennis ur en cache-payload (defensivt). */
function readTwoWayCacheArrays(payload: unknown): { basket: TwoWayCacheEvent[]; tennis: TwoWayCacheEvent[] } {
  const p = (payload ?? {}) as Record<string, unknown>;
  return {
    basket: Array.isArray(p.eventsBasket) ? (p.eventsBasket as TwoWayCacheEvent[]) : [],
    tennis: Array.isArray(p.eventsTennis) ? (p.eventsTennis as TwoWayCacheEvent[]) : [],
  };
}

/**
 * Samla Betsson-gruppens + VBET:s cachade basket/tennis-events. Betsson-gruppen
 * delar ETT odds-set över 5 brands. VBET har ett eget. Saknas fältet (t.ex. VBET
 * innan scrapern börjat producera 2-vägs) → tom array, källan bidrar tyst inget.
 */
async function loadTwoWayCacheBrands(): Promise<TwoWayCacheBrand[]> {
  const brands: TwoWayCacheBrand[] = [];
  try {
    const betsson = await loadBetssonPayloadWithMeta();
    const { basket, tennis } = readTwoWayCacheArrays(betsson.payload);
    if (basket.length || tennis.length) {
      for (const b of [
        { id: "betsson", name: "Betsson" },
        { id: "bethard", name: "Bethard" },
        { id: "spelklubben", name: "Spelklubben" },
        { id: "nordicbet", name: "NordicBet" },
        { id: "betsafe", name: "Betsafe" },
      ]) {
        brands.push({ brandId: b.id, brandName: b.name, basket, tennis });
      }
    }
  } catch { /* Betsson saknas → hoppa */ }
  try {
    const vbet = await loadVbetPayloadWithMeta();
    const { basket, tennis } = readTwoWayCacheArrays(vbet.payload);
    if (basket.length || tennis.length) {
      brands.push({ brandId: "vbet", brandName: "VBET", basket, tennis });
    }
  } catch { /* VBET saknas → hoppa */ }
  return brands;
}

async function loadMultiSportBonusMatches(hoursWindow: number): Promise<MultiSportMatch[]> {
  const now = Date.now();
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const allMatches: MultiSportMatch[] = [];

  // Betsson-grupp + VBET: cachade basket/tennis-events (laddas en gång, matchas
  // mot Unibet-ankaret per match nedan). Endast basket + tennis stöds av dem.
  const twoWayCacheBrands = await loadTwoWayCacheBrands();

  for (const sport of MULTI_SPORT_KEYS) {
    const cfg = MULTI_SPORT_CATALOG[sport];

    // Fetcha events parallellt från Kambi (ubse=Unibet) + alla Altenar-integrationer
    const [unibetEvents, ...altenarFetches] = await Promise.all([
      fetchKambiEventsForSport("ubse", sport).catch(() => []),
      ...ALTENAR_MULTI_SPORT_INTEGRATIONS.map((alt) =>
        fetchAltenarUpcoming(alt.integration, cfg.altenarSportId).catch(() => ({ events: [], markets: [], odds: [] } as AltenarUpcoming)),
      ),
    ]);

    // Per Kambi-event: scrape Unibet-odds via Kambi-API, hitta Altenar-matchningar
    // via titel-jaccard, och bygg ihop en MatchData med oddsRows från alla
    // bookmakers som hade matchen.
    const eventPromises = unibetEvents.map(async (entry): Promise<MultiSportMatch | null> => {
      const event = entry.event;
      const eventId = event?.id;
      const startMs = Date.parse(event?.start ?? "");
      const title = (event?.name || [event?.homeName, event?.awayName].filter(Boolean).join(" - "))
        .replace(/\s+/g, " ")
        .trim();
      if (!eventId || !title || !Number.isFinite(startMs)) return null;
      // prematch-only: ingen bakåt-grace → redan startade/live matcher tappas
      if (startMs < now || startMs > latest) return null;
      if (looksLikeFantasyOrEsportsTitle(title) || isWomensTitle(title) || isJuniorTitle(title)) return null;

      const rows: MultiSportMatch["oddsRows"] = [];

      // Unibet via Kambi
      const unibetOdds = await parseOddsRowsFromKambiEventForSport("ubse", String(eventId), getKambiOfferingReferer("ubse"))
        .catch(() => null);
      if (unibetOdds && unibetOdds.home != null && unibetOdds.away != null) {
        rows.push({ bookmakerId: "unibet", bookmaker: "Unibet", home: unibetOdds.home, away: unibetOdds.away });
      }

      // Altenar-bookmakers — matcha mot deras event-feed via titel-jaccard
      for (let i = 0; i < ALTENAR_MULTI_SPORT_INTEGRATIONS.length; i++) {
        const alt = ALTENAR_MULTI_SPORT_INTEGRATIONS[i];
        const data = altenarFetches[i];
        if (!data?.events?.length) continue;
        const candidates = data.events
          .filter((e) => e.id && e.name && e.sportId === cfg.altenarSportId)
          .filter((e) => !isAudienceMismatch(e.name ?? "", title))
          .filter((e) => isLikelySameMatch(String(e.name ?? ""), title));
        if (candidates.length === 0) continue;
        const best = candidates[0];
        const odds = parseAltenarTwoWay(data, Number(best.id));
        if (odds) rows.push({ bookmakerId: alt.id, bookmaker: alt.name, home: odds.home, away: odds.away });
      }

      // Betsson-gruppen + VBET — matcha mot deras cachade basket/tennis-events
      // (samma titel-jaccard som Altenar). Endast basket + tennis finns hos dem.
      const cacheField = sport === "basketball" ? "basket" : sport === "tennis" ? "tennis" : null;
      if (cacheField) {
        for (const brand of twoWayCacheBrands) {
          const events = brand[cacheField];
          if (!events.length) continue;
          const hit = events.find((e) => {
            const candTitle = (e.title || [e.homeTeam, e.awayTeam].filter(Boolean).join(" - ")).trim();
            return candTitle.length > 0 && !isAudienceMismatch(candTitle, title) && isLikelySameMatch(candTitle, title);
          });
          const home = Number(hit?.odds?.home);
          const away = Number(hit?.odds?.away);
          if (hit && home > 1 && away > 1) {
            rows.push({ bookmakerId: brand.brandId, bookmaker: brand.brandName, home, away });
          }
        }
      }

      // Kräv minst 1 bookmaker-rad (Unibet) — annars är matchen inte
      // användbar i bonus-finder.
      if (rows.length === 0) return null;
      return {
        title,
        startTs: event?.start,
        league: event?.group,
        sport,
        marketType: "ML2",
        oddsRows: rows,
      };
    });

    const settled = await Promise.allSettled(eventPromises);
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) allMatches.push(result.value);
    }
  }

  return allMatches;
}

// Cache så att vi inte spammar Kambi/Altenar API per request.
let multiSportBonusMatchesCache: { expiresAt: number; matches: MultiSportMatch[] } | null = null;
let multiSportBonusMatchesInflight: Promise<MultiSportMatch[]> | null = null;
const MULTI_SPORT_BONUS_TTL_MS = 5 * 60 * 1000;

async function getMultiSportBonusMatches(hoursWindow: number): Promise<MultiSportMatch[]> {
  if (multiSportBonusMatchesCache && multiSportBonusMatchesCache.expiresAt > Date.now()) {
    return multiSportBonusMatchesCache.matches;
  }
  if (multiSportBonusMatchesInflight) return multiSportBonusMatchesInflight;
  const promise = loadMultiSportBonusMatches(hoursWindow).then((matches) => {
    multiSportBonusMatchesCache = { expiresAt: Date.now() + MULTI_SPORT_BONUS_TTL_MS, matches };
    multiSportBonusMatchesInflight = null;
    console.info(`[multi-sport-bonus] loaded ${matches.length} matches across ${MULTI_SPORT_KEYS.length} sports`);
    return matches;
  }).catch((error) => {
    console.warn("[multi-sport-bonus] failed", error);
    multiSportBonusMatchesInflight = null;
    return [];
  });
  multiSportBonusMatchesInflight = promise;
  return promise;
}

function bonusCandidateLimit(hoursWindow: number) {
  // 24h är viktigast i praktiken, så även kortaste fönstret får en stor pool.
  if (hoursWindow <= 24) return 96;
  if (hoursWindow <= 48) return 112;
  return 128;
}

function bonusOddsIndexCandidateLimit(hoursWindow: number) {
  // Stora matcher måste få chans att komma med. Progressiv disk-cache skrivs under tiden.
  // Bumpat 96/144/180 → 160/220/280 för Bonus Finder: ju fler kandidater desto
  // fler matcher som potentiellt har odds från valda svenska bookmakers.
  if (hoursWindow <= 24) return 160;
  if (hoursWindow <= 48) return 220;
  return 280;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results: R[] = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = items[nextIndex++];
      results.push(await mapper(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const BEST_BONUS_MATCHES_CACHE_TTL_MS = 90 * 1000;
const bestBonusMatchesCache = new Map<string, { expiresAt: number; matches: unknown[] }>();
type IndexedBonusOddsMatch = BonusMatch & {
  oddsRows: Array<OddsRow & { bookmakerId: string }>;
  bookmakerResults: BookmakerScrapeResult[];
  fairValueReference: FairValueReference | null;
  coverageScore?: number;
};
const BONUS_ODDS_INDEX_TTL_MS = 10 * 60 * 1000;
/**
 * Max-ålder på disk-cache: 30 min. Tidigare 6h, men det orsakade stale odds i
 * Valuebets (faktiska bookmaker-priser hade flyttats sedan senaste scrape).
 * Tradeoff: requests >30 min efter senaste rebuild triggar en ny rebuild,
 * vilket kan ge första-request-latens på Render.
 */
const BONUS_ODDS_INDEX_DISK_MAX_AGE_MS = 30 * 60 * 1000;
// Cache-katalog. DEFAULT = .matched-betting-cache i cwd, men den är EFEMÄR på
// Render (försvinner när containern recyclas ~var 10:e h) → disk-persisterade
// cacher (källor-status, bonus-index, last-good-odds) överlever inte en omstart
// och första requesten efter recycle bygger om allt från noll = "segt efter
// 7-10h". Sätt env CACHE_DIR till en MONTERAD PERSISTENT DISK (Render → Disks,
// t.ex. /var/data) så överlever cacherna recycles → alltid snabbt även direkt
// efter omstart.
const BONUS_CACHE_DIR = (process.env.CACHE_DIR || process.env.RENDER_CACHE_DIR || "").trim()
  ? path.resolve((process.env.CACHE_DIR || process.env.RENDER_CACHE_DIR || "").trim())
  : path.resolve(process.cwd(), ".matched-betting-cache");
const bonusOddsIndexCache = new Map<number, { expiresAt: number; generatedAt: number; matches: IndexedBonusOddsMatch[] }>();
const bonusOddsIndexInflight = new Map<number, Promise<IndexedBonusOddsMatch[]>>();
/** Efter en tom index-run: undvik att auto-trigga om och om igen vid varje poll. */
const bonusOddsIndexEmptyCooldownUntil = new Map<number, number>();
const BONUS_ODDS_INDEX_EMPTY_COOLDOWN_MS = 10 * 60 * 1000;
const BEST_BONUS_PREWARM_INTERVAL_MS = 10 * 60 * 1000;
// Självläkning: om en förvärmning fallerar eller ger tomt index väntar vi inte
// hela 10 min till nästa ordinarie pass — vi snabb-retryar så indexet läker i
// bakgrunden i stället för på besökarens återkomst.
const BEST_BONUS_PREWARM_RETRY_MS = 90 * 1000;
let bestBonusPrewarmRetryScheduled = false;
let bestBonusPrewarmTimer: ReturnType<typeof setInterval> | null = null;
let bestBonusPrewarmRunning = false;
let bestBonusPrewarmSecondaryIndex = 0;

type BonusMatchStrategy = "single" | "split";

function bonusPortfolioSearchCacheKey(
  portfolio: BonusPortfolio,
  method: OptimizationMethod,
  hoursWindow: number,
  top: number,
  tolerance: DistributionTolerance,
  strategy: BonusMatchStrategy,
) {
  return JSON.stringify({
    method,
    hoursWindow,
    top,
    tolerance,
    strategy,
    matched: portfolio.matched
      .filter((bonus) => bonus.enabled)
      .map(({ id, deposit, minOdds, wagerMultiplier }) => ({ id, deposit, minOdds, wagerMultiplier }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    freebets: portfolio.freebets
      .filter((bonus) => bonus.enabled)
      .map(({ id, amount, minOdds }) => ({ id, amount, minOdds }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function bonusOddsIndexFile(hoursWindow: number) {
  return path.join(BONUS_CACHE_DIR, `bonus-odds-index-${hoursWindow}.json`);
}

function pruneIndexedBonusMatches(matches: IndexedBonusOddsMatch[], hoursWindow: number) {
  const now = Date.now();
  const latest = now + hoursWindow * 60 * 60 * 1000;
  return matches.filter((match) => {
    const startMs = Date.parse(match.startTs ?? "");
    return Number.isFinite(startMs) && startMs >= now - 60 * 60 * 1000 && startMs <= latest;
  });
}

function readBonusOddsIndexFromDisk(hoursWindow: number) {
  try {
    const file = bonusOddsIndexFile(hoursWindow);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      generatedAt?: number;
      matches?: IndexedBonusOddsMatch[];
    };
    if (!parsed.generatedAt || !Array.isArray(parsed.matches)) return null;
    if (Date.now() - parsed.generatedAt > BONUS_ODDS_INDEX_DISK_MAX_AGE_MS) return null;
    const matches = pruneIndexedBonusMatches(parsed.matches, hoursWindow);
    if (matches.length === 0) return null;
    const entry = {
      generatedAt: parsed.generatedAt,
      // Disk-cache får användas direkt, men refreshas i bakgrunden om TTL är passerad.
      expiresAt: parsed.generatedAt + BONUS_ODDS_INDEX_TTL_MS,
      matches,
    };
    bonusOddsIndexCache.set(hoursWindow, entry);
    return entry;
  } catch (error) {
    console.warn("[bonus-index] disk read failed", error);
    return null;
  }
}

function writeBonusOddsIndexToDisk(hoursWindow: number, generatedAt: number, matches: IndexedBonusOddsMatch[]) {
  try {
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      bonusOddsIndexFile(hoursWindow),
      JSON.stringify({ generatedAt, matches }, null, 2),
      "utf-8",
    );
    console.info(`[bonus-index] wrote ${matches.length} matches for ${hoursWindow}h`);
  } catch (error) {
    console.warn("[bonus-index] disk write failed", error);
  }
}

async function buildBonusOddsIndex(hoursWindow: number, force = false): Promise<IndexedBonusOddsMatch[]> {
  if (force) bonusOddsIndexEmptyCooldownUntil.delete(hoursWindow);
  const cached = bonusOddsIndexCache.get(hoursWindow);
  // Tomt index får inte kortsluta: annars fastnar bonus-API på pending utan att inflight någonsin startar.
  if (!force && cached && cached.expiresAt > Date.now() && cached.matches.length > 0) return cached.matches;
  if (!force) {
    const disk = readBonusOddsIndexFromDisk(hoursWindow);
    if (disk && disk.expiresAt > Date.now() && disk.matches.length > 0) return disk.matches;
  }
  const inflight = bonusOddsIndexInflight.get(hoursWindow);
  if (inflight) return inflight;

  const promise = (async () => {
    const candidates = await buildBonusCandidateMatches(hoursWindow, bonusOddsIndexCandidateLimit(hoursWindow));
    const allIds = [...new Set([...requiredBonusBookmakerIds(DEFAULT_BONUS_PORTFOLIO), "betsson"])];
    const partialMatches: IndexedBonusOddsMatch[] = [];
    const persistPartialIndex = () => {
      const generatedAt = Date.now();
      const sorted = [...partialMatches].sort(
        (a, b) =>
          (b.coverageScore ?? 0) - (a.coverageScore ?? 0) ||
          bonusLeaguePriority(a.league ?? "") - bonusLeaguePriority(b.league ?? "") ||
          (a.startTs ?? "").localeCompare(b.startTs ?? ""),
      );
      bonusOddsIndexCache.set(hoursWindow, {
        expiresAt: generatedAt + BONUS_ODDS_INDEX_TTL_MS,
        generatedAt,
        matches: sorted,
      });
      writeBonusOddsIndexToDisk(hoursWindow, generatedAt, sorted);
    };

    const matches = await mapLimit(candidates, 8, async (candidate): Promise<IndexedBonusOddsMatch | null> => {
      let bookmakerResults = await scrapeBookmakersForMatch(candidate.title, candidate.title, allIds);
      let rows = rowsFromBookmakerResults(bookmakerResults);
      let match: BonusMatch = {
        title: candidate.title,
        startTs: candidate.startTs,
        league: candidate.league,
        odds: fillBonusOddsMatrixFromFallbackGroups(oddsMatrixFromRows(rows)),
      };
      const missingBookmakerIds = missingBonusBookmakerIds(match, DEFAULT_BONUS_PORTFOLIO);
      if (missingBookmakerIds.length > 0) {
        const retryResults = await scrapeBookmakersForMatch(candidate.title, candidate.title, missingBookmakerIds);
        const mergedByBookmaker = new Map(bookmakerResults.map((result) => [result.bookmakerId, result]));
        for (const result of retryResults) mergedByBookmaker.set(result.bookmakerId, result);
        bookmakerResults = [...mergedByBookmaker.values()];
        rows = rowsFromBookmakerResults(bookmakerResults);
        match = {
          title: candidate.title,
          startTs: candidate.startTs,
          league: candidate.league,
          odds: fillBonusOddsMatrixFromFallbackGroups(oddsMatrixFromRows(rows)),
        };
      }
      if (rows.length === 0) return null;
      const oddsFilled = fillBonusOddsMatrixFromFallbackGroups(match.odds);
      const portfolioIds = requiredBonusBookmakerIds(DEFAULT_BONUS_PORTFOLIO);
      const indexedMatch = {
        ...match,
        odds: oddsFilled,
        oddsRows: rows,
        bookmakerResults,
        fairValueReference: fairValueReferenceFromRows(rows),
        coverageScore: portfolioIds.filter((id) => {
          const o = oddsFilled[id];
          return o && o["1"] > 1 && o.X > 1 && o["2"] > 1;
        }).length,
      };
      partialMatches.push(indexedMatch);
      if (partialMatches.length === 1 || partialMatches.length % 4 === 0) persistPartialIndex();
      return indexedMatch;
    });
    const filtered = matches
      .filter((item): item is IndexedBonusOddsMatch => Boolean(item))
      .sort(
        (a, b) =>
          (b.coverageScore ?? 0) - (a.coverageScore ?? 0) ||
          bonusLeaguePriority(a.league ?? "") - bonusLeaguePriority(b.league ?? "") ||
          (a.startTs ?? "").localeCompare(b.startTs ?? ""),
      );
    const generatedAt = Date.now();
    if (filtered.length === 0) {
      bonusOddsIndexEmptyCooldownUntil.set(hoursWindow, Date.now() + BONUS_ODDS_INDEX_EMPTY_COOLDOWN_MS);
      // Skriv aldrig ut ett tomt index — det gav cachad [] med TTL och satte igång eviga rebuilds + evigt "bygger..." i UI.
      // Disk lämnas orörd så tidigare lyckade indexer finns kvar vid tillfälliga scrape-missar.
    } else {
      bonusOddsIndexEmptyCooldownUntil.delete(hoursWindow);
      bonusOddsIndexCache.set(hoursWindow, {
        expiresAt: Date.now() + BONUS_ODDS_INDEX_TTL_MS,
        generatedAt,
        matches: filtered,
      });
      writeBonusOddsIndexToDisk(hoursWindow, generatedAt, filtered);
    }
    return filtered;
  })();

  bonusOddsIndexInflight.set(hoursWindow, promise);
  try {
    return await promise;
  } finally {
    bonusOddsIndexInflight.delete(hoursWindow);
  }
}

function getBonusOddsIndexMatches(hoursWindow: number): Promise<IndexedBonusOddsMatch[]> {
  const cached = bonusOddsIndexCache.get(hoursWindow);
  if (cached && cached.expiresAt > Date.now() && cached.matches.length > 0) {
    return Promise.resolve(cached.matches);
  }
  const disk = readBonusOddsIndexFromDisk(hoursWindow);
  if (disk && disk.expiresAt > Date.now() && disk.matches.length > 0) {
    return Promise.resolve(disk.matches);
  }
  return Promise.resolve([]);
}

function sortOptimizedBonusMatches<T extends { optimization: BonusOptimizationResult; externalComplement?: ExternalComplementPlan | null; fairValueReference?: FairValueReference | null; startTs?: string; matchedCoverageComplete?: boolean }>(items: T[]) {
  return items.sort((a, b) => {
    if (Boolean(a.matchedCoverageComplete) !== Boolean(b.matchedCoverageComplete)) {
      return a.matchedCoverageComplete ? -1 : 1;
    }
    const aWorstEdge = a.externalComplement?.worstCaseEdgePct ?? a.optimization.best.worstCaseEdgePct;
    const bWorstEdge = b.externalComplement?.worstCaseEdgePct ?? b.optimization.best.worstCaseEdgePct;
    const aAverageEdge = a.externalComplement?.averageEdgePct ?? a.optimization.best.averageEdgePct;
    const bAverageEdge = b.externalComplement?.averageEdgePct ?? b.optimization.best.averageEdgePct;
    const aMin = a.externalComplement?.minPayback ?? a.optimization.best.minPayback;
    const bMin = b.externalComplement?.minPayback ?? b.optimization.best.minPayback;
    const aSpread = a.externalComplement?.outcomeSpread ?? a.optimization.best.outcomeSpread;
    const bSpread = b.externalComplement?.outcomeSpread ?? b.optimization.best.outcomeSpread;
    const aAvg = a.externalComplement?.averagePayback ?? a.optimization.best.averagePayback;
    const bAvg = b.externalComplement?.averagePayback ?? b.optimization.best.averagePayback;
    const aStake = a.optimization.best.totalStakePlaced + (a.externalComplement?.totalStake ?? 0);
    const bStake = b.optimization.best.totalStakePlaced + (b.externalComplement?.totalStake ?? 0);
    const aSoftWorst = aWorstEdge - softSpreadPenaltyPct(aSpread, aStake);
    const bSoftWorst = bWorstEdge - softSpreadPenaltyPct(bSpread, bStake);
    const aSoftAverage = aAverageEdge - softSpreadPenaltyPct(aSpread, aStake);
    const bSoftAverage = bAverageEdge - softSpreadPenaltyPct(bSpread, bStake);
    const aFair = a.fairValueReference?.score ?? 1;
    const bFair = b.fairValueReference?.score ?? 1;
    const aMeetsWorst = aWorstEdge >= -5;
    const bMeetsWorst = bWorstEdge >= -5;
    if (aMeetsWorst !== bMeetsWorst) return aMeetsWorst ? -1 : 1;
    if (aSoftWorst !== bSoftWorst) return bSoftWorst - aSoftWorst;
    if (aWorstEdge !== bWorstEdge) return bWorstEdge - aWorstEdge;
    const aMeetsEdge = aAverageEdge >= -5;
    const bMeetsEdge = bAverageEdge >= -5;
    if (aMeetsEdge !== bMeetsEdge) return aMeetsEdge ? -1 : 1;
    if (aSoftAverage !== bSoftAverage) return bSoftAverage - aSoftAverage;
    if (aAverageEdge !== bAverageEdge) return bAverageEdge - aAverageEdge;
    return bAvg - aAvg || bFair - aFair || aSpread - bSpread || bMin - aMin || (a.startTs ?? "").localeCompare(b.startTs ?? "");
  });
}

function optimizeIndexedBonusMatches(
  indexed: IndexedBonusOddsMatch[],
  portfolio: BonusPortfolio,
  method: OptimizationMethod,
  top: number,
  tolerance: DistributionTolerance,
  strategy: BonusMatchStrategy,
) {
  const indexedFilled = indexed.map((raw) => ({
    ...raw,
    // 1) Fyll bara COVERADE syster-brands (ingen spök-coverage). 2) Släng odds
    //    som grovt motsäger konsensus (datafel / hemma-borta-flip) så optimeraren
    //    inte rankar felaktiga odds högst.
    odds: dropMisalignedBookmakerOdds(fillBonusOddsMatrixFromFallbackGroups(raw.odds)),
  }));
  const activeEnabledMatched = portfolio.matched.filter((bonus) => bonus.enabled);
  const activeMatchedCount = activeEnabledMatched.length;
  const activeMatchedIds = activeEnabledMatched.map((bonus) => bonus.id);
  const completeIndexed = indexedFilled.filter((item) => activeMatchedIds.every((id) => item.odds[id]));
  const basePool = completeIndexed.length >= 3 ? completeIndexed : indexedFilled;
  const optimizationPool = basePool.slice(0, strategy === "split" ? 6 : 8);
  const singles = optimizationPool.flatMap((item) => {
    const placeableMatchedCount = activeEnabledMatched.filter((bonus) => item.odds[bonus.id]).length;
    const minMatchedBets = Math.max(1, Math.min(activeMatchedCount, 6, placeableMatchedCount));
    const missingMatchedIds = missingMatchedBonusBookmakerIds(item, portfolio);
    const missingBookmakerIds = missingBonusBookmakerIds(item, portfolio);
    const unavailableBookmakerIds = unavailableBonusBookmakerIds(item.bookmakerResults, missingBookmakerIds);
    const disabledIds = [...new Set([...missingBookmakerIds, ...unavailableBookmakerIds])];
    const effectivePortfolio = disabledIds.length > 0 ? disabledBonusPortfolio(portfolio, disabledIds) : portfolio;
    const optimization = optimizeBonusMatch(item, effectivePortfolio, method, tolerance);
    if (!optimization) return [];
    if (optimization.best.matched.length < minMatchedBets) return [];
    return [{
      ...item,
      optimization,
      externalComplement: null,
      matchedCoverageComplete: missingMatchedIds.length === 0,
      unavailableBookmakerIds: disabledIds,
      staleBookmakerIds: item.bookmakerResults.filter((result) => result.stale).map((result) => result.bookmakerId as BonusBookmakerId),
      mirroredBookmakerIds: item.bookmakerResults.filter((result) => result.mirroredFromBookmakerId).map((result) => result.bookmakerId as BonusBookmakerId),
      mirroredBookmakers: item.bookmakerResults
        .filter((result) => result.mirroredFromBookmakerId)
        .map((result) => ({
          bookmakerId: result.bookmakerId,
          bookmaker: result.bookmaker,
          fromBookmakerId: result.mirroredFromBookmakerId,
          fromBookmaker: result.mirroredFromBookmaker,
        })),
    }];
  });

  const completeSingles = singles.filter((item) => item.matchedCoverageComplete);
  const singlePool = completeSingles.length >= Math.min(top, 10) ? completeSingles : singles;

  if (strategy !== "split") return sortOptimizedBonusMatches(singlePool).slice(0, top);

  const splitCandidates = sortOptimizedBonusMatches([...singlePool]).slice(0, 2);
  const splitEvaluated = [];
  for (let i = 0; i < splitCandidates.length; i++) {
    for (let j = i + 1; j < splitCandidates.length; j++) {
      const first = splitCandidates[i];
      const second = splitCandidates[j];
      const optimization = optimizeBonusMatchSplit([first, second], portfolio, method, tolerance);
      if (!optimization) continue;
      splitEvaluated.push({
        title: `${first.title} / ${second.title}`,
        startTs: first.startTs,
        league: "Två matcher",
        odds: first.odds,
        splitMatches: [
          { title: first.title, startTs: first.startTs, league: first.league, odds: first.odds },
          { title: second.title, startTs: second.startTs, league: second.league, odds: second.odds },
        ],
        optimization,
        externalComplement: null,
        fairValueReference: {
          source:
            first.fairValueReference?.source === "pinnacle-smarkets" || second.fairValueReference?.source === "pinnacle-smarkets"
              ? "pinnacle-smarkets"
              : "market-consensus",
          score: ((first.fairValueReference?.score ?? 1) + (second.fairValueReference?.score ?? 1)) / 2,
          fairOdds: {},
        } satisfies FairValueReference,
        unavailableBookmakerIds: [
          ...new Set([...(first.unavailableBookmakerIds ?? []), ...(second.unavailableBookmakerIds ?? [])]),
        ],
        staleBookmakerIds: [...new Set([...(first.staleBookmakerIds ?? []), ...(second.staleBookmakerIds ?? [])])],
        mirroredBookmakerIds: [
          ...new Set([...(first.mirroredBookmakerIds ?? []), ...(second.mirroredBookmakerIds ?? [])]),
        ],
        mirroredBookmakers: [...(first.mirroredBookmakers ?? []), ...(second.mirroredBookmakers ?? [])],
      });
    }
  }
  return sortOptimizedBonusMatches([...singlePool, ...splitEvaluated]).slice(0, top);
}

async function buildBestBonusMatches(
  portfolio: BonusPortfolio,
  method: OptimizationMethod,
  hoursWindow = 72,
  top = 10,
  tolerance: DistributionTolerance = DEFAULT_DISTRIBUTION_TOLERANCE,
  strategy: BonusMatchStrategy = "single",
) {
  const cacheKey = bonusPortfolioSearchCacheKey(portfolio, method, hoursWindow, top, tolerance, strategy);
  const cached = bestBonusMatchesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.matches;

  const indexed = await getBonusOddsIndexMatches(hoursWindow);
  if (indexed.length > 0) {
    const indexedMatches = optimizeIndexedBonusMatches(indexed, portfolio, method, top, tolerance, strategy);
    if (indexedMatches.length > 0) {
      bestBonusMatchesCache.set(cacheKey, { expiresAt: Date.now() + BEST_BONUS_MATCHES_CACHE_TTL_MS, matches: indexedMatches });
      // Persistera senaste resultat → instant efter omstart (SWR).
      persistBonusOptimizerResultToDisk(cacheKey, indexedMatches);
      return indexedMatches;
    }
  }

  bestBonusMatchesCache.delete(cacheKey);
  return [];
}

type PrewarmStatusKind = "idle" | "running" | "ready" | "failed" | "stale";
type PrewarmStatus = {
  status: PrewarmStatusKind;
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  matchesCount: number;
  windowsLoaded: number[];
  errorMessage: string | null;
};
const prewarmStatus: PrewarmStatus = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  lastSuccessAt: null,
  ageSeconds: null,
  matchesCount: 0,
  windowsLoaded: [],
  errorMessage: null,
};

function getPrewarmStatusSnapshot(): PrewarmStatus {
  // Beräkna ageSeconds från lastSuccessAt vid läsning för att alltid ge aktuell ålder.
  let ageSeconds: number | null = null;
  if (prewarmStatus.lastSuccessAt) {
    const ms = Date.parse(prewarmStatus.lastSuccessAt);
    if (Number.isFinite(ms)) ageSeconds = Math.floor((Date.now() - ms) / 1000);
  }
  // "stale" = senaste success var äldre än 2× intervallet (= 20 min) men inte running/failed
  let status = prewarmStatus.status;
  if (status === "ready" && ageSeconds !== null && ageSeconds > (BEST_BONUS_PREWARM_INTERVAL_MS * 2) / 1000) {
    status = "stale";
  }
  // Räkna current matches från in-memory cache så frontend ser alltid senast lästa antal.
  const cached24 = bonusOddsIndexCache.get(24);
  const matchesCount = cached24?.matches.length ?? prewarmStatus.matchesCount;
  return { ...prewarmStatus, status, ageSeconds, matchesCount };
}

async function prewarmBestBonusMatchesCache() {
  if (bestBonusPrewarmRunning) return;
  bestBonusPrewarmRunning = true;
  prewarmStatus.status = "running";
  prewarmStatus.startedAt = new Date().toISOString();
  prewarmStatus.finishedAt = null;
  prewarmStatus.errorMessage = null;
  // Skriv summary av föregående cykels bookmaker-fel (om några), och börja om räknaren.
  resetBookmakerDebugLog();
  const loadedWindows: number[] = [];
  let healthy = false; // 24h-indexet (det valuebets + optimeraren default använder) byggdes och har matcher
  try {
    const secondaryWindows = [48, 72] as const;
    const secondary = secondaryWindows[bestBonusPrewarmSecondaryIndex % secondaryWindows.length];
    bestBonusPrewarmSecondaryIndex += 1;
    console.info("[bonus-prewarm] startar build för 24h…");
    const matches24 = await buildBonusOddsIndex(24, true);
    loadedWindows.push(24);
    prewarmStatus.matchesCount = matches24.length;
    healthy = matches24.length > 0;
    console.info(`[bonus-prewarm] 24h klar (${matches24.length} matcher)`);
    if (secondary !== 24) {
      console.info(`[bonus-prewarm] startar build för ${secondary}h…`);
      const matchesSecondary = await buildBonusOddsIndex(secondary, true);
      loadedWindows.push(secondary);
      console.info(`[bonus-prewarm] ${secondary}h klar (${matchesSecondary.length} matcher)`);
    }
    prewarmStatus.status = "ready";
    prewarmStatus.lastSuccessAt = new Date().toISOString();
    prewarmStatus.windowsLoaded = loadedWindows;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn("[bonus-prewarm] failed", msg);
    prewarmStatus.status = "failed";
    prewarmStatus.errorMessage = msg;
  } finally {
    prewarmStatus.finishedAt = new Date().toISOString();
    bestBonusPrewarmRunning = false;
    // Självläkning: tunt/tomt index eller fel → snabb-retry i stället för att
    // vänta hela 10-min-intervallet (så indexet läker i bakgrunden, inte på
    // besökarens återkomst).
    if (!healthy && !bestBonusPrewarmRetryScheduled) {
      bestBonusPrewarmRetryScheduled = true;
      setTimeout(() => {
        bestBonusPrewarmRetryScheduled = false;
        void prewarmBestBonusMatchesCache();
      }, BEST_BONUS_PREWARM_RETRY_MS);
      console.warn(
        `[bonus-prewarm] ohälsosamt index (0 matcher / fel) — snabb-retry om ${Math.round(BEST_BONUS_PREWARM_RETRY_MS / 1000)}s`,
      );
    }
  }
}

function startBestBonusMatchesPrewarm() {
  if (bestBonusPrewarmTimer) return;
  // 15s (förr 3s): response-cache-värmarna (5s) ska hinna bygga första
  // valuebets/sources-svaren INNAN det fleminuters CPU-tunga index-bygget
  // börjar — annars är sajten seg för första besökarna efter varje deploy.
  setTimeout(() => void prewarmBestBonusMatchesCache(), 15_000);
  bestBonusPrewarmTimer = setInterval(() => void prewarmBestBonusMatchesCache(), BEST_BONUS_PREWARM_INTERVAL_MS);
}

// ── Optimeraren: håll SENAST ANVÄNDA portföljen varm ───────────────────────
// Prewarmen ovan bygger bara bonus-INDEXET. Optimeringen (best-bonus-matches)
// är nycklad på portföljen och förvärmdes ALDRIG för din portfölj → varje
// första laddning efter inaktivitet körde hela optimeringen på nytt ("Söker…").
// Vi sparar senast använda parametrar och håller deras resultat varmt i
// bakgrunds-loopen, så handlerns cache-träff serverar färdigt resultat direkt.
type BonusOptimizerWarmParams = {
  portfolio: BonusPortfolio;
  method: OptimizationMethod;
  hoursWindow: number;
  top: number;
  tolerance: DistributionTolerance;
  strategy: BonusMatchStrategy;
};
let lastBonusOptimizerParams: BonusOptimizerWarmParams | null = null;
const BONUS_OPTIMIZER_LAST_FILE = path.join(BONUS_CACHE_DIR, "bonus-optimizer-last-params.json");
// Senast FÄRDIGBERÄKNADE optimerings-RESULTAT (inte bara parametrarna). Persisteras
// så att första besöket EFTER en omstart serveras direkt ur disken (SWR) i stället
// för "bygger i bakgrunden… 0 förslag". Speglar valuebets/finder-mönstret.
const BONUS_OPTIMIZER_RESULT_FILE = path.join(BONUS_CACHE_DIR, "bonus-optimizer-last-result.json");

function persistBonusOptimizerResultToDisk(cacheKey: string, matches: unknown[]): void {
  try {
    if (!Array.isArray(matches) || matches.length === 0) return;
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      BONUS_OPTIMIZER_RESULT_FILE,
      JSON.stringify({ cacheKey, matches, builtAt: Date.now() }),
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Läs in senast sparade optimerings-resultat vid boot och lägg det i RAM-cachen
 * som "redan utgånget" → /api/best-bonus-matches serverar det DIREKT (endpointen
 * struntar i expiry), medan warm-loopen bygger ett färskt i bakgrunden och
 * skriver över. Inga "bygger i bakgrunden"-tomma sidor efter en omstart.
 */
function loadBonusOptimizerResultFromDisk(): void {
  try {
    if (!fs.existsSync(BONUS_OPTIMIZER_RESULT_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(BONUS_OPTIMIZER_RESULT_FILE, "utf-8")) as {
      cacheKey?: string;
      matches?: unknown[];
    };
    if (typeof parsed?.cacheKey === "string" && Array.isArray(parsed.matches) && parsed.matches.length > 0) {
      // expiresAt i det förflutna → endpointen serverar det, men buildBestBonusMatches
      // ser det som utgånget och bygger om (äkta stale-while-revalidate).
      bestBonusMatchesCache.set(parsed.cacheKey, { expiresAt: Date.now() - 1, matches: parsed.matches });
      console.log(`[bonus-optimizer] läste in senaste resultat vid boot (${parsed.matches.length} förslag) — serveras direkt`);
    }
  } catch {
    /* ignorera — warm-loopen bygger ändå */
  }
}

function recordBonusOptimizerParams(p: BonusOptimizerWarmParams): void {
  try {
    const json = JSON.stringify(p);
    if (lastBonusOptimizerParams && JSON.stringify(lastBonusOptimizerParams) === json) return;
    lastBonusOptimizerParams = p;
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(BONUS_OPTIMIZER_LAST_FILE, json, "utf-8");
  } catch {
    /* best-effort */
  }
}

function loadBonusOptimizerParamsFromDisk(): void {
  try {
    if (!fs.existsSync(BONUS_OPTIMIZER_LAST_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(BONUS_OPTIMIZER_LAST_FILE, "utf-8")) as BonusOptimizerWarmParams;
    if (parsed && parsed.portfolio && parsed.method) {
      lastBonusOptimizerParams = parsed;
      console.log("[bonus-optimizer] läste in senast använda portfölj-parametrar vid boot (förvärms)");
    }
  } catch {
    /* ignorera */
  }
}

/** Håll senast använda portföljens optimering varm (anropas från warm-loopen). */
async function warmBonusOptimizer(): Promise<void> {
  const p = lastBonusOptimizerParams;
  if (!p) return;
  await buildBestBonusMatches(p.portfolio, p.method, p.hoursWindow, p.top, p.tolerance, p.strategy);
}

async function prewarmStatusDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/prewarm-status") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }
  const snapshot = getPrewarmStatusSnapshot();
  res.statusCode = 200;
  res.end(
    JSON.stringify({
      ok: true,
      ...snapshot,
      intervalMs: BEST_BONUS_PREWARM_INTERVAL_MS,
    }),
  );
}

async function rebuildBonusIndexDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/rebuild-bonus-index") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }

  try {
    const body = await readRequestBody(req);
    const parsed = (body ? JSON.parse(body) : {}) as { hours?: number };
    const hoursRaw = Number(parsed.hours ?? 24);
    const hoursWindow = ([24, 48, 72] as const).includes(hoursRaw as 24 | 48 | 72) ? hoursRaw : 24;
    if (bonusOddsIndexInflight.has(hoursWindow)) {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, hours: hoursWindow, status: "already-running" }));
      return;
    }
    void buildBonusOddsIndex(hoursWindow, true).catch((error) => console.warn("[bonus-index] manual rebuild failed", error));
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, hours: hoursWindow, status: "started" }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown rebuild error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/**
 * Rikta en 1X2-triple mot en mål-titels lag-ordning via lag-identitet. Källans
 * home/draw/away hör ihop med (sourceHome, sourceAway). Om målet listar lagen i
 * omvänd ordning swappar vi home↔away (draw oförändrad). Returnerar null om
 * sidorna inte kan matchas ENTYDIGT (varken eller båda) → då hellre ingen
 * täckning än fel-riktad täckning.
 */
function alignTripleToTitle(
  targetTitle: string,
  sourceHomeTeam: string,
  sourceAwayTeam: string,
  home: number,
  draw: number,
  away: number,
): { home: number; draw: number; away: number } | null {
  const tSides = getMatchSideTokens(targetTitle);
  const sSides = getMatchSideTokens(`${sourceHomeTeam} - ${sourceAwayTeam}`);
  if (tSides.length < 2 || sSides.length < 2) return null;
  const direct = sideMatches(tSides[0], sSides[0]) && sideMatches(tSides[1], sSides[1]);
  const reversed = sideMatches(tSides[0], sSides[1]) && sideMatches(tSides[1], sSides[0]);
  if (direct === reversed) return null; // tvetydigt (eller ingen match) → hoppa
  return reversed ? { home: away, draw, away: home } : { home, draw, away };
}

/**
 * Bygg täckningsrader (1X2) för en match ENBART från Pinnacle + Smarkets, riktade
 * mot matchens lag-ordning. Detta är bonus-optimerarens enda tillåtna täcknings-
 * sidor — uttagbara sharp/exchange-marknader vars utfall aldrig blandas ihop.
 */
function buildSharpCoverRowsForTitle(
  title: string,
  pinnacleRows: PinnacleRow[],
  smarketsRows: SmarketsRow[],
): Array<OddsRow & { bookmakerId: string }> {
  const out: Array<OddsRow & { bookmakerId: string }> = [];

  const pin = pinnacleRows.find((p) => {
    if (!p.match) return false;
    try { return isLikelySameMatch(p.match, title); } catch { return false; }
  });
  if (pin && pin.drawOdds != null && pin.homeOdds > 1 && pin.drawOdds > 1 && pin.awayOdds > 1) {
    const sides = pin.match.split(/\s+-\s+/);
    const aligned = alignTripleToTitle(title, sides[0] ?? "", sides[1] ?? "", pin.homeOdds, pin.drawOdds, pin.awayOdds);
    if (aligned) out.push({ bookmakerId: "pinnacle", bookmaker: "Pinnacle", ...aligned });
  }

  const smk = smarketsRows.find((s) => {
    try { return isLikelySameMatch(s.title, title); } catch { return false; }
  });
  if (smk && smk.odds.draw != null && smk.odds.home > 1 && (smk.odds.draw ?? 0) > 1 && smk.odds.away > 1) {
    const aligned = alignTripleToTitle(title, smk.homeTeam, smk.awayTeam, smk.odds.home, smk.odds.draw, smk.odds.away);
    if (aligned) out.push({ bookmakerId: "smarkets", bookmaker: "Smarkets", ...aligned });
  }

  return out;
}

async function buildContinuationMatches(
  accounts: WageringAccount[],
  vouchers: FreebetVoucher[],
  hoursWindow = 72,
  top = 5,
  wageringMinOdds?: number,
) {
  const candidateLimit = bonusCandidateLimit(hoursWindow);
  const candidates = await buildBonusCandidateMatches(hoursWindow, candidateLimit);
  const requiredIds = continuationRequiredBookmakerIds(accounts, vouchers);

  // TÄCKNING = ENBART Pinnacle + Smarkets (uttagbara, sharp/exchange-sidor).
  // Tidigare breddades täckningen till ALLA bookmakers, men då kunde olika
  // bookmakers home/away-orientering skilja sig → utfall blandades ihop och gav
  // "orimligt bra" täckningsodds (t.ex. Nasarawa United vs Ikorodu City). Genom
  // att bara täcka på de två trovärdiga sharp-källorna — och rikta deras odds
  // mot matchens lag-ordning via lag-identitet — kan utfall aldrig blandas.
  // Bonus: vi slipper scrapa hela bookmaker-poolen per match → Dag 2/3 blir
  // dramatiskt snabbare (kunden slipper vänta).
  const [pinnacleMoneylineRows, smarketsSoccerRows] = await Promise.all([
    buildPinnacleRowsWithMeta()
      .then((m) =>
        m.rows.filter(
          (r) =>
            r.sport === "soccer" &&
            r.marketType === "moneyline" &&
            Number.isFinite(r.drawOdds) &&
            (r.drawOdds ?? 0) > 1 &&
            (r.homeOdds ?? 0) > 1 &&
            (r.awayOdds ?? 0) > 1,
        ),
      )
      .catch(() => [] as PinnacleRow[]),
    loadSmarketsPayloadWithMeta()
      .then((m) =>
        smarketsAllRows(m.payload).filter(
          (r) =>
            (r.sport ?? "soccer") === "soccer" &&
            r.odds.home > 1 &&
            (r.odds.draw ?? 0) > 1 &&
            r.odds.away > 1,
        ),
      )
      .catch(() => [] as SmarketsRow[]),
  ]);

  const evaluated = await mapLimit(candidates, 4, async (candidate) => {
    const bookmakerResults = await scrapeBookmakersForMatch(candidate.title, candidate.title, requiredIds);
    const rows = rowsFromBookmakerResults(bookmakerResults);
    const match: BonusMatch = {
      title: candidate.title,
      startTs: candidate.startTs,
      league: candidate.league,
      odds: oddsMatrixFromRows(rows),
    };

    // Täckningsrader = Pinnacle + Smarkets, riktade mot matchens lag-ordning.
    const complementRows = buildSharpCoverRowsForTitle(candidate.title, pinnacleMoneylineRows, smarketsSoccerRows);

    const bestExternalOdds = bestExternalOddsByOutcome(complementRows);
    const result = optimizeContinuationMatch(match, accounts, vouchers, {
      strategy: "same-match",
      bestExternalOdds,
      ...(wageringMinOdds && wageringMinOdds > 0 ? { wageringMinOdds } : {}),
    });
    if (!result) return null;
    // Vilka matched-KONTON (inte hela systergruppen) saknar odds på just denna match,
    // ens efter systerbrand-spegling? De kontona kan inte spelas här och utesluts ur planen.
    // Vi exponerar dem så att (a) coverage-sorteringen kan föredra matcher som täcker ALLA
    // konton, och (b) klienten kan visa en varning om en sajt ändå måste uteslutas.
    const missingAccountBookmakers = accounts
      .filter((account) => !match.odds[account.bookmakerId])
      .map((account) => ({ bookmakerId: account.bookmakerId, bookmaker: account.bookmaker }));
    return {
      ...match,
      oddsRows: rows,
      bookmakerResults,
      optimization: result,
      missingAccountBookmakers,
      unavailableBookmakerIds: requiredIds.filter((id) => !match.odds[id]),
      staleBookmakerIds: bookmakerResults
        .filter((item) => item.stale)
        .map((item) => item.bookmakerId as BonusBookmakerId),
      mirroredBookmakerIds: bookmakerResults
        .filter((item) => item.mirroredFromBookmakerId)
        .map((item) => item.bookmakerId as BonusBookmakerId),
      mirroredBookmakers: bookmakerResults
        .filter((item) => item.mirroredFromBookmakerId)
        .map((item) => ({
          bookmakerId: item.bookmakerId,
          bookmaker: item.bookmaker,
          fromBookmakerId: item.mirroredFromBookmakerId,
          fromBookmaker: item.mirroredFromBookmaker,
        })),
    };
  });

  return evaluated
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    // COVERAGE FÖRST: föredra matcher som täcker ALLA matched-konton (90% av fallen finns
    // en sådan match). Bara om ingen full-täckning finns rullar vi ner till matcher som
    // saknar en sajt — och då bär matchen med sig `missingAccountBookmakers` så klienten
    // kan varna om att den sajten måste kompletteras separat via Bonus Findern.
    .sort((a, b) => {
      const missDiff = a.missingAccountBookmakers.length - b.missingAccountBookmakers.length;
      if (missDiff !== 0) return missDiff;
      return compareContinuationPlans(a.optimization.best, b.optimization.best);
    })
    .slice(0, top);
}

// Kort cache + in-flight-dedup för Dag 2/3-optimeringen så kunden inte behöver
// vänta om på samma beräkning (t.ex. navigera fram/tillbaka eller klicka igen).
type ContinuationMatchesResult = Awaited<ReturnType<typeof buildContinuationMatches>>;
const continuationMatchesCache = new Map<string, { expiresAt: number; matches: ContinuationMatchesResult }>();
const continuationMatchesInflight = new Map<string, Promise<ContinuationMatchesResult>>();
const CONTINUATION_CACHE_TTL_MS = 90_000;

async function getContinuationMatchesCached(
  accounts: WageringAccount[],
  vouchers: FreebetVoucher[],
  hoursWindow: number,
  top: number,
  wageringMinOdds?: number,
): Promise<ContinuationMatchesResult> {
  const key = JSON.stringify({ accounts, vouchers, hoursWindow, top, wageringMinOdds: wageringMinOdds ?? 0 });
  const now = Date.now();
  const cached = continuationMatchesCache.get(key);
  if (cached && cached.expiresAt > now) return cached.matches;
  const inflight = continuationMatchesInflight.get(key);
  if (inflight) return inflight;
  const promise = buildContinuationMatches(accounts, vouchers, hoursWindow, top, wageringMinOdds)
    .then((matches) => {
      continuationMatchesCache.set(key, { expiresAt: Date.now() + CONTINUATION_CACHE_TTL_MS, matches });
      continuationMatchesInflight.delete(key);
      // Håll cachen liten.
      if (continuationMatchesCache.size > 50) {
        const oldest = [...continuationMatchesCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
        if (oldest) continuationMatchesCache.delete(oldest[0]);
      }
      return matches;
    })
    .catch((error) => {
      continuationMatchesInflight.delete(key);
      throw error;
    });
  continuationMatchesInflight.set(key, promise);
  return promise;
}

async function parseOddsRowsFromSupportedUrl(targetUrl: string) {
  if (isOneXTwoKambiUrl(targetUrl)) {
    return await parseOddsRowsFromOneXTwoKambi(targetUrl);
  }
  if (isBetssonSportsbookUrl(targetUrl)) {
    return await parseOddsRowsFromBetssonSportsbook(targetUrl);
  }
  if (isComeOnSportsbookUrl(targetUrl)) {
    return await parseOddsRowsFromComeOnSportsbook(targetUrl);
  }

  const html = await fetchHtml(targetUrl);
  let rows = parseOddsRowsFromHtml(html);
  if (rows.length === 0 && targetUrl.includes("oddsportal.com")) {
    rows = await parseOddsRowsFromOddsPortalMatch(html, targetUrl);
  }
  return {
    rows,
    title: /<title>(.*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "",
  };
}

async function scrapeSearchOdds(
  query: string,
  matches: Array<{ title: string; url: string }>,
  targetTitle?: string,
  targetUrl?: string,
) {
  const urls = new Set<string>();
  const targetMatch = targetTitle ? { title: targetTitle, url: targetUrl ?? "" } : matches[0];
  if (targetUrl && /^https?:\/\//i.test(targetUrl)) urls.add(targetUrl);
  if (!targetUrl && targetMatch?.url && /^https?:\/\//i.test(targetMatch.url)) urls.add(targetMatch.url);
  if (shouldUseKnownPsgBayernPartnerLinks(query, matches, targetTitle)) {
    KNOWN_PSG_BAYERN_PARTNER_URLS.forEach((url) => urls.add(url));
  }
  const discoveredUrls = await discoverPartnerUrlsForSearch(query, matches, targetTitle);
  discoveredUrls.forEach((url) => urls.add(url));

  const settled = await Promise.allSettled([...urls].map((url) => parseOddsRowsFromSupportedUrl(url)));
  const successful = settled
    .filter((result): result is PromiseFulfilledResult<{ rows: Array<{ bookmaker: string; home: number; draw: number; away: number }>; title: string }> => result.status === "fulfilled")
    .map((result) => result.value);

  const alignmentTargetTitle = targetTitle ?? targetMatch?.title;
  const matchingResults = alignmentTargetTitle
    ? successful.filter((result) => !result.title || isLikelySameMatch(result.title, alignmentTargetTitle))
    : successful;
  const rows = mergeOddsRows(
    matchingResults.flatMap((result) => alignOddsRowsToTargetTitle(result.rows, result.title, alignmentTargetTitle)),
  );
  const title = targetTitle ?? matchingResults.find((result) => result.title)?.title ?? targetMatch?.title ?? "";
  return { rows, title };
}

/** Dev-only: finds top Dag 1 bonus-consumption matches for the configured portfolio. */
async function bestBonusMatchesDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/best-bonus-matches") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }

  try {
    const body = await readRequestBody(req);
    const parsed = (body ? JSON.parse(body) : {}) as {
      portfolio?: BonusPortfolio;
      method?: OptimizationMethod;
      /** Kommande matcher vars starttid ligger inom detta antal timmar från nu. */
      hours?: number;
      /** @deprecated Använd `hours` (dagar × 24 översätts server-side om `hours` saknas). */
      days?: number;
      top?: number;
      tolerance?: DistributionTolerance | string;
      strategy?: BonusMatchStrategy | string;
    };
    const portfolio = parsed.portfolio ?? DEFAULT_BONUS_PORTFOLIO;
    const method = parsed.method ?? "strict-balance";
    const toleranceRaw = parsed.tolerance;
    const tolerance: DistributionTolerance =
      toleranceRaw === "free"
        ? "free"
        : toleranceRaw === 0 || toleranceRaw === "0"
          ? 0
          : toleranceRaw === 2 || toleranceRaw === "2"
            ? 2
            : toleranceRaw === 1 || toleranceRaw === "1"
              ? 1
              : DEFAULT_DISTRIBUTION_TOLERANCE;
    const ALLOWED_HOURS = [24, 48, 72] as const;
    let hoursWindow: number;
    const hoursRaw = Number(parsed.hours);
    if (ALLOWED_HOURS.includes(hoursRaw as 24 | 48 | 72)) {
      hoursWindow = hoursRaw;
    } else if (parsed.days != null && Number.isFinite(Number(parsed.days)) && Number(parsed.days) > 0) {
      const legacyDays = Math.min(Math.max(Number(parsed.days), 1), 14);
      const approx = legacyDays * 24;
      hoursWindow = ALLOWED_HOURS.reduce((best, h) =>
        Math.abs(h - approx) < Math.abs(best - approx) ? h : best,
      72);
    } else {
      hoursWindow = 72;
    }
    const top = Math.min(Math.max(Number(parsed.top ?? 10), 1), 10);
    const strategy: BonusMatchStrategy = parsed.strategy === "split" ? "split" : "single";
    const cacheKey = bonusPortfolioSearchCacheKey(portfolio, method, hoursWindow, top, tolerance, strategy);
    // Spara senast använda portfölj så bakgrunds-loopen kan hålla den varm →
    // nästa laddning (även efter lång inaktivitet) serveras direkt ur cachen.
    recordBonusOptimizerParams({ portfolio, method, hoursWindow, top, tolerance, strategy });
    const cached = bestBonusMatchesCache.get(cacheKey);
    if (cached) {
      const matches = cached.matches;
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, method, hours: hoursWindow, tolerance, strategy, cached: true, count: matches.length, matches }));
      return;
    }

    const indexed = await getBonusOddsIndexMatches(hoursWindow);
    const quickMatches = indexed.length > 0
      ? optimizeIndexedBonusMatches(indexed.slice(0, 8), portfolio, method, top, tolerance, "single")
      : [];
    let matches = quickMatches;
    if (matches.length === 0 && hoursWindow !== 24) {
      const fallbackIndexed = await getBonusOddsIndexMatches(24);
      matches = fallbackIndexed.length > 0
        ? optimizeIndexedBonusMatches(fallbackIndexed.slice(0, 8), portfolio, method, top, tolerance, "single")
        : [];
    }

    // Starta index-bygg endast när cache/disk saknar rader för valt fönster.
    // Att trigga 24h-bygg bara för att optimeringen gav <5 förslag dubblerade scrape-jobb
    // och höll UI kvar på "bygger i bakgrunden..." i onödan.
    const triggerBackgroundBuild = (window: number) => {
      if (bonusOddsIndexInflight.has(window)) return;
      if ((bonusOddsIndexEmptyCooldownUntil.get(window) ?? 0) > Date.now()) return;
      void buildBonusOddsIndex(window).catch((error) =>
        console.warn(`[bonus-index] auto rebuild for ${window}h failed`, error),
      );
    };
    if (indexed.length === 0) triggerBackgroundBuild(hoursWindow);

    const buildInProgress = bonusOddsIndexInflight.has(hoursWindow);
    /** Polling ska bara pågå medan index faktiskt byggs — inte för alltid när count < 5. */
    const pollForMore = buildInProgress;
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        method,
        hours: hoursWindow,
        fallbackHours: matches.length > 0 && hoursWindow !== 24 ? 24 : undefined,
        tolerance,
        strategy,
        preview: true,
        pending: pollForMore,
        building: buildInProgress,
        count: matches.length,
        matches,
      }),
    );
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown bonus optimizer error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

async function bonusContinuationDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/bonus-continuation-matches") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }

  try {
    const body = await readRequestBody(req);
    const parsed = JSON.parse(body) as {
      accounts?: WageringAccount[];
      vouchers?: FreebetVoucher[];
      hours?: number;
      top?: number;
      wageringMinOdds?: number;
    };
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    const vouchers = Array.isArray(parsed.vouchers) ? parsed.vouchers : [];
    const ALLOWED_HOURS = [24, 48, 72] as const;
    const hoursRaw = Number(parsed.hours);
    const hoursWindow = ALLOWED_HOURS.includes(hoursRaw as 24 | 48 | 72) ? hoursRaw : 72;
    const top = Math.min(Math.max(Number(parsed.top ?? 5), 1), 10);
    // "Tappa-matched"-strategi: ≥3.3 odds tvingar matched bets på utfall som
    // troligen INTE inträffar → snabbare exit från omsättningskrav.
    // Klampar 1.01-15 så ingen sätter orimliga värden.
    const wageringMinOddsRaw = Number(parsed.wageringMinOdds ?? 0);
    const wageringMinOdds = Number.isFinite(wageringMinOddsRaw) && wageringMinOddsRaw > 1
      ? Math.min(Math.max(wageringMinOddsRaw, 1.01), 15)
      : undefined;
    const matches = await getContinuationMatchesCached(accounts, vouchers, hoursWindow, top, wageringMinOdds);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, hours: hoursWindow, count: matches.length, wageringMinOdds: wageringMinOdds ?? null, matches }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown continuation optimizer error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

type ValueBetVerification = {
  teamsOk: boolean;
  leagueOk: boolean;
  timeOk: boolean;
  marketOk: boolean;
  startDeltaMs: number | null;
};

type ValueBetEntry = {
  match: string;
  startTs?: string;
  league?: string;
  market: "moneyline" | "total" | "ah" | "eh3" | "corner_total" | "corner_ah";
  /** "soccer" | "basketball". Saknas på fotboll → UI faller tillbaka på pinnacle.sport. */
  sport?: string;
  pinnacle: {
    sport: string;
    tournament?: string;
    startTs?: string;
    /** Pinnacle matchup-id (String(matchupId)). Blir signal.event_id → CLV-join + market_key. */
    eventId?: string;
    odds: Record<string, number>;
    impliedProbs: Record<string, number>;
    overround: number;
    vig: number;
    fairProbs: Record<string, number>;
    fairOdds: Record<string, number>;
    /** Pinnacle max-insats (live likviditet) för marknaden. null om okänd.
     *  Hög = vass/stabil linje (edge att lita på), låg = tunn/osäker (edge svänger). */
    limit: number | null;
  };
  /** Betfair-likviditet (fas 2) + §2 rå orderbok (back/lay/mid för utfallet). null om ingen färsk börs-match. */
  betfair?: { liquidityFactor: number; spreadPct: number | null; matchedVolume: number; back?: number | null; lay?: number | null; mid?: number | null } | null;
  /** Sharp-källor som blandades in i fair price (sbobet/betfair); [] = bara Pinnacle. */
  sharpSources?: string[];
  /** §3: per-källa feed-färskhet vid detektion (global feed-ålder + om färsk nog att blandas). */
  sourceFreshness?: { sbobet?: { age_sec: number | null; fresh: boolean }; betfair?: { age_sec: number | null; fresh: boolean } } | null;
  /** Market Trust Layer: likviditets-grade (PRIOR) + trust-flaggor, så UI:t kan visa
   *  trovärdighet PER valuebet. score null/grade "unknown" = okänt (Unknown ≠ dålig). */
  trust?: { liquidity_score: number | null; liquidity_grade: string; flags: string[]; recommendation: string };
  /** Market Trust Layer: varje sharps INDIVIDUELLA fair odds för detta utfall (tracking/analys).
   *  pinnacle = Pinnacle no-vig (alltid); sbobet/betfair = null om ej matchade. */
  sharpPrices?: { pinnacle: number | null; sbobet: number | null; betfair: number | null };
  bookmakerId: BonusBookmakerId;
  bookmakerName: string;
  outcome: Outcome | "over" | "under" | "ah_home" | "ah_away";
  outcomeLabel: string;
  /** Totals: linjen (t.ex. 2.5). AH: handikapp-linjen ur HEMMA-perspektiv (t.ex. -0.5). */
  line?: number;
  bookmakerOdds: number;
  fairProb: number;
  fairOdds: number;
  ev: number;
  evPct: number;
  verification: ValueBetVerification;
  needsReview: boolean;
  comment: string;
  isValueBet: true;
};

// CONFIG-DRIVEN (system_config-tabellen, fas 0): `let` så refreshAnalyticsConfigFromDb()
// kan uppdatera dem var ~5 min utan omstart. Init = DEFAULT_ANALYTICS_CONFIG = EXAKT de
// gamla hårdkodade värdena → identiskt beteende vid boot. Alla ~30 use-sites är orörda.
/** Min EV för att räknas som värdebet enligt specen. */
let VALUE_BET_EV_THRESHOLD = DEFAULT_ANALYTICS_CONFIG.valueBetEvThreshold;
/** EV över denna nivå flaggas för manuell granskning (sannolikt datafel). */
let VALUE_BET_REVIEW_THRESHOLD = DEFAULT_ANALYTICS_CONFIG.valueBetReviewThreshold;
/** EV över denna nivå avvisas helt — orealistiskt vid Pinnacle-referens. */
let VALUE_BET_REJECT_THRESHOLD = DEFAULT_ANALYTICS_CONFIG.valueBetRejectThreshold;
/** Pinnacle och svenska sidor måste annonsera samma kickoff inom denna tolerans. */
let VALUE_BET_TIME_TOLERANCE_MS = DEFAULT_ANALYTICS_CONFIG.valueBetTimeToleranceMs;

// CONFIG-REFRESH (fas 0): läs system_config från Supabase var ~5 min och uppdatera
// trösklarna ovan + den process-globala analytics-configen. Kastar ALDRIG; om tabellen
// inte finns ännu (innan migrationer körts) behålls defaults → befintligt beteende.
async function refreshAnalyticsConfigFromDb(): Promise<void> {
  if (!ODDS_DB_URL || !ODDS_DB_KEY) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ODDS_DB_READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${ODDS_DB_URL}/rest/v1/system_config?select=key,value`, {
      headers: { apikey: ODDS_DB_KEY, Authorization: `Bearer ${ODDS_DB_KEY}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return; // tabell saknas/ej klar → behåll nuvarande
    const json = await res.json();
    if (!Array.isArray(json)) return;
    const cfg = mergeConfigRows(json as { key: string; value: unknown }[]);
    setAnalyticsConfig(cfg);
    VALUE_BET_EV_THRESHOLD = cfg.valueBetEvThreshold;
    VALUE_BET_REVIEW_THRESHOLD = cfg.valueBetReviewThreshold;
    VALUE_BET_REJECT_THRESHOLD = cfg.valueBetRejectThreshold;
    VALUE_BET_TIME_TOLERANCE_MS = cfg.valueBetTimeToleranceMs;
    PINNACLE_FRESHNESS_THRESHOLD_MS = cfg.pinnacleFreshnessThresholdMs;
    SHARP_FRESHNESS_THRESHOLD_MS = cfg.sharpFreshnessThresholdMs;
  } catch {
    /* behåll nuvarande värden */
  } finally {
    clearTimeout(timer);
  }
}
let analyticsConfigRefreshStarted = false;
/** Starta config-refresh-loopen en gång (idempotent). Anropas från valuebets-bygget. */
function ensureAnalyticsConfigRefresh(): void {
  if (analyticsConfigRefreshStarted) return;
  analyticsConfigRefreshStarted = true;
  void refreshAnalyticsConfigFromDb();
  const t = setInterval(() => void refreshAnalyticsConfigFromDb(), 5 * 60 * 1000);
  (t as { unref?: () => void }).unref?.();
}

/**
 * Favorit-flip-guard mot swap-/sidoswap-artefakter.
 *
 * En ÄKTA value bet har bokmakaren och Pinnacle på samma sida om 50/50 —
 * bokmakaren ligger bara lite efter. Om bokmakaren prissätter selektionen som
 * underdog (implied < 50 %, dvs odds > 2.0) MEN Pinnacle som tydlig favorit
 * (fair > 56 %), är "värdet" nästan alltid en data-/sidoswap (fel spelare↔odds
 * hos någon bok), inte en edge.
 *
 * Verifierat fall (2026-06-10): Unibet/Kambi hade Karl Lee (2.12) och Matt Kuhar
 * (1.64) swappade — Pinnacle OCH Altenar hade Karl Lee som favorit (~1.6). Det
 * gav ett falskt +24 % "value" på Karl Lee @ 2.12. Guarden fångar exakt det.
 */
function isFavoriteFlipArtifact(bookmakerOdds: number, pinnacleFairProb: number): boolean {
  if (!(bookmakerOdds > 1) || !(pinnacleFairProb > 0)) return false;
  const bookImplied = 1 / bookmakerOdds;
  // Tröskel sänkt 0.56 → 0.52 (2026-06-16): ett verkligt fall (Jaime Faria 2.08
  // felkopplad till Zhizhen Zhang som Pinnacle hade på 54.9 %) slank igenom på
  // 0.56-gränsen. Rotorsaken (sida härledd ur titeln i st.f. home/away) är fixad,
  // men guarden behålls som skyddsnät: book säger underdog (<50 %) MEN Pinnacle
  // tydlig favorit (>52 %) = nästan alltid sidoswap, aldrig en äkta edge.
  return bookImplied < 0.5 && pinnacleFairProb > 0.52;
}

/**
 * /api/odds/pinnacle-normalized — returnerar ALLA Pinnacle-odds i normaliserad
 * form (inte filtrerade som valuebets). Används av POD-sidan för att följa
 * marknadens rörelser oavsett om matchen råkar ha edge mot någon scrapad
 * bookmaker just nu.
 *
 * Läser från befintliga Pinnacle-data-källor (disk → GitHub API) via
 * buildPinnacleRowsWithMeta(). Konverterar American → decimal på samma sätt
 * som src/lib/odds/adapters/pinnacleAdapter.ts (men separat implementation
 * eftersom backend och frontend inte delar TypeScript-bundle).
 *
 * Response-format:
 *   {
 *     ok: true,
 *     updatedAt: ISO,
 *     source: "disk" | "github-api" | "github-raw" | "cache" | "empty",
 *     ageSeconds: number | null,
 *     count: number,
 *     rows: NormalizedRow[]
 *   }
 */
async function pinnacleNormalizedDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/odds/pinnacle-normalized") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }

  try {
    // Läs hela Pinnacle-payloaden direkt (rå) — buildPinnacleRowsWithMeta
    // returnerar redan-buildade PinnacleRow[] som är moneyline-fokuserade
    // och tappar O/U + AH-data. Vi vill ha allt → läser disk/github själv.
    const fromGithub = await fetchPinnacleFromGithub().catch(() => null);
    let payload: PinnaclePayload | null = fromGithub;
    let source: "disk" | "github-api" | "github-raw" | "empty" =
      fromGithub ? (pinnacleLastFetchSource === "github-raw" ? "github-raw" : "github-api") : "empty";

    if (!payload) {
      // Fallback till disk
      try {
        if (fs.existsSync(PINNACLE_DATA_FILE)) {
          payload = JSON.parse(fs.readFileSync(PINNACLE_DATA_FILE, "utf-8")) as PinnaclePayload;
          source = "disk";
        }
      } catch (error) {
        console.warn("[pinnacle-normalized] disk read failed:", error);
      }
    }

    if (!payload) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true,
        updatedAt: null,
        source: "empty",
        ageSeconds: null,
        count: 0,
        rows: [],
      }));
      return;
    }

    const rows = pinnaclePayloadToNormalizedRows(payload);
    const ageMs = pinnacleAgeMs(payload.updatedAt ?? null);
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      updatedAt: payload.updatedAt ?? null,
      source,
      ageSeconds: ageMs !== null ? Math.floor(ageMs / 1000) : null,
      count: rows.length,
      rows,
    }));
  } catch (error) {
    console.error("[pinnacle-normalized] error:", error);
    res.statusCode = 500;
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Konvertera Pinnacle-payload till normaliserade rows. Tar alla markets
 * (moneyline, spread, total), period 0/match/all (full time), och alla sport-
 * kategorier (soccer, basketball, tennis, etc).
 *
 * American odds → decimal:
 *   positive (+250) → 3.50    (decimal = price/100 + 1)
 *   negative (-150) → 1.667   (decimal = 100/|price| + 1)
 */
function pinnaclePayloadToNormalizedRows(payload: PinnaclePayload): Array<{
  match: string;
  sport: string;
  league?: string;
  startTime: string;
  market: "moneyline" | "total" | "spread";
  line: number | null;
  selection: "home" | "draw" | "away" | "over" | "under";
  odds: number;
  limit: number | null;
  timestamp: string;
  matchupId: string;
}> {
  const now = new Date().toISOString();
  const out: Array<{
    match: string;
    sport: string;
    league?: string;
    startTime: string;
    market: "moneyline" | "total" | "spread";
    line: number | null;
    selection: "home" | "draw" | "away" | "over" | "under";
    odds: number;
    /** Pinnacle max-insats (likviditet) för marknaden. null om okänd. */
    limit: number | null;
    timestamp: string;
    matchupId: string;
  }> = [];

  const bySport = payload?.bySport ?? {};
  for (const [sportTag, sportData] of Object.entries(bySport)) {
    const matchups = sportData?.matchups ?? [];
    const markets = sportData?.markets ?? [];
    const matchupById = new Map<string, typeof matchups[number]>();
    for (const m of matchups) matchupById.set(String(m.id), m);

    for (const market of markets) {
      const period = String((market as { period?: number | string }).period ?? "0");
      if (period !== "0" && period !== "match" && period !== "all") continue;

      const typeStr = String((market as { type?: string }).type ?? "").toLowerCase();
      let marketType: "moneyline" | "total" | "spread" | null = null;
      if (typeStr === "moneyline") marketType = "moneyline";
      else if (typeStr === "total") marketType = "total";
      else if (typeStr === "spread") marketType = "spread";
      if (!marketType) continue;

      const matchup = matchupById.get(String((market as { matchupId?: number | string }).matchupId));
      if (!matchup) continue;
      const parts = matchup.participants ?? [];
      const home = parts.find((p) => (p.alignment ?? "").toLowerCase() === "home")?.name;
      const away = parts.find((p) => (p.alignment ?? "").toLowerCase() === "away")?.name;
      if (!home || !away) continue;
      const matchStr = `${home} - ${away}`;
      // Pinnacle max-insats (likviditet) per marknad — confidence-signal. Hög =
      // vass/stabil linje, låg = tunn/osäker → edge opålitlig.
      const pinnacleLimit = (() => {
        const l = (market as { limit?: number | null }).limit;
        return typeof l === "number" && Number.isFinite(l) && l > 0 ? l : null;
      })();

      const prices = (market as { prices?: Array<{ designation?: string; points?: number; price?: number | string; decimal?: number | string }> }).prices ?? [];
      for (const price of prices) {
        const designation = (price.designation ?? "").toLowerCase();
        let selection: "home" | "draw" | "away" | "over" | "under" | null = null;
        if (designation === "home") selection = "home";
        else if (designation === "away") selection = "away";
        else if (designation === "draw") selection = "draw";
        else if (designation === "over") selection = "over";
        else if (designation === "under") selection = "under";
        if (!selection) continue;

        // American → decimal
        let decimal: number | null = null;
        if (price.decimal != null) {
          const d = Number(price.decimal);
          if (Number.isFinite(d) && d > 1) decimal = d;
        }
        if (decimal == null && price.price != null) {
          const american = Number(price.price);
          if (Number.isFinite(american)) {
            if (american > 0) decimal = american / 100 + 1;
            else if (american < 0) decimal = 100 / Math.abs(american) + 1;
          }
        }
        if (decimal == null || decimal <= 1) continue;

        out.push({
          match: matchStr,
          sport: sportTag,
          league: matchup.league?.name,
          startTime: matchup.startTime ?? "",
          market: marketType,
          line: typeof price.points === "number" ? price.points : null,
          selection,
          odds: Number(decimal.toFixed(4)),
          limit: pinnacleLimit,
          timestamp: now,
          matchupId: String(matchup.id),
        });
      }
    }
  }
  return out;
}

/**
 * /api/debug/pinnacle — diagnostik-endpoint för Pinnacle-pipelinen.
 *
 * Visar exakt vilken källa Render läser från, hur färsk datan är, och
 * varför valuebets-gate ev. triggar. Säkert att lämna i prod — endast
 * diagnostik, ingen mutation, inga hemligheter.
 */
async function pinnacleDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/pinnacle") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    // Disk-probe: finns filen + hur gammal?
    let diskExists = false;
    let diskUpdatedAt: string | null = null;
    let diskAgeSec: number | null = null;
    let diskRowsLength: number | null = null;
    try {
      if (fs.existsSync(PINNACLE_DATA_FILE)) {
        diskExists = true;
        const stat = fs.statSync(PINNACLE_DATA_FILE);
        const raw = JSON.parse(fs.readFileSync(PINNACLE_DATA_FILE, "utf-8")) as PinnaclePayload;
        diskUpdatedAt = raw.updatedAt ?? null;
        if (raw.updatedAt) {
          const ms = Date.parse(raw.updatedAt);
          if (Number.isFinite(ms)) diskAgeSec = Math.floor((Date.now() - ms) / 1000);
        }
        diskRowsLength = Object.values(raw.bySport ?? {}).reduce(
          (sum, s) => sum + (Array.isArray(s?.matchups) ? s.matchups.length : 0),
          0,
        );
        void stat; // bara för att inte ESLint klagar
      }
    } catch (e) {
      console.warn("[pinnacle-debug] disk probe failed:", e);
    }

    // Aktiv pipeline-läsning (samma som /api/valuebets använder).
    const meta = await buildPinnacleRowsWithMeta();
    const ageMs = meta.updatedAt ? Date.now() - Date.parse(meta.updatedAt) : null;
    const ageSec = ageMs !== null && Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : null;
    const moneylineCount = meta.rows.filter(
      (r) => r.sport === "soccer" && r.marketType === "moneyline" && (r.drawOdds ?? 0) > 1,
    ).length;
    const isFresh = ageMs !== null && ageMs <= PINNACLE_FRESHNESS_THRESHOLD_MS;
    const thresholdSec = Math.round(PINNACLE_FRESHNESS_THRESHOLD_MS / 1000);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        pinnacleStatus: meta.source === "empty"
          ? "missing"
          : ageMs === null
            ? "fresh"
            : isFresh
              ? "fresh"
              : "stale",
        pinnacleAgeSeconds: ageSec,
        lastPinnacleUpdatedAt: meta.updatedAt,
        pinnacleMoneylineCount: moneylineCount,
        cacheSource: meta.source,
        cachePath: PINNACLE_DATA_FILE,
        freshnessThresholdSeconds: thresholdSec,
        isFresh,
        disk: {
          exists: diskExists,
          updatedAt: diskUpdatedAt,
          ageSeconds: diskAgeSec,
          totalMatchups: diskRowsLength,
        },
        github: {
          lastFetchSource: pinnacleLastFetchSource,
          cachedPayloadAge:
            pinnacleGithubCachedAt > 0
              ? Math.floor((Date.now() - pinnacleGithubCachedAt) / 1000)
              : null,
          apiUrl: PINNACLE_GITHUB_API_URL,
          rawUrl: PINNACLE_RAW_GITHUB_URL,
          cacheTtlSeconds: Math.round(PINNACLE_GITHUB_CACHE_TTL_MS / 1000),
        },
        diagnosis: ageSec === null
          ? "Pinnacle has no updatedAt — likely empty/missing source. Check GitHub Actions and data/pinnacle-rows.json in repo."
          : !isFresh
            ? `Pinnacle is ${ageSec}s old (threshold ${thresholdSec}s). Most likely: GitHub Actions workflow stopped committing. Check https://github.com/Lilgunner24/linusgan/actions/workflows/pinnacle-fetch.yml`
            : `Pinnacle is fresh (${ageSec}s old, source=${meta.source}). Pipeline healthy.`,
      }),
    );
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown pinnacle-debug error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/**
 * /api/sources/status — aggregator för alla källors hälsotillstånd.
 * Används av Home-sidan så användaren ser om alla feeds är aktiva, även
 * om en specifik källa inte har valuebets just nu.
 *
 * Säker i prod — read-only, ingen mutation. Stora payloads (rows-arrays)
 * läses bara för att räkna storlek, inte returneras.
 */
/**
 * Svarscache för /api/sources/status. Endpointen laddar ~30 källors payloads
 * (många delar underliggande fil: 7 altenar-brands, 8 betsson/comeon-shared).
 * TTL 30s = frontendens poll-intervall, så sidans polls träffar cachen;
 * bakgrundsvärmaren (startResponseCacheWarmers) håller den dessutom varm
 * mellan besök och direkt efter deploy.
 */
/**
 * Svarscache för /api/sources/status med STALE-WHILE-REVALIDATE (fix 2026-06-13).
 * Tidigare: vid utgången TTL väntade besökaren in HELA ombyggnaden (~30 källors
 * payloads, varav flera stora Supabase-läsningar). Om Supabase är trögt blev
 * det sekunder av väntan → "källor & bookmakers laddar för länge". Nu serveras
 * det senast byggda svaret ALLTID omedelbart; en inaktuell cache triggar en
 * BAKGRUNDS-ombyggnad utan att besökaren väntar. Bara den allra första (kalla)
 * byggnaden — eller en orimligt gammal cache — väntar besökaren in.
 */
const SOURCES_STATUS_FRESH_MS = 10_000; // yngre än så → ingen ombyggnad (10s: sänkt från 30s så
// den VISADE åldern för snabba sharp-källor (betfair/sbobet ~30-50s cadens) inte släpar ytterligare
// 30s. Stale-while-revalidate → fortsatt 0 blockering; bygget läser DB-cachen (10s TTL) så billigt.
const SOURCES_STATUS_HARD_MAX_MS = 10 * 60_000; // äldre än så → vänta in ny byggnad
let sourcesStatusCache: { builtAt: number; body: string } | null = null;
let sourcesStatusInflight: Promise<string> | null = null;
let sourcesStatusLastBuildMs = 0;

/**
 * Disk-persistens (fix 2026-06-14). Servern startar om då och då (nattetid/OOM)
 * → alla RAM-cacher töms → första laddningen efter omstart byggde om allt från
 * noll (10 Supabase-läsningar) = "varje gång jag går in efter 7-10h är det
 * segt". Nu skrivs senaste svaret till persistent disk och läses in vid boot,
 * så den ALLRA första requesten efter en omstart serveras direkt (stale) medan
 * en färsk byggnad sker i bakgrunden. Samma mönster som bonus-indexet.
 */
const SOURCES_STATUS_DISK_FILE = path.join(BONUS_CACHE_DIR, "sources-status-cache.json");

function persistSourcesStatusToDisk(body: string): void {
  try {
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(SOURCES_STATUS_DISK_FILE, JSON.stringify({ builtAt: Date.now(), body }), "utf-8");
  } catch {
    /* disk-skrivning är best-effort — RAM-cachen räcker annars */
  }
}

/** Läs in disk-persisterat källor-svar vid boot. builtAt sätts till "precis
 *  stale" så första requesten serverar det direkt OCH triggar en bakgrunds-
 *  ombyggnad (färsk data inom någon sekund). */
function loadSourcesStatusFromDisk(): void {
  try {
    if (!fs.existsSync(SOURCES_STATUS_DISK_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(SOURCES_STATUS_DISK_FILE, "utf-8")) as { body?: string };
    if (typeof parsed?.body === "string" && parsed.body.length > 0) {
      sourcesStatusCache = { builtAt: Date.now() - SOURCES_STATUS_FRESH_MS, body: parsed.body };
      console.log("[sources-status] läste in disk-persisterat svar vid boot (serveras direkt)");
    }
  } catch {
    /* ignorera — bygget kör som vanligt */
  }
}

function rebuildSourcesStatus(): Promise<string> {
  if (sourcesStatusInflight) return sourcesStatusInflight;
  const t0 = Date.now();
  sourcesStatusInflight = buildSourcesStatusBody()
    .then((body) => {
      sourcesStatusLastBuildMs = Date.now() - t0;
      sourcesStatusCache = { builtAt: Date.now(), body };
      persistSourcesStatusToDisk(body);
      if (sourcesStatusLastBuildMs > 2000) {
        console.log(`[sources-status] ombyggnad tog ${sourcesStatusLastBuildMs}ms`);
      }
      return body;
    })
    .finally(() => {
      sourcesStatusInflight = null;
    });
  return sourcesStatusInflight;
}

/** Max tid en request får blockera på en (om)byggnad när vi HAR en äldre body
 *  att falla tillbaka på. Bygget fortsätter i bakgrunden. */
const SOURCES_STATUS_MAX_WAIT_MS = 2_500;

/** Hämta sources-status-svaret — stale-while-revalidate (se kommentar ovan).
 *  GARANTI: så länge vi NÅGON GÅNG byggt (eller läst disk-snapshot vid boot)
 *  blockerar en request ALDRIG mer än SOURCES_STATUS_MAX_WAIT_MS — den gamla
 *  bodyn serveras direkt och en färsk byggs i bakgrunden. Det var den enda
 *  kvarvarande väg där "källor & bookmakers" kunde hänga: när cachen blivit
 *  hård-stale (>10 min, t.ex. efter en container-recycle) väntade besökaren
 *  förut in HELA ombyggnaden av ~11 källor. */
async function getSourcesStatusBodyCached(): Promise<string> {
  const c = sourcesStatusCache;
  if (c) {
    const age = Date.now() - c.builtAt;
    // Inaktuell → trigga ALLTID bakgrundsombyggnad (oavsett hur gammal).
    if (age >= SOURCES_STATUS_FRESH_MS) void rebuildSourcesStatus().catch(() => {});
    // Färsk nog → direkt.
    if (age < SOURCES_STATUS_HARD_MAX_MS) return c.body;
    // Hård-stale men vi HAR en body → blockera aldrig hela bygget; servera den
    // gamla om bygget inte hinner klart snabbt (det fortsätter i bakgrunden).
    const build = rebuildSourcesStatus();
    return Promise.race([
      build,
      new Promise<string>((resolve) => setTimeout(() => resolve(c.body), SOURCES_STATUS_MAX_WAIT_MS)),
    ]);
  }
  // Riktigt kallt (ingen body alls) — bara möjligt på en färsk container UTAN
  // persistent disk innan första bygget hunnit. Vänta in bygget (bundet av
  // per-källa-timeouts). Med CACHE_DIR på persistent disk läses en snapshot in
  // vid boot → denna gren nås aldrig och även första requesten efter recycle
  // är direkt.
  return rebuildSourcesStatus();
}

async function sourcesStatusDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/sources/status") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  try {
    const body = await getSourcesStatusBodyCached();
    res.statusCode = 200;
    res.end(body);
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown sources-status error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/**
 * GET /api/perf/sources — PUBLIK diagnostik (ingen auth) som tidsmäter varje
 * distinkt källas payload-laddning + hela bygget, så vi kan se exakt vad som är
 * trögt på Render (typiskt en långsam Supabase-läsning). Exponerar bara
 * millisekunder + cache-ålder — inga hemligheter. Tillfällig; tas bort när
 * flaskhalsen är hittad.
 */
async function sourcesPerfProbeApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/perf/sources") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  try {
    const loaders: Array<[string, () => Promise<unknown>]> = [
      ["pinnacle", () => buildPinnacleRowsWithMeta()],
      ["kambi", () => loadKambiPayloadWithMeta()],
      ["comeon", () => loadComeOnPayloadWithMeta()],
      ["betsson", () => loadBetssonPayloadWithMeta()],
      ["vbet", () => loadVbetPayloadWithMeta()],
      ["altenar", () => loadAltenarPayloadWithMeta()],
      ["pafbrand", () => loadPafBrandPayloadWithMeta()],
    ];
    const perLoaderMs: Record<string, number | string> = {};
    for (const [name, fn] of loaders) {
      const t = Date.now();
      try { await fn(); perLoaderMs[name] = Date.now() - t; }
      catch (e) { perLoaderMs[name] = `err ${Date.now() - t}ms: ${e instanceof Error ? e.message : e}`; }
    }
    const tBuild = Date.now();
    await buildSourcesStatusBody();
    const fullBuildMs = Date.now() - tBuild;
    const cacheAgeMs = sourcesStatusCache ? Date.now() - sourcesStatusCache.builtAt : null;
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      // uptime: liten siffra direkt efter att servern startat om. Bekräftar
      // omstart-teorin om den är låg när sidan känns seg efter lång inaktivitet.
      uptimeSeconds: Math.round(process.uptime()),
      dbConfigured: Boolean(ODDS_DB_URL && ODDS_DB_KEY),
      cacheAgeMs,
      lastBuildMs: sourcesStatusLastBuildMs,
      fullBuildMs,
      perLoaderMs,
    }, null, 2));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown perf error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/** Bygger /api/sources/status-svaret (dyr: laddar alla källors payloads — cachas ovan). */
async function buildSourcesStatusBody(): Promise<string> {
  // Förvärm alla DISTINKTA underliggande payloads PARALLELLT. De sekventiella
  // addForeign/addShared/addGroup-anropen nedan träffar då varje loaders korta
  // RAM-cache i stället för att seriellt vänta på ~10 Supabase-rundresor.
  // Varje loader fångar sina egna fel → .catch här är bara en säkerhetsnät så
  // Promise.all aldrig rejectar på en enskild källa.
  await Promise.all(
    [
      buildPinnacleRowsWithMeta(),
      loadKambiPayloadWithMeta(),
      loadComeOnPayloadWithMeta(),
      loadBetssonPayloadWithMeta(),
      loadVbetPayloadWithMeta(),
      loadAltenarPayloadWithMeta(),
      loadPafBrandPayloadWithMeta(),
      loadSmarketsPayloadWithMeta(),
    ].map((p) => p.catch(() => null)),
  );

  const ageOf = (updatedAt: string | null | undefined) => {
    if (!updatedAt) return null;
    const ms = Date.parse(updatedAt);
    return Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 1000) : null;
  };

  type SourceEntry = {
    id: string;
    name: string;
    type: SourceRegistryEntry["type"];
    status: "active" | "stale" | "empty" | "blocked" | "error" | "not_configured" | "on_demand" | "unknown";
    /** Människo-läsbar förklaring till status (t.ex. "118 events fresh", "workflow paused"). */
    reason: string;
    /** Vilken array vi räknade rader från: rows / events / byFranchise / byIntegration / signals / initial-empty / unknown. */
    dataShape: "rows" | "events" | "byFranchise" | "byIntegration" | "signals" | "initial-empty" | "unknown";
    updatedAt: string | null;
    ageSeconds: number | null;
    /** Totalt antal rader (legacy-fält — semantik beror på dataShape). */
    rowCount: number;
    /** Antal events specifikt (för events/byFranchise/initial-empty shapes). 0 för rows-shape. */
    events: number;
    source?: string | null;
    blocked?: boolean;
    lastError?: string | null;
    /**
     * Runtime-partiell: DENNA körning avbröts av scraperns hard-deadline →
     * reducerad täckning just nu (skild från coverageLevel som är den statiska
     * strukturella klassningen). Härleds från source-taggen "...partial-deadline".
     */
    partial?: boolean;
    // Registry-fält (alltid sätta från SOURCE_REGISTRY):
    workflow?: string;
    cron?: string;
    fetchIntervalSeconds?: number;
    staleAfterSeconds: number;
    backendCacheTtlSeconds: number;
    maxPossibleAgeSeconds?: number;
    note: string;
    // Coverage-klassning (från SOURCE_COVERAGE — visar varför row count är som den är)
    coverageLevel?: "full" | "partial" | "limited" | "unknown";
    coverageReason?: string;
    // Svensk-fokus (från SWEDISH_METADATA — för Home-prioritering)
    swedishPriority?: "high" | "medium" | "low" | "none";
    sharedOddsWith?: string[];
    matchCoveragePct?: number;
    /** Plattforms-grupp (samma odds-backend). Brands i samma grupp delar odds. */
    group?: string;
    /** Alla bookmaker-brands i samma grupp (delar odds-backend) — för grupperad admin-vy. */
    groupBrands?: string[];
    // Diagnostik:
    warnings: string[];
    // Sharp-specifikt:
    footballMoneylineCount?: number;
  };

  // Hjälper: räkna ut status från age + meta + state
  //
  // Prioritets-ordning:
  //   1. error       — loader threw
  //   2. blocked     — vi vet att källan är temporärt otillgänglig
  //   3. not_configured — fetch-script har aldrig kört (t.ex. VBET initial-empty)
  //   4. on-demand → active (no disk cache att stale-kolla)
  //   5. stale       — vi HAR data men den är gammal (>staleAfter)
  //                    OBS: stale prioriteras före empty när rowCount>0
  //   6. empty       — fil finns men 0 rader/events
  //   7. active      — fil finns, har data, är fräsch
  const computeStatus = (
    type: SourceRegistryEntry["type"],
    blocked: boolean,
    rowCount: number,
    ageSec: number | null,
    staleAfterSec: number,
    hadError: boolean,
    notConfigured: boolean = false,
  ): SourceEntry["status"] => {
    if (hadError) return "error";
    if (blocked) return "blocked";
    if (notConfigured) return "not_configured";
    if (type === "on_demand") return "active";
    // Stale-kollen kommer FÖRE empty-kollen så vi inte tappar information om
    // att data finns men är gammal. Endast om både ageSec saknas OCH rowCount==0
    // rapporterar vi "empty".
    if (ageSec !== null && ageSec > staleAfterSec) return rowCount === 0 ? "empty" : "stale";
    if (rowCount === 0) return "empty";
    return "active";
  };

  // Hjälper: bygg warnings från registry + observerad state
  const buildWarnings = (
    meta: SourceRegistryEntry,
    rowCount: number,
    ageSec: number | null,
    blocked: boolean,
    hadError: boolean,
    errorMsg: string | null,
  ): string[] => {
    const w: string[] = [];
    if (hadError) w.push(`error:${errorMsg ?? "unknown"}`);
    if (blocked) w.push("blocked");
    if (rowCount === 0 && meta.type !== "on_demand") w.push("empty_data");
    if (meta.type !== "on_demand" && ageSec === null) w.push("no_updatedAt");
    if (ageSec !== null && ageSec > meta.staleAfterSeconds) {
      const expectedMin = Math.round(meta.staleAfterSeconds / 60);
      const actualMin = Math.round(ageSec / 60);
      w.push(`stale:${actualMin}min>${expectedMin}min`);
    }
    if (
      meta.fetchIntervalSeconds &&
      ageSec !== null &&
      ageSec > meta.fetchIntervalSeconds * 3
    ) {
      w.push("no_recent_workflow_update");
    }
    return w;
  };

  const maxAge = (meta: SourceRegistryEntry): number =>
    (meta.fetchIntervalSeconds ?? 0) + 180 /* workflow runtime budget */ + meta.backendCacheTtlSeconds;

  // Bygg en kort, läsbar förklaring (visas på Home + i debug-endpoints).
  const buildReason = (
    status: SourceEntry["status"],
    rowCount: number,
    ageSec: number | null,
    staleAfterSec: number,
    blockedReason: string | null,
    errorMsg: string | null,
    notConfiguredReason: string | null = null,
  ): string => {
    if (status === "error") return errorMsg ? `error: ${errorMsg}` : "error";
    if (status === "blocked") return blockedReason ?? "blocked";
    if (status === "not_configured") return notConfiguredReason ?? "scraper not configured / never fetched real data";
    if (status === "empty") {
      const minutes = ageSec !== null ? Math.round(ageSec / 60) : null;
      return minutes !== null
        ? `data file exists (${minutes}min old) but contains 0 rows/events`
        : "data file exists but contains 0 rows/events";
    }
    if (status === "stale") {
      const minutes = ageSec !== null ? Math.round(ageSec / 60) : null;
      const threshold = Math.round(staleAfterSec / 60);
      return minutes !== null
        ? `${rowCount} rows, ${minutes}min old (stale after ${threshold}min)`
        : `${rowCount} rows, stale (older than ${threshold}min)`;
    }
    if (status === "active") {
      const minutes = ageSec !== null ? Math.round(ageSec / 60) : null;
      return minutes !== null ? `${rowCount} rows, ${minutes}min old` : `${rowCount} rows, on-demand`;
    }
    return "unknown";
  };

  const sources: SourceEntry[] = [];

  // Helper: foreign bookmaker loader-pattern.
  //
  // countRows kan överridas per källa eftersom payload-shapes skiljer sig:
  //   ComeOn:  byFranchise[*].events[]    (summera över franchises)
  //   Betsson: events[]                   (ej rows[])
  //   VBET:    events[] (oftast tom)      (workflow paused → blocked)
  // Default-counter läser rows[].
  const addForeign = async <P extends { updatedAt?: string | null; blocked?: boolean; lastError?: string | null; source?: string }>(
    metaId: string,
    loader: () => Promise<{ payload: P | null; source: string }>,
    opts?: {
      countRows?: (payload: P) => number;
      dataShape?: SourceEntry["dataShape"];
      detectBlocked?: (payload: P | null, source: string) => { blocked: true; reason: string } | null;
      /** Detekterar om scrapern aldrig hämtat riktig data (t.ex. VBET initial-empty). */
      detectNotConfigured?: (payload: P | null, source: string) => { notConfigured: true; reason: string } | null;
    },
  ) => {
    const meta = getSourceMeta(metaId);
    if (!meta) return;
    let hadError = false;
    let errorMsg: string | null = null;
    let rowCount = 0;
    let updatedAt: string | null = null;
    let source: string | null = null;
    let blocked = false;
    let blockedReason: string | null = null;
    let notConfigured = false;
    let notConfiguredReason: string | null = null;
    let lastError: string | null = null;
    try {
      const m = await loader();
      const payload = m.payload;
      if (payload) {
        rowCount = opts?.countRows
          ? opts.countRows(payload)
          : ((payload as unknown as { rows?: unknown[] }).rows?.length ?? 0);
        updatedAt = payload.updatedAt ?? null;
        blocked = payload.blocked ?? false;
        lastError = payload.lastError ?? null;
      }
      source = m.source ?? null;
      const detectedBlocked = opts?.detectBlocked?.(payload, m.source);
      if (detectedBlocked) {
        blocked = true;
        blockedReason = detectedBlocked.reason;
      }
      const detectedNotConfigured = opts?.detectNotConfigured?.(payload, m.source);
      if (detectedNotConfigured) {
        notConfigured = true;
        notConfiguredReason = detectedNotConfigured.reason;
      }
    } catch (e) {
      hadError = true;
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    const ageSec = ageOf(updatedAt);
    const status = computeStatus(meta.type, blocked, rowCount, ageSec, meta.staleAfterSeconds, hadError, notConfigured);
    const dataShape = opts?.dataShape ?? "rows";
    const eventsCount = dataShape === "rows" ? 0 : rowCount;
    sources.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      status,
      reason: buildReason(status, rowCount, ageSec, meta.staleAfterSeconds, blockedReason, errorMsg ?? lastError, notConfiguredReason),
      dataShape,
      updatedAt,
      ageSeconds: ageSec,
      rowCount,
      events: eventsCount,
      source,
      blocked,
      lastError: lastError ?? errorMsg,
      workflow: meta.workflow,
      cron: meta.cron,
      fetchIntervalSeconds: meta.fetchIntervalSeconds,
      staleAfterSeconds: meta.staleAfterSeconds,
      backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
      maxPossibleAgeSeconds: maxAge(meta),
      note: meta.note,
      warnings: buildWarnings(meta, rowCount, ageSec, blocked, hadError, errorMsg),
    });
  };

  // 1) Pinnacle (sharp) — har inte rows.blocked-fält, har sport/marketType-filter
  {
    const meta = getSourceMeta("pinnacle")!;
    let hadError = false;
    let errorMsg: string | null = null;
    let rowCount = 0;
    let updatedAt: string | null = null;
    let source: string | null = null;
    let moneylineCount = 0;
    try {
      const pin = await buildPinnacleRowsWithMeta();
      rowCount = pin.rows.length;
      updatedAt = pin.updatedAt ?? null;
      source = pin.source;
      moneylineCount = pin.rows.filter(
        (r) => r.sport === "soccer" && r.marketType === "moneyline" && (r.drawOdds ?? 0) > 1,
      ).length;
    } catch (e) {
      hadError = true;
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    const ageSec = ageOf(updatedAt);
    const pinStatus = computeStatus(meta.type, false, rowCount, ageSec, meta.staleAfterSeconds, hadError);
    sources.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      status: pinStatus,
      reason: buildReason(pinStatus, rowCount, ageSec, meta.staleAfterSeconds, null, errorMsg),
      dataShape: "rows",
      updatedAt,
      ageSeconds: ageSec,
      rowCount,
      events: 0,
      source,
      blocked: false,
      lastError: errorMsg,
      workflow: meta.workflow,
      cron: meta.cron,
      fetchIntervalSeconds: meta.fetchIntervalSeconds,
      staleAfterSeconds: meta.staleAfterSeconds,
      backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
      maxPossibleAgeSeconds: maxAge(meta),
      note: meta.note,
      warnings: buildWarnings(meta, rowCount, ageSec, false, hadError, errorMsg),
      footballMoneylineCount: moneylineCount,
    });
  }

  // 2-7) Foreign bookmakers via Helpers
  // Smarkets (börs) lagrar rows[] över alla sporter (+ bakåtkompat per-sport).
  // SBOBET (andra sharp-källan, DOM-skrapa). `events` är en OBJEKT-map
  // (eventId → event), inte array → räkna med Object.keys.
  await addForeign("sbobet", () => loadSbobetPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => Object.keys(p.events ?? {}).length,
  });

  // Betfair (börs, sharp komplement via UK-VPN). `events` är en OBJEKT-map
  // (betfairEventId → ParsedBetfairEvent), inte array → räkna med Object.keys.
  await addForeign("betfair", () => loadBetfairPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => Object.keys(p.events ?? {}).length,
  });

  await addForeign("smarkets", () => loadSmarketsPayloadWithMeta(), {
    dataShape: "rows",
    countRows: (p) => smarketsAllRows(p).length,
  });

  // Unibet (Kambi listView fan-out) lagrar events[].
  await addForeign("unibet", () => loadKambiPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // ATG Sport (Kambi-offering=atg) — samma events-form som Unibet/Kambi.
  await addForeign("atg", () => loadAtgPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // Coolbet (sbgate, VPS-stealth-browser) — samma events-form som ATG.
  await addForeign("coolbet", () => loadCoolbetPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // Svenska Spel / Oddset (Kambi offering=svenskaspel) — samma events-form som ATG.
  await addForeign("svenskaspel", () => loadSvenskaspelPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // Tipwin (NSoft/GP, Scrapfly) — events[] (1X2 + totals + EH3).
  await addForeign("tipwin", () => loadTipwinPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // 10bet (Playtech, Scrapfly DOM-walk per tävling) — events[] (1X2 + totals).
  await addForeign("10bet", () => loadTenbetPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // 888sport (Spectate, Mullvad-loop) — events[] (1X2).
  await addForeign("888sport", () => load888PayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // ProntoSport (ABM/Euro, Mullvad) — events[] (1X2 + totals).
  await addForeign("prontosport", () => loadProntoPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // ComeOn lagrar events per franchise (Hajper/Snabbare/ComeOn) — summera över alla.
  // dataShape "byFranchise" så konsument vet att count är events, inte rows.
  await addForeign("comeon", () => loadComeOnPayloadWithMeta(), {
    dataShape: "byFranchise",
    countRows: (p) => {
      const fr = p.byFranchise;
      if (!fr) return 0;
      let total = 0;
      for (const v of Object.values(fr)) total += v?.events?.length ?? 0;
      return total;
    },
  });

  // Betsson lagrar events[] (inte rows[]).
  await addForeign("betsson", () => loadBetssonPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
  });

  // VBET: workflow är pausad sedan 2026-05-07 (Cloudflare WAF blockar GitHub
  // Actions Azure-IPs på både conf.json och swarm-WS). Fetch-script sätter
  // source: "initial-empty" i payload när inget fetchats. Det här är inte ett
  // VBET — re-aktiverad 2026-05-25 via Mullvad VPN i workflow:n.
  // Cloudflare WAF blockade GitHub Actions Azure-IPs direkt, men svensk
  // Mullvad-relay funkar (samma trick som Betsson). Behåller fortfarande
  // not_configured-fallback för det fall payload skulle bli initial-empty
  // igen (om secret saknas eller workflow inte körts efter deploy).
  await addForeign("vbet", () => loadVbetPayloadWithMeta(), {
    dataShape: "events",
    countRows: (p) => p.events?.length ?? 0,
    detectNotConfigured: (payload) => {
      if (payload?.source === "initial-empty") {
        return {
          notConfigured: true,
          reason:
            "VBET payload is still initial-empty seed. Workflow är re-aktiverad — väntar på första lyckade körning via Mullvad VPN. Kolla GitHub Actions att vbet-fetch.yml körts.",
        };
      }
      return null;
    },
  });

  // 7b) Shared foreign bookmakers — läser brand-specifik del av en annan
  // bokmakares cachefil. Ingen ny scraping; data hämtas redan av master:ens
  // workflow (comeon-fetch.yml resp betsson-fetch.yml).
  //
  // Hajper/Snabbare: byFranchise.{SWEDEN_HAJPER,SWEDEN_SNABBARE}.events
  // Bethard/Spelklubben: events[] (samma odds som Betsson per SAME_ODDS_FALLBACK_GROUPS)
  const addShared = async (
    metaId: string,
    loaderForMaster: () =>
      | Promise<{ payload: { updatedAt?: string | null; source?: string; byFranchise?: Record<string, { events?: unknown[] }>; events?: unknown[] } | null; source: string }>,
  ) => {
    const meta = getSourceMeta(metaId);
    if (!meta || meta.type !== "foreign_bookmaker_shared") return;
    let hadError = false;
    let errorMsg: string | null = null;
    let rowCount = 0;
    let updatedAt: string | null = null;
    let cacheSource: string | null = null;
    let dataShape: SourceEntry["dataShape"] = "unknown";
    try {
      const m = await loaderForMaster();
      cacheSource = m.source ?? null;
      const payload = m.payload;
      if (payload) {
        updatedAt = payload.updatedAt ?? null;
        if (meta.franchiseKey && payload.byFranchise) {
          // Hajper/Snabbare: läs SWEDEN_HAJPER eller SWEDEN_SNABBARE
          rowCount = payload.byFranchise[meta.franchiseKey]?.events?.length ?? 0;
          dataShape = "byFranchise";
        } else if (Array.isArray(payload.events)) {
          // Bethard/Spelklubben: samma events[] som Betsson (samma odds)
          rowCount = payload.events.length;
          dataShape = "events";
        }
      }
    } catch (e) {
      hadError = true;
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    const ageSec = ageOf(updatedAt);
    const status = computeStatus(meta.type, false, rowCount, ageSec, meta.staleAfterSeconds, hadError);
    const reasonBase = buildReason(status, rowCount, ageSec, meta.staleAfterSeconds, null, errorMsg);
    sources.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      status,
      reason: `${reasonBase} (shared via ${meta.sharedWith}-cache${meta.franchiseKey ? `, franchise=${meta.franchiseKey}` : ""})`,
      dataShape,
      updatedAt,
      ageSeconds: ageSec,
      rowCount,
      events: rowCount,
      source: cacheSource,
      blocked: false,
      lastError: errorMsg,
      workflow: undefined, // master:ens workflow (visa "via X" istället)
      cron: undefined,
      fetchIntervalSeconds: meta.fetchIntervalSeconds,
      staleAfterSeconds: meta.staleAfterSeconds,
      backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
      maxPossibleAgeSeconds: maxAge(meta),
      note: meta.note,
      warnings: buildWarnings(meta, rowCount, ageSec, false, hadError, errorMsg),
    });
  };

  await addShared("hajper", () => loadComeOnPayloadWithMeta());
  await addShared("snabbare", () => loadComeOnPayloadWithMeta());
  await addShared("casinostugan", () => loadComeOnPayloadWithMeta());
  await addShared("lyllo", () => loadComeOnPayloadWithMeta());
  await addShared("bethard", () => loadBetssonPayloadWithMeta());
  await addShared("spelklubben", () => loadBetssonPayloadWithMeta());
  await addShared("nordicbet", () => loadBetssonPayloadWithMeta());
  await addShared("betsafe", () => loadBetssonPayloadWithMeta());

  // 7c) Foreign bookmaker groups — egna group-cachefiler, peer-relationship.
  // Altenar-gruppen: DBET/MrVegas/MegaRiches delar altenar-rows.json
  // byIntegration. Ingen master — alla 3 är peers.
  const addGroup = async (
    metaId: string,
    loader: () => Promise<{
      payload: {
        updatedAt?: string | null;
        source?: string;
        byIntegration?: Record<string, { events?: unknown[]; lastError?: string | null }>;
      } | null;
      source: string;
    }>,
  ) => {
    const meta = getSourceMeta(metaId);
    if (!meta || meta.type !== "foreign_bookmaker_group" || !meta.integrationKey) return;
    let hadError = false;
    let errorMsg: string | null = null;
    let rowCount = 0;
    let updatedAt: string | null = null;
    let cacheSource: string | null = null;
    let perIntegrationError: string | null = null;
    try {
      const m = await loader();
      cacheSource = m.source ?? null;
      const payload = m.payload;
      if (payload) {
        updatedAt = payload.updatedAt ?? null;
        const integ = payload.byIntegration?.[meta.integrationKey];
        rowCount = Array.isArray(integ?.events) ? integ.events.length : 0;
        perIntegrationError = integ?.lastError ?? null;
      }
    } catch (e) {
      hadError = true;
      errorMsg = e instanceof Error ? e.message : String(e);
    }
    const ageSec = ageOf(updatedAt);
    const status = computeStatus(meta.type, false, rowCount, ageSec, meta.staleAfterSeconds, hadError);
    const reasonBase = buildReason(status, rowCount, ageSec, meta.staleAfterSeconds, null, errorMsg ?? perIntegrationError);
    sources.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      status,
      reason: `${reasonBase} (group=${meta.group}, integration=${meta.integrationKey})`,
      dataShape: "byIntegration",
      updatedAt,
      ageSeconds: ageSec,
      rowCount,
      events: rowCount,
      source: cacheSource,
      blocked: false,
      lastError: errorMsg ?? perIntegrationError,
      workflow: meta.workflow,
      cron: meta.cron,
      fetchIntervalSeconds: meta.fetchIntervalSeconds,
      staleAfterSeconds: meta.staleAfterSeconds,
      backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
      maxPossibleAgeSeconds: maxAge(meta),
      note: meta.note,
      warnings: buildWarnings(meta, rowCount, ageSec, false, hadError, errorMsg ?? perIntegrationError),
    });
  };

  await addGroup("dbet", () => loadAltenarPayloadWithMeta());
  await addGroup("mrvegas", () => loadAltenarPayloadWithMeta());
  await addGroup("megariches", () => loadAltenarPayloadWithMeta());
  await addGroup("happycasino", () => loadAltenarPayloadWithMeta());
  await addGroup("lucky", () => loadAltenarPayloadWithMeta());
  await addGroup("betinia", () => loadAltenarPayloadWithMeta());
  await addGroup("quick", () => loadAltenarPayloadWithMeta());
  await addGroup("videoslots", () => loadAltenarPayloadWithMeta());
  await addGroup("kungaslottet", () => loadAltenarPayloadWithMeta());
  await addGroup("campobet", () => loadAltenarPayloadWithMeta());

  // Paf-brand group cache (X3000 / Golden Bull / 1x2 / Speedybet — prewarm).
  // Använder samma addGroup-helper. Payload-shape är byBrand i stället för
  // byIntegration, men eftersom helpern läser från payload.byIntegration[key]
  // måste vi adapta:a payloaden så byBrand → byIntegration syntaktiskt sett.
  // Lösning: shimma payloaden så addGroup ser byIntegration-fältet.
  const loadPafBrandAsIntegration = async () => {
    const m = await loadPafBrandPayloadWithMeta();
    if (!m.payload) return { payload: null, source: m.source };
    // Mappa byBrand → byIntegration så samma helper kan användas
    return {
      payload: {
        updatedAt: m.payload.updatedAt,
        source: m.payload.source,
        byIntegration: m.payload.byBrand
          ? Object.fromEntries(
              Object.entries(m.payload.byBrand).map(([k, v]) => [
                k,
                { events: v?.events ?? [], lastError: v?.lastError ?? null },
              ]),
            )
          : {},
      },
      source: m.source,
    };
  };
  await addGroup("x3000", loadPafBrandAsIntegration);
  await addGroup("goldenbull", loadPafBrandAsIntegration);
  await addGroup("1x2", loadPafBrandAsIntegration);
  await addGroup("speedybet", loadPafBrandAsIntegration);

  // 9) On-demand bookmakers (ingen disk-cache, scrape:as per request).
  //
  // Egen status "on_demand" (inte "active") så Home-tabellen visar tydligt
  // att de inte har egen cache att stale-kolla. Active reserveras för källor
  // med konfirmerad fräsch data. On-demand-källor körs lazy när en Pinnacle-
  // match jämförs mot dem via /api/valuebets eller bonus-optimizer.
  //
  // TODO: lägg till in-memory health tracking (lastAttemptAt, lastSuccessAt,
  // lastError, success/failureCount) så vi kan rapportera realtidsstatus.
  for (const meta of SOURCE_REGISTRY.filter((s) => s.type === "on_demand")) {
    sources.push({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      status: "on_demand",
      reason: "Scraped on-demand when matched against a Pinnacle event — no standalone cached odds file. Health is tracked per valuebets-request.",
      dataShape: "unknown",
      updatedAt: null,
      ageSeconds: null,
      rowCount: 0,
      events: 0,
      backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
      staleAfterSeconds: meta.staleAfterSeconds,
      note: meta.note,
      warnings: [],
    });
  }

  // Plattforms-grupp → alla systerbrands (samma odds-backend). Används för att
  // gruppera/färgkoda i admin-vyn: brands i samma grupp delar odds, så när en blir
  // stale blir oftast hela gruppen det. group = SOURCE_REGISTRY.group (egen id om saknas).
  const brandsByGroup = new Map<string, string[]>();
  for (const r of SOURCE_REGISTRY) {
    const g = r.group ?? r.id;
    const arr = brandsByGroup.get(g) ?? [];
    if (!arr.includes(r.name)) arr.push(r.name);
    brandsByGroup.set(g, arr);
  }

  // Inject coverage + Swedish metadata + grupp från SOURCE_REGISTRY (post-process).
  for (const s of sources) {
    const meta = getSourceMeta(s.id);
    if (meta?.coverageLevel) s.coverageLevel = meta.coverageLevel;
    if (meta?.coverageReason) s.coverageReason = meta.coverageReason;
    if (meta?.swedishPriority) s.swedishPriority = meta.swedishPriority;
    if (meta?.sharedOddsWith) s.sharedOddsWith = meta.sharedOddsWith;
    if (meta?.matchCoveragePct != null) s.matchCoveragePct = meta.matchCoveragePct;
    // Plattforms-grupp + systerbrands (alla bookmakers som delar denna odds-backend).
    s.group = meta?.group ?? s.id;
    s.groupBrands = brandsByGroup.get(s.group) ?? [s.name];
    // Runtime-partiell: scrapern skriver source="...partial-deadline" när en
    // körning avbröts av hard-deadline (reducerad täckning just denna cykel).
    if (typeof s.source === "string" && s.source.includes("partial")) {
      s.partial = true;
      if (!s.warnings.includes("partial_run")) s.warnings.push("partial_run");
    }
  }

  // Summera: hur många i varje status-kategori
  const summary = {
    total: sources.length,
    active: sources.filter((s) => s.status === "active").length,
    stale: sources.filter((s) => s.status === "stale").length,
    empty: sources.filter((s) => s.status === "empty").length,
    blocked: sources.filter((s) => s.status === "blocked").length,
    error: sources.filter((s) => s.status === "error").length,
    not_configured: sources.filter((s) => s.status === "not_configured").length,
    on_demand: sources.filter((s) => s.status === "on_demand").length,
    coverageBreakdown: {
      full: sources.filter((s) => s.coverageLevel === "full").length,
      partial: sources.filter((s) => s.coverageLevel === "partial").length,
      limited: sources.filter((s) => s.coverageLevel === "limited").length,
      unknown: sources.filter((s) => s.coverageLevel === "unknown").length,
    },
    swedishBreakdown: {
      high: sources.filter((s) => s.swedishPriority === "high").length,
      medium: sources.filter((s) => s.swedishPriority === "medium").length,
      low: sources.filter((s) => s.swedishPriority === "low").length,
      none: sources.filter((s) => s.swedishPriority === "none").length,
    },
  };

  return JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    summary,
    sources,
  });
}

/**
 * /api/debug/{comeon,betsson,vbet} — detaljerad diagnostik per foreign-bookmaker-källa.
 *
 * Inkluderar:
 *   - sourceId, displayName, status, reason, updatedAt, ageSeconds
 *   - rowsLoaded, fileExists, filePath, statusFile, lastError
 *   - sampleRows (5), sampleEvents (5)
 *   - workflowFile, expectedIntervalSeconds, staleAfterSeconds
 *   - cacheSource ("disk" | "github-api" | "github-raw" | "empty" | "none")
 *   - warnings: blocked, file_missing, updatedAt_missing, stale, empty_rows,
 *               workflow_paused, parser_returned_zero_rows
 *
 * Read-only — kallar samma loadrar som /api/sources/status och prod-pipelinen.
 */
async function foreignSourceDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  const match = url?.match(/^\/api\/debug\/(comeon|betsson|vbet)$/);
  if (!match) {
    next();
    return;
  }
  const sourceId = match[1] as "comeon" | "betsson" | "vbet";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  const meta = getSourceMeta(sourceId);
  if (!meta) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: `unknown sourceId: ${sourceId}` }));
    return;
  }

  const filePath = meta.dataFile ? path.resolve(process.cwd(), "data", meta.dataFile) : null;
  let fileExists = false;
  let fileSize = 0;
  if (filePath) {
    try {
      const st = fs.statSync(filePath);
      fileExists = st.isFile();
      fileSize = st.size;
    } catch { /* file missing — leave as false */ }
  }

  let payload: unknown = null;
  let payloadSource: string = "none";
  let loaderError: string | null = null;
  let rowCount = 0;
  const sampleEvents: unknown[] = [];
  const warnings: string[] = [];

  try {
    if (sourceId === "comeon") {
      const m = await loadComeOnPayloadWithMeta();
      payload = m.payload;
      payloadSource = m.source;
      const p = m.payload;
      if (p?.byFranchise) {
        for (const [code, fr] of Object.entries(p.byFranchise)) {
          const evts = fr?.events ?? [];
          rowCount += evts.length;
          for (const e of evts.slice(0, 2)) {
            sampleEvents.push({ franchise: code, title: e.title, homeTeam: e.homeTeam, awayTeam: e.awayTeam, startTime: e.startTime });
            if (sampleEvents.length >= 5) break;
          }
          if (sampleEvents.length >= 5) break;
        }
      }
    } else if (sourceId === "betsson") {
      const m = await loadBetssonPayloadWithMeta();
      payload = m.payload;
      payloadSource = m.source;
      const evts = m.payload?.events ?? [];
      rowCount = evts.length;
      for (const e of evts.slice(0, 5)) {
        sampleEvents.push({ eventId: e.eventId, title: e.title, startTime: e.startTime, hasOdds: !!e.odds });
      }
    } else if (sourceId === "vbet") {
      const m = await loadVbetPayloadWithMeta();
      payload = m.payload;
      payloadSource = m.source;
      const evts = m.payload?.events ?? [];
      rowCount = evts.length;
      for (const e of evts.slice(0, 5)) {
        sampleEvents.push(e);
      }
    }
  } catch (e) {
    loaderError = e instanceof Error ? e.message : String(e);
    warnings.push("loader_threw");
  }

  const updatedAt = (payload as { updatedAt?: string | null } | null)?.updatedAt ?? null;
  const payloadSourceStr = (payload as { source?: string } | null)?.source ?? null;
  const ageSec = updatedAt && Number.isFinite(Date.parse(updatedAt))
    ? Math.floor((Date.now() - Date.parse(updatedAt)) / 1000)
    : null;

  // Build warnings
  if (!fileExists) warnings.push("file_missing");
  if (!updatedAt) warnings.push("updatedAt_missing");
  if (rowCount === 0) warnings.push("parser_returned_zero_rows");
  if (ageSec !== null && ageSec > meta.staleAfterSeconds) {
    warnings.push(`stale:${Math.round(ageSec / 60)}min>${Math.round(meta.staleAfterSeconds / 60)}min`);
  }
  if (sourceId === "vbet" && payloadSourceStr === "initial-empty") {
    warnings.push("workflow_paused");
  }

  // ComeOn: per-franchise breakdown så vi kan se ifall en specifik brand är tom
  let franchiseBreakdown: Record<string, number> | null = null;
  if (sourceId === "comeon") {
    const p = payload as { byFranchise?: Record<string, { events?: unknown[] }> } | null;
    if (p?.byFranchise) {
      franchiseBreakdown = {};
      for (const [code, fr] of Object.entries(p.byFranchise)) {
        franchiseBreakdown[code] = fr?.events?.length ?? 0;
        if (franchiseBreakdown[code] === 0) warnings.push(`franchise_empty:${code}`);
      }
    }
  }

  // Workflow-status (statisk read av YAML) — saknar schedule = pausad
  let workflowFile: string | null = null;
  let workflowPaused = false;
  if (meta.workflow) {
    workflowFile = path.resolve(process.cwd(), ".github/workflows", meta.workflow);
    try {
      const yml = fs.readFileSync(workflowFile, "utf8");
      // Snabb heuristik: om "schedule:" inte finns i on-blocket är workflow:n pausad
      const onBlockMatch = yml.match(/^on:\s*\n((?:[ \t]+.+\n)+)/m);
      if (onBlockMatch && !/^\s*schedule:/m.test(onBlockMatch[1])) {
        workflowPaused = true;
        if (!warnings.includes("workflow_paused")) warnings.push("workflow_paused");
      }
    } catch {
      warnings.push("workflow_file_missing");
    }
  }

  // Status + reason — matchar samma logik som /api/sources/status.
  // initial-empty / workflow paused → not_configured (inte tillfälligt fel,
  // utan dokumenterat-uncompleted scraper-tillstånd).
  // Stale > empty: prioritera stale så vi inte tappar info att data finns.
  let status: "active" | "stale" | "empty" | "blocked" | "error" | "not_configured" | "unknown" = "unknown";
  if (loaderError) status = "error";
  else if (sourceId === "vbet" && (workflowPaused || payloadSourceStr === "initial-empty")) status = "not_configured";
  else if (ageSec !== null && ageSec > meta.staleAfterSeconds) status = rowCount === 0 ? "empty" : "stale";
  else if (rowCount === 0) status = "empty";
  else status = "active";

  // Hitta dataShape genom att inspektera payload-rooten
  let dataShape: "rows" | "events" | "byFranchise" | "signals" | "initial-empty" | "unknown" = "unknown";
  if (payloadSourceStr === "initial-empty") dataShape = "initial-empty";
  else if (sourceId === "comeon") dataShape = "byFranchise";
  else if (sourceId === "betsson" || sourceId === "vbet") dataShape = "events";

  const reasonParts: string[] = [];
  if (status === "not_configured") reasonParts.push("VBET scraper not configured / initial-empty payload — workflow paused after Cloudflare WAF block on GitHub Actions IPs");
  else if (status === "blocked") reasonParts.push("workflow paused — Cloudflare blocks GitHub Actions IPs");
  else if (status === "error") reasonParts.push(loaderError ?? "loader error");
  else if (status === "empty") reasonParts.push(`file exists (${Math.round((ageSec ?? 0) / 60)}min old) but parser returned 0 rows/events`);
  else if (status === "stale") reasonParts.push(`${rowCount} rows, ${Math.round((ageSec ?? 0) / 60)}min old (stale > ${Math.round(meta.staleAfterSeconds / 60)}min)`);
  else reasonParts.push(`${rowCount} rows, ${Math.round((ageSec ?? 0) / 60)}min old`);

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    sourceId: meta.id,
    displayName: meta.name,
    status,
    reason: reasonParts.join("; "),
    dataShape,
    updatedAt,
    ageSeconds: ageSec,
    rowsLoaded: rowCount,
    events: rowCount, // semantiskt: alla 3 källor lagrar events, inte rows
    fileExists,
    fileSizeBytes: fileSize,
    filePath: filePath ? path.relative(process.cwd(), filePath) : null,
    cacheSource: payloadSource,
    payloadSourceField: payloadSourceStr,
    lastError: loaderError,
    workflowFile: workflowFile ? path.relative(process.cwd(), workflowFile) : null,
    workflowPaused,
    expectedIntervalSeconds: meta.fetchIntervalSeconds,
    staleAfterSeconds: meta.staleAfterSeconds,
    backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
    franchiseBreakdown,
    sampleEvents: sampleEvents.slice(0, 5),
    warnings,
    note: meta.note,
    generatedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * /api/debug/on-demand-sources — lista alla on-demand-bookmakers med
 * konfiguration och (kommande) health metrics.
 *
 * On-demand-källor har ingen disk-cache att stale-kolla. De skrapas lazy
 * när en Pinnacle-match jämförs mot dem (via /api/valuebets eller bonus-
 * optimizer). Den här endpointen visar:
 *   - registry-config (group, cache TTL, scraper-spec id, integration)
 *   - hasStandaloneCache: false (alltid — det är poängen)
 *   - usedInValueBets: true om bookmakerId finns i BOOKMAKER_SCRAPERS
 *
 * TODO: lägg till in-memory health tracking (lastAttemptAt, lastSuccessAt,
 * lastError, success/failureCount). I dag finns ingen sådan tracking, så
 * vi rapporterar "no standalone health check yet".
 */
function onDemandSourcesDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/on-demand-sources") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  const onDemand = SOURCE_REGISTRY.filter((s) => s.type === "on_demand");
  const sources = onDemand.map((meta) => {
    const scraper = BOOKMAKER_SCRAPERS.find((b) => b.id === meta.id);
    return {
      id: meta.id,
      displayName: meta.name,
      type: "on_demand" as const,
      status: scraper ? "on_demand" : "not_configured",
      reason: scraper
        ? "Scraped on-demand when matched against a Pinnacle event"
        : "Registered in SOURCE_REGISTRY but no entry in BOOKMAKER_SCRAPERS — not used by valuebets pipeline",
      group: scraper?.group ?? null,
      hasStandaloneCache: false,
      usedInValueBets: Boolean(scraper),
      backendCacheTtlSeconds: meta.backendCacheTtlSeconds,
      // Health tracking placeholders — TODO: bygg in-memory counters
      lastAttemptAt: null as string | null,
      lastSuccessAt: null as string | null,
      lastError: null as string | null,
      successCount: null as number | null,
      failureCount: null as number | null,
      notes: meta.note,
      healthCheckStatus: "no standalone health check yet",
    };
  });

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    count: sources.length,
    sources,
    explainer:
      "On-demand bookmakers are scraped when matching against a Pinnacle event. " +
      "They do not keep a standalone cached odds file — that's why /api/sources/status " +
      "returns rowCount=0 and updatedAt=null for them. Status 'on_demand' is normal.",
  }, null, 2));
}

/**
 * /api/debug/shared-bookmakers — diagnostik för foreign_bookmaker_shared-typen.
 *
 * Lista alla bookmakers som läser från en annan master:s cachefil (ingen egen
 * workflow). Visar var datat egentligen kommer från + brand-specifik count.
 *
 * Hajper/Snabbare → comeon-rows.json byFranchise.{KEY}.events
 * Bethard/Spelklubben → betsson-rows.json events (samma odds som Betsson)
 */
async function sharedBookmakersDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/shared-bookmakers") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  const shared = SOURCE_REGISTRY.filter((s) => s.type === "foreign_bookmaker_shared");
  const ageOfStr = (s: string | null | undefined) => {
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? Math.floor((Date.now() - ms) / 1000) : null;
  };

  type SharedSourceDebug = {
    id: string;
    displayName: string;
    sharedDataFile: string | null;
    dataShape: "byFranchise" | "events" | "unknown";
    franchiseKey: string | null;
    sharedWith: string | null;
    rows: number;
    updatedAt: string | null;
    ageSeconds: number | null;
    status: "active" | "stale" | "empty" | "error" | "unknown";
    warnings: string[];
    lastError: string | null;
  };

  const sources: SharedSourceDebug[] = [];

  for (const meta of shared) {
    const warnings: string[] = [];
    let rows = 0;
    let updatedAt: string | null = null;
    let lastError: string | null = null;
    let dataShape: "byFranchise" | "events" | "unknown" = "unknown";

    try {
      if (meta.sharedWith === "comeon") {
        const m = await loadComeOnPayloadWithMeta();
        updatedAt = m.payload?.updatedAt ?? null;
        if (meta.franchiseKey && m.payload?.byFranchise) {
          rows = m.payload.byFranchise[meta.franchiseKey]?.events?.length ?? 0;
          dataShape = "byFranchise";
          if (rows === 0) warnings.push(`franchise_empty:${meta.franchiseKey}`);
        }
      } else if (meta.sharedWith === "betsson") {
        const m = await loadBetssonPayloadWithMeta();
        updatedAt = m.payload?.updatedAt ?? null;
        rows = m.payload?.events?.length ?? 0;
        dataShape = "events";
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      warnings.push("master_loader_threw");
    }

    const ageSeconds = ageOfStr(updatedAt);
    if (ageSeconds === null) warnings.push("updatedAt_missing");
    if (ageSeconds !== null && ageSeconds > meta.staleAfterSeconds) {
      warnings.push(`stale:${Math.round(ageSeconds / 60)}min>${Math.round(meta.staleAfterSeconds / 60)}min`);
    }

    let status: SharedSourceDebug["status"];
    if (lastError) status = "error";
    else if (rows === 0) status = "empty";
    else if (ageSeconds !== null && ageSeconds > meta.staleAfterSeconds) status = "stale";
    else status = "active";

    sources.push({
      id: meta.id,
      displayName: meta.name,
      sharedDataFile: meta.sharedDataFile ?? null,
      dataShape,
      franchiseKey: meta.franchiseKey ?? null,
      sharedWith: meta.sharedWith ?? null,
      rows,
      updatedAt,
      ageSeconds,
      status,
      warnings,
      lastError,
    });
  }

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    count: sources.length,
    sources,
    explainer:
      "Shared bookmakers read brand-specific events from another master's cache file (no own workflow/scraping). " +
      "Hajper/Snabbare share comeon-rows.json byFranchise. Bethard/Spelklubben share betsson-rows.json events (identical 1X2 per SAME_ODDS_FALLBACK_GROUPS).",
  }, null, 2));
}

/**
 * /api/debug/altenar — diagnostik för Altenar-gruppens cache.
 *
 * Visar status per integration (DBET/MrVegas/MegaRiches) — events-count,
 * sista fetch-error, sample events. Underlättar att se om en specifik
 * integration returnerade 0 events utan att blockera hela gruppen.
 */
async function altenarDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/altenar") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  let payload: AltenarCachePayload | null = null;
  let cacheSource: string = "none";
  let loaderError: string | null = null;
  let fileExists = false;
  let fileSize = 0;

  try {
    const st = fs.statSync(ALTENAR_DATA_FILE);
    fileExists = st.isFile();
    fileSize = st.size;
  } catch { /* file missing */ }

  try {
    const m = await loadAltenarPayloadWithMeta();
    payload = m.payload;
    cacheSource = m.source;
  } catch (e) {
    loaderError = e instanceof Error ? e.message : String(e);
  }

  const ageSeconds = altenarPayloadAgeMs(payload);
  const ageSec = ageSeconds !== null ? Math.floor(ageSeconds / 1000) : null;

  type IntegrationDebug = {
    id: string;
    displayName: string;
    integrationKey: string;
    rows: number;
    updatedAt: string | null;
    lastError: string | null;
    skippedNoOdds: number | null;
    rawEventsCount: number | null;
    sampleEvents: unknown[];
    warnings: string[];
  };

  const integrationsResult: IntegrationDebug[] = [];
  const keyToBookmakerName: Record<string, { id: string; displayName: string }> = {
    dbet: { id: "dbet", displayName: "DBET" },
    mrvegasse: { id: "mrvegas", displayName: "MrVegas" },
    megarichesse: { id: "megariches", displayName: "MegaRiches" },
  };
  const byInteg = payload?.byIntegration ?? {};
  for (const [key, integ] of Object.entries(byInteg)) {
    const evts = Array.isArray(integ?.events) ? integ.events : [];
    const warnings: string[] = [];
    if (integ?.lastError) warnings.push(`fetch_error:${integ.lastError.substring(0, 60)}`);
    if (evts.length === 0) warnings.push("zero_events_for_integration");
    integrationsResult.push({
      id: keyToBookmakerName[key]?.id ?? key,
      displayName: keyToBookmakerName[key]?.displayName ?? (integ?.displayName ?? key),
      integrationKey: key,
      rows: evts.length,
      updatedAt: integ?.updatedAt ?? null,
      lastError: integ?.lastError ?? null,
      skippedNoOdds: integ?.skippedNoOdds ?? null,
      rawEventsCount: integ?.rawEventsCount ?? null,
      sampleEvents: evts.slice(0, 5).map((e) => ({
        eventId: (e as AltenarCacheEvent).eventId,
        title: (e as AltenarCacheEvent).title,
        league: (e as AltenarCacheEvent).league,
        startTime: (e as AltenarCacheEvent).startTime,
        odds: (e as AltenarCacheEvent).odds,
      })),
      warnings,
    });
  }

  // Overall status
  const totalEvents = integrationsResult.reduce((sum, i) => sum + i.rows, 0);
  let status: "active" | "stale" | "empty" | "error" | "partial" = "unknown" as never;
  if (loaderError) status = "error";
  else if (totalEvents === 0) status = "empty";
  else if (ageSec !== null && ageSec > 30 * 60) status = "stale";
  else if (integrationsResult.some((i) => i.lastError)) status = "partial";
  else status = "active";

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    group: "altenar",
    workflow: "altenar-fetch.yml",
    status,
    updatedAt: payload?.updatedAt ?? null,
    ageSeconds: ageSec,
    cacheSource,
    fileExists,
    fileSizeBytes: fileSize,
    filePath: "data/altenar-rows.json",
    totalEvents,
    integrations: integrationsResult,
    lastError: loaderError,
    payloadStatus: payload?.status ?? null,
    payloadFailedIntegrations: payload?.failedIntegrations ?? null,
    generatedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * /api/debug/coverage — aggregated coverage view across all bookmakers.
 *
 * Visar samma tabell som scripts/audit-bookmaker-coverage.mjs men live
 * från cache-filerna. Bra för att verifiera att row counts ser rimliga
 * ut innan en deploy eller efter en workflow-fix.
 */
async function coverageAuditDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/coverage") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  type CoverageSource = {
    id: string;
    displayName: string;
    coverageLevel: NonNullable<SourceRegistryEntry["coverageLevel"]>;
    coverageReason: string;
    rows: number;
    updatedAt: string | null;
    ageMinutes: number | null;
    dataFile: string | null;
    notes: string;
  };

  const results: CoverageSource[] = [];

  const ageMin = (s: string | null | undefined) => {
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 60_000) : null;
  };

  const tryReadFile = (filename: string | undefined): { payload: unknown; updatedAt: string | null } => {
    if (!filename) return { payload: null, updatedAt: null };
    try {
      const p = path.resolve(process.cwd(), "data", filename);
      if (!fs.existsSync(p)) return { payload: null, updatedAt: null };
      const j = JSON.parse(fs.readFileSync(p, "utf8")) as { updatedAt?: string };
      return { payload: j, updatedAt: j?.updatedAt ?? null };
    } catch {
      return { payload: null, updatedAt: null };
    }
  };

  const countRows = (id: string, payload: unknown): number => {
    if (!payload) return 0;
    const p = payload as Record<string, unknown>;
    // ComeOn / Hajper / Snabbare → byFranchise
    if (p.byFranchise && typeof p.byFranchise === "object") {
      const fr = p.byFranchise as Record<string, { events?: unknown[] }>;
      if (id === "comeon") return fr.SWEDEN_COMEON?.events?.length ?? 0;
      if (id === "hajper") return fr.SWEDEN_HAJPER?.events?.length ?? 0;
      if (id === "snabbare") return fr.SWEDEN_SNABBARE?.events?.length ?? 0;
      // Aggregate
      let total = 0;
      for (const v of Object.values(fr)) total += v?.events?.length ?? 0;
      return total;
    }
    // Altenar byIntegration
    if (p.byIntegration && typeof p.byIntegration === "object") {
      const integ = p.byIntegration as Record<string, { events?: unknown[] }>;
      const meta = getSourceMeta(id);
      if (meta?.integrationKey) return integ[meta.integrationKey]?.events?.length ?? 0;
      let total = 0;
      for (const v of Object.values(integ)) total += v?.events?.length ?? 0;
      return total;
    }
    // Paf-brand byBrand
    if (p.byBrand && typeof p.byBrand === "object") {
      const br = p.byBrand as Record<string, { events?: unknown[] }>;
      const meta = getSourceMeta(id);
      if (meta?.integrationKey) return br[meta.integrationKey]?.events?.length ?? 0;
      let total = 0;
      for (const v of Object.values(br)) total += v?.events?.length ?? 0;
      return total;
    }
    if (Array.isArray(p.rows)) return (p.rows as unknown[]).length;
    if (Array.isArray(p.events)) return (p.events as unknown[]).length;
    if (Array.isArray(p.signals)) return (p.signals as unknown[]).length;
    return 0;
  };

  for (const meta of SOURCE_REGISTRY) {
    const file = meta.dataFile ?? meta.sharedDataFile ?? null;
    const { payload, updatedAt } = tryReadFile(file ?? undefined);
    const rows = countRows(meta.id, payload);
    results.push({
      id: meta.id,
      displayName: meta.name,
      coverageLevel: meta.coverageLevel ?? "unknown",
      coverageReason: meta.coverageReason ?? "not classified",
      rows,
      updatedAt,
      ageMinutes: ageMin(updatedAt),
      dataFile: file,
      notes: meta.note,
    });
  }

  const totals = {
    sources: results.length,
    full: results.filter((r) => r.coverageLevel === "full").length,
    partial: results.filter((r) => r.coverageLevel === "partial").length,
    limited: results.filter((r) => r.coverageLevel === "limited").length,
    unknown: results.filter((r) => r.coverageLevel === "unknown").length,
    totalRowsAcrossAllSources: results.reduce((sum, r) => sum + r.rows, 0),
  };

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    explainer:
      "Coverage levels: 'full' = bulk/fan-out returns full catalog; 'partial' = endpoint limited " +
      "(search-based / region-fan-out / catalog ∪ highlights); 'limited' = endpoint returns subset only; " +
      "'unknown' = workflow not configured / blocked / never fetched. See coverageReason per source.",
    totals,
    sources: results,
  }, null, 2));
}

/**
 * /api/debug/paf-brand — diagnostik för Paf-brand prewarm cache.
 *
 * Visar per-brand: rows, queriesTried/Succeeded/Failed, eventsFound,
 * lastError, sampleEvents. Bra för att se om en specifik brand inte
 * längre returnerar data.
 */
async function pafBrandDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/paf-brand") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  let payload: PafBrandCachePayload | null = null;
  let cacheSource: string = "none";
  let loaderError: string | null = null;
  let fileExists = false;
  let fileSize = 0;

  try {
    const st = fs.statSync(PAF_BRAND_DATA_FILE);
    fileExists = st.isFile();
    fileSize = st.size;
  } catch { /* missing */ }

  try {
    const m = await loadPafBrandPayloadWithMeta();
    payload = m.payload;
    cacheSource = m.source;
  } catch (e) {
    loaderError = e instanceof Error ? e.message : String(e);
  }

  const ageMs = pafBrandPayloadAgeMs(payload);
  const ageSec = ageMs !== null ? Math.floor(ageMs / 1000) : null;

  // BOOKMAKER_SCRAPERS-id per brandKey för att vi ska kunna lista dem under rätt id
  const keyToId: Record<string, string> = {
    x3000: "x3000",
    goldenbull: "goldenbull",
    oneTwo: "1x2",
    speedybet: "speedybet",
  };

  type BrandDebug = {
    id: string;
    displayName: string;
    brandKey: string;
    baseUrl: string | null;
    rows: number;
    queriesTried: number | null;
    queriesSucceeded: number | null;
    queriesFailed: number | null;
    eventsFound: number | null;
    updatedAt: string | null;
    durationMs: number | null;
    lastError: string | null;
    sampleEvents: unknown[];
    warnings: string[];
  };

  const brands: BrandDebug[] = [];
  for (const [brandKey, brandData] of Object.entries(payload?.byBrand ?? {})) {
    const evts = brandData?.events ?? [];
    const warnings: string[] = [];
    if (brandData?.lastError) warnings.push(`fetch_error:${brandData.lastError.substring(0, 60)}`);
    if (evts.length === 0) warnings.push("zero_events_for_brand");
    if (brandData?.queriesFailed && brandData.queriesFailed > 0) {
      warnings.push(`queries_failed:${brandData.queriesFailed}/${brandData.queriesTried}`);
    }
    brands.push({
      id: keyToId[brandKey] ?? brandKey,
      displayName: brandData?.displayName ?? brandKey,
      brandKey,
      baseUrl: brandData?.baseUrl ?? null,
      rows: evts.length,
      queriesTried: brandData?.queriesTried ?? null,
      queriesSucceeded: brandData?.queriesSucceeded ?? null,
      queriesFailed: brandData?.queriesFailed ?? null,
      eventsFound: brandData?.eventsFound ?? null,
      updatedAt: brandData?.updatedAt ?? null,
      durationMs: brandData?.durationMs ?? null,
      lastError: brandData?.lastError ?? null,
      sampleEvents: evts.slice(0, 5).map((e) => ({
        eventId: e.eventId,
        title: e.title,
        league: e.league,
        startTime: e.startTime,
        odds: e.odds,
        matchedQuery: e.matchedQuery,
      })),
      warnings,
    });
  }

  const totalEvents = brands.reduce((sum, b) => sum + b.rows, 0);
  let status: "active" | "stale" | "partial" | "empty" | "error" | "unknown";
  if (loaderError) status = "error";
  else if (totalEvents === 0) status = "empty";
  else if (ageSec !== null && ageSec > 60 * 60) status = "stale";
  else if (brands.some((b) => b.lastError || b.rows === 0)) status = "partial";
  else status = "active";

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    group: "paf-brand",
    workflow: "paf-brand-fetch.yml",
    cacheType: payload?.cacheType ?? "prewarm",
    status,
    queryCount: payload?.queryCount ?? null,
    updatedAt: payload?.updatedAt ?? null,
    ageSeconds: ageSec,
    totalEvents,
    brandsFetched: payload?.brandsFetched ?? null,
    brandsFailed: payload?.brandsFailed ?? null,
    cacheSource,
    fileExists,
    fileSizeBytes: fileSize,
    filePath: "data/paf-brand-rows.json",
    lastError: loaderError,
    note: payload?.note ?? null,
    brands,
    generatedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * /api/debug/kambi — diagnostik för Unibet/Kambi-cachen.
 *
 * Visar fetchedRegions/uniqueEvents/parsed events + sample.
 */
async function kambiDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/debug/kambi") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  let payload: KambiCachePayload | null = null;
  let cacheSource: string = "none";
  let loaderError: string | null = null;
  let fileExists = false;
  let fileSize = 0;

  try {
    const st = fs.statSync(KAMBI_DATA_FILE);
    fileExists = st.isFile();
    fileSize = st.size;
  } catch { /* missing */ }

  try {
    const m = await loadKambiPayloadWithMeta();
    payload = m.payload;
    cacheSource = m.source;
  } catch (e) {
    loaderError = e instanceof Error ? e.message : String(e);
  }

  const events = payload?.events ?? [];
  const ageMs = kambiPayloadAgeMs(payload);
  const ageSec = ageMs !== null ? Math.floor(ageMs / 1000) : null;

  const warnings: string[] = [];
  if (!fileExists) warnings.push("file_missing");
  if (!payload?.updatedAt) warnings.push("updatedAt_missing");
  if (events.length === 0) warnings.push("zero_events");
  if (ageSec !== null && ageSec > 30 * 60) warnings.push(`stale:${Math.round(ageSec / 60)}min>30min`);
  if (payload?.failedRegions && payload.failedRegions > 0) warnings.push(`failed_regions:${payload.failedRegions}`);

  let status: "active" | "stale" | "empty" | "error" | "unknown";
  if (loaderError) status = "error";
  else if (events.length === 0) status = "empty";
  else if (ageSec !== null && ageSec > 30 * 60) status = "stale";
  else status = "active";

  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    bookmaker: "unibet",
    displayName: "Unibet",
    group: "kambi",
    workflow: "kambi-fetch.yml",
    status,
    offering: payload?.offering ?? null,
    updatedAt: payload?.updatedAt ?? null,
    ageSeconds: ageSec,
    rows: events.length,
    uniqueEventsBeforeParse: payload?.uniqueEvents ?? null,
    fetchedRegions: payload?.fetchedRegions ?? null,
    failedRegions: payload?.failedRegions ?? null,
    skippedNoOdds: payload?.skippedNoOdds ?? null,
    cacheSource,
    fileExists,
    fileSizeBytes: fileSize,
    filePath: "data/kambi-rows.json",
    lastError: loaderError ?? payload?.lastError ?? null,
    sampleEvents: events.slice(0, 5),
    warnings,
    generatedAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * 2-vägs valuebets (moneyline, ingen oavgjort): basket + tennis. HELT separat
 * kodväg från fotbollens 1X2-pipeline — fotbollen rörs inte. Läser Altenars
 * cachade per-sport-events (eventsBasket / eventsTennis, per integration =
 * per bookmaker-brand) och parar mot Pinnacle-rader av samma sport.
 * Återanvänder isLikelySameMatch + computeNoVig (generisk 2+) + samma
 * EV-trösklar + samma ValueBetEntry-form som fotbollen.
 */
// Soft-bok-id (parseSoftBook) → bonus-brand för visning. Multi-brand-böcker
// (altenar/betsson) surfas under ett generiskt namn i v1.
const TOTALS_BOOK_BRAND: Record<string, { id: string; name: string }> = {
  comeon: { id: "comeon", name: "ComeOn" },
  vbet: { id: "vbet", name: "VBET" },
  kambi: { id: "unibet", name: "Unibet" },
  atg: { id: "atg", name: "ATG" },
  coolbet: { id: "coolbet", name: "Coolbet" },
  svenskaspel: { id: "svenskaspel", name: "Svenska Spel (Oddset)" },
  paf: { id: "paf", name: "Paf" },
  altenar: { id: "altenar", name: "Altenar" },
  betsson: { id: "betsson", name: "Betsson" },
  // Bonus-syskon surfas under sin EGEN brand (egna freebets/finder-poster) — odds
  // är identiska med grupp-cachen (nordicbet/betsafe ⊂ betsson, lucky/quick ⊂ altenar)
  // men användaren har bonus hos respektive brand så varje surfas separat.
  nordicbet: { id: "nordicbet", name: "NordicBet" },
  betsafe: { id: "betsafe", name: "Betsafe" },
  lucky: { id: "lucky", name: "LuckyCasino" },
  quick: { id: "quick", name: "QuickCasino" },
  videoslots: { id: "videoslots", name: "Videoslots" },
  kungaslottet: { id: "kungaslottet", name: "Kungaslottet" },
  campobet: { id: "campobet", name: "CampoBet" },
  tipwin: { id: "tipwin", name: "Tipwin" },
};

/**
 * FOOTBALL TOTALS-VALUEBETS i live-svaret. Återanvänder den bevisade backend-
 * motorn (computeTotalsValuebets: Pinnacle-stege + Betfair-blend + likviditet +
 * CLV-vikt) och konverterar till ValueBetEntry. Bakom kill-switch (VALUEBETS_TOTALS)
 * + samma EV-/reject-grindar som 1X2. Felsäkert: laddningsfel → tom lista.
 */
async function computeFootballTotalsValueBets(
  rawPinnacleJson: unknown,
  hoursWindow: number,
  pinnacleEvents?: PinnacleEvent[],
  pinnacleLadders?: Map<string, PinnacleLineLadders>,
): Promise<ValueBetEntry[]> {
  if (!rawPinnacleJson) return [];
  const softBooks: Array<{ id: string; json: unknown; franchise?: string }> = [];
  const tryLoad = async (id: string, loader: () => Promise<{ payload: unknown }>, franchise?: string) => {
    try { const r = await loader(); if (r?.payload) softBooks.push({ id, json: r.payload, franchise }); } catch { /* hoppa */ }
  };
  await Promise.all([
    tryLoad("comeon", loadComeOnPayloadWithMeta),
    tryLoad("betsson", loadBetssonPayloadWithMeta),
    tryLoad("vbet", loadVbetPayloadWithMeta),
    tryLoad("altenar", loadAltenarPayloadWithMeta),
    tryLoad("kambi", loadKambiPayloadWithMeta),
    tryLoad("atg", loadAtgPayloadWithMeta),
    tryLoad("coolbet", loadCoolbetPayloadWithMeta),
    tryLoad("svenskaspel", loadSvenskaspelPayloadWithMeta),
    tryLoad("paf", loadPafBrandPayloadWithMeta),
    // Bonus-syskon surfas under egen brand (identiska odds men egna bonusar):
    // nordicbet/betsafe delar betsson-cachen (flat events[]) → ingen franchise;
    // lucky/quick delar altenar-cachen (byIntegration) → franchise-nyckel krävs.
    tryLoad("nordicbet", loadBetssonPayloadWithMeta),
    tryLoad("betsafe", loadBetssonPayloadWithMeta),
    tryLoad("lucky", loadAltenarPayloadWithMeta, "luckycasino"),
    tryLoad("quick", loadAltenarPayloadWithMeta, "quickcasinose"),
    tryLoad("videoslots", loadAltenarPayloadWithMeta, "videoslotsse"),
    tryLoad("kungaslottet", loadAltenarPayloadWithMeta, "kungaslottetse"),
    tryLoad("campobet", loadAltenarPayloadWithMeta, "campose"),
    tryLoad("tipwin", loadTipwinPayloadWithMeta),
  ]);
  if (softBooks.length === 0) return [];

  // Betfair-totals — endast om FÄRSK (samma 3-min-grind som 1X2-blandningen).
  let betfairLines: ReturnType<typeof parseBetfairLineRowsMap> | undefined;
  try {
    const bf = await loadBetfairPayloadWithMeta();
    const age = oddsDbPayloadAgeMs(bf.payload);
    if (bf.payload && age !== null && age <= SHARP_FRESHNESS_THRESHOLD_MS) betfairLines = parseBetfairLineRowsMap(bf.payload);
  } catch { /* ingen Betfair → bara Pinnacle */ }

  let clvMultipliers: Record<string, number> = {};
  try {
    const cmPath = path.resolve(process.cwd(), "data", "clv-multipliers.json");
    if (fs.existsSync(cmPath)) clvMultipliers = JSON.parse(fs.readFileSync(cmPath, "utf-8"))?.multipliers ?? {};
  } catch { /* prior-vikter */ }

  const now = Date.now();
  const vbs = computeTotalsValuebets({
    pinnacleJson: rawPinnacleJson, pinnacleEvents, pinnacleLadders, betfairLines, softBooks, clvMultipliers,
    evThreshold: VALUE_BET_EV_THRESHOLD, rejectThreshold: VALUE_BET_REJECT_THRESHOLD, now,
  });

  const earliest = now; // prematch-only: ingen bakåt-grace → redan startade/live matcher tappas
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const out: ValueBetEntry[] = [];
  for (const v of vbs) {
    const ms = Date.parse(v.startTime);
    if (!Number.isFinite(ms) || ms < earliest || ms > latest) continue;
    const brand = TOTALS_BOOK_BRAND[v.bookmaker] ?? { id: v.bookmaker, name: v.bookmaker };
    const overProb = v.selection === "OVER" ? v.fairProb : 1 - v.fairProb;
    const underProb = 1 - overProb;
    const selLabel = v.selection === "OVER" ? "Över" : "Under";
    out.push({
      match: `${v.homeTeam} - ${v.awayTeam}`,
      startTs: v.startTime,
      league: v.league ?? undefined,
      market: "total",
      sport: "soccer",
      pinnacle: {
        sport: "soccer", tournament: v.league ?? undefined, startTs: v.startTime,
        eventId: v.eventId,
        odds: { over: 1 / overProb, under: 1 / underProb },
        impliedProbs: { over: overProb, under: underProb },
        overround: 0, vig: 0,
        fairProbs: { over: overProb, under: underProb },
        fairOdds: { over: 1 / overProb, under: 1 / underProb },
        limit: null,
      },
      bookmakerId: brand.id as BonusBookmakerId,
      bookmakerName: brand.name,
      outcome: v.selection === "OVER" ? "over" : "under",
      outcomeLabel: `${selLabel} ${v.line} mål`,
      line: v.line,
      bookmakerOdds: v.bookmakerOdds,
      fairProb: v.fairProb,
      fairOdds: v.fairOdds,
      ev: v.ev,
      evPct: v.ev * 100,
      verification: { teamsOk: true, leagueOk: true, timeOk: true, marketOk: true, startDeltaMs: 0 },
      needsReview: v.ev > VALUE_BET_REVIEW_THRESHOLD,
      comment: `Skarp konsensus (${v.sources.join("+")}) ${(v.fairProb * 100).toFixed(1)}% för ${selLabel} ${v.line} mål vs bookmaker @${v.bookmakerOdds.toFixed(2)} ger EV +${(v.ev * 100).toFixed(2)}%.`,
      isValueBet: true,
    });
  }
  return out;
}

/**
 * FOOTBALL ASIAN-HANDICAP-VALUEBETS i live-svaret. Återanvänder den bevisade
 * backend-motorn (computeAhValuebets: Pinnacle-AH-stege + Betfair-AH + SBOBET-AH-
 * blend + likviditet + CLV-vikt) och konverterar till ValueBetEntry. AH-linjen är
 * HEMMA-perspektiv — allt prissätts i Pinnacle-native ordning (HOME = Pinnacles
 * hemmalag). Bakom kill-switch (VALUEBETS_AH) + samma EV-/reject-grindar som 1X2.
 * Felsäkert: laddningsfel → tom lista.
 */
async function computeFootballAhValueBets(
  rawPinnacleJson: unknown,
  hoursWindow: number,
  pinnacleEvents?: PinnacleEvent[],
  pinnacleLadders?: Map<string, PinnacleLineLadders>,
): Promise<ValueBetEntry[]> {
  if (!rawPinnacleJson) return [];
  const softBooks: Array<{ id: string; json: unknown; franchise?: string }> = [];
  const tryLoad = async (id: string, loader: () => Promise<{ payload: unknown }>, franchise?: string) => {
    try { const r = await loader(); if (r?.payload) softBooks.push({ id, json: r.payload, franchise }); } catch { /* hoppa */ }
  };
  await Promise.all([
    tryLoad("comeon", loadComeOnPayloadWithMeta),
    tryLoad("betsson", loadBetssonPayloadWithMeta),
    tryLoad("vbet", loadVbetPayloadWithMeta),
    tryLoad("altenar", loadAltenarPayloadWithMeta),
    tryLoad("kambi", loadKambiPayloadWithMeta),
    tryLoad("atg", loadAtgPayloadWithMeta),
    tryLoad("coolbet", loadCoolbetPayloadWithMeta),
    tryLoad("svenskaspel", loadSvenskaspelPayloadWithMeta),
    tryLoad("paf", loadPafBrandPayloadWithMeta),
    // Bonus-syskon surfas under egen brand (identiska odds men egna bonusar):
    // nordicbet/betsafe delar betsson-cachen (flat events[]) → ingen franchise;
    // lucky/quick delar altenar-cachen (byIntegration) → franchise-nyckel krävs.
    tryLoad("nordicbet", loadBetssonPayloadWithMeta),
    tryLoad("betsafe", loadBetssonPayloadWithMeta),
    tryLoad("lucky", loadAltenarPayloadWithMeta, "luckycasino"),
    tryLoad("quick", loadAltenarPayloadWithMeta, "quickcasinose"),
    tryLoad("videoslots", loadAltenarPayloadWithMeta, "videoslotsse"),
    tryLoad("kungaslottet", loadAltenarPayloadWithMeta, "kungaslottetse"),
    tryLoad("campobet", loadAltenarPayloadWithMeta, "campose"),
    tryLoad("tipwin", loadTipwinPayloadWithMeta),
  ]);
  if (softBooks.length === 0) return [];

  // Betfair-AH (TOTALS+AH-mappen) — endast om FÄRSK (samma 3-min-grind som 1X2).
  let betfairLines: ReturnType<typeof parseBetfairLineRowsMap> | undefined;
  try {
    const bf = await loadBetfairPayloadWithMeta();
    const age = oddsDbPayloadAgeMs(bf.payload);
    if (bf.payload && age !== null && age <= SHARP_FRESHNESS_THRESHOLD_MS) betfairLines = parseBetfairLineRowsMap(bf.payload);
  } catch { /* ingen Betfair → bara Pinnacle */ }

  // SBOBET-AH — marknadsledande på AH, blandas in om FÄRSK.
  let sbobetAh: ReturnType<typeof parseSbobetAhRowsMap> | undefined;
  try {
    const sbo = await loadSbobetPayloadWithMeta();
    const age = oddsDbPayloadAgeMs(sbo.payload);
    if (sbo.payload && age !== null && age <= SHARP_FRESHNESS_THRESHOLD_MS) sbobetAh = parseSbobetAhRowsMap(sbo.payload);
  } catch { /* ingen SBOBET → Pinnacle (+ ev. Betfair) */ }

  let clvMultipliers: Record<string, number> = {};
  try {
    const cmPath = path.resolve(process.cwd(), "data", "clv-multipliers.json");
    if (fs.existsSync(cmPath)) clvMultipliers = JSON.parse(fs.readFileSync(cmPath, "utf-8"))?.multipliers ?? {};
  } catch { /* prior-vikter */ }

  const now = Date.now();
  const vbs = computeAhValuebets({
    pinnacleJson: rawPinnacleJson, pinnacleEvents, pinnacleLadders, betfairLines, sbobetAh, softBooks, clvMultipliers,
    evThreshold: VALUE_BET_EV_THRESHOLD, rejectThreshold: VALUE_BET_REJECT_THRESHOLD, now,
  });

  const earliest = now; // prematch-only: ingen bakåt-grace → redan startade/live matcher tappas
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const out: ValueBetEntry[] = [];
  for (const v of vbs) {
    const ms = Date.parse(v.startTime);
    if (!Number.isFinite(ms) || ms < earliest || ms > latest) continue;
    const brand = TOTALS_BOOK_BRAND[v.bookmaker] ?? { id: v.bookmaker, name: v.bookmaker };
    const homeProb = v.selection === "HOME" ? v.fairProb : 1 - v.fairProb;
    const awayProb = 1 - homeProb;
    // Linjen ur den valda sidans perspektiv (HOME = v.line, AWAY = -v.line).
    const selLine = v.selection === "HOME" ? v.line : -v.line;
    const selTeam = v.selection === "HOME" ? v.homeTeam : v.awayTeam;
    const signed = selLine > 0 ? `+${selLine}` : `${selLine}`;
    out.push({
      match: `${v.homeTeam} - ${v.awayTeam}`,
      startTs: v.startTime,
      league: v.league ?? undefined,
      market: "ah",
      sport: "soccer",
      pinnacle: {
        sport: "soccer", tournament: v.league ?? undefined, startTs: v.startTime,
        eventId: v.eventId,
        odds: { ah_home: 1 / homeProb, ah_away: 1 / awayProb },
        impliedProbs: { ah_home: homeProb, ah_away: awayProb },
        overround: 0, vig: 0,
        fairProbs: { ah_home: homeProb, ah_away: awayProb },
        fairOdds: { ah_home: 1 / homeProb, ah_away: 1 / awayProb },
        limit: null,
      },
      bookmakerId: brand.id as BonusBookmakerId,
      bookmakerName: brand.name,
      outcome: v.selection === "HOME" ? "ah_home" : "ah_away",
      outcomeLabel: `${selTeam} ${signed}`,
      line: v.line,
      bookmakerOdds: v.bookmakerOdds,
      fairProb: v.fairProb,
      fairOdds: v.fairOdds,
      ev: v.ev,
      evPct: v.ev * 100,
      verification: { teamsOk: true, leagueOk: true, timeOk: true, marketOk: true, startDeltaMs: 0 },
      needsReview: v.ev > VALUE_BET_REVIEW_THRESHOLD,
      comment: `Skarp konsensus (${v.sources.join("+")}) ${(v.fairProb * 100).toFixed(1)}% för ${selTeam} ${signed} vs bookmaker @${v.bookmakerOdds.toFixed(2)} ger EV +${(v.ev * 100).toFixed(2)}%.`,
      isValueBet: true,
    });
  }
  return out;
}

/**
 * FOOTBALL EUROPEISKT 3-VÄGS-HANDIKAPP (EH3) i live-svaret. Härleder Pinnacle-3-vägs-
 * HC ur en MULTI-SKARP konsensus av AH-stegen (Pinnacle + Betfair + SBOBET + Smarkets)
 * — aldrig Pinnacle ensam. Hård fler-källskonfirmation + disagreement-grindar (se
 * eh3Valuebets.ts) skyddar mot falska valuebets. OPT-IN bakom VALUEBETS_EH3=1 (default
 * AV tills teckenkonventionen validerats mot riktig data). Try/catch isolerar felet.
 */
async function computeFootballEh3ValueBets(
  rawPinnacleJson: unknown,
  hoursWindow: number,
  pinnacleEvents?: PinnacleEvent[],
  pinnacleLadders?: Map<string, PinnacleLineLadders>,
): Promise<ValueBetEntry[]> {
  if (!rawPinnacleJson) return [];
  const softBooks: Array<{ id: string; json: unknown; franchise?: string }> = [];
  const tryLoad = async (id: string, loader: () => Promise<{ payload: unknown }>, franchise?: string) => {
    try { const r = await loader(); if (r?.payload) softBooks.push({ id, json: r.payload, franchise }); } catch { /* hoppa */ }
  };
  // Böcker som (kan) emittera eh3 — motorn hoppar event utan eh3, så övriga är no-op.
  await Promise.all([
    tryLoad("tipwin", loadTipwinPayloadWithMeta),
    tryLoad("betsson", loadBetssonPayloadWithMeta),
    tryLoad("svenskaspel", loadSvenskaspelPayloadWithMeta),
  ]);
  if (softBooks.length === 0) return [];

  const fresh = (p: unknown) => { const a = oddsDbPayloadAgeMs(p); return a !== null && a <= SHARP_FRESHNESS_THRESHOLD_MS; };
  let betfairLines: ReturnType<typeof parseBetfairLineRowsMap> | undefined;
  try { const bf = await loadBetfairPayloadWithMeta(); if (bf.payload && fresh(bf.payload)) betfairLines = parseBetfairLineRowsMap(bf.payload); } catch { /* */ }
  let sbobetAh: ReturnType<typeof parseSbobetAhRowsMap> | undefined;
  try { const sbo = await loadSbobetPayloadWithMeta(); if (sbo.payload && fresh(sbo.payload)) sbobetAh = parseSbobetAhRowsMap(sbo.payload); } catch { /* */ }
  let smarketsAh: ReturnType<typeof parseSmarketsAhRowsMap> | undefined;
  try { const sm = await loadSmarketsPayloadWithMeta(); if (sm.payload && fresh(sm.payload)) smarketsAh = parseSmarketsAhRowsMap(sm.payload); } catch { /* */ }

  let clvMultipliers: Record<string, number> = {};
  try {
    const cmPath = path.resolve(process.cwd(), "data", "clv-multipliers.json");
    if (fs.existsSync(cmPath)) clvMultipliers = JSON.parse(fs.readFileSync(cmPath, "utf-8"))?.multipliers ?? {};
  } catch { /* */ }

  const now = Date.now();
  const vbs = computeEh3Valuebets({
    pinnacleJson: rawPinnacleJson, pinnacleEvents, pinnacleLadders, betfairLines, sbobetAh, smarketsAh, softBooks, clvMultipliers,
    evThreshold: VALUE_BET_EV_THRESHOLD, rejectThreshold: VALUE_BET_REJECT_THRESHOLD, now,
  });

  const earliest = now; // prematch-only: ingen bakåt-grace → redan startade/live matcher tappas
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const out: ValueBetEntry[] = [];
  for (const v of vbs) {
    const ms = Date.parse(v.startTime);
    if (!Number.isFinite(ms) || ms < earliest || ms > latest) continue;
    const brand = TOTALS_BOOK_BRAND[v.bookmaker] ?? { id: v.bookmaker, name: v.bookmaker };
    const signedH = v.line > 0 ? `+${v.line}` : `${v.line}`;
    const awayH = -v.line; const signedAway = awayH > 0 ? `+${awayH}` : `${awayH}`;
    const outcome: Outcome = v.selection === "HOME" ? "1" : v.selection === "DRAW" ? "X" : "2";
    const outcomeLabel =
      v.selection === "HOME" ? `${v.homeTeam} ${signedH}`
      : v.selection === "DRAW" ? `Oavgjort (HC ${signedH})`
      : `${v.awayTeam} ${signedAway}`;
    out.push({
      match: `${v.homeTeam} - ${v.awayTeam}`,
      startTs: v.startTime,
      league: v.league ?? undefined,
      market: "eh3",
      sport: "soccer",
      pinnacle: {
        sport: "soccer", tournament: v.league ?? undefined, startTs: v.startTime,
        eventId: v.eventId,
        odds: { [outcome]: v.fairOdds },
        impliedProbs: { [outcome]: v.fairProb },
        overround: 0, vig: 0,
        fairProbs: { [outcome]: v.fairProb },
        fairOdds: { [outcome]: v.fairOdds },
        limit: null,
      },
      bookmakerId: brand.id as BonusBookmakerId,
      bookmakerName: brand.name,
      outcome,
      outcomeLabel,
      line: v.line,
      bookmakerOdds: v.bookmakerOdds,
      fairProb: v.fairProb,
      fairOdds: v.fairOdds,
      ev: v.ev,
      evPct: v.ev * 100,
      verification: { teamsOk: true, leagueOk: true, timeOk: true, marketOk: true, startDeltaMs: 0 },
      needsReview: v.ev > VALUE_BET_REVIEW_THRESHOLD,
      comment: `Skarp multi-källa-konsensus (${v.sources.join("+")}) ${(v.fairProb * 100).toFixed(1)}% för ${outcomeLabel} (europeiskt 3-vägs-HC) vs bookmaker @${v.bookmakerOdds.toFixed(2)} ger EV +${(v.ev * 100).toFixed(2)}%.`,
      isValueBet: true,
    });
  }
  return out;
}

/**
 * FOOTBALL HÖRN-VALUEBETS (corner totals + corner AH) i live-svaret. Prissätts mot
 * Pinnacles hörn-stege (parsePinnacleCornerLadders — sharp referens). OPT-IN bakom
 * VALUEBETS_CORNERS=1. Try/catch isolerar. Soft-böcker som ännu inte emitterar
 * corners-fältet bidrar inget (motorn hoppar dem).
 */
async function computeFootballCornersValueBets(
  rawPinnacleJson: unknown,
  hoursWindow: number,
  pinnacleEvents?: PinnacleEvent[],
): Promise<ValueBetEntry[]> {
  if (!rawPinnacleJson) return [];
  const softBooks: Array<{ id: string; json: unknown; franchise?: string }> = [];
  const tryLoad = async (id: string, loader: () => Promise<{ payload: unknown }>, franchise?: string) => {
    try { const r = await loader(); if (r?.payload) softBooks.push({ id, json: r.payload, franchise }); } catch { /* */ }
  };
  await Promise.all([
    tryLoad("svenskaspel", loadSvenskaspelPayloadWithMeta),
    tryLoad("kambi", loadKambiPayloadWithMeta),
    tryLoad("atg", loadAtgPayloadWithMeta),
    tryLoad("betsson", loadBetssonPayloadWithMeta),
    // Betsson-syskon surfas under egen brand (delar betsson-cachen → samma hörn).
    tryLoad("nordicbet", loadBetssonPayloadWithMeta),
    tryLoad("betsafe", loadBetssonPayloadWithMeta),
    tryLoad("altenar", loadAltenarPayloadWithMeta),
    tryLoad("comeon", loadComeOnPayloadWithMeta),
    tryLoad("coolbet", loadCoolbetPayloadWithMeta),
    tryLoad("tipwin", loadTipwinPayloadWithMeta),
  ]);
  if (softBooks.length === 0) return [];

  const now = Date.now();
  const vbs = computeCornersValuebets({
    pinnacleJson: rawPinnacleJson, pinnacleEvents, softBooks,
    evThreshold: VALUE_BET_EV_THRESHOLD, rejectThreshold: VALUE_BET_REJECT_THRESHOLD, now,
  });

  const earliest = now; // prematch-only: ingen bakåt-grace → redan startade/live matcher tappas
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const out: ValueBetEntry[] = [];
  for (const v of vbs) {
    const ms = Date.parse(v.startTime);
    if (!Number.isFinite(ms) || ms < earliest || ms > latest) continue;
    const brand = TOTALS_BOOK_BRAND[v.bookmaker] ?? { id: v.bookmaker, name: v.bookmaker };
    const isTotal = v.market === "corner_total";
    const outcome = isTotal ? (v.selection === "OVER" ? "over" : "under") : (v.selection === "HOME" ? "ah_home" : "ah_away");
    const signedH = v.line > 0 ? `+${v.line}` : `${v.line}`;
    const label = isTotal
      ? `${v.selection === "OVER" ? "Över" : "Under"} ${v.line} hörn`
      : `${v.selection === "HOME" ? v.homeTeam : v.awayTeam} ${v.selection === "HOME" ? signedH : (-v.line > 0 ? `+${-v.line}` : `${-v.line}`)} hörn`;
    out.push({
      match: `${v.homeTeam} - ${v.awayTeam}`,
      startTs: v.startTime,
      league: v.league ?? undefined,
      market: v.market,
      sport: "soccer",
      pinnacle: {
        sport: "soccer", tournament: v.league ?? undefined, startTs: v.startTime,
        eventId: v.eventId,
        odds: { [outcome]: v.fairOdds }, impliedProbs: { [outcome]: v.fairProb },
        overround: 0, vig: 0, fairProbs: { [outcome]: v.fairProb }, fairOdds: { [outcome]: v.fairOdds },
        limit: v.pinnacleLimit,
      },
      bookmakerId: brand.id as BonusBookmakerId,
      bookmakerName: brand.name,
      outcome,
      outcomeLabel: label,
      line: v.line,
      bookmakerOdds: v.bookmakerOdds,
      fairProb: v.fairProb,
      fairOdds: v.fairOdds,
      ev: v.ev,
      evPct: v.ev * 100,
      verification: { teamsOk: true, leagueOk: true, timeOk: true, marketOk: true, startDeltaMs: 0 },
      needsReview: v.ev > VALUE_BET_REVIEW_THRESHOLD,
      comment: `Pinnacle hörn-stege ${(v.fairProb * 100).toFixed(1)}% för ${label} vs bookmaker @${v.bookmakerOdds.toFixed(2)} ger EV +${(v.ev * 100).toFixed(2)}% (Pinnacle-limit ${v.pinnacleLimit ?? "?"}).`,
      isValueBet: true,
    });
  }
  return out;
}

async function compute2WayValueBets(
  pinnacleRows: PinnacleRow[],
  hoursWindow: number,
): Promise<ValueBetEntry[]> {
  const out: ValueBetEntry[] = [];
  // Varje 2-vägs-sport: Pinnacle-sport-tag + Altenars per-sport events-array.
  const SPORT_2WAY_CONFIGS: Array<{ sport: string; field: string }> = [
    { sport: "basketball", field: "eventsBasket" },
    { sport: "tennis", field: "eventsTennis" },
  ];

  // Samla alla 2-vägs-källor (per bokmakare). Varje källa exponerar
  // eventsBasket / eventsTennis. Fler källor = fler bokmakare per match = fler
  // valuebets. En källa som failar ignoreras (de andra fortsätter).
  const sources: Array<{ bookmakerId: string; bookmakerName: string; eventsBasket: unknown; eventsTennis: unknown }> = [];
  // Altenar — per integration (per brand).
  try {
    const altenar = await loadAltenarPayloadWithMeta();
    const byIntegration = altenar.payload?.byIntegration ?? {};
    const integToBrand = new Map(
      ALTENAR_MULTI_SPORT_INTEGRATIONS.map((b) => [b.integration, { id: b.id, name: b.name }]),
    );
    for (const [integ, cacheRaw] of Object.entries(byIntegration)) {
      const brand = integToBrand.get(integ);
      if (!brand) continue;
      const c = cacheRaw as Record<string, unknown>;
      sources.push({ bookmakerId: brand.id, bookmakerName: brand.name, eventsBasket: c.eventsBasket, eventsTennis: c.eventsTennis });
    }
  } catch { /* Altenar saknas → hoppa */ }
  // Kambi (Unibet).
  try {
    const kambi = await loadKambiPayloadWithMeta();
    const p = kambi.payload as Record<string, unknown> | null;
    if (p) sources.push({ bookmakerId: "unibet", bookmakerName: "Unibet", eventsBasket: p.eventsBasket, eventsTennis: p.eventsTennis });
  } catch { /* Kambi saknas → hoppa */ }
  // ComeOn-gruppen — per franchise (delar odds, UI grupperar dem som fotbollen).
  try {
    const comeon = await loadComeOnPayloadWithMeta();
    const byFranchise = (comeon.payload?.byFranchise ?? {}) as Record<string, Record<string, unknown>>;
    const COMEON_FRANCHISE_BRAND: Record<string, { id: string; name: string }> = {
      SWEDEN_HAJPER: { id: "hajper", name: "Hajper" },
      SWEDEN_SNABBARE: { id: "snabbare", name: "Snabbare" },
      SWEDEN_COMEON: { id: "comeon", name: "ComeOn" },
      SWEDEN_CASINOSTUGAN: { id: "casinostugan", name: "Casinostugan" },
      SWEDEN_LYLLO: { id: "lyllo", name: "Lyllo" },
    };
    for (const [code, cache] of Object.entries(byFranchise)) {
      const brand = COMEON_FRANCHISE_BRAND[code];
      if (!brand) continue;
      sources.push({ bookmakerId: brand.id, bookmakerName: brand.name, eventsBasket: cache.eventsBasket, eventsTennis: cache.eventsTennis });
    }
  } catch { /* ComeOn saknas → hoppa */ }
  // Betsson-gruppen — ett delat odds-set, alla brands pekar på samma 2-vägs-events.
  try {
    const betsson = await loadBetssonPayloadWithMeta();
    const p = betsson.payload as Record<string, unknown> | null;
    if (p) {
      const BETSSON_BRANDS = [
        { id: "betsson", name: "Betsson" },
        { id: "bethard", name: "Bethard" },
        { id: "spelklubben", name: "Spelklubben" },
        { id: "nordicbet", name: "NordicBet" },
        { id: "betsafe", name: "Betsafe" },
      ];
      for (const b of BETSSON_BRANDS) {
        sources.push({ bookmakerId: b.id, bookmakerName: b.name, eventsBasket: p.eventsBasket, eventsTennis: p.eventsTennis });
      }
    }
  } catch { /* Betsson saknas → hoppa */ }
  // VBET — eget odds-set. eventsBasket/eventsTennis saknas tills scrapern börjat
  // producera 2-vägs (då bidrar den tyst inget).
  try {
    const vbet = await loadVbetPayloadWithMeta();
    const p = vbet.payload as Record<string, unknown> | null;
    if (p) sources.push({ bookmakerId: "vbet", bookmakerName: "VBET", eventsBasket: p.eventsBasket, eventsTennis: p.eventsTennis });
  } catch { /* VBET saknas → hoppa */ }
  if (sources.length === 0) return out;

  const now = Date.now();
  const earliest = now; // prematch-only: ingen bakåt-grace → redan startade/live matcher tappas
  const latest = now + hoursWindow * 60 * 60 * 1000;
  const labels2: Record<"1" | "2", string> = { "1": "Hemma", "2": "Borta" };

  for (const cfg of SPORT_2WAY_CONFIGS) {
    const pinnacleForSport = pinnacleRows.filter(
      (row) =>
        row.sport === cfg.sport &&
        row.marketType === "moneyline" &&
        Number.isFinite(row.homeOdds) && row.homeOdds > 1 &&
        Number.isFinite(row.awayOdds) && row.awayOdds > 1,
    );
    if (pinnacleForSport.length === 0) continue;

    // CPU-yield: samma motiv som fotbollsloopen — släpp event-loopen periodvis
    // så 2-vägs-matchningen inte fryser servern under en ombyggnad.
    let twoWayYield = 0;
    for (const src of sources) {
    const events = ((src as unknown as Record<string, unknown>)[cfg.field] ?? []) as Array<{
      title?: string;
      homeTeam?: string | null;
      awayTeam?: string | null;
      startTime?: string | null;
      league?: string | null;
      odds?: { home?: number; away?: number };
    }>;
    for (const ev of events) {
      if (++twoWayYield % 30 === 0) await new Promise((r) => setImmediate(r));
      const rawTitle = String(ev.title ?? "").trim();
      const bookHome = ev.odds?.home;
      const bookAway = ev.odds?.away;
      if (!(typeof bookHome === "number" && bookHome > 1)) continue;
      if (!(typeof bookAway === "number" && bookAway > 1)) continue;

      // KRITISKT (mot falska value bets): härled sidorna (outcome 1/2) ur
      // bookmakerns home/away-LAG, INTE ur den fria titel-strängen. odds.home hör
      // ihop med homeTeam och odds.away med awayTeam (scraperns kontrakt). Titel-
      // ordningen kan avvika från home/away — sett på Kambi-tennis där event.name
      // listar spelarna i annan ordning än home/away — och att läsa sidorna ur
      // titeln kopplade då fel odds till fel spelare (t.ex. Farias 2.08 hamnade på
      // Zhizhen Zhang → falskt +14% EV). Kanonisk titel "homeTeam - awayTeam" gör
      // att outcome 1 = home = odds.home och outcome 2 = away = odds.away, både i
      // beräkningen och i frontendens utfall→lag-mappning.
      const homeName = String(ev.homeTeam ?? "").trim();
      const awayName = String(ev.awayTeam ?? "").trim();
      const canonicalTitle = homeName && awayName ? `${homeName} - ${awayName}` : rawTitle;
      if (!canonicalTitle) continue;
      const bookSides = getMatchSideTokens(canonicalTitle);
      if (bookSides.length < 2) continue; // kan inte säkert avgöra sidorna → hoppa
      const startMs = Date.parse(ev.startTime ?? "");
      if (!Number.isFinite(startMs) || startMs < earliest || startMs > latest) continue;

      // Matcha mot Pinnacle: namn + tid (±tol) + sida-alignment via LAG-identitet.
      let pin: PinnacleRow | undefined;
      let swap = false;
      let bestDelta: number | null = null;
      for (const row of pinnacleForSport) {
        if (!isLikelySameMatch(row.match, canonicalTitle)) continue;
        if (!Number.isFinite(row.startTime)) continue;
        const delta = Math.abs((row.startTime as number) - startMs);
        if (delta > VALUE_BET_TIME_TOLERANCE_MS) continue;
        const pSides = getMatchSideTokens(row.match);
        if (pSides.length < 2) continue;
        const direct = sideMatches(pSides[0], bookSides[0]) && sideMatches(pSides[1], bookSides[1]);
        const reversed = sideMatches(pSides[0], bookSides[1]) && sideMatches(pSides[1], bookSides[0]);
        // Kräv EXAKT en entydig alignment. Matchar varken (fel match) eller båda
        // (tvetydigt) → vi kan inte garantera rätt sida → hoppa hellre än att gissa.
        if (direct === reversed) continue;
        if (bestDelta === null || delta < bestDelta) {
          bestDelta = delta;
          pin = row;
          swap = reversed;
        }
      }
      if (!pin) continue;

      const pinnacleOdds: Record<"1" | "2", number> = {
        "1": swap ? pin.awayOdds : pin.homeOdds,
        "2": swap ? pin.homeOdds : pin.awayOdds,
      };
      const noVig = computeNoVig(pinnacleOdds);
      if (!noVig) continue;
      const fairProbs = Object.fromEntries(noVig.outcomes.map((o) => [o.outcome, o.fairProb])) as Record<string, number>;
      const fairOddsMap = Object.fromEntries(noVig.outcomes.map((o) => [o.outcome, o.fairOdds])) as Record<string, number>;
      const impliedProbs = Object.fromEntries(noVig.outcomes.map((o) => [o.outcome, o.impliedProb])) as Record<string, number>;

      const pinnacleBlock = {
        sport: pin.sport,
        tournament: pin.tournament,
        eventId: pin.matchupId != null ? String(pin.matchupId) : undefined,
        startTs: pin.startTime && Number.isFinite(pin.startTime) ? new Date(pin.startTime).toISOString() : undefined,
        odds: pinnacleOdds as Record<string, number>,
        impliedProbs,
        overround: noVig.overround,
        vig: noVig.vig,
        fairProbs,
        fairOdds: fairOddsMap,
        // Live Pinnacle-likviditet — även för 2-vägs (tennis/basket) valuebets.
        limit: typeof pin.limit === "number" && pin.limit > 0 ? pin.limit : null,
      };

      const bookByOutcome: Record<"1" | "2", number> = { "1": bookHome, "2": bookAway };
      for (const outcome of ["1", "2"] as const) {
        const bookOdds = bookByOutcome[outcome];
        const fairProb = fairProbs[outcome];
        if (!(fairProb > 0)) continue;
        const evVal = fairProb * bookOdds - 1;
        if (evVal <= VALUE_BET_EV_THRESHOLD || evVal > VALUE_BET_REJECT_THRESHOLD) continue;
        // Favorit-flip = trolig sidoswap hos boken (underdog @ bok men favorit @
        // Pinnacle) → falskt värde, hoppa över.
        if (isFavoriteFlipArtifact(bookOdds, fairProb)) continue;
        const needsReview = evVal > VALUE_BET_REVIEW_THRESHOLD;
        out.push({
          match: canonicalTitle,
          startTs: ev.startTime ?? undefined,
          league: ev.league ?? undefined,
          market: "moneyline",
          sport: cfg.sport,
          pinnacle: pinnacleBlock,
          bookmakerId: src.bookmakerId as BonusBookmakerId,
          bookmakerName: src.bookmakerName,
          outcome: outcome as Outcome,
          outcomeLabel: labels2[outcome],
          bookmakerOdds: bookOdds,
          fairProb,
          fairOdds: fairOddsMap[outcome],
          ev: evVal,
          evPct: evVal * 100,
          verification: { teamsOk: true, leagueOk: true, timeOk: true, marketOk: true, startDeltaMs: bestDelta },
          needsReview,
          comment: needsReview
            ? `EV ${(evVal * 100).toFixed(2)}% överstiger ${VALUE_BET_REVIEW_THRESHOLD * 100}%-tröskeln — dubbelkolla marknaden (stale odds / fel match).`
            : `Pinnacle-fair ${(fairProb * 100).toFixed(1)}% vs bookmaker @${bookOdds.toFixed(2)} ger EV +${(evVal * 100).toFixed(2)}%.`,
          isValueBet: true,
        });
      }
    }
    }
  }
  return out;
}

/**
 * Hitta Pinnacles AKTUELLA no-vig fair-odds för en loggad bet (oavsett om den
 * fortfarande är en value bet). Används för auto-CLV: klienten fryser detta
 * vid avspark som closingFairOdds. Återanvänder samma matchning som valuebets.
 */
function pinnacleFairOddsForBet(
  pinnacleRows: PinnacleRow[],
  bet: { match: string; outcome: string; startTs?: string; sport?: string },
): { fairOdds: number; pinnacleMatch: string } | null {
  const sport = bet.sport || "soccer";
  const is3way = sport === "soccer";
  const candidates = pinnacleRows.filter(
    (row) =>
      row.sport === sport &&
      row.marketType === "moneyline" &&
      Number.isFinite(row.homeOdds) && row.homeOdds > 1 &&
      Number.isFinite(row.awayOdds) && row.awayOdds > 1 &&
      (!is3way || (Number.isFinite(row.drawOdds) && (row.drawOdds ?? 0) > 1)),
  );
  const betMs = bet.startTs ? Date.parse(bet.startTs) : NaN;
  let best: PinnacleRow | undefined;
  let swap = false;
  let bestDelta = Infinity;
  for (const row of candidates) {
    if (!isLikelySameMatch(row.match, bet.match)) continue;
    if (Number.isFinite(betMs) && Number.isFinite(row.startTime)) {
      const delta = Math.abs((row.startTime as number) - betMs);
      if (delta > 30 * 60 * 1000) continue; // ±30 min (closing kan vara nära/efter avspark)
      if (delta >= bestDelta) continue;
      bestDelta = delta;
    }
    const tSides = getMatchSideTokens(bet.match);
    const pSides = getMatchSideTokens(row.match);
    if (tSides.length >= 2 && pSides.length >= 2) {
      const direct = sideMatches(pSides[0], tSides[0]) && sideMatches(pSides[1], tSides[1]);
      const reversed = sideMatches(pSides[0], tSides[1]) && sideMatches(pSides[1], tSides[0]);
      if (!direct && !reversed) continue;
      best = row;
      swap = reversed;
    } else {
      best = row;
    }
  }
  if (!best) return null;
  const odds: Record<string, number> = is3way
    ? { "1": swap ? best.awayOdds : best.homeOdds, X: best.drawOdds as number, "2": swap ? best.homeOdds : best.awayOdds }
    : { "1": swap ? best.awayOdds : best.homeOdds, "2": swap ? best.homeOdds : best.awayOdds };
  const noVig = computeNoVig(odds);
  if (!noVig) return null;
  const fair = noVig.outcomes.find((o) => o.outcome === bet.outcome);
  if (!fair) return null;
  return { fairOdds: fair.fairOdds, pinnacleMatch: best.match };
}

/**
 * POST /api/pinnacle-fair-odds — batch. Body: { bets: [{id,match,outcome,startTs,sport}] }.
 * Returnerar Pinnacles aktuella no-vig fair-odds per bet (för auto-CLV-fångst).
 */
async function pinnacleFairOddsDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/pinnacle-fair-odds") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: "Use POST" })); return; }
  try {
    const body = await readRequestBody(req);
    const parsed = JSON.parse(body) as { bets?: Array<{ id: string; match: string; outcome: string; startTs?: string; sport?: string }> };
    const bets = Array.isArray(parsed?.bets) ? parsed.bets.slice(0, 500) : [];
    const meta = await buildPinnacleRowsWithMeta();
    const rows = meta.rows;
    const results = bets.map((b) => {
      const r = b?.match && b?.outcome ? pinnacleFairOddsForBet(rows, b) : null;
      return { id: b.id, fairOdds: r?.fairOdds ?? null, pinnacleMatch: r?.pinnacleMatch ?? null };
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, pinnacleUpdatedAt: meta.updatedAt, results }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown pinnacle-fair-odds error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

// ── Auto-resultat: multi-källa-resolver ────────────────────────────────────
// Flera oberoende resultatkällor frågas i parallell och normaliseras till EN
// gemensam event-form. Fler källor = fler matcher auto-settlas; nischade ligor
// (som gratis-API:er ofta missar) fångas av Sofascore. Tennis stöds nu också.
//
//   1. TheSportsDB  (gratis, key "3")     — fotboll + basket, breda men luckor
//   2. ESPN         (gratis, ingen key)   — stora ligor, robust
//   3. Sofascore    (gratis, ingen key)   — bredast täckning inkl. nisch + tennis
//
// Varje källa är feltolerant: 403/timeout/parse-fel → tom lista, nästa källa
// täcker. Resultatet är union:en av alla källors events för dagen; matchnings-
// logiken (isLikelySameMatch + sido-swap) plockar rätt rad oavsett källa.

const TSDB_FREE_KEY = "3";
/** sportKey (vårt interna) → namn/slug per källa. null/[] = källan täcker ej sporten. */
const TSDB_SPORT_NAME: Record<string, string> = { soccer: "Soccer", basketball: "Basketball" };
const ESPN_SPORT_PATHS: Record<string, string[]> = {
  // Flera scoreboards per sport — ESPN delar upp per liga. WNBA tillagd
  // 2026-06-12 efter verifiering: TSDB hittade en WNBA-final som ESPN:s
  // nba-scoreboard inte täcker.
  soccer: ["soccer/all"],
  basketball: ["basketball/nba", "basketball/wnba"],
  tennis: [], // ESPN tennis-scoreboard har annan form → hoppas över
};
const SOFASCORE_SPORT: Record<string, string> = {
  soccer: "football",
  basketball: "basketball",
  tennis: "tennis",
};
/** Sofascore-värdar i fallback-ordning: huvud-API:t Cloudflare-blockar ofta
 *  datacenter-IP:er (verifierat 0 events från Render 2026-06-12); mobil-API:t
 *  (.app) och webbens /api/v1 är ofta mer tillåtande. Första som svarar vinner. */
const SOFASCORE_HOSTS = [
  "https://api.sofascore.com/api/v1",
  "https://api.sofascore.app/api/v1",
  "https://www.sofascore.com/api/v1",
];

/** Senaste hämtnings-diagnostik per källa — exponeras i /api/result-sources-debug
 *  så vi kan se EXAKT varför en källa gav 0 events (HTTP-status vs tom dag). */
const resultSourceDiag = new Map<string, string>();

/** Normaliserad slutresultat-form delad mellan alla källor. */
type NormEvent = {
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  finished: boolean;
  /** Avsparkstid (ISO) om källan anger den — används som tids-veto vid matchning. */
  startTs: string | null;
  /** Liga/turneringsnamn om källan anger det — används som liga-veto vid matchning. */
  league: string | null;
};

const RESULT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── Källa 0: Committade resultat (Actions-hämtad Sofascore-data) ────────────
// .github/workflows/results-fetch.yml hämtar färdiga matcher var 30:e min
// från en Actions-runner (vars IP Sofascore INTE blockar) och publicerar
// data/match-results.json + Supabase-spegel. Render läser bara den
// publicerade filen — behöver aldrig prata med Sofascore direkt.
type MatchResultsPayload = {
  updatedAt?: string | null;
  days?: Record<
    string,
    Array<{ home: string; away: string; homeScore: number; awayScore: number; startTs: string | null; league: string | null }>
  >;
};
const MATCH_RESULTS_FILE = path.resolve(process.cwd(), "data", "match-results.json");
const MATCH_RESULTS_RAW_URL =
  process.env.MATCH_RESULTS_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/match-results.json";
const matchResultsRam: { at: number; payload: MatchResultsPayload | null } = { at: 0, payload: null };

function readMatchResultsFromDisk(): MatchResultsPayload | null {
  try {
    if (!fs.existsSync(MATCH_RESULTS_FILE)) return null;
    const disk = JSON.parse(fs.readFileSync(MATCH_RESULTS_FILE, "utf-8")) as MatchResultsPayload;
    return disk?.days ? disk : null;
  } catch {
    return null;
  }
}

async function loadMatchResultsPayload(): Promise<MatchResultsPayload | null> {
  if (Date.now() - matchResultsRam.at < 60_000) return matchResultsRam.payload;
  let payload: MatchResultsPayload | null = null;
  // 1) Supabase-spegeln — färskast på Render (ingen commit/pull-lag).
  try {
    const db = (await fetchOddsDbPayload("match-results")) as MatchResultsPayload | null;
    if (db?.days) payload = db;
  } catch {
    /* nästa väg */
  }
  // 2) Disk om FÄRSK (<45 min) — täcker dev + direkt efter deploy.
  if (!payload) {
    const disk = readMatchResultsFromDisk();
    const age = disk?.updatedAt ? Date.now() - Date.parse(disk.updatedAt) : Infinity;
    if (disk && Number.isFinite(age) && age < 45 * 60 * 1000) payload = disk;
  }
  // 3) GitHub raw — Render utan DB-secrets / gammal disk.
  if (!payload) {
    try {
      const r = await fetch(MATCH_RESULTS_RAW_URL, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const gh = (await r.json()) as MatchResultsPayload;
        if (gh?.days) payload = gh;
      }
    } catch {
      /* sista utvägen nedan */
    }
  }
  // 4) Disk oavsett ålder — gamla resultat är fortfarande korrekta resultat.
  if (!payload) payload = readMatchResultsFromDisk();
  matchResultsRam.at = Date.now();
  matchResultsRam.payload = payload;
  return payload;
}

async function committedResultsNormForDay(date: string, sportKey: string): Promise<NormEvent[]> {
  const payload = await loadMatchResultsPayload();
  const rows = payload?.days?.[`${date}::${sportKey}`];
  if (!Array.isArray(rows) || rows.length === 0) {
    resultSourceDiag.set(
      "committed",
      payload
        ? `0 rader för ${date}::${sportKey} (updatedAt ${payload.updatedAt ?? "?"})`
        : "payload saknas — results-fetch.yml har inte publicerat än",
    );
    return [];
  }
  resultSourceDiag.set(
    "committed",
    `${rows.length} finished för ${date}::${sportKey} (updatedAt ${payload?.updatedAt ?? "?"})`,
  );
  return rows.map((r) => ({
    home: r.home,
    away: r.away,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    finished: true,
    startTs: r.startTs ?? null,
    league: r.league ?? null,
  }));
}

// ── Källa 1: TheSportsDB ────────────────────────────────────────────────────
const tsdbDayCache = new Map<string, { at: number; events: Array<Record<string, unknown>> }>();

async function tsdbEventsForDay(date: string, sportName: string): Promise<Array<Record<string, unknown>>> {
  const key = `${date}::${sportName}`;
  const cached = tsdbDayCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.events;
  try {
    const r = await fetch(
      `https://www.thesportsdb.com/api/v1/json/${TSDB_FREE_KEY}/eventsday.php?d=${date}&s=${encodeURIComponent(sportName)}`,
      { signal: AbortSignal.timeout(12000) },
    );
    const j = (await r.json()) as { events?: Array<Record<string, unknown>> };
    const events = Array.isArray(j?.events) ? j.events : [];
    resultSourceDiag.set("thesportsdb", `HTTP ${r.status}, ${events.length} events`);
    tsdbDayCache.set(key, { at: Date.now(), events });
    return events;
  } catch (e) {
    resultSourceDiag.set("thesportsdb", e instanceof Error ? e.message : String(e));
    return [];
  }
}

function tsdbNormalize(events: Array<Record<string, unknown>>): NormEvent[] {
  // Slut-status varierar per sport: fotboll "FT"/"Match Finished", basket ofta
  // "Final"/"AOT"/"AET" — och mindre ligor lämnar strStatus TOM medan slut-
  // siffror fylls i. Poäng + (slut-status ELLER tom status) ⇒ klart. Bets
  // pollas först >2.5h efter avspark så live-läckage är osannolikt.
  const FINISHED = new Set(["ft", "match finished", "aet", "aot", "ot", "finished", "final", "after extra time"]);
  return events.map((e) => {
    const status = String(e.strStatus ?? "").trim().toLowerCase();
    const hs = e.intHomeScore;
    const as = e.intAwayScore;
    const hasScore = hs != null && as != null && hs !== "" && as !== "";
    // strTimestamp är ISO-UTC; fallback dateEvent + strTime (lokal/oklar zon
    // → används bara som grov tids-veto, 3h-toleransen absorberar zondiff).
    const ts = String(e.strTimestamp ?? "").trim();
    const dateEvent = String(e.dateEvent ?? "").trim();
    const strTime = String(e.strTime ?? "").trim();
    const startTs = ts || (dateEvent && strTime ? `${dateEvent}T${strTime}` : null);
    return {
      home: String(e.strHomeTeam ?? "").trim(),
      away: String(e.strAwayTeam ?? "").trim(),
      homeScore: hasScore ? Number(hs) : null,
      awayScore: hasScore ? Number(as) : null,
      finished: hasScore && (FINISHED.has(status) || status === ""),
      startTs,
      league: String(e.strLeague ?? "").trim() || null,
    };
  });
}

// ── Källa 2: ESPN scoreboard (gratis, ingen key) ────────────────────────────
async function espnNormForDay(date: string, sportKey: string): Promise<NormEvent[]> {
  const paths = ESPN_SPORT_PATHS[sportKey] ?? [];
  if (paths.length === 0) return [];
  const ymd = date.replace(/-/g, "");
  const out: NormEvent[] = [];
  const diag: string[] = [];
  for (const path of paths) {
    try {
      const r = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${ymd}&limit=300`,
        { headers: { "User-Agent": RESULT_BROWSER_UA }, signal: AbortSignal.timeout(12000) },
      );
      if (!r.ok) {
        diag.push(`${path}: HTTP ${r.status}`);
        continue;
      }
      const j = (await r.json()) as { events?: Array<Record<string, unknown>> };
      const events = Array.isArray(j?.events) ? j.events : [];
      diag.push(`${path}: HTTP 200, ${events.length} events`);
      out.push(...espnEventsToNorm(events));
    } catch (e) {
      diag.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  resultSourceDiag.set("espn", diag.join(" · "));
  return out;
}

function espnEventsToNorm(events: Array<Record<string, unknown>>): NormEvent[] {
  const out: NormEvent[] = [];
  for (const ev of events) {
      const comp = (ev.competitions as Array<Record<string, unknown>> | undefined)?.[0];
      if (!comp) continue;
      const competitors = comp.competitors as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(competitors) || competitors.length < 2) continue;
      const homeC = competitors.find((c) => c.homeAway === "home");
      const awayC = competitors.find((c) => c.homeAway === "away");
      if (!homeC || !awayC) continue;
      // completed-flaggan kan ligga på competition- ELLER event-nivå beroende
      // på sport/liga (verifierat 2026-06-12: WNBA-finaler hade den bara på
      // event-nivån → finished:0 trots färdiga matcher).
      const compStatus = (comp.status as { type?: { completed?: boolean } } | undefined)?.type;
      const evStatus = (ev.status as { type?: { completed?: boolean } } | undefined)?.type;
      const statusType = { completed: compStatus?.completed === true || evStatus?.completed === true };
      const home = String((homeC.team as { displayName?: string })?.displayName ?? "").trim();
      const away = String((awayC.team as { displayName?: string })?.displayName ?? "").trim();
      const hs = Number(homeC.score);
      const as = Number(awayC.score);
      const hasScore = Number.isFinite(hs) && Number.isFinite(as);
      // ESPN-event har ISO-datum; liganamn saknas ofta per event i /all-svar →
      // null (saknad data blockerar inte liga-vetot).
      const evDate = String(ev.date ?? "").trim() || null;
      const leagueName = String((ev.league as { name?: string })?.name ?? "").trim() || null;
      out.push({
        home,
        away,
        homeScore: hasScore ? hs : null,
        awayScore: hasScore ? as : null,
        finished: hasScore && statusType?.completed === true,
        startTs: evDate,
        league: leagueName,
      });
  }
  return out;
}

// ── Källa 3: Sofascore scheduled-events (gratis, bredast täckning) ───────────
async function sofascoreNormForDay(date: string, sportKey: string): Promise<NormEvent[]> {
  const sport = SOFASCORE_SPORT[sportKey];
  if (!sport) return [];
  const diag: string[] = [];
  let events: Array<Record<string, unknown>> | null = null;
  // Prova värdarna i ordning — Cloudflare blockar ofta huvud-API:t från
  // datacenter-IP:er men släpper igenom mobil-/webb-värdarna.
  for (const host of SOFASCORE_HOSTS) {
    try {
      const r = await fetch(`${host}/sport/${sport}/scheduled-events/${date}`, {
        headers: {
          "User-Agent": RESULT_BROWSER_UA,
          Accept: "application/json",
          "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
          Referer: "https://www.sofascore.com/",
          Origin: "https://www.sofascore.com",
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        diag.push(`${new URL(host).host}: HTTP ${r.status}`);
        continue;
      }
      const j = (await r.json()) as { events?: Array<Record<string, unknown>> };
      const list = Array.isArray(j?.events) ? j.events : [];
      diag.push(`${new URL(host).host}: HTTP 200, ${list.length} events`);
      events = list;
      break;
    } catch (e) {
      diag.push(`${new URL(host).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  resultSourceDiag.set("sofascore", diag.join(" · "));
  if (!events) return [];
  try {
    const out: NormEvent[] = [];
    for (const ev of events) {
      const home = String((ev.homeTeam as { name?: string })?.name ?? "").trim();
      const away = String((ev.awayTeam as { name?: string })?.name ?? "").trim();
      if (!home || !away) continue;
      const statusType = (ev.status as { type?: string })?.type;
      const hs = (ev.homeScore as { current?: number; display?: number })?.current
        ?? (ev.homeScore as { display?: number })?.display;
      const as = (ev.awayScore as { current?: number; display?: number })?.current
        ?? (ev.awayScore as { display?: number })?.display;
      const hasScore = typeof hs === "number" && typeof as === "number";
      // startTimestamp = unix-sekunder UTC; tournament/uniqueTournament = liga.
      const startSec = Number(ev.startTimestamp);
      const tournament =
        String((ev.tournament as { uniqueTournament?: { name?: string } })?.uniqueTournament?.name ?? "").trim() ||
        String((ev.tournament as { name?: string })?.name ?? "").trim();
      out.push({
        home,
        away,
        homeScore: hasScore ? hs : null,
        awayScore: hasScore ? as : null,
        finished: hasScore && statusType === "finished",
        startTs: Number.isFinite(startSec) && startSec > 0 ? new Date(startSec * 1000).toISOString() : null,
        league: tournament || null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Aggregator: alla källor för en (datum, sportKey), parallellt + cachat ────
const normDayCache = new Map<string, { at: number; events: NormEvent[] }>();

async function normEventsForDay(date: string, sportKey: string): Promise<NormEvent[]> {
  const key = `${date}::${sportKey}`;
  const cached = normDayCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.events;

  const tsdbName = TSDB_SPORT_NAME[sportKey];
  // Committade resultat FÖRST i unionen — de är hämtade från en o-blockerad
  // IP och täcker bredast (inkl. nischligor + tennis).
  const [committed, tsdbRaw, espn, sofa] = await Promise.all([
    committedResultsNormForDay(date, sportKey),
    tsdbName ? tsdbEventsForDay(date, tsdbName) : Promise.resolve([]),
    espnNormForDay(date, sportKey),
    sofascoreNormForDay(date, sportKey),
  ]);
  const events = [...committed, ...tsdbNormalize(tsdbRaw), ...espn, ...sofa];
  normDayCache.set(key, { at: Date.now(), events });
  return events;
}

/**
 * Matchar ett bet mot dagens normaliserade events (union av alla källor) och
 * returnerar 1/X/2-utfall + slutställning, med home/away-swap om källan listar
 * matchen i omvänd ordning. Första FÄRDIGA matchande eventet vinner.
 *
 * Verifiering = lagnamn (båda sidor) + SameMatchContext-veto: när BÅDE event
 * och bet har avsparkstid/liga och dessa säger emot varandra (>3h tidsdiff
 * eller helt skilda liga-tokens) förkastas kandidaten även om namnen stämmer.
 * Saknad data blockerar inte (alla källor anger inte liga) — samma princip
 * som valuebets-parningen.
 */
function resultFromNormEvents(
  events: NormEvent[],
  bet: { match: string; sport?: string; startTs?: string; league?: string },
): { result: "1" | "X" | "2"; score: string } | null {
  const is3way = (bet.sport || "soccer") === "soccer";
  for (const e of events) {
    if (!e.finished || e.homeScore == null || e.awayScore == null || !e.home || !e.away) continue;
    const title = `${e.home} - ${e.away}`;
    if (
      !isLikelySameMatch(title, bet.match, {
        candidateStartTs: e.startTs,
        targetStartTs: bet.startTs ?? null,
        candidateLeague: e.league,
        targetLeague: bet.league ?? null,
      })
    ) continue;
    const tSides = getMatchSideTokens(bet.match);
    const pSides = getMatchSideTokens(title);
    let swap = false;
    if (tSides.length >= 2 && pSides.length >= 2) {
      const direct = sideMatches(pSides[0], tSides[0]) && sideMatches(pSides[1], tSides[1]);
      const reversed = sideMatches(pSides[0], tSides[1]) && sideMatches(pSides[1], tSides[0]);
      if (!direct && !reversed) continue;
      swap = reversed;
    }
    const homeScore = swap ? e.awayScore : e.homeScore;
    const awayScore = swap ? e.homeScore : e.awayScore;
    const score = `${homeScore}-${awayScore}`;
    if (homeScore > awayScore) return { result: "1", score };
    if (homeScore < awayScore) return { result: "2", score };
    return is3way ? { result: "X", score } : null;
  }
  return null;
}

/** Sporter med minst en resultatkälla (för "supported"-flaggan i API:t). */
const RESULT_SUPPORTED_SPORTS = new Set(["soccer", "basketball", "tennis"]);

/**
 * GET /api/result-sources-debug?date=YYYY-MM-DD&sport=basketball
 * Diagnostik: visar hur många FÄRDIGA events varje källa returnerar för en dag
 * + 3 exempel. Används för att verifiera (efter deploy) att ESPN/Sofascore
 * faktiskt svarar från Renders datacenter-IP — vissa tjänster 403:ar dem.
 */
async function resultSourcesDebugDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/result-sources-debug") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  try {
    const params = new URLSearchParams(req.url?.split("?")[1] ?? "");
    const date = params.get("date") || isoDateUTC(new Date());
    const sportKey = params.get("sport") || "basketball";
    const tsdbName = TSDB_SPORT_NAME[sportKey];
    const [committed, tsdbRaw, espn, sofa] = await Promise.all([
      committedResultsNormForDay(date, sportKey),
      tsdbName ? tsdbEventsForDay(date, tsdbName) : Promise.resolve([]),
      espnNormForDay(date, sportKey),
      sofascoreNormForDay(date, sportKey),
    ]);
    const tsdb = tsdbNormalize(tsdbRaw);
    const summarize = (evs: NormEvent[]) => ({
      total: evs.length,
      finished: evs.filter((e) => e.finished).length,
      sample: evs.filter((e) => e.finished).slice(0, 3).map((e) => `${e.home} ${e.homeScore}-${e.awayScore} ${e.away}`),
    });
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      date,
      sport: sportKey,
      sources: {
        committedResults: summarize(committed),
        thesportsdb: summarize(tsdb),
        espn: summarize(espn),
        sofascore: summarize(sofa),
      },
      // HTTP-status/fel per källa från senaste hämtningen — skiljer
      // "blockerad" (403) från "tom dag" (200, 0 events).
      diag: Object.fromEntries(resultSourceDiag),
    }, null, 2));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown result-sources-debug error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * POST /api/match-result — batch. Body: { bets: [{id,match,sport,startTs}] }.
 * Returnerar faktiskt resultat-outcome per bet via TheSportsDB (fotboll/basket).
 */
async function matchResultDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/match-result") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: "Use POST" })); return; }
  try {
    const body = await readRequestBody(req);
    const parsed = JSON.parse(body) as { bets?: Array<{ id: string; match: string; sport?: string; startTs?: string; league?: string }> };
    const bets = Array.isArray(parsed?.bets) ? parsed.bets.slice(0, 200) : [];
    // Batcha unika (datum, sportKey) — fetcha varje kombo en gång (±1 dag för tidszon).
    const dayKeys = new Set<string>();
    for (const b of bets) {
      const sportKey = b.sport || "soccer";
      if (!RESULT_SUPPORTED_SPORTS.has(sportKey) || !b.startTs) continue;
      const t = Date.parse(b.startTs);
      if (!Number.isFinite(t)) continue;
      for (const off of [0, -1, 1]) {
        dayKeys.add(`${isoDateUTC(new Date(t + off * 86400000))}::${sportKey}`);
      }
    }
    const dayEvents = new Map<string, NormEvent[]>();
    await Promise.all(
      [...dayKeys].map(async (k) => {
        const [date, sportKey] = k.split("::");
        dayEvents.set(k, await normEventsForDay(date, sportKey));
      }),
    );
    const results = bets.map((b) => {
      const sportKey = b.sport || "soccer";
      const supported = RESULT_SUPPORTED_SPORTS.has(sportKey);
      if (!supported || !b.startTs) return { id: b.id, result: null, score: null, supported };
      const t = Date.parse(b.startTs);
      let match: { result: "1" | "X" | "2"; score: string } | null = null;
      if (Number.isFinite(t)) {
        for (const off of [0, -1, 1]) {
          const evs = dayEvents.get(`${isoDateUTC(new Date(t + off * 86400000))}::${sportKey}`) ?? [];
          match = resultFromNormEvents(evs, b);
          if (match) break;
        }
      }
      return { id: b.id, result: match?.result ?? null, score: match?.score ?? null, supported: true };
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, results }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown match-result error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/**
 * GET/PUT /api/user/bets — per-användare bet-store (auth via session-cookie).
 * Klienten synkar sin localStorage hit; server-jobbet fyller CLV + settlar
 * resultat oberoende av om kunden är inne.
 */
async function userBetsDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/user/bets") {
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  const auth = getAuthFromRequest(req);
  if (!auth) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error: "Not authenticated" })); return; }
  const username = auth.user;
  try {
    if (req.method === "GET") {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, bets: getUserBets(username) }));
      return;
    }
    if (req.method === "PUT") {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body) as { bets?: Array<Record<string, unknown>> };
      const bets = Array.isArray(parsed?.bets) ? parsed.bets : [];
      setUserBets(username, bets as never);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, count: bets.length }));
      return;
    }
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET or PUT" }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown user-bets error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

// ── Bakgrundsjobb: server-side CLV-fångst + auto-settle ────────────────────
// Körs var 5:e min i serverprocessen → fångar stängningsodds vid avspark och
// settlar resultat ÄVEN när kunden inte är inne. Itererar alla användares bets.
let betMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let betMaintenanceRunning = false;

async function runBetMaintenance() {
  if (betMaintenanceRunning) return;
  betMaintenanceRunning = true;
  try {
    const all = allUserBets();
    const now = Date.now();
    const needClv: Array<{ username: string; bet: Record<string, unknown> }> = [];
    const needSettle: Array<{ username: string; bet: Record<string, unknown> }> = [];
    // Closing-line FALLBACK: bets vars live-pollade Pinnacle-linje aldrig hann
    // fångas (nisch-ligor där pre-match-linjen försvinner direkt vid avspark)
    // men som lades NÄRA avspark → fair-odds vid bet-tillfället ≈ closing line.
    const needClosingFallback: Array<{ username: string; bet: Record<string, unknown> }> = [];
    for (const [username, bets] of Object.entries(all)) {
      if (!Array.isArray(bets)) continue;
      for (const b of bets) {
        const startTs = b.startTs as string | undefined;
        if (!startTs || !b.match || !b.outcome) continue;
        const ms = Date.parse(startTs);
        if (!Number.isFinite(ms)) continue;
        const delta = now - ms;
        if (b.status === "open" && b.closingFairOdds == null && delta >= -5 * 60 * 1000 && delta <= 20 * 60 * 1000) {
          needClv.push({ username, bet: b });
        }
        // Fallback: linjen är borta (>25 min efter avspark = live-fångsten har
        // haft sin chans), CLV saknas, men vi har fair-odds från bet-tillfället
        // OCH bettet lades inom 45 min från avspark (då ≈ closing).
        if (
          b.closingFairOdds == null &&
          typeof b.pinnacleFairOddsAtBet === "number" &&
          b.pinnacleFairOddsAtBet > 1 &&
          delta > 25 * 60 * 1000
        ) {
          const logged = Date.parse(b.loggedAt as string);
          if (Number.isFinite(logged) && Math.abs(logged - ms) <= 45 * 60 * 1000) {
            needClosingFallback.push({ username, bet: b });
          }
        }
        const sport = (b.sport as string) || "soccer";
        if (b.status === "open" && delta > 2.5 * 60 * 60 * 1000 && RESULT_SUPPORTED_SPORTS.has(sport)) {
          needSettle.push({ username, bet: b });
        }
      }
    }
    if (needClv.length === 0 && needSettle.length === 0 && needClosingFallback.length === 0) return;

    const patches: Array<{ username: string; id: string; patch: Record<string, unknown> }> = [];

    // Closing-fallback (ingen nätverksåtkomst — använder redan sparad bet-odds).
    for (const { username, bet } of needClosingFallback) {
      patches.push({
        username,
        id: String(bet.id),
        patch: { closingFairOdds: bet.pinnacleFairOddsAtBet, clvAuto: true },
      });
    }

    // CLV-fångst (stängningslinjen vid avspark).
    if (needClv.length > 0) {
      const meta = await buildPinnacleRowsWithMeta();
      for (const { username, bet } of needClv) {
        const r = pinnacleFairOddsForBet(meta.rows, {
          match: String(bet.match),
          outcome: String(bet.outcome),
          startTs: bet.startTs as string,
          sport: bet.sport as string | undefined,
        });
        if (r && r.fairOdds > 1) {
          patches.push({ username, id: String(bet.id), patch: { closingFairOdds: r.fairOdds, clvAuto: true } });
        }
      }
    }

    // Auto-settle via multi-källa-resolvern (TheSportsDB + ESPN + Sofascore).
    if (needSettle.length > 0) {
      const dayKeys = new Set<string>();
      for (const { bet } of needSettle) {
        const sportKey = (bet.sport as string) || "soccer";
        const t = Date.parse(bet.startTs as string);
        if (!RESULT_SUPPORTED_SPORTS.has(sportKey) || !Number.isFinite(t)) continue;
        for (const off of [0, -1, 1]) dayKeys.add(`${isoDateUTC(new Date(t + off * 86400000))}::${sportKey}`);
      }
      const dayEvents = new Map<string, NormEvent[]>();
      await Promise.all(
        [...dayKeys].map(async (k) => {
          const [date, sportKey] = k.split("::");
          dayEvents.set(k, await normEventsForDay(date, sportKey));
        }),
      );
      for (const { username, bet } of needSettle) {
        const sportKey = (bet.sport as string) || "soccer";
        const t = Date.parse(bet.startTs as string);
        if (!RESULT_SUPPORTED_SPORTS.has(sportKey) || !Number.isFinite(t)) continue;
        let match: { result: "1" | "X" | "2"; score: string } | null = null;
        for (const off of [0, -1, 1]) {
          const evs = dayEvents.get(`${isoDateUTC(new Date(t + off * 86400000))}::${sportKey}`) ?? [];
          match = resultFromNormEvents(evs, {
            match: String(bet.match),
            sport: bet.sport as string | undefined,
            startTs: bet.startTs as string | undefined,
            league: bet.league as string | undefined,
          });
          if (match) break;
        }
        if (match) {
          const status = String(bet.outcome) === match.result ? "won" : "lost";
          patches.push({
            username,
            id: String(bet.id),
            patch: { status, result: match.result, finalScore: match.score, settledAt: new Date().toISOString() },
          });
        }
      }
    }

    if (patches.length > 0) {
      const n = applyBetPatches(patches);
      console.log(`[bet-maintenance] uppdaterade ${n} bets (CLV ${needClv.length} / closing-fallback ${needClosingFallback.length} / settle ${needSettle.length} kandidater)`);
    }
  } catch (e) {
    console.warn("[bet-maintenance] fel:", e instanceof Error ? e.message : e);
  } finally {
    betMaintenanceRunning = false;
  }
}

function startBetMaintenance() {
  if (betMaintenanceTimer) return;
  setTimeout(() => void runBetMaintenance(), 8000);
  betMaintenanceTimer = setInterval(() => void runBetMaintenance(), 5 * 60 * 1000);
}

/**
 * Svars-cache för /api/valuebets — INPUT-NYCKLAD (fix 2026-06-12).
 * Tidigare ren 5s tids-TTL: kortare än frontendens 10s-polling, så i princip
 * VARJE poll missade cachen och körde om hela den CPU-tunga matchningen
 * (~3s lokalt, mer på Renders mindre CPU) — även med en enda öppen flik.
 * Nu nycklas cachen på beräkningens INPUTS (Pinnacles updatedAt + bonus-
 * indexets storlek): oförändrade inputs ⇒ identiskt svar ⇒ servera ur RAM
 * (~1ms). Ombyggnad sker bara när Pinnacle-datan faktiskt uppdaterats
 * (~30-60s cadens). Hård max-age 60s gör att freshness-gaten ändå alltid
 * omprövas inom en minut — Pinnacle som blir stale ska snabbt flippa till
 * 0 valuebets (kunder får ALDRIG se falsk +EV).
 */
const VALUEBETS_RESPONSE_MAX_AGE_MS = 60_000;
// Efter detta triggas en bakgrundsombyggnad (men den cachade bodyn serveras
// ändå direkt så länge färskhetsvakten godkänner den).
const VALUEBETS_FRESH_MS = 30_000;
type ValuebetsCacheEntry = {
  inputKey: string;
  builtAt: number;
  pinnacleUpdatedAt: string | null;
  body: string;
};
const valuebetsResponseCache = new Map<number, ValuebetsCacheEntry>();
const valuebetsResponseInflight = new Map<number, Promise<string>>();

function valuebetsDiskFile(hoursWindow: number): string {
  return path.join(BONUS_CACHE_DIR, `valuebets-response-${hoursWindow}.json`);
}

/** Persistera svaret till disk så första besökaren efter en deploy slipper kalla
 *  bygget. pinnacleUpdatedAt sparas så färskhetsvakten kan bedöma RIKTIG ålder. */
function persistValuebetsResponseToDisk(hoursWindow: number, entry: ValuebetsCacheEntry): void {
  try {
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(valuebetsDiskFile(hoursWindow), JSON.stringify(entry), "utf-8");
  } catch {
    /* disk-skrivning är best-effort — RAM-cachen räcker annars */
  }
}

/** Läs in disk-persisterat valuebets-svar vid boot. builtAt sätts till "precis
 *  stale" så första requesten serverar det direkt OCH triggar en bakgrunds-
 *  ombyggnad. pinnacleUpdatedAt bevaras → färskhetsvakten bedömer den verkliga
 *  Pinnacle-åldern, så ett gammalt svar ALDRIG kan visa falsk +EV. */
function loadValuebetsResponseFromDisk(hoursWindow: number): void {
  try {
    const file = valuebetsDiskFile(hoursWindow);
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ValuebetsCacheEntry>;
    if (typeof parsed?.body === "string" && parsed.body.length > 0) {
      valuebetsResponseCache.set(hoursWindow, {
        inputKey: typeof parsed.inputKey === "string" ? parsed.inputKey : "",
        builtAt: Date.now() - VALUEBETS_FRESH_MS,
        pinnacleUpdatedAt: typeof parsed.pinnacleUpdatedAt === "string" ? parsed.pinnacleUpdatedAt : null,
        body: parsed.body,
      });
      console.log(`[valuebets] läste in disk-persisterat svar (${hoursWindow}h) vid boot (serveras direkt om Pinnacle är färsk)`);
    }
  } catch {
    /* ignorera — bygget kör som vanligt */
  }
}

/** Bygg om valuebets-svaret (inflight-dedup), uppdatera RAM-cache + disk. */
function rebuildValuebetsResponse(
  hoursWindow: number,
  inputKey: string,
  probeMatches: IndexedBonusOddsMatch[],
  pinnacleMeta: PinnacleLoadResult,
): Promise<string> {
  let inflight = valuebetsResponseInflight.get(hoursWindow);
  if (inflight) return inflight;
  inflight = buildValuebetsResponseBody(hoursWindow, probeMatches, pinnacleMeta)
    .then((body) => {
      const entry: ValuebetsCacheEntry = {
        inputKey,
        builtAt: Date.now(),
        pinnacleUpdatedAt: pinnacleMeta.updatedAt,
        body,
      };
      valuebetsResponseCache.set(hoursWindow, entry);
      persistValuebetsResponseToDisk(hoursWindow, entry);
      return body;
    })
    .finally(() => {
      valuebetsResponseInflight.delete(hoursWindow);
    });
  valuebetsResponseInflight.set(hoursWindow, inflight);
  return inflight;
}

/**
 * Hämta valuebets-svaret via cache (input-nycklad + inflight-dedup + SWR + disk).
 * SWR + disk (fix 2026-06-16): det senaste svaret serveras DIREKT (inkl. ett
 * disk-persisterat svar efter en deploy) medan en färsk byggs i bakgrunden —
 * ingen request väntar, varken i steady-state eller på första laddningen efter
 * en omstart.
 * Säkert mot falsk +EV: den cachade bodyn serveras BARA om dess Pinnacle-snapshot
 * fortfarande är inom färskhetsgaten (3 min). Är den äldre byggs svaret om
 * (gaten ger då 0 valuebets — snabb early-return), så stale +EV kan aldrig visas.
 */
async function getValuebetsResponseBodyCached(hoursWindow: number, cacheOnly = false): Promise<string> {
  // STABILITETS-GATE (boot-OOM-diagnos): medan tung uppvärmning är av bygger vi
  // ALDRIG om valuebets — rebuildValuebetsResponse sprängde V8-heapen (>1,5 GB
  // ensam) och dödade processen (134) vid varje request/warm. Servera RAM-/disk-
  // cachen som den är → ingen OOM, sajten stabil. Sätt RESPONSE_WARM_HEAVY=1 när
  // minnesboven är fixad för att återaktivera live-ombyggnad.
  if (process.env.RESPONSE_WARM_HEAVY !== "1") {
    const c = valuebetsResponseCache.get(hoursWindow);
    if (c) return c.body;
    return JSON.stringify({ updatedAt: new Date().toISOString(), valueBets: [], note: "valuebets rebuild tillfälligt pausad (boot-OOM-diagnos)" });
  }
  // Billiga versions-probes — båda har egna korta RAM-cacher (5s / 10 min).
  const [pinnacleMeta, probeMatches] = await Promise.all([
    buildPinnacleRowsWithMeta(),
    getBonusOddsIndexMatches(hoursWindow),
  ]);
  const inputKey = `${pinnacleMeta.updatedAt ?? "none"}::${probeMatches.length}`;
  const now = Date.now();
  const cached = valuebetsResponseCache.get(hoursWindow);

  if (cached) {
    const stale = now - cached.builtAt >= VALUEBETS_FRESH_MS || cached.inputKey !== inputKey;
    if (stale) {
      void rebuildValuebetsResponse(hoursWindow, inputKey, probeMatches, pinnacleMeta).catch(() => {});
    }
    // SÄKERHET: servera bara direkt om bodyns Pinnacle-snapshot fortfarande är
    // inom färskhetsgaten. Då är de visade valuebetsen samma som ett färskt
    // bygge skulle ge (samma Pinnacle-data) → aldrig falsk/stale +EV.
    const ageMs = pinnacleAgeMs(cached.pinnacleUpdatedAt);
    if (ageMs !== null && ageMs <= PINNACLE_FRESHNESS_THRESHOLD_MS) {
      return cached.body;
    }
    // Pinnacle-snapshot för gammal. cacheOnly (persist/server-till-server): ALDRIG
    // synkron rebuild — den är >90s + OOM-benägen → klienten (persist) timeout:ar.
    // Pinnacle stale → korrekt 0 valuebets (samma som färskhetsgaten ger, ingen
    // falsk +EV), och vi bygger om i BAKGRUNDEN så nästa varv blir varmt.
    if (cacheOnly) {
      void rebuildValuebetsResponse(hoursWindow, inputKey, probeMatches, pinnacleMeta).catch(() => {});
      return JSON.stringify({ updatedAt: new Date().toISOString(), valueBets: [], note: "cacheOnly: pinnacle-snapshot stale (>3min) → 0 valuebets, rebuild i bakgrunden" });
    }
    // Pinnacle-snapshot för gammal → bygg om och vänta in (gaten → 0 valuebets).
    return rebuildValuebetsResponse(hoursWindow, inputKey, probeMatches, pinnacleMeta);
  }
  // Ingen cache. cacheOnly → trigga bakgrunds-rebuild + returnera tomt DIREKT
  // (ingen blockerande kallstarts-rebuild för persist).
  if (cacheOnly) {
    void rebuildValuebetsResponse(hoursWindow, inputKey, probeMatches, pinnacleMeta).catch(() => {});
    return JSON.stringify({ updatedAt: new Date().toISOString(), valueBets: [], note: "cacheOnly: cache kall → rebuild i bakgrunden" });
  }
  return rebuildValuebetsResponse(hoursWindow, inputKey, probeMatches, pinnacleMeta);
}

/**
 * Response-cache-värmare: efter en deploy startar serverprocessen om och ALLA
 * RAM-cacher är tomma — första besökaren betalade tidigare hela kallstarts-
 * bygget (valuebets-matchning + 10 källors payload-laddning) själv, samtidigt
 * som bonus-index-prewarmen åt CPU. Nu byggs båda svaren i bakgrunden direkt
 * efter boot (före första besökaren) och hålls sedan permanent varma.
 * Input-nycklingen gör intervallet billigt: oförändrade inputs ⇒ bara två
 * snabba probes, ingen ombyggnad.
 */
// ── Bonus Finder: förbyggd + bakgrundsvärmd match-data (SWR) ───────────────
// Bonus Finder byggde förut hela odds-indexet + Pinnacle/Smarkets-join på VARJE
// request → segt att öppna. Nu byggs det i bakgrunden och hålls varmt; en
// request serveras alltid från senaste bygge direkt (stale-while-revalidate),
// och en färsk byggs i bakgrunden. Samma mönster som /api/sources/status.
let bonusFinderBuildFn: ((hoursWindow: number) => Promise<BonusFinderMatchData[]>) | null = null;
const BFM_FRESH_MS = 30_000;
const BFM_HARD_MAX_MS = 10 * 60_000;
const BFM_MAX_WAIT_MS = 2_500;
const bonusFinderMatchesCache = new Map<number, { builtAt: number; matches: BonusFinderMatchData[] }>();
const bonusFinderMatchesInflight = new Map<number, Promise<BonusFinderMatchData[]>>();

function bonusFinderDiskFile(h: number): string {
  return path.join(BONUS_CACHE_DIR, `bonus-finder-matches-${h}.json`);
}
function persistBonusFinderMatchesToDisk(h: number, matches: BonusFinderMatchData[]): void {
  try {
    fs.mkdirSync(BONUS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(bonusFinderDiskFile(h), JSON.stringify({ builtAt: Date.now(), matches }), "utf-8");
  } catch {
    /* best-effort */
  }
}
/** Läs in disk-persisterade Bonus Finder-matcher vid boot → första laddningen
 *  efter en deploy serveras direkt (builtAt "precis stale" → trigga bg-ombyggnad). */
function loadBonusFinderMatchesFromDisk(h: number): void {
  try {
    const file = bonusFinderDiskFile(h);
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { matches?: BonusFinderMatchData[] };
    if (Array.isArray(parsed?.matches) && parsed.matches.length > 0) {
      bonusFinderMatchesCache.set(h, { builtAt: Date.now() - BFM_FRESH_MS, matches: parsed.matches });
      console.log(`[bonus-finder] läste in disk-persisterade matcher (${h}h) vid boot (serveras direkt)`);
    }
  } catch {
    /* ignorera */
  }
}

function rebuildBonusFinderMatches(h: number): Promise<BonusFinderMatchData[]> {
  const ex = bonusFinderMatchesInflight.get(h);
  if (ex) return ex;
  const p = (bonusFinderBuildFn ? bonusFinderBuildFn(h) : Promise.resolve([] as BonusFinderMatchData[]))
    .then((m) => {
      bonusFinderMatchesCache.set(h, { builtAt: Date.now(), matches: m });
      if (m.length > 0) persistBonusFinderMatchesToDisk(h, m);
      return m;
    })
    .finally(() => bonusFinderMatchesInflight.delete(h));
  bonusFinderMatchesInflight.set(h, p);
  return p;
}
async function getBonusFinderMatchesCached(h: number): Promise<BonusFinderMatchData[]> {
  const c = bonusFinderMatchesCache.get(h);
  if (c) {
    const age = Date.now() - c.builtAt;
    if (age >= BFM_FRESH_MS) void rebuildBonusFinderMatches(h).catch(() => {});
    if (age < BFM_HARD_MAX_MS) return c.matches;
    return Promise.race([
      rebuildBonusFinderMatches(h),
      new Promise<BonusFinderMatchData[]>((res) => setTimeout(() => res(c.matches), BFM_MAX_WAIT_MS)),
    ]);
  }
  return rebuildBonusFinderMatches(h);
}

let responseCacheWarmersStarted = false;
function startResponseCacheWarmers() {
  if (responseCacheWarmersStarted) return;
  responseCacheWarmersStarted = true;
  // Läs in disk-persisterade svar SYNKRONT vid boot → första requesten efter en
  // omstart serveras direkt i stället för att vänta in ett kallt bygge.
  loadSourcesStatusFromDisk();
  loadValuebetsResponseFromDisk(24);
  loadBonusFinderMatchesFromDisk(48);
  loadBonusOptimizerParamsFromDisk();
  loadBonusOptimizerResultFromDisk();
  // SEKVENTIELLT (inte parallellt) — bara EN tung beräkning i minnet åt gången.
  // Parallellt sprängde V8-heapen vid boot: valuebets(24h) + sources/status +
  // bonusFinder(48h) + optimizer kördes SAMTIDIGT → summan av alla fyra som
  // minnespik → "FATAL ERROR: Reached heap limit". Sekventiellt = toppen blir
  // den största enskilda beräkningen, inte summan. Inflight-spärr så varven
  // aldrig överlappar (annars dubbel-pik om ett varv tar >20s).
  let warmInflight = false;
  const warmAll = async () => {
    if (warmInflight) return;
    warmInflight = true;
    try {
      // Lätt — alltid på (källfärskhet).
      await getSourcesStatusBodyCached().catch(() => {});
      // TUNGA uppvärmningar (valuebets 24h + bonusFinder 48h + optimizer) är
      // AVSTÄNGDA som standard medan vi diagnostiserar en boot-heap-OOM. En av
      // dem behöver >1,5 GB ensam → sprängde heapen var 20:e sekund (up/down-loop).
      // Servern serverar disk-cachen istället → STABIL. Sätt RESPONSE_WARM_HEAVY=1
      // i Render-env för att återaktivera när minnesboven är fixad.
      if (process.env.RESPONSE_WARM_HEAVY === "1") {
        // BARA valuebets(24h) — det tracking behöver. ~1,5 GB ensam, gott om
        // marginal under 3072 MB-taket.
        await getValuebetsResponseBodyCached(24).catch(() => {});
        // bonusFinder(48h) + optimizer är de TYNGSTA bygg­ena. Alla tre i samma
        // cold-boot-cykel sprängde V8-heapen (status 134, "Reached heap limit").
        // De behövs inte för tracking och byggs ändå LAZY på sina egna endpoints
        // (getBonusFinderMatchesCached anropas av bonus-finder-routen). Förvärm dem
        // bara om RESPONSE_WARM_BONUS=1 (av som standard → låg minnespik).
        if (process.env.RESPONSE_WARM_BONUS === "1") {
          await getBonusFinderMatchesCached(48).catch(() => {});
          await warmBonusOptimizer().catch(() => {});
        }
      }
    } finally {
      warmInflight = false;
    }
  };
  // DEPLOY-FLAP-SKYDD: kör BARA den lätta källfärskhets-warmen direkt vid boot
  // (billig) så porten + health-check svarar snabbt. Den TUNGA valuebets-rebuilden
  // blockerar event-loopen några sekunder; körs den omedelbart vid boot timear
  // Render's health-check under bygget → instansen pendlar "instance failed"/
  // "recovered" varje deploy. Vi fördröjer därför HELA warm-cykeln (tung inkluderad)
  // ~45 s så Render hinner markera den nya instansen som "live" FÖRST. Disk-cachen
  // (laddad ovan) serverar valuebets under fördröjningen.
  void getSourcesStatusBodyCached().catch(() => {});
  const startWarmCycle = setTimeout(() => {
    void warmAll();
    const timer = setInterval(() => void warmAll(), 20_000);
    (timer as unknown as { unref?: () => void }).unref?.();
  }, 45_000);
  (startWarmCycle as unknown as { unref?: () => void }).unref?.();
  console.log("[response-warm] värmare igång: lätt warm direkt, tung warm-cykel efter 45s + var 20:e s (deploy-flap-skydd)");
}

/**
 * GET /api/smarkets-extraction?hours=72
 * Join: matcher som finns BÅDE i bonus-odds-indexet (bookmaker back-odds per
 * spelbolag) OCH i Smarkets (back + lay-odds). Frontend räknar sedan ut lay-
 * matchad uttagsplan per konto med den testade layMatching-matematiken.
 */
async function smarketsExtractionDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/smarkets-extraction") { next(); return; }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  try {
    const params = new URLSearchParams(req.url?.split("?")[1] ?? "");
    const hoursRaw = Number(params.get("hours"));
    const hoursWindow = ([24, 48, 72] as const).includes(hoursRaw as 24 | 48 | 72) ? hoursRaw : 72;

    const [bonusMatches, smk] = await Promise.all([
      getBonusOddsIndexMatches(hoursWindow),
      loadSmarketsPayloadWithMeta(),
    ]);
    const smkRows = smarketsAllRows(smk.payload);
    const commission = smk.payload?.commission ?? 0.02;

    type OutTriple = { "1"?: number | null; X?: number | null; "2"?: number | null };
    const out: Array<{
      title: string;
      sport?: string;
      startTs?: string;
      league?: string;
      books: Record<string, OutTriple>;       // bookmakerId → back-odds {1,X,2}
      smarketsBack: OutTriple;                  // Smarkets back-odds
      smarketsLay: OutTriple;                   // Smarkets lay-odds
    }> = [];

    for (const m of bonusMatches) {
      if (!m.title || !m.odds) continue;
      const smkRow = smkRows.find((r) => isLikelySameMatch(`${r.homeTeam} - ${r.awayTeam}`, m.title));
      if (!smkRow) continue;
      // Sido-alignment (Smarkets home/away kan vara omvänt mot bonus-matchen).
      const tSides = getMatchSideTokens(m.title);
      const sSides = getMatchSideTokens(`${smkRow.homeTeam} - ${smkRow.awayTeam}`);
      let swap = false;
      if (tSides.length >= 2 && sSides.length >= 2) {
        const reversed = sideMatches(sSides[0], tSides[1]) && sideMatches(sSides[1], tSides[0]);
        swap = reversed;
      }
      const pick = (o?: { home?: number | null; draw?: number | null; away?: number | null }): OutTriple => {
        if (!o) return {};
        return {
          "1": swap ? o.away ?? null : o.home ?? null,
          X: o.draw ?? null,
          "2": swap ? o.home ?? null : o.away ?? null,
        };
      };
      const books: Record<string, OutTriple> = {};
      for (const [bid, triple] of Object.entries(m.odds)) {
        if (triple) books[bid] = { "1": triple["1"], X: triple.X, "2": triple["2"] };
      }
      out.push({
        title: m.title,
        sport: smkRow.sport,
        startTs: m.startTs,
        league: m.league,
        books,
        smarketsBack: pick(smkRow.odds),
        smarketsLay: pick(smkRow.layOdds),
      });
    }

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      hours: hoursWindow,
      commission,
      smarketsUpdatedAt: smk.payload?.updatedAt ?? null,
      smarketsSource: smk.source,
      matchCount: out.length,
      matches: out,
    }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown smarkets-extraction error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/** GET /api/valuebets/sharp-lines → Pinnacle AH + totals no-vig referens (#9, read-only). */
async function pinnacleSharpLinesDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/valuebets/sharp-lines") { next(); return; }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  try {
    const hoursRaw = Number(new URLSearchParams(req.url?.split("?")[1] ?? "").get("hours"));
    const hoursWindow = ([24, 48, 72] as const).includes(hoursRaw as 24 | 48 | 72) ? hoursRaw : 72;
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, hours: hoursWindow, ...getPinnacleSharpLines(hoursWindow) }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "sharp-lines error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

async function valuebetsDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/valuebets") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }

  try {
    const queryString = req.url?.split("?")[1] ?? "";
    const params = new URLSearchParams(queryString);
    const ALLOWED_HOURS = [24, 48, 72] as const;
    const hoursRaw = Number(params.get("hours"));
    const hoursWindow = ALLOWED_HOURS.includes(hoursRaw as 24 | 48 | 72) ? hoursRaw : 24;
    // cacheOnly=1: server-till-server (persist-signals) — servera senaste cache utan
    // synkron tung rebuild (som är >90s + OOM-benägen → persist timeout:ar). Se getValuebetsResponseBodyCached.
    const cacheOnly = params.get("cacheOnly") === "1";

    const body = await getValuebetsResponseBodyCached(hoursWindow, cacheOnly);
    res.statusCode = 200;
    res.end(body);
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown valuebets error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

/** Bygger hela /api/valuebets-JSON-svaret (dyr beräkning — cachas ovan). */
async function buildValuebetsResponseBody(
  hoursWindow: number,
  probeMatches?: IndexedBonusOddsMatch[],
  preloadedPinnacleMeta?: PinnacleLoadResult,
): Promise<string> {
    ensureAnalyticsConfigRefresh(); // fas 0: starta config-refresh-loopen (idempotent, lättviktig)
    // För värdebets duger 6h-gammal disk-cache (max-age) — ingen anledning att rebuilda
    // pga 10-min TTL, det skulle ta minuter och stör inte EV-beräkningens precision.
    // probeMatches/preloadedPinnacleMeta kommer från cache-lagrets versions-probe
    // (getValuebetsResponseBodyCached) så samma data inte laddas två gånger.
    const cachedMatches = probeMatches ?? (await getBonusOddsIndexMatches(hoursWindow));
    const matches = cachedMatches.length > 0 ? cachedMatches : readBonusOddsIndexFromDisk(hoursWindow)?.matches ?? [];
    const pinnacleMeta = preloadedPinnacleMeta ?? (await buildPinnacleRowsWithMeta());
    const pinnacleRows = pinnacleMeta.rows;
    const pinnacleAgeMsValue = pinnacleAgeMs(pinnacleMeta.updatedAt);
    const pinnacleAgeSeconds =
      pinnacleAgeMsValue !== null ? Math.floor(pinnacleAgeMsValue / 1000) : null;
    const isPinnacleFresh =
      pinnacleAgeMsValue !== null && pinnacleAgeMsValue <= PINNACLE_FRESHNESS_THRESHOLD_MS;
    // Status-narrativ för frontend.
    let pinnacleStatus: "fresh" | "stale" | "missing" | "fetch_failed" | "cache_used" = "fresh";
    if (pinnacleRows.length === 0) {
      pinnacleStatus = pinnacleMeta.source === "empty" ? "missing" : "fetch_failed";
    } else if (!isPinnacleFresh) {
      pinnacleStatus = "stale";
    } else if (pinnacleMeta.source === "cache") {
      pinnacleStatus = "cache_used";
    }

    console.log(
      `[valuebets] Pinnacle status=${pinnacleStatus} source=${pinnacleMeta.source} updatedAt=${pinnacleMeta.updatedAt ?? "null"} ageSeconds=${pinnacleAgeSeconds} fresh=${isPinnacleFresh}`,
    );

    // Bara fotboll 1X2: svenska sidor i pipelinen levererar enbart 3-way moneyline.
    const pinnacleSoccer = pinnacleRows.filter(
      (row) =>
        row.sport === "soccer" &&
        row.marketType === "moneyline" &&
        Number.isFinite(row.drawOdds) &&
        (row.drawOdds ?? 0) > 1,
    );

    // HARD FRESHNESS GATE: hellre 0 valuebets än bets baserade på stale Pinnacle-data.
    // Returnerar tidigt utan att räkna EV om Pinnacle inte är färsk eller saknas.
    if (!isPinnacleFresh || pinnacleRows.length === 0) {
      const ageNote =
        pinnacleAgeSeconds !== null ? `${pinnacleAgeSeconds}s gammal` : "okänt åldersstämpel";
      console.warn(
        `[valuebets] gate triggered: status=${pinnacleStatus} (${ageNote}, threshold=${Math.round(PINNACLE_FRESHNESS_THRESHOLD_MS / 1000)}s) — returnerar 0 valuebets`,
      );
      return JSON.stringify({
          ok: true,
          generatedAt: Date.now(),
          hours: hoursWindow,
          threshold: VALUE_BET_EV_THRESHOLD,
          reviewThreshold: VALUE_BET_REVIEW_THRESHOLD,
          rejectThreshold: VALUE_BET_REJECT_THRESHOLD,
          timeToleranceMs: VALUE_BET_TIME_TOLERANCE_MS,
          pinnacleFreshnessThresholdMs: PINNACLE_FRESHNESS_THRESHOLD_MS,
          matchesScanned: matches.length,
          pinnacleSoccerMoneylineCount: pinnacleSoccer.length,
          pinnacleUpdatedAt: pinnacleMeta.updatedAt,
          pinnacleAgeSeconds,
          isPinnacleFresh,
          pinnacleStatus,
          pinnacleSource: pinnacleMeta.source,
          bonusIndexStatus: getPrewarmStatusSnapshot(),
          valueBets: [],
          gateReason:
            !isPinnacleFresh && pinnacleRows.length > 0
              ? `Pinnacle är ${pinnacleAgeSeconds}s gammal (gräns ${Math.round(PINNACLE_FRESHNESS_THRESHOLD_MS / 1000)}s) — visar inga valuebets för att undvika falska positiva.`
              : `Pinnacle-data saknas eller fetch misslyckades (källa: ${pinnacleMeta.source}) — visar inga valuebets.`,
          diagnostics: {
            pairsConsidered: 0,
            pairsRejectedTeams: 0,
            pairsRejectedTime: 0,
            pairsRejectedLeague: 0,
            pairsRejectedSides: 0,
            evRejectedExtreme: 0,
            pinnacleProbe: null,
            pinnacleDisk: pinnacleRows.length === 0 ? pinnacleDiskProbe() : null,
          },
        });
    }

    const valueBets: ValueBetEntry[] = [];
    const outcomeLabels: Record<Outcome, string> = { "1": "Hemma", X: "Oavgjort", "2": "Borta" };

    // SHARP-INBLANDNING: ladda SBOBET + Betfair och bygg ett färskhets-gateat index
    // (stale källa exkluderas → blandas aldrig in). Pinnacle förblir gate + dominant;
    // sharparna NUDGAR bara fair price. Felsäkert: laddningsfel → ingen inblandning.
    let sharpIdx: SharpIndex | null = null;
    if (SHARP_BLEND_ENABLED) {
      try {
        const [sbo, bf] = await Promise.all([loadSbobetPayloadWithMeta(), loadBetfairPayloadWithMeta()]);
        // Empiriska CLV-multiplikatorer (clv-calibrate → data/clv-multipliers.json):
        // skalar källornas trust-vikt efter uppmätt träffsäkerhet. Saknas ⇒ {} (1.0).
        let clvMultipliers: Record<string, number> = {};
        try {
          const cmPath = path.resolve(process.cwd(), "data", "clv-multipliers.json");
          if (fs.existsSync(cmPath)) clvMultipliers = JSON.parse(fs.readFileSync(cmPath, "utf-8"))?.multipliers ?? {};
        } catch { /* ingen kalibrering än → prior-vikter */ }
        sharpIdx = buildSharpIndex({
          sbobetJson: sbo.payload,
          sbobetUpdatedAt: sbo.payload?.updatedAt ?? null,
          betfairJson: bf.payload,
          betfairUpdatedAt: bf.payload?.updatedAt ?? null,
          freshnessMs: SHARP_FRESHNESS_THRESHOLD_MS,
          clvMultipliers,
        });
        console.log(
          `[valuebets] sharp-blend: sbobet fresh=${sharpIdx.sbobetFresh}(${sharpIdx.ageSec.sbobet}s,${sharpIdx.sbobet?.size ?? 0}ev) betfair fresh=${sharpIdx.betfairFresh}(${sharpIdx.ageSec.betfair}s,${sharpIdx.betfair?.size ?? 0}ev)`,
        );
      } catch (err) {
        console.warn("[valuebets] sharp-blend avstängd (laddningsfel):", (err as Error)?.message);
        sharpIdx = null;
      }
    }
    let pairsConsidered = 0;
    let pairsRejectedTeams = 0;
    let pairsRejectedTime = 0;
    let pairsRejectedLeague = 0;
    let pairsRejectedSides = 0;
    let evRejectedExtreme = 0;

    // CPU-YIELD (fix 2026-06-13): matchningen nedan är O(matcher × Pinnacle-rader)
    // med token-jämförelser — flera sekunder ren CPU. På Nodes enda tråd FRÖS det
    // hela servern under varje ombyggnad (källor/auth/statiska filer fick vänta).
    // setImmediate var ~30:e match släpper event-loopen så andra requests servas
    // mellan chunkarna. Samma totala arbete, men ingen frysning.
    const matchStart = Date.now();
    // KANDIDAT-INDEX (fix 2026-06-16): tidigare full-scan av alla Pinnacle-rader
    // per bonus-match = O(matcher × Pinnacle-rader) med regex-tokenisering av samma
    // titlar om och om igen. Nu tokeniseras varje Pinnacle-rad EN gång och läggs i
    // ett lag-token-index; varje bonus-match slår bara upp relevanta rader. Vi kör
    // sedan EXAKT samma isLikelySameMatch på den smala kandidatlistan i samma
    // ordning som förut → identiskt resultat, men ~O(matcher × få) i stället.
    const PSG_KEY = "__psg__";
    const isPsgTokens = (toks: string[]): boolean => {
      const s = new Set(toks);
      return s.has("psg") || (s.has("paris") && s.has("saint") && s.has("germain"));
    };
    const pinIndex = new Map<string, number[]>();
    const pinAmbiguous: number[] = []; // rader utan 2 tydliga sidor → alltid kandidater
    pinnacleSoccer.forEach((row, i) => {
      const sides = getMatchSideTokens(row.match);
      if (sides.length < 2) {
        pinAmbiguous.push(i);
        return;
      }
      const flat = sides.flat();
      const seen = new Set<string>();
      const add = (key: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        let arr = pinIndex.get(key);
        if (!arr) {
          arr = [];
          pinIndex.set(key, arr);
        }
        arr.push(i);
      };
      for (const tok of flat) {
        add("e:" + tok); // exakt token
        if (tok.length >= 5) add("p:" + tok.slice(0, 5)); // prefix-regeln i sideMatches
      }
      if (isPsgTokens(flat)) add(PSG_KEY);
    });

    let vbYieldCounter = 0;
    for (const match of matches) {
      if (++vbYieldCounter % 30 === 0) await new Promise((r) => setImmediate(r));
      // Kandidater: slå upp relevanta Pinnacle-rader via token-indexet, behåll
      // ursprunglig ordning, kör sedan exakt samma isLikelySameMatch som förut.
      const matchSides = getMatchSideTokens(match.title);
      let prelim: PinnacleRow[];
      if (matchSides.length < 2) {
        prelim = pinnacleSoccer; // sällsynt: titel utan 2 sidor → exakt fallback
      } else {
        const flat = matchSides.flat();
        const hitSet = new Set<number>(pinAmbiguous);
        for (const t of flat) {
          const ex = pinIndex.get("e:" + t);
          if (ex) for (const i of ex) hitSet.add(i);
          if (t.length >= 5) {
            const pr = pinIndex.get("p:" + t.slice(0, 5));
            if (pr) for (const i of pr) hitSet.add(i);
          }
        }
        if (isPsgTokens(flat)) {
          const pg = pinIndex.get(PSG_KEY);
          if (pg) for (const i of pg) hitSet.add(i);
        }
        prelim = [...hitSet].sort((a, b) => a - b).map((i) => pinnacleSoccer[i]);
      }
      const candidates = prelim.filter((row) => isLikelySameMatch(row.match, match.title));
      if (candidates.length === 0) {
        pairsRejectedTeams += 1;
        continue;
      }
      pairsConsidered += 1;

      // Strikt verifiering enligt spec: tid (±5 min) OCH liga måste matcha. Om bonus-match
      // saknar startTs eller league finns ingen sanningsdata att verifiera mot → exkludera.
      let pinnacle: PinnacleRow | undefined;
      let timeOkSeen = false;
      let leagueOkSeen = false;
      let bestStartDelta: number | null = null;
      for (const row of candidates) {
        if (!Number.isFinite(row.startTime) || !match.startTs) continue;
        const matchMs = Date.parse(match.startTs);
        if (!Number.isFinite(matchMs)) continue;
        const delta = Math.abs((row.startTime as number) - matchMs);
        const timeOk = delta <= VALUE_BET_TIME_TOLERANCE_MS;
        if (timeOk) timeOkSeen = true;
        if (bestStartDelta === null || delta < bestStartDelta) bestStartDelta = delta;
        if (!timeOk) continue;

        // Liga måste ha minst ett gemensamt token mellan Pinnacle-tournament och bonus-league.
        const aT = leagueTokensSet(row.tournament);
        const bT = leagueTokensSet(match.league ?? "");
        if (aT.size === 0 || bT.size === 0) continue;
        let overlap = false;
        for (const t of aT) if (bT.has(t)) { overlap = true; break; }
        if (!overlap) continue;
        leagueOkSeen = true;
        pinnacle = row;
        break;
      }
      if (!pinnacle || !pinnacle.drawOdds) {
        if (!timeOkSeen) pairsRejectedTime += 1;
        else if (!leagueOkSeen) pairsRejectedLeague += 1;
        continue;
      }

      // Pinnacle och svenska sidor kan lista samma fixture i omvänd home/away-ordning
      // (vanligt i ligor där hemmaplan-konventionen skiljer sig). Rikta in Pinnacle-oddsen
      // mot bonus-matchens lagordning innan EV per utfall beräknas; annars jämförs
      // Pinnacles "Borta" mot bookmakers "Hemma" → falska 100%+ EV-värden.
      const targetSides = getMatchSideTokens(match.title);
      const pinSides = getMatchSideTokens(pinnacle.match);
      let swapHomeAway = false;
      let sidesAligned = false;
      if (targetSides.length >= 2 && pinSides.length >= 2) {
        const direct =
          sideMatches(pinSides[0], targetSides[0]) && sideMatches(pinSides[1], targetSides[1]);
        const reversed =
          sideMatches(pinSides[0], targetSides[1]) && sideMatches(pinSides[1], targetSides[0]);
        if (direct) sidesAligned = true;
        else if (reversed) {
          sidesAligned = true;
          swapHomeAway = true;
        }
      }
      if (!sidesAligned) {
        pairsRejectedSides += 1;
        continue;
      }

      const verification: ValueBetVerification = {
        teamsOk: true,
        leagueOk: true,
        timeOk: true,
        marketOk: true,
        startDeltaMs: bestStartDelta,
      };

      const pinnacleOdds: Record<Outcome, number> = {
        "1": swapHomeAway ? pinnacle.awayOdds : pinnacle.homeOdds,
        X: pinnacle.drawOdds,
        "2": swapHomeAway ? pinnacle.homeOdds : pinnacle.awayOdds,
      };
      const noVig = computeNoVig(pinnacleOdds);
      if (!noVig) continue;

      const impliedProbs = Object.fromEntries(
        noVig.outcomes.map((o) => [o.outcome, o.impliedProb]),
      ) as Record<Outcome, number>;
      const fairProbs = Object.fromEntries(
        noVig.outcomes.map((o) => [o.outcome, o.fairProb]),
      ) as Record<Outcome, number>;
      const fairOdds = Object.fromEntries(
        noVig.outcomes.map((o) => [o.outcome, o.fairOdds]),
      ) as Record<Outcome, number>;

      // SHARP-NUDGE: blanda in färska SBOBET/Betfair i Pinnacles native fair-probs
      // (Pinnacle dominerar, vikt 2.5 vs 0.7/0.8). Allt sker i Pinnacle-native HOME/
      // DRAW/AWAY-rum → mappa tillbaka till 1/X/2 via swapHomeAway. Ingen färsk/matchad
      // sharp ⇒ effFairProbs == Pinnacle. Felsäkert (blend kastar aldrig, men wrappa).
      let effFairProbs = fairProbs;
      // undefined = sharp-blend kördes INTE (sharpIdx null / kraschade) → OKÄNT, inte "tom".
      // [] = blend kördes men ingen färsk sharp matchade (känd Pinnacle-only). Skillnaden
      // styr trust-flaggor (computeTrustFlags): bara känd tom ger pinnacle_only. (Cursor #11.)
      let sharpSources: string[] | undefined = undefined;
      let betfairLiquidity: BetfairLiquidityInfo | null = null;
      // §2: rå Betfair-orderbok (back/lay/mid) per utfall (Pinnacle-native) — observerbarhet.
      let betfairBook: Partial<Record<"HOME" | "DRAW" | "AWAY", { back: number; lay: number; mid: number | null }>> | null = null;
      // Market Trust Layer: per-källa no-vig fairProb-triples (Pinnacle-native) för
      // individuell sharp-prissättning i tracking. null = blend kördes ej.
      let sharpPerSource:
        | { pinnacle: { HOME: number; DRAW: number; AWAY: number }; sbobet?: { HOME: number; DRAW: number; AWAY: number }; betfair?: { HOME: number; DRAW: number; AWAY: number } }
        | null = null;
      if (sharpIdx) {
        try {
          const nativeFair = {
            HOME: swapHomeAway ? fairProbs["2"] : fairProbs["1"],
            DRAW: fairProbs["X"],
            AWAY: swapHomeAway ? fairProbs["1"] : fairProbs["2"],
          };
          const res = blendNativeFair(
            nativeFair,
            pinnacle.homeName ?? "",
            pinnacle.awayName ?? "",
            pinnacle.startTime ?? NaN,
            sharpIdx,
            undefined, // default-vikter
            typeof pinnacle.limit === "number" && pinnacle.limit > 0 ? pinnacle.limit : null, // Pinnacle-likviditet
          );
          sharpSources = res.sources; // blend kördes → KÄND lista (ev. tom = Pinnacle-only)
          sharpPerSource = res.perSource ?? null; // individuella sharp-priser (tracking)
          if (res.sources.length > 0) {
            effFairProbs = {
              "1": swapHomeAway ? res.blended.AWAY : res.blended.HOME,
              X: res.blended.DRAW,
              "2": swapHomeAway ? res.blended.HOME : res.blended.AWAY,
            } as Record<Outcome, number>;
            betfairLiquidity = res.betfairLiquidity ?? null;
            betfairBook = res.betfairBook ?? null;
          }
        } catch {
          effFairProbs = fairProbs;
          sharpSources = undefined; // blend kraschade → OKÄNT (inte "tom")
          betfairLiquidity = null;
          betfairBook = null;
        }
      }

      // §3: per-källa feed-färskhet (global feed-ålder vid detektion) — följer varje signal.
      const sourceFreshness = sharpIdx
        ? { sbobet: { age_sec: sharpIdx.ageSec.sbobet, fresh: sharpIdx.sbobetFresh }, betfair: { age_sec: sharpIdx.ageSec.betfair, fresh: sharpIdx.betfairFresh } }
        : null;
      const pinnacleBlock = {
        sport: pinnacle.sport,
        tournament: pinnacle.tournament,
        eventId: pinnacle.matchupId != null ? String(pinnacle.matchupId) : undefined,
        startTs:
          pinnacle.startTime && Number.isFinite(pinnacle.startTime)
            ? new Date(pinnacle.startTime).toISOString()
            : undefined,
        odds: pinnacleOdds,
        impliedProbs,
        overround: noVig.overround,
        vig: noVig.vig,
        fairProbs,
        fairOdds,
        // Live Pinnacle-likviditet (max-insats) — följer med varje valuebet.
        limit: typeof pinnacle.limit === "number" && pinnacle.limit > 0 ? pinnacle.limit : null,
      };

      const oddsByBookmaker = match.odds ?? {};
      for (const [bookmakerIdRaw, triple] of Object.entries(oddsByBookmaker)) {
        if (!triple) continue;
        const bookmakerId = bookmakerIdRaw as BonusBookmakerId;
        const bookmakerName = BONUS_BOOKMAKER_NAMES[bookmakerId] ?? bookmakerId;
        for (const outcome of BONUS_OUTCOMES) {
          const bookOdds = triple[outcome];
          if (!Number.isFinite(bookOdds) || !(bookOdds > 1)) continue;
          // EV mot SKARP konsensus-fair (Pinnacle dominerar + ev. färska SBOBET/Betfair).
          const fairProb = effFairProbs[outcome];
          if (!(fairProb > 0)) continue;
          const ev = fairProb * bookOdds - 1;
          if (ev <= VALUE_BET_EV_THRESHOLD) continue;
          // Avvisa orealistiska EV-värden: vid Pinnacle som referens är >25% nästan
          // alltid datafel (stale odds, fel match, sidobyte vi missat).
          if (ev > VALUE_BET_REJECT_THRESHOLD) {
            evRejectedExtreme += 1;
            continue;
          }
          // Favorit-flip = trolig sidoswap hos boken (underdog @ bok men favorit
          // @ Pinnacle) → falskt värde, hoppa över.
          if (isFavoriteFlipArtifact(bookOdds, fairProb)) {
            evRejectedExtreme += 1;
            continue;
          }
          const needsReview = ev > VALUE_BET_REVIEW_THRESHOLD;
          const fairPct = (effFairProbs[outcome] * 100).toFixed(1);
          const comment = needsReview
            ? `EV ${(ev * 100).toFixed(2)}% överstiger ${VALUE_BET_REVIEW_THRESHOLD * 100}%-tröskeln — dubbelkolla att Pinnacle-oddsen och bookmakerns avser samma marknad och inte är stale.`
            : (sharpSources?.length ?? 0) > 0
              ? `Skarp konsensus (Pinnacle + ${sharpSources?.join("+")}) ${fairPct}% sannolikhet vs bookmaker @${bookOdds.toFixed(2)} ger EV +${(ev * 100).toFixed(2)}%.`
              : `Pinnacle-fair ${fairPct}% sannolikhet vs bookmaker @${bookOdds.toFixed(2)} ger EV +${(ev * 100).toFixed(2)}%.`;
          // Market Trust Layer: beräkna grade + flaggor PER valuebet (ev varierar per
          // bok/utfall) ur samma data persist-vägen använder → UI visar trovärdigheten live.
          // Per-sharp individuella fair odds FÖR DETTA UTFALL (Pinnacle-native → 1/X/2).
          const sharpSel = outcome === "X" ? "DRAW" : outcome === "1" ? (swapHomeAway ? "AWAY" : "HOME") : (swapHomeAway ? "HOME" : "AWAY");
          const psFairOdds = (tri?: { HOME: number; DRAW: number; AWAY: number }): number | null => {
            const p = tri?.[sharpSel as "HOME" | "DRAW" | "AWAY"];
            return typeof p === "number" && p > 0 ? 1 / p : null;
          };
          const sharpPrices = {
            pinnacle: typeof fairOdds[outcome] === "number" ? fairOdds[outcome] : null,
            sbobet: psFairOdds(sharpPerSource?.sbobet),
            betfair: psFairOdds(sharpPerSource?.betfair),
          };
          // §2: rå Betfair back/lay/mid för DETTA utfall (om börsen matchade) + likviditet.
          const bfBookSel = betfairBook?.[sharpSel as "HOME" | "DRAW" | "AWAY"] ?? null;
          const betfairView = betfairLiquidity
            ? { ...betfairLiquidity, back: bfBookSel?.back ?? null, lay: bfBookSel?.lay ?? null, mid: bfBookSel?.mid ?? null }
            : null;
          const trustView = { match: match.title, market: "moneyline", outcome, bookmakerOdds: bookOdds, ev, pinnacle: pinnacleBlock, betfair: betfairView, sharpSources, sharpPrices, sourceFreshness };
          const liqScore = computeLiquidityScore(trustView);
          const trust = { liquidity_score: liqScore.score, liquidity_grade: liqScore.grade, flags: computeTrustFlags(trustView), recommendation: computeRecommendation(trustView).action };
          valueBets.push({
            match: match.title,
            startTs: match.startTs,
            league: match.league,
            market: "moneyline",
            pinnacle: pinnacleBlock,
            betfair: betfairView,
            sourceFreshness,
            sharpSources,
            trust,
            sharpPrices,
            bookmakerId,
            bookmakerName,
            outcome,
            outcomeLabel: outcomeLabels[outcome],
            bookmakerOdds: bookOdds,
            fairProb,
            fairOdds: fairProb > 0 ? 1 / fairProb : fairOdds[outcome], // konsekvent m. blandad fairProb
            ev,
            evPct: ev * 100,
            verification,
            needsReview,
            comment,
            isValueBet: true,
          });
        }
      }
    }

    // 2-vägs valuebets (basket + tennis) — separat kodväg som appendas.
    // Try/catch så ett 2-vägs-fel ALDRIG kan fälla fotbolls-svaret ovan.
    let basketballCount = 0;
    try {
      const twoWayBets = await compute2WayValueBets(pinnacleRows, hoursWindow);
      basketballCount = twoWayBets.length;
      valueBets.push(...twoWayBets);
    } catch (e) {
      console.warn(
        "[valuebets] basket-beräkning misslyckades (fotboll opåverkad):",
        e instanceof Error ? e.message : e,
      );
    }

    // PARSA PINNACLE EN GÅNG → dela mellan alla 4 football-motorer. Annars parsade
    // var motor om samma ~4,7 MB-payload (parsePinnacleSoccer + parsePinnacleLineLadders)
    // → 4× allokering/GC-churn → "ineffective mark-compacts" heap-OOM på busy dagar.
    const sharedRawPin = (await fetchOddsDbPayload("pinnacle-rows")) ?? null;
    const sharedPinEvents = sharedRawPin ? parsePinnacleSoccer(sharedRawPin) : undefined;
    const sharedPinLadders = sharedRawPin ? parsePinnacleLineLadders(sharedRawPin, "soccer") : undefined;

    // FOOTBALL TOTALS (Over/Under) — bevisad backend-motor (Pinnacle-stege + Betfair-
    // blend). Kill-switch VALUEBETS_TOTALS=0. Try/catch så totals-fel ALDRIG fäller
    // 1X2/2-vägs-svaret. Pinnacle är redan färsk här (hård gate ovan).
    if (process.env.VALUEBETS_TOTALS !== "0") {
      try {
        const totalsBets = await computeFootballTotalsValueBets(sharedRawPin, hoursWindow, sharedPinEvents, sharedPinLadders);
        valueBets.push(...totalsBets);
        console.log(`[valuebets] totals: ${totalsBets.length} Over/Under-valuebets`);
      } catch (e) {
        console.warn("[valuebets] totals-beräkning misslyckades (1X2 opåverkad):", e instanceof Error ? e.message : e);
      }
    }

    // FOOTBALL ASIAN HANDICAP — bevisad backend-motor (Pinnacle-AH-stege + Betfair-AH
    // + SBOBET-AH-blend). Kill-switch VALUEBETS_AH=0. Try/catch så AH-fel ALDRIG fäller
    // 1X2/2-vägs/totals-svaret.
    if (process.env.VALUEBETS_AH !== "0") {
      try {
        const ahBets = await computeFootballAhValueBets(sharedRawPin, hoursWindow, sharedPinEvents, sharedPinLadders);
        valueBets.push(...ahBets);
        console.log(`[valuebets] ah: ${ahBets.length} Asian-Handicap-valuebets`);
      } catch (e) {
        console.warn("[valuebets] AH-beräkning misslyckades (1X2 opåverkad):", e instanceof Error ? e.message : e);
      }
    }

    // FOOTBALL EUROPEISKT 3-VÄGS-HANDIKAPP (EH3) — härlett ur multi-skarp AH-konsensus
    // (Pinnacle + Betfair + SBOBET + Smarkets). DEFAULT PÅ (kill-switch VALUEBETS_EH3=0).
    // Teckenkonventionen validerad mot RIKTIG tipwin-data 2026-06-26: härledda
    // sannolikheter rimliga (summa=1, monoton), 0 falska valuebets — confirmer- +
    // disagreement-grindarna fångar tunna/oense marknader. Try/catch isolerar felet.
    if (process.env.VALUEBETS_EH3 !== "0") {
      try {
        const eh3Bets = await computeFootballEh3ValueBets(sharedRawPin, hoursWindow, sharedPinEvents, sharedPinLadders);
        valueBets.push(...eh3Bets);
        console.log(`[valuebets] eh3: ${eh3Bets.length} europeiska-3-vägs-HC-valuebets`);
      } catch (e) {
        console.warn("[valuebets] EH3-beräkning misslyckades (övriga opåverkade):", e instanceof Error ? e.message : e);
      }
    }

    // FOOTBALL HÖRN (corner totals + corner AH) — mot Pinnacles hörn-stege. OPT-IN:
    // VALUEBETS_CORNERS=1 (default AV tills böckerna emitterar corners-fältet). Try/catch.
    if (process.env.VALUEBETS_CORNERS === "1") {
      try {
        const cornerBets = await computeFootballCornersValueBets(sharedRawPin, hoursWindow, sharedPinEvents);
        valueBets.push(...cornerBets);
        console.log(`[valuebets] corners: ${cornerBets.length} hörn-valuebets`);
      } catch (e) {
        console.warn("[valuebets] hörn-beräkning misslyckades (övriga opåverkade):", e instanceof Error ? e.message : e);
      }
    }

    valueBets.sort((a, b) => b.ev - a.ev);

    // När Pinnacle ger 0 rader är det enda värdebets-pipelinen kan göra att avvisa allt.
    // Probea direkt mot Pinnacle + workerns disk-cache så vi ser exakt varför
    // (datacenter-IP-blockering / disk-cache saknas / disk-cache är gammal etc.).
    const pinnacleProbeResult =
      pinnacleSoccer.length === 0 ? await pinnacleProbe() : null;
    const pinnacleDisk = pinnacleSoccer.length === 0 ? pinnacleDiskProbe() : null;

    console.log(
      `[valuebets] matchning klar: ${matches.length} bonus-matcher × ${pinnacleSoccer.length} Pinnacle-rader på ${Date.now() - matchStart}ms → ${valueBets.length} valuebets`,
    );

    return JSON.stringify({
        ok: true,
        generatedAt: Date.now(),
        hours: hoursWindow,
        threshold: VALUE_BET_EV_THRESHOLD,
        reviewThreshold: VALUE_BET_REVIEW_THRESHOLD,
        rejectThreshold: VALUE_BET_REJECT_THRESHOLD,
        timeToleranceMs: VALUE_BET_TIME_TOLERANCE_MS,
        pinnacleFreshnessThresholdMs: PINNACLE_FRESHNESS_THRESHOLD_MS,
        matchesScanned: matches.length,
        pinnacleSoccerMoneylineCount: pinnacleSoccer.length,
        basketballValueBetCount: basketballCount,
        pinnacleUpdatedAt: pinnacleMeta.updatedAt,
        pinnacleAgeSeconds,
        isPinnacleFresh,
        pinnacleStatus,
        pinnacleSource: pinnacleMeta.source,
        bonusIndexStatus: getPrewarmStatusSnapshot(),
        valueBets,
        diagnostics: {
          pairsConsidered,
          pairsRejectedTeams,
          pairsRejectedTime,
          pairsRejectedLeague,
          pairsRejectedSides,
          evRejectedExtreme,
          pinnacleProbe: pinnacleProbeResult,
          pinnacleDisk,
        },
      });
}

async function fetchBetssonJson(url: string, referer: string, headers: Record<string, string>) {
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_HTTP_TIMEOUT_MS),
    headers: {
      ...headers,
      accept: "application/json, text/plain, */*",
      "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
      "content-type": "application/json",
      origin: new URL(referer).origin,
      referer,
      "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });
  if (!upstream.ok) throw new Error(`Upstream status ${upstream.status}`);
  return (await upstream.json()) as unknown;
}

async function parseOddsRowsFromBetssonSportsbook(url: string) {
  const context = await getBetssonSportsbookContext(url);
  const eventId = extractBetssonEventId(url);
  if (!context || !eventId) return { rows: [], title: "" };

  const eventData = await fetchBetssonJson(
    `${context.baseUrl}/api/sb/v1/widgets/event/v2?eventId=${encodeURIComponent(eventId)}&subTabs=133`,
    context.iframeUrl,
    context.headers,
  );
  let oddsRows: ReturnType<typeof parseBetssonRowsFromAccordion> = [];
  const accordionUrls = [
    `${context.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}&groupableId=MW3W`,
    `${context.baseUrl}/api/sb/v1/widgets/accordion/v1?eventId=${encodeURIComponent(eventId)}`,
  ];
  for (const accUrl of accordionUrls) {
    try {
      const accordionData = await fetchBetssonJson(accUrl, context.iframeUrl, context.headers);
      oddsRows = parseBetssonRowsFromAccordion(accordionData);
      if (oddsRows.length > 0) break;
    } catch {
      // nästa
    }
  }

  return {
    rows: oddsRows,
    title: parseBetssonTitleFromEvent(eventData),
  };
}

function parseMatchLinksFromHtml(html: string, query?: string) {
  const $ = load(html);
  const links: Array<{ title: string; url: string; score: number }> = [];
  const seen = new Set<string>();
  const queryTokens = (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  $("a").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    if (!href) return;
    const full = href.startsWith("http") ? href : `https://oddsportal.com${href}`;
    if (!full.includes("/football/") && !full.includes("/odds/")) return;
    // Skip obvious non-match list pages.
    if (/\/(results|standings|bookmakers|value-bets|sure-bets|dropping-odds|bonus-offers)\b/i.test(full)) return;
    const title = $(a).text().replace(/\s+/g, " ").trim();
    if (!title || title.length < 5) return;
    const looksLikeMatch = /\b(vs|v)\b| - | : /i.test(title) ? 1 : 0;
    if (!looksLikeMatch) return;
    const normalizedTitle = title.toLowerCase();
    if (queryTokens.length > 0 && !queryTokens.some((t) => normalizedTitle.includes(t))) return;
    if (seen.has(full)) return;
    seen.add(full);
    const tokenHits = queryTokens.reduce((sum, token) => sum + (normalizedTitle.includes(token) ? 1 : 0), 0);
    if (tokenHits < minSearchScore(query ?? "")) return;
    const footballBoost = full.includes("/football/") ? 1 : 0;
    const score = tokenHits * 10 + looksLikeMatch * 4 + footballBoost;
    links.push({ title, url: full, score });
  });
  return links
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 120)
    .map(({ title, url }) => ({ title, url }));
}

async function fetchHtml(url: string, referer?: string) {
  const origin = (() => {
    try {
      return new URL(referer ?? url).origin;
    } catch {
      return undefined;
    }
  })();
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_HTTP_TIMEOUT_MS),
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": referer ? "iframe" : "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": referer ? "same-site" : "none",
      "upgrade-insecure-requests": "1",
      ...(origin ? { origin } : {}),
      ...(referer ? { referer, "x-requested-with": "XMLHttpRequest" } : {}),
    },
  });
  if (!upstream.ok) throw new Error(`Upstream status ${upstream.status}`);
  return await upstream.text();
}

/** Dev-only scraping proxy/parsing for odds comparison pages. */
async function oddsComparisonDevApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/odds-comparison") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }

  try {
    const body = await readRequestBody(req);
    const parsed = JSON.parse(body) as { url?: string; query?: string; targetTitle?: string; targetUrl?: string };
    const query = parsed?.query?.trim();
    const targetTitle = parsed?.targetTitle?.trim();
    const selectedTargetUrl = parsed?.targetUrl?.trim();
    if (query) {
      const searchUrl = `https://oddsportal.com/search/?q=${encodeURIComponent(query)}`;
      const searchHtml = await fetchHtml(searchUrl);
      const matches = parseMatchLinksFromHtml(searchHtml, query);

      // Fallback: search upcoming football pages if search results are empty.
      if (matches.length === 0) {
        const fallbackPages = [
          "https://oddsportal.com/football/",
          "https://oddsportal.com/football/england/premier-league/",
          "https://oddsportal.com/football/europe/champions-league/",
        ];
        for (const page of fallbackPages) {
          try {
            const html = await fetchHtml(page);
            const pageMatches = parseMatchLinksFromHtml(html, query);
            for (const item of pageMatches) {
              if (!matches.some((m) => m.url === item.url)) matches.push(item);
            }
            if (matches.length >= 12) break;
          } catch {
            // Ignore individual fallback page errors.
          }
        }
      }
      const partnerMatches = await discoverPartnerMatchLinks(query);
      const selectedMatch =
        targetTitle && selectedTargetUrl
          ? [{ title: targetTitle, url: selectedTargetUrl }]
          : targetTitle
            ? [{ title: targetTitle, url: `partner-search:${encodeURIComponent(targetTitle)}` }]
            : [];
      const combinedMatches = mergeMatchLinks([...selectedMatch, ...matches, ...partnerMatches]);
      matches.splice(0, matches.length, ...combinedMatches);
      const bookmakerResults = targetTitle ? await scrapeBookmakersForMatch(targetTitle, query) : [];
      const rows = rowsFromBookmakerResults(bookmakerResults);
      const title = targetTitle || matches[0]?.title || "";
      if (matches.length === 0 && title && rows.length > 0) {
        matches.push({ title, url: `partner-search:${query}` });
      }
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          mode: "search",
          query,
          count: matches.length,
          matches,
          title,
          odds: rows.slice(0, 120),
          bookmakerResults,
          scrapeSummary: summarizeBookmakerScrapeResults(bookmakerResults),
          bestByOutcome: buildBestByOutcome(rows),
        }),
      );
      return;
    }

    const targetUrl = parsed?.url?.trim();
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Invalid url or query" }));
      return;
    }

    const { rows, title } = await parseOddsRowsFromSupportedUrl(targetUrl);
    const bestByOutcome = buildBestByOutcome(rows);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ok: true,
        mode: "url",
        source: targetUrl,
        title,
        count: rows.length,
        odds: rows.slice(0, 120),
        bestByOutcome,
      }),
    );
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(error, "Unknown error");
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

type BetOnlineBrowserOdd = {
  raw: string;
  match: string;
  homeAmerican: number;
  awayAmerican: number;
  homeDecimal: number;
  awayDecimal: number;
  drawAmerican?: number;
  drawDecimal?: number;
  marketType?: "moneyline" | "spread" | "total";
  homeLine?: number;
  awayLine?: number;
  line?: number;
  homeOutcomeLabel?: string;
  awayOutcomeLabel?: string;
  drawOutcomeLabel?: string;
  marketLabel?: string;
  /** Vilken bookmaker raden kommer ifrån (default "betonline" för bakåtkompatibilitet). */
  bookSource?: "betonline" | "pinnacle";
};

function americanOddsToDecimal(value: number) {
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

// ---------------------------------------------------------------------------
// Stake.com publik odds-data API (https://odds-data.stake.com)
// Inget API-token krävs. Vi pratar direkt mot dataservern Stakes egna webb
// använder för att rita upp sportsbooken, så vi får exakt samma odds som syns
// i webbappen utan browser/Playwright.
// ---------------------------------------------------------------------------

const STAKE_API_BASE = "https://odds-data.stake.com";
const STAKE_FETCH_TIMEOUT_MS = UPSTREAM_HTTP_TIMEOUT_MS;
const STAKE_FETCH_HEADERS = {
  accept: "application/json",
  origin: "https://stake.com",
  referer: "https://stake.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
} as const;

type StakeFixtureMeta = {
  id?: string;
  slug?: string;
  name?: string;
  date?: number;
  feedStartTime?: number;
  startTime?: number;
  status?: string;
  category?: string;
  tournament?: string;
  competitors?: string[];
  preMatchEnabled?: boolean;
};

function stakeFixtureStartTime(fixture: StakeFixtureMeta | undefined) {
  return fixture?.startTime ?? fixture?.date ?? fixture?.feedStartTime;
}

type StakeMarketOutcome = {
  name?: string;
  odds?: number;
  active?: boolean;
};

type StakeMarket = {
  name?: string;
  status?: string;
  specifiers?: string;
  outcomes?: StakeMarketOutcome[];
};

type StakeMarketGroup = {
  name?: string;
  markets?: StakeMarket[][];
};

type StakeOddsResponse = {
  fixture?: StakeFixtureMeta;
  groups?: StakeMarketGroup[];
};

type StakeWinnerOdds = {
  source: "stake";
  sport: string;
  match: string;
  startTime?: number;
  status?: string;
  category?: string;
  tournament?: string;
  homeName?: string;
  awayName?: string;
  homeOdds: number;
  awayOdds: number;
  homeLine?: number;
  awayLine?: number;
  homeOutcomeLabel?: string;
  awayOutcomeLabel?: string;
  drawOdds?: number;
  marketType?: "moneyline" | "spread" | "total";
  line?: number;
  marketLabel?: string;
  marketName: string;
  fixtureSlug?: string;
  fixtureId?: string;
};

const STAKE_DEFAULT_SPORTS = [
  "soccer",
  "basketball",
  "tennis",
  "ice-hockey",
  "american-football",
  "baseball",
  "mma",
  "boxing",
] as const;

const STAKE_POPULAR_TOURNAMENTS = [
  { sport: "soccer", category: "england", tournament: "premier-league" },
  { sport: "soccer", category: "spain", tournament: "laliga" },
  { sport: "soccer", category: "italy", tournament: "serie-a" },
  { sport: "soccer", category: "germany", tournament: "bundesliga" },
  { sport: "soccer", category: "france", tournament: "ligue-1" },
  { sport: "soccer", category: "international-clubs", tournament: "uefa-champions-league" },
  { sport: "soccer", category: "international-clubs", tournament: "uefa-europa-league" },
  { sport: "soccer", category: "england", tournament: "championship" },
  { sport: "soccer", category: "england", tournament: "fa-cup" },
  { sport: "soccer", category: "usa", tournament: "major-league-soccer" },
  { sport: "soccer", category: "spain", tournament: "copa-del-rey" },
  { sport: "basketball", category: "usa", tournament: "nba" },
  { sport: "basketball", category: "international", tournament: "euroleague" },
  { sport: "basketball", category: "usa", tournament: "ncaa" },
  { sport: "ice-hockey", category: "usa", tournament: "nhl" },
  { sport: "american-football", category: "usa", tournament: "nfl" },
  { sport: "american-football", category: "usa", tournament: "ncaa" },
  { sport: "baseball", category: "usa", tournament: "mlb" },
  { sport: "tennis", category: "atp", tournament: "atp-madrid" },
  { sport: "tennis", category: "wta", tournament: "wta-madrid" },
] as const;

async function fetchStakeJson<T = unknown>(pathSuffix: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAKE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${STAKE_API_BASE}${pathSuffix}`, {
      headers: STAKE_FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Stake API ${pathSuffix} HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function selectStakeWinnerMarket(payload: StakeOddsResponse) {
  if (!payload?.groups) return null;
  const candidates: Array<{ market: StakeMarket; priority: number }> = [];

  for (const group of payload.groups) {
    if (group?.name && group.name !== "main" && !/winner|moneyline|head/i.test(group.name)) continue;
    for (const marketArr of group?.markets ?? []) {
      for (const market of marketArr ?? []) {
        if (!market?.name || market.status === "deactivated" || market.status === "suspended") continue;
        if (market.specifiers && market.specifiers.length > 0) continue;
        const lower = market.name.toLowerCase();
        let priority = -1;
        if (lower === "1x2") priority = 100;
        else if (lower === "match winner" || lower === "match winner - threeway") priority = 95;
        else if (lower === "winner (incl. overtime)") priority = 90;
        else if (lower === "match winner - twoway" || lower === "winner") priority = 85;
        else if (lower === "moneyline") priority = 82;
        else if (lower === "head to head" || lower === "to win match") priority = 80;
        else if (lower.includes("winner") && !lower.includes("half") && !lower.includes("quarter") && !lower.includes("set"))
          priority = 60;
        if (priority < 0) continue;
        const outcomes = (market.outcomes ?? []).filter((o) => Number.isFinite(o?.odds) && (o?.odds ?? 0) > 1);
        if (outcomes.length < 2) continue;
        candidates.push({ market: { ...market, outcomes }, priority });
      }
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0]?.market ?? null;
}

function parseMarketLine(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).replace(",", ".");
    const match = text.match(/(?:^|[^\d])([+-]?\d+(?:\.\d+)?)(?!\d)/);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatMarketLine(value: number) {
  const abs = Math.abs(value);
  const text = abs.toLocaleString("sv-SE", { maximumFractionDigits: 2 });
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return "0";
}

function isMarketActive(market: StakeMarket) {
  return Boolean(market?.name) && market.status !== "deactivated" && market.status !== "suspended";
}

function cleanStakeOutcomes(market: StakeMarket) {
  return (market.outcomes ?? []).filter((o) => Number.isFinite(o?.odds) && (o?.odds ?? 0) > 1);
}

function extractStakeWinnerOdds(
  sport: string,
  meta: StakeFixtureMeta | undefined,
  payload: StakeOddsResponse,
): StakeWinnerOdds | null {
  const market = selectStakeWinnerMarket(payload);
  if (!market || !market.outcomes) return null;

  const fixture = payload.fixture ?? meta ?? {};
  const competitors = fixture.competitors ?? meta?.competitors ?? [];
  const matchName = fixture.name ?? meta?.name ?? competitors.join(" - ");
  if (!matchName) return null;

  const homeName = competitors[0];
  const awayName = competitors[1];

  const findOutcome = (predicate: (o: StakeMarketOutcome) => boolean) =>
    market.outcomes!.find(predicate);

  let drawOutcome: StakeMarketOutcome | undefined;
  let homeOutcome: StakeMarketOutcome | undefined;
  let awayOutcome: StakeMarketOutcome | undefined;

  if (market.outcomes.length === 3) {
    drawOutcome = findOutcome((o) => /^(draw|x|tie)$/i.test(o?.name ?? ""));
  }
  if (homeName) {
    homeOutcome = findOutcome((o) => (o?.name ?? "").trim().toLowerCase() === homeName.toLowerCase());
  }
  if (awayName) {
    awayOutcome = findOutcome((o) => (o?.name ?? "").trim().toLowerCase() === awayName.toLowerCase());
  }

  if (!homeOutcome || !awayOutcome) {
    const remaining = market.outcomes.filter((o) => o !== drawOutcome);
    homeOutcome = homeOutcome ?? remaining[0];
    awayOutcome = awayOutcome ?? remaining[1] ?? remaining[remaining.length - 1];
  }
  if (!homeOutcome || !awayOutcome) return null;

  const homeOdds = Number(homeOutcome?.odds);
  const awayOdds = Number(awayOutcome?.odds);
  if (!(homeOdds > 1 && awayOdds > 1)) return null;
  const drawOdds = drawOutcome ? Number(drawOutcome.odds) : undefined;

  return {
    source: "stake",
    sport,
    match: matchName,
    startTime: stakeFixtureStartTime(fixture) ?? stakeFixtureStartTime(meta),
    status: fixture.status ?? meta?.status,
    category: fixture.category ?? meta?.category,
    tournament: fixture.tournament ?? meta?.tournament,
    homeName: homeOutcome?.name ?? homeName,
    awayName: awayOutcome?.name ?? awayName,
    homeOdds,
    awayOdds,
    drawOdds: Number.isFinite(drawOdds) && (drawOdds ?? 0) > 1 ? drawOdds : undefined,
    marketName: market.name ?? "Match Winner",
    fixtureSlug: fixture.slug ?? meta?.slug,
    fixtureId: fixture.id ?? meta?.id,
  };
}

function extractStakeMarketRows(
  sport: string,
  meta: StakeFixtureMeta | undefined,
  payload: StakeOddsResponse,
): StakeWinnerOdds[] {
  const fixture = payload.fixture ?? meta ?? {};
  const competitors = fixture.competitors ?? meta?.competitors ?? [];
  const matchName = fixture.name ?? meta?.name ?? competitors.join(" - ");
  if (!matchName) return [];

  const homeName = competitors[0];
  const awayName = competitors[1];
  const base = {
    source: "stake" as const,
    sport,
    match: matchName,
    startTime: stakeFixtureStartTime(fixture) ?? stakeFixtureStartTime(meta),
    status: fixture.status ?? meta?.status,
    category: fixture.category ?? meta?.category,
    tournament: fixture.tournament ?? meta?.tournament,
    fixtureSlug: fixture.slug ?? meta?.slug,
    fixtureId: fixture.id ?? meta?.id,
  };

  const rows: StakeWinnerOdds[] = [];
  const winner = extractStakeWinnerOdds(sport, meta, payload);
  if (winner) rows.push({ ...winner, marketType: "moneyline", marketLabel: "Moneyline" });

  for (const group of payload.groups ?? []) {
    for (const marketArr of group?.markets ?? []) {
      for (const market of marketArr ?? []) {
        if (!isMarketActive(market)) continue;
        const outcomes = cleanStakeOutcomes(market);
        if (outcomes.length < 2) continue;
        const lower = (market.name ?? "").toLowerCase();

        if (/total|over\/under|o\/u/.test(lower) && !/team|half|quarter|period|set/.test(lower)) {
          const over = outcomes.find((o) => /^over\b|^o\b/i.test(o.name ?? ""));
          const under = outcomes.find((o) => /^under\b|^u\b/i.test(o.name ?? ""));
          const line = parseMarketLine(over?.name, under?.name, market.name, market.specifiers);
          if (!over || !under || line == null) continue;
          rows.push({
            ...base,
            homeName,
            awayName,
            homeOdds: Number(over.odds),
            awayOdds: Number(under.odds),
            homeOutcomeLabel: `Över ${line.toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
            awayOutcomeLabel: `Under ${line.toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
            marketType: "total",
            line,
            marketName: market.name ?? "Total",
            marketLabel: `Total ${line.toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
          });
          continue;
        }

        if (/spread|handicap|run line|puck line/.test(lower) && !/half|quarter|period|set/.test(lower)) {
          const homeOutcome =
            outcomes.find((o) => homeName && (o.name ?? "").toLowerCase().includes(homeName.toLowerCase())) ??
            outcomes[0];
          const awayOutcome =
            outcomes.find((o) => awayName && (o.name ?? "").toLowerCase().includes(awayName.toLowerCase())) ??
            outcomes.find((o) => o !== homeOutcome);
          const homeLine = parseMarketLine(homeOutcome?.name, market.name, market.specifiers);
          const awayLine = parseMarketLine(awayOutcome?.name, market.name, market.specifiers);
          if (!homeOutcome || !awayOutcome || homeLine == null || awayLine == null) continue;
          if (Math.abs(homeLine + awayLine) > 0.05) continue;
          rows.push({
            ...base,
            homeName,
            awayName,
            homeOdds: Number(homeOutcome.odds),
            awayOdds: Number(awayOutcome.odds),
            homeLine,
            awayLine,
            homeOutcomeLabel: `${homeName ?? "Hemma"} ${formatMarketLine(homeLine)}`,
            awayOutcomeLabel: `${awayName ?? "Borta"} ${formatMarketLine(awayLine)}`,
            marketType: "spread",
            line: Math.abs(homeLine),
            marketName: market.name ?? "Spread",
            marketLabel: `Spread ${Math.abs(homeLine).toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
          });
        }
      }
    }
  }

  const deduped = new Map<string, StakeWinnerOdds>();
  for (const row of rows) {
    const key = `${row.marketType ?? "moneyline"}:${row.line ?? ""}:${row.homeLine ?? ""}:${row.awayLine ?? ""}`;
    if (!deduped.has(key)) deduped.set(key, row);
  }
  return [...deduped.values()];
}

async function listStakeFixturesForSport(sport: string): Promise<StakeFixtureMeta[]> {
  const seen = new Map<string, StakeFixtureMeta>();
  const addAll = (arr: StakeFixtureMeta[] | undefined) => {
    for (const fixture of arr ?? []) {
      const key = fixture?.slug ?? fixture?.id;
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, fixture);
    }
  };

  const tournamentRequests = STAKE_POPULAR_TOURNAMENTS.filter((t) => t.sport === sport).map((t) =>
    fetchStakeJson<{ fixture?: StakeFixtureMeta[] }>(
      `/sport/${t.sport}/category/${t.category}/tournament/${t.tournament}/fixture`,
    )
      .then((data) => addAll(data?.fixture))
      .catch(() => undefined),
  );

  await Promise.all([
    fetchStakeJson<{ fixture?: StakeFixtureMeta[] }>(`/sport/${sport}/fixture`)
      .then((data) => addAll(data?.fixture))
      .catch(() => undefined),
    fetchStakeJson<{ schedule?: Array<{ fixture?: StakeFixtureMeta[]; fixtures?: StakeFixtureMeta[] }> }>(
      `/schedule/sport/${sport}`,
    )
      .then((data) => {
        for (const entry of data?.schedule ?? []) {
          addAll(entry?.fixture);
          addAll(entry?.fixtures);
        }
      })
      .catch(() => undefined),
    ...tournamentRequests,
  ]);

  return [...seen.values()].filter((fixture) => fixture?.preMatchEnabled !== false);
}

const STAKE_ROWS_CACHE_TTL_MS = 90 * 1000;
const stakeRowsCache = new Map<string, { expiresAt: number; rows: StakeWinnerOdds[] }>();
let stakeRowsInflight: Promise<StakeWinnerOdds[]> | null = null;

async function buildStakeRowsForSport(sport: string, fixtureLimit = 60): Promise<StakeWinnerOdds[]> {
  const fixtures = await listStakeFixturesForSport(sport);
  const now = Date.now();
  // Endast pre-match: skippa live, redan startade och utan korrekt starttid
  const preMatch = fixtures.filter(
    (fixture) =>
      fixture?.status !== "live" &&
      fixture?.status !== "ended" &&
      Number.isFinite(stakeFixtureStartTime(fixture)) &&
      (stakeFixtureStartTime(fixture) ?? 0) > now,
  );
  const trimmed = preMatch
    .slice()
    .sort((a, b) => (stakeFixtureStartTime(a) ?? Infinity) - (stakeFixtureStartTime(b) ?? Infinity))
    .slice(0, fixtureLimit);

  const out = await mapLimit(trimmed, 6, async (fixture) => {
    const slug = fixture?.slug ?? fixture?.id;
    if (!slug) return null;
    try {
      const payload = await fetchStakeJson<StakeOddsResponse>(`/fixtures/${slug}`);
      const rows = extractStakeMarketRows(sport, fixture, payload);
      // Dubbelkolla: payload kan ha uppdaterat status till live efter fixturlistans hämtning
      return rows.filter((row) => row.status !== "live" && row.status !== "ended");
    } catch {
      return null;
    }
  });
  return out.flat().filter((row): row is StakeWinnerOdds => row !== null);
}

async function buildStakeRowsAllSports(
  options: { sports?: readonly string[]; fixtureLimitPerSport?: number; force?: boolean } = {},
): Promise<StakeWinnerOdds[]> {
  const sports = options.sports ?? STAKE_DEFAULT_SPORTS;
  const limitPerSport = options.fixtureLimitPerSport ?? 60;
  const cacheKey = `${sports.join(",")}|${limitPerSport}`;
  const now = Date.now();

  if (!options.force) {
    const cached = stakeRowsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.rows;
    if (stakeRowsInflight) return stakeRowsInflight;
  }

  const promise = (async () => {
    const all: StakeWinnerOdds[] = [];
    for (const sport of sports) {
      try {
        const rows = await buildStakeRowsForSport(sport, limitPerSport);
        all.push(...rows);
      } catch (error) {
        console.warn(`[stake] failed to fetch sport ${sport}:`, error instanceof Error ? error.message : error);
      }
    }
    stakeRowsCache.set(cacheKey, { expiresAt: Date.now() + STAKE_ROWS_CACHE_TTL_MS, rows: all });
    return all;
  })()
    .finally(() => {
      stakeRowsInflight = null;
    });

  stakeRowsInflight = promise;
  return promise;
}

// ---------------------------------------------------------------------------
// Match-koppling Stake <-> BetOnline
// ---------------------------------------------------------------------------

// Vanliga geografiska/franchise-ord som inte räknas som unika klubbtokens.
// Tar bort dem så att t.ex. "Los Angeles Lakers" inte matchas mot "Los Angeles Galaxy".
const STAKE_BETONLINE_STOP_WORDS = new Set([
  "fc",
  "afc",
  "cf",
  "sc",
  "bk",
  "if",
  "ac",
  "bc",
  "united",
  "city",
  "club",
  "los",
  "angeles",
  "new",
  "york",
  "san",
  "real",
  "el",
  "la",
  "saint",
  "st",
  "fr",
  "of",
  "the",
  "and",
  "fck",
  "borussia",
  "atletico",
  "athletic",
  "deportivo",
]);

const MLB_TEAM_TOKENS = [
  "angels",
  "astros",
  "athletics",
  "blue jays",
  "braves",
  "brewers",
  "cardinals",
  "cubs",
  "diamondbacks",
  "dodgers",
  "giants",
  "guardians",
  "mariners",
  "marlins",
  "mets",
  "nationals",
  "orioles",
  "padres",
  "phillies",
  "pirates",
  "rangers",
  "rays",
  "red sox",
  "reds",
  "rockies",
  "royals",
  "tigers",
  "twins",
  "white sox",
  "yankees",
];

function isMlbMatchName(value: string | undefined) {
  const normalized = normalizeStakeBetOnlineMatchName(value ?? "");
  return MLB_TEAM_TOKENS.filter((team) => normalized.includes(team)).length >= 2;
}

function isSupportedStakeBetOnlineMatch(stakeRow: StakeWinnerOdds, betOnlineRow: BetOnlineBrowserOdd) {
  if (stakeRow.sport !== "baseball" && betOnlineRow.sport !== "baseball") return true;
  return isMlbMatchName(stakeRow.match) && isMlbMatchName(betOnlineRow.match);
}

function normalizeStakeBetOnlineMatchName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stakeBetOnlineTeamTokens(team: string | undefined) {
  if (!team) return new Set<string>();
  const tokens = normalizeStakeBetOnlineMatchName(team)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STAKE_BETONLINE_STOP_WORDS.has(token));
  return new Set(tokens);
}

function stakeBetOnlineTeamMatch(a: string | undefined, b: string | undefined) {
  const aTokens = stakeBetOnlineTeamTokens(a);
  const bTokens = stakeBetOnlineTeamTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let hits = 0;
  for (const token of aTokens) if (bTokens.has(token)) hits += 1;
  return hits / Math.min(aTokens.size, bTokens.size);
}

function stakeMatchTeams(row: StakeWinnerOdds): { home: string; away: string } {
  const split = row.match.includes(" vs ")
    ? row.match.split(" vs ")
    : row.match.split(" - ");
  return {
    home: row.homeName ?? split[0]?.trim() ?? "",
    away: row.awayName ?? split.slice(-1)[0]?.trim() ?? "",
  };
}

function betOnlineMatchTeams(row: BetOnlineBrowserOdd & { homeName?: string; awayName?: string }): {
  home: string;
  away: string;
} {
  const split = row.match.includes(" vs ")
    ? row.match.split(" vs ")
    : row.match.split(" - ");
  return {
    home: row.homeName ?? split[0]?.trim() ?? "",
    away: row.awayName ?? split.slice(-1)[0]?.trim() ?? "",
  };
}

function oddsValueForSide(row: { homeDecimal?: number; awayDecimal?: number; homeOdds?: number; awayOdds?: number }, side: "home" | "away") {
  return Number(side === "home" ? (row.homeDecimal ?? row.homeOdds) : (row.awayDecimal ?? row.awayOdds));
}

function drawOddsValue(row: { drawDecimal?: number; drawOdds?: number }) {
  return Number(row.drawDecimal ?? row.drawOdds);
}

function outcomeLabelForSide(
  row: {
    homeOutcomeLabel?: string;
    awayOutcomeLabel?: string;
    drawOutcomeLabel?: string;
    homeName?: string;
    awayName?: string;
    match?: string;
    marketType?: string;
  },
  side: "home" | "draw" | "away",
) {
  if (side === "draw") return row.drawOutcomeLabel ?? "Oavgjort";
  const explicit = side === "home" ? row.homeOutcomeLabel : row.awayOutcomeLabel;
  if (explicit) return explicit;
  if (row.marketType === "total") return side === "home" ? "Över" : "Under";
  const teams = row.match ? betOnlineMatchTeams(row as BetOnlineBrowserOdd & { homeName?: string; awayName?: string }) : null;
  return side === "home" ? row.homeName ?? teams?.home ?? "Hemma" : row.awayName ?? teams?.away ?? "Borta";
}

function marketsCompatible(
  stakeRow: StakeWinnerOdds,
  betOnlineRow: BetOnlineBrowserOdd & { marketType?: "moneyline" | "spread" | "total" },
) {
  const stakeType = stakeRow.marketType ?? "moneyline";
  const boType = betOnlineRow.marketType ?? "moneyline";
  if (stakeType !== boType) return false;
  if (stakeType === "moneyline") {
    // Antalet utfall måste matcha — 1X2 mot 1X2, eller 2-vägs mot 2-vägs.
    const stakeIs3Way = !!(stakeRow.drawOdds && stakeRow.drawOdds > 1);
    const boIs3Way = !!(betOnlineRow.drawDecimal && betOnlineRow.drawDecimal > 1);
    return stakeIs3Way === boIs3Way;
  }
  if (stakeType === "total") return stakeRow.line != null && betOnlineRow.line != null && Math.abs(stakeRow.line - betOnlineRow.line) < 0.05;
  return (
    stakeRow.homeLine != null &&
    stakeRow.awayLine != null &&
    betOnlineRow.homeLine != null &&
    betOnlineRow.awayLine != null &&
    Math.abs(Math.abs(stakeRow.homeLine) - Math.abs(betOnlineRow.homeLine)) < 0.05
  );
}

function opportunityKey(row: StakeBetOnlineOpportunity) {
  // Använd Stake-matchen + marknad som nyckel. Vi vill bara behålla den BÄSTA
  // varianten per match+marknad, oavsett vilken kombination av böcker som gav
  // den. Detta dedupar best-line och pair-wise tillsammans.
  return [
    normalizeStakeBetOnlineMatchName(row.stakeMatch),
    row.marketType ?? "moneyline",
    row.line ?? "",
  ].join("|");
}

type StakeBetOnlineLeg = {
  book: "stake" | "betonline";
  outcome: "home" | "draw" | "away";
  label: string;
  odds: number;
  stake: number;
  payout: number;
  result: number;
};

type StakeBetOnlineOpportunity = {
  match: string;
  sport?: string;
  startTime?: number;
  tournament?: string;
  marketType?: "moneyline" | "spread" | "total";
  marketLabel?: string;
  line?: number;
  stakeMatch: string;
  betOnlineMatch: string;
  stakeSide: "home" | "draw" | "away";
  stakeOutcomeLabel?: string;
  stakeOdds: number;
  betOnlineSide: "home" | "draw" | "away";
  betOnlineOutcomeLabel?: string;
  betOnlineOdds: number;
  stakeStake: number;
  betOnlineStake: number;
  totalStake: number;
  payout: number;
  profit: number;
  edgePct: number;
  /** Vilken bookmaker som "BetOnline-sidan" verkligen kommer från. */
  betOnlineBookSource?: "betonline" | "pinnacle";
  legs?: StakeBetOnlineLeg[];
};

function buildThreeWayOpportunity(
  stakeRow: StakeWinnerOdds,
  betOnlineRow: BetOnlineBrowserOdd & { homeName?: string; awayName?: string },
  flipped: boolean,
  stakeSingleOutcome: "home" | "draw" | "away" | null,
  totalStake: number,
): StakeBetOnlineOpportunity | null {
  if (!(stakeRow.drawOdds && stakeRow.drawOdds > 1)) return null;
  const boOdds = {
    home: flipped ? oddsValueForSide(betOnlineRow, "away") : oddsValueForSide(betOnlineRow, "home"),
    draw: drawOddsValue(betOnlineRow),
    away: flipped ? oddsValueForSide(betOnlineRow, "home") : oddsValueForSide(betOnlineRow, "away"),
  };
  const stakeOdds = {
    home: stakeRow.homeOdds,
    draw: stakeRow.drawOdds,
    away: stakeRow.awayOdds,
  };
  if (!Object.values(boOdds).every((value) => value > 1) || !Object.values(stakeOdds).every((value) => value > 1)) {
    return null;
  }

  const outcomes: Array<"home" | "draw" | "away"> = ["home", "draw", "away"];
  const legs = outcomes.map((outcome) => {
    const book = stakeSingleOutcome === outcome ? "stake" : "betonline";
    const odds = book === "stake" ? stakeOdds[outcome] : boOdds[outcome];
    return {
      book,
      outcome,
      label:
        book === "stake"
          ? outcomeLabelForSide(stakeRow, outcome)
          : outcomeLabelForSide(betOnlineRow, outcome),
      odds,
      stake: 0,
      payout: 0,
      result: 0,
    } satisfies StakeBetOnlineLeg;
  });

  const invSum = legs.reduce((sum, leg) => sum + 1 / leg.odds, 0);
  if (!(invSum > 0)) return null;
  const equalPayout = totalStake / invSum;
  const pricedLegs = legs.map((leg) => {
    const stake = equalPayout / leg.odds;
    return {
      ...leg,
      stake,
      payout: equalPayout,
      result: equalPayout - totalStake,
    };
  });
  const profit = equalPayout - totalStake;
  const stakeStake = pricedLegs.filter((leg) => leg.book === "stake").reduce((sum, leg) => sum + leg.stake, 0);
  const betOnlineStake = pricedLegs.filter((leg) => leg.book === "betonline").reduce((sum, leg) => sum + leg.stake, 0);
  const stakeLeg = pricedLegs.find((leg) => leg.book === "stake") ?? pricedLegs[0];
  const betOnlineLeg = pricedLegs.find((leg) => leg.book === "betonline") ?? pricedLegs[1] ?? pricedLegs[0];

  return {
    match: stakeRow.match,
    sport: stakeRow.sport,
    startTime: stakeRow.startTime,
    tournament: stakeRow.tournament,
    marketType: "moneyline",
    marketLabel: "1X2",
    stakeMatch: stakeRow.match,
    betOnlineMatch: betOnlineRow.match,
    stakeSide: stakeLeg.outcome,
    stakeOutcomeLabel: stakeLeg.label,
    stakeOdds: stakeLeg.odds,
    betOnlineSide: betOnlineLeg.outcome,
    betOnlineOutcomeLabel: betOnlineLeg.label,
    betOnlineOdds: betOnlineLeg.odds,
    stakeStake,
    betOnlineStake,
    totalStake,
    payout: equalPayout,
    profit,
    edgePct: (profit / totalStake) * 100,
    legs: pricedLegs,
  };
}

function buildStakeBetOnlineOpportunities(
  stakeRows: StakeWinnerOdds[],
  betOnlineRows: Array<BetOnlineBrowserOdd & { sport?: string | null; homeName?: string; awayName?: string }>,
  baseStake = 1000,
): StakeBetOnlineOpportunity[] {
  const opportunities: StakeBetOnlineOpportunity[] = [];

  for (const stakeRow of stakeRows) {
    const stakeTeams = stakeMatchTeams(stakeRow);
    if (!stakeTeams.home || !stakeTeams.away) continue;

    let bestRow: (BetOnlineBrowserOdd & { sport?: string | null; homeName?: string; awayName?: string }) | null =
      null;
    let bestScore = 0;

    for (const row of betOnlineRows) {
      // Kräv sport-matchning om vi vet bägge
      if (row.sport && stakeRow.sport && row.sport !== stakeRow.sport) continue;
      if (!isSupportedStakeBetOnlineMatch(stakeRow, row)) continue;
      if (!marketsCompatible(stakeRow, row)) continue;
      const boTeams = betOnlineMatchTeams(row);
      const homeHome = stakeBetOnlineTeamMatch(stakeTeams.home, boTeams.home);
      const awayAway = stakeBetOnlineTeamMatch(stakeTeams.away, boTeams.away);
      const homeAway = stakeBetOnlineTeamMatch(stakeTeams.home, boTeams.away);
      const awayHome = stakeBetOnlineTeamMatch(stakeTeams.away, boTeams.home);
      // Båda lagen måste matcha (samma orientering ELLER bytt orientering)
      const sameOrient = Math.min(homeHome, awayAway);
      const swapOrient = Math.min(homeAway, awayHome);
      const score = Math.max(sameOrient, swapOrient);
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }

    // Kräv minst 50 % token-överlapp på BÅDE hemma- och bortalaget.
    if (!bestRow || bestScore < 0.5) continue;

    const betOnlineRow = bestRow;
    const boTeams = betOnlineMatchTeams(betOnlineRow);
    // Avgör om BetOnline-sidan har samma orientering som Stake-sidan
    const sameOrient = Math.min(
      stakeBetOnlineTeamMatch(stakeTeams.home, boTeams.home),
      stakeBetOnlineTeamMatch(stakeTeams.away, boTeams.away),
    );
    const swapOrient = Math.min(
      stakeBetOnlineTeamMatch(stakeTeams.home, boTeams.away),
      stakeBetOnlineTeamMatch(stakeTeams.away, boTeams.home),
    );
    const teamFlipped = swapOrient > sameOrient;
    // Total over/under är inte teamspecifikt: "Över 2,5" är samma sak oavsett vem som är hemma.
    // Spread/handicap och moneyline är teamspecifika och ska följa flippen.
    const flipped = (stakeRow.marketType ?? "moneyline") === "total" ? false : teamFlipped;

    // Endast .5-linjer för spread/total: hela linjer kan ge push (refund) och kvartslinjer (.25/.75)
    // splittas i två halva bets med push på den ena. Båda bryter den enkla arb-formeln.
    const isHalfLine = (value?: number) =>
      value != null && Number.isFinite(value) && Math.abs(((value * 2) % 2) - 1) < 0.05;
    if (stakeRow.marketType === "spread") {
      if (!isHalfLine(stakeRow.line) || !isHalfLine(betOnlineRow.line)) continue;
    }
    if (stakeRow.marketType === "total") {
      if (!isHalfLine(stakeRow.line) || !isHalfLine(betOnlineRow.line)) continue;
    }

    if ((stakeRow.marketType ?? "moneyline") === "moneyline" && stakeRow.drawOdds && stakeRow.drawOdds > 1) {
      // Generera tre kombinationer som lämnar exakt en outcome på Stake (resten på BetOnline).
      // "Alla på BetOnline" är inte en cross-book arb och tas inte med.
      const threeWayCandidates = (["home", "draw", "away"] as const)
        .map((side) => buildThreeWayOpportunity(stakeRow, betOnlineRow, flipped, side, baseStake))
        .filter((item): item is StakeBetOnlineOpportunity => item !== null);
      for (const candidate of threeWayCandidates) {
        candidate.betOnlineBookSource = betOnlineRow.bookSource ?? "betonline";
      }
      opportunities.push(...threeWayCandidates);
      continue;
    }

    const boHomeOdds = flipped ? oddsValueForSide(betOnlineRow, "away") : oddsValueForSide(betOnlineRow, "home");
    const boAwayOdds = flipped ? oddsValueForSide(betOnlineRow, "home") : oddsValueForSide(betOnlineRow, "away");
    const boHomeLabel = flipped
      ? outcomeLabelForSide(betOnlineRow, "away")
      : outcomeLabelForSide(betOnlineRow, "home");
    const boAwayLabel = flipped
      ? outcomeLabelForSide(betOnlineRow, "home")
      : outcomeLabelForSide(betOnlineRow, "away");

    const combos: Array<{
      stakeSide: "home" | "away";
      stakeOdds: number;
      stakeOutcomeLabel?: string;
      betOnlineSide: "home" | "away";
      betOnlineOdds: number;
      betOnlineOutcomeLabel?: string;
    }> = [
      {
        stakeSide: "home",
        stakeOdds: stakeRow.homeOdds,
        stakeOutcomeLabel: outcomeLabelForSide(stakeRow, "home"),
        betOnlineSide: "away",
        betOnlineOdds: boAwayOdds,
        betOnlineOutcomeLabel: boAwayLabel,
      },
      {
        stakeSide: "away",
        stakeOdds: stakeRow.awayOdds,
        stakeOutcomeLabel: outcomeLabelForSide(stakeRow, "away"),
        betOnlineSide: "home",
        betOnlineOdds: boHomeOdds,
        betOnlineOutcomeLabel: boHomeLabel,
      },
    ];

    for (const combo of combos) {
      if (!(combo.stakeOdds > 1 && combo.betOnlineOdds > 1)) continue;
      const betOnlineStake = (baseStake * combo.stakeOdds) / combo.betOnlineOdds;
      const totalStake = baseStake + betOnlineStake;
      const payout = baseStake * combo.stakeOdds;
      const profit = payout - totalStake;
      opportunities.push({
        match: stakeRow.match,
        sport: stakeRow.sport,
        startTime: stakeRow.startTime,
        tournament: stakeRow.tournament,
        marketType: stakeRow.marketType ?? "moneyline",
        marketLabel: stakeRow.marketLabel ?? stakeRow.marketName,
        line: stakeRow.line,
        stakeMatch: stakeRow.match,
        betOnlineMatch: betOnlineRow.match,
        stakeSide: combo.stakeSide,
        stakeOutcomeLabel: combo.stakeOutcomeLabel,
        stakeOdds: combo.stakeOdds,
        betOnlineSide: combo.betOnlineSide,
        betOnlineOutcomeLabel: combo.betOnlineOutcomeLabel,
        betOnlineOdds: combo.betOnlineOdds,
        betOnlineBookSource: betOnlineRow.bookSource ?? "betonline",
        stakeStake: baseStake,
        betOnlineStake,
        totalStake,
        payout,
        profit,
        edgePct: (profit / totalStake) * 100,
      });
    }
  }

  const minEdgePct = Number(process.env.STAKE_BETONLINE_MIN_EDGE_PCT ?? -2);
  // Säkerhetsnät: orealistiskt höga edges är nästan säkert parser-fel
  // (olika reglementen, OT vs regulation, draw push, etc.).
  const maxEdgePct = Number(process.env.STAKE_BETONLINE_MAX_EDGE_PCT ?? 15);
  const bestByKey = new Map<string, StakeBetOnlineOpportunity>();
  for (const opportunity of opportunities) {
    if (opportunity.edgePct < minEdgePct) continue;
    if (opportunity.edgePct > maxEdgePct) continue;
    const key = opportunityKey(opportunity);
    const existing = bestByKey.get(key);
    if (!existing || opportunity.edgePct > existing.edgePct) bestByKey.set(key, opportunity);
  }

  return [...bestByKey.values()].sort((a, b) => b.edgePct - a.edgePct).slice(0, 50);
}

// ---------------------------------------------------------------------------
// Pinnacle.com publik API (https://guest.api.arcadia.pinnacle.com)
// Pinnacle har bland marknadens lägsta marginaler (~2-3 %), vilket ger oss en
// "skarp" referens som drastiskt höjer chansen att hitta bra edge mellan oss
// och Stake/BetOnline.
// ---------------------------------------------------------------------------

const PINNACLE_API_BASE = "https://guest.api.arcadia.pinnacle.com";
const PINNACLE_FETCH_HEADERS = {
  accept: "application/json",
  "x-api-key": "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R",
  origin: "https://www.pinnacle.com",
  referer: "https://www.pinnacle.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
} as const;

type PinnacleSport =
  | "soccer"
  | "basketball"
  | "tennis"
  | "ice-hockey"
  | "american-football"
  | "baseball"
  | "mma"
  | "boxing";

const PINNACLE_SPORTS: Array<{ id: number; tag: PinnacleSport }> = [
  { id: 29, tag: "soccer" },
  { id: 4, tag: "basketball" },
  { id: 33, tag: "tennis" },
  { id: 19, tag: "ice-hockey" },
  { id: 15, tag: "american-football" },
  { id: 3, tag: "baseball" },
  { id: 22, tag: "mma" },
  { id: 6, tag: "boxing" },
];

type PinnacleParticipant = {
  alignment?: "home" | "away" | "neutral";
  name?: string;
  order?: number;
  id?: number;
};

type PinnacleMatchup = {
  id: number;
  startTime?: string;
  isLive?: boolean;
  hasMarkets?: boolean;
  league?: { id?: number; name?: string };
  participants?: PinnacleParticipant[];
  parent?: PinnacleMatchup;
  type?: string;
  units?: string;
};

type PinnacleMarket = {
  matchupId?: number;
  type?: "moneyline" | "spread" | "total" | "team_total";
  key?: string;
  period?: number;
  isAlternate?: boolean;
  status?: string;
  prices?: Array<{
    participantId?: number;
    designation?: "home" | "away" | "draw" | "over" | "under";
    price: number;
    points?: number;
  }>;
};

function americanToDecimalFromPrice(price: number) {
  if (!Number.isFinite(price) || price === 0) return 0;
  return price > 0 ? 1 + price / 100 : 1 + 100 / Math.abs(price);
}

async function fetchPinnacleJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${PINNACLE_API_BASE}${path}`, {
      headers: PINNACLE_FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type PinnacleProbeResult = {
  url: string;
  ok: boolean;
  status: number | null;
  bodyLen: number | null;
  contentType: string | null;
  errorName: string | null;
  errorMsg: string | null;
  sampleBody: string | null;
};

async function probePinnacleEndpoint(
  base: string,
  origin: string,
): Promise<PinnacleProbeResult> {
  const url = `${base}/0.1/sports/29/matchups`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { ...PINNACLE_FETCH_HEADERS, origin, referer: `${origin}/` },
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      url,
      ok: response.ok,
      status: response.status,
      bodyLen: body.length,
      contentType: response.headers.get("content-type"),
      errorName: null,
      errorMsg: null,
      sampleBody: body.slice(0, 160),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      bodyLen: null,
      contentType: null,
      errorName: error instanceof Error ? error.name : "unknown",
      errorMsg: error instanceof Error ? error.message : String(error),
      sampleBody: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Diagnostik: probea både .com och .se så vi vet vilken Render-IP:n kan nå. */
async function pinnacleProbe(): Promise<PinnacleProbeResult[]> {
  return Promise.all([
    probePinnacleEndpoint("https://guest.api.arcadia.pinnacle.com", "https://www.pinnacle.com"),
    probePinnacleEndpoint("https://guest.api.arcadia.pinnacle.se", "https://www.pinnacle.se"),
  ]);
}

/** Diagnostik: rapportera workerns disk-cache (existerar, ålder, summary). */
function pinnacleDiskProbe(): {
  path: string;
  exists: boolean;
  ageMs: number | null;
  updatedAt: string | null;
  summary: Record<string, unknown> | null;
  errorMsg: string | null;
} {
  try {
    if (!fs.existsSync(PINNACLE_RAW_CACHE_FILE)) {
      return { path: PINNACLE_RAW_CACHE_FILE, exists: false, ageMs: null, updatedAt: null, summary: null, errorMsg: null };
    }
    const raw = fs.readFileSync(PINNACLE_RAW_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as {
      updatedAt?: string;
      summary?: Record<string, unknown>;
    };
    const updatedMs = parsed.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    return {
      path: PINNACLE_RAW_CACHE_FILE,
      exists: true,
      ageMs: Number.isFinite(updatedMs) ? Date.now() - updatedMs : null,
      updatedAt: parsed.updatedAt ?? null,
      summary: parsed.summary ?? null,
      errorMsg: null,
    };
  } catch (error) {
    return {
      path: PINNACLE_RAW_CACHE_FILE,
      exists: false,
      ageMs: null,
      updatedAt: null,
      summary: null,
      errorMsg: error instanceof Error ? error.message : String(error),
    };
  }
}

type PinnacleRow = {
  source: "pinnacle";
  sport: PinnacleSport;
  match: string;
  startTime?: number;
  tournament?: string;
  homeName?: string;
  awayName?: string;
  homeOdds: number;
  awayOdds: number;
  drawOdds?: number;
  /** Pinnacle max-insats (likviditet) för marknaden. undefined om okänd. */
  limit?: number;
  marketType: "moneyline" | "spread" | "total";
  marketLabel: string;
  marketName?: string;
  line?: number;
  homeLine?: number;
  awayLine?: number;
  homeOutcomeLabel?: string;
  awayOutcomeLabel?: string;
  drawOutcomeLabel?: string;
  matchupId?: number;
};

function pinnaclePeriodLabel(_sport: PinnacleSport, period: number): string | null {
  if (period === 0) return null;
  if (period === 1) return "1H";
  if (period === 2) return "2H";
  return null;
}

function buildPinnacleRowsFromSport(
  sport: PinnacleSport,
  matchups: PinnacleMatchup[],
  markets: PinnacleMarket[],
  includeAhTotals = false,
): PinnacleRow[] {
  const matchupById = new Map<number, PinnacleMatchup>();
  for (const matchup of matchups ?? []) {
    if (matchup?.id) matchupById.set(matchup.id, matchup);
  }

  // För soccer behöver vi även matchhuvudet (parent) eftersom 1X2/draw ligger där.
  // För övriga sporter använder vi direkt huvudmatchupen.
  const fullGameMarkets = (markets ?? []).filter((market) => market?.period === 0);

  const groupedByMatchup = new Map<number, PinnacleMarket[]>();
  for (const market of fullGameMarkets) {
    if (typeof market.matchupId !== "number") continue;
    if (!groupedByMatchup.has(market.matchupId)) groupedByMatchup.set(market.matchupId, []);
    groupedByMatchup.get(market.matchupId)!.push(market);
  }

  const rows: PinnacleRow[] = [];

  for (const [matchupId, marketList] of groupedByMatchup) {
    const matchup = matchupById.get(matchupId);
    if (!matchup) continue;
    if (matchup.isLive) continue;
    const participants = (matchup.participants ?? []).filter(
      (participant) => participant?.alignment !== "neutral",
    );
    const home = participants.find((p) => p.alignment === "home");
    const away = participants.find((p) => p.alignment === "away");
    if (!home?.name || !away?.name) continue;

    const matchName = `${home.name} - ${away.name}`;
    const startTime = matchup.startTime ? Date.parse(matchup.startTime) : undefined;
    if (startTime && startTime <= Date.now()) continue;

    const tournament = matchup.league?.name;
    const baseRow = {
      source: "pinnacle" as const,
      sport,
      match: matchName,
      startTime: startTime && Number.isFinite(startTime) ? startTime : undefined,
      tournament,
      homeName: home.name,
      awayName: away.name,
      matchupId,
    };

    for (const market of marketList) {
      if (market.status && market.status !== "open") continue;
      if (market.isAlternate) continue;
      // Spread/total skiljer sig mellan bookmakers (regulation vs incl. OT, draw push m.m.)
      // vilket lätt skapar falska arbitrage. Default: bara moneyline. AH/totals
      // parsas BARA när includeAhTotals=true (read-only sharp-lines-referens, #9) —
      // de auto-genererar ALDRIG valuebets (ingen falsk +EV).
      if (!includeAhTotals && market.type !== "moneyline") continue;
      const prices = market.prices ?? [];
      const byDesignation = (designation: string) =>
        prices.find((price) => price.designation === designation);

      if (market.type === "moneyline") {
        const homePrice = byDesignation("home");
        const awayPrice = byDesignation("away");
        if (!homePrice || !awayPrice) continue;
        const homeDecimal = americanToDecimalFromPrice(homePrice.price);
        const awayDecimal = americanToDecimalFromPrice(awayPrice.price);
        if (!(homeDecimal > 1 && awayDecimal > 1)) continue;
        const drawPrice = sport === "soccer" ? byDesignation("draw") : undefined;
        const drawDecimal = drawPrice ? americanToDecimalFromPrice(drawPrice.price) : undefined;
        const mlLimit = (() => {
          const l = (market as { limit?: number | null }).limit;
          return typeof l === "number" && Number.isFinite(l) && l > 0 ? l : undefined;
        })();
        rows.push({
          ...baseRow,
          homeOdds: homeDecimal,
          awayOdds: awayDecimal,
          drawOdds: drawDecimal && drawDecimal > 1 ? drawDecimal : undefined,
          drawOutcomeLabel: drawDecimal && drawDecimal > 1 ? "Oavgjort" : undefined,
          marketType: "moneyline",
          marketLabel: drawDecimal && drawDecimal > 1 ? "1X2" : "Moneyline",
          marketName: "Moneyline",
          limit: mlLimit,
        });
      } else if (market.type === "spread") {
        const homePrice = byDesignation("home");
        const awayPrice = byDesignation("away");
        if (!homePrice || !awayPrice) continue;
        const homeDecimal = americanToDecimalFromPrice(homePrice.price);
        const awayDecimal = americanToDecimalFromPrice(awayPrice.price);
        if (!(homeDecimal > 1 && awayDecimal > 1)) continue;
        const homeLine = Number(homePrice.points);
        const awayLine = Number(awayPrice.points);
        if (!Number.isFinite(homeLine) || !Number.isFinite(awayLine)) continue;
        if (Math.abs(homeLine + awayLine) > 0.05) continue;
        const formattedHome = formatLineSigned(homeLine);
        const formattedAway = formatLineSigned(awayLine);
        rows.push({
          ...baseRow,
          homeOdds: homeDecimal,
          awayOdds: awayDecimal,
          homeLine,
          awayLine,
          line: Math.abs(homeLine),
          homeOutcomeLabel: `${home.name} ${formattedHome}`,
          awayOutcomeLabel: `${away.name} ${formattedAway}`,
          marketType: "spread",
          marketLabel: `Spread ${Math.abs(homeLine).toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
          marketName: "Spread",
        });
      } else if (market.type === "total") {
        const overPrice = byDesignation("over");
        const underPrice = byDesignation("under");
        if (!overPrice || !underPrice) continue;
        const overDecimal = americanToDecimalFromPrice(overPrice.price);
        const underDecimal = americanToDecimalFromPrice(underPrice.price);
        if (!(overDecimal > 1 && underDecimal > 1)) continue;
        const line = Number(overPrice.points ?? underPrice.points);
        if (!Number.isFinite(line)) continue;
        const formattedLine = line.toLocaleString("sv-SE", { maximumFractionDigits: 2 });
        rows.push({
          ...baseRow,
          homeOdds: overDecimal,
          awayOdds: underDecimal,
          line,
          homeOutcomeLabel: `Över ${formattedLine}`,
          awayOutcomeLabel: `Under ${formattedLine}`,
          marketType: "total",
          marketLabel: `Total ${formattedLine}`,
          marketName: "Total",
        });
      }
    }
  }

  return rows;
}

function formatLineSigned(value: number) {
  const abs = Math.abs(value).toLocaleString("sv-SE", { maximumFractionDigits: 2 });
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return "0";
}

// Sänkt 90s → 5s 2026-05-12 för snabbare drop-detection. Pinnacle-workflow:n
// pushar ~var 1-2 min, så 5s TTL ger oss minimal latency efter ny push utan
// att slå i GitHub API rate-limit (PAT: 5000 req/h, vi gör ~720/h).
const PINNACLE_CACHE_TTL_MS = 5 * 1000;
const pinnacleRowsCache = new Map<string, { expiresAt: number; rows: PinnacleRow[] }>();
let pinnacleRowsInflight: Promise<PinnacleRow[]> | null = null;

async function fetchPinnacleSportRows(sportId: number, sportTag: PinnacleSport): Promise<PinnacleRow[]> {
  const [matchups, markets] = await Promise.all([
    fetchPinnacleJson<PinnacleMatchup[]>(`/0.1/sports/${sportId}/matchups`),
    fetchPinnacleJson<PinnacleMarket[]>(`/0.1/sports/${sportId}/markets/straight`),
  ]);
  if (!matchups || !markets) return [];
  return buildPinnacleRowsFromSport(sportTag, matchups, markets);
}

// ---------------------------------------------------------------------------
// Best-line per utfall över alla bookmakers
// För varje fixture+marknad: hämta bästa pris för varje utfall (home/draw/away
// eller over/under) från valfri bokmakare. Detta är den enda algoritmen som
// realistiskt ger edges nära/över 0 % när alla bookmakers har egen marginal.
// ---------------------------------------------------------------------------

type RightSideRow = BetOnlineRowFromCache & { bookSource?: "betonline" | "pinnacle" };
type BookSource = "stake" | "betonline" | "pinnacle";

function rowMarketKey(row: { match: string; marketType?: string; line?: number; homeLine?: number; drawOdds?: number; drawDecimal?: number }) {
  const mt = row.marketType ?? "moneyline";
  const isThreeWay = mt === "moneyline" && Boolean((row.drawOdds ?? row.drawDecimal ?? 0) > 1);
  return [
    normalizeStakeBetOnlineMatchName(row.match),
    mt,
    row.line != null ? Math.round(row.line * 10) / 10 : "",
    row.homeLine != null ? Math.round(row.homeLine * 10) / 10 : "",
    isThreeWay ? "1x2" : "2way",
  ].join("|");
}

function teamFingerprint(row: { homeName?: string; awayName?: string; match: string }) {
  const home = row.homeName ?? row.match.split(" - ")[0] ?? "";
  const away = row.awayName ?? row.match.split(" - ").slice(-1)[0] ?? "";
  return { home: stakeBetOnlineTeamTokens(home), away: stakeBetOnlineTeamTokens(away) };
}

function teamMatchScore(a: { home: Set<string>; away: Set<string> }, b: { home: Set<string>; away: Set<string> }) {
  const sameOrient = Math.min(
    a.home.size > 0 && b.home.size > 0 ? [...a.home].filter((t) => b.home.has(t)).length / Math.min(a.home.size, b.home.size) : 0,
    a.away.size > 0 && b.away.size > 0 ? [...a.away].filter((t) => b.away.has(t)).length / Math.min(a.away.size, b.away.size) : 0,
  );
  const swapOrient = Math.min(
    a.home.size > 0 && b.away.size > 0 ? [...a.home].filter((t) => b.away.has(t)).length / Math.min(a.home.size, b.away.size) : 0,
    a.away.size > 0 && b.home.size > 0 ? [...a.away].filter((t) => b.home.has(t)).length / Math.min(a.away.size, b.home.size) : 0,
  );
  return { score: Math.max(sameOrient, swapOrient), flipped: swapOrient > sameOrient };
}

function buildBestLineOpportunities(
  stakeRows: StakeWinnerOdds[],
  betOnlineRows: RightSideRow[],
  pinnacleRows: RightSideRow[],
  baseStake = 1000,
): StakeBetOnlineOpportunity[] {
  const opportunities: StakeBetOnlineOpportunity[] = [];

  for (const stakeRow of stakeRows) {
    const stakeMarketType = stakeRow.marketType ?? "moneyline";
    if (stakeMarketType !== "moneyline") continue; // best-line endast för moneyline tills vidare
    const stakeIsThreeWay = !!(stakeRow.drawOdds && stakeRow.drawOdds > 1);
    const stakeFp = teamFingerprint({
      homeName: stakeRow.homeName,
      awayName: stakeRow.awayName,
      match: stakeRow.match,
    });
    if (stakeFp.home.size === 0 || stakeFp.away.size === 0) continue;

    const findBestMatch = (pool: RightSideRow[]) => {
      let best: { row: RightSideRow; flipped: boolean; score: number } | null = null;
      for (const row of pool) {
        if (row.sport && stakeRow.sport && row.sport !== stakeRow.sport) continue;
        if (!isSupportedStakeBetOnlineMatch(stakeRow, row)) continue;
        const rowIsThreeWay = !!(row.drawDecimal && row.drawDecimal > 1);
        if ((row.marketType ?? "moneyline") !== "moneyline") continue;
        if (rowIsThreeWay !== stakeIsThreeWay) continue;
        const fp = teamFingerprint({ homeName: row.homeName, awayName: row.awayName, match: row.match });
        if (fp.home.size === 0 || fp.away.size === 0) continue;
        const { score, flipped } = teamMatchScore(stakeFp, fp);
        if (score < 0.5) continue;
        if (!best || score > best.score) best = { row, flipped, score };
      }
      return best;
    };

    const boBest = findBestMatch(betOnlineRows);
    const pinBest = findBestMatch(pinnacleRows);
    if (!boBest && !pinBest) continue;

    type LegOption = { book: BookSource; outcome: "home" | "draw" | "away"; odds: number; label: string };

    const collectOptions = (outcome: "home" | "draw" | "away"): LegOption[] => {
      const options: LegOption[] = [];

      // Stake leg
      let stakeOdds: number | undefined;
      let stakeLabel = "";
      if (outcome === "home") {
        stakeOdds = stakeRow.homeOdds;
        stakeLabel = outcomeLabelForSide(stakeRow, "home");
      } else if (outcome === "away") {
        stakeOdds = stakeRow.awayOdds;
        stakeLabel = outcomeLabelForSide(stakeRow, "away");
      } else if (stakeIsThreeWay) {
        stakeOdds = stakeRow.drawOdds;
        stakeLabel = outcomeLabelForSide(stakeRow, "draw");
      }
      if (stakeOdds && stakeOdds > 1) options.push({ book: "stake", outcome, odds: stakeOdds, label: stakeLabel || (outcome === "draw" ? "Oavgjort" : outcome) });

      const pushFromMatch = (match: { row: RightSideRow; flipped: boolean }, book: BookSource) => {
        const row = match.row;
        if (outcome === "draw") {
          const draw = drawOddsValue(row);
          if (!(draw > 1)) return;
          options.push({ book, outcome, odds: draw, label: outcomeLabelForSide(row, "draw") });
          return;
        }
        const effectiveSide = match.flipped ? (outcome === "home" ? "away" : "home") : outcome;
        const odds = oddsValueForSide(row, effectiveSide);
        if (!(odds > 1)) return;
        const label = outcomeLabelForSide(row, effectiveSide);
        options.push({ book, outcome, odds, label });
      };

      if (boBest) pushFromMatch(boBest, "betonline");
      if (pinBest) pushFromMatch(pinBest, "pinnacle");

      return options;
    };

    const outcomes: Array<"home" | "draw" | "away"> = stakeIsThreeWay
      ? ["home", "draw", "away"]
      : ["home", "away"];
    const bestPerOutcome = outcomes.map((outcome) => {
      const options = collectOptions(outcome);
      if (options.length === 0) return null;
      return options.reduce((best, current) => (current.odds > best.odds ? current : best));
    });
    if (bestPerOutcome.some((o) => !o)) continue;
    const legs = bestPerOutcome.filter((o): o is LegOption => Boolean(o));
    // Måste involvera Stake — annars är det inte en "Stake & BetOnline"-strategi.
    if (!legs.some((leg) => leg.book === "stake")) continue;
    const invSum = legs.reduce((sum, leg) => sum + 1 / leg.odds, 0);
    if (!(invSum > 0)) continue;
    const equalPayout = baseStake / invSum;
    const totalStake = baseStake;
    const profit = equalPayout - totalStake;
    const edgePct = (profit / totalStake) * 100;
    if (edgePct < -2) continue;
    if (edgePct > 15) continue;

    const pricedLegs: StakeBetOnlineLeg[] = legs.map((leg) => {
      const stake = equalPayout / leg.odds;
      return {
        book: leg.book === "pinnacle" ? "pinnacle" : leg.book,
        outcome: leg.outcome,
        label: leg.label,
        odds: leg.odds,
        stake,
        payout: equalPayout,
        result: equalPayout - totalStake,
      };
    });

    const stakeLeg = pricedLegs.find((leg) => leg.book === "stake") ?? pricedLegs[0];
    const otherLeg = pricedLegs.find((leg) => leg.book !== "stake") ?? pricedLegs[1] ?? pricedLegs[0];
    const stakeStakeAmount = pricedLegs
      .filter((leg) => leg.book === "stake")
      .reduce((sum, leg) => sum + leg.stake, 0);
    const otherStakeAmount = pricedLegs
      .filter((leg) => leg.book !== "stake")
      .reduce((sum, leg) => sum + leg.stake, 0);

    const matchedBetOnlineRow = boBest?.row;
    const matchedPinnacleRow = pinBest?.row;
    const otherBookSource: "betonline" | "pinnacle" =
      otherLeg.book === "pinnacle" ? "pinnacle" : "betonline";
    const opportunityMatchName =
      matchedPinnacleRow?.match ?? matchedBetOnlineRow?.match ?? stakeRow.match;

    opportunities.push({
      match: stakeRow.match,
      sport: stakeRow.sport,
      startTime: stakeRow.startTime,
      tournament: stakeRow.tournament,
      marketType: "moneyline",
      marketLabel: stakeIsThreeWay ? "1X2" : "Moneyline",
      stakeMatch: stakeRow.match,
      betOnlineMatch: opportunityMatchName,
      stakeSide: stakeLeg.outcome,
      stakeOutcomeLabel: stakeLeg.label,
      stakeOdds: stakeLeg.odds,
      betOnlineSide: otherLeg.outcome,
      betOnlineOutcomeLabel: otherLeg.label,
      betOnlineOdds: otherLeg.odds,
      stakeStake: stakeStakeAmount,
      betOnlineStake: otherStakeAmount,
      totalStake,
      payout: equalPayout,
      profit,
      edgePct,
      betOnlineBookSource: otherBookSource,
      legs: pricedLegs,
    });
  }

  return opportunities;
}

function pinnacleRowsAsBetOnlineRows(rows: PinnacleRow[]): BetOnlineRowFromCache[] {
  return rows.map((row) => ({
    raw: `${row.awayName ?? "Away"} @ ${row.homeName ?? "Home"} (Pinnacle ${row.marketLabel})`,
    match: row.match,
    sport: row.sport,
    homeName: row.homeName,
    awayName: row.awayName,
    homeAmerican: 0,
    awayAmerican: 0,
    homeDecimal: row.homeOdds,
    awayDecimal: row.awayOdds,
    drawDecimal: row.drawOdds,
    homeLine: row.homeLine,
    awayLine: row.awayLine,
    line: row.line,
    homeOutcomeLabel: row.homeOutcomeLabel,
    awayOutcomeLabel: row.awayOutcomeLabel,
    drawOutcomeLabel: row.drawOutcomeLabel,
    marketType: row.marketType,
    marketLabel: row.marketLabel,
    bookSource: "pinnacle",
  }));
}

/**
 * Läs Pinnacle-rådata. På Render blockerar Cloudflare WAF Render-IP:n både för
 * direkt fetch och Playwright-stealth (ASN-baserat block). Vår fungerande lösning
 * är GitHub Actions: workflow:n .github/workflows/pinnacle-fetch.yml kör
 * scripts/fetch-pinnacle-github-action.mjs på Azure-runners (passerar Cloudflare),
 * commit:ar `data/pinnacle-rows.json` tillbaka till repot, och Render hämtar via
 * raw.githubusercontent.com.
 */
const PINNACLE_RAW_CACHE_FILE = path.resolve(
  process.cwd(),
  ".matched-betting-cache",
  "pinnacle-rows.json",
);
const PINNACLE_DATA_FILE = path.resolve(process.cwd(), "data", "pinnacle-rows.json");
/**
 * GitHub API contents endpoint är primär källa eftersom raw.githubusercontent.com
 * cachas av Fastly i 5 minuter (Cache-Control: max-age=300), vilket lade till
 * ~5 min lag mellan commits och Render-instansens vy. API endpoint har ingen
 * Fastly-cache med max-age=300.
 *
 * Anonym rate limit: 60 req/h. Vi gör ~40 req/h (en per ~90s in-memory cache miss),
 * så vi ryms inom limiten.
 */
const PINNACLE_GITHUB_API_URL =
  process.env.PINNACLE_GITHUB_API_URL ??
  "https://api.github.com/repos/Lilgunner24/linusgan/contents/data/pinnacle-rows.json?ref=main";
/** Fallback om GitHub API failar/rate-limitar — raw URL har 5-min CDN-cache men funkar ändå. */
const PINNACLE_RAW_GITHUB_URL =
  process.env.PINNACLE_RAW_URL ??
  "https://raw.githubusercontent.com/Lilgunner24/linusgan/main/data/pinnacle-rows.json";
/** Disken anses användbar i 60 min. GitHub Actions uppdaterar var ~30 min. */
const PINNACLE_DISK_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * TTL för in-memory cache av GitHub-fetchen. Sänkt 60s → 5s 2026-05-12
 * för POD-strategin (snabbare drop-detection). Vi gör då ~720 GitHub-API
 * requests/h från Render — well under PAT-limit 5000/h.
 *
 * Workflow pushar var ~1-2 min, så 5s TTL betyder att nya data syns på
 * Render inom 5s efter att GitHub-snapshotet uppdaterats.
 */
const PINNACLE_GITHUB_CACHE_TTL_MS = 5 * 1000;
/**
 * Strikt freshness-tröskel: värdebets visas bara om Pinnacle-data är yngre än denna.
 * Sänker risk för "false positive" valuebets baserade på odds som hunnit flyttas.
 * Mål: aldrig falska valuebets — hellre 0 än stale baseline.
 *
 * Historik: höjdes 2026-05-13 från 5 → 10 min för att tolerera GitHub Actions-
 * workflowens commit-cadens (~90-120s) utan att gate-utlösa i onödan.
 * Sänkt 2026-06-18 till 3 min på uttrycklig begäran: strängare EV-säkerhet väger
 * tyngre än enstaka bortfall. Konsekvens: om Pinnacle-datan är >3 min gammal
 * (t.ex. några missade workflow-tickar) döljs value bets tills färsk data finns.
 * Eftersom denna konstant skickas till klienten (pinnacleFreshnessThresholdMs)
 * styr den BÅDE serverns gate OCH webbläsarens färskhetsvakt — en sanning.
 */
// CONFIG-DRIVEN (system_config, fas 0): `let` så refreshAnalyticsConfigFromDb() kan
// uppdatera utan omstart. Init = DEFAULT_ANALYTICS_CONFIG = de gamla 3 min → oförändrat.
let PINNACLE_FRESHNESS_THRESHOLD_MS = DEFAULT_ANALYTICS_CONFIG.pinnacleFreshnessThresholdMs;
// SHARP-KOMPLEMENT (SBOBET/Betfair) blandas in i valuebets-fair-price ENBART om de
// är färskare än detta — stale sharp exkluderas helt (skapar då inga falska
// valuebets). 3 min = samma hårda grind som Pinnacle. VALUEBETS_SHARP_BLEND=0
// stänger av inblandningen helt (kill-switch utan kodändring).
let SHARP_FRESHNESS_THRESHOLD_MS = DEFAULT_ANALYTICS_CONFIG.sharpFreshnessThresholdMs;
const SHARP_BLEND_ENABLED = process.env.VALUEBETS_SHARP_BLEND !== "0";
/**
 * Om disk-fil är äldre än denna, försök GitHub raw först (i fall workflow:n hunnit
 * pusha ny fil mellan deploy-checkout och nu).
 */
const PINNACLE_PREFER_GITHUB_AFTER_MS = 2 * 60 * 1000;

/**
 * KRITISKT (2026-06-11): Live direkt-fetch mot Pinnacles API får ALDRIG köras i
 * produktion (Render). Två skäl:
 *   1. Render-datacenter-IP:n kan få en EDGE-CACHAD/stale linje från Pinnacles
 *      CDN (Cloudflare 403:ar inte alltid — när den släpper igenom kan svaret
 *      vara en gammal linje, t.ex. 2.00, medan den verkliga linjen är 2.16).
 *   2. Live-grenen stämplar updatedAt = now, så den ser ALLTID färsk ut och går
 *      förbi PINNACLE_FRESHNESS_THRESHOLD-gaten — och väljs FÖRE den auktoritativa
 *      scrapade datan (DB→disk→GitHub).
 * Resultat (observerat): appen visade Pinnacle 2.00 för Frayles de Guasave och
 * en falsk +7.62% EV, fast scrapad+verklig linje var 2.16 (= verklig EV −0.4%).
 * Den hårdade scrapern (egen stealth/headers, det vi verifierar mot riktiga
 * sajten) är auktoritativ. Live-fetch används BARA lokalt/dev där ingen scraper
 * och ingen DB finns. Sätt PINNACLE_ALLOW_LIVE_FETCH=true för att tvinga på.
 */
const PINNACLE_LIVE_FETCH_ENABLED =
  process.env.PINNACLE_ALLOW_LIVE_FETCH === "true" ||
  (process.env.NODE_ENV !== "production" && process.env.RENDER !== "true");

let pinnacleGithubInflight: Promise<unknown> | null = null;
let pinnacleGithubCachedAt = 0;
let pinnacleGithubCachedPayload: {
  updatedAt?: string;
  bySport?: Record<
    string,
    { sportId: number; ok: boolean; matchups: PinnacleMatchup[]; markets: PinnacleMarket[] }
  >;
} | null = null;

type PinnaclePayload = {
  updatedAt?: string;
  bySport?: Record<
    string,
    { sportId: number; ok: boolean; matchups: PinnacleMatchup[]; markets: PinnacleMarket[] }
  >;
};

/** Senaste fetch-källa, för logging och status. */
let pinnacleLastFetchSource: "github-api" | "github-raw" | null = null;

async function fetchPinnacleFromGithub(): Promise<PinnaclePayload | null> {
  const now = Date.now();
  if (pinnacleGithubCachedPayload && now - pinnacleGithubCachedAt < PINNACLE_GITHUB_CACHE_TTL_MS) {
    return pinnacleGithubCachedPayload;
  }
  if (pinnacleGithubInflight) return pinnacleGithubInflight as Promise<PinnaclePayload | null>;

  const tryFetch = async (
    url: string,
    label: "github-api" | "github-raw",
    extraHeaders: Record<string, string> = {},
  ): Promise<PinnaclePayload | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "matched-betting-render",
          ...extraHeaders,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        const reset = response.headers.get("x-ratelimit-reset");
        console.warn(
          `[pinnacle] ${label} HTTP ${response.status}${
            remaining ? ` (rate-limit remaining=${remaining}, reset=${reset})` : ""
          }`,
        );
        return null;
      }
      const data = (await response.json()) as PinnaclePayload;
      console.log(
        `[pinnacle] hämtade från ${label} (updatedAt=${data?.updatedAt ?? "okänt"})`,
      );
      return data;
    } catch (error) {
      console.warn(
        `[pinnacle] ${label} fetch failed:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const promise = (async () => {
    // Prio 1: GitHub API contents (ingen Fastly 5-min CDN-cache).
    // Om GITHUB_TOKEN-env-var är satt höjs rate-limit från 60→5000 req/h,
    // vilket eliminerar de stale-perioder vi sett när Render-IP delas.
    const apiHeaders: Record<string, string> = {
      Accept: "application/vnd.github.raw+json",
    };
    if (process.env.GITHUB_TOKEN) {
      apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    let data = await tryFetch(PINNACLE_GITHUB_API_URL, "github-api", apiHeaders);
    if (data) {
      pinnacleLastFetchSource = "github-api";
    } else {
      // Fallback: raw URL (har Fastly 5-min cache men fungerar vid API rate-limit)
      data = await tryFetch(PINNACLE_RAW_GITHUB_URL, "github-raw");
      if (data) pinnacleLastFetchSource = "github-raw";
    }
    if (data) {
      pinnacleGithubCachedPayload = data;
      pinnacleGithubCachedAt = Date.now();
    }
    return data;
  })().finally(() => {
    pinnacleGithubInflight = null;
  });
  pinnacleGithubInflight = promise;
  return promise;
}

/**
 * GET /api/admin/source-tolerance — visar varje källas INLÄRDA polling-tolerans
 * (finaste hämttakt som höll sig frisk) från den committade tolerans-filen.
 * Läser i första hand från GitHub raw (alltid senaste), faller tillbaka på den
 * lokala checkouten. Admin-gateas av adminOnlyMiddleware (/api/admin/*).
 */
async function sourceToleranceApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/admin/source-tolerance") { next(); return; }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  try {
    const repo = (process.env.GITHUB_REPOSITORY || "lilgunner24/linusgan").trim();
    let data: unknown = null;
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/data/source-tolerance.json`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "oddexus-admin" },
      });
      if (r.ok) data = await r.json();
    } catch { /* fall tillbaka på lokal fil */ }
    if (!data) {
      try {
        const p = path.resolve(process.cwd(), "data/source-tolerance.json");
        if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch { /* saknas ännu */ }
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, found: !!data, ...((data as Record<string, unknown>) ?? { sources: {} }) }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}

function pinnaclePayloadToRows(parsed: {
  bySport?: Record<
    string,
    { sportId: number; ok: boolean; matchups: PinnacleMatchup[]; markets: PinnacleMarket[] }
  >;
}, includeAhTotals = false): PinnacleRow[] {
  const all: PinnacleRow[] = [];
  for (const sport of PINNACLE_SPORTS) {
    const entry = parsed.bySport?.[sport.tag];
    if (!entry || !Array.isArray(entry.matchups) || !Array.isArray(entry.markets)) continue;
    try {
      const rows = buildPinnacleRowsFromSport(sport.tag, entry.matchups, entry.markets, includeAhTotals);
      all.push(...rows);
    } catch (error) {
      console.warn(
        `[pinnacle] parse failed for ${sport.tag}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return all;
}

// FAS #9 — Läs Pinnacle AH (spread) + totals från råpayloaden (opt-in-parse).
// Read-only referens: vi auto-genererar ALDRIG valuebets på dessa (reglemente
// kan skilja mellan böcker → falsk +EV-risk). Bara sharp no-vig-linjer att titta på.
function loadPinnacleAhTotalsRows(): { rows: PinnacleRow[]; updatedAt: string | null } {
  for (const file of [PINNACLE_DATA_FILE, PINNACLE_RAW_CACHE_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        updatedAt?: string;
        bySport?: Record<string, { sportId: number; ok: boolean; matchups: PinnacleMatchup[]; markets: PinnacleMarket[] }>;
      };
      const rows = pinnaclePayloadToRows(parsed, true).filter((r) => r.marketType === "spread" || r.marketType === "total");
      if (rows.length > 0) return { rows, updatedAt: parsed.updatedAt ?? null };
    } catch { /* nästa fil */ }
  }
  return { rows: [], updatedAt: null };
}

/** Bygg per-match sharp-linjer: huvud-AH + huvud-total med no-vig fair odds. */
function getPinnacleSharpLines(hoursWindow: number) {
  const { rows, updatedAt } = loadPinnacleAhTotalsRows();
  const now = Date.now();
  const horizon = now + hoursWindow * 3600_000;
  const noVig2 = (a: number, b: number) => {
    const r1 = a > 1 ? 1 / a : 0, r2 = b > 1 ? 1 / b : 0;
    const s = r1 + r2;
    if (s <= 0) return null;
    return { aFair: 1 / (r1 / s), bFair: 1 / (r2 / s), vigPct: (s - 1) * 100 };
  };
  type Line = {
    match: string; sport?: string; league?: string; startTs: string | null;
    spread: { line?: number; homeLabel?: string; awayLabel?: string; homeOdds: number; awayOdds: number; homeFairOdds: number | null; awayFairOdds: number | null; vigPct: number | null } | null;
    total: { line?: number; overOdds: number; underOdds: number; overFairOdds: number | null; underFairOdds: number | null; vigPct: number | null } | null;
  };
  const byMatch = new Map<string, Line>();
  for (const r of rows) {
    if (r.startTime && (r.startTime <= now || r.startTime > horizon)) continue;
    let m = byMatch.get(r.match);
    if (!m) {
      m = { match: r.match, sport: r.sport, league: r.tournament, startTs: r.startTime ? new Date(r.startTime).toISOString() : null, spread: null, total: null };
      byMatch.set(r.match, m);
    }
    if (r.marketType === "spread" && !m.spread) {
      const nv = noVig2(r.homeOdds, r.awayOdds);
      m.spread = { line: r.line, homeLabel: r.homeOutcomeLabel, awayLabel: r.awayOutcomeLabel, homeOdds: r.homeOdds, awayOdds: r.awayOdds, homeFairOdds: nv?.aFair ?? null, awayFairOdds: nv?.bFair ?? null, vigPct: nv?.vigPct ?? null };
    } else if (r.marketType === "total" && !m.total) {
      const nv = noVig2(r.homeOdds, r.awayOdds);
      m.total = { line: r.line, overOdds: r.homeOdds, underOdds: r.awayOdds, overFairOdds: nv?.aFair ?? null, underFairOdds: nv?.bFair ?? null, vigPct: nv?.vigPct ?? null };
    }
  }
  const matches = [...byMatch.values()]
    .filter((m) => m.spread || m.total)
    .sort((a, b) => (a.startTs && b.startTs ? Date.parse(a.startTs) - Date.parse(b.startTs) : 0));
  return { generatedAt: now, updatedAt, count: matches.length, matches };
}

type PinnacleSource = "live" | "db" | "disk" | "github-api" | "github-raw" | "cache" | "empty";
type PinnacleLoadResult = {
  rows: PinnacleRow[];
  updatedAt: string | null;
  source: PinnacleSource;
};

function loadPinnacleRowsFromDiskWithMeta(): PinnacleLoadResult {
  // Prio: data/pinnacle-rows.json (committad av GitHub Actions). Föll tidigare även
  // tillbaka på .matched-betting-cache/ — vi tar bort den fallbacken eftersom den
  // alltid är äldre än Git-checkout och förvirrar freshness-bedömningen.
  for (const file of [PINNACLE_DATA_FILE, PINNACLE_RAW_CACHE_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        updatedAt?: string;
        bySport?: Record<
          string,
          { sportId: number; ok: boolean; matchups: PinnacleMatchup[]; markets: PinnacleMarket[] }
        >;
      };
      const updatedAt = parsed.updatedAt ?? null;
      const updatedMs = parsed.updatedAt ? Date.parse(parsed.updatedAt) : 0;
      if (Number.isFinite(updatedMs) && Date.now() - updatedMs > PINNACLE_DISK_MAX_AGE_MS) {
        console.warn(
          `[pinnacle] ${file} är ${Math.round((Date.now() - updatedMs) / 60_000)} min gammal — fortsätter ändå.`,
        );
      }
      const rows = pinnaclePayloadToRows(parsed);
      if (rows.length > 0) return { rows, updatedAt, source: "disk" };
    } catch (error) {
      console.warn(
        `[pinnacle] ${file} read failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { rows: [], updatedAt: null, source: "empty" };
}

async function loadPinnacleRowsFromGithubWithMeta(): Promise<PinnacleLoadResult> {
  const data = await fetchPinnacleFromGithub();
  if (!data) return { rows: [], updatedAt: null, source: "empty" };
  // Använd faktisk källa från senaste fetch (api eller raw fallback).
  const source: PinnacleSource = pinnacleLastFetchSource === "github-raw" ? "github-raw" : "github-api";
  return {
    rows: pinnaclePayloadToRows(data),
    updatedAt: data.updatedAt ?? null,
    source,
  };
}

/** Bevarar bakåtkompat för callers som bara vill ha rader. */
function loadPinnacleRowsFromDisk(): PinnacleRow[] {
  return loadPinnacleRowsFromDiskWithMeta().rows;
}
async function loadPinnacleRowsFromGithub(): Promise<PinnacleRow[]> {
  return (await loadPinnacleRowsFromGithubWithMeta()).rows;
}

function pinnacleAgeMs(updatedAt: string | null): number | null {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  if (!Number.isFinite(ms)) return null;
  return Date.now() - ms;
}

/** In-memory cache med metadata (rader + updatedAt + source). */
const pinnacleRowsMetaCache = new Map<string, { expiresAt: number; data: PinnacleLoadResult }>();
let pinnacleRowsMetaInflight: Promise<PinnacleLoadResult> | null = null;

/**
 * Primär laddare med freshness-metadata. Prio:
 *   1. In-memory cache (90s TTL)
 *   2. Live direkt-fetch (lokalt funkar; Render blockas av Cloudflare)
 *   3. Välj nyast av (disk, GitHub raw) — om disk är >2 min försök GitHub raw först
 *      eftersom Actions-workflow:n kan ha pushat efter Render-deploy.
 */
async function buildPinnacleRowsWithMeta(force = false): Promise<PinnacleLoadResult> {
  const cacheKey = "all";
  const now = Date.now();
  if (!force) {
    const cached = pinnacleRowsMetaCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return { ...cached.data, source: "cache" };
    if (pinnacleRowsMetaInflight) return pinnacleRowsMetaInflight;
  }

  const promise = (async (): Promise<PinnacleLoadResult> => {
    // 1. Live direkt-fetch — BARA lokalt/dev (PINNACLE_LIVE_FETCH_ENABLED). I
    //    produktion (Render) är detta AVSTÄNGT: datacenter-IP:n kan få stale
    //    edge-cachad linje från Pinnacles CDN och grenen stämplar updatedAt=now,
    //    vilket gick förbi freshness-gaten och visade en valuebet mot en GAMMAL
    //    linje (2.00 i st.f. 2.16 → falsk +EV). Auktoritativ data = scrapern
    //    (DB→disk→GitHub) nedan, med den VERKLIGA scrape-tiden som updatedAt.
    if (PINNACLE_LIVE_FETCH_ENABLED) {
      let liveRows: PinnacleRow[] = [];
      for (const sport of PINNACLE_SPORTS) {
        try {
          const rows = await fetchPinnacleSportRows(sport.id, sport.tag);
          liveRows.push(...rows);
        } catch (error) {
          console.warn(
            `[pinnacle] live-fetch failed for ${sport.tag}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      if (liveRows.length > 0) {
        const data: PinnacleLoadResult = {
          rows: liveRows,
          updatedAt: new Date().toISOString(),
          source: "live",
        };
        pinnacleRowsMetaCache.set(cacheKey, { expiresAt: Date.now() + PINNACLE_CACHE_TTL_MS, data });
        return data;
      }
    }

    // 2. Odds-databasen (steg 3 i docs/database-plan.md) — Actions-loopen speglar
    //    pinnacle-payloaden hit varje iteration, så detta är den färskaste vägen
    //    på Render (ingen commit/push-lag, inga GitHub-rate-limits). Endast om
    //    payloaden är FÄRSK — annars faller vi vidare till disk/GitHub som idag.
    const dbPayload = (await fetchOddsDbPayload("pinnacle-rows")) as Parameters<
      typeof pinnaclePayloadToRows
    >[0] | null;
    if (dbPayload) {
      const dbUpdatedAt = (dbPayload as { updatedAt?: string }).updatedAt ?? null;
      const dbAge = pinnacleAgeMs(dbUpdatedAt);
      if (dbAge !== null && dbAge < PINNACLE_PREFER_GITHUB_AFTER_MS) {
        const dbRows = pinnaclePayloadToRows(dbPayload);
        if (dbRows.length > 0) {
          const data: PinnacleLoadResult = { rows: dbRows, updatedAt: dbUpdatedAt, source: "db" };
          pinnacleRowsMetaCache.set(cacheKey, { expiresAt: Date.now() + PINNACLE_CACHE_TTL_MS, data });
          return data;
        }
      }
    }

    // 3. Disk + GitHub raw — välj nyast.
    const diskMeta = loadPinnacleRowsFromDiskWithMeta();
    const diskAge = pinnacleAgeMs(diskMeta.updatedAt);
    let githubMeta: PinnacleLoadResult | null = null;
    if (diskMeta.rows.length === 0 || (diskAge !== null && diskAge > PINNACLE_PREFER_GITHUB_AFTER_MS)) {
      githubMeta = await loadPinnacleRowsFromGithubWithMeta();
    }

    const candidates: PinnacleLoadResult[] = [];
    if (diskMeta.rows.length > 0) candidates.push(diskMeta);
    if (githubMeta && githubMeta.rows.length > 0) candidates.push(githubMeta);
    if (candidates.length === 0) {
      const empty: PinnacleLoadResult = { rows: [], updatedAt: null, source: "empty" };
      pinnacleRowsMetaCache.set(cacheKey, { expiresAt: Date.now() + 30_000, data: empty });
      return empty;
    }
    // Välj källan med yngst updatedAt.
    candidates.sort((a, b) => {
      const aAge = pinnacleAgeMs(a.updatedAt) ?? Number.POSITIVE_INFINITY;
      const bAge = pinnacleAgeMs(b.updatedAt) ?? Number.POSITIVE_INFINITY;
      return aAge - bAge;
    });
    const chosen = candidates[0];
    const ageStr =
      chosen.updatedAt && pinnacleAgeMs(chosen.updatedAt) !== null
        ? `${Math.round(pinnacleAgeMs(chosen.updatedAt)! / 1000)}s`
        : "okänt";
    console.log(
      `[pinnacle] valde källa=${chosen.source} (${chosen.rows.length} rader, ålder=${ageStr})`,
    );
    pinnacleRowsMetaCache.set(cacheKey, { expiresAt: Date.now() + PINNACLE_CACHE_TTL_MS, data: chosen });
    return chosen;
  })().finally(() => {
    pinnacleRowsMetaInflight = null;
  });
  pinnacleRowsMetaInflight = promise;
  return promise;
}

/** Bakåtkompat-wrapper som bara returnerar rader (för callers utan freshness-behov). */
async function buildPinnacleRowsAllSports(force = false): Promise<PinnacleRow[]> {
  const meta = await buildPinnacleRowsWithMeta(force);
  return meta.rows;
}

type BetOnlineRowFromCache = BetOnlineBrowserOdd & {
  sport?: string | null;
  homeName?: string;
  awayName?: string;
};

function loadBetOnlineRowsFromWorkerCache(): { updatedAt?: string; rows: BetOnlineRowFromCache[] } {
  const file = path.join(BONUS_CACHE_DIR, "stake-betonline-cache.json");
  if (!fs.existsSync(file)) return { rows: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      updatedAt?: string;
      betOnlineRows?: Array<{
        match?: string;
        sport?: string | null;
        homeName?: string;
        awayName?: string;
        homeOdds?: number;
        awayOdds?: number;
        drawOdds?: number;
        homeLine?: number;
        awayLine?: number;
        line?: number;
        homeOutcomeLabel?: string;
        awayOutcomeLabel?: string;
        drawOutcomeLabel?: string;
        marketType?: "moneyline" | "spread" | "total";
        marketLabel?: string;
        raw?: string;
      }>;
    };
    const rows = (data.betOnlineRows ?? [])
      .filter((row) => row?.match && Number(row.homeOdds) > 1 && Number(row.awayOdds) > 1)
      .map<BetOnlineRowFromCache>((row) => ({
        raw: row.raw ?? row.match ?? "",
        match: row.match!,
        homeName: row.homeName,
        awayName: row.awayName,
        sport: row.sport ?? null,
        homeAmerican: 0,
        awayAmerican: 0,
        homeDecimal: Number(row.homeOdds),
        awayDecimal: Number(row.awayOdds),
        drawDecimal: Number(row.drawOdds),
        homeLine: Number.isFinite(row.homeLine) ? Number(row.homeLine) : undefined,
        awayLine: Number.isFinite(row.awayLine) ? Number(row.awayLine) : undefined,
        line: Number.isFinite(row.line) ? Number(row.line) : undefined,
        homeOutcomeLabel: row.homeOutcomeLabel,
        awayOutcomeLabel: row.awayOutcomeLabel,
        drawOutcomeLabel: row.drawOutcomeLabel,
        marketType: row.marketType ?? "moneyline",
        marketLabel: row.marketLabel,
      }));
    return { updatedAt: data.updatedAt, rows };
  } catch {
    return { rows: [] };
  }
}

function parseBetOnlineRenderedText(lines: string[]): BetOnlineBrowserOdd[] {
  return lines.flatMap((rawLine) => {
    const raw = rawLine.replace(/\s+/g, " ").trim();
    if (!raw || !/moneyline/i.test(raw)) return [];
    const moneylineIndex = raw.toLowerCase().indexOf("moneyline");
    const moneylinePart = raw.slice(moneylineIndex);
    const americanOdds = [...moneylinePart.matchAll(/(?:^|\s)([+-]\d{3,4})(?=\s|$)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));
    if (americanOdds.length < 2) return [];

    const matchText = raw
      .slice(0, moneylineIndex)
      .replace(/^(today|tomorrow),?\s+/i, "")
      .replace(/^\d{1,2}:\d{2}\s*(am|pm)\s+/i, "")
      .replace(/\+\d+\s+/g, " ")
      .replace(/\b\d{3,4}\s+-\s+/g, "")
      .replace(/\b(run line|total)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    return [
      {
        raw,
        match: matchText || raw.slice(0, moneylineIndex).trim(),
        homeAmerican: americanOdds[0],
        awayAmerican: americanOdds[1],
        homeDecimal: americanOddsToDecimal(americanOdds[0]),
        awayDecimal: americanOddsToDecimal(americanOdds[1]),
      },
    ];
  });
}

async function scrapeBetOnlineWithBrowser(targetUrl = "https://www.betonline.ag/sportsbook/soccer") {
  const originalBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  if (originalBrowserPath == null) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowserPath;
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 1000 },
      locale: "en-US",
    });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(8_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const linkTexts = await page.locator("a").evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean),
    );
    const buttonTexts = await page.locator("button").evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean),
    );
    const bodyText = ((await page.locator("body").textContent()) ?? "")
      .split(/(?=Today|Tomorrow|Mon,|Tue,|Wed,|Thu,|Fri,|Sat,|Sun,)/i)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const odds = parseBetOnlineRenderedText([...linkTexts, ...buttonTexts, ...bodyText]);
    return {
      title: await page.title(),
      url: page.url(),
      odds,
    };
  } finally {
    await browser.close();
  }
}

async function stakeBetOnlineBrowserApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/stake-betonline/betonline-browser") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use POST" }));
    return;
  }

  try {
    const body = await readRequestBody(req);
    const parsed = (body ? JSON.parse(body) : {}) as { url?: string };
    const targetUrl = parsed.url?.startsWith("https://www.betonline.ag/")
      ? parsed.url
      : "https://www.betonline.ag/sportsbook/soccer";
    const result = await scrapeBetOnlineWithBrowser(targetUrl);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, ...result, count: result.odds.length }));
  } catch (error) {
    const { status, payload } = jsonErrorFromUnknown(
      error,
      "Kunde inte hämta BetOnline via browser",
    );
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  }
}

async function stakeBetOnlineCacheApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/stake-betonline/cache") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET" }));
    return;
  }

  try {
    const file = path.join(BONUS_CACHE_DIR, "stake-betonline-cache.json");
    if (!fs.existsSync(file)) {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, exists: false, opportunities: [], stakeRows: [], betOnlineRows: [] }));
      return;
    }
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, exists: true, ...(data as object) }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown cache read error" }));
  }
}

/** GET-cache så sidan inte hämtar om ~1 MB Stake-data vid varje poll (90 s i UI). */
const STAKE_BETONLINE_AUTO_GET_CACHE_TTL_MS = 50_000;
let stakeBetOnlineAutoGetCache: { body: string; expiresAt: number; betOnlineCacheMtime: number } | null = null;

function stakeBetOnlineWorkerCacheMtime(): number {
  try {
    return fs.statSync(path.join(BONUS_CACHE_DIR, "stake-betonline-cache.json")).mtimeMs;
  } catch {
    return 0;
  }
}

async function stakeBetOnlineAutoApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url?.split("?")[0];
  if (url !== "/api/stake-betonline/auto") {
    next();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: "Use GET or POST" }));
    return;
  }

  const force = req.method === "POST" || (req.url ?? "").includes("force=1");

  if (req.method === "GET" && !force) {
    const hit = stakeBetOnlineAutoGetCache;
    if (hit && hit.expiresAt > Date.now()) {
      const workerMtime = stakeBetOnlineWorkerCacheMtime();
      if (workerMtime <= hit.betOnlineCacheMtime + 500) {
        res.statusCode = 200;
        res.end(hit.body);
        return;
      }
    }
  }

  try {
    const [stakeRows, pinnacleRows] = await Promise.all([
      buildStakeRowsAllSports({ force }),
      buildPinnacleRowsAllSports(force).catch((error) => {
        console.warn(
          "[pinnacle] failed to fetch:",
          error instanceof Error ? error.message : error,
        );
        return [] as PinnacleRow[];
      }),
    ]);
    const { rows: betOnlineRows, updatedAt: betOnlineUpdatedAt } = loadBetOnlineRowsFromWorkerCache();
    const pinnacleAsBetOnline = pinnacleRowsAsBetOnlineRows(pinnacleRows);

    // Bygg opportunities på två sätt: traditionell pair-wise (Stake vs en bookmaker)
    // OCH best-line per utfall där varje utfall får komma från olika bookmakers.
    const stakeVsBetOnline = buildStakeBetOnlineOpportunities(stakeRows, betOnlineRows);
    const stakeVsPinnacle = buildStakeBetOnlineOpportunities(stakeRows, pinnacleAsBetOnline);
    const bestLineOps = buildBestLineOpportunities(stakeRows, betOnlineRows, pinnacleAsBetOnline);

    const combined = new Map<string, StakeBetOnlineOpportunity>();
    for (const opportunity of [...stakeVsBetOnline, ...stakeVsPinnacle, ...bestLineOps]) {
      const key = opportunityKey(opportunity);
      const existing = combined.get(key);
      if (!existing || opportunity.edgePct > existing.edgePct) {
        combined.set(key, opportunity);
      }
    }
    const opportunities = [...combined.values()].sort((a, b) => b.edgePct - a.edgePct).slice(0, 50);

    const stakeMatchesNeeded = new Set(opportunities.map((o) => o.stakeMatch));
    const stakeRowsForClient =
      opportunities.length === 0 ? [] : stakeRows.filter((row) => stakeMatchesNeeded.has(row.match));

    const slimPayload = {
      ok: true as const,
      updatedAt: new Date().toISOString(),
      stakeUpdatedAt: new Date().toISOString(),
      betOnlineUpdatedAt,
      stakeCount: stakeRows.length,
      betOnlineCount: betOnlineRows.length,
      /** UI använder bara rader för visade opportunities — skickar inte ~1 MB extra. */
      stakeRows: stakeRowsForClient,
      opportunities,
    };

    const body = JSON.stringify(slimPayload);
    stakeBetOnlineAutoGetCache = {
      body,
      expiresAt: Date.now() + STAKE_BETONLINE_AUTO_GET_CACHE_TTL_MS,
      betOnlineCacheMtime: stakeBetOnlineWorkerCacheMtime(),
    };

    res.statusCode = 200;
    res.end(body);
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Kunde inte hämta Stake-odds",
      }),
    );
  }
}

/** Ta bort Vites `base` från `req.url` så `/api/*`-handlers matchar när appen ligger under t.ex. `/linusgan/`. */
function stripViteBaseFromIncomingUrl(req: IncomingMessage, appBase: string): void {
  if (!req.url) return;
  const trimmedBase = appBase.replace(/\/$/, "");
  if (!trimmedBase) return;
  const qIndex = req.url.indexOf("?");
  const pathPart = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
  const search = qIndex === -1 ? "" : req.url.slice(qIndex);
  if (pathPart === trimmedBase || pathPart.startsWith(`${trimmedBase}/`)) {
    let nextPath = pathPart === trimmedBase ? "/" : pathPart.slice(trimmedBase.length);
    if (!nextPath.startsWith("/")) nextPath = `/${nextPath}`;
    req.url = nextPath + search;
  }
}

function matchedBettingApiPlugin(appBase: string) {
  initAutoclickerStorage();
  initAppUsersStorage();
  // Logga persistent storage-konfiguration vid uppstart så det syns tydligt
  // i Render-loggarna. Underlättar felsökning av env-vars och disk-mount.
  logStorageConfigOnStartup();
  const adminUsersApiCtx = {
    getAuthUsername: (req: IncomingMessage) => {
      if (!authIsEnabled()) return getAuthCredentials()?.username ?? "dev-admin";
      return getAuthFromRequest(req)?.user ?? null;
    },
    isAdminUsername: (username: string) => !authIsEnabled() || isAdminUsername(username),
  };
  const stripBaseMiddleware = (req: IncomingMessage, _res: ServerResponse, next: () => void) => {
    stripViteBaseFromIncomingUrl(req, appBase);
    next();
  };
  type MiddlewareStack = {
    use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void;
  };

  const registerMatchedBettingMiddlewares = (
    middlewares: MiddlewareStack,
    options: { productionBootLog?: boolean; prewarmBonuses?: boolean },
  ) => {
    middlewares.use(stripBaseMiddleware);
      middlewares.use(apiHealthDevApi);
      // Auth endpoints FIRST so they bypass the gate below
      middlewares.use((req, res, next) => { void authLoginDevApi(req, res, next); });
      middlewares.use(authLogoutDevApi);
      middlewares.use(authMeDevApi);
      middlewares.use(autoclickerHealthApi);
      middlewares.use((req, res, next) => { void botLicenseApi(req, res, next); });
      // Oautentiserad diagnostik — MÅSTE ligga före auth-gaten för att vara nåbar.
      middlewares.use(internalPingDevApi);
      // Auth gate — blocks /api/* except PUBLIC_API_PATHS + /api/auth/*
      middlewares.use(authGateMiddleware);
      middlewares.use(adminOnlyMiddleware);
      middlewares.use(valuebetsAccessMiddleware);
      middlewares.use((req, res, next) => { void trackingApiDevApi(req, res, next); });
      // Per-funktion-åtkomst (admin ELLER kund med flaggan, sätts i /admin/users).
      middlewares.use(bonusOptimizerAccessMiddleware);
      middlewares.use(bonusFinderAccessMiddleware);
      middlewares.use(athenaAccessMiddleware);
      // Admin endpoints (protected by authGate + adminOnly above)
      middlewares.use(adminAuthSettingsDevApi);
      middlewares.use((req, res, next) => { void adminUsersApi(req, res, next, adminUsersApiCtx); });
      middlewares.use((req, res, next) => {
        storageHealthApi(req, res, next, {
          getAuthUsername: adminUsersApiCtx.getAuthUsername,
          isAdminUsername: adminUsersApiCtx.isAdminUsername,
        });
      });
      // B2: källornas inlärda polling-tolerans (admin) — läses från committad fil via GitHub raw.
      middlewares.use((req, res, next) => { void sourceToleranceApi(req, res, next); });
      // Bonus Finder — admin-only oddsanalys per bookmaker
      middlewares.use((req, res, next) => {
        void bonusFinderApi(req, res, next, {
          getAuthUsername: adminUsersApiCtx.getAuthUsername,
          isAdminUsername: adminUsersApiCtx.isAdminUsername,
          loadMatches: (hoursWindow: number) => getBonusFinderMatchesCached(hoursWindow),
        });
      });
      // Bygg-funktionen som cachen/bakgrundsvärmaren använder (oförändrad logik).
      bonusFinderBuildFn = async (hoursWindow: number): Promise<BonusFinderMatchData[]> => {
            const bfStart = Date.now();
            // Återanvänd samma odds-index som /api/valuebets så vi slipper
            // duplicerad scraping. Berika med Pinnacle-odds per match —
            // 3-vägs (1X2) för fotboll, 2-vägs (ML2) för tennis/hockey/basket.
            const indexed = await getBonusOddsIndexMatches(hoursWindow);
            const pinnacleMeta = await buildPinnacleRowsWithMeta();

            // Smarkets som TÄCKNINGS-källa (helst Pinnacle/Smarkets). Smarkets är
            // en börs → BACK-bet betalar ~2% kommission på nettovinst, så vi
            // konverterar till effektiva odds: 1 + (rå − 1) × (1 − commission).
            // Då kan kunden ALDRIG se falsk +EV (kommissionen är redan inbakad).
            const smkMeta = await loadSmarketsPayloadWithMeta().catch(() => ({ payload: null as SmarketsCachePayload | null }));
            const smkRows = smarketsAllRows(smkMeta.payload);
            const smkLookup = buildTitleTokenIndex(smkRows, (s) => `${s.homeTeam} - ${s.awayTeam}`);
            const smkCommission = smkMeta.payload?.commission ?? 0.02;
            const effSmkBack = (o?: number | null): number | undefined =>
              o != null && o > 1 ? 1 + (o - 1) * (1 - smkCommission) : undefined;
            // Riktnings-alignment: en kandidat-rad (home/away ur candTitle) mappas
            // till referensmatchens orientering (refTitle). Smarkets/Pinnacle kan
            // ha hemma/borta omvänt → utan detta hamnar odds på fel utfall.
            const alignTriple = (
              refTitle: string,
              candTitle: string,
              t: { home?: number | null; draw?: number | null; away?: number | null },
            ): { home?: number | null; draw?: number | null; away?: number | null } => {
              let swap = false;
              try {
                const r = getMatchSideTokens(refTitle);
                const c = getMatchSideTokens(candTitle);
                if (r.length >= 2 && c.length >= 2 && sideMatches(c[0], r[1]) && sideMatches(c[1], r[0])) swap = true;
              } catch { /* okänd orientering → anta ingen swap */ }
              return swap ? { home: t.away, draw: t.draw, away: t.home } : t;
            };
            /** Bygg en Smarkets-täckningsrad (effektiva back-odds, riktnings-justerad). */
            const smarketsCoverRow = (
              refTitle: string,
              refStartTs: string | null | undefined,
              refLeague: string | null | undefined,
              threeWay: boolean,
            ): BonusFinderMatchData["oddsRows"][number] | null => {
              const row = smkLookup(refTitle).find((s) => {
                try {
                  // KICKOFF-VETO: utan tids-/liga-kontroll matchades olika matcher
                  // med liknande namn → orimliga returer (t.ex. 183%). Kräver nu
                  // samma avspark (inom tolerans) för att en täckning ska godtas.
                  return isLikelySameMatch(`${s.homeTeam} - ${s.awayTeam}`, refTitle, {
                    candidateStartTs: s.startTime ?? null,
                    targetStartTs: refStartTs ?? null,
                    candidateLeague: s.league ?? null,
                    targetLeague: refLeague ?? null,
                  });
                } catch { return false; }
              });
              if (!row) return null;
              const a = alignTriple(refTitle, `${row.homeTeam} - ${row.awayTeam}`, {
                home: row.odds?.home, draw: row.odds?.draw, away: row.odds?.away,
              });
              const home = effSmkBack(a.home);
              const away = effSmkBack(a.away);
              const draw = threeWay ? effSmkBack(a.draw) : undefined;
              if (!(home && away)) return null;
              return { bookmakerId: "smarkets", bookmaker: "Smarkets", home, ...(draw ? { draw } : {}), away };
            };

            const pinnacleSoccer = pinnacleMeta.rows.filter(
              (r) =>
                r.sport === "soccer" &&
                r.marketType === "moneyline" &&
                Number.isFinite(r.drawOdds) &&
                (r.drawOdds ?? 0) > 1 &&
                (r.homeOdds ?? 0) > 1 &&
                (r.awayOdds ?? 0) > 1,
            );

            // 2-vägs Pinnacle moneyline för icke-fotboll. Phase 1 av
            // 2-vägs-stödet exponerar dessa i pipelinen så att Phase 2
            // (bookmaker-scrapers för tennis/hockey/basket) automatiskt
            // får en Pinnacle-referens utan ytterligare wiring.
            const TWO_WAY_SPORTS = new Set(["tennis", "ice-hockey", "basketball", "baseball", "mma", "boxing"]);
            const pinnacleTwoWay = pinnacleMeta.rows.filter(
              (r) =>
                TWO_WAY_SPORTS.has(r.sport ?? "") &&
                r.marketType === "moneyline" &&
                (r.homeOdds ?? 0) > 1 &&
                (r.awayOdds ?? 0) > 1,
            );

            const pinSoccerLookup = buildTitleTokenIndex(pinnacleSoccer, (p) => p.match ?? "");
            const pinTwoWayLookup = buildTitleTokenIndex(pinnacleTwoWay, (p) => p.match ?? "");

            const soccerMatches: BonusFinderMatchData[] = indexed.map((m) => {
              const isTwoWay = m.oddsRows.length > 0 && m.oddsRows.every((r) => !((r.draw ?? 0) > 1));
              const threeWay = !isTwoWay;

              const oddsRows: BonusFinderMatchData["oddsRows"] = m.oddsRows.map((r) => ({
                bookmakerId: String(r.bookmakerId),
                bookmaker: r.bookmaker,
                home: r.home,
                ...(threeWay ? { draw: r.draw } : {}),
                away: r.away,
              }));

              // Pinnacle (riktnings-justerad) — jämförelse + täcknings-rad.
              let pinnacleOdds: { home: number; draw?: number; away: number } | undefined;
              const pinHit = pinSoccerLookup(m.title).find((p) => {
                if (!p.match) return false;
                try {
                  return isLikelySameMatch(p.match, m.title, {
                    candidateStartTs: p.startTime != null && Number.isFinite(p.startTime) ? new Date(p.startTime).toISOString() : null,
                    targetStartTs: m.startTs ?? null,
                    candidateLeague: p.tournament ?? null,
                    targetLeague: m.league ?? null,
                  });
                } catch { return false; }
              });
              if (pinHit && pinHit.drawOdds != null) {
                const a = alignTriple(m.title, pinHit.match ?? "", {
                  home: pinHit.homeOdds, draw: pinHit.drawOdds, away: pinHit.awayOdds,
                });
                if (a.home && a.away) {
                  pinnacleOdds = threeWay
                    ? { home: a.home, draw: a.draw ?? undefined, away: a.away }
                    : { home: a.home, away: a.away };
                  if (!oddsRows.some((r) => r.bookmakerId === "pinnacle")) {
                    oddsRows.push({
                      bookmakerId: "pinnacle", bookmaker: "Pinnacle",
                      home: a.home, ...(threeWay && a.draw ? { draw: a.draw } : {}), away: a.away,
                    });
                  }
                }
              }

              // Smarkets täckning (effektiva back-odds inkl. kommission).
              const smkRow = smarketsCoverRow(m.title, m.startTs, m.league, threeWay);
              if (smkRow && !oddsRows.some((r) => r.bookmakerId === "smarkets")) oddsRows.push(smkRow);

              return {
                title: m.title,
                startTs: m.startTs,
                league: m.league,
                sport: "soccer",
                marketType: isTwoWay ? ("ML2" as const) : ("1X2" as const),
                oddsRows,
                pinnacleOdds,
              };
            });

            // Phase 2: lägg till multi-sport-matcher (tennis, hockey, basket,
            // baseball, MMA, boxning) från Unibet via Kambi + Altenar-gruppen.
            // Berika med Pinnacle 2-vägs odds via titel-jaccard.
            const multiSport = await getMultiSportBonusMatches(hoursWindow).catch((e) => {
              console.warn("[bonus-finder] multi-sport load failed", e);
              return [] as MultiSportMatch[];
            });
            const nonSoccerMatches: BonusFinderMatchData[] = multiSport.map((m) => {
              const oddsRows: BonusFinderMatchData["oddsRows"] = m.oddsRows.map((r) => ({
                bookmakerId: r.bookmakerId,
                bookmaker: r.bookmaker,
                home: r.home,
                away: r.away,
              }));

              // Pinnacle 2-vägs (riktnings-justerad) — jämförelse + täckning.
              let pinnacleOdds: { home: number; draw?: number; away: number } | undefined;
              const pinHit2 = pinTwoWayLookup(m.title).find((p) => {
                if (!p.match) return false;
                try {
                  return isLikelySameMatch(p.match, m.title, {
                    candidateStartTs: p.startTime != null && Number.isFinite(p.startTime) ? new Date(p.startTime).toISOString() : null,
                    targetStartTs: m.startTs ?? null,
                    candidateLeague: p.tournament ?? null,
                    targetLeague: m.league ?? null,
                  });
                } catch { return false; }
              });
              if (pinHit2) {
                const a = alignTriple(m.title, pinHit2.match ?? "", { home: pinHit2.homeOdds, away: pinHit2.awayOdds });
                if (a.home && a.away) {
                  pinnacleOdds = { home: a.home, away: a.away };
                  if (!oddsRows.some((r) => r.bookmakerId === "pinnacle")) {
                    oddsRows.push({ bookmakerId: "pinnacle", bookmaker: "Pinnacle", home: a.home, away: a.away });
                  }
                }
              }

              // Smarkets 2-vägs täckning (effektiva back-odds inkl. kommission).
              const smkRow = smarketsCoverRow(m.title, m.startTs, m.league, false);
              if (smkRow && !oddsRows.some((r) => r.bookmakerId === "smarkets")) oddsRows.push(smkRow);

              return {
                title: m.title,
                startTs: m.startTs,
                league: m.league,
                sport: m.sport,
                marketType: m.marketType,
                oddsRows,
                pinnacleOdds,
              };
            });

            console.log(
              `[bonus-finder] bygge klart: ${soccerMatches.length}+${nonSoccerMatches.length} matcher på ${Date.now() - bfStart}ms`,
            );
            return [...soccerMatches, ...nonSoccerMatches];
      };
      middlewares.use((req, res, next) => { void adminAutoclickerUploadZipApi(req, res, next); });
      middlewares.use((req, res, next) => { void adminAutoclickerLicensesApi(req, res, next); });
      middlewares.use((req, res, next) => {
        const auth = getAuthFromRequest(req);
        if (!auth) {
          next();
          return;
        }
        autoclickerStatusApi(req, res, auth.user, () => {
          autoclickerDownloadApi(req, res, auth.user, next);
        });
      });
      middlewares.use((req, res, next) => { void adminChangePasswordDevApi(req, res, next); });
      middlewares.use(adminLogoutAllDevApi);
      middlewares.use(betLogsDevApi);
      middlewares.use((req, res, next) => {
        void bestBonusMatchesDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void rebuildBonusIndexDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void bonusContinuationDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void oddsComparisonDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void stakeBetOnlineBrowserApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void stakeBetOnlineCacheApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void stakeBetOnlineAutoApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void valuebetsDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void pinnacleSharpLinesDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void smarketsExtractionDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void pinnacleFairOddsDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void matchResultDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void resultSourcesDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void userBetsDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void pinnacleNormalizedDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void sourcesStatusDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void sourcesPerfProbeApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void foreignSourceDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        onDemandSourcesDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void sharedBookmakersDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void altenarDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void kambiDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void pafBrandDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void coverageAuditDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void pinnacleDebugDevApi(req, res, next);
      });
      middlewares.use((req, res, next) => {
        void prewarmStatusDevApi(req, res, next);
      });
      // Athena AI-assistent (chat för inloggade + admin-CRUD för kunskapsbasen).
      middlewares.use((req, res, next) => {
        const a = getAuthFromRequest(req);
        const auth = { user: a?.user ?? null, isAdmin: a ? isAdminUsername(a.user) : false };
        void handleAthenaApi(req, res, next, auth);
      });
      // Billing (Mollie): medlemmens köp/uppgradering + webhook.
      middlewares.use((req, res, next) => {
        void handleBillingApi(req, res, next, {
          getAuthUsername: (r) => getAuthFromRequest(r)?.user ?? null,
        });
      });

    if (options.productionBootLog) {
      logAutoclickerRouteManifest("production");
    }
    if (options.prewarmBonuses) {
      // Pre-warm bonus-indexet vid serverstart så att Valuebets-sidan har
      // svenska odds direkt utan att Bonus Optimizer behöver öppnas först.
      startBestBonusMatchesPrewarm();
      // Bygg + håll valuebets/sources-svaren varma så första besökaren efter
      // en deploy inte betalar kallstartsbygget.
      startResponseCacheWarmers();
      // Server-side CLV-fångst + auto-settle (oberoende av om kunden är inne).
      startBetMaintenance();
      // Prenumerationer: nollställ premium automatiskt när perioden gått ut.
      startSubscriptionSweeper();
    }
  };

  return {
    name: "matched-betting-api",
    configureServer(server: { middlewares: MiddlewareStack }) {
      registerMatchedBettingMiddlewares(server.middlewares, {});
    },
    configurePreviewServer(server: { middlewares: MiddlewareStack }) {
      // Render production (vite preview / scripts/production-server.mjs)
      registerMatchedBettingMiddlewares(server.middlewares, {
        productionBootLog: true,
        prewarmBonuses: true,
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // BASE_PATH env styr base-pathen vid build/preview.
  // Default: GitHub Pages-pathen "/linusgan/" i produktion, "/" lokalt.
  // Sätt BASE_PATH=/ i Render/cloud (där appen ligger på domänroten).
  const appBase = process.env.BASE_PATH ?? (mode === "production" ? "/linusgan/" : "/");
  return {
  base: appBase,
  server: {
    host: true,
    port: 8080,
    /** Om 8080 är upptagen väljer Vite nästa lediga port — kolla terminalen efter rätt URL. */
    strictPort: false,
    hmr: {
      overlay: false,
    },
    watch: {
      usePolling: true,
      interval: 200,
    },
  },
  preview: {
    host: true,
    port: 8080,
    strictPort: false,
    // Render/Railway/Fly serverar appen via okänd hostname, så vi vill inte
    // blockera DNS-rebinding-skyddet i Vite preview för cloud-deploys.
    allowedHosts: true,
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    matchedBettingApiPlugin(appBase),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) {
            return;
          }
          if (id.includes("recharts")) {
            return "vendor-recharts";
          }
          if (id.includes("d3-") || id.includes("/d3/") || id.includes("node_modules/d3")) {
            return "vendor-d3";
          }
          if (id.includes("@radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("framer-motion")) {
            return "vendor-motion";
          }
          if (id.includes("@tanstack")) {
            return "vendor-query";
          }
          if (id.includes("lucide-react")) {
            return "vendor-lucide";
          }
          if (id.includes("react-router")) {
            return "vendor-router";
          }
          if (id.includes("react-dom")) {
            return "vendor-react-dom";
          }
          if (id.includes("node_modules/react/")) {
            return "vendor-react";
          }
          if (id.includes("date-fns")) {
            return "vendor-date-fns";
          }
          if (id.includes("zod")) {
            return "vendor-zod";
          }
        },
      },
    },
  },
};
});
