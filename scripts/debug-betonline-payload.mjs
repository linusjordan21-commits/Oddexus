import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const EXECUTABLE = "/Users/lilgan/Downloads/matched-betting-project/node_modules/playwright-core/.local-browsers/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const URL = "https://www.betonline.ag/sportsbook/basketball";
const TARGETS = [
  { sport: "basketball", league: "nba" },
  { sport: "baseball", league: "mlb" },
  { sport: "soccer", league: "premier_league" },
  { sport: "soccer", league: "mls" },
  { sport: "ice_hockey", league: "nhl" },
];

const browser = await chromium.launch({
  headless: false,
  ...(fs.existsSync(EXECUTABLE) ? { executablePath: EXECUTABLE } : {}),
  args: ["--disable-blink-features=AutomationControlled", "--disable-features=IsolateOrigins,site-per-process"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});
const page = await context.newPage();
console.log("Going to", URL);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => console.warn("nav err", e?.message));
for (let i = 0; i < 16; i += 1) {
  await page.waitForTimeout(3000);
  const cookies = await context.cookies("https://www.betonline.ag");
  const hasCF = cookies.some((c) => c.name === "cf_clearance" || c.name === "__cf_bm");
  const title = await page.title().catch(() => "");
  const looksLikeApp = !/just a moment|attention required|cloudflare|welcome to sportsbook/i.test(title);
  console.log(`wait #${i} title="${title}" cookies=${cookies.length} hasCF=${hasCF}`);
  if (hasCF && looksLikeApp) break;
}
console.log("Cookies set:", (await context.cookies("https://www.betonline.ag")).length);

// Klicka runt på sidan så React faktiskt laddar deras pre-renderade data
await page.evaluate(() => window.scrollTo(0, 200)).catch(() => undefined);
await page.waitForTimeout(2000);

const out = {};
for (const target of TARGETS) {
  const data = await page.evaluate(
    async ({ sport, league }) => {
      try {
        const r = await fetch("https://api-offering.betonline.ag/api/offering/Sports/offering-by-league", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            gsetting: "bolsassite",
            "utc-offset": "-120",
          },
          body: JSON.stringify({ Sport: sport, League: league, ScheduleText: null, filterTime: 0 }),
        });
        if (!r.ok) return { error: `HTTP ${r.status}` };
        return await r.json();
      } catch (error) {
        return { error: String(error) };
      }
    },
    target,
  );
  out[`${target.sport}/${target.league}`] = data;
}

const file = path.resolve(process.cwd(), ".matched-betting-cache/debug-betonline-payload.json");
fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf-8");
console.log("Dumped to", file);
for (const [key, value] of Object.entries(out)) {
  const games = value?.GameOffering?.GamesDescription?.length ?? 0;
  console.log(key, "games:", games, value?.error ? `error=${value.error}` : "");
}

await browser.close();
