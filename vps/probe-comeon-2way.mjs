#!/usr/bin/env node
/**
 * ComeOn 2-vägs-struktur-probe. Söker en basket- + tennis-match, RSocket-hämtar
 * oddsen och DUMPAR selections-strukturen så vi ser vilken marketTypeId som är
 * moneyline (2-vägs) + hur outcomeType/odds ser ut. Read-only.
 *
 * Kör på VPS:en (search + RSocket funkar från clearad IP):
 *   ip netns exec mv node vps/probe-comeon-2way.mjs
 *   (eller utan netns om comeon ej Mullvad-routas)
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import WebSocket from "ws";

const ORIGIN = "https://www.casinostugan.com";
const FRANCHISE = "SWEDEN_CASINOSTUGAN";
const RSOCKET_TIMEOUT_MS = 14_000;

// ---- RSocket-hjälpare (kopierade från fetch-comeon-github-action.mjs) ----
function createRSocketJsonRequest(streamId, route, payload) {
  const routeMetadata = Buffer.concat([Buffer.from([route.length]), Buffer.from(route)]);
  const data = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + 2 + 4 + 3 + routeMetadata.length + data.length);
  let offset = 0;
  frame.writeUInt32BE(streamId, offset); offset += 4;
  frame[offset] = 0x19; frame[offset + 1] = 0x00; offset += 2;
  frame.writeUInt32BE(100000, offset); offset += 4;
  frame.writeUIntBE(routeMetadata.length, offset, 3); offset += 3;
  routeMetadata.copy(frame, offset); offset += routeMetadata.length;
  data.copy(frame, offset);
  return frame;
}
function extractJsonPayloadFromRSocketFrame(data) {
  const text = Buffer.from(data).toString("utf-8");
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  return JSON.parse(text.slice(start));
}
async function rsocketEvents(eventId, marketGroupIds) {
  const setupFrame = Buffer.from("000000000400000100000000ea600001d4c01c6d6573736167652f782e72736f636b65742e726f7574696e672e7630106170706c69636174696f6e2f6a736f6e","hex");
  const payload = { filters: { eventIds: [eventId], ...(marketGroupIds ? { marketGroupIds } : {}), includeEntities: ["MARKET", "SELECTION"] }, orders: [null] };
  const requestFrame = createRSocketJsonRequest(1, "/v4/events", payload);
  const websocketUrl = `wss://${new URL(ORIGIN).hostname}/sportsbook-api/websocket?franchiseCode=${FRANCHISE}&locale=sv`;
  const socket = new WebSocket(websocketUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("timeout")); }, RSOCKET_TIMEOUT_MS);
    socket.on("open", () => { socket.send(setupFrame); socket.send(requestFrame); });
    socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    socket.on("message", (data) => {
      try {
        const json = extractJsonPayloadFromRSocketFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
        if (!json) return;
        clearTimeout(timer); socket.close(); resolve(json);
      } catch (e) { clearTimeout(timer); socket.close(); reject(e); }
    });
  });
}
async function search(query, sportId) {
  const url = `${ORIGIN}/sportsbook-search-service/public/search?franchiseCode=${FRANCHISE}&locale=sv&query=${encodeURIComponent(query)}&eventTypes=Fixture&sportIds=${sportId}`;
  const r = await fetch(url, { headers: { accept: "application/json", origin: ORIGIN, referer: ORIGIN + "/" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { status: r.status, events: [] };
  const d = await r.json();
  return { status: r.status, events: Array.isArray(d?.events) ? d.events : [] };
}

function pinnacleTeams(sport) {
  try {
    const p = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "data/pinnacle-rows.json"), "utf-8"));
    const mu = p?.bySport?.[sport]?.matchups ?? [];
    const names = [];
    for (const m of mu) for (const x of (m.participants ?? [])) if (x?.name) names.push(x.name);
    return [...new Set(names)];
  } catch { return []; }
}

async function probeSport(label, sport, pinnacleSport) {
  console.log(`\n========== ${label} (ComeOn sportId=${sport}) ==========`);
  const teams = pinnacleTeams(pinnacleSport);
  const queries = teams.length ? teams.slice(0, 12) : (sport === 2 ? ["Maccabi", "Real Madrid", "Paris"] : ["Djokovic", "Alcaraz", "Sinner"]);
  let evId = null, foundQ = null;
  for (const q of queries) {
    try {
      const { events } = await search(q, sport);
      const ev = events.find((e) => e.sportId === sport && e.id);
      if (ev) { evId = ev.id; foundQ = q; break; }
    } catch {}
  }
  if (!evId) { console.log("  hittade inget event via sök (queries:", queries.slice(0, 4), "...)"); return; }
  console.log(`  event ${evId} (sökt på "${foundQ}") → RSocket-hämtar marknader…`);
  for (const mg of [[1], null]) {
    try {
      const data = await rsocketEvents(typeof evId === "string" ? evId : String(evId), mg);
      const payload = data?.[0]?.payload ?? data?.payload ?? {};
      const selections = payload.selections ?? [];
      const markets = payload.markets ?? [];
      console.log(`  [marketGroupIds=${JSON.stringify(mg)}] markets=${markets.length} selections=${selections.length}`);
      if (markets.length) {
        console.log("    MARKETS (id, marketTypeId, name):");
        for (const m of markets.slice(0, 8)) console.log(`      id=${m.id} typeId=${m.marketTypeId ?? m.typeId} name=${JSON.stringify(m.name ?? m.label)}`);
      }
      if (selections.length) {
        console.log("    SELECTIONS (marketTypeId, outcomeType, odds, status, points/line):");
        for (const s of selections.slice(0, 14)) {
          const odds = s.trueOdds ?? s.odds ?? s.decimalOdds;
          const line = s.points ?? s.line ?? s.handicap ?? s.value ?? "";
          console.log(`      mTypeId=${s.marketTypeId} outcome=${JSON.stringify(s.outcomeType)} odds=${odds} status=${s.status ?? ""} line=${line}`);
        }
        return; // klart för denna sport
      }
    } catch (e) { console.log(`  [marketGroupIds=${JSON.stringify(mg)}] RSocket-fel: ${String(e?.message ?? e).slice(0, 60)}`); }
  }
}

async function main() {
  await probeSport("BASKET", 2, "basketball");
  await probeSport("TENNIS", 5, "tennis");
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
