/**
 * Public API paths — shared by auth gate (vite.config.ts) and production startup logs.
 * These routes must work without session cookie on Render (vite preview / production-server).
 */

export const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/bot-license",
  "/api/autoclicker/health",
  // Mollie ringer denna utan cookie; säkras genom att betalningen verifieras
  // mot Mollie-API:t, inte via vår session.
  "/api/billing/webhook",
  // Tillfällig publik perf-diagnostik (bara timing-siffror, inga hemligheter).
  "/api/perf/sources",
]);

export function isPublicApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (normalized.startsWith("/api/auth/")) return true;
  return PUBLIC_API_PATHS.has(normalized);
}

/** Logged on production boot (configurePreviewServer + production-server.mjs). */
export function logAutoclickerRouteManifest(context = "production"): void {
  console.log(`[matched-betting:${context}] Autoclicker routes registered:`);
  console.log("  - GET  /api/autoclicker/health public");
  console.log("  - POST /api/bot-license public");
  console.log("  - GET  /autoclicker/download protected");
  console.log("  - POST /api/admin/autoclicker-licenses/upload-zip protected");
  console.log("  - POST /admin/autoclicker-licenses/upload-zip protected");
}
