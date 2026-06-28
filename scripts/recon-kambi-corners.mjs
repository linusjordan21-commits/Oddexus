#!/usr/bin/env node
/**
 * recon-kambi-corners.mjs — RECON: hitta Kambis HÖRN-marknadskriterier (corners).
 *
 * Kambi-böckerna (svenskaspel/atg/unibet/888sport) exponerar marknader via per-event
 * /betoffer/event/{id}. Vår scraper parsar idag bara 'Total Goals' + 'Asian Handicap'.
 * Hörn finns som egna criterion (t.ex. 'Total Corners' / 'Corner Handicap') men vi vet
 * inte exakta engelska labels eller hur linje/handikapp kodas → denna probe dumpar alla
 * criterion + corner-specifika betOffer-strukturer så vi kan bygga corner-parsern rätt.
 *
 * Output: data/_kambi-corner-recon.json (committas tillbaka). Publik CDN, ingen VPN.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "https://eu-offering-api.kambicdn.com/offering/v2018";
const OFFERING = process.env.KAMBI_OFFERING || "svenskaspel";
const H = { accept: "application/json", "user-agent": "Mozilla/5.0 Chrome/126", referer: "https://spela.svenskaspel.se/oddset" };
const OUT = path.resolve(process.cwd(), "data", "_kambi-corner-recon.json");

async function getJson(u) {
  const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(25000) });
  const t = await r.text();
  try { return { status: r.status, j: JSON.parse(t) }; } catch { return { status: r.status, j: null, head: t.slice(0, 120) }; }
}

async function main() {
  const out = { ranAt: new Date().toISOString(), offering: OFFERING };
  try {
    const lv = await getJson(`${BASE}/${OFFERING}/listView/football/all/all.json?lang=sv_SE&market=SE`);
    out.listViewStatus = lv.status;
    const events = Array.isArray(lv.j?.events) ? lv.j.events : [];
    const footy = events.filter((e) => e?.event?.id && e?.event?.sport === "FOOTBALL").slice(0, 6);
    out.probedEvents = footy.length;
    const allCriteria = {};
    const cornerSamples = [];
    for (const ev of footy) {
      const id = ev.event.id;
      const det = await getJson(`${BASE}/${OFFERING}/betoffer/event/${id}.json?lang=sv_SE&market=SE`);
      const betOffers = Array.isArray(det.j?.betOffers) ? det.j.betOffers : [];
      for (const o of betOffers) {
        const type = o?.betOfferType?.englishName ?? o?.betOfferType?.name ?? "?";
        const crit = o?.criterion?.englishLabel ?? o?.criterion?.label ?? "?";
        const k = `${type} :: ${crit}`;
        allCriteria[k] = (allCriteria[k] || 0) + 1;
        if (/corner|hörn/i.test(k) && cornerSamples.length < 8) {
          cornerSamples.push({
            type, crit,
            tags: o.tags, criterionId: o.criterion?.id,
            outcomes: (o.outcomes || []).slice(0, 6).map((x) => ({ label: x.label, type: x.type, line: x.line, odds: x.odds, participant: x.participant })),
          });
        }
      }
    }
    out.allCriteria = allCriteria;
    out.cornerCriteria = Object.keys(allCriteria).filter((k) => /corner|hörn/i.test(k));
    out.cornerSamples = cornerSamples;
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`[kambi-corner-recon] klart → corners: ${(out.cornerCriteria || []).join(" | ") || "NONE"}`);
}

main().catch((e) => { console.error("[kambi-corner-recon] fatal:", e); process.exit(1); });
