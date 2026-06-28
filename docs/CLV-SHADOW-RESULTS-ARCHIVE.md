# CLV-shadow — ARKIV av resultat & lärdomar (före ren omstart)

> **Sparat 2026-06-22** inför en medveten **ren omstart** av CLV-/sharp-consensus-
> arbetet med utökad scope (alla skarpa böcker + AH/totals på alla sidor) och
> **noll dubbelräkning**. Detta dokument bevarar vad vi byggt, datan vi fått och
> de korrekthetsfällor vi hittat — så att omstarten görs RÄTT från början.

## 1. Vad som byggdes (sharp-consensus-mellanlager, shadow-only)
Allt i `src/lib/odds/` + scripts + workflows (på `main` + dev-branch `claude/great-franklin-R2IGD`):
- **consensus/confidence/trust:** `consensus.ts`, `confidence.ts`, `sourceTrustConfig.ts`, `marketTypeConfig.ts`, `sourceWeights.ts` — fair price (steg 1) skilt från value-beslut (steg 2). 5 scenarier (PINNACLE_ANCHOR, BETFAIR_LIQUID_PRIMARY, SHARP_CONSENSUS_NO_PINNACLE, SOFT_CONSENSUS_PROP, NO_RELIABLE_BENCHMARK).
- **Betfair:** `betfairLiquidityFilter.ts`, `betfairAdapter.ts`, `betfairScrapeParse.ts` (+ scrape-scaffold, ej live-verifierad).
- **line-matching:** `lineMatching.ts` (exact → quarter_split → interpolated → rejected) för totals/AH.
- **props:** `propEngine.ts` (separat, aldrig auto i v1).
- **CLV-loop:** `clvLogger.ts`, `clvSettle.ts`, `clvCapture.ts`, `clvAnalysis.ts`, `clvDedupe.ts`, `clvReport.ts`, `trustFeedback.ts`, `bookmakerGroups.ts`, `shadowConsensus.ts`.
- **workflows:** `shadow-clv.yml` (självdrivande loop, capture→settle→shadow, actions/cache), `clv-report.yml` (read-only rapport).
- **~118 tester gröna.** Allt shadow-only: `executed=false`, inga live-beslut, inga secrets.

## 2. Datasnapshot (2026-06-22, efter ~13h shadow-only, PINNACLE-ONLY)
- raw rows ~26 000 → **deduped ~99 samples** → **settled ~15**.
- **total avgCLV ≈ −11,9 %** (median ≈ −10,4 %) — väntat negativt: soft-book-pris mot Pinnacle no-vig closing = ungefär vig:en.
- **AUTO_BET (value-subsetet): 0 settled** → modellen kunde INTE bedömas (för få/ingen settlad value-bet än).
- trustFeedback: `INSUFFICIENT_DATA` på alla celler.
- **Slutsats:** loopen fungerar end-to-end, men för lite settlad value-data för slutsatser.

## 3. Korrekthetsfällor vi hittade (KRITISKT för omstarten)
1. **Systerbrands dubbelräknades (4×).** Hajper/Snabbare/Casinostugan/Lyllo är ComeOn-systerbrands; samma bet räknades 4 ggr (en per sida). **Fix:** dedupe per plattforms-grupp.
2. **Systerbrands delar INTE odds — 2 prisnivåer.** Verifierat mot `comeon-rows.json`: 100 av 102 delade events har olika odds (Hajper/Snabbare högre, Casinostugan/Lyllo lägre). **Fix:** vid kollaps behåll **BÄSTA priset** (det du faktiskt skulle ta), inte godtycklig representant.
3. **Corner/booking-marknader läcker in som ML_1X2.** Ligor som "FIFA - World Cup Corners" / "...Bookings" ingestas som matchvinnare → förorenar 1X2. **EJ fixat — måste filtreras vid omstart.**
4. **Closing line finns bara för Pinnacle-marknader.** Props/gold boosts saknar Pinnacle-closing → kräver annan referens (soft consensus / Betfair-likviditet / egen modell). Hanteras separat.
5. **Capture-timing:** smalt fönster [15 min före, 2 efter] → settled fylls långsamt; matcher måste passera avspark under ett körande pass.

## 4. Principer för OMSTARTEN (gör rätt — ingen dubbelräkning)
- **En bet-tillfälle = (event, marketType, line, selection) per plattforms-grupp, vid bästa pris.** Aldrig N× per systersajt.
- **Marknadstyps-hygien:** corners/bookings/cards/team-totals m.m. får ALDRIG blandas med match-1X2/AH/match-total. Exakt market-typ + scope krävs (jfr `lineMatching` scope-krav).
- **Line-matching:** Over 2.25 ≠ Over 2.5; AH -0.25 ≠ -0.5; quarter-split korrekt; reject hellre än interpolera fel.
- **Sharp-consensus:** Pinnacle default; SBO/IBC korrelerar (räkna ej som oberoende); Betfair endast vid likviditet; props separat.
- **CLV mäts mot Pinnacle no-vig closing** där den finns; annars dokumenterad alternativ referens.
- **Allt shadow-only tills CLV bevisat positivt per cell (trustFeedback ≥ min samples).**

## 5. Utökad scope för omstarten (att bygga, kräver prerequisites)
- **Alla skarpa böcker:** Betfair Exchange, SBOBET, IBC/ISN, Singbet. **Prereq:** dataåtkomst. Pinnacle = öppet gäst-API; Betfair = eget API/scrape; **SBO/IBC/Singbet har ingen publik API → kräver tredjeparts-feed.** Måste lösas innan de kan "följas".
- **AH + totals på ALLA sidor.** **Prereq:** (a) Pinnacle-fetch måste utökas från moneyline till AH/totals (`fetch-pinnacle-github-action.mjs` trimmar idag till `period=0` moneyline); (b) varje soft books fetcher måste leverera AH/totals (idag mest 1X2). Stort fetch-arbete.

## 6. Var datan/koden finns
- Kod + workflows: `main` (sharp-consensus-infra) + dev-branch.
- Research/design: `docs/SHARP-SOURCES-DESIGN.md`, `docs/SWEDISH-*.md`.
- CLV-state: `actions/cache` (`shadow-clv-state-*`). **Vid ren omstart: byt cache-namespace så gammal (flawed) data inte läses in.**

*Detta arkiv är referenspunkten. Den faktiska omstarts-planen och kraven kommer i nästa prompt.*
