#!/usr/bin/env node
/**
 * probe-paf-detail.mjs — ISOLERAD recon. Paf-brands är en Kambi-mirror. Vi
 * (1) dumpar ett SEARCH-events fulla struktur (hittar ev. offering/detalj-url),
 * (2) provar flera detalj-endpoint-varianter, (3) provar Kambi-API direkt med
 * gissade offerings. Skriver inget.
 */
const ORIGIN = process.env.PAF_ORIGIN || "https://www.x3000.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json" };

async function getJson(url, extra = {}) {
  try {
    const r = await fetch(url, { headers: { ...H, ...extra } });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* */ }
    return { status: r.status, j, sample: txt.slice(0, 160) };
  } catch (e) { return { status: null, err: e.message }; }
}

async function main() {
  // 1) Hämta ett search-event och dumpa hela strukturen.
  const s = await getJson(`${ORIGIN}/api/betting/search?q=${encodeURIComponent("Arsenal")}`, { Referer: `${ORIGIN}/betting` });
  console.log(`[probe-paf] search status=${s.status}`);
  // Hitta första event i search-svaret (struktur kan variera).
  let ev = null;
  const findEvent = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.eventId && (o.participants || o.betOffers)) { ev ??= o; return; }
    for (const v of Array.isArray(o) ? o : Object.values(o)) findEvent(v);
  };
  findEvent(s.j);
  if (ev) {
    console.log(`[probe-paf] SEARCH-EVENT keys=${JSON.stringify(Object.keys(ev))}`);
    console.log(`[probe-paf] SEARCH-EVENT sample=${JSON.stringify(ev).slice(0, 500)}`);
  } else {
    console.log(`[probe-paf] inget event i search; topp-keys=${JSON.stringify(s.j && typeof s.j === "object" ? Object.keys(s.j) : null)} sample=${s.sample}`);
  }
  const eventId = ev?.eventId;
  if (!eventId) { console.log("[probe-paf] saknar eventId — kan ej testa detalj."); return; }

  // 2) Prova flera detalj-paths.
  const paths = [
    `${ORIGIN}/api/betting/event/${eventId}`,
    `${ORIGIN}/api/event/${eventId}`,
    `${ORIGIN}/api/betting/events/${eventId}`,
    `${ORIGIN}/api/betting/event/${eventId}/betoffers`,
    `${ORIGIN}/api/betting/coupon/event/${eventId}`,
  ];
  for (const p of paths) {
    const r = await getJson(p, { Referer: `${ORIGIN}/betting#event/${eventId}` });
    const bo = r.j?.betOffers;
    console.log(`[probe-paf] PATH ${p.replace(ORIGIN, "")} → ${r.status}${bo ? ` betOffers=${Array.isArray(bo) ? "array(" + bo.length + ")" : "obj:" + JSON.stringify(Object.keys(bo))}` : ""}`);
    if (Array.isArray(bo) && bo.length) {
      const crits = [...new Set(bo.map((o) => o?.criterion?.englishLabel))].slice(0, 20);
      console.log(`[probe-paf]    crits=${JSON.stringify(crits)}`);
      break;
    }
  }

  // 3) Prova Kambi-API direkt med gissade offerings för brandet.
  const offerings = ["x3000", "x3000se", "goldenbull", "onetwo", "speedybet", "paf", "pafse"];
  for (const off of offerings) {
    const r = await getJson(`https://eu-offering-api.kambicdn.com/offering/v2018/${off}/betoffer/event/${eventId}.json?lang=sv_SE&market=SE`);
    if (r.status === 200 && Array.isArray(r.j?.betOffers)) {
      console.log(`[probe-paf] KAMBI offering="${off}" → 200 betOffers=${r.j.betOffers.length} ✅`);
      break;
    } else {
      console.log(`[probe-paf] KAMBI offering="${off}" → ${r.status}`);
    }
  }
  console.log("[probe-paf] klar.");
}
main().catch((e) => { console.error("[probe-paf] fatal:", e?.message ?? e); process.exit(0); });
