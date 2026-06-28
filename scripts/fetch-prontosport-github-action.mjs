/**
 * fetch-prontosport-github-action.mjs — prontosport (ABM/"Euro", sb.prontosport.se,
 * site 5066) prematch-1X2 via DOM-skrapning. Server-renderad HTML → stabil DOM. Binärt
 * API kringgås helt (webbläsaren har redan målat ut oddsen). Recon gav URL-schemat:
 *   /sv/euro/sport/soccer  (+ per-liga /sv/euro/sport/soccer/<slug>/<id>)
 *
 * Laddar soccer-vyn via stealth-Chromium bakom Mullvad (svensk IP), extraherar match-
 * rader (container med exakt 3 decimalpris-element = 1X2) + lag-namn → kanoniskt
 * events[]-format (samma som coolbet/888sport) → prontosport-rows.json.
 * Skriver även diag med pris-antal + prov-HTML så strukturen kan förfinas.
 * Secret: MULLVAD_WG_CONF (via workflow).
 */
import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { installHardDeadline, writeJsonPreservingCache } from "./lib/scrape-guard.mjs";
chromiumExtra.use(StealthPlugin());

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "prontosport-rows.json");
const DIAG_FILE = path.join(DATA_DIR, "_prontosport-scraper-diag.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[prontosport]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.message ?? e));

// Soccer-vyn + några toppligor (täckning utan att rendera för många sidor).
const URLS = [
  "https://sb.prontosport.se/sv/euro/sport/soccer",
  "https://sb.prontosport.se/sv/euro/sport/soccer/sweden-allsvenskan/704",
  "https://sb.prontosport.se/sv/euro/sport/soccer/english-premier-league/104",
];

// körs IN i sidan: ABM "?tab=all"-listvy renderar 1X2 + totals (+ first-goal/BTTS) per match.
// Varje match ankras av en event-länk /sv/euro/event/<slug>/<id>. Gå upp till match-containern
// och plocka ut 1X2 (hemma/Oavgjort/borta) + totals (Över/Under-par, linjen i elementets fulltext
// "Över 2.5 1.58"). AH visas inte i listvyn (skulle kräva enskild matchsida).
const EXTRACT = () => {
  const num = (t) => Number(String(t).replace(",", "."));
  const rows = []; const seen = new Set(); const samples = [];
  // linje = .0/.5-talet i market-oddens fulltext som INTE är odd:et (odds är sällan exakt X.0/X.5).
  const lineOf = (o) => { const nums = (o.full.match(/\d+(?:\.\d+)?/g) || []).map(num); return nums.find((v) => v !== o.odd && v > 0 && v < 20 && (v * 2) % 1 === 0) ?? null; };
  const links = Array.from(document.querySelectorAll('a[href*="/sv/euro/event/"]'));
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/\/event\/([^/?]+)\/(\d+)/);
    if (!m) continue;
    const eid = m[2];
    if (seen.has(eid)) continue;
    // gå upp till match-containern (element med ≥3 market-odds = minst 1X2)
    let n = a, container = null;
    for (let up = 0; up < 12 && n; up++) {
      if (n.querySelectorAll && n.querySelectorAll('[data-testid="market-odd"]').length >= 3) { container = n; break; }
      n = n.parentElement;
    }
    if (!container) continue;
    const ods = Array.from(container.querySelectorAll('[data-testid="market-odd"]')).map((o) => ({
      label: ((o.querySelector('[class*="info-label"],[class*="label"]') || {}).textContent || "").replace(/\s+/g, " ").trim(),
      odd: num((o.querySelector('[class*="_odd"],[class*="odd-col"]') || {}).textContent || ""),
      full: (o.textContent || "").replace(/\s+/g, " ").trim(),
    }));
    // 1X2: tre i rad där mitten = Oavgjort och ytterkanterna är lagnamn (ej Över/Under/Ja/Nej).
    let one = null, homeTeam = null, awayTeam = null;
    for (let i = 0; i + 2 < ods.length; i++) {
      const A = ods[i], B = ods[i + 1], C = ods[i + 2];
      if (/^(oavgjort|draw|x)$/i.test(B.label) && A.odd > 1 && B.odd > 1 && C.odd > 1 && A.label && C.label && !/över|under|ja|nej|inga mål/i.test(A.label)) {
        one = { home: A.odd, draw: B.odd, away: C.odd }; homeTeam = A.label.slice(0, 40); awayTeam = C.label.slice(0, 40); break;
      }
    }
    if (!one) continue;
    seen.add(eid);
    if (samples.length < 3) samples.push(container.outerHTML.replace(/\s+/g, " ").slice(0, 900));
    // totals: Över/Under-par; linjen ur fulltexten.
    const totals = []; let over = null, overLine = null;
    for (const o of ods) {
      if (/^över$/i.test(o.label)) { over = o.odd; overLine = lineOf(o); }
      else if (/^under$/i.test(o.label)) { const line = overLine ?? lineOf(o); if (over != null && line != null && over > 1 && o.odd > 1) totals.push({ line, over, under: o.odd }); over = null; overLine = null; }
    }
    rows.push({ homeTeam, awayTeam, home: one.home, draw: one.draw, away: one.away, totals, eid, href });
  }
  return { url: location.href, rowCount: rows.length, rows, samples };
};

async function main() {
  installHardDeadline({ budgetMs: Number(process.env.PRONTO_DEADLINE_MS) || 4 * 60 * 1000, label: "prontosport" });
  const diag = { ranAt: new Date().toISOString(), pages: [], builtEvents: 0, notes: [], samples: [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const byTitle = new Map();
  let browser;
  try {
    browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
    const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 1100 } });
    const page = await ctx.newPage();
    // boota SPA på home (CF/cookie-clearance) först
    try { await page.goto("https://sb.prontosport.se/sv/euro/home", { waitUntil: "domcontentloaded", timeout: 35000 }); } catch { /* */ }
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK", "Jag förstår"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(4000);
    for (const url of URLS) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(8000);
        for (let i = 0; i < 4; i++) { try { await page.mouse.wheel(0, 1500); await page.waitForTimeout(1000); } catch { /* */ } }
        const r = await page.evaluate(EXTRACT).catch((e) => ({ url, rowCount: 0, rows: [], samples: [], err: String(e?.message ?? e).slice(0, 80) }));
        diag.pages.push({ url, rowCount: r.rowCount, err: r.err });
        if (r.samples?.length && diag.samples.length < 3) diag.samples.push(...r.samples);
        for (const row of r.rows || []) {
          const homeTeam = row.homeTeam, awayTeam = row.awayTeam;
          const title = `${homeTeam} - ${awayTeam}`;
          if (byTitle.has(title)) continue;
          const ev = { eventId: `prontosport_${row.eid || Buffer.from(title).toString("hex").slice(0, 16)}`, title, homeTeam, awayTeam, startTime: null, league: null, sport: "football", odds: { home: row.home, draw: row.draw, away: row.away } };
          if (Array.isArray(row.totals) && row.totals.length) ev.totals = row.totals;
          byTitle.set(title, ev);
        }
        log(`${url.split("/soccer")[1] || "soccer"} → ${r.rowCount} rader (totalt ${byTitle.size})`);
      } catch (e) { diag.notes.push(`${url}: ${String(e?.message ?? e).slice(0, 80)}`); }
    }
    // OBS (recon 2026-06-25): prontosports matchsida (40 marknader) erbjuder INGEN handicap-
    // marknad — bara 1X2, totals (+ alt-linjer), dubbelchans, rätt resultat, målintervall,
    // BTTS, HT/FT, nästa mål. Asiatiskt handicap erbjuds ej av operatören (likt altenar).
  } catch (e) {
    diag.notes.push(`fel: ${String(e?.message ?? e).slice(0, 160)}`);
    log("fel:", e?.message ?? e);
  } finally {
    try { await browser?.close(); } catch { /* */ }
  }
  const events = [...byTitle.values()];
  diag.builtEvents = events.length;
  diag.withTotals = events.filter((e) => e.totals?.length).length;
  diag.sampleTotals = events.find((e) => e.totals?.length)?.totals ?? null;
  const payload = { updatedAt: new Date().toISOString(), source: "prontosport-abm-dom", partial: false, events };
  const res = writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "prontosport" });
  log(`events=${events.length} (skrivet: ${res.written})`);
  fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
}
main().catch((e) => { console.error("[prontosport] fel:", e); process.exit(1); });
