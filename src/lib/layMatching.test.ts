import { describe, it, expect } from "vitest";
import { computeLayMatch, layStake } from "./layMatching";

describe("layMatching — matchad betting mot börs", () => {
  it("SR (vanligt bet): de två utfallen är LIKA (matchat) vid rätt lay-insats", () => {
    const r = computeLayMatch({ backStake: 1000, backOdds: 2.0, layOdds: 2.1, commission: 0.02 });
    // Matchat ⇒ profitIfBackWins ≈ profitIfBackLoses
    expect(Math.abs(r.profitIfBackWins - r.profitIfBackLoses)).toBeLessThan(0.01);
    // Lay-insats = B·S/(L−c) = 2·1000/(2.1−0.02) = 2000/2.08 ≈ 961.54
    expect(r.layStake).toBeCloseTo(961.538, 2);
    // Liability = layStake·(L−1)
    expect(r.liability).toBeCloseTo(961.538 * 1.1, 2);
  });

  it("SR: lika back- och lay-odds utan kommission ⇒ noll förlust (perfekt match)", () => {
    const r = computeLayMatch({ backStake: 500, backOdds: 3.0, layOdds: 3.0, commission: 0 });
    expect(r.matchedProfit).toBeCloseTo(0, 6);
    expect(r.profitIfBackWins).toBeCloseTo(r.profitIfBackLoses, 6);
  });

  it("SR: lay-odds högre än back-odds ⇒ liten qualifying-förlust (kostnad)", () => {
    // Smarkets lay 2.10 mot back 2.00, 2% kommission → liten negativ retention.
    const r = computeLayMatch({ backStake: 1000, backOdds: 2.0, layOdds: 2.1, commission: 0.02 });
    expect(r.matchedProfit).toBeLessThan(0);
    expect(r.matchedProfit).toBeGreaterThan(-120); // rimlig storleksordning
  });

  it("SNR (freebet): utfallen matchade, och man får ut en stor andel av freebeten", () => {
    // Freebet 1000 kr, backa höga odds 6.0, laya 6.2, 2% kommission.
    const r = computeLayMatch({ backStake: 1000, backOdds: 6.0, layOdds: 6.2, commission: 0.02, stakeReturned: false });
    expect(Math.abs(r.profitIfBackWins - r.profitIfBackLoses)).toBeLessThan(0.01);
    // layStake = (B−1)·S/(L−c) = 5·1000/(6.2−0.02) = 5000/6.18 ≈ 809.06
    expect(r.layStake).toBeCloseTo(809.06, 1);
    // Freebet ⇒ man behåller en positiv andel (typ ~75-80% av face value).
    expect(r.matchedProfit).toBeGreaterThan(700);
    expect(r.matchedProfit).toBeLessThan(1000);
  });

  it("layStake-formeln skiljer korrekt på SR och SNR", () => {
    const sr = layStake({ backStake: 1000, backOdds: 4.0, layOdds: 4.1, commission: 0.02, stakeReturned: true });
    const snr = layStake({ backStake: 1000, backOdds: 4.0, layOdds: 4.1, commission: 0.02, stakeReturned: false });
    // SR = B·S/(L−c); SNR = (B−1)·S/(L−c) → SNR mindre.
    expect(sr).toBeCloseTo((4.0 * 1000) / (4.1 - 0.02), 2);
    expect(snr).toBeCloseTo((3.0 * 1000) / (4.1 - 0.02), 2);
    expect(snr).toBeLessThan(sr);
  });

  it("ogiltiga lay-odds (≤ kommission) ger 0 lay-insats utan krasch", () => {
    const r = computeLayMatch({ backStake: 1000, backOdds: 2.0, layOdds: 0.01, commission: 0.02 });
    expect(r.layStake).toBe(0);
    expect(Number.isFinite(r.matchedProfit)).toBe(true);
  });
});
