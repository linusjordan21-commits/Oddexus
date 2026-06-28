#!/usr/bin/env node
/**
 * Standalone Betfair Exchange-skrapa avsedd för GitHub Actions.
 *
 * STATUS: live-verifierad via UK Mullvad-VPN — den publika readonly/bymarket-
 * feeden ger back/lay + djup + matchad volym OAUTENTISERAT (verifierat: 24
 * MATCH_ODDS-events med full ladder). Betfair är geo-blockerat i SE/US, så
 * workflow:t kör genom en UK/IE-relay (se betfair-fetch.yml).
 *
 * Strategin: ladda Betfairs exchange-sida och INTERCEPTA de JSON-svar sidan
 * själv hämtar. Oddsen kommer från `ero.../readonly/v1/bymarket` (eventTypes-
 * form där katalog + order book är joinade). Dessa matas genom den testade
 * parsern parseBymarketBodies (betfairScrapeParse). Marknader utan djup släpps
 * (ingen halvdata) — liquidity-filtret skulle ändå förkasta dem.
 *
 * BETFAIR_DUMP_XHR=1 → recon-läge: dumpa alla JSON/odds-anrop (för kalibrering
 * om feeden ändrar form). Annars av.
 *
 * Skriver data/betfair-rows.json (writeJsonPreservingCache → speglar även till
 * Supabase odds_cache:betfair-rows när SUPABASE_* är satt). Inga secrets här.
 */

import path from "node:path";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { installHardDeadline, writeJsonPreservingCache, readJsonSafe } from "./lib/scrape-guard.mjs";
import { flushOddsDbMirrors } from "./lib/odds-db.mjs";

chromiumExtra.use(StealthPlugin());

const BETFAIR_URL = "https://www.betfair.com/exchange/plus/football";
const DATA_DIR = path.resolve(process.cwd(), "data");
const OUTPUT_FILE = path.join(DATA_DIR, "betfair-rows.json");
// Recon: BETFAIR_DUMP_XHR=1 → logga ALLA JSON/odds-relaterade nätverkssvar
// (URL + form) så vi kan se var oddsen faktiskt kommer ifrån och kalibrera.
const DUMP_XHR = process.env.BETFAIR_DUMP_XHR === "1";

// Heuristik: känns ett interceptat JSON-svar igen som marketCatalogue/Book?
function looksLikeCatalogue(obj) {
  return Array.isArray(obj) && obj.some((m) => m && m.marketId && m.event && Array.isArray(m.runners));
}
function looksLikeBook(obj) {
  return Array.isArray(obj) && obj.some((m) => m && m.marketId && Array.isArray(m.runners) && m.runners.some((r) => r?.ex));
}

async function main() {
  const start = Date.now();
  let enumFetchMs = null; // bymarket-hämtningens tid (observability → summary)
  const deadline = installHardDeadline({
    budgetMs: Number(process.env.BETFAIR_DEADLINE_MS) || 5 * 60 * 1000,
    label: "betfair-action",
  });

  console.log("[betfair-action] Startar headless Chromium med stealth...");
  const browser = await chromiumExtra.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-GB",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Intercepta sidans egna JSON-anrop (marketCatalogue/marketBook-liknande).
  const catalogues = [];
  const books = [];
  const bymarketBodies = []; // ero.../readonly/v1/bymarket-svar (joinad katalog+book)
  const xhrLog = []; // recon: alla JSON/odds-relaterade svar (URL + form)
  const reqLog = []; // recon: REQUEST-payloads (POST-body) för katalog/nav-anrop
  const marketIdsSeen = new Set(); // alla marketIds som sidan refererar i bymarket-URL:er
  // Publik web-app-nyckel (_ak) — ligger i klartext i varje Betfair-URL (ej secret).
  // Default är den observerade; uppdateras från första riktiga URL ifall den roterar.
  let appKey = "nzIFcwyWhrlwYMrh";
  page.on("response", async (res) => {
    try {
      const ct = res.headers()["content-type"] || "";
      const url = res.url();
      const ak = /[?&]_ak=([^&]+)/.exec(url);
      if (ak) appKey = ak[1];
      const isJson = ct.includes("application/json");
      const body = isJson ? await res.json().catch(() => null) : null;
      // Samla alla marketIds sidan begär (för att se hur stor katalog den känner till).
      const midMatch = /marketIds=([0-9.,]+)/.exec(url);
      if (midMatch) for (const id of midMatch[1].split(",")) marketIdsSeen.add(id);
      if (DUMP_XHR && (isJson || /market|exchange|api|odds|price|runner|navigation/i.test(url))) {
        let shape = "";
        if (body) {
          shape = Array.isArray(body)
            ? `array[${body.length}]${body[0] && typeof body[0] === "object" ? " k=" + Object.keys(body[0]).slice(0, 8).join("|") : ""}`
            : `obj{${Object.keys(body).slice(0, 12).join("|")}}`;
        }
        xhrLog.push(`${(ct.split(";")[0] || "?").padEnd(24)} ${url.slice(0, 140)}  ${shape}`);
        // KATALOG-NYCKELN: logga REQUEST-method + POST-body för navigerings-/katalog-
        // anropen → så vi kan REPLIKERA dem med bredare filter (alla matcher + AH/totals).
        if (/navigation\/facet\/v1\/search|exchange\/readonly\/v1\/bymarket|capi-content/i.test(url)) {
          const req = res.request();
          const post = req.postData();
          if (post) reqLog.push(`${req.method()} ${url.slice(0, 110)}\n      BODY=${post.slice(0, 600)}`);
        }
        // Dumpa HELA strukturen för odds- + katalog-endpointsen (en gång var) så
        // vi ser exakt var event-/runner-namn + back/lay-priser ligger → parser.
        if (body && /readonly\/v1\/bymarket/.test(url) && !globalThis.__bfBymarketDumped) {
          globalThis.__bfBymarketDumped = true;
          console.log("[betfair-action] FULLDUMP bymarket=" + JSON.stringify(body).slice(0, 3000));
        }
        // Dumpa flera facet-svar i sin HELHET (results-listan = katalogen vi jagar).
        if (body && /navigation\/facet\/v1\/search/.test(url)) {
          globalThis.__bfFacetN = (globalThis.__bfFacetN ?? 0) + 1;
          if (globalThis.__bfFacetN <= 3) console.log(`[betfair-action] FULLDUMP facet#${globalThis.__bfFacetN}=` + JSON.stringify(body).slice(0, 2500));
        }
      }
      if (!body) return;
      // Fånga sidans EXAKTA request-headers för ett LYCKAT bymarket-anrop (en gång)
      // → så vi kan replikera dem i enum-fetchen (DSC-0018 = saknad header?).
      if (/readonly\/v1\/bymarket/.test(url) && body.eventTypes && !globalThis.__bfReqHdr) {
        globalThis.__bfReqHdr = true;
        try { const h = await res.request().allHeaders(); console.log("[betfair-action] BYMARKET-REQ-HEADERS=" + JSON.stringify(h).slice(0, 700)); } catch { /* ignore */ }
      }
      // Betfairs publika odds-feed: ero.../readonly/v1/bymarket (eventTypes-form).
      if (/readonly\/v1\/bymarket/.test(url) && body.eventTypes) bymarketBodies.push(body);
      else if (looksLikeCatalogue(body)) catalogues.push(...body);
      else if (looksLikeBook(body)) books.push(...body);
    } catch {
      /* ignorera ej-JSON / stängda svar */
    }
  });

  console.log(`[betfair-action] Öppnar ${BETFAIR_URL}...`);
  await page.goto(BETFAIR_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
    console.warn("[betfair-action] goto-fel (fortsätter):", e?.message);
  });
  // Cookie-consent (OneTrust) blockerar ofta att odds-griden + dess XHR laddas.
  for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Accept All Cookies')", "button:has-text('Accept All')", "button:has-text('Accept')"]) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 3000 });
      if (btn) { await btn.click().catch(() => {}); console.log(`[betfair-action] cookies accepterade via ${sel}`); break; }
    } catch { /* nästa selektor */ }
  }
  // Ge sidan tid att hämta sina marknadsdata-XHR (efter ev. cookie-accept).
  await page.waitForTimeout(Number(process.env.BETFAIR_SETTLE_MS) || 15_000);

  // ── KATALOG-ENUMERERING: replikera sidans egen navigation/facet-sökning för att
  // hitta ALLA fotbolls-events + deras marketIds (Match Odds + Over/Under + Asian
  // Handicap), inte bara de ~24 hubben råkar ladda. Körs i sid-kontexten (samma
  // origin/cookies/_ak) → inga CORS/geo-problem. Faller tyst tillbaka på de
  // passivt interceptade svaren om enumereringen misslyckas. ENUM=0 stänger av.
  if (process.env.BETFAIR_ENUM !== "0") {
    try {
      const enumeration = await page.evaluate(async ({ ak, batchSize, conc, marketMaxValues, maxCalls, typesRe }) => {
        const out = { competitions: 0, events: 0, marketIds: [], typeHist: {}, bymarket: [], errors: [] };
        const facetUrl = `https://scan-inbf.betfair.com/www/sports/navigation/facet/v1/search?_ak=${ak}&alt=json`;
        // Deep facet-träd: COMPETITION → EVENT → MARKET. attachments.markets ger
        // marketId → {marketType, eventId}; attachments.events ger eventId → namn/tid.
        const facetBody = {
          filter: {
            marketBettingTypes: ["ASIAN_HANDICAP_SINGLE_LINE", "ASIAN_HANDICAP_DOUBLE_LINE", "ODDS", "LINE"],
            eventTypeIds: [1], productTypes: ["EXCHANGE"],
            contentGroup: { language: "en", regionCode: "UK" }, maxResults: 0,
          },
          facets: [{ type: "COMPETITION", maxValues: 400, skipValues: 0, applyNextTo: 0,
            next: { type: "EVENT", maxValues: 2000, skipValues: 0, applyNextTo: 0,
              next: { type: "MARKET", maxValues: marketMaxValues, skipValues: 0, applyNextTo: 0 } } }],
          currencyCode: "GBP", locale: "en_GB",
        };
        let facetJson;
        try {
          const fr = await fetch(facetUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(facetBody) });
          facetJson = await fr.json();
        } catch (e) { out.errors.push("facet:" + (e?.message || e)); return out; }
        const att = facetJson?.attachments || {};
        out.competitions = Object.keys(att.competitions || {}).length;
        out.events = Object.keys(att.events || {}).length;
        // attachments.markets: marketId → {marketType, eventId, ...}. Gruppera de
        // önskade marknaderna PER EVENT — readonly/bymarket faultar om en förfrågan
        // spänner över flera events (sidan hämtar alltid per-event-grupper). Steg 1
        // scopar MATCH_ODDS (typesRe); AH/totals breddas via BETFAIR_MARKET_TYPES.
        const markets = att.markets || {};
        const wantTypes = new RegExp(typesRe);
        let sampleLogged = false;
        for (const [mid, meta] of Object.entries(markets)) {
          const mt = meta?.marketType || "?";
          out.typeHist[mt] = (out.typeHist[mt] || 0) + 1;
          if (!sampleLogged) { out.sample = { mid, keys: Object.keys(meta || {}), meta: JSON.stringify(meta || {}).slice(0, 200) }; sampleLogged = true; }
          if (!wantTypes.test(mt)) continue;
          out.marketIds.push(mid);
        }
        // Hämta order book i FLATA batchar (sidan batchar markets över FLERA events i
        // ett anrop). KRITISKT: types=-projektionen krävs — utan den faultar readonly
        // med DSC-0018 (det var hela problemet, inte batch/event-gruppering).
        const TYPES = "MARKET_STATE,MARKET_RATES,MARKET_DESCRIPTION,EVENT,RUNNER_DESCRIPTION,RUNNER_STATE,RUNNER_EXCHANGE_PRICES_BEST,RUNNER_METADATA,MARKET_LICENCE,MARKET_LINE_RANGE_INFO";
        const ids = [...new Set(out.marketIds)];
        const batches = [];
        for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
        const capped = batches.slice(0, maxCalls);
        const fetchBatch = async (batch) => {
          const url = `https://ero.betfair.com/www/sports/exchange/readonly/v1/bymarket?_ak=${ak}&alt=json&currencyCode=GBP&locale=en_GB&rollupLimit=10&rollupModel=STAKE&types=${TYPES}&marketIds=${batch.join(",")}`;
          try { const r = await fetch(url, { headers: { "Accept": "application/json, text/plain, */*" } }); return await r.json(); }
          catch (e) { return { __err: String(e?.message || e) }; }
        };
        // Parallellisera bymarket-hämtningen (pool om `conc`) → en full iteration når
        // ~30s-cadens. Måttlig parallellism för att inte trigga rate-limit (DSC-0018).
        const t0 = Date.now();
        for (let i = 0; i < capped.length; i += conc) {
          const group = capped.slice(i, i + conc);
          const results = await Promise.all(group.map(fetchBatch));
          for (const j of results) {
            if (j?.eventTypes) out.bymarket.push(j);
            else if (j?.faultstring && out.errors.length < 3) out.errors.push("fault:" + j.faultstring + " detail=" + JSON.stringify(j.detail || "").slice(0, 120));
            else if (j?.__err && out.errors.length < 5) out.errors.push("net:" + j.__err);
          }
        }
        out.fetchMs = Date.now() - t0;
        return out;
      }, { ak: appKey, batchSize: Number(process.env.BETFAIR_BATCH || 20), conc: Number(process.env.BETFAIR_CONC || 6), marketMaxValues: Number(process.env.BETFAIR_MARKET_MAX || 60), maxCalls: Number(process.env.BETFAIR_MAX_CALLS || 400), typesRe: process.env.BETFAIR_MARKET_TYPES || "^(MATCH_ODDS|OVER_UNDER_[0-9]{2}|ASIAN_HANDICAP)$" });

      enumFetchMs = enumeration.fetchMs ?? null;
      console.log(`[betfair-action] ENUM: ${enumeration.competitions} ligor · ${enumeration.events} events · ${enumeration.marketIds.length} marketIds · ${enumeration.bymarket.length} bymarket-svar · fetch ${enumeration.fetchMs}ms`);
      if (enumeration.sample) console.log(`[betfair-action] ENUM market-sample: ${enumeration.sample.mid} keys=${enumeration.sample.keys.join(",")} ${enumeration.sample.meta}`);
      if (enumeration.errors.length) console.warn("[betfair-action] ENUM-fel:", enumeration.errors.slice(0, 5).join(" | "));
      if (DUMP_XHR) {
        const hist = Object.entries(enumeration.typeHist).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}×${k}`).join("  ");
        console.log(`[betfair-action] ENUM marketType-histogram (katalog): ${hist}`);
        // Dumpa första OVER_UNDER- + ASIAN_HANDICAP-marketNode (HELA strukturen) så
        // vi verifierar linje-/runner-/handicap-fälten innan parsern litar på dem.
        let ouDumped = false, ahDumped = false;
        for (const body of enumeration.bymarket) {
          for (const et of body?.eventTypes ?? []) {
            for (const en of et?.eventNodes ?? []) {
              for (const mn of en?.marketNodes ?? []) {
                const mt = mn?.description?.marketType ?? "";
                if (/^OVER_UNDER_\d{2}$/.test(mt) && !ouDumped) { ouDumped = true; console.log("[betfair-action] DUMP OVER_UNDER=" + JSON.stringify(mn).slice(0, 1400)); }
                if (mt === "ASIAN_HANDICAP" && !ahDumped) { ahDumped = true; console.log("[betfair-action] DUMP ASIAN_HANDICAP=" + JSON.stringify(mn).slice(0, 1600)); }
              }
            }
          }
        }
      }
      // Lägg enumererade bymarket-svar FÖRST (full täckning); passivt interceptade
      // ligger redan i bymarketBodies som komplement (dedup sker i parsern per eventId).
      for (const b of enumeration.bymarket) bymarketBodies.push(b);
    } catch (e) {
      console.warn("[betfair-action] ENUM hoppad (fel):", e?.message || e);
    }
  }

  await browser.close();

  console.log(`[betfair-action] Interceptat: ${bymarketBodies.length} bymarket-svar (${catalogues.length} catalogue, ${books.length} book legacy).`);
  if (DUMP_XHR) {
    console.log(`[betfair-action] XHR-DUMP (${xhrLog.length} JSON/odds-relaterade svar):`);
    for (const l of xhrLog.slice(0, 70)) console.log("  " + l);
    if (xhrLog.length === 0) console.log("  (inga JSON/odds-svar fångades — sidan laddar ev. odds via WebSocket/streaming, eller kräver navigering till en marknad)");
    // Histogram över ALLA marknadstyper feeden faktiskt levererar (visar om AH/
    // totals laddas av hubben + deras exakta marketType-strängar → parser-kalibrering).
    const typeHist = new Map();
    const runnerSamples = new Map(); // marketType → exempel-runnerName (för selection-mappning)
    for (const body of bymarketBodies) {
      for (const et of body?.eventTypes ?? []) {
        for (const en of et?.eventNodes ?? []) {
          for (const mn of en?.marketNodes ?? []) {
            const mt = mn?.description?.marketType ?? "?";
            const mn2 = mn?.description?.marketName ?? "?";
            const key = `${mt} (${mn2})`;
            typeHist.set(key, (typeHist.get(key) ?? 0) + 1);
            if (!runnerSamples.has(mt)) {
              runnerSamples.set(mt, (mn?.runners ?? []).map((r) => r?.description?.runnerName ?? "?").slice(0, 4).join(" | "));
            }
          }
        }
      }
    }
    console.log(`[betfair-action] MARKNADSTYP-HISTOGRAM (${typeHist.size} unika):`);
    for (const [k, n] of [...typeHist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)} × ${k}`);
    console.log("[betfair-action] RUNNER-EXEMPEL per marketType (för selection-mappning):");
    for (const [mt, names] of runnerSamples.entries()) console.log(`  ${mt}: ${names}`);
    // KATALOG-RECON: request-payloads (så vi kan replikera enumereringen) + alla
    // marketIds sidan refererar (visar katalogstorleken bortom de 24 vi parsar).
    console.log(`[betfair-action] REQUEST-PAYLOADS för katalog/nav (${reqLog.length}):`);
    for (const l of reqLog.slice(0, 20)) console.log("  " + l);
    console.log(`[betfair-action] MARKET-IDS sidan refererar (${marketIdsSeen.size} unika): ${[...marketIdsSeen].slice(0, 60).join(",")}`);
  }

  // Parsa via den TESTADE parsern (dynamisk import — .ts via vite ej tillgängligt
  // i ren node; därför kör scrapen i Actions med vite-node ELLER kompileras.
  // För nu: om parsern ej kan laddas, skriv råpaket så ett separat steg parsar).
  let events = [];
  try {
    const mod = await import("../src/lib/odds/betfairScrapeParse.ts");
    // Primärt: bymarket-svaren (publika readonly-feeden). Fallback: legacy
    // catalogue+book om de någonsin skulle dyka upp.
    events = bymarketBodies.length > 0
      ? mod.parseBymarketBodies(bymarketBodies)
      : mod.parseBetfairMarkets(catalogues, books);
  } catch (e) {
    console.warn("[betfair-action] kunde ej ladda parser direkt i node (.ts):", e?.message);
    console.warn("[betfair-action] skriver rå-paket; kör parsern via vite-node i ett separat steg.");
  }

  const isEmpty = (p) => !(p?.summary?.eventCount > 0);
  const countOf = (p) => p?.summary?.eventCount ?? 0;

  const payload = events.length > 0
    ? (() => {
        const byId = {};
        for (const e of events) byId[e.betfairEventId] = e;
        return { updatedAt: new Date().toISOString(), source: "github-actions-scrape", events: byId, summary: { eventCount: events.length, durationMs: Date.now() - start, fetchMs: enumFetchMs } };
      })()
    : {
        updatedAt: new Date().toISOString(),
        source: "github-actions-scrape",
        events: {},
        // Rå-paket bevaras så ett vite-node-steg kan parsa om node ej laddar .ts.
        raw: { catalogues, books },
        summary: { eventCount: 0, rawCatalogues: catalogues.length, rawBooks: books.length, durationMs: Date.now() - start, fetchMs: enumFetchMs },
      };

  deadline.cancel();
  // Skriv aldrig en tom payload över en tidigare bra cache.
  const prev = readJsonSafe(OUTPUT_FILE);
  if (payload.summary.eventCount === 0 && countOf(prev) > 0) {
    console.warn("[betfair-action] 0 events parsade — bevarar tidigare cache (skriver inte tunn data).");
    return;
  }
  writeJsonPreservingCache(OUTPUT_FILE, payload, { label: "betfair-action", isEmpty, countOf });
  console.log(`[betfair-action] Skrev ${OUTPUT_FILE}: ${payload.summary.eventCount} events.`);
  // Vänta in DB-speglingen INNAN processen exit:ar (annars abortas POSTen → DB stale).
  await flushOddsDbMirrors();
}

main().catch((error) => {
  console.error("[betfair-action] Fatal:", error);
  process.exit(1);
});
