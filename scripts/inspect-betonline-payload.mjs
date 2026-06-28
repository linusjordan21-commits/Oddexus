import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

process.env.PLAYWRIGHT_BROWSERS_PATH = "0";

const LOCAL = path.resolve(
  process.cwd(),
  "node_modules/playwright-core/.local-browsers/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);

const TARGETS = [
  { sport: "baseball", league: "mlb" },
  { sport: "soccer", league: "champions_league" },
  { sport: "basketball", league: "nba" },
  { sport: "ice_hockey", league: "nhl" },
];

const browser = await chromium.launch({
  headless: true,
  ...(fs.existsSync(LOCAL) ? { executablePath: LOCAL } : {}),
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});
const page = await context.newPage();
await page.goto("https://www.betonline.ag/sportsbook/baseball", { waitUntil: "domcontentloaded", timeout: 60000 });

for (let i = 0; i < 12; i += 1) {
  await page.waitForTimeout(2500);
  const cookies = await context.cookies("https://www.betonline.ag");
  if (cookies.some((c) => c.name === "cf_clearance" || c.name === "__cf_bm")) break;
}

const out = {};
for (const t of TARGETS) {
  const data = await page.evaluate(
    async ({ sport, league }) => {
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
      if (!r.ok) return { error: r.status };
      return await r.json();
    },
    t,
  );
  const games = data?.GameOffering?.GamesDescription ?? [];
  out[`${t.sport}/${t.league}`] = {
    count: games.length,
    sample: games[0] ?? data?.error ?? null,
  };
}

const outFile = path.resolve(process.cwd(), ".matched-betting-cache/betonline-payload-sample.json");
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
console.log(`Wrote ${outFile}`);
await browser.close();
