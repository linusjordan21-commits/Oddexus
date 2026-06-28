import { describe, it, expect } from "vitest";
import { toSwedishParts, timeBucketSweden, timeToStartSec, timeToStartBucket } from "./swedishTime.ts";

describe("swedishTime — svensk tid + buckets", () => {
  it("sommartid (CEST, UTC+2): 18:00Z → 20:00 svensk tid", () => {
    const p = toSwedishParts("2026-07-01T18:00:00.000Z");
    expect(p).not.toBeNull();
    expect(p!.hour).toBe(20);
    expect(p!.timeBucket).toBe("18-21");
    expect(p!.sweden.startsWith("2026-07-01 20:00")).toBe(true);
  });
  it("vintertid (CET, UTC+1): 18:00Z → 19:00 svensk tid", () => {
    const p = toSwedishParts("2026-01-15T18:00:00.000Z");
    expect(p!.hour).toBe(19);
    expect(p!.timeBucket).toBe("18-21");
  });
  it("veckodag ISO (1=mån … 7=sön): 2026-07-01 är onsdag = 3", () => {
    expect(toSwedishParts("2026-07-01T10:00:00.000Z")!.weekday).toBe(3);
  });
  it("timeBucketSweden delar in i 3h-fönster", () => {
    expect(timeBucketSweden(0)).toBe("00-03");
    expect(timeBucketSweden(20)).toBe("18-21");
    expect(timeBucketSweden(23)).toBe("21-24");
  });
  it("ogiltig input → null", () => {
    expect(toSwedishParts("inte-en-tid")).toBeNull();
    expect(toSwedishParts(null)).toBeNull();
  });
});

describe("swedishTime — time-to-start", () => {
  const now = "2026-07-01T12:00:00.000Z";
  it("räknar sekunder till start", () => {
    expect(timeToStartSec(now, "2026-07-01T13:00:00.000Z")).toBe(3600);
    expect(timeToStartSec(now, "2026-07-01T11:30:00.000Z")).toBe(-1800);
  });
  it("buckets", () => {
    expect(timeToStartBucket(3600 * 50)).toBe("48h+");
    expect(timeToStartBucket(3600 * 30)).toBe("24-48h");
    expect(timeToStartBucket(3600 * 4)).toBe("3-6h");
    expect(timeToStartBucket(3600 * 2)).toBe("1-3h");
    expect(timeToStartBucket(45 * 60)).toBe("30-60m");
    expect(timeToStartBucket(10 * 60)).toBe("0-30m");
    expect(timeToStartBucket(-100)).toBe("started");
    expect(timeToStartBucket(null)).toBeNull();
  });
});
