import { describe, it, expect } from "vitest";
import { bookmakerGroup } from "./bookmakerGroups.ts";

describe("bookmakerGroup", () => {
  it("ComeOn-systerbrands → samma grupp 'comeon'", () => {
    for (const b of ["comeon", "Hajper", "Snabbare", "Casinostugan", "Lyllo", "reviant"]) {
      expect(bookmakerGroup(b)).toBe("comeon");
    }
  });
  it("Betsson-grupp", () => {
    expect(bookmakerGroup("betsson")).toBe("betsson");
    expect(bookmakerGroup("Bethard")).toBe("betsson");
    expect(bookmakerGroup("NordicBet")).toBe("betsson");
  });
  it("okänd bok → sig själv (lowercase)", () => {
    expect(bookmakerGroup("PinnacleClone")).toBe("pinnacleclone");
  });
  it("case-insensitivt + trim", () => {
    expect(bookmakerGroup("  HAJPER ")).toBe("comeon");
  });
});
