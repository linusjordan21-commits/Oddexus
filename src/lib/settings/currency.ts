/**
 * Currency-formatering via `Intl.NumberFormat`. Inga växelkurser, inga
 * konverteringar — `currency` styr bara displayformat (symbol, decimal-
 * separator, gruppering). Stake `10000` med currency `NGN` blir alltså
 * `₦10,000.00`, INTE konverterat till lokal valuta.
 *
 * Locale per currency är vald för att producera den symbol/format-stil
 * användare av respektive currency typiskt förväntar sig:
 *   SEK → sv-SE (suffix "kr" — Sverige skriver `1 234,00 kr`)
 *   EUR → de-DE (Tyskland — €-symbol vänster, komma som decimal)
 *   USD → en-US ($-symbol vänster, punkt som decimal)
 *   GBP → en-GB (£-symbol vänster, punkt som decimal)
 *   NGN → en-NG (₦-symbol vänster, punkt som decimal)
 *
 * En enkel cache av NumberFormat-instanser per (currency, options) eftersom
 * Intl.NumberFormat-skapelse är icke-trivial CPU. Cache rensas aldrig (max
 * ~25 instances i steady state).
 */

import type { CurrencyCode } from "./types";

interface FormatOptions {
  /** Antal decimaler (default beror på currency-konvention). */
  fractionDigits?: number;
  /** Visa explicit + på positiva tal (för profit/loss). */
  showSign?: boolean;
}

const LOCALE_FOR_CURRENCY: Record<CurrencyCode, string> = {
  SEK: "sv-SE",
  EUR: "de-DE",
  USD: "en-US",
  GBP: "en-GB",
  NGN: "en-NG",
};

/** Skärmsymboler — används bara i fallback om Intl saknas. */
export const CURRENCY_SYMBOL: Record<CurrencyCode, string> = {
  SEK: "kr",
  EUR: "€",
  USD: "$",
  GBP: "£",
  NGN: "₦",
};

/** Public helper: hämta symbol för en given currency-kod. */
export function getCurrencySymbol(currency: CurrencyCode): string {
  return CURRENCY_SYMBOL[currency] ?? currency;
}

/** Public helper: hämta locale-kod (BCP-47) för Intl-formatering. */
export function getCurrencyLocale(currency: CurrencyCode): string {
  return LOCALE_FOR_CURRENCY[currency] ?? "en-US";
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function getFormatter(currency: CurrencyCode, fractionDigits: number, signed: boolean): Intl.NumberFormat {
  const cacheKey = `${currency}|${fractionDigits}|${signed ? 1 : 0}`;
  const cached = formatterCache.get(cacheKey);
  if (cached) return cached;
  const locale = LOCALE_FOR_CURRENCY[currency];
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    // `exceptZero` ger +123 men inte +0 — bra för profit/loss-kolumner.
    signDisplay: signed ? "exceptZero" : "auto",
    // Vi vill ha currency-symbol, inte ISO-kod ("USD"). "narrowSymbol" är inte
    // alltid stödd; "symbol" är default och funkar i alla relevanta currencies.
  });
  formatterCache.set(cacheKey, fmt);
  return fmt;
}

/**
 * Formatera ett tal som currency-sträng.
 *
 *   formatCurrency(10000, "NGN") → "₦10,000.00"
 *   formatCurrency(-123.5, "SEK", { fractionDigits: 0 }) → "−124 kr"
 *   formatCurrency(50.25, "USD", { showSign: true }) → "+$50.25"
 *
 * `null`/`undefined`/`NaN`/`Infinity` → "—" (för säkra UI-celler).
 */
export function formatCurrency(
  amount: number | null | undefined,
  currency: CurrencyCode,
  options: FormatOptions = {},
): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const fractionDigits = options.fractionDigits ?? defaultFractionDigits(currency, amount);
  try {
    return getFormatter(currency, fractionDigits, Boolean(options.showSign)).format(amount);
  } catch {
    // Fallback om Intl skulle krascha för en obekant currency.
    const sym = CURRENCY_SYMBOL[currency] ?? currency;
    const fixed = amount.toFixed(fractionDigits);
    const sign = options.showSign && amount > 0 ? "+" : "";
    return `${sign}${sym}${fixed}`;
  }
}

/**
 * Default decimaler: 0 för "hela kronor"-stil (SEK, NGN), 2 för EUR/USD/GBP.
 * Stora belopp visas i regel utan decimaler i sportsbetting; små med 2.
 */
function defaultFractionDigits(currency: CurrencyCode, amount: number): number {
  if (currency === "SEK" || currency === "NGN") {
    return Math.abs(amount) >= 100 ? 0 : 2;
  }
  return 2;
}
