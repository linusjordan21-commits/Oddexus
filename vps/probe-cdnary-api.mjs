#!/usr/bin/env node
/**
 * "Hitta den riktiga sportbok-backenden" — bred variant. Tidigare antagande att
 * sga.cdnary.com vore odds-backend var fel (det är en logo/asset-CDN). Denna
 * probe fångar ALLA tredjeparts-hosts + all JSON + sidtext/iframes så vi ser
 * vilken backend FrankFred/Onerush/Jubla faktiskt kör (om någon).
 *
 *   xvfb-run -a ip netns exec mv node vps/probe-cdnary-api.mjs
 *   BRAND=onerush|jubla|frankfred (default frankfred)
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[backend]", ...a);

const BRANDS = {
  frankfred: { home: "frankfred.com", urls: ["https://www.frankfred.com/sv/sports", "https://www.frankfred.com/sv/sportsbook", "https://www.frankfred.com/sv/betting"] },
  onerush:   { home: "onerush.com",   urls: ["https://onerush.com/sv/sports", "https://onerush.com/sv/sportsbook", "https://onerush.com/sv/betting"] },
  jubla:     { home: "jubla.com",     urls: ["https://jubla.com/sv/sports", "https://jubla.com/sv/sportsbook", "https://jubla.com/sv/betting"] },
};
const brand = (process.env.BRAND || "frankfred").toLowerCase();
const cfg = BRANDS[brand] || BRANDS.frankfred;

// kända backend-signaturer (för snabb identifiering om vi ser dem)
const SIG = [
  [/kambi|kambicdn/i, "Kambi"], [/biahosted|altenar/i, "Altenar"],
  [/bcapps|betconstruct|sportsbookv2/i, "BetConstruct"], [/digitain|dgsts/i, "Digitain"],
  [/betby/i, "Betby"], [/sbtech|sportradar|betradar/i, "SBTech/Sportradar"],
  [/sportnco|gig-|gigsport|everymatrix|oddin|delasport|pronet|logifuture|pinnacle\.solutions|softswiss|tglab|nsoft|altenar/i, "annan B2B"],
];

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", viewport: { width: 1366, height: 850 } });
  const hostCount = new Map();
  const jsonBodies = [];
  const seen = new Set();
  let sigHit = null;

  ctx.on("request", (r) => {
    const u = r.url();
    try {
      const h = new URL(u).hostname;
      if (!h.includes(cfg.home)) hostCount.set(h, (hostCount.get(h) || 0) + 1); // tredjeparts
    } catch {}
    if (!sigHit) for (const [re, name] of SIG) if (re.test(u)) { sigHit = { name, url: u.slice(0, 120) }; break; }
  });
  ctx.on("response", async (res) => {
    const u = res.url();
    if (seen.has(u)) return; seen.add(u);
    const ct = res.headers()["content-type"] || "";
    if (!ct.includes("json")) return;
    try {
      const txt = await res.text();
      if (txt.length > 200 && /odd|market|event|match|price|selection|outcome|competitor|fixture/i.test(txt) && jsonBodies.length < 8) {
        let host = ""; try { host = new URL(u).hostname; } catch {}
        jsonBodies.push({ host, url: u.slice(0, 150), len: txt.length, sample: txt.slice(0, 900) });
      }
    } catch {}
  });

  const page = await ctx.newPage();
  let loaded = null;
  for (const url of cfg.urls) { try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); loaded = url; break; } catch {} }
  log("brand:", brand, "| laddad:", loaded || "INGEN");
  if (loaded) {
    for (const t of ["Acceptera alla", "Godkänn alla", "Tillåt alla", "Accept all", "Acceptera", "OK", "Jag förstår"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch {}
    }
    for (const t of ["Fotboll", "Football", "Sport", "Sportsbook", "Sportbok", "Odds", "Betting", "Live"]) {
      try { await page.getByRole("link", { name: t, exact: false }).first().click({ timeout: 2000 }); await page.waitForTimeout(3000); } catch {}
    }
    await page.waitForTimeout(15000);
    // sidtext + iframes (avslöjar om sportbok ens finns / är iframe-baserad)
    const title = await page.title().catch(() => "");
    const bodyText = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    const iframes = await page.evaluate(() => Array.from(document.querySelectorAll("iframe")).map((f) => f.src).filter(Boolean)).catch(() => []);
    log("titel:", title);
    log("sidtext:", bodyText);
    log("iframes:", JSON.stringify(iframes).slice(0, 300));
  }

  log("\n===== KÄND BACKEND-SIGNATUR =====");
  console.log(sigHit ? `  ★ ${sigHit.name} — ${sigHit.url}` : "  (ingen känd signatur i trafiken)");

  log("\n===== TREDJEPARTS-HOSTS (req-count, top 25) =====");
  for (const [h, n] of [...hostCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(3)}  ${h}`);

  log(`\n===== JSON-SVAR med odds/event-nyckelord (${jsonBodies.length}) =====`);
  for (const b of jsonBodies) {
    console.log(`\n  --- ${b.host}  ${b.url}  [${b.len} bytes] ---`);
    console.log("  " + b.sample.replace(/\n/g, " "));
  }
  await browser.close();
}
main().catch((e) => { console.error("[backend] FATALT:", e?.message ?? e); process.exit(1); });
