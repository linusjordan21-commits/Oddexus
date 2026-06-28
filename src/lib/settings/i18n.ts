/**
 * App-wide i18n. Två språk: svenska (default) + engelska. Saknad nyckel
 * faller tillbaka till sv → nyckeln själv. Vi kraschar aldrig på en ny
 * nyckel som glömts översättas.
 *
 * Designprincip:
 *   - Inga interpolationer i v1 — keys returnerar ren sträng. Komponenter
 *     komponerar med template strings vid behov (`${t("foo")} 5`).
 *   - Plural-former hanteras manuellt (separata keys ".singular" / ".plural")
 *     bara där det är nödvändigt.
 *   - Backend-fält (gateReason, comment etc.) är fortfarande svenska för nu —
 *     i18n av backend är ett separat projekt.
 */

import type { LanguageCode } from "./types";

export type TranslationKey =
  // -- common --
  | "common.refresh"
  | "common.loading"
  | "common.error"
  | "common.empty"
  | "common.save"
  | "common.saved"
  | "common.cancel"
  | "common.search"
  | "common.filter"
  | "common.filters"
  | "common.all"
  | "common.reset"
  | "common.yes"
  | "common.no"
  | "common.updated"
  | "common.lastUpdated"
  | "common.back"
  | "common.delete"
  | "common.edit"
  | "common.close"
  | "common.never"
  | "common.now"
  | "common.minutesAgo"
  | "common.secondsAgo"
  | "common.add"
  | "common.copy"
  | "common.copied"
  | "common.unknown"
  | "common.unknownError"
  | "common.searching"
  | "common.searchPlaceholder"
  | "common.tryAgain"
  | "common.saveChanges"
  | "common.waiting"
  | "common.fresh"
  | "common.stale"
  | "common.over"
  | "common.under"
  | "outcome.home"
  | "outcome.draw"
  | "outcome.away"
  | "outcome.homeWithCode"
  | "outcome.drawWithCode"
  | "outcome.awayWithCode"
  // -- nav / home --
  | "nav.home"
  | "nav.valuebets"
  | "nav.oddsDrops"
  | "nav.betTracker"
  | "nav.settings"
  | "home.title"
  | "home.tagline"
  | "home.heroHeadline"
  | "home.heroSubtitle"
  | "home.heroBody"
  | "home.heroCta"
  | "home.plaqueTitle"
  | "home.plaqueSub"
  | "home.quote"
  | "home.quoteAuthor"
  | "home.athenaShort"
  | "home.ithacaShort"
  | "home.outisShort"
  | "home.odysseusShort"
  | "home.argosShort"
  | "home.xeniaShort"
  | "home.trust1Title"
  | "home.trust1Sub"
  | "home.trust2Title"
  | "home.trust2Sub"
  | "home.trust3Title"
  | "home.trust3Sub"
  | "home.subtitle"
  | "home.stakeBetonline"
  | "home.stakeBetonlineDescription"
  | "home.valuebets"
  | "home.valuebetsDescription"
  | "home.oddsDrops"
  | "home.oddsDropsDescription"
  | "home.settings"
  | "home.settingsDescription"
  | "home.autoclicker"
  | "home.autoclickerDescription"
  | "home.athena"
  | "home.athenaDescription"
  | "home.bonusFinder"
  | "home.bonusFinderDescription"
  | "home.bonusOptimizer"
  | "home.bonusOptimizerDescription"
  | "home.welcomeBonus"
  | "home.welcomeBonusDescription"
  | "home.soon"
  | "home.sourcesTitle"
  | "home.sourcesSubtitle"
  | "home.sourcesActive"
  | "home.sourcesEmpty"
  | "home.sourcesBlocked"
  | "home.sourcesError"
  | "home.sourcesStale"
  | "home.sourcesOnDemand"
  | "home.sourcesNotConfigured"
  | "home.sourcesPerMatch"
  | "home.sourcesOnRequest"
  | "home.sourcesIntervalOnDemand"
  | "home.sourcesStaleNa"
  | "home.sourcesReason"
  | "home.sourcesPartialRun"
  | "home.sourcesPartialRunHint"
  | "home.sourcesOnDemandExplainer"
  | "home.sourcesLoading"
  | "home.sourcesUpdatedAgo"
  | "home.sourcesRowsLabel"
  | "home.sourcesExternalSignal"
  | "home.sourcesNoData"
  | "home.sourcesRefresh"
  | "home.sourcesColSource"
  | "home.sourcesColType"
  | "home.sourcesColRows"
  | "home.sourcesColUpdated"
  | "home.sourcesColInterval"
  | "home.sourcesColStaleAfter"
  | "home.sourcesColStatus"
  // -- auth --
  | "auth.title"
  | "auth.subtitle"
  | "auth.usernameLabel"
  | "auth.passwordLabel"
  | "auth.loginButton"
  | "auth.loggingIn"
  | "auth.invalidCredentials"
  | "auth.networkError"
  | "auth.logout"
  | "auth.usernamePlaceholder"
  | "auth.passwordPlaceholder"
  // -- billing / prenumeration --
  | "nav.billing"
  | "billing.title"
  | "billing.subtitle"
  | "billing.currentPlan"
  | "billing.activeUntil"
  | "billing.autoRenewOn"
  | "billing.notConfigured"
  | "billing.choosePlan"
  | "billing.perMonth"
  | "billing.upgrade"
  | "billing.yourPlan"
  | "billing.includesValuebets"
  | "billing.includesAutoclicker"
  | "billing.includesNothing"
  | "billing.processing"
  | "billing.backHome"
  | "billing.returnNote"
  // -- admin --
  | "admin.title"
  | "admin.subtitle"
  | "admin.currentUserLabel"
  | "admin.authSourceLabel"
  | "admin.passwordUpdatedAtLabel"
  | "admin.changePasswordHeader"
  | "admin.currentPasswordLabel"
  | "admin.newPasswordLabel"
  | "admin.confirmPasswordLabel"
  | "admin.changePasswordButton"
  | "admin.changingPassword"
  | "admin.passwordChanged"
  | "admin.passwordMismatch"
  | "admin.logoutAllHeader"
  | "admin.logoutAllButton"
  | "admin.logoutAllConfirm"
  | "admin.logoutAllDone"
  | "admin.diskWarningHeader"
  | "admin.diskWarningHint"
  | "admin.navLink"
  // -- valuebets --
  | "valuebets.title"
  | "valuebets.subtitle"
  | "valuebets.liveValuebets"
  | "valuebets.betTracker"
  | "valuebets.bookmaker"
  | "valuebets.bookmakers"
  | "valuebets.match"
  | "valuebets.time"
  | "valuebets.odds"
  | "valuebets.edge"
  | "valuebets.ev"
  | "valuebets.pinnacleOdds"
  | "valuebets.minEv"
  | "valuebets.minOdds"
  | "valuebets.maxOdds"
  | "valuebets.bankroll"
  | "valuebets.stakeRecommended"
  | "valuebets.stakeModel"
  | "valuebets.stakeRisk"
  | "valuebets.stakeNoBet"
  | "valuebets.stakeSetBankroll"
  | "valuebets.stakeApply"
  | "valuebets.hours"
  | "valuebets.timeWindow"
  | "valuebets.noBetsFound"
  | "valuebets.staleGuardTitle"
  | "valuebets.staleGuardBody"
  | "valuebets.logBet"
  | "valuebets.lastUpdated"
  | "valuebets.dataAge"
  | "valuebets.bookmakerFilter"
  | "valuebets.outcome.home"
  | "valuebets.outcome.draw"
  | "valuebets.outcome.away"
  | "valuebets.live"
  | "valuebets.startsIn"
  | "valuebets.minutes"
  | "valuebets.hour"
  | "valuebets.hoursShort"
  | "valuebets.days"
  | "valuebets.activeFilters"
  | "valuebets.pinnacle.fresh"
  | "valuebets.pinnacle.freshHint"
  | "valuebets.pinnacle.cache"
  | "valuebets.pinnacle.cacheHint"
  | "valuebets.pinnacle.stale"
  | "valuebets.pinnacle.staleHint"
  | "valuebets.pinnacle.missing"
  | "valuebets.pinnacle.missingHint"
  | "valuebets.pinnacle.failed"
  | "valuebets.pinnacle.failedHint"
  | "valuebets.bonusIndex.waiting"
  | "valuebets.bonusIndex.waitingHint"
  | "valuebets.bonusIndex.loading"
  | "valuebets.bonusIndex.loadingHint"
  | "valuebets.bonusIndex.ready"
  | "valuebets.bonusIndex.readyHint"
  | "valuebets.bonusIndex.stale"
  | "valuebets.bonusIndex.staleHint"
  | "valuebets.bonusIndex.error"
  | "valuebets.bonusIndex.errorHint"
  | "valuebets.pinnacleOddsTooltip"
  | "valuebets.copyTeamName"
  | "valuebets.opportunity"
  | "valuebets.opportunities"
  | "valuebets.bookmakerListings"
  // -- odds drops / POD --
  | "oddsDrops.title"
  | "oddsDrops.subtitle"
  | "oddsDrops.market"
  | "oddsDrops.selection"
  | "oddsDrops.oldOdds"
  | "oddsDrops.newOdds"
  | "oddsDrops.drop"
  | "oddsDrops.window"
  | "oddsDrops.threshold"
  | "oddsDrops.sport"
  | "oddsDrops.noDropsYet"
  | "oddsDrops.collectingSnapshots"
  | "oddsDrops.lastSnapshot"
  | "oddsDrops.alerts"
  | "oddsDrops.dropDetected"
  | "oddsDrops.timeSinceDrop"
  | "oddsDrops.source"
  | "oddsDrops.snapshots"
  | "oddsDrops.clearHistory"
  // -- bet log / bet tracker --
  | "betLog.title"
  | "betLog.stake"
  | "betLog.profit"
  | "betLog.roi"
  | "betLog.yield"
  | "betLog.clv"
  | "betLog.result"
  | "betLog.finalScore"
  | "betLog.status"
  | "betLog.pending"
  | "betLog.open"
  | "betLog.won"
  | "betLog.lost"
  | "betLog.void"
  | "betLog.totalStake"
  | "betLog.totalProfit"
  | "betLog.addBet"
  | "betLog.editBet"
  | "betLog.deleteBet"
  | "betLog.bookmaker"
  | "betLog.odds"
  | "betLog.date"
  | "betLog.notes"
  | "betLog.units"
  | "betLog.bankroll"
  | "betLog.bankrollDesc"
  | "betLog.bankrollPlaceholder"
  | "betLog.bankrollNotSet"
  | "betLog.bankrollActive"
  | "betLog.match"
  | "betLog.outcome"
  | "betLog.expectedValue"
  | "betLog.hitRate"
  | "betLog.turnover"
  | "betLog.settled"
  | "betLog.bets"
  | "betLog.empty"
  | "betLog.emptyHint"
  | "betLog.confirmDelete"
  | "betLog.confirmDeleteHint"
  | "betLog.profitAndClv"
  | "betLog.profitChartHint"
  | "betLog.noSettledYet"
  | "betLog.noSettledHint"
  | "betLog.addManually"
  | "betLog.statusOpen"
  | "betLog.statusRefunded"
  | "betLog.statusHalfWon"
  | "betLog.statusHalfLost"
  | "betLog.outcomeHome"
  | "betLog.outcomeDraw"
  | "betLog.outcomeAway"
  | "betLog.modalAddManually"
  | "betLog.modalSetResult"
  | "betLog.modalHintFromValuebet"
  | "betLog.modalHintSettle"
  | "betLog.modalHintCreate"
  | "betLog.savedUpdated"
  | "betLog.savedLogged"
  | "betLog.saveFailed"
  | "betLog.closingFairOddsPlaceholder"
  | "betLog.notesPlaceholder"
  | "betLog.evInCurrency"
  | "betLog.liveVsPinnacle"
  | "betLog.pollingPinnacle"
  | "betLog.settledShowsEvAtBetTime"
  | "betLog.evAtBetNotValueAnymore"
  | "betLog.lineClosed"
  | "betLog.lineClosedHint"
  | "betLog.lineGone"
  | "betLog.lineGoneHint"
  | "betLog.evAtBetLabel"
  | "betLog.settleManually"
  | "betLog.settleManuallyHint"
  | "betLog.updateClosingOdds"
  | "betLog.confirmDeleteRow"
  | "betLog.deletedToast"
  | "betLog.importError"
  | "betLog.importSuccess"
  | "betLog.exportSuccessJson"
  | "betLog.exportSuccessCsv"
  | "betLog.couldNotReadFile"
  // -- stake & betonline --
  | "stake.worstCase"
  | "stake.bestPlays"
  | "stake.refreshNow"
  | "stake.refreshing"
  | "stake.firstTimeHint"
  | "stake.noOddsLoaded"
  | "stake.workerCheck"
  | "stake.invalidResponse"
  | "stake.fetchFailed"
  | "stake.refreshFailed"
  | "stake.updatedToast"
  | "stake.result"
  | "stake.fullyAutomatic"
  | "stake.loadingHint"
  | "stake.difference"
  // -- match calculator --
  | "matchCalc.matchWithDay2Money"
  | "matchCalc.useStake"
  | "matchCalc.use"
  | "matchCalc.noDay2Money"
  | "matchCalc.deductFromWinner"
  | "matchCalc.outcomeOverview"
  | "matchCalc.winningBets"
  | "matchCalc.lostBets"
  | "matchCalc.pureProfitGuaranteed"
  | "matchCalc.sameProfitLossRegardless"
  | "matchCalc.noFreebetsLeft"
  // -- welcome bonus / Day 1-3 flow --
  | "welcome.outcomeOverviewDay1"
  | "welcome.bestOddsHint"
  | "welcome.noDataYet"
  | "welcome.day1MoneyOn"
  | "welcome.day3MoneyOn"
  | "welcome.freebetResultQuestion"
  | "welcome.matchedWinnerResultQuestion"
  | "welcome.withdrawableProfitTitle"
  | "welcome.noFreebetWon"
  | "welcome.totalWithdrawable"
  | "welcome.wonOnWinnerMatch"
  | "welcome.accountTurnover"
  | "welcome.needsTurnoverNow"
  | "welcome.day3Wagering"
  | "welcome.savedBets"
  | "welcome.noSavedBets"
  | "welcome.save"
  | "welcome.backToCalculator"
  | "welcome.searchPlaceholder"
  | "welcome.searching"
  | "welcome.searchMatch"
  | "welcome.fetchingOdds"
  | "welcome.fetchOdds"
  | "welcome.minSearchChars"
  | "welcome.examplePlaceholder"
  | "welcome.outcomeHomeWithCode"
  | "welcome.outcomeDrawWithCode"
  | "welcome.outcomeAwayWithCode"
  // -- bonus optimizer --
  | "bonusOpt.hours24"
  | "bonusOpt.hours48"
  | "bonusOpt.hours72"
  | "bonusOpt.loading"
  | "bonusOpt.refresh"
  | "bonusOpt.searching"
  | "bonusOpt.waitingResult"
  | "bonusOpt.noBetsRegistered"
  | "bonusOpt.freebetsThatEqualize"
  | "bonusOpt.earnedFreebets"
  | "bonusOpt.optimizeNextRound"
  | "bonusOpt.requirementsMatched"
  | "bonusOpt.lost"
  | "bonusOpt.waitingResultGeneric"
  | "bonusOpt.consumed"
  | "bonusOpt.available"
  | "bonusOpt.outcome"
  | "bonusOpt.profitModel"
  | "settings.title"
  | "settings.subtitle"
  | "settings.language"
  | "settings.currency"
  | "settings.save"
  | "settings.saved"
  | "settings.swedish"
  | "settings.english"
  | "settings.preview.title"
  | "settings.preview.exampleStake"
  | "settings.preview.exampleProfit"
  | "settings.note.ngn"
  | "settings.note.displayOnly"
  | "settings.back"
  | "settings.currencyOption.sek"
  | "settings.currencyOption.eur"
  | "settings.currencyOption.usd"
  | "settings.currencyOption.gbp"
  | "settings.currencyOption.ngn";

const SV: Record<TranslationKey, string> = {
  // common
  "common.refresh": "Uppdatera",
  "common.loading": "Laddar…",
  "common.error": "Fel",
  "common.empty": "Tomt",
  "common.save": "Spara",
  "common.saved": "Sparat",
  "common.cancel": "Avbryt",
  "common.search": "Sök",
  "common.filter": "Filter",
  "common.filters": "Filter",
  "common.all": "Alla",
  "common.reset": "Återställ",
  "common.yes": "Ja",
  "common.no": "Nej",
  "common.updated": "Uppdaterad",
  "common.lastUpdated": "Senast uppdaterad",
  "common.back": "Tillbaka",
  "common.delete": "Ta bort",
  "common.edit": "Redigera",
  "common.close": "Stäng",
  "common.never": "Aldrig",
  "common.now": "Nu",
  "common.minutesAgo": "min sedan",
  "common.secondsAgo": "sek sedan",
  "common.add": "Lägg till",
  "common.copy": "Kopiera",
  "common.copied": "Kopierat",
  "common.unknown": "okänt",
  "common.unknownError": "Okänt fel",
  "common.searching": "Söker…",
  "common.searchPlaceholder": "Sök…",
  "common.tryAgain": "Försök igen",
  "common.saveChanges": "Spara ändringar",
  "common.waiting": "väntar…",
  "common.fresh": "färsk",
  "common.stale": "stale",
  "common.over": "Över",
  "common.under": "Under",
  "outcome.home": "Hemma",
  "outcome.draw": "Oavgjort",
  "outcome.away": "Borta",
  "outcome.homeWithCode": "Hemma (1)",
  "outcome.drawWithCode": "Oavgjort (X)",
  "outcome.awayWithCode": "Borta (2)",
  // nav / home
  "nav.home": "Hem",
  "nav.valuebets": "Valuebets",
  "nav.oddsDrops": "Odds Drops",
  "nav.betTracker": "Bet Tracker",
  "nav.settings": "Inställningar",
  "home.title": "Välj system",
  "home.tagline": "Edge · Strategi · Frihet",
  "home.heroHeadline": "Strategi. Edge. Frihet.",
  "home.heroSubtitle": "Sex kraftfulla system. En odyssé av möjligheter.",
  "home.heroBody": "Oddexus samlar beprövade metoder, smart automation och exklusiva bonusar – allt för att ge dig ett försprång i varje beslut.",
  "home.heroCta": "Utforska alla system",
  "home.plaqueTitle": "För dig som spelar smart.",
  "home.plaqueSub": "Byggt för edge. Drivet av strategi.",
  "home.quote": "Det är inte vinden som avgör resan, utan kaptenens beslut.",
  "home.quoteAuthor": "Odysseus",
  "home.athenaShort": "AI-assistent för frågor och strategi",
  "home.ithacaShort": "Value betting och långsiktig edge",
  "home.outisShort": "Enkel arbitrage och bonuslägen",
  "home.odysseusShort": "Avancerad arbitrage på flera sidor",
  "home.argosShort": "Automation och desktop-bot",
  "home.xeniaShort": "Stake/BetOnline bonusar och rewards",
  "home.trust1Title": "Säkert & pålitligt",
  "home.trust1Sub": "Trygga verktyg och beprövade metoder.",
  "home.trust2Title": "Bygg din edge",
  "home.trust2Sub": "Strategier som skapar långsiktig vinst.",
  "home.trust3Title": "Din resa. Ditt beslut.",
  "home.trust3Sub": "Du styr resan – vi ger dig kartan.",
  "home.subtitle": "",
  "home.stakeBetonline": "Xenia",
  "home.stakeBetonlineDescription": "Start för Stake/BetOnline odds och import.",
  "home.valuebets": "Ithaca",
  "home.valuebetsDescription": "Hitta värdebets via Pinnacle no-vig vs svenska sidor.",
  "home.oddsDrops": "Odds Drops",
  "home.oddsDropsDescription": "Följ Pinnacle-marknaden och fånga sharp drops i realtid.",
  "home.settings": "Inställningar",
  "home.settingsDescription": "Språk och valuta (SEK, EUR, USD, GBP, NGN).",
  "home.autoclicker": "Argos",
  "home.autoclickerDescription": "Licens, nedladdning och instruktioner för desktop-botten.",
  "home.athena": "Athena",
  "home.athenaDescription": "Din AI-assistent. Fråga om value betting, bonusuttag, Stake/BetOnline – svar från communityns kunskapsbas + allmän AI.",
  "home.bonusFinder": "Outis",
  "home.bonusFinderDescription": "Välj vilken bookmaker du har bonus hos och hitta fotbolls-1X2-matcher där bonusen kan omsättas med låg beräknad kvalificeringsförlust.",
  "home.bonusOptimizer": "Odysseus",
  "home.bonusOptimizerDescription": "Hitta bästa matcher och optimera bonusarna automatiskt.",
  "home.welcomeBonus": "Välkomst bonusar",
  "home.welcomeBonusDescription": "Manuellt flöde för loggade bonusar (Walter m.fl.) — Dag 1, Dag 2, Dag 3.",
  "home.soon": "Snart",
  "home.sourcesTitle": "Källor & bookmakers",
  "home.sourcesSubtitle": "Hälsa per datakälla — uppdateras automatiskt.",
  "home.sourcesActive": "active",
  "home.sourcesEmpty": "empty",
  "home.sourcesBlocked": "blocked",
  "home.sourcesError": "error",
  "home.sourcesStale": "stale",
  "home.sourcesOnDemand": "on demand",
  "home.sourcesNotConfigured": "not configured",
  "home.sourcesPerMatch": "per match",
  "home.sourcesOnRequest": "vid förfrågan",
  "home.sourcesIntervalOnDemand": "on demand",
  "home.sourcesStaleNa": "n/a",
  "home.sourcesReason": "Orsak",
  "home.sourcesPartialRun": "partiell körning",
  "home.sourcesPartialRunHint": "Senaste hämtningen avbröts av tidsgränsen och sparade det den hunnit — färsk men reducerad täckning denna cykel. Nästa körning krymper budgeten automatiskt för att hinna klart.",
  "home.sourcesOnDemandExplainer": "On-demand bookmakers hämtas vid matchning mot Pinnacle och har därför ingen egen cache med rows/updatedAt.",
  "home.sourcesLoading": "Laddar källor…",
  "home.sourcesUpdatedAgo": "uppdaterad {seconds}s sedan",
  "home.sourcesRowsLabel": "{count} rader",
  "home.sourcesExternalSignal": "external signal",
  "home.sourcesNoData": "Ingen data",
  "home.sourcesRefresh": "Uppdatera",
  "home.sourcesColSource": "Källa",
  "home.sourcesColType": "Typ",
  "home.sourcesColRows": "Rader",
  "home.sourcesColUpdated": "Uppdaterad",
  "home.sourcesColInterval": "Intervall",
  "home.sourcesColStaleAfter": "Stale efter",
  "home.sourcesColStatus": "Status",
  // auth
  "auth.title": "Logga in",
  "auth.subtitle": "Ange dina uppgifter för att fortsätta",
  "auth.usernameLabel": "Användarnamn",
  "auth.passwordLabel": "Lösenord",
  "auth.loginButton": "Logga in",
  "auth.loggingIn": "Loggar in…",
  "auth.invalidCredentials": "Fel användarnamn eller lösenord",
  "auth.networkError": "Nätverksfel — försök igen",
  "auth.logout": "Logga ut",
  "nav.billing": "Abonnemang",
  "billing.title": "Abonnemang",
  "billing.subtitle": "Välj en nivå och lås upp fler verktyg.",
  "billing.currentPlan": "Din nuvarande nivå",
  "billing.activeUntil": "Aktiv t.o.m.",
  "billing.autoRenewOn": "Förnyas automatiskt varje månad",
  "billing.notConfigured": "Betalning är inte aktiverad ännu. Kontakta supporten så aktiverar vi din nivå manuellt.",
  "billing.choosePlan": "Välj nivå",
  "billing.perMonth": "/mån",
  "billing.upgrade": "Uppgradera",
  "billing.yourPlan": "Din nivå",
  "billing.includesValuebets": "Ithaca (value betting)",
  "billing.includesAutoclicker": "Argos (autoclicker)",
  "billing.includesNothing": "Grundåtkomst",
  "billing.processing": "Skickar dig till betalning…",
  "billing.backHome": "Tillbaka",
  "billing.returnNote": "Tack! Din betalning behandlas — din nivå aktiveras inom kort.",
  "auth.usernamePlaceholder": "användarnamn",
  "auth.passwordPlaceholder": "lösenord",
  // admin
  "admin.title": "Admin",
  "admin.subtitle": "Hantera inloggning och sessioner",
  "admin.currentUserLabel": "Inloggad som",
  "admin.authSourceLabel": "Lösenordskälla",
  "admin.passwordUpdatedAtLabel": "Senast ändrat",
  "admin.changePasswordHeader": "Ändra lösenord",
  "admin.currentPasswordLabel": "Nuvarande lösenord",
  "admin.newPasswordLabel": "Nytt lösenord",
  "admin.confirmPasswordLabel": "Bekräfta nytt lösenord",
  "admin.changePasswordButton": "Ändra lösenord",
  "admin.changingPassword": "Ändrar…",
  "admin.passwordChanged": "Lösenord ändrat",
  "admin.passwordMismatch": "Lösenorden matchar inte",
  "admin.logoutAllHeader": "Logga ut alla sessioner",
  "admin.logoutAllButton": "Logga ut alla sessioner",
  "admin.logoutAllConfirm": "Är du säker? Alla andra inloggningar slängs ut.",
  "admin.logoutAllDone": "Alla sessioner avslutade",
  "admin.diskWarningHeader": "Persistent disk",
  "admin.diskWarningHint": "Utan persistent disk i Render kan filen återställas vid redeploy och fall tillbaka till env-värden.",
  "admin.navLink": "Admin",
  // valuebets
  "valuebets.title": "Ithaca",
  "valuebets.subtitle": "Värdebets via Pinnacle no-vig.",
  "valuebets.liveValuebets": "Live valuebets",
  "valuebets.betTracker": "Bet Tracker",
  "valuebets.bookmaker": "Bookmaker",
  "valuebets.bookmakers": "Bookmakers",
  "valuebets.match": "Match",
  "valuebets.time": "Tid",
  "valuebets.odds": "Odds",
  "valuebets.edge": "Edge",
  "valuebets.ev": "EV",
  "valuebets.pinnacleOdds": "Pinnacle odds",
  "valuebets.minEv": "Min EV (%)",
  "valuebets.minOdds": "Min odds",
  "valuebets.maxOdds": "Max odds",
  "valuebets.bankroll": "Bankroll",
  "valuebets.stakeRecommended": "Rekommenderad insats",
  "valuebets.stakeModel": "Value Adjusted % Bankroll",
  "valuebets.stakeRisk": "Risknivå",
  "valuebets.stakeNoBet": "No bet",
  "valuebets.stakeSetBankroll": "Ange bankroll",
  "valuebets.stakeApply": "Använd",
  "valuebets.hours": "Tim",
  "valuebets.timeWindow": "Tidsfönster",
  "valuebets.noBetsFound": "Inga valuebets hittade i nuvarande filter.",
  "valuebets.staleGuardTitle": "Pinnacle-data är inte färsk just nu",
  "valuebets.staleGuardBody": "Value bets döljs eftersom referensoddsen (Pinnacle) inte uppdaterats nyligen. Det skyddar dig från att spela mot en gammal linje. De visas igen automatiskt så snart färska odds finns.",
  "valuebets.logBet": "Logga bet",
  "valuebets.lastUpdated": "Senast uppdaterad",
  "valuebets.dataAge": "Data-ålder",
  "valuebets.bookmakerFilter": "Bookmakers",
  "valuebets.outcome.home": "Hemma",
  "valuebets.outcome.draw": "Oavgjort",
  "valuebets.outcome.away": "Borta",
  "valuebets.live": "live",
  "valuebets.startsIn": "om",
  "valuebets.minutes": "min",
  "valuebets.hour": "h",
  "valuebets.hoursShort": "h",
  "valuebets.days": "d",
  "valuebets.activeFilters": "aktiva filter",
  "valuebets.pinnacle.fresh": "Pinnacle FÄRSK",
  "valuebets.pinnacle.freshHint": "Värdebets jämförs mot Pinnacle.",
  "valuebets.pinnacle.cache": "Pinnacle (cache)",
  "valuebets.pinnacle.cacheHint": "In-memory cache.",
  "valuebets.pinnacle.stale": "Pinnacle STALE",
  "valuebets.pinnacle.staleHint": "Pinnacle är för gammal — inga värdebets visas för att undvika falska positiva.",
  "valuebets.pinnacle.missing": "Pinnacle SAKNAS",
  "valuebets.pinnacle.missingHint": "Ingen Pinnacle-data tillgänglig — inga värdebets.",
  "valuebets.pinnacle.failed": "Pinnacle FETCH MISSLYCKADES",
  "valuebets.pinnacle.failedHint": "Pinnacle-hämtningen misslyckades — inga värdebets.",
  "valuebets.bonusIndex.waiting": "Bookmaker-odds: VÄNTAR",
  "valuebets.bonusIndex.waitingHint": "Index har inte byggts än — pre-warm väntar på serverstart.",
  "valuebets.bonusIndex.loading": "Bookmaker-odds: LADDAR",
  "valuebets.bonusIndex.loadingHint": "Pre-warm bygger indexet — kan ta 2-5 min vid första körning.",
  "valuebets.bonusIndex.ready": "Bookmaker-odds: REDO",
  "valuebets.bonusIndex.readyHint": "Index uppdaterat.",
  "valuebets.bonusIndex.stale": "Bookmaker-odds: STALE",
  "valuebets.bonusIndex.staleHint": "Pre-warm verkar ha pausat. Värdebets kan visas med gammal data.",
  "valuebets.bonusIndex.error": "Bookmaker-odds: FEL",
  "valuebets.bonusIndex.errorHint": "Pre-warm misslyckades — försöker igen vid nästa intervall.",
  "valuebets.pinnacleOddsTooltip": "Pinnacle decimal odds för detta utfall (raw, med vig)",
  "valuebets.copyTeamName": "Klicka för att kopiera lagets namn",
  "valuebets.opportunity": "tillfälle",
  "valuebets.opportunities": "tillfällen",
  "valuebets.bookmakerListings": "bookmaker-rader",
  // odds drops
  "oddsDrops.title": "Odds Drops",
  "oddsDrops.subtitle": "Pinnacle Odds Dropper-signaler i realtid.",
  "oddsDrops.market": "Marknad",
  "oddsDrops.selection": "Val",
  "oddsDrops.oldOdds": "Föregående odds",
  "oddsDrops.newOdds": "Nuvarande odds",
  "oddsDrops.drop": "Drop",
  "oddsDrops.window": "Fönster",
  "oddsDrops.threshold": "Tröskel",
  "oddsDrops.sport": "Sport",
  "oddsDrops.noDropsYet": "Inga drops ännu.",
  "oddsDrops.collectingSnapshots": "Samlar snapshots — drops visas efter några pollingintervall.",
  "oddsDrops.lastSnapshot": "Senaste snapshot",
  "oddsDrops.alerts": "Alerts",
  "oddsDrops.dropDetected": "Drop upptäckt",
  "oddsDrops.timeSinceDrop": "Tid sedan drop",
  "oddsDrops.source": "Källa",
  "oddsDrops.snapshots": "Snapshots",
  "oddsDrops.clearHistory": "Rensa historik",
  // bet log
  "betLog.title": "Bet Tracker",
  "betLog.stake": "Insats",
  "betLog.profit": "Vinst",
  "betLog.roi": "ROI",
  "betLog.yield": "Yield",
  "betLog.clv": "CLV",
  "betLog.result": "Resultat",
  "betLog.finalScore": "Slutresultat",
  "betLog.status": "Status",
  "betLog.pending": "Väntar",
  "betLog.open": "Öppna",
  "betLog.won": "Vunnen",
  "betLog.lost": "Förlorad",
  "betLog.void": "Annullerad",
  "betLog.totalStake": "Total insats",
  "betLog.totalProfit": "Total vinst",
  "betLog.addBet": "Logga bet",
  "betLog.editBet": "Redigera bet",
  "betLog.deleteBet": "Ta bort bet",
  "betLog.bookmaker": "Bookmaker",
  "betLog.odds": "Odds",
  "betLog.date": "Datum",
  "betLog.notes": "Anteckningar",
  "betLog.units": "Enheter",
  "betLog.bankroll": "Bankroll",
  "betLog.bankrollDesc": "Bankrollen du spelar value betting med. Insats rekommenderas utifrån den (Value Adjusted % Bankroll).",
  "betLog.bankrollPlaceholder": "T.ex. 10000",
  "betLog.bankrollNotSet": "Mata in din bankroll för att få insatsrekommendationer på valuebets.",
  "betLog.bankrollActive": "Insats rekommenderas mot din bankroll:",
  "betLog.match": "Match",
  "betLog.outcome": "Utfall",
  "betLog.expectedValue": "Expected Value",
  "betLog.hitRate": "Hit Rate",
  "betLog.turnover": "Omsättning",
  "betLog.settled": "settled",
  "betLog.bets": "bets",
  "betLog.empty": "Inga loggade bets än",
  "betLog.emptyHint": "Logga ett bet från Valuebets-fliken eller manuellt.",
  "betLog.confirmDelete": "Ta bort bet?",
  "betLog.confirmDeleteHint": "Detta går inte att ångra.",
  "betLog.profitAndClv": "Resultatutveckling",
  "betLog.profitChartHint": "Din ackumulerade vinst/förlust för loggade bets.",
  "betLog.noSettledYet": "Dina resultat visas här",
  "betLog.noSettledHint": "När dina bets är avgjorda (vunna, förlorade eller annullerade) ritas de upp här som en kurva. Logga ett bet och markera resultatet när matchen är klar.",
  "betLog.addManually": "Lägg till manuellt",
  "betLog.statusOpen": "Öppen",
  "betLog.statusRefunded": "Återbetald",
  "betLog.statusHalfWon": "Halvvunnen",
  "betLog.statusHalfLost": "Halvförlorad",
  "betLog.outcomeHome": "1 — Hemma",
  "betLog.outcomeDraw": "X — Oavgjort",
  "betLog.outcomeAway": "2 — Borta",
  "betLog.modalAddManually": "Lägg till bet manuellt",
  "betLog.modalSetResult": "Sätt resultat",
  "betLog.modalHintFromValuebet": "EV och Pinnacle-snapshot är redan ifyllt. Mata in stake och bekräfta.",
  "betLog.modalHintSettle": "Markera resultat och fyll gärna i closing fair odds för CLV.",
  "betLog.modalHintCreate": "Fyll i bet-data och spara. Beräkningar görs live.",
  "betLog.savedUpdated": "Bet uppdaterat",
  "betLog.savedLogged": "Bet loggat",
  "betLog.saveFailed": "Kunde inte spara — localStorage kan vara fullt",
  "betLog.closingFairOddsPlaceholder": "lämna tomt tills closing",
  "betLog.notesPlaceholder": "t.ex. spelat live, väntar på lineup…",
  "betLog.evInCurrency": "EV i",
  "betLog.liveVsPinnacle": "Live mot Pinnacle",
  "betLog.pollingPinnacle": "Pollar Pinnacle…",
  "betLog.settledShowsEvAtBetTime": "Bettet är settled — visar EV vid bet-tillfället",
  "betLog.evAtBetNotValueAnymore": "EV vid bet",
  "betLog.lineClosed": "Linje stängd",
  "betLog.lineClosedHint": "Matchen har startat — Pinnacle har stängt pre-match-linjen, så live-EV kan inte räknas längre",
  "betLog.lineGone": "Linje borta",
  "betLog.lineGoneHint": "Pinnacle noterar inte längre den här linjen, så live-EV kan inte räknas",
  "betLog.evAtBetLabel": "EV vid bet",
  "betLog.settleManually": "Settla manuellt",
  "betLog.settleManuallyHint": "Inget resultat hittades automatiskt (alla ligor täcks inte av resultat-tjänsten). Klicka för att sätta resultatet själv — då visas vinst/förlust i Vinst-kolumnen och resultatkurvan.",
  "betLog.updateClosingOdds": "Uppdatera closing odds (CLV)",
  "betLog.confirmDeleteRow": "Detta tar bort raden för",
  "betLog.deletedToast": "Bet borttaget",
  "betLog.importError": "Importfel",
  "betLog.importSuccess": "Importerade {added} bets ({skipped} duplicates skippade)",
  "betLog.exportSuccessJson": "Exporterade till JSON",
  "betLog.exportSuccessCsv": "Exporterade till CSV",
  "betLog.couldNotReadFile": "Kunde inte läsa filen",
  // stake & betonline
  "stake.worstCase": "Sämsta resultat",
  "stake.bestPlays": "Bästa spel mellan sidorna",
  "stake.refreshNow": "Uppdatera nu",
  "stake.refreshing": "Uppdaterar…",
  "stake.firstTimeHint": "(första gången kan ta 15–40 s)",
  "stake.noOddsLoaded": "Inga odds laddade. Tryck Uppdatera nu.",
  "stake.workerCheck": "Inga matchande spel. Kontrollera att workern har hämtat odds.",
  "stake.invalidResponse": "Ogiltigt svar från servern (förväntade JSON).",
  "stake.fetchFailed": "Kunde inte hämta data",
  "stake.refreshFailed": "Kunde inte uppdatera",
  "stake.updatedToast": "Uppdaterad: {bo} BetOnline-rader · {ops} matchande spel",
  "stake.result": "Resultat",
  "stake.fullyAutomatic": "Helautomatisk",
  "stake.loadingHint": "Laddar odds och matcher…",
  "stake.difference": "Skillnad",
  // match calculator
  "matchCalc.matchWithDay2Money": "Matcha med pengar från Dag 2 — Vinnare-match",
  "matchCalc.useStake": "Använd",
  "matchCalc.use": "Använd",
  "matchCalc.noDay2Money": "Inga pengar kvar i Dag 2 — Vinnare-match.",
  "matchCalc.deductFromWinner": "Draget från vinnare-match:",
  "matchCalc.outcomeOverview": "📋 Utfallsöversikt — vad händer vid varje resultat:",
  "matchCalc.winningBets": "✅ Vinnande spel:",
  "matchCalc.lostBets": "❌ Förlorade:",
  "matchCalc.pureProfitGuaranteed": "Ren vinst (garanterad):",
  "matchCalc.sameProfitLossRegardless": "Samma vinst/förlust oavsett utfall:",
  "matchCalc.noFreebetsLeft": "Inga freebets med ifyllda odds kvar i listan.",
  // welcome bonus
  "welcome.outcomeOverviewDay1": "📊 Utfallsöversikt — Dag 1",
  "welcome.bestOddsHint": "Bästa odds från senaste odds comparison-hämtning",
  "welcome.noDataYet": "Ingen data ännu",
  "welcome.day1MoneyOn": "dag 1 pengar på",
  "welcome.day3MoneyOn": "Dag 3 pengar på",
  "welcome.freebetResultQuestion": "🎁 Vad blev resultatet på freebet-matchen?",
  "welcome.matchedWinnerResultQuestion": "🏆 Vad blev resultatet på matched-vinnare-matchen?",
  "welcome.withdrawableProfitTitle": "✅ Uttagbar freebet-vinst hamnar på:",
  "welcome.noFreebetWon": "ℹ️ Inga freebet-spel vann på det resultatet.",
  "welcome.totalWithdrawable": "Totalt uttagbart:",
  "welcome.wonOnWinnerMatch": "✅ Vann på vinnare-matchen:",
  "welcome.accountTurnover": "📊 Omsatt hittills på kontot",
  "welcome.needsTurnoverNow": "Behöver omsättas nu:",
  "welcome.day3Wagering": "💰 Dag 3 — Omsättningsspel",
  "welcome.savedBets": "📜 Sparade spel",
  "welcome.noSavedBets": "Inga sparade spel visas just nu.",
  "welcome.save": "💾 Spara",
  "welcome.backToCalculator": "Tillbaka till kalkylatorn",
  "welcome.searchPlaceholder": "Sök match (t.ex. Arsenal Chelsea)",
  "welcome.searching": "Söker…",
  "welcome.searchMatch": "🔎 Sök match",
  "welcome.fetchingOdds": "Hämtar odds…",
  "welcome.fetchOdds": "📡 Hämta odds (scrape)",
  "welcome.minSearchChars": "Skriv minst 3 tecken för sökning",
  "welcome.examplePlaceholder": "t.ex. Flickvän",
  "welcome.outcomeHomeWithCode": "1 Hemma",
  "welcome.outcomeDrawWithCode": "X Oavgjort",
  "welcome.outcomeAwayWithCode": "2 Borta",
  // bonus optimizer
  "bonusOpt.hours24": "24 timmar",
  "bonusOpt.hours48": "48 timmar",
  "bonusOpt.hours72": "72 timmar",
  "bonusOpt.loading": "Laddar…",
  "bonusOpt.refresh": "Uppdatera",
  "bonusOpt.searching": "Söker…",
  "bonusOpt.waitingResult": "Väntar resultat",
  "bonusOpt.noBetsRegistered": "Inga spel registrerade i denna runda.",
  "bonusOpt.freebetsThatEqualize": "Freebets som jämnar ut",
  "bonusOpt.earnedFreebets": "Intjänade freebets",
  "bonusOpt.optimizeNextRound": "Optimera nästa runda",
  "bonusOpt.requirementsMatched": "Omsättningskrav — matched-bonusar",
  "bonusOpt.lost": "Förlorat",
  "bonusOpt.waitingResultGeneric": "Väntar resultat",
  "bonusOpt.consumed": "Förbrukad",
  "bonusOpt.available": "Tillgänglig",
  "bonusOpt.outcome": "Utfall",
  "bonusOpt.profitModel": "Vinst-modell",
  // settings
  "settings.title": "Inställningar",
  "settings.subtitle": "Språk och valuta för displayformat.",
  "settings.language": "Språk",
  "settings.currency": "Valuta",
  "settings.save": "Spara",
  "settings.saved": "Sparat",
  "settings.swedish": "Svenska",
  "settings.english": "English",
  "settings.preview.title": "Förhandsvisning",
  "settings.preview.exampleStake": "Exempel insats",
  "settings.preview.exampleProfit": "Exempel vinst",
  "settings.note.ngn": "NGN för spel i nigerianska naira.",
  "settings.note.displayOnly": "Valutan ändrar bara visningsformat. Befintliga belopp räknas inte om.",
  "settings.back": "Tillbaka",
  "settings.currencyOption.sek": "Svensk krona (SEK)",
  "settings.currencyOption.eur": "Euro (EUR)",
  "settings.currencyOption.usd": "US-dollar (USD)",
  "settings.currencyOption.gbp": "Brittiskt pund (GBP)",
  "settings.currencyOption.ngn": "Nigeriansk naira (NGN)",
};

const EN: Record<TranslationKey, string> = {
  // common
  "common.refresh": "Refresh",
  "common.loading": "Loading…",
  "common.error": "Error",
  "common.empty": "Empty",
  "common.save": "Save",
  "common.saved": "Saved",
  "common.cancel": "Cancel",
  "common.search": "Search",
  "common.filter": "Filter",
  "common.filters": "Filters",
  "common.all": "All",
  "common.reset": "Reset",
  "common.yes": "Yes",
  "common.no": "No",
  "common.updated": "Updated",
  "common.lastUpdated": "Last updated",
  "common.back": "Back",
  "common.delete": "Delete",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.never": "Never",
  "common.now": "Now",
  "common.minutesAgo": "min ago",
  "common.secondsAgo": "sec ago",
  "common.add": "Add",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.unknown": "unknown",
  "common.unknownError": "Unknown error",
  "common.searching": "Searching…",
  "common.searchPlaceholder": "Search…",
  "common.tryAgain": "Try again",
  "common.saveChanges": "Save changes",
  "common.waiting": "pending…",
  "common.fresh": "fresh",
  "common.stale": "stale",
  "common.over": "Over",
  "common.under": "Under",
  "outcome.home": "Home",
  "outcome.draw": "Draw",
  "outcome.away": "Away",
  "outcome.homeWithCode": "Home (1)",
  "outcome.drawWithCode": "Draw (X)",
  "outcome.awayWithCode": "Away (2)",
  // nav / home
  "nav.home": "Home",
  "nav.valuebets": "Value bets",
  "nav.oddsDrops": "Odds Drops",
  "nav.betTracker": "Bet Tracker",
  "nav.settings": "Settings",
  "home.title": "Choose a system",
  "home.tagline": "Edge · Strategy · Freedom",
  "home.heroHeadline": "Strategy. Edge. Freedom.",
  "home.heroSubtitle": "Six powerful systems. An odyssey of opportunity.",
  "home.heroBody": "Oddexus brings together proven methods, smart automation and exclusive bonuses – all to give you an edge in every decision.",
  "home.heroCta": "Explore all systems",
  "home.plaqueTitle": "For those who play smart.",
  "home.plaqueSub": "Built for edge. Driven by strategy.",
  "home.quote": "It is not the wind that decides the journey, but the captain's decisions.",
  "home.quoteAuthor": "Odysseus",
  "home.athenaShort": "AI assistant for questions and strategy",
  "home.ithacaShort": "Value betting and long-term edge",
  "home.outisShort": "Simple arbitrage and bonus plays",
  "home.odysseusShort": "Advanced arbitrage across sites",
  "home.argosShort": "Automation and desktop bot",
  "home.xeniaShort": "Stake/BetOnline bonuses and rewards",
  "home.trust1Title": "Safe & reliable",
  "home.trust1Sub": "Trusted tools and proven methods.",
  "home.trust2Title": "Build your edge",
  "home.trust2Sub": "Strategies that create long-term profit.",
  "home.trust3Title": "Your journey. Your decision.",
  "home.trust3Sub": "You steer the journey – we give you the map.",
  "home.subtitle": "",
  "home.stakeBetonline": "Xenia",
  "home.stakeBetonlineDescription": "Entry point for Stake/BetOnline odds and import.",
  "home.valuebets": "Ithaca",
  "home.valuebetsDescription": "Find value bets via Pinnacle no-vig vs other bookmakers.",
  "home.oddsDrops": "Odds Drops",
  "home.oddsDropsDescription": "Follow the Pinnacle market and catch sharp drops in real time.",
  "home.settings": "Settings",
  "home.settingsDescription": "Language and currency (SEK, EUR, USD, GBP, NGN).",
  "home.autoclicker": "Argos",
  "home.autoclickerDescription": "License, download, and setup for the desktop bot.",
  "home.athena": "Athena",
  "home.athenaDescription": "Your AI assistant. Ask about value betting, bonus clearing, Stake/BetOnline – answers from the community knowledge base + general AI.",
  "home.bonusFinder": "Outis",
  "home.bonusFinderDescription": "Pick the bookmaker you have a bonus with and find football 1X2 matches where the bonus can be turned over with low calculated qualifying loss.",
  "home.bonusOptimizer": "Odysseus",
  "home.bonusOptimizerDescription": "Find the best matches and optimize bonuses automatically.",
  "home.welcomeBonus": "Welcome bonuses",
  "home.welcomeBonusDescription": "Manual flow for logged bonuses (Walter etc.) — Day 1, Day 2, Day 3.",
  "home.soon": "Soon",
  "home.sourcesTitle": "Sources & bookmakers",
  "home.sourcesSubtitle": "Health per data source — auto-refreshes.",
  "home.sourcesActive": "active",
  "home.sourcesEmpty": "empty",
  "home.sourcesBlocked": "blocked",
  "home.sourcesError": "error",
  "home.sourcesStale": "stale",
  "home.sourcesOnDemand": "on demand",
  "home.sourcesNotConfigured": "not configured",
  "home.sourcesPerMatch": "per match",
  "home.sourcesOnRequest": "on request",
  "home.sourcesIntervalOnDemand": "on demand",
  "home.sourcesStaleNa": "n/a",
  "home.sourcesReason": "Reason",
  "home.sourcesPartialRun": "partial run",
  "home.sourcesPartialRunHint": "The latest fetch was cut short by the time limit and saved what it had — fresh but reduced coverage this cycle. The next run automatically shrinks its budget to finish in time.",
  "home.sourcesOnDemandExplainer": "On-demand bookmakers are scraped when matching against a Pinnacle event. They do not keep a standalone cached odds file.",
  "home.sourcesLoading": "Loading sources…",
  "home.sourcesUpdatedAgo": "updated {seconds}s ago",
  "home.sourcesRowsLabel": "{count} rows",
  "home.sourcesExternalSignal": "external signal",
  "home.sourcesNoData": "No data",
  "home.sourcesRefresh": "Refresh",
  "home.sourcesColSource": "Source",
  "home.sourcesColType": "Type",
  "home.sourcesColRows": "Rows",
  "home.sourcesColUpdated": "Updated",
  "home.sourcesColInterval": "Interval",
  "home.sourcesColStaleAfter": "Stale after",
  "home.sourcesColStatus": "Status",
  // auth
  "auth.title": "Sign in",
  "auth.subtitle": "Enter your credentials to continue",
  "auth.usernameLabel": "Username",
  "auth.passwordLabel": "Password",
  "auth.loginButton": "Sign in",
  "auth.loggingIn": "Signing in…",
  "auth.invalidCredentials": "Invalid username or password",
  "auth.networkError": "Network error — try again",
  "auth.logout": "Sign out",
  "nav.billing": "Subscription",
  "billing.title": "Subscription",
  "billing.subtitle": "Pick a plan and unlock more tools.",
  "billing.currentPlan": "Your current plan",
  "billing.activeUntil": "Active until",
  "billing.autoRenewOn": "Renews automatically every month",
  "billing.notConfigured": "Payments are not enabled yet. Contact support and we'll activate your plan manually.",
  "billing.choosePlan": "Choose plan",
  "billing.perMonth": "/mo",
  "billing.upgrade": "Upgrade",
  "billing.yourPlan": "Your plan",
  "billing.includesValuebets": "Ithaca (value betting)",
  "billing.includesAutoclicker": "Argos (autoclicker)",
  "billing.includesNothing": "Base access",
  "billing.processing": "Sending you to checkout…",
  "billing.backHome": "Back",
  "billing.returnNote": "Thank you! Your payment is processing — your plan will activate shortly.",
  "auth.usernamePlaceholder": "username",
  "auth.passwordPlaceholder": "password",
  // admin
  "admin.title": "Admin",
  "admin.subtitle": "Manage credentials and sessions",
  "admin.currentUserLabel": "Signed in as",
  "admin.authSourceLabel": "Password source",
  "admin.passwordUpdatedAtLabel": "Last changed",
  "admin.changePasswordHeader": "Change password",
  "admin.currentPasswordLabel": "Current password",
  "admin.newPasswordLabel": "New password",
  "admin.confirmPasswordLabel": "Confirm new password",
  "admin.changePasswordButton": "Change password",
  "admin.changingPassword": "Changing…",
  "admin.passwordChanged": "Password changed",
  "admin.passwordMismatch": "Passwords do not match",
  "admin.logoutAllHeader": "Logout all sessions",
  "admin.logoutAllButton": "Logout all sessions",
  "admin.logoutAllConfirm": "Are you sure? All other sessions will be invalidated.",
  "admin.logoutAllDone": "All sessions invalidated",
  "admin.diskWarningHeader": "Persistent disk",
  "admin.diskWarningHint": "Without a Render persistent disk this file may reset on redeploy and fall back to env values.",
  "admin.navLink": "Admin",
  // valuebets
  "valuebets.title": "Ithaca",
  "valuebets.subtitle": "Value bets via Pinnacle no-vig.",
  "valuebets.liveValuebets": "Live value bets",
  "valuebets.betTracker": "Bet Tracker",
  "valuebets.bookmaker": "Bookmaker",
  "valuebets.bookmakers": "Bookmakers",
  "valuebets.match": "Match",
  "valuebets.time": "Time",
  "valuebets.odds": "Odds",
  "valuebets.edge": "Edge",
  "valuebets.ev": "EV",
  "valuebets.pinnacleOdds": "Pinnacle odds",
  "valuebets.minEv": "Min EV (%)",
  "valuebets.minOdds": "Min odds",
  "valuebets.maxOdds": "Max odds",
  "valuebets.bankroll": "Bankroll",
  "valuebets.stakeRecommended": "Recommended stake",
  "valuebets.stakeModel": "Value Adjusted % Bankroll",
  "valuebets.stakeRisk": "Risk level",
  "valuebets.stakeNoBet": "No bet",
  "valuebets.stakeSetBankroll": "Set bankroll",
  "valuebets.stakeApply": "Apply",
  "valuebets.hours": "h",
  "valuebets.timeWindow": "Time window",
  "valuebets.noBetsFound": "No value bets in the current filter.",
  "valuebets.staleGuardTitle": "Pinnacle data isn't fresh right now",
  "valuebets.staleGuardBody": "Value bets are hidden because the reference odds (Pinnacle) haven't updated recently. This protects you from betting into a stale line. They'll reappear automatically once fresh odds arrive.",
  "valuebets.logBet": "Log bet",
  "valuebets.lastUpdated": "Last updated",
  "valuebets.dataAge": "Data age",
  "valuebets.bookmakerFilter": "Bookmakers",
  "valuebets.outcome.home": "Home",
  "valuebets.outcome.draw": "Draw",
  "valuebets.outcome.away": "Away",
  "valuebets.live": "live",
  "valuebets.startsIn": "in",
  "valuebets.minutes": "min",
  "valuebets.hour": "h",
  "valuebets.hoursShort": "h",
  "valuebets.days": "d",
  "valuebets.activeFilters": "active filters",
  "valuebets.pinnacle.fresh": "Pinnacle FRESH",
  "valuebets.pinnacle.freshHint": "Value bets compared against Pinnacle.",
  "valuebets.pinnacle.cache": "Pinnacle (cache)",
  "valuebets.pinnacle.cacheHint": "In-memory cache.",
  "valuebets.pinnacle.stale": "Pinnacle STALE",
  "valuebets.pinnacle.staleHint": "Pinnacle is too old — no value bets shown to avoid false positives.",
  "valuebets.pinnacle.missing": "Pinnacle MISSING",
  "valuebets.pinnacle.missingHint": "No Pinnacle data available — no value bets.",
  "valuebets.pinnacle.failed": "Pinnacle FETCH FAILED",
  "valuebets.pinnacle.failedHint": "Pinnacle fetch failed — no value bets.",
  "valuebets.bonusIndex.waiting": "Bookmaker odds: WAITING",
  "valuebets.bonusIndex.waitingHint": "Index has not been built yet — pre-warm awaiting server start.",
  "valuebets.bonusIndex.loading": "Bookmaker odds: LOADING",
  "valuebets.bonusIndex.loadingHint": "Pre-warm is building the index — can take 2–5 min on first run.",
  "valuebets.bonusIndex.ready": "Bookmaker odds: READY",
  "valuebets.bonusIndex.readyHint": "Index updated.",
  "valuebets.bonusIndex.stale": "Bookmaker odds: STALE",
  "valuebets.bonusIndex.staleHint": "Pre-warm appears paused. Value bets may show old data.",
  "valuebets.bonusIndex.error": "Bookmaker odds: ERROR",
  "valuebets.bonusIndex.errorHint": "Pre-warm failed — retrying at next interval.",
  "valuebets.pinnacleOddsTooltip": "Pinnacle decimal odds for this selection (raw, with vig)",
  "valuebets.copyTeamName": "Click to copy team name",
  "valuebets.opportunity": "opportunity",
  "valuebets.opportunities": "opportunities",
  "valuebets.bookmakerListings": "bookmaker listings",
  // odds drops
  "oddsDrops.title": "Odds Drops",
  "oddsDrops.subtitle": "Pinnacle Odds Dropper signals in real time.",
  "oddsDrops.market": "Market",
  "oddsDrops.selection": "Selection",
  "oddsDrops.oldOdds": "Previous odds",
  "oddsDrops.newOdds": "Current odds",
  "oddsDrops.drop": "Drop",
  "oddsDrops.window": "Window",
  "oddsDrops.threshold": "Threshold",
  "oddsDrops.sport": "Sport",
  "oddsDrops.noDropsYet": "No drops yet.",
  "oddsDrops.collectingSnapshots":
    "Collecting snapshots — drops will appear after a few polling intervals.",
  "oddsDrops.lastSnapshot": "Last snapshot",
  "oddsDrops.alerts": "Alerts",
  "oddsDrops.dropDetected": "Drop detected",
  "oddsDrops.timeSinceDrop": "Time since drop",
  "oddsDrops.source": "Source",
  "oddsDrops.snapshots": "Snapshots",
  "oddsDrops.clearHistory": "Clear history",
  // bet log
  "betLog.title": "Bet Tracker",
  "betLog.stake": "Stake",
  "betLog.profit": "Profit",
  "betLog.roi": "ROI",
  "betLog.yield": "Yield",
  "betLog.clv": "CLV",
  "betLog.result": "Result",
  "betLog.finalScore": "Final score",
  "betLog.status": "Status",
  "betLog.pending": "Pending",
  "betLog.open": "Open",
  "betLog.won": "Won",
  "betLog.lost": "Lost",
  "betLog.void": "Void",
  "betLog.totalStake": "Total stake",
  "betLog.totalProfit": "Total profit",
  "betLog.addBet": "Log bet",
  "betLog.editBet": "Edit bet",
  "betLog.deleteBet": "Delete bet",
  "betLog.bookmaker": "Bookmaker",
  "betLog.odds": "Odds",
  "betLog.date": "Date",
  "betLog.notes": "Notes",
  "betLog.units": "Units",
  "betLog.bankroll": "Bankroll",
  "betLog.bankrollDesc": "The bankroll you play value betting with. Stakes are recommended from it (Value Adjusted % Bankroll).",
  "betLog.bankrollPlaceholder": "e.g. 10000",
  "betLog.bankrollNotSet": "Enter your bankroll to get stake recommendations on value bets.",
  "betLog.bankrollActive": "Stakes are recommended against your bankroll:",
  "betLog.match": "Match",
  "betLog.outcome": "Outcome",
  "betLog.expectedValue": "Expected Value",
  "betLog.hitRate": "Hit Rate",
  "betLog.turnover": "Turnover",
  "betLog.settled": "settled",
  "betLog.bets": "bets",
  "betLog.empty": "No logged bets yet",
  "betLog.emptyHint": "Log a bet from the Value bets tab or manually.",
  "betLog.confirmDelete": "Delete bet?",
  "betLog.confirmDeleteHint": "This cannot be undone.",
  "betLog.profitAndClv": "Performance",
  "betLog.profitChartHint": "Your cumulative profit/loss across logged bets.",
  "betLog.noSettledYet": "Your results will appear here",
  "betLog.noSettledHint":
    "Once your bets have a result (won, lost, or void) they'll be plotted as a curve. Log a bet and mark the result when the match is done.",
  "betLog.addManually": "Add manually",
  "betLog.statusOpen": "Open",
  "betLog.statusRefunded": "Refunded",
  "betLog.statusHalfWon": "Half won",
  "betLog.statusHalfLost": "Half lost",
  "betLog.outcomeHome": "1 — Home",
  "betLog.outcomeDraw": "X — Draw",
  "betLog.outcomeAway": "2 — Away",
  "betLog.modalAddManually": "Add bet manually",
  "betLog.modalSetResult": "Set result",
  "betLog.modalHintFromValuebet": "EV and Pinnacle snapshot are already filled in. Enter stake and confirm.",
  "betLog.modalHintSettle": "Mark the result and optionally fill in closing fair odds for CLV.",
  "betLog.modalHintCreate": "Fill in bet data and save. Calculations run live.",
  "betLog.savedUpdated": "Bet updated",
  "betLog.savedLogged": "Bet logged",
  "betLog.saveFailed": "Could not save — localStorage may be full",
  "betLog.closingFairOddsPlaceholder": "leave empty until closing",
  "betLog.notesPlaceholder": "e.g. played live, waiting for lineup…",
  "betLog.evInCurrency": "EV in",
  "betLog.liveVsPinnacle": "Live vs Pinnacle",
  "betLog.pollingPinnacle": "Polling Pinnacle…",
  "betLog.settledShowsEvAtBetTime": "Bet is settled — showing EV at the time of the bet",
  "betLog.evAtBetNotValueAnymore": "EV at bet",
  "betLog.lineClosed": "Line closed",
  "betLog.lineClosedHint": "The match has started — Pinnacle closed the pre-match line, so live EV can no longer be calculated",
  "betLog.lineGone": "Line gone",
  "betLog.lineGoneHint": "Pinnacle no longer quotes this line, so live EV cannot be calculated",
  "betLog.evAtBetLabel": "EV at bet",
  "betLog.settleManually": "Settle manually",
  "betLog.settleManuallyHint": "No result was found automatically (the results service doesn't cover every league). Click to set the result yourself — profit/loss then shows in the Profit column and the results chart.",
  "betLog.updateClosingOdds": "Update closing odds (CLV)",
  "betLog.confirmDeleteRow": "This removes the row for",
  "betLog.deletedToast": "Bet deleted",
  "betLog.importError": "Import error",
  "betLog.importSuccess": "Imported {added} bets ({skipped} duplicates skipped)",
  "betLog.exportSuccessJson": "Exported to JSON",
  "betLog.exportSuccessCsv": "Exported to CSV",
  "betLog.couldNotReadFile": "Could not read file",
  // stake & betonline
  "stake.worstCase": "Worst-case result",
  "stake.bestPlays": "Best plays across sites",
  "stake.refreshNow": "Refresh now",
  "stake.refreshing": "Refreshing…",
  "stake.firstTimeHint": "(first time may take 15–40 s)",
  "stake.noOddsLoaded": "No odds loaded. Click Refresh now.",
  "stake.workerCheck": "No matching plays. Check that the worker has fetched odds.",
  "stake.invalidResponse": "Invalid response from server (expected JSON).",
  "stake.fetchFailed": "Could not fetch data",
  "stake.refreshFailed": "Could not refresh",
  "stake.updatedToast": "Refreshed: {bo} BetOnline rows · {ops} matching plays",
  "stake.result": "Result",
  "stake.fullyAutomatic": "Fully automatic",
  "stake.loadingHint": "Loading odds and matches…",
  "stake.difference": "Difference",
  // match calculator
  "matchCalc.matchWithDay2Money": "Match with money from Day 2 — Winner match",
  "matchCalc.useStake": "Use",
  "matchCalc.use": "Use",
  "matchCalc.noDay2Money": "No money left in Day 2 — Winner match.",
  "matchCalc.deductFromWinner": "Deducted from winner match:",
  "matchCalc.outcomeOverview": "📋 Outcome overview — what happens for each result:",
  "matchCalc.winningBets": "✅ Winning bets:",
  "matchCalc.lostBets": "❌ Lost:",
  "matchCalc.pureProfitGuaranteed": "Pure profit (guaranteed):",
  "matchCalc.sameProfitLossRegardless": "Same profit/loss regardless of outcome:",
  "matchCalc.noFreebetsLeft": "No freebets with odds left in the list.",
  // welcome bonus
  "welcome.outcomeOverviewDay1": "📊 Outcome overview — Day 1",
  "welcome.bestOddsHint": "Best odds from the latest odds-comparison fetch",
  "welcome.noDataYet": "No data yet",
  "welcome.day1MoneyOn": "Day 1 money on",
  "welcome.day3MoneyOn": "Day 3 money on",
  "welcome.freebetResultQuestion": "🎁 What was the freebet match result?",
  "welcome.matchedWinnerResultQuestion": "🏆 What was the matched-winner match result?",
  "welcome.withdrawableProfitTitle": "✅ Withdrawable freebet profit goes to:",
  "welcome.noFreebetWon": "ℹ️ No freebet bet won on that result.",
  "welcome.totalWithdrawable": "Total withdrawable:",
  "welcome.wonOnWinnerMatch": "✅ Won on the winner match:",
  "welcome.accountTurnover": "📊 Turnover so far on this account",
  "welcome.needsTurnoverNow": "Needs turnover now:",
  "welcome.day3Wagering": "💰 Day 3 — Wagering play",
  "welcome.savedBets": "📜 Saved bets",
  "welcome.noSavedBets": "No saved bets currently shown.",
  "welcome.save": "💾 Save",
  "welcome.backToCalculator": "Back to calculator",
  "welcome.searchPlaceholder": "Search match (e.g. Arsenal Chelsea)",
  "welcome.searching": "Searching…",
  "welcome.searchMatch": "🔎 Search match",
  "welcome.fetchingOdds": "Fetching odds…",
  "welcome.fetchOdds": "📡 Fetch odds (scrape)",
  "welcome.minSearchChars": "Type at least 3 characters to search",
  "welcome.examplePlaceholder": "e.g. Girlfriend",
  "welcome.outcomeHomeWithCode": "1 Home",
  "welcome.outcomeDrawWithCode": "X Draw",
  "welcome.outcomeAwayWithCode": "2 Away",
  // bonus optimizer
  "bonusOpt.hours24": "24 hours",
  "bonusOpt.hours48": "48 hours",
  "bonusOpt.hours72": "72 hours",
  "bonusOpt.loading": "Loading…",
  "bonusOpt.refresh": "Refresh",
  "bonusOpt.searching": "Searching…",
  "bonusOpt.waitingResult": "Waiting for result",
  "bonusOpt.noBetsRegistered": "No bets registered in this round.",
  "bonusOpt.freebetsThatEqualize": "Freebets that equalize",
  "bonusOpt.earnedFreebets": "Earned freebets",
  "bonusOpt.optimizeNextRound": "Optimize next round",
  "bonusOpt.requirementsMatched": "Turnover requirements — matched bonuses",
  "bonusOpt.lost": "Lost",
  "bonusOpt.waitingResultGeneric": "Waiting for result",
  "bonusOpt.consumed": "Consumed",
  "bonusOpt.available": "Available",
  "bonusOpt.outcome": "Outcome",
  "bonusOpt.profitModel": "Profit model",
  // settings
  "settings.title": "Settings",
  "settings.subtitle": "Language and currency for display formatting.",
  "settings.language": "Language",
  "settings.currency": "Currency",
  "settings.save": "Save",
  "settings.saved": "Saved",
  "settings.swedish": "Svenska",
  "settings.english": "English",
  "settings.preview.title": "Preview",
  "settings.preview.exampleStake": "Example stake",
  "settings.preview.exampleProfit": "Example profit",
  "settings.note.ngn": "NGN for betting in Nigerian naira.",
  "settings.note.displayOnly":
    "Currency changes display format only. It does not convert existing amounts.",
  "settings.back": "Back",
  "settings.currencyOption.sek": "Swedish Krona (SEK)",
  "settings.currencyOption.eur": "Euro (EUR)",
  "settings.currencyOption.usd": "US Dollar (USD)",
  "settings.currencyOption.gbp": "British Pound (GBP)",
  "settings.currencyOption.ngn": "Nigerian Naira (NGN)",
};

const TRANSLATIONS: Record<LanguageCode, Record<TranslationKey, string>> = {
  sv: SV,
  en: EN,
};

/**
 * Översätt en nyckel. Saknad nyckel i mål-språket → fallback till svenska,
 * sedan till nyckeln själv. Vi kraschar aldrig på en ny nyckel.
 *
 * I dev-mode skickar vi en console.warn vid första miss per nyckel så att
 * översättningar inte tyst tappas. I prod är detta tyst.
 */
const warnedMissingKeys = new Set<string>();

function maybeWarn(key: string, language: LanguageCode, where: "target" | "fallback") {
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") return;
  if (typeof import.meta !== "undefined") {
    // Vite dev: import.meta.env.PROD = true → ingen warning.
    // (Vi har inget direkt sätt att avgöra dev kontra prod här utan
    //  import.meta — typescript-ts tillåter det dock i Vite-context.)
  }
  const tag = `${language}:${key}:${where}`;
  if (warnedMissingKeys.has(tag)) return;
  warnedMissingKeys.add(tag);
  // eslint-disable-next-line no-console
  console.warn(`[i18n] Missing translation: ${key} (lang=${language}, ${where} fallback)`);
}

export function t(key: TranslationKey, language: LanguageCode): string {
  const target = TRANSLATIONS[language]?.[key];
  if (target != null) return target;
  maybeWarn(String(key), language, "target");
  const fallback = TRANSLATIONS.sv[key];
  if (fallback != null) return fallback;
  maybeWarn(String(key), language, "fallback");
  return String(key);
}
