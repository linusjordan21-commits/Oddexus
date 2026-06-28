/**
 * swedishTime.ts — timing-derivat med SVENSK TID som standard.
 *
 * Allt i tracking-/learning-systemet ska kunna analyseras per svensk klocktid,
 * veckodag och time-to-start. Detta är den enda källan för de derivaten så att
 * signals, snapshots, observations och outcomes blir konsekventa. Pure + testbar.
 *
 * Använder Intl.DateTimeFormat med Europe/Stockholm → korrekt sommar/vintertid.
 */

const TZ = "Europe/Stockholm";

const partsFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  mån: 1, tis: 2, ons: 3, tors: 4, fre: 5, lör: 6, sön: 7,
};

export interface SwedishTimeParts {
  /** ISO-strängen som matades in (oförändrad). */
  iso: string;
  /** Läsbar svensk tid, t.ex. "2026-07-01 20:00:00". */
  sweden: string;
  /** Timme 0–23 i svensk tid. */
  hour: number;
  /** Veckodag 1=måndag … 7=söndag (ISO). */
  weekday: number;
  /** Tidsfönster, t.ex. "18-21". */
  timeBucket: string;
}

/** 3-timmarsfönster (svensk tid) → "00-03" … "21-24". */
export function timeBucketSweden(hour: number): string {
  const start = Math.floor(hour / 3) * 3;
  const end = start + 3;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(start)}-${pad(end)}`;
}

/** Härled svensk-tid-delar ur en ISO-tidsstämpel. Returnerar null vid ogiltig input. */
export function toSwedishParts(iso: string | null | undefined): SwedishTimeParts | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const parts = partsFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = Number(get("hour"));
  const wdRaw = get("weekday").toLowerCase().replace(/\.$/, "");
  const weekday = WEEKDAY_INDEX[wdRaw] ?? 0;
  const sweden = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  return {
    iso,
    sweden,
    hour: Number.isFinite(hour) ? hour : 0,
    weekday,
    timeBucket: timeBucketSweden(Number.isFinite(hour) ? hour : 0),
  };
}

export type TimeToStartBucket =
  | "48h+"
  | "24-48h"
  | "12-24h"
  | "6-12h"
  | "3-6h"
  | "1-3h"
  | "30-60m"
  | "0-30m"
  | "started";

/** Time-to-start i sekunder (negativt = redan startat). */
export function timeToStartSec(nowIso: string, startIso: string | null | undefined): number | null {
  if (!startIso) return null;
  const now = Date.parse(nowIso);
  const start = Date.parse(startIso);
  if (!Number.isFinite(now) || !Number.isFinite(start)) return null;
  return Math.round((start - now) / 1000);
}

/** Mappa time-to-start (sekunder) → bucket. */
export function timeToStartBucket(ttsSec: number | null): TimeToStartBucket | null {
  if (ttsSec === null) return null;
  if (ttsSec <= 0) return "started";
  const min = ttsSec / 60;
  const h = min / 60;
  if (h >= 48) return "48h+";
  if (h >= 24) return "24-48h";
  if (h >= 12) return "12-24h";
  if (h >= 6) return "6-12h";
  if (h >= 3) return "3-6h";
  if (h >= 1) return "1-3h";
  if (min >= 30) return "30-60m";
  return "0-30m";
}
