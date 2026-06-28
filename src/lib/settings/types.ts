/**
 * User-settings — språk + valuta. Lagras i localStorage under nyckeln
 * SETTINGS_STORAGE_KEY. Bara display-preferenser, ingen växelkurs-konvertering
 * sker — `currency` styr endast hur monetära fält formateras.
 */

export const SUPPORTED_LANGUAGES = ["sv", "en"] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export const SUPPORTED_CURRENCIES = ["SEK", "EUR", "USD", "GBP", "NGN"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export interface UserSettings {
  language: LanguageCode;
  currency: CurrencyCode;
  /**
   * Användarens aktuella bankroll (samma valuta som `currency`). Används av
   * staking-modellen "Value Adjusted % Bankroll" på valuebets-sidan för att
   * räkna ut rekommenderad insats. `undefined` = ej angiven → inget förslag.
   */
  bankroll?: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  language: "sv",
  currency: "SEK",
  bankroll: undefined,
};

export const SETTINGS_STORAGE_KEY = "parlay-pilot-settings";

/**
 * Custom-event som dispatchas på `window` när settings ändras. Andra hooks/
 * komponenter i samma tab kan lyssna och re-rendera. (localStorage `storage`-
 * eventet triggar bara cross-tab, inte samma tab.)
 */
export const SETTINGS_CHANGED_EVENT = "parlay-pilot-settings-changed";
