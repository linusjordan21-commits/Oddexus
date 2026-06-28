/**
 * signalMapping.ts — mappa visade valuebets → persisterbara signal/snapshot-rader.
 *
 * KÄRN-DEDUP (löser "samma valuebet räknas per bok"): signal_id härleds ur
 * market_key (sport+liga+match+market+period+line+selection) — som INTE innehåller
 * boken. Samma marknads-möjlighet hos flera böcker → SAMMA signal_id → en signal,
 * där vi behåller bästa boken (högst EV) och listar alla i `extra.books`.
 *
 * Pure + testbar. Workern (scripts/persist-signals.mjs) hämtar /api/valuebets,
 * grupperar per market_key, och anropar buildSignalRecord + buildSnapshotRecord.
 */

import { buildMarketKey, normalizeSport, type MarketKeyParts, type MarketType, type Selection } from "../markets/marketKey.ts";
import { toSwedishParts, timeToStartSec, timeToStartBucket } from "../markets/swedishTime.ts";

/** Delmängd av ValueBetEntry från /api/valuebets som vi behöver. */
export interface ValueBetLike {
  match: string;
  startTs?: string | number | null;
  league?: string | null;
  sport?: string | null;
  market: string; // moneyline | total | ah | eh3 | corner_total | corner_ah
  outcome: string; // 1/X/2 | over/under | ah_home/ah_away
  line?: number | null;
  bookmakerId?: string | null;
  bookmakerName?: string | null;
  bookmakerOdds: number;
  fairProb?: number | null;
  fairOdds?: number | null;
  ev: number;
  evPct?: number | null;
  pinnacle?: { startTs?: string | number | null; tournament?: string | null; eventId?: string | null; limit?: number | null } | null;
  /** Betfair-likviditet (fas 2) + §2 rå orderbok (back/lay/mid för utfallet) — null om ingen börs-match. */
  betfair?: { liquidityFactor?: number | null; spreadPct?: number | null; matchedVolume?: number | null; back?: number | null; lay?: number | null; mid?: number | null } | null;
  /** Market Trust Layer: per-sharp INDIVIDUELLA fair odds för utfallet (pinnacle/sbobet/betfair). */
  sharpPrices?: { pinnacle?: number | null; sbobet?: number | null; betfair?: number | null } | null;
  sharpSources?: string[] | null;
  /** §3: per-källa feed-färskhet vid detektion (global feed-ålder + om den var färsk nog att blandas). */
  sourceFreshness?: { sbobet?: { age_sec: number | null; fresh: boolean } | null; betfair?: { age_sec: number | null; fresh: boolean } | null } | null;
  needsReview?: boolean;
  comment?: string | null;
}

function toIso(ts: string | number | null | undefined): string | null {
  if (ts == null) return null;
  if (typeof ts === "number") return new Date(ts).toISOString();
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round4 = (v: number | null): number | null => (v == null ? null : Number(v.toFixed(4)));

/**
 * Market Trust Layer — likviditets-/EV-baserade trust-flaggor (spec 5.7). PURE.
 * PRIOR-trösklar (ej CLV-kalibrerade än → fas 4). Persisteras ADDITIVT i extra.trust_flags;
 * ändrar INTE data_quality_flag/status/pris. Tom lista = inga varningar (clean).
 */
export function computeTrustFlags(vb: ValueBetLike): string[] {
  const flags: string[] = [];
  const ev = num(vb.ev) ?? 0;
  const limit = num(vb.pinnacle?.limit ?? null);
  const bf = vb.betfair;
  const bfVol = num(bf?.matchedVolume ?? null);
  const bfSpread = num(bf?.spreadPct ?? null);
  // VIKTIGT: skilj "känd tom" (1X2-vägen sätter sharpSources=[]) från "okänd"
  // (totals/AH-engines sätter den INTE → undefined). Annars falsk pinnacle_only på
  // icke-1X2-marknader. (Cursor Bugbot, PR #11.)
  const sharpKnown = Array.isArray(vb.sharpSources);
  const nSharp = vb.sharpSources?.length ?? 0; // sbobet/betfair som höll med Pinnacle

  if (limit == null) flags.push("unknown_pinnacle_limit");
  else if (limit < 500) flags.push("low_pinnacle_limit"); // tunn/tidig Pinnacle-marknad

  if (!bf) flags.push("no_betfair_confirmation");
  else {
    if (bfVol != null && bfVol < 20000) flags.push("thin_betfair_volume");
    if (bfSpread != null && bfSpread > 2.0) flags.push("wide_betfair_spread");
  }

  // §10: en sharp-feed FANNS men var för gammal (hård-gatad ur blandningen) → data-pipeline-
  // varning, INTE en marknadssignal. Skiljer "stale feed" från "sharpen var oense/saknades".
  const sf = vb.sourceFreshness;
  if (sf?.sbobet && sf.sbobet.age_sec != null && !sf.sbobet.fresh) flags.push("stale_sbobet_feed");
  if (sf?.betfair && sf.betfair.age_sec != null && !sf.betfair.fresh) flags.push("stale_betfair_feed");

  if (sharpKnown && nSharp === 0) flags.push("pinnacle_only"); // ingen sharp bekräftade priset
  else if (sharpKnown && nSharp === 1) flags.push("single_sharp_source"); // bara EN sharp höll med

  // Suspekt EV (spec 5.7): hög EV + svag marknad = ofta fake value (stale/mismatch).
  const weakLiquidity = (limit != null && limit < 500) || !bf || (sharpKnown && nSharp === 0);
  if (ev >= 0.1 && weakLiquidity) flags.push("high_ev_weak_liquidity");

  // sharp_conflict: ≥2 sharps med stor prisspridning (>5%) = de är oense → svagare signal.
  const sp = vb.sharpPrices;
  if (sp) {
    const so = [sp.pinnacle, sp.sbobet, sp.betfair].map((x) => num(x ?? null)).filter((x): x is number => x != null && x > 1);
    if (so.length >= 2) {
      const lo = Math.min(...so), hi = Math.max(...so), mn = so.reduce((a, b) => a + b, 0) / so.length;
      if (mn > 0 && (hi - lo) / mn > 0.05) flags.push("sharp_conflict");
    }
  }

  return flags;
}

/** Pinnacle-limit → likviditetsfaktor 0.4..1.0 (speglar sharpBlend.pinnacleLiquidityFactor). null om okänd. */
function pinLimitFactor(limit: number | null): number | null {
  if (limit == null || !(limit > 0)) return null;
  return Math.max(0.4, Math.min(1.0, 0.4 + 0.6 * Math.min(1, limit / 2500)));
}

/**
 * Market Trust Layer (fas 4): composite liquidity_score 0..1 + grade A–D.
 * ⚠️ PRIOR-heuristik, EJ CLV-kalibrerad än — vikterna (0.55 Pinnacle / 0.45 Betfair) och
 * grade-trösklarna är startvärden som ska tunas mot CLV när data ackumulerats. Råvärdena
 * (pinnacle_limit, betfair) persisteras separat så omkalibrering är möjlig. Ingen källa
 * alls → null/"unknown" (Unknown ≠ dålig). PÅVERKAR EJ pris/rekommendation/lifecycle.
 */
export function computeLiquidityScore(vb: ValueBetLike): { score: number | null; grade: string } {
  const pin = pinLimitFactor(num(vb.pinnacle?.limit ?? null));
  const bf = num(vb.betfair?.liquidityFactor ?? null);
  let score: number | null;
  if (pin != null && bf != null) score = 0.55 * pin + 0.45 * bf;
  else if (pin != null) score = pin;
  else if (bf != null) score = bf;
  else score = null;
  const grade = score == null ? "unknown" : score >= 0.85 ? "A" : score >= 0.7 ? "B" : score >= 0.55 ? "C" : "D";
  return { score: score == null ? null : Number(score.toFixed(4)), grade };
}

/**
 * Market Trust Layer (sharp price/consensus): ur de individuella sharp-priserna
 * (pinnacle/sbobet/betfair fair odds för utfallet) → consensus-mått. PURE.
 *   sources_count, price_spread_pct (range/mean), range_low/high, agreement (tightness),
 *   disagreement, consensus_score (PRIOR: fler källor + tightare = högre), primary_source.
 * 0 källor → allt null/0 (Unknown ≠ dålig). consensus_fair_odds = den blandade fairOdds.
 */
export function computeSharpConsensus(vb: ValueBetLike): {
  consensus_fair_odds: number | null;
  sources_count: number;
  price_spread_pct: number | null;
  range_low: number | null;
  range_high: number | null;
  agreement_score: number | null;
  disagreement_score: number | null;
  consensus_score: number | null;
  primary_source: string | null;
} {
  const sp = vb.sharpPrices;
  const entries: Array<[string, number]> = [];
  for (const key of ["pinnacle", "sbobet", "betfair"] as const) {
    const v = num(sp?.[key] ?? null);
    if (v != null && v > 1) entries.push([key, v]);
  }
  const count = entries.length;
  const blended = num(vb.fairOdds ?? null);
  if (count === 0) {
    return { consensus_fair_odds: blended, sources_count: 0, price_spread_pct: null, range_low: null, range_high: null, agreement_score: null, disagreement_score: null, consensus_score: null, primary_source: null };
  }
  const odds = entries.map(([, v]) => v);
  const low = Math.min(...odds), high = Math.max(...odds);
  const mean = odds.reduce((a, b) => a + b, 0) / count;
  const spreadPct = count >= 2 && mean > 0 ? ((high - low) / mean) * 100 : 0;
  // agreement: tajt spread → 1.0; ≥5% → 0. Meningsfullt först med ≥2 källor.
  const agreement = count >= 2 ? Math.max(0, Math.min(1, 1 - spreadPct / 5)) : null;
  const disagreement = count >= 2 ? Math.max(0, Math.min(1, spreadPct / 5)) : null;
  // consensus_score PRIOR (ej kalibrerad): 1 källa→0.4, 2→0.7, 3→0.9, skalad med agreement.
  const countScore = count >= 3 ? 0.9 : count === 2 ? 0.7 : 0.4;
  const consensusScore = count >= 2 ? Math.max(0, Math.min(1, countScore * (0.5 + 0.5 * (agreement ?? 1)))) : countScore;
  const r4 = (x: number) => Number(x.toFixed(4));
  return {
    consensus_fair_odds: blended,
    sources_count: count,
    price_spread_pct: count >= 2 ? r4(spreadPct) : null,
    range_low: r4(low),
    range_high: r4(high),
    agreement_score: agreement == null ? null : r4(agreement),
    disagreement_score: disagreement == null ? null : r4(disagreement),
    consensus_score: r4(consensusScore),
    primary_source: entries.some(([k]) => k === "pinnacle") ? "pinnacle" : entries[0][0],
  };
}

/**
 * Market Trust Layer (§7): handlings-rekommendation ur EV + liquidity + consensus.
 * ⚠️ PRIOR (ej CLV-kalibrerad). ADDITIV — ändrar INTE EV/pris/valuebet-output, bara en
 * separat rekommendation för observerbarhet:
 *   manual_review = market-mismatch · avoid = hög EV + svag marknad (sannolik fake value)
 *   stake_reduce  = bra EV men svag/ensam likviditet · watch = okänd likviditet
 *   bet           = bra EV + solid likviditet
 */
export function computeRecommendation(vb: ValueBetLike): { action: string; reasons: string[] } {
  if (vb.needsReview) return { action: "manual_review", reasons: ["market_mismatch_risk"] };
  const ev = num(vb.ev) ?? 0;
  const flags = computeTrustFlags(vb);
  const grade = computeLiquidityScore(vb).grade;
  const sc = computeSharpConsensus(vb);
  const weak = flags.includes("high_ev_weak_liquidity") || flags.includes("low_pinnacle_limit") || grade === "D";
  const single = (sc.sources_count != null && sc.sources_count <= 1) || flags.includes("pinnacle_only") || flags.includes("single_sharp_source");
  if (ev >= 0.15 && weak) return { action: "avoid", reasons: ["high_ev_weak_liquidity"] };
  if (weak) return { action: "stake_reduce", reasons: ["weak_liquidity"] };
  if (single) return { action: "stake_reduce", reasons: ["single_source"] };
  if (grade === "unknown") return { action: "watch", reasons: ["unknown_liquidity"] };
  return { action: "bet", reasons: grade ? [`liquidity_${grade}`] : [] };
}

/**
 * Market Trust Layer: slå ihop trust-/likviditets-RÅVÄRDEN + trust-flaggor i extra.
 *   pinnacle_limit (steg 1) + betfair {liquidity_factor, spread_pct, matched_volume} (fas 2)
 *   + trust_flags (fas 3). Saknas en källa → nyckeln utelämnas (Unknown ≠ 0).
 *   Ingen påhittad composite-score (CLV-kalibreras senare).
 */
function mergeTrustExtra(base: Record<string, unknown>, vb: ValueBetLike): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const lim = vb.pinnacle?.limit;
  if (lim != null && Number.isFinite(lim)) out.pinnacle_limit = lim;
  const bf = vb.betfair;
  if (bf) {
    out.betfair = {
      liquidity_factor: num(bf.liquidityFactor ?? null),
      spread_pct: num(bf.spreadPct ?? null),
      matched_volume: num(bf.matchedVolume ?? null),
      // §2: rå börspris för DETTA utfall (bästa back/lay + mid) om tillgängligt.
      back: num(bf.back ?? null),
      lay: num(bf.lay ?? null),
      mid: num(bf.mid ?? null),
    };
  }
  // §3: per-källa feed-färskhet vid detektion (persisteras additivt).
  const sf = vb.sourceFreshness;
  if (sf && (sf.sbobet || sf.betfair)) out.source_freshness = sf;
  const flags = computeTrustFlags(vb);
  if (flags.length) out.trust_flags = flags;
  const liq = computeLiquidityScore(vb);
  if (liq.score != null) {
    out.liquidity_score = liq.score; // PRIOR (se computeLiquidityScore)
    out.liquidity_grade = liq.grade;
  }
  // Individuella sharp-priser + consensus-detalj (fas: sharp price persistence).
  const sc = computeSharpConsensus(vb);
  if (sc.sources_count > 0) {
    out.sharp_prices = {
      pinnacle: num(vb.sharpPrices?.pinnacle ?? null),
      sbobet: num(vb.sharpPrices?.sbobet ?? null),
      betfair: num(vb.sharpPrices?.betfair ?? null),
    };
    out.sharp_consensus = {
      fair_odds: sc.consensus_fair_odds,
      sources_count: sc.sources_count,
      price_spread_pct: sc.price_spread_pct,
      range_low: sc.range_low,
      range_high: sc.range_high,
      agreement_score: sc.agreement_score,
      disagreement_score: sc.disagreement_score,
      consensus_score: sc.consensus_score,
      primary_source: sc.primary_source,
    };
  }
  const rec = computeRecommendation(vb); // §7 PRIOR — additiv rekommendation, ej pris-ändring
  out.recommendation = rec.action;
  if (rec.reasons.length) out.recommendation_reasons = rec.reasons;
  return out;
}

/** Dela "Home - Away" → {home, away}. Tolerant mot " - ", " vs ", "–". */
export function splitMatch(match: string): { home: string; away: string } {
  const m = match.split(/\s+(?:-|–|vs\.?|v)\s+/i);
  return { home: (m[0] ?? "").trim(), away: (m[1] ?? "").trim() };
}

/** Mappa motorns market+outcome → kanonisk marketType + selection. */
export function mapMarket(vb: ValueBetLike): { marketType: MarketType; selection: Selection } {
  // normalizeSport: football/soccer → "football" → 3-vägs moneyline blir korrekt 1x2.
  // Endast äkta 2-way-sporter (tennis/basket) behåller "moneyline".
  const sport = normalizeSport(vb.sport ?? "football");
  const out = (vb.outcome ?? "").toLowerCase();
  switch (vb.market) {
    case "moneyline":
      return {
        marketType: sport === "football" ? "1x2" : "moneyline",
        selection: out === "1" ? "HOME" : out === "x" ? "DRAW" : "AWAY",
      };
    case "total":
      return { marketType: "total", selection: out.includes("over") ? "OVER" : "UNDER" };
    case "ah":
      return { marketType: "ah", selection: out.includes("home") ? "HOME" : "AWAY" };
    case "eh3":
      return { marketType: "eh3", selection: out === "1" ? "HOME" : out === "x" ? "DRAW" : "AWAY" };
    case "corner_total":
      return { marketType: "corner_total", selection: out.includes("over") ? "OVER" : "UNDER" };
    case "corner_ah":
      return { marketType: "corner_ah", selection: out.includes("home") ? "HOME" : "AWAY" };
    default:
      return { marketType: vb.market as MarketType, selection: (out.toUpperCase() as Selection) || "HOME" };
  }
}

export function valueBetToMarketKeyParts(vb: ValueBetLike): MarketKeyParts {
  const { home, away } = splitMatch(vb.match);
  const { marketType, selection } = mapMarket(vb);
  const start = toIso(vb.startTs) ?? toIso(vb.pinnacle?.startTs ?? null);
  return {
    sport: normalizeSport(vb.sport ?? "football"),
    league: vb.league ?? vb.pinnacle?.tournament ?? null,
    eventId: vb.pinnacle?.eventId ?? null,
    homeTeam: home,
    awayTeam: away,
    startTime: start,
    marketType,
    period: "ft",
    line: vb.line ?? null,
    selection,
  };
}

/** Deterministisk, portabel sträng-hash (FNV-1a) → stabilt signal_id utan crypto-dep. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function deriveSignalId(marketKey: string): string {
  return `sig_${fnv1a(marketKey)}`;
}

/**
 * Gruppera valuebets per market_key (DEDUP över böcker). Returnerar grupper med
 * bästa boken (högst EV) först + alla böcker.
 */
export function groupByMarketKey(vbs: ValueBetLike[]): Map<string, { best: ValueBetLike; all: ValueBetLike[]; marketKey: string }> {
  const groups = new Map<string, { best: ValueBetLike; all: ValueBetLike[]; marketKey: string }>();
  for (const vb of vbs) {
    const mk = buildMarketKey(valueBetToMarketKeyParts(vb));
    const g = groups.get(mk);
    if (!g) groups.set(mk, { best: vb, all: [vb], marketKey: mk });
    else {
      g.all.push(vb);
      if (vb.ev > g.best.ev) g.best = vb;
    }
  }
  return groups;
}

// Datakvalitets-trösklar (justerbara). EV i decimalandel.
export const SUSPICIOUS_EV = 0.15; // ≥15% EV = osannolikt äkta → suspicious_ev (data_quality_issue)
export const ELEVATED_EV = 0.1; // 10–15% EV = förhöjd → uncertain (spåras, men märkt)

export interface DataQualityInput {
  ev: number;
  needsReview?: boolean | null;
  eventId?: string | null;
  bookCount?: number;
}

/**
 * Klassa en signals datakvalitet (steg 6). Ren funktion.
 *   suspicious_ev = EV ≥ SUSPICIOUS_EV → nästan alltid stale/mismatch/formatfel (RÖD)
 *   mismatch      = marknads-mismatch-risk flaggad (needsReview) (RÖD)
 *   uncertain     = förhöjd EV, saknad event_id, eller ensam bok m. förhöjd EV (GUL → spåras)
 *   clean         = inga flaggor
 * RÖD → status data_quality_issue (ut ur active); GUL/clean → stannar active.
 */
export function classifyDataQuality(input: DataQualityInput): { flag: string; reasons: string[] } {
  const ev = num(input.ev) ?? 0;
  if (ev >= SUSPICIOUS_EV) return { flag: "suspicious_ev", reasons: [`ev_${(ev * 100).toFixed(1)}pct`] };
  if (input.needsReview) return { flag: "mismatch", reasons: ["market_mismatch_risk"] };
  const reasons: string[] = [];
  if (ev >= ELEVATED_EV) reasons.push("elevated_ev");
  if (!input.eventId) reasons.push("no_event_id");
  if ((input.bookCount ?? 1) <= 1 && ev >= ELEVATED_EV) reasons.push("lone_book_elevated_ev");
  return reasons.length ? { flag: "uncertain", reasons } : { flag: "clean", reasons: [] };
}

export interface SignalRecord {
  signal_id: string;
  market_key: string;
  event_id: string | null;
  sport: string | null;
  league: string | null;
  match: string;
  start_time: string | null;
  start_time_sweden: string | null;
  soft_bookmaker: string | null;
  market_type: string;
  selection: string;
  line: number | null;
  status: string;
  first_detected_at_sweden: string | null;
  last_seen_at: string;
  /** Soft-oddset vid detektion = bet_odds för CLV (settle-tracking-clv.mjs läser denna). */
  soft_odds_at_detection: number;
  current_soft_odds: number;
  sharp_fair_odds: number | null;
  current_ev: number;
  ev_at_detection: number;
  max_ev: number;
  sharp_sources_available: string[];
  market_mismatch_risk: string | null;
  data_quality_flag: string;
  reason_summary: string | null;
  timing_bucket_sweden: string | null;
  hour_of_day_sweden: number | null;
  weekday_sweden: number | null;
  time_to_start_sec: number | null;
  time_to_start_bucket: string | null;
  extra: Record<string, unknown>;
  updated_at: string;
}

/** Bygg en signal-rad (för upsert) ur den bästa boken i en market-grupp. */
export function buildSignalRecord(
  group: { best: ValueBetLike; all: ValueBetLike[]; marketKey: string },
  nowIso: string,
): SignalRecord {
  const vb = group.best;
  const parts = valueBetToMarketKeyParts(vb);
  const startIso = parts.startTime;
  const sw = toSwedishParts(nowIso);
  const tts = timeToStartSec(nowIso, startIso);
  const dq = classifyDataQuality({
    ev: vb.ev,
    needsReview: vb.needsReview,
    eventId: parts.eventId,
    bookCount: group.all.length,
  });
  return {
    signal_id: deriveSignalId(group.marketKey),
    market_key: group.marketKey,
    event_id: parts.eventId,
    sport: parts.sport,
    league: typeof parts.league === "string" ? parts.league : null,
    match: vb.match,
    start_time: startIso,
    start_time_sweden: toSwedishParts(startIso)?.sweden ?? null,
    soft_bookmaker: vb.bookmakerName ?? vb.bookmakerId ?? null,
    market_type: parts.marketType,
    selection: String(parts.selection ?? ""),
    line: parts.line ?? null,
    status: "active",
    first_detected_at_sweden: sw?.sweden ?? null,
    last_seen_at: nowIso,
    // Bet odds för CLV. Vid första insert == current_soft_odds; RPC:n (0013) bevarar
    // detta värde på efterföljande ticks så CLV mäts mot oddset vi FAKTISKT såg.
    soft_odds_at_detection: vb.bookmakerOdds,
    current_soft_odds: vb.bookmakerOdds,
    sharp_fair_odds: vb.fairOdds ?? null,
    current_ev: vb.ev,
    ev_at_detection: vb.ev,
    max_ev: vb.ev,
    sharp_sources_available: vb.sharpSources ?? [],
    market_mismatch_risk: vb.needsReview ? "review" : null,
    data_quality_flag: dq.flag,
    reason_summary: vb.comment ?? null,
    timing_bucket_sweden: sw?.timeBucket ?? null,
    hour_of_day_sweden: sw?.hour ?? null,
    weekday_sweden: sw?.weekday ?? null,
    time_to_start_sec: tts,
    time_to_start_bucket: timeToStartBucket(tts),
    // Market Trust Layer: Pinnacle-limit (steg 1) + Betfair-likviditet (fas 2) som
    // råvärden i extra. Ingen påhittad composite liquidity_score — den (grade) kommer
    // CLV-kalibrerad senare; tills dess Unknown.
    extra: mergeTrustExtra(
      {
        books: group.all.map((b) => ({ book: b.bookmakerName ?? b.bookmakerId, odds: b.bookmakerOdds, ev: b.ev })),
        data_quality_reasons: dq.reasons,
      },
      vb,
    ),
  } as SignalRecord & { updated_at: string };
}

export interface SnapshotRecord {
  snapshot_id: string;
  signal_id: string;
  market_key: string;
  taken_at: string;
  taken_at_sweden: string | null;
  trigger: string;
  hour_of_day_sweden: number | null;
  weekday_sweden: number | null;
  time_bucket_sweden: string | null;
  time_to_start_sec: number | null;
  time_to_start_bucket: string | null;
  soft_odds: number;
  sharp_fair_odds: number | null;
  ev: number;
  market_mismatch_risk: string | null;
  recommended_action_at_time: string;
  /** Market Trust Layer (fas 2): Betfair-likviditet i befintliga decision_snapshots-kolumner. */
  betfair_liquidity?: number | null;
  betfair_spread_score?: number | null;
  /** Market Trust Layer (fas 4): composite liquidity_score (PRIOR, ej kalibrerad än). */
  liquidity_score?: number | null;
  /** Market Trust Layer (sharp consensus): fyller de tidigare döda kolumnerna i 0004. */
  sharp_consensus_fair_odds?: number | null;
  sharp_consensus_score?: number | null;
  sharp_disagreement_score?: number | null;
  extra: Record<string, unknown>;
}

/** En snapshot per worker-körning = tidsserie av beslutspunkter (look-ahead-säker). */
export function buildSnapshotRecord(
  signalId: string,
  group: { best: ValueBetLike; marketKey: string },
  nowIso: string,
  trigger: string,
  extra: Record<string, unknown> = {},
): SnapshotRecord {
  const vb = group.best;
  const parts = valueBetToMarketKeyParts(vb);
  const sw = toSwedishParts(nowIso);
  const tts = timeToStartSec(nowIso, parts.startTime);
  const sc = computeSharpConsensus(vb);
  return {
    snapshot_id: `snap_${fnv1a(`${signalId}|${nowIso}`)}`,
    signal_id: signalId,
    market_key: group.marketKey,
    taken_at: nowIso,
    taken_at_sweden: sw?.sweden ?? null,
    trigger,
    hour_of_day_sweden: sw?.hour ?? null,
    weekday_sweden: sw?.weekday ?? null,
    time_bucket_sweden: sw?.timeBucket ?? null,
    time_to_start_sec: tts,
    time_to_start_bucket: timeToStartBucket(tts),
    soft_odds: vb.bookmakerOdds,
    sharp_fair_odds: vb.fairOdds ?? null,
    ev: vb.ev,
    market_mismatch_risk: vb.needsReview ? "review" : null,
    // §7: liquidity-justerad rekommendation (PRIOR) — ersätter den binära bet/review.
    recommended_action_at_time: computeRecommendation(vb).action,
    // Market Trust Layer: Betfair-likviditet i befintliga kolumner (fas 2) + alla
    // råvärden (Pinnacle-limit + Betfair) i extra. Saknas → Unknown (null / ingen nyckel).
    betfair_liquidity: num(vb.betfair?.matchedVolume ?? null),
    betfair_spread_score: num(vb.betfair?.spreadPct ?? null),
    liquidity_score: computeLiquidityScore(vb).score, // PRIOR — fyller tidigare död kolumn
    // Sharp consensus → fyller de tidigare döda kolumnerna (0004). Per-källa-priser i extra.
    sharp_consensus_fair_odds: sc.consensus_fair_odds,
    sharp_consensus_score: sc.consensus_score,
    sharp_disagreement_score: sc.disagreement_score,
    extra: mergeTrustExtra(extra, vb),
  };
}

/** Föregående persisterade signaltillstånd (för trigger-klassning). */
export interface PrevSignalState {
  current_ev?: number | null;
  current_soft_odds?: number | null;
  sharp_fair_odds?: number | null;
  status?: string | null;
}

// Trösklar för snapshot-triggers (justerbara). EV i decimalandel: 0.01 = 1 procentenhet.
export const EV_MATERIAL_DELTA = 0.01; // ≥1 pp EV-förändring tick→tick = materiell
export const SHARP_MOVE_PCT = 0.03; // ≥3% rörelse i sharp fair odds = sharp-rörelse

/**
 * Klassa VARFÖR denna snapshot är intressant genom att jämföra mot förra tickets
 * persisterade signaltillstånd. Ren funktion — ingen DB, ingen look-ahead.
 *   prev == null              → value_appeared (helt ny signal)
 *   sharp fair odds ↓ ≥3%     → sharp_drop  (marknaden steam:ar mot vårt val → agera nu)
 *   sharp fair odds ↑ ≥3%     → sharp_drift (sharp drar ifrån → edge eroderar)
 *   |ΔEV| ≥ 1 pp              → ev_changed_materially
 *   annars                    → worker_tick (heartbeat; tidsserien bevaras ändå)
 * Deltan läggs i `extra` så dashboards kan rita EV-/sharp-banor utan omräkning.
 */
export function classifySnapshotTrigger(
  prev: PrevSignalState | null | undefined,
  curr: { ev: number; sharp_fair_odds?: number | null },
): { trigger: string; extra: Record<string, unknown> } {
  if (!prev) return { trigger: "value_appeared", extra: {} };
  const prevEv = num(prev.current_ev);
  const prevSharp = num(prev.sharp_fair_odds);
  const currSharp = num(curr.sharp_fair_odds ?? null);
  const evDelta = prevEv != null ? curr.ev - prevEv : null;
  const sharpMovePct =
    prevSharp != null && prevSharp > 0 && currSharp != null ? (currSharp - prevSharp) / prevSharp : null;

  const extra: Record<string, unknown> = {};
  if (prevEv != null) {
    extra.prev_ev = round4(prevEv);
    extra.ev_delta = round4(evDelta);
  }
  if (prevSharp != null) extra.prev_sharp_fair_odds = round4(prevSharp);
  if (sharpMovePct != null) extra.sharp_move_pct = round4(sharpMovePct);

  if (sharpMovePct != null && sharpMovePct <= -SHARP_MOVE_PCT) return { trigger: "sharp_drop", extra };
  if (sharpMovePct != null && sharpMovePct >= SHARP_MOVE_PCT) return { trigger: "sharp_drift", extra };
  if (evDelta != null && Math.abs(evDelta) >= EV_MATERIAL_DELTA) return { trigger: "ev_changed_materially", extra };
  return { trigger: "worker_tick", extra };
}

/** Persisterad signal-rad (DB) — delmängd vi behöver för snapshot utan en färsk valuebet. */
export interface SignalRowLike {
  signal_id: string;
  market_key: string;
  start_time?: string | null;
  current_soft_odds?: number | null;
  sharp_fair_odds?: number | null;
  current_ev?: number | null;
  market_mismatch_risk?: string | null;
}

/**
 * Bygg en snapshot ur en PERSISTERAD signal-rad (inte en färsk valuebet) — används för
 * händelse-snapshots där vi inte har en motorrad: value_disappeared (signalen syns inte
 * längre i feeden) och closing_captured (CLV-settle). Använder radens senast kända värden.
 */
export function snapshotFromSignalRow(
  row: SignalRowLike,
  nowIso: string,
  trigger: string,
  extra: Record<string, unknown> = {},
): SnapshotRecord {
  const sw = toSwedishParts(nowIso);
  const startIso = typeof row.start_time === "string" ? row.start_time : null;
  const tts = timeToStartSec(nowIso, startIso);
  return {
    snapshot_id: `snap_${fnv1a(`${row.signal_id}|${nowIso}`)}`,
    signal_id: row.signal_id,
    market_key: row.market_key,
    taken_at: nowIso,
    taken_at_sweden: sw?.sweden ?? null,
    trigger,
    hour_of_day_sweden: sw?.hour ?? null,
    weekday_sweden: sw?.weekday ?? null,
    time_bucket_sweden: sw?.timeBucket ?? null,
    time_to_start_sec: tts,
    time_to_start_bucket: timeToStartBucket(tts),
    soft_odds: num(row.current_soft_odds) ?? 0,
    sharp_fair_odds: num(row.sharp_fair_odds),
    ev: num(row.current_ev) ?? 0,
    market_mismatch_risk: row.market_mismatch_risk ?? null,
    recommended_action_at_time: row.market_mismatch_risk ? "manual_review" : "bet",
    extra,
  };
}
