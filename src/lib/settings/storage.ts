/**
 * localStorage-läsare/skrivare för user-settings.
 *
 * Designkrav:
 *   - Trasig JSON → fallback till defaults, ingen crash
 *   - Saknad localStorage (SSR / dev-iframe) → fallback till defaults
 *   - Främmande nycklar i payload tolereras (vi plockar bara våra fält)
 *   - Främmande värden (t.ex. language="zh") → fallback per fält
 *
 * Skrivning dispatchar custom event så att andra useUserSettings-instanser
 * i samma tab re-renderas direkt.
 */

import {
  DEFAULT_SETTINGS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_STORAGE_KEY,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LANGUAGES,
  type CurrencyCode,
  type LanguageCode,
  type UserSettings,
} from "./types";

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isLanguage(value: unknown): value is LanguageCode {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

function isCurrency(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Sanitera unknown payload till en garanterat-giltig UserSettings. */
function sanitizeSettings(raw: unknown): UserSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const obj = raw as Record<string, unknown>;
  return {
    language: isLanguage(obj.language) ? obj.language : DEFAULT_SETTINGS.language,
    currency: isCurrency(obj.currency) ? obj.currency : DEFAULT_SETTINGS.currency,
    bankroll:
      typeof obj.bankroll === "number" && Number.isFinite(obj.bankroll) && obj.bankroll >= 0
        ? obj.bankroll
        : undefined,
  };
}

export function loadSettings(): UserSettings {
  const storage = safeLocalStorage();
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeSettings(parsed);
  } catch {
    // JSON.parse-fel eller LocalStorage-access-fel → defaults
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: UserSettings): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    // Notifiera samma-tab-listeners (storage-event triggar inte i samma tab).
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }));
    }
  } catch {
    // QuotaExceeded eller liknande — ignorera tyst, settings förblir minne-only.
  }
}
