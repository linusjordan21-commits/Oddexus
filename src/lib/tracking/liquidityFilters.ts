/**
 * liquidityFilters.ts — Market Trust Layer (§8): Strategy Lab-filter på den
 * persisterade trust-/likviditets-datan i signalens `extra`-jsonb.
 *
 * PURE + testbar. Backend (/api/tracking/strategy) hämtar valuebet_signals och
 * filtrerar i JS (PostgREST kan inte numerik-jämföra jsonb-fält pålitligt), så
 * att Strategy Lab kan svara "ger hög liquidity / tight consensus / hög limit
 * bättre CLV?". Ändrar ingen prissättning — bara urval för analys.
 */

export interface LiquidityFilterParams {
  /** Min composite liquidity_score (0..1). */
  minLiquidityScore?: number | null;
  /** Exakt grade: "A" | "B" | "C" | "D". */
  liquidityGrade?: string | null;
  /** Min Pinnacle-limit (max-insats). */
  minPinnacleLimit?: number | null;
  /** Min antal sharp-källor som bekräftade (consensus sources_count). */
  minSharpSources?: number | null;
  /** Dölj signaler där liquidity är okänd (ingen grade / "unknown"). */
  excludeUnknownLiquidity?: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Tom = inga aktiva filter (allt passerar). */
export function hasAnyLiquidityFilter(p: LiquidityFilterParams): boolean {
  return Boolean(
    (p.minLiquidityScore != null && p.minLiquidityScore > 0) ||
      p.liquidityGrade ||
      (p.minPinnacleLimit != null && p.minPinnacleLimit > 0) ||
      (p.minSharpSources != null && p.minSharpSources > 0) ||
      p.excludeUnknownLiquidity,
  );
}

/**
 * True om signalens `extra` passerar alla satta liquidity-filter. Okänd data
 * räknas som "passerar inte" för min-trösklar (Unknown ≠ uppfyller kravet), men
 * exkluderas bara explicit av excludeUnknownLiquidity (Unknown ≠ dålig).
 */
export function passesLiquidityFilters(extra: unknown, p: LiquidityFilterParams): boolean {
  const e = (extra && typeof extra === "object" ? extra : {}) as Record<string, unknown>;
  const liq = num(e.liquidity_score);
  const grade = typeof e.liquidity_grade === "string" ? e.liquidity_grade : null;
  const lim = num(e.pinnacle_limit);
  const cons = (e.sharp_consensus && typeof e.sharp_consensus === "object" ? e.sharp_consensus : {}) as Record<string, unknown>;
  const sources = num(cons.sources_count);

  if (p.minLiquidityScore != null && p.minLiquidityScore > 0 && !(liq != null && liq >= p.minLiquidityScore)) return false;
  if (p.liquidityGrade && grade !== p.liquidityGrade) return false;
  if (p.minPinnacleLimit != null && p.minPinnacleLimit > 0 && !(lim != null && lim >= p.minPinnacleLimit)) return false;
  if (p.minSharpSources != null && p.minSharpSources > 0 && !(sources != null && sources >= p.minSharpSources)) return false;
  if (p.excludeUnknownLiquidity && (grade == null || grade === "unknown")) return false;
  return true;
}

/** Parsa filter ur URLSearchParams-lika get(). 0/ogiltigt → null (inget filter). */
export function parseLiquidityFilters(get: (k: string) => string | null): LiquidityFilterParams {
  const n = (k: string): number | null => {
    const v = Number(get(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  return {
    minLiquidityScore: n("min_liquidity_score"),
    liquidityGrade: get("liquidity_grade") || null,
    minPinnacleLimit: n("min_pinnacle_limit"),
    minSharpSources: n("min_sharp_sources"),
    excludeUnknownLiquidity: get("exclude_unknown_liquidity") === "1",
  };
}
