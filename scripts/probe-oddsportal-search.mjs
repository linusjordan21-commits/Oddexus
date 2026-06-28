#!/usr/bin/env node
/**
 * Test: kan vi HITTA en matchs OddsPortal-URL via sök (server-renderad?)?
 * Avgör om discovery för bet365-scrapern håller. Kör via Mullvad.
 *   DISCOVER_Q="Brommapojkarna Degerfors" ip netns exec mv node scripts/probe-oddsportal-search.mjs
 */
const Q = process.env.DISCOVER_Q || "Brommapojkarna Degerfors";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const log = (...a) => console.log("[op-search]", ...a);

async function fetchHtml(url, referer) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: {
    "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7", ...(referer ? { referer } : {}),
  }});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function main() {
  const candidates = [
    `https://www.oddsportal.com/search/?q=${encodeURIComponent(Q)}`,
    `https://www.oddsportal.com/ajax-sport-country-tournament-archive/1/${encodeURIComponent(Q)}/`,
  ];
  for (const url of candidates) {
    log("provar:", url);
    try {
      const html = await fetchHtml(url);
      const dec = html.replace(/&quot;/g, '"').replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
      // match-länkar: /football/<land>/<liga>/<slug-id>/ ELLER /football/h2h/...
      const links = [...new Set([
        ...[...dec.matchAll(/\/football\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+-[A-Za-z0-9]{6,10}\//g)].map((m) => m[0]),
        ...[...dec.matchAll(/\/football\/h2h\/[a-z0-9-]+-[A-Za-z0-9]{6,10}\/[a-z0-9-]+-[A-Za-z0-9]{6,10}\//g)].map((m) => m[0]),
      ])];
      log(`  HTML ${html.length} tecken, hittade ${links.length} match-länkar`);
      links.slice(0, 8).forEach((l) => console.log("    ", l));
      if (links.length) { log("✅ DISCOVERY FUNGERAR via denna URL"); return; }
    } catch (e) { log("  fel:", e.message); }
  }
  log("❌ inga match-länkar (sök troligen JS-renderad)");
}
main().catch((e) => { console.error("[op-search] FATALT:", e?.message ?? e); process.exit(1); });
