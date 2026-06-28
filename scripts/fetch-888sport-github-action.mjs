/**
 * fetch-888sport-github-action.mjs — 888sport (Spectate) odds via prematch-REST.
 *
 * BEVISAD METOD (recon): Spectate exponerar en ren katalog-endpoint
 *   GET https://spectate-web.888sport.se/spectate/sportsbook-req/getUpcomingEvents/football/<tf>
 * som returnerar events{} med markets{}→selections{} INLINE (decimal_price + type
 * "1"=hemma/"X"=oavgjort/"2"=borta). Listan ger 1X2 ("Matchvinnare"). Cloudflare +
 * svensk geo → hämtas via stealth-Chromium bakom Mullvad (samma infra som betsson).
 *
 * Vi laddar /fotboll (CF-clearance) och fångar getUpcomingEvents-svaret, parsar 1X2
 * → kanoniskt events[]-format (samma som coolbet/atg) → 888sport-rows.json.
 * Totals/AH kräver per-event-detalj (framtida iteration).
 *
 * Secret: MULLVAD_WG_CONF (via workflow). Output: data/888sport-rows.json.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { installHardDeadline, writeJsonPreservingCache, filterToWindowHours } from "./lib/scrape-guard.mjs";

chromiumExtra.use(StealthPlugin());

const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "888sport-rows.json");
const DIAG_FILE = path.join(DATA_DIR, "_888sport-scraper-diag.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const log = (...a) => console.log("[888sport]", ...a);
process.on("unhandledRejection", (e) => log("unhandledRejection (ignorerad):", e?.message ?? e));

const PAGE_URL = "https://www.888sport.se/fotboll/";
const TIMEFRAMES = ["today", "tomorrow"]; // giltiga Spectate-tidsfönster (3days/week → 400)

// Bygg kanoniska events ur Spectate-katalogen (events{}→markets{}→selections{}).
function buildEvents(catalogs) {
  const byId = new Map();
  for (const cat of catalogs) {
    const events = cat?.events && typeof cat.events === "object" ? cat.events : {};
    for (const [id, ev] of Object.entries(events)) {
      if (!ev || ev.inplay === true || ev.betable === false) continue;
      if (byId.has(id)) continue; // dedupe över tidsfönster
      const markets = ev.markets && typeof ev.markets === "object" ? ev.markets : {};
      // hitta 1X2-marknaden: name "Matchvinnare" ELLER 3 selections med type 1/X/2
      let one = null, homeName = null, awayName = null;
      for (const mk of Object.values(markets)) {
        if (!mk || mk.tradable === false) continue;
        const sels = mk.selections && typeof mk.selections === "object" ? Object.values(mk.selections) : [];
        const byType = {};
        for (const s of sels) if (s && s.type) byType[String(s.type)] = s;
        const h = byType["1"], d = byType["X"], a = byType["2"];
        const is1x2 = /matchvinnare|full time|1x2|matchresultat/i.test(String(mk.name || "")) || (h && d && a && sels.length === 3);
        if (is1x2 && h && d && a) {
          const hp = Number(h.decimal_price), dp = Number(d.decimal_price), ap = Number(a.decimal_price);
          if (hp > 1 && dp > 1 && ap > 1) { one = { home: hp, draw: dp, away: ap }; homeName = h.name; awayName = a.name; }
          break;
        }
      }
      if (!one) continue; // konsument kräver 1X2

      // lag-namn: helst ur selections (type 1=hemma, 2=borta), annars split på " mot "
      let homeTeam = homeName, awayTeam = awayName;
      if ((!homeTeam || !awayTeam) && typeof ev.name === "string" && / mot /i.test(ev.name)) {
        const parts = ev.name.split(/ mot /i); homeTeam = homeTeam || parts[0]?.trim(); awayTeam = awayTeam || parts[1]?.trim();
      }
      const title = homeTeam && awayTeam ? `${homeTeam} - ${awayTeam}` : String(ev.name || "").trim();
      byId.set(id, {
        eventId: `888sport_${ev.id ?? id}`,
        title, homeTeam: homeTeam ?? null, awayTeam: awayTeam ?? null,
        startTime: ev.start_time ?? null,
        league: ev.tournament_display_name ?? ev.tournament_name ?? null,
        sport: "football",
        odds: one,
      });
    }
  }
  return [...byId.values()];
}

async function main() {
  installHardDeadline({ budgetMs: Number(process.env.S888_DEADLINE_MS) || 4 * 60 * 1000, label: "888sport" });
  const diag = { ranAt: new Date().toISOString(), catalogs: 0, builtEvents: 0, notes: [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const catalogs = [];
  let browser;
  try {
    browser = await chromiumExtra.launch({ headless: process.env.HEADFUL !== "1", args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] });
    const ctx = await browser.newContext({ userAgent: UA, locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    // WS-RECON (temp): fånga websocket-frames → ser om/hur odds (totals/AH) flödar där.
    const wsFrames = [];
    const wsUrls = new Set();
    page.on("websocket", (ws) => {
      try {
        wsUrls.add(ws.url().slice(0, 120));
        ws.on("framereceived", (data) => {
          try {
            const p = typeof data.payload === "string" ? data.payload : (data.payload?.toString?.("utf8") || "");
            if (p && p.length > 40 && wsFrames.length < 12 && /market|selection|odd|price|över|under|handic|mtg|mahcp|\d\.\d{2}/i.test(p)) wsFrames.push(p.slice(0, 700));
          } catch { /* */ }
        });
      } catch { /* */ }
    });
    // fånga getUpcomingEvents-svar som sidan själv hämtar
    page.on("response", (resp) => {
      (async () => {
        try {
          const u = resp.url();
          if (!/spectate-web\.888sport\.se\/spectate\/sportsbook-req\/getUpcomingEvents\/football/i.test(u)) return;
          const j = await resp.json();
          if (j && j.events) { catalogs.push(j); log(`fångade ${u.split("/football/")[1]} → ${Object.keys(j.events).length} events`); }
        } catch { /* */ }
      })();
    });
    // OBS (recon 2026-06-25): Spectates getUpcomingEvents ger bara 1X2. Match-detaljsidan
    // är ett tomt SPA-skal (oddsCount=0, bodyLen~2k) — odds levereras via WEBSOCKET, inte
    // REST/DOM. load/state är bara session. getEvent-varianter → 404. Totals/AH kräver
    // websocket-reverse-engineering (stor insats) → ej implementerat. 1X2 är fullständigt.

    log("laddar /fotboll (CF-clearance)…");
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 35000 });
    for (const t of ["Acceptera alla", "Godkänn alla", "Acceptera", "Accept all", "OK"]) {
      try { await page.getByRole("button", { name: t, exact: false }).first().click({ timeout: 1500 }); break; } catch { /* */ }
    }
    await page.waitForTimeout(10000);
    // klicka "Matcher"/"Kommande" → triggar att sidan hämtar getUpcomingEvents (som recon)
    for (const t of ["Kommande", "Matcher", "Prematch", "Alla"]) {
      try { await page.getByText(t, { exact: false }).first().click({ timeout: 2000 }); log(`klickade "${t}"`); break; } catch { /* */ }
    }
    await page.waitForTimeout(12000); // response-lyssnaren fångar auto-hämtade katalogen

    // hämta tidsfönster via IN-PAGE fetch (kör i sidans CF-clearade kontext m. cookies →
    // mer robust än page.request.get som Cloudflare kan blocka).
    for (const tf of TIMEFRAMES) {
      try {
        const j = await page.evaluate(async (timeframe) => {
          try {
            const r = await fetch(`https://spectate-web.888sport.se/spectate/sportsbook-req/getUpcomingEvents/football/${timeframe}`, { headers: { accept: "application/json" }, credentials: "include" });
            if (!r.ok) return { __err: `HTTP ${r.status}` };
            return await r.json();
          } catch (e) { return { __err: String(e && e.message || e) }; }
        }, tf);
        if (j && j.events) { catalogs.push(j); log(`in-page ${tf} → ${Object.keys(j.events).length} events`); }
        else if (j && j.__err) diag.notes.push(`tf ${tf}: ${j.__err}`);
      } catch (e) { diag.notes.push(`tf ${tf}: ${String(e?.message ?? e).slice(0, 80)}`); }
    }

    // WS-RECON (temp): navigera till en RIKTIG prematch-matchsida (bootad session) → låt
    // websocketen pusha odds. wsFrames fångar payloads → ser om totals/AH går att parsa.
    try {
      let pick = null;
      for (const cat of catalogs) {
        for (const ev of Object.values(cat?.events || {})) {
          const sl = `${ev?.sport_slug || ""}/${ev?.category_slug || ""}/${ev?.tournament_slug || ""}`.toLowerCase();
          if (/esoccer|esport|cyber|virtual/.test(sl)) continue;
          if (ev?.id && ev?.category_slug && ev?.tournament_slug && ev?.slug) { pick = ev; break; }
        }
        if (pick) break;
      }
      if (pick) {
        const murl = `https://www.888sport.se/${pick.sport_slug || "fotboll"}/${pick.category_slug}/${pick.tournament_slug}/${pick.slug}/`;
        await page.goto(murl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(14000); // låt websocketen ansluta + pusha odds
        for (let i = 0; i < 3; i++) { try { await page.mouse.wheel(0, 1200); await page.waitForTimeout(1500); } catch { /* */ } }
        diag.wsRecon = { murl, wsUrls: [...wsUrls].slice(0, 8), frameCount: wsFrames.length, frames: wsFrames.slice(0, 10) };
      } else { diag.wsRecon = { err: "inget icke-esoccer-event med slugs" }; }
    } catch (e) { diag.notes.push(`ws-recon: ${String(e?.message ?? e).slice(0, 80)}`); }

  } catch (e) {
    diag.notes.push(`fel: ${String(e?.message ?? e).slice(0, 160)}`);
    log("fel:", e?.message ?? e);
  } finally {
    try { await browser?.close(); } catch { /* */ }
  }

  diag.catalogs = catalogs.length;
  // OBS: Spectates getUpcomingEvents-katalog returnerar bara huvudmarknaden "Matchvinnare"
  // (1X2) inline — inga totals/AH. De kräver per-event detalj-anrop (ej implementerat).
  const allEvents = buildEvents(catalogs);
  // Fokusera på 24h-fönstret (888sport är gratis men vi håller samma fokus som
  // de betalda källorna så valuebettern jämför imminenta matcher konsekvent).
  const win = filterToWindowHours(allEvents, { windowHours: 24 });
  const events = win.kept;
  diag.droppedOutsideWindow = win.dropped;
  diag.builtEvents = events.length;
  const payload = { updatedAt: new Date().toISOString(), source: "888sport-spectate", partial: false, events };
  const res = writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "888sport" });
  log(`katalog=${catalogs.length} events=${events.length} (skrivet: ${res.written})`);
  fs.writeFileSync(DIAG_FILE, JSON.stringify(diag, null, 2) + "\n");
}

main().catch((e) => { console.error("[888sport] fel:", e); process.exit(1); });
