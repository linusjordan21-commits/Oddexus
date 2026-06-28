/**
 * Settings-sida — språk + valuta för displayformat.
 *
 * INGEN växelkurskonvertering: byter `currency` ändrar bara hur monetära
 * fält (Bet Log stake/profit etc.) presenteras. Stora värden förblir
 * samma siffror.
 *
 * Settings sparas till localStorage via SettingsProvider och synkar till
 * alla wrappade komponenter via React Context (real-time, ingen refresh).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BrandHeader } from "@/components/BrandHeader";
import { useUserSettings } from "@/hooks/useUserSettings";
import type { TranslationKey } from "@/lib/settings/i18n";
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_LANGUAGES,
  type CurrencyCode,
  type LanguageCode,
} from "@/lib/settings/types";

const LANGUAGE_LABEL_KEY: Record<LanguageCode, TranslationKey> = {
  sv: "settings.swedish",
  en: "settings.english",
};

const CURRENCY_LABEL_KEY: Record<CurrencyCode, TranslationKey> = {
  SEK: "settings.currencyOption.sek",
  EUR: "settings.currencyOption.eur",
  USD: "settings.currencyOption.usd",
  GBP: "settings.currencyOption.gbp",
  NGN: "settings.currencyOption.ngn",
};

export default function Settings() {
  const { settings, setLanguage, setCurrency, t, formatMoney } = useUserSettings();
  const [savedFlash, setSavedFlash] = useState(false);

  const handleSaveFlash = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1800);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary/10 to-accent/10">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <BrandHeader className="mb-4" />

        <div className="mb-6 flex items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-1 h-4 w-4" />
              {t("settings.back")}
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Language card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("settings.language")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Label htmlFor="lang-select" className="sr-only">{t("settings.language")}</Label>
              <Select value={settings.language} onValueChange={(v) => setLanguage(v as LanguageCode)}>
                <SelectTrigger id="lang-select" className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_LANGUAGES.map((code) => (
                    <SelectItem key={code} value={code}>{t(LANGUAGE_LABEL_KEY[code])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Currency card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("settings.currency")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="currency-select" className="sr-only">{t("settings.currency")}</Label>
                <Select value={settings.currency} onValueChange={(v) => setCurrency(v as CurrencyCode)}>
                  <SelectTrigger id="currency-select" className="w-full sm:w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_CURRENCIES.map((code) => (
                      <SelectItem key={code} value={code}>{t(CURRENCY_LABEL_KEY[code])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.note.displayOnly")}</p>
              <p className="text-xs text-muted-foreground">{t("settings.note.ngn")}</p>
            </CardContent>
          </Card>

          {/* Preview card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("settings.preview.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted-foreground">{t("settings.preview.exampleStake")}</span>
                <span className="font-mono text-base tabular-nums">{formatMoney(10000)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-muted-foreground">{t("settings.preview.exampleProfit")}</span>
                <span className="font-mono text-base tabular-nums text-emerald-600">
                  {formatMoney(1234.56, { showSign: true })}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Save (decorative — settings are live-saved) */}
          <div className="flex justify-end">
            <Button onClick={handleSaveFlash} variant={savedFlash ? "secondary" : "default"}>
              {savedFlash ? (
                <>
                  <Check className="mr-1 h-4 w-4" />
                  {t("settings.saved")}
                </>
              ) : (
                t("settings.save")
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
