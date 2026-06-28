#!/usr/bin/env node
/**
 * Batch backend-detektor: laddar varje sajt, fångar nätverksanrop, och
 * identifierar sportsbook-backend via kända signaturer. Avgör edge + adderbarhet.
 *
 * Kör via Mullvad (svensk exit-IP):
 *   xvfb-run -a ip netns exec mv node vps/probe-backends-batch.mjs
 */
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromiumExtra.use(StealthPlugin());

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[backends]", ...a);

// brand → kandidat-URL:er (försöker i ordning tills en laddar)
const SITES = [
  ["LeoVegas",   ["https://www.leovegas.com/sv-se/sport", "https://www.leovegas.com/sv-se/"]],
  ["Coolbet",    ["https://www.coolbet.com/sv/sports", "https://www.coolbet.com/sv/"]],
  ["Casumo",     ["https://www.casumo.com/sv/sportsbook", "https://www.casumo.com/sv/"]],
  ["MrGreen",    ["https://www.mrgreen.com/sv/sport", "https://www.mrgreen.com/sv/"]],
  ["BetMGM",     ["https://www.betmgm.se/", "https://sport.betmgm.se/"]],
  ["10bet",      ["https://www.10bet.se/", "https://www.10bet.com/sv/"]],
  ["Interwetten",["https://www.interwetten.com/sv/sportsbook", "https://www.interwetten.com/sv/"]],
  ["Smarkets",   ["https://smarkets.com/sport"]],
  ["Tipwin",     ["https://www.tipwin.se/sv/sports", "https://www.tipwin.se/"]],
  ["PokerStars", ["https://www.pokerstars.se/sports/", "https://www.pokerstars.se/"]],
  ["CampoBet",   ["https://www.campobet.com/sv/sports", "https://www.campobet.com/sv/"]],
  ["Betinia",    ["https://betinia.se/sv/sportsbook", "https://betinia.se/"]],
  ["FastBet",    ["https://www.fastbet.com/sv/sports", "https://www.fastbet.com/sv/"]],
  ["FrankFred",  ["https://www.frankfred.com/sv/sports", "https://www.frankfred.com/sv/"]],
  ["Quick",      ["https://quickcasino.se/sv/sportsbook", "https://quickcasino.se/"]],
  ["Swiper",     ["https://swiper.com/sv/sports", "https://swiper.com/"]],
  ["Onerush",    ["https://onerush.com/sv/sports", "https://onerush.com/"]],
  ["Jubla",      ["https://jubla.com/sv/sports", "https://jubla.com/"]],
  ["Reviant",    ["https://reviant.com/sv/sports", "https://reviant.com/"]],
  ["Lodur",      ["https://lodur.com/sv/sports", "https://lodur.com/"]],
  ["FlaxSport",  ["https://flax.com/sv/sports", "https://flax.com/"]],
  ["GoGo",       ["https://gogocasino.com/sv/sportsbook", "https://gogocasino.com/"]],
  ["VeraJohn",   ["https://www.verajohn.se/se/sports", "https://www.verajohn.se/"]],
  ["NinjaCasino",["https://www.ninjacasino.se/sportsbook", "https://www.ninjacasino.se/"]],
  ["SvenskaSpel",["https://spela.svenskaspel.se/sport", "https://www.svenskaspel.se/sport"]],
  ["Videoslots", ["https://www.videoslots.com/sv/sportsbook", "https://www.videoslots.com/"]],
  ["Paf",        ["https://www.paf.se/sport", "https://www.paf.se/"]],
];

// backend-signaturer (domän/path-fragment → backend-namn + känd edge-grupp)
const SIG = [
  [/kambi|kambicdn|\/offering\//i, "Kambi ★"],
  [/biahosted|altenar/i, "Altenar ★★"],
  [/bcapps|betconstruct|sportsbookv2/i, "BetConstruct ?"],
  [/digitain|dgsts/i, "Digitain ?"],
  [/betby\.com|sb2\.|betby/i, "Betby ?"],
  [/sbtech|sportsbook\.sg|geocomply/i, "SBTech ?"],
  [/sportradar|betradar/i, "Sportradar ?"],
  [/pronet/i, "Pronet ?"],
  [/sportnco|gig-|gigsport/i, "GiG/Sportnco ?"],
  [/365lpodds|bet365/i, "bet365-egen 🔴"],
  [/oddin|delasport|logifuture|pinnacle\.solutions/i, "annan B2B ?"],
];

async function main() {
  const browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
  const results = [];
  for (const [name, urls] of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", viewport: { width: 1366, height: 850 } });
    const hosts = new Map();
    let backend = null;
    ctx.on("request", (r) => {
      const u = r.url();
      try { const h = new URL(u).hostname; hosts.set(h, (hosts.get(h) || 0) + 1); } catch {}
      if (!backend) for (const [re, label] of SIG) if (re.test(u)) { backend = label; break; }
    });
    const page = await ctx.newPage();
    let loaded = false;
    for (const url of urls) {
      try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }); loaded = true; break; } catch {}
    }
    if (loaded) {
      for (const t of ["Acceptera alla", "Godkänn alla", "Tillåt alla", "Accept all", "Acceptera"]) {
        try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch {}
      }
      await page.waitForTimeout(9000);
    }
    // topp externa domäner (för okända)
    const top = [...hosts.entries()].filter(([h]) => !h.includes(new URL(urls[0]).hostname.replace(/^www\./, "")))
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
    results.push({ name, backend: backend || (loaded ? "okänd" : "kunde ej ladda"), top });
    log(`${name.padEnd(12)} → ${(backend || (loaded ? "okänd" : "EJ LADDAD")).padEnd(16)} ${backend ? "" : top.join(", ")}`);
    await ctx.close();
  }
  log("\n=========== SAMMANFATTNING ===========");
  for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.backend.padEnd(18)} ${r.backend === "okänd" ? "[" + r.top.join(", ") + "]" : ""}`);
  await browser.close();
}
main().catch((e) => { console.error("[backends] FATALT:", e?.message ?? e); process.exit(1); });
