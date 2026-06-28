#!/usr/bin/env node
/**
 * probe-kambi-detail.mjs — ISOLERAD recon (rör ej live-fetchern). Hämtar Kambis
 * per-event detalj-endpoint (/betoffer/event/{id}) för några events ur
 * kambi-rows.json och loggar marknadsstrukturen så vi ser exakt hur totals
 * (Over/Under) + Asian Handicap ser ut (criterion.englishLabel, outcome.label,
 * outcome.line, outcome.odds). Skriver inget. Kör i Actions (egress OK).
 */

import fs from "node:fs";

const OFFERING = process.env.KAMBI_OFFERING || "ubse";
const BASE = "https://eu-offering-api.kambicdn.com/offering/v2018";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function sampleEventIds(n) {
  try {
    const j = JSON.parse(fs.readFileSync("data/kambi-rows.json", "utf-8"));
    const evs = Array.isArray(j.events) ? j.events : [];
    return evs.slice(0, n).map((e) => e.eventId).filter(Boolean);
  } catch (e) {
    console.log("[probe-kambi] kunde ej läsa kambi-rows.json:", e.message);
    return [];
  }
}

async function fetchDetail(eventId) {
  const url = `${BASE}/${OFFERING}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) return { status: r.status, json: null };
  return { status: r.status, json: await r.json() };
}

async function main() {
  const ids = sampleEventIds(4);
  console.log(`[probe-kambi] offering=${OFFERING} sample-events=${JSON.stringify(ids)}`);
  for (const id of ids) {
    const { status, json } = await fetchDetail(id).catch((e) => ({ status: null, json: null, err: e.message }));
    const betOffers = Array.isArray(json?.betOffers) ? json.betOffers : [];
    console.log(`[probe-kambi] event ${id}: status=${status} betOffers=${betOffers.length}`);
    if (!betOffers.length) continue;
    // Distinkta marknadstyper (för att hitta totals + AH).
    const types = [...new Set(betOffers.map((o) => `type=${o?.betOfferType?.englishName} crit=${o?.criterion?.englishLabel}`))];
    console.log(`[probe-kambi]   TYPER: ${JSON.stringify(types.slice(0, 40))}`);
    // Dumpa en totals- och en AH-betoffer i detalj.
    const dump = (o) => ({
      crit: o?.criterion?.englishLabel,
      outcomes: (o?.outcomes ?? []).slice(0, 4).map((x) => ({ label: x.label, line: x.line, odds: x.odds, type: x.type })),
    });
    const tot = betOffers.find((o) => /total|over.?under|o\/u|goals/i.test(String(o?.criterion?.englishLabel ?? "")));
    if (tot) console.log(`[probe-kambi]   TOTALS: ${JSON.stringify(dump(tot))}`);
    const ah = betOffers.find((o) => /handicap|asian/i.test(String(o?.criterion?.englishLabel ?? "")));
    if (ah) console.log(`[probe-kambi]   AH: ${JSON.stringify(dump(ah))}`);
    if (tot || ah) break; // en räcker för kalibrering
  }
  console.log("[probe-kambi] klar.");
}

main().catch((e) => { console.error("[probe-kambi] fatal:", e?.message ?? e); process.exit(0); });
