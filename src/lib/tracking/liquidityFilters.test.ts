import { describe, it, expect } from "vitest";
import { passesLiquidityFilters, parseLiquidityFilters, hasAnyLiquidityFilter } from "./liquidityFilters.ts";

const extraA = { liquidity_score: 0.9, liquidity_grade: "A", pinnacle_limit: 3000, sharp_consensus: { sources_count: 3 } };
const extraD = { liquidity_score: 0.45, liquidity_grade: "D", pinnacle_limit: 150, sharp_consensus: { sources_count: 1 } };
const extraUnknown = { trust_flags: ["unknown_pinnacle_limit"] }; // ingen liquidity-data

describe("liquidityFilters", () => {
  it("inga filter → allt passerar", () => {
    expect(passesLiquidityFilters(extraD, {})).toBe(true);
    expect(passesLiquidityFilters(extraUnknown, {})).toBe(true);
    expect(hasAnyLiquidityFilter({})).toBe(false);
  });
  it("min_liquidity_score filtrerar bort låga + okända", () => {
    expect(passesLiquidityFilters(extraA, { minLiquidityScore: 0.7 })).toBe(true);
    expect(passesLiquidityFilters(extraD, { minLiquidityScore: 0.7 })).toBe(false);
    expect(passesLiquidityFilters(extraUnknown, { minLiquidityScore: 0.7 })).toBe(false);
  });
  it("liquidity_grade matchar exakt", () => {
    expect(passesLiquidityFilters(extraA, { liquidityGrade: "A" })).toBe(true);
    expect(passesLiquidityFilters(extraD, { liquidityGrade: "A" })).toBe(false);
  });
  it("min_pinnacle_limit", () => {
    expect(passesLiquidityFilters(extraA, { minPinnacleLimit: 1000 })).toBe(true);
    expect(passesLiquidityFilters(extraD, { minPinnacleLimit: 1000 })).toBe(false);
  });
  it("min_sharp_sources (exkluderar single-source)", () => {
    expect(passesLiquidityFilters(extraA, { minSharpSources: 2 })).toBe(true);
    expect(passesLiquidityFilters(extraD, { minSharpSources: 2 })).toBe(false);
  });
  it("exclude_unknown_liquidity döljer bara okänd (Unknown ≠ dålig annars)", () => {
    expect(passesLiquidityFilters(extraUnknown, { excludeUnknownLiquidity: true })).toBe(false);
    expect(passesLiquidityFilters(extraA, { excludeUnknownLiquidity: true })).toBe(true);
    // utan flaggan passerar okänd
    expect(passesLiquidityFilters(extraUnknown, {})).toBe(true);
  });
  it("parseLiquidityFilters: 0/ogiltigt → null, giltiga → satta", () => {
    const m = new Map(Object.entries({ min_liquidity_score: "0.7", liquidity_grade: "A", min_pinnacle_limit: "0", exclude_unknown_liquidity: "1" }));
    const p = parseLiquidityFilters((k) => m.get(k) ?? null);
    expect(p.minLiquidityScore).toBe(0.7);
    expect(p.liquidityGrade).toBe("A");
    expect(p.minPinnacleLimit).toBeNull(); // 0 → null
    expect(p.excludeUnknownLiquidity).toBe(true);
  });
});
