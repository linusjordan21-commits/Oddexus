/**
 * check-scrapfly-balance.mjs — hämtar Scrapflys konto-API (GRATIS, 0 scrape-credits)
 * och dumpar kvarvarande credits/användning → data/_scrapfly-account.json.
 * Secret: SCRAPER_API_KEY. ENDAST dispatch.
 */
import fs from "node:fs";
import path from "node:path";

const KEY = (process.env.SCRAPER_API_KEY || "").trim();
const OUT = path.resolve(process.cwd(), "data", "_scrapfly-account.json");

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!KEY) { fs.writeFileSync(OUT, JSON.stringify({ err: "SCRAPER_API_KEY saknas" }, null, 2) + "\n"); console.error("ingen nyckel"); return; }
  let out = { ranAt: new Date().toISOString() };
  try {
    const r = await fetch(`https://api.scrapfly.io/account?key=${encodeURIComponent(KEY)}`);
    const j = await r.json();
    // Plocka ut de viktiga fälten (utan att läcka nyckeln).
    const sub = j?.subscription ?? {};
    const usage = sub?.usage?.scrape ?? j?.usage?.scrape ?? {};
    out = {
      ranAt: out.ranAt,
      httpStatus: r.status,
      plan: sub?.plan_name ?? sub?.name ?? null,
      period: { start: sub?.period?.start ?? null, end: sub?.period?.end ?? null },
      scrapeCredits: {
        used: usage?.current ?? usage?.used ?? null,
        limit: usage?.limit ?? usage?.allowed ?? null,
        remaining: (usage?.limit != null && usage?.current != null) ? (usage.limit - usage.current) : (usage?.remaining ?? null),
        extra: usage?.extra ?? null,
      },
      concurrency: { limit: sub?.max_concurrency ?? j?.account?.concurrent_limit ?? null, used: j?.account?.concurrent_usage ?? null },
      // hela svaret (utan key) för felsökning ifall fälten flyttat
      raw: j,
    };
  } catch (e) {
    out.err = String(e?.message ?? e).slice(0, 200);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  const c = out.scrapeCredits || {};
  console.log(`[scrapfly-account] plan=${out.plan} used=${c.used} limit=${c.limit} remaining=${c.remaining}`);
}
main().catch((e) => { console.error("fel:", e); fs.writeFileSync(OUT, JSON.stringify({ err: String(e?.message ?? e) }, null, 2) + "\n"); process.exit(1); });
