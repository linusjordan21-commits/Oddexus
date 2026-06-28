#!/usr/bin/env node
/**
 * Probe: dra ut bet365:s 1X2 från en OddsPortal-matchsida.
 * Speglar exakt logiken i vite.config.ts (decrypt + parse) för att bevisa att
 * hela kedjan fungerar innan vi bygger en full scraper.
 *
 * Kör:  BET365_TEST_URL="https://www.oddsportal.com/football/.../#1X2;2" node scripts/probe-oddsportal-bet365.mjs
 * Via Mullvad om Cloudflare blockar VPS-IP:n:
 *       ip netns exec mv node scripts/probe-oddsportal-bet365.mjs
 */
import crypto from "node:crypto";
import zlib from "node:zlib";

const URL_IN = process.env.BET365_TEST_URL
  || "https://www.oddsportal.com/football/h2h/dep-la-coruna-Q51ZzMS6/las-palmas-IyRQC2vM/#SbKuQc2b:1X2;2";
const AES_KEY = "J*8sQ!p$7aD_fR2yW@gHn*3bVp#sAdLd_k";
const AES_SALT = "5b9a8f2c3e6d1a4b7c8e9d0f1a2b3c4d";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const log = (...a) => console.log("[op-bet365]", ...a);

async function fetchHtml(url, referer) {
  const origin = (() => { try { return new URL(referer ?? url).origin; } catch { return undefined; } })();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache", pragma: "no-cache",
      "sec-fetch-dest": referer ? "iframe" : "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": referer ? "same-site" : "none",
      "upgrade-insecure-requests": "1",
      ...(origin ? { origin } : {}),
      ...(referer ? { referer, "x-requested-with": "XMLHttpRequest" } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function extractPrematchOddsUrl(html) {
  const decoded = html.replace(/&quot;/g, '"').replace(/\\\//g, "/");
  const m = /"requestPreMatch":\{"url":"([^"]+)"/.exec(decoded);
  if (!m) return null;
  return new URL(`${m[1]}${Date.now()}`, "https://www.oddsportal.com").toString();
}

function decrypt(payload) {
  const outer = Buffer.from(payload.trim(), "base64").toString("utf-8");
  const [encB64, ivHex] = outer.split(":");
  if (!encB64 || !ivHex) throw new Error("oväntat krypterat payload");
  const iv = Buffer.from(ivHex.match(/.{1,2}/g)?.map((p) => parseInt(p, 16)) ?? []);
  const key = crypto.pbkdf2Sync(Buffer.from(AES_KEY), Buffer.from(AES_SALT), 1000, 32, "sha256");
  const dec = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const out = Buffer.concat([dec.update(Buffer.from(encB64, "base64")), dec.final()]);
  return (out[0] === 0x1f && out[1] === 0x8b ? zlib.gunzipSync(out) : out).toString("utf-8");
}

function bookmakerSlug(url) { return /\/bookmaker\/([^/]+)\//.exec(url ?? "")?.[1]; }

function parseRows(data) {
  const market = data?.d?.oddsdata?.back?.["E-1-2-0-0-0"];
  if (!market?.odds) return [];
  const names = {};
  for (const [id, urls] of Object.entries(market.bs ?? {})) names[id] = bookmakerSlug((urls || []).find(Boolean)) ?? `id${id}`;
  return Object.entries(market.odds).map(([id, o]) => ({
    bookmaker: names[id] ?? `id${id}`,
    home: Number(o["0"] ?? 0), draw: Number(o["1"] ?? 0), away: Number(o["2"] ?? 0),
  })).filter((r) => r.home > 1 && r.draw > 1 && r.away > 1);
}

async function discoverUpcomingMatch() {
  log("auto-letar kommande match på OddsPortal...");
  for (const page of ["https://www.oddsportal.com/matches/football/", "https://www.oddsportal.com/football/"]) {
    try {
      const h = await fetchHtml(page);
      const dec = h.replace(/&quot;/g, '"').replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
      const urls = [...dec.matchAll(/\/football\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+-[A-Za-z0-9]{6,10}\//g)].map((m) => m[0]);
      const uniq = [...new Set(urls)].filter((u) => !/\/results?\//.test(u));
      if (uniq.length) { log(`hittade ${uniq.length} match-länkar på ${page}`); return "https://www.oddsportal.com" + uniq[0]; }
    } catch (e) { log("discovery-fel:", e.message); }
  }
  return null;
}

async function main() {
  // Använd egen URL bara om BET365_TEST_URL är satt + giltig; annars auto-hitta.
  const envUrl = process.env.BET365_TEST_URL;
  let url = envUrl && /^https?:\/\//.test(envUrl) && !envUrl.includes("<") ? envUrl : null;
  if (!url) {
    url = await discoverUpcomingMatch();
    if (!url) { log("kunde ej auto-hitta match — ange BET365_TEST_URL=<riktig oddsportal-match-url>"); return; }
  }
  log("hämtar matchsida:", url);
  const html = await fetchHtml(url);
  log("sid-HTML hämtad:", html.length, "tecken");
  // Hitta bookmaker ID→namn ur huvudsidan (definitiv mappning).
  const idName = {};
  const dec = html.replace(/&quot;/g, '"').replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
  // a) /bookmaker/<slug>/ + närliggande id, b) "id":NN,"...Name":"namn"
  for (const m of dec.matchAll(/"(?:id|bookmakerId|bookieId)":\s*"?(\d+)"?[^}]{0,80}?"(?:WebName|webName|name|Name|brandName)":\s*"([^"]+)"/g)) idName[m[1]] = m[2];
  for (const m of dec.matchAll(/"(?:WebName|webName|name|Name|brandName)":\s*"([^"]+)"[^}]{0,80}?"(?:id|bookmakerId|bookieId)":\s*"?(\d+)"?/g)) idName[m[2]] = m[1];
  const b365id = Object.entries(idName).find(([, n]) => /bet\s*365/i.test(n))?.[0];
  log("ID→namn hittade:", Object.keys(idName).length, b365id ? `| bet365 = id${b365id}` : "| bet365-id ej hittat i HTML");

  const preUrl = extractPrematchOddsUrl(html);
  if (!preUrl) { log("HITTADE INTE prematch-odds-URL (sidan kanske blockerad/ändrad)"); return; }
  log("prematch-odds-URL:", preUrl.slice(0, 90));
  const enc = await fetchHtml(preUrl, url);
  const decStr = decrypt(enc);
  const json = JSON.parse(decStr);
  // DIAGNOS: var finns bookmaker-namn?
  log("'bet365' förekommer i dekrypterad data:", /bet365/i.test(decStr));
  const mk = json?.d?.oddsdata?.back?.["E-1-2-0-0-0"];
  log("market keys:", mk ? Object.keys(mk) : "(ingen E-1-2-0-0-0)");
  log("market.bs (raw):", JSON.stringify(mk?.bs ?? null).slice(0, 300));
  log("d.oddsdata keys:", json?.d?.oddsdata ? Object.keys(json.d.oddsdata) : "?");
  const rows = parseRows(json);
  // Mappa idXX → namn via huvudsidans mappning
  for (const r of rows) {
    const id = /^id(\d+)$/.exec(r.bookmaker)?.[1];
    if (id && idName[id]) r.bookmaker = idName[id];
  }
  log(`=== ${rows.length} bookmakers med 1X2 ===`);
  rows.forEach((r) => console.log(`   ${r.bookmaker.padEnd(18)} 1=${r.home} X=${r.draw} 2=${r.away}`));
  const b365 = rows.find((r) => /bet\s*365/i.test(r.bookmaker)) || (b365id ? rows.find((r) => r.bookmaker === `id${b365id}`) : null);
  log(b365 ? `🎯 BET365: 1=${b365.home} X=${b365.draw} 2=${b365.away}` : "❌ bet365 fanns ej i denna match (men andra bokis funkar = kedjan OK)");
}
main().catch((e) => { console.error("[op-bet365] FEL:", e?.message ?? e); process.exit(1); });
