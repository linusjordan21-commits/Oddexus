#!/usr/bin/env node
/**
 * Render production entry point.
 *
 * Uses Vite preview (dist/ + configurePreviewServer middleware from vite.config.ts).
 * API routes are NOT dev-only — configurePreviewServer registers the same stack as dev.
 */
import { preview } from "vite";

const host = "0.0.0.0";
const port = Number(process.env.PORT) || 8080;

console.log("[production-server] Starting vite preview with API middleware…");
console.log(
  "[production-server] env: NODE_ENV=%s RENDER=%s BASE_PATH=%s PORT=%d",
  process.env.NODE_ENV ?? "(unset)",
  process.env.RENDER ?? "(unset)",
  process.env.BASE_PATH ?? "(vite default)",
  port,
);

const server = await preview({
  preview: {
    host,
    port,
    strictPort: false,
  },
});

const resolvedPort = server.config.preview?.port ?? port;
console.log("[production-server] Listening on http://%s:%d", host, resolvedPort);
server.printUrls();

async function selfTest(label, url, init) {
  try {
    const res = await fetch(url, init);
    console.log("[production-server] self-test %s → HTTP %d", label, res.status);
    return res.status;
  } catch (e) {
    console.warn(
      "[production-server] self-test %s failed: %s",
      label,
      e instanceof Error ? e.message : String(e),
    );
    return 0;
  }
}

await new Promise((r) => setTimeout(r, 500));

const healthStatus = await selfTest(
  "GET /api/autoclicker/health",
  `http://127.0.0.1:${resolvedPort}/api/autoclicker/health`,
);
const botStatus = await selfTest("POST /api/bot-license", `http://127.0.0.1:${resolvedPort}/api/bot-license`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    license_key: "TEST-OK-123",
    device_id: "PRODUCTION-SELF-TEST",
    bot_version: "1.0.0",
  }),
});

if (healthStatus !== 200) {
  console.warn("[production-server] WARNING: /api/autoclicker/health should return 200 without auth");
}
if (botStatus === 401 || botStatus === 404) {
  console.warn("[production-server] WARNING: /api/bot-license should not return 401/404 without auth");
}
