/**
 * SettingsProvider + useUserSettings(): global app-wide settings via React
 * Context. Hela appen wrappas i <SettingsProvider> i App.tsx. När
 * language/currency byts uppdateras alla aktiva komponenter automatiskt —
 * ingen sid-refresh krävs.
 *
 * Context-värdet exponerar både råa settings, setters och två formaterings-
 * helpers:
 *   - `t(key)`       — översätter via i18n.ts med nuvarande language
 *   - `formatMoney(amount, opts?)` — currency-formatering med nuvarande currency
 *
 * Cross-tab + same-tab-sync funkar fortfarande: `saveSettings` dispatchar
 * custom event som providern lyssnar på, och webbläsarens `storage`-event
 * fångar förändringar från andra tabbar.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { formatCurrency } from "./currency";
import { t as translateFn, type TranslationKey } from "./i18n";
import { loadSettings, saveSettings } from "./storage";
import {
  DEFAULT_SETTINGS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_STORAGE_KEY,
  type CurrencyCode,
  type LanguageCode,
  type UserSettings,
} from "./types";

export interface SettingsContextValue {
  settings: UserSettings;
  setLanguage: (lang: LanguageCode) => void;
  setCurrency: (cur: CurrencyCode) => void;
  updateSettings: (patch: Partial<UserSettings>) => void;
  resetSettings: () => void;
  /** Kortform: översätt en nyckel med nuvarande language. */
  t: (key: TranslationKey) => string;
  /** Kortform: formatera ett belopp med nuvarande currency. */
  formatMoney: (
    amount: number | null | undefined,
    options?: { fractionDigits?: number; showSign?: boolean },
  ) => string;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

interface SettingsProviderProps {
  children: ReactNode;
}

export function SettingsProvider({ children }: SettingsProviderProps) {
  const [settings, setSettingsState] = useState<UserSettings>(() => loadSettings());

  useEffect(() => {
    const handleSameTab = (event: Event) => {
      const detail = (event as CustomEvent<UserSettings>).detail;
      if (detail) setSettingsState(detail);
      else setSettingsState(loadSettings());
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== SETTINGS_STORAGE_KEY) return;
      setSettingsState(loadSettings());
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, handleSameTab as EventListener);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, handleSameTab as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const setLanguage = useCallback(
    (lang: LanguageCode) => updateSettings({ language: lang }),
    [updateSettings],
  );
  const setCurrency = useCallback(
    (cur: CurrencyCode) => updateSettings({ currency: cur }),
    [updateSettings],
  );
  const resetSettings = useCallback(() => {
    saveSettings({ ...DEFAULT_SETTINGS });
    setSettingsState({ ...DEFAULT_SETTINGS });
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      setLanguage,
      setCurrency,
      updateSettings,
      resetSettings,
      t: (key) => translateFn(key, settings.language),
      formatMoney: (amount, options) => formatCurrency(amount, settings.currency, options),
    }),
    [settings, setLanguage, setCurrency, updateSettings, resetSettings],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/**
 * Komponent-hook. Returnerar context om SettingsProvider wrappar appen, annars
 * en degraderad fallback (read-only, defaults från localStorage). Fallbacken
 * finns för defensiv stabilitet — i prod är SettingsProvider alltid mounted i
 * App.tsx.
 */
export function useUserSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (ctx) return ctx;
  // Fallback (no provider mounted — t.ex. unit-tests utan provider): läs
  // settings direkt, men setters är no-ops. Komponenten re-renderar inte
  // när localStorage ändras eftersom vi inte har någon subscription.
  const fallback = loadSettings();
  return {
    settings: fallback,
    setLanguage: () => {},
    setCurrency: () => {},
    updateSettings: () => {},
    resetSettings: () => {},
    t: (key) => translateFn(key, fallback.language),
    formatMoney: (amount, options) => formatCurrency(amount, fallback.currency, options),
  };
}
