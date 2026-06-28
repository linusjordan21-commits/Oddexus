# Multi-sharp benchmark-system — design (Betfair, SBOBET, IBC/ISN, Singbet)

> **Syfte:** lägga till 4 sharp-källor som *benchmark/confirmation* till Pinnacle utan att skapa falska valuebets. Grundprincip: **hellre missa value än flagga falskt value.**
>
> **Förankring i befintlig kod:** återanvänder `src/lib/odds/edge.ts` (devig + edge), `src/lib/odds/matching.ts` (event-matchning), `src/lib/odds/types.ts` (MarketType), `SOURCE_REGISTRY` i `vite.config.ts`, freshness via `data/source-tolerance.json`. Nytt lager = **Consensus Fair-Price Engine** som ersätter "Pinnacle = enda referensen".

---

## 0. Dataverklighet FÖRST (måste lösas innan logiken spelar roll)
Designen är feed-agnostisk: **en adapter per källa**, oavsett hur datan kommer in. Men acquisition skiljer sig kraftigt och avgör vad som ens är möjligt:

| Källa | Åtkomst | Realistisk väg | Pre/live |
|---|---|---|---|
| **Betfair Exchange** | Officiellt **API** (app key + finansierat konto) | Direkt API — ger back/lay, matched volume, depth | båda, bäst nära start |
| **SBOBET** | Ingen publik API; agent-nätverk | Tredjeparts odds-feed/aggregator (BetsAPI, OddsJam-typ) eller scraping av agentportal | pre + live |
| **IBC/ISN** (BTi/ISN-nätet) | Ingen publik API | Samma aggregator-feeds som SBO; ofta SAMMA leverantör → korrelerar | pre + live |
| **Singbet** | Ingen publik API | Aggregator-feed | pre |

**Konsekvens för designen:**
1. **Betfair är den enda du tekniskt äger linan på** (ditt eget API-konto). Den blir därför din viktigaste *oberoende* extra-källa.
2. **SBOBET + IBC/ISN kommer ofta från samma feed-leverantör och delar prissättningsmotor** → de är **inte två oberoende röster**. Korrelationsdämpning (avsnitt 4) är inte en finess, den är nödvändig för att "2 av 3 håller med" ska betyda något.
3. Pinnacle-fetchen måste utökas från moneyline till **spreads + totals + AH** (`scripts/fetch-pinnacle-github-action.mjs` hämtar redan `/markets/straight` men trimmar till `period=0` moneyline) innan AH/totals-consensus är meningsfull.

---

## 1. Trust-modell (kärnan)

Trust är **inte** ett tal per källa. Det är en uppslagning per **cell**:

```
trust_cell = (source, sport, league_tier, market_type, phase, tts_bucket)
```

- `sport`: football | tennis | basketball
- `league_tier`: T1 (toppligor/ATP-WTA/NBA-Euroleague) | T2 | T3 (Challenger/ITF/obskyrt)
- `market_type`: ML_1X2 | ML_2WAY | AH | ASIAN_TOTAL | TOTAL | SPREAD | PLAYER_PROP
- `phase`: prematch | live
- `tts_bucket`: >24h | 6–24h | 1–6h | <1h (närmare start = sharpare)

Varje cell ger:
```
baseTrust ∈ {0, 0.2 … 1.0}   // 0 = får ALDRIG vara benchmark här
```
Plus dynamiska modifierare som beräknas i runtime:
```
effectiveTrust = baseTrust
               × liquidityFactor   (endast Betfair, annars 1)
               × clvMultiplier     (från historik, 0.7…1.15, default 1)
               × ttsFactor         (0.9…1.05)
```

### 1.1 `source_trust_config` (config-struktur)
Lagras som JSON i `data/source-trust-config.json`, läses likt `source-tolerance.json`. Wildcard `"*"` = default, specifika celler overridar.

```jsonc
{
  "version": 3,
  "sources": {
    "pinnacle": { "role": "primary", "*": 1.0 },   // alltid anchor när den finns

    "betfair": {
      "role": "independent_sharp",
      "requiresLiquidity": true,
      "football":   { "T1": { "AH": 0.85, "ASIAN_TOTAL": 0.8, "ML_1X2": 0.8, "TOTAL": 0.8 },
                      "T2": { "*": 0.5 }, "T3": { "*": 0.2 } },
      "tennis":     { "T1": { "ML_2WAY": 0.9, "AH": 0.7, "TOTAL": 0.6 },
                      "T3": { "*": 0.25 } },         // Challenger/ITF: låg
      "basketball": { "T1": { "SPREAD": 0.7, "TOTAL": 0.7, "ML_2WAY": 0.7 } },
      "PLAYER_PROP": 0                                // aldrig
    },

    "sbobet": {
      "role": "asian_sharp",
      "football":   { "T1": { "AH": 0.95, "ASIAN_TOTAL": 0.95, "ML_1X2": 0.7 },
                      "T2": { "AH": 0.8, "ASIAN_TOTAL": 0.8 }, "T3": { "AH": 0.55 } },
      "basketball": { "T1": { "SPREAD": 0.75, "ASIAN_TOTAL": 0.75 } },
      "tennis":     { "T1": { "ML_2WAY": 0.6, "AH": 0.6 }, "T3": { "*": 0.2 } },
      "PLAYER_PROP": 0
    },

    "ibc": {                                          // IBC/ISN — nästan identisk profil som SBO
      "role": "asian_sharp",
      "football":   { "T1": { "AH": 0.9, "ASIAN_TOTAL": 0.9, "ML_1X2": 0.65 },
                      "T2": { "AH": 0.75, "ASIAN_TOTAL": 0.75 }, "T3": { "AH": 0.5 } },
      "basketball": { "T1": { "SPREAD": 0.7, "ASIAN_TOTAL": 0.7 } },
      "tennis":     { "T1": { "ML_2WAY": 0.55 }, "T3": { "*": 0.2 } },
      "PLAYER_PROP": 0
    },

    "singbet": {                                      // svagast → mest confirmation
      "role": "asian_confirm",
      "football":   { "T1": { "AH": 0.7, "ASIAN_TOTAL": 0.7 }, "T2": { "AH": 0.5 } },
      "basketball": { "T1": { "SPREAD": 0.55, "ASIAN_TOTAL": 0.55 } },
      "tennis":     { "T1": { "ML_2WAY": 0.4 } },
      "PLAYER_PROP": 0
    }
  },

  // KORRELATION: källor i samma grupp räknas inte som oberoende (avsnitt 4)
  "correlationGroups": [
    { "id": "asian_bti", "members": ["sbobet", "ibc", "singbet"], "rho": 0.7 }
  ]
}
```

**Att läsa ur tabellen:** SBO/IBC = primära asiatiska benchmarks för fotboll-AH/totals; Singbet = confirmation; Betfair = stark men bara där likviditeten finns (T1 + nära start); ingen källa får vara benchmark för PLAYER_PROP; Challenger/ITF (T3) trycks ner överallt.

---

## 2. Vilka marknader varje källa får vara benchmark för (matris)

✅ = får bidra till fair-linjen · ⭐ = primär när Pinnacle saknas · 🔸 = endast confirmation · ⛔ = aldrig

| Marknad | Pinnacle | Betfair | SBOBET | IBC/ISN | Singbet |
|---|---|---|---|---|---|
| Fotboll **AH** | ✅ primär | ✅ (likvid T1) | ⭐ | ⭐ | 🔸 |
| Fotboll **Asian total** | ✅ primär | ✅ (likvid T1) | ⭐ | ⭐ | 🔸 |
| Fotboll **1X2 / total** | ✅ primär | ✅ (likvid T1) | ✅ | ✅ | 🔸 |
| Tennis **ML (ATP/WTA)** | ✅ primär | ⭐ (likvid) | ✅ validera | ✅ validera | 🔸 |
| Tennis **Challenger/ITF** | ✅ om finns | 🔸 låg | 🔸 låg | 🔸 låg | ⛔ |
| Basket **spread/total** | ✅ primär | ✅ (likvid) | ✅ | ✅ | 🔸 |
| Basket **ML** | ✅ primär | ✅ (likvid) | ✅ | ✅ | 🔸 |
| **Player props** | (har sällan) | ⛔ | ⛔ | ⛔ | ⛔ |

Player props körs i en **separat pipeline** (avsnitt 11) — aldrig genom denna matris.

---

## 3. När systemet litar på vad — beslutsträd

```
FÖR VARJE (event, market_type, line, selection) där en SOFT book ger candidate-odds:

1. Bygg benchmarkSet = alla sharp-källor som (a) har marknaden, (b) har baseTrust>0 i cellen,
   (c) är FRESH (freshness-gate per källa), (d) för Betfair: passerar liquidity_filter.

2. ── Pinnacle finns i benchmarkSet? ──────────────────────────────
   JA →  fairLine   = Pinnacles no-vig-linje (devig)
         confirmers = övriga i benchmarkSet
         scenario   = "PINNACLE_ANCHOR"
         → confidence börjar högt; confirmers JUSTERAR (avsnitt 5)
         → om confirmers KRAFTIGT oense med Pinnacle (avsnitt 5.3) → NO_BET

   NEJ → (Pinnacle saknar marknaden)
         Räkna effektiva oberoende källor N_eff (avsnitt 4).
         ── N_eff ≥ 2 (helst ≥2 av sbobet/ibc/singbet, ELLER Betfair-likvid + 1) ──
            JA → fairLine = viktad consensus (avsnitt 5.2)
                 scenario = "CONSENSUS"
                 → högre minimum-edge-krav (avsnitt 8)
            NEJ → ── exakt 1 källa? ──
                  Betfair mycket likvid & stor liga → scenario="SINGLE_BETFAIR" → MANUAL_REVIEW
                  annars                              → scenario="SINGLE_WEAK"   → NO_BET

3. edgePct = candidateOdds × fairProb(selection) − 1   (befintlig computeOpportunity)

4. requiredEdge = minEdgeByMarket[market] + (1 − benchmarkConfidence) × penaltySlope[market]
                  (+ scenario-tillägg, avsnitt 8)

5. BESLUT (avsnitt 9):
   edgePct < requiredEdge                         → NO_BET
   edgePct ≥ requiredEdge & conf ≥ C_auto & auto-tillåten marknad → AUTO_BET
   edgePct ≥ requiredEdge & conf ≥ C_review       → MANUAL_REVIEW
   sharp-källor oense (dispersion hög)            → NO_BET (override allt)
```

---

## 4. Oberoende & korrelation (varför "2 av 3" kan vara en illusion)

SBOBET, IBC/ISN och Singbet rör sig ofta ihop (samma asiatiska prisflöde, ibland samma feed). Att tre korrelerade källor "håller med" ger nästan ingen extra information.

**Effektivt antal oberoende källor** via korrelations-nedräkning:
```
// rho = korrelation inom grupp (0.7 i config)
function effectiveIndependentCount(sourcesPresent, groups):
    n_eff = 0
    for each correlationGroup g:
        k = antal källor i benchmarkSet som tillhör g
        if k > 0:
            // k korrelerade källor ≈ 1 + (k−1)(1−rho) oberoende röster
            n_eff += 1 + (k - 1) * (1 - g.rho)
    n_eff += antal källor som INTE tillhör någon grupp   // Pinnacle, Betfair = fullt oberoende
    return n_eff
```
Exempel: SBO+IBC+Singbet alla håller med (rho=0.7) → `1 + 2×0.3 = 1.6` oberoende röster, **inte 3**. Då räcker det inte för "consensus utan Pinnacle" (kräver N_eff ≥ 2) om inte Betfair också är med. Detta är den medvetna spärren mot falskt asiatiskt "consensus".

---

## 5. Consensus Fair-Price Engine + confidence_score

### 5.1 Devig per källa (återanvänder `edge.ts`-logiken)
2-way (AH, asian total, tennis ML, basket spread):
```
p_over_novig = (1/over) / (1/over + 1/under)
```
3-way (1X2): devig via overround precis som `indexReferenceOdds()` gör idag.

### 5.2 Viktad consensus (när Pinnacle saknas)
```
fairProb(sel) = Σ_i  w_i · p_i(sel)   /   Σ_i w_i
w_i = effectiveTrust_i(cell) × independenceWeight_i × liquidityFactor_i
```
`independenceWeight_i` = 1/groupSize för korrelerade källor (så SBO/IBC/Singbet delar på vikten istället för att tredubbla den).

### 5.3 Confidence-score (0…1) — den centrala valutan
```
function benchmarkConfidence(scenario, benchmarkSet, dispersion, cell):
    base = { PINNACLE_ANCHOR: 0.60,
             CONSENSUS:       0.45,
             SINGLE_BETFAIR:  0.35,
             SINGLE_WEAK:     0.12 }[scenario]

    // (a) AGREEMENT: hur tätt no-vig-sannolikheterna ligger för selection
    //     dispersion = stდev(p_i(sel)) över benchmarkSet (+ Pinnacle om anchor)
    agreement = clamp(1 - dispersion / DISPERSION_REF[market], 0, 1)   // DISPERSION_REF ≈ 0.02
    base += 0.25 * agreement

    // (b) oberoende-bonus
    base += 0.10 * clamp((N_eff - 1) / 2, 0, 1)

    // (c) modifierare
    conf = base
         × ttsFactor(tts_bucket)        // <1h: 1.05, >24h: 0.9
         × clvMultiplier(cell)          // från historik, default 1
         × (betfairInSet ? liquidityFactor : 1)

    return clamp(conf, 0, 1)
```
**Disagreement-grind (5.3-override):** om `dispersion > DISPERSION_KILL[market]` (t.ex. >0.035 prob, ≈ linorna pekar åt olika håll) → **NO_BET oavsett edge**. Det är här falska valuebets dör: ett soft-pris ser ut som value bara för att en sharp-källa är fel/stale, men de andra avslöjar det.

---

## 6. Line-matching engine (samma event, samma marknad)

Två nivåer:

### 6.1 Event-matchning (utöka befintlig `matching.ts`)
Behåll team-normalisering + 30-min-buckets, men:
- lägg till `sport` i nyckeln (idag de facto football-only),
- lägg till **alias-tabell** per källa (asiatiska böcker stavar lag annorlunda: "Man Utd" vs "Manchester United", kinesiska/translittererade namn) → `data/team-aliases.json`,
- för tennis: matcha på **efternamn + initial + turnering** (inte klubbsuffix-logiken).

```
eventKey = sport :: norm(home) :: norm(away) :: timeBucket
```
Asiatiska feeds har ofta eget event-id → mappa via alias en gång, cacha paret.

### 6.2 Market/line-matchning (avsnitt 7–8)
Efter event-match: para market_type. För AH/totals krävs **line-interpolation** eftersom böcker har olika linor.

---

## 7. Olika linor (Over 2.25 vs 2.5 vs 2.75) — interpolation

Du kan inte jämföra ett soft-pris på **Over 2.5** mot en sharp-källa som bara har **2.25** och **2.75**. Lös med **monoton interpolation i sannolikhetsrummet**:

```
function fairProbAtLine(sourcePoints, targetLine, side):
    // sourcePoints = [{line, pOver_novig}, ...] för denna källa/marknad
    // P(Over) är monotont AVTAGANDE i line (högre total = mindre sannolikt över)
    if targetLine finns exakt: return direkt
    (loLine, loP), (hiLine, hiP) = närmaste linor runt targetLine
    pOver = linInterp(loLine, loP, hiLine, hiP, targetLine)   // ev. log-odds-interpolation
    return side == OVER ? pOver : 1 - pOver
```
- Helst **log-odds-interpolation** (interpolera logit(p), inte p) — stabilare i svansarna.
- Extrapolera ALDRIG utanför källans linor mer än ±0.25 → annars markera marknaden som "ej jämförbar" (bidrar inte till consensus).
- Pinnacle ger ofta tät line-stege → bäst interpolations-ankare när den finns.

---

## 8. Asian handicap & Asian totals korrekt

### 8.1 Kvartslinor = split
- AH **−0.25** = halva insatsen på 0.0, halva på −0.5. Total **2.25** = halva på 2.0, halva på 2.5.
- Fair-sannolikhet för en kvartslina = **medel av de två halvlinornas** no-vig-sannolikheter:
```
pFair(AH -0.25) = 0.5 · pFair(AH 0.0) + 0.5 · pFair(AH -0.5)
```
- Settlement (för EV/CLV-bokföring): kvartslinor ger push/halvvinst → modellera utfall som {win, half-win, push, half-loss, loss}, inte binärt.

### 8.2 Devig på 2-way asian
Asiatiska böcker har låg vig (~1.5–2%) → no-vig nära rådata, men devigga ändå:
```
pHome = (1/oddsHome) / (1/oddsHome + 1/oddsAway)
```

### 8.3 AH ↔ 1X2-konsistens (sanity-check)
När både Pinnacle (1X2) och SBO (AH) finns: konvertera AH-linjen till implicit 1X2-fördelning (via supremacy/total-modell) och kolla att de inte motsäger varandra grovt → annars sänk confidence. Billig korskontroll som fångar feltolkade linor.

---

## 9. minimum_edge_by_market + auto/no-bet/review-regler

### 9.1 `minimum_edge_by_market` (startvärden, kalibreras via CLV)
```jsonc
{
  // baseEdge = krav när confidence = 1.0; penaltySlope = tillägg per (1−confidence)
  "football_AH":          { "baseEdge": 1.5, "penaltySlope": 4.0, "autoAllowed": true  },
  "football_ASIAN_TOTAL": { "baseEdge": 1.5, "penaltySlope": 4.0, "autoAllowed": true  },
  "football_1X2":         { "baseEdge": 2.0, "penaltySlope": 4.0, "autoAllowed": true  },
  "football_TOTAL":       { "baseEdge": 2.0, "penaltySlope": 4.0, "autoAllowed": true  },
  "tennis_ML_T1":         { "baseEdge": 2.0, "penaltySlope": 4.5, "autoAllowed": true  },
  "tennis_ML_T3":         { "baseEdge": 4.0, "penaltySlope": 6.0, "autoAllowed": false },
  "basket_SPREAD":        { "baseEdge": 2.0, "penaltySlope": 4.5, "autoAllowed": true  },
  "basket_TOTAL":         { "baseEdge": 2.0, "penaltySlope": 4.5, "autoAllowed": true  },
  "PLAYER_PROP":          { "baseEdge": 6.0, "penaltySlope": 8.0, "autoAllowed": false }
}
requiredEdge = baseEdge + (1 − benchmarkConfidence) × penaltySlope + scenarioAdd
scenarioAdd = { PINNACLE_ANCHOR: 0, CONSENSUS: +1.0, SINGLE_BETFAIR: +2.5 }
```

### 9.2 Trösklar
```
C_auto   = 0.65    // under detta: aldrig auto-bet
C_review = 0.40    // under detta: aldrig ens review → no-bet
```

### 9.3 Beslut
```
function decide(edgePct, conf, dispersion, market, scenario):
    if dispersion > DISPERSION_KILL[market]:           return NO_BET("sharp disagreement")
    req = requiredEdge(market, conf, scenario)
    if edgePct < req:                                  return NO_BET("below edge")
    if conf < C_review:                                return NO_BET("benchmark too weak")
    if conf < C_auto:                                  return MANUAL_REVIEW
    if not minEdgeByMarket[market].autoAllowed:        return MANUAL_REVIEW
    if scenario != "PINNACLE_ANCHOR" and N_eff < 2:    return MANUAL_REVIEW
    return AUTO_BET
```

---

## 10. Saknade Pinnacle-marknader (kärnscenariot du beskrev)
1. Markera marknaden `pinnacleMissing = true`.
2. Kräv `scenario = CONSENSUS` med `N_eff ≥ 2` (efter korrelations-nedräkning → i praktiken SBO+IBC räcker INTE ensamma, du behöver Singbet ELLER Betfair-likvid som tredje signal, eller Betfair+en asiat).
3. Höj edge-kravet (`scenarioAdd CONSENSUS +1.0`).
4. Sänk confidence-tak: även perfekt agreement utan Pinnacle kapas vid ~0.8.
5. Logga dessa separat i CLV (avsnitt 12) — det är här du lär dig om consensus-only faktiskt slår stängningen, vilket avgör om du på sikt vågar auto-bet:a utan Pinnacle.

---

## 11. Player props — helt separat pipeline

Aldrig genom consensus-matrisen. Egen modul `propEngine`.

```jsonc
// prop_market_config
{
  "requireExactRuleMatch": true,     // skott vs skott-på-mål vs touches är OLIKA marknader
  "ruleKeys": ["statType","line","starterRequired","includesOT","voidIfNotStart","periodScope"],
  "minSoftBooksSameMarket": 3,       // minst 3 soft books med EXAKT samma regel-tuple
  "minEdgeVsSoftConsensus": 6.0,     // % — högre än main markets
  "boostedHandling": "NEEDS_VALIDATION",  // boostade odds aldrig auto-value
  "autoBet": false                   // tills propModelReady && CLV-historik finns
}
```

Beslutslogik:
```
function decideProp(prop):
    if !exactRuleMatchAcrossBooks(prop):        return NO_BET("rule mismatch")
    if prop.isBoosted:                          return NEEDS_VALIDATION
    softConsensus = novigConsensus(softBooksWithExactRule)   // soft, inte sharp!
    if count(softBooksSameRule) < 3:            return NO_BET("insufficient market")
    edge = prop.odds × softConsensus.fairProb − 1
    if edge < minEdgeVsSoftConsensus:           return NO_BET
    if !propModelReady(statType,league):        return NEEDS_VALIDATION   // ingen auto utan modell/CLV
    return MANUAL_REVIEW                         // props når aldrig AUTO_BET i v1
```
Nyckel: **soft-book-consensus är inte en sharp fair price** — den används bara för att en boostad outlier inte ska se ut som value när den bara är en felprissatt enskild bok. "Isak över 0.5 skott på Unibet/Bet365" → om bara dessa två har marknaden och Pinnacle saknar den → `NEEDS_VALIDATION`, aldrig valuebet.

---

## 12. CLV-tracking per källa/sport/marknad

Utöka befintlig CLV-loggning (`pinnacle-history.json`, `/api/valuebets/analysis`) med **källattribuering**.

```jsonc
// en rad per flaggad/lagd bet → data/clv-log.jsonl
{
  "ts": "2026-06-21T18:00:00Z",
  "event": "eventKey",
  "sport": "football", "leagueTier": "T1",
  "market": "football_AH", "line": -0.25, "selection": "HOME",
  "scenario": "CONSENSUS",
  "benchmarkSources": ["sbobet","ibc","singbet"],
  "nEff": 1.6,
  "ourBook": "unibet", "ourOdds": 1.98,
  "fairProbAtFlag": 0.49, "edgePctAtFlag": 2.0, "confidenceAtFlag": 0.52,
  "decision": "MANUAL_REVIEW",
  // fylls i vid stängning:
  "closingFairProb": 0.485,          // Pinnacle-stängning om den dök upp, annars consensus-stängning
  "closingSource": "pinnacle",
  "clvPct": null                     // = ourOdds × closingFairProb − 1
}
```
- **CLV är facit, inte edge-vid-flagg.** En källa är "sharp i denna cell" bara om bets flaggade via den har **positiv genomsnittlig CLV** över tid.
- Aggregera per cell `(source, sport, leagueTier, market, phase, ttsBucket)`: `n`, `meanCLV`, `stdCLV`, `beatRate` (% med CLV>0).
- För consensus-only-rader: jämför mot Pinnacle-stängning **när Pinnacle dyker upp nära start** — det är guldtestet på om dina asiatiska källor var rätt.

---

## 13. Auto-uppgradering / nedgradering av trust

Efter tillräcklig data per cell, justera `clvMultiplier` (som går in i confidence) — **inte** baseTrust direkt (behåll baseTrust som mänsklig prior).

```
function updateTrust(cell):
    s = clvStats(cell)
    if s.n < MIN_SAMPLES[cell.market]:   return    // t.ex. 200 för main, 500 för props
    // Bayesiansk shrink mot prior 0 CLV
    shrunkCLV = s.meanCLV × s.n / (s.n + K)         // K ≈ 100
    target = 1 + clamp(shrunkCLV / CLV_SCALE, -0.3, +0.15)   // 0.7…1.15
    // hysteres: rör multiplikatorn långsamt
    cell.clvMultiplier += 0.2 × (target − cell.clvMultiplier)
    // hård nedgradering
    if s.beatRate < 0.45 and s.n > 2×MIN_SAMPLES:
        cell.baseTrust = max(0, cell.baseTrust − 0.2)   // föreslå till människa, logga
        flagForReview(cell)
```
- **Uppgradering är trög och takad** (+15% max) — du vill inte att en het strnig gör en svag källa till "auto".
- **Nedgradering är snabbare** (CLV-förlust → skär direkt) — i linje med "hellre missa än falskt".
- Allt loggas; baseTrust-sänkningar kräver mänsklig bekräftelse innan de permanentas.

---

## 14. Implementationsordning (konkret, minimal risk)
1. **Betfair-adapter via officiellt API** (`scripts/fetch-betfair-github-action.mjs` → `data/betfair-rows.json`) + `liquidity_filter`. Enklast att äga, mest oberoende.
2. **Utöka Pinnacle-fetch** till spreads+totals+AH (lyft `period=0`-trimmet).
3. **Consensus Fair-Price Engine** som nytt modul-lager framför `edge.ts` (`src/lib/odds/consensus.ts`) — `indexReferenceOdds` blir ett specialfall (PINNACLE_ANCHOR).
4. **`source-trust-config.json` + line-interpolation** (avsnitt 7) + AH-split (avsnitt 8).
5. **CLV-logg med källattribuering** (avsnitt 12) — kör i "shadow mode" (loggar beslut men auto-bet av) i flera veckor.
6. **SBOBET/IBC/Singbet-adaptrar** när feed-källa är vald; börja som confirmation-only (auto av).
7. **Player-prop-pipeline** sist, alltid `MANUAL_REVIEW`/`NEEDS_VALIDATION` i v1.
8. **Trust-auto-update** aktiveras först när varje cell har MIN_SAMPLES.

### Nya building blocks ↔ filer
| Block | Fil |
|---|---|
| source_trust_config | `data/source-trust-config.json` |
| market_type_config / minimum_edge_by_market | `src/lib/odds/marketConfig.ts` |
| sharp_consensus_engine | `src/lib/odds/consensus.ts` |
| line_matching_engine | utöka `src/lib/odds/matching.ts` + `data/team-aliases.json` |
| liquidity_filter (Betfair) | `src/lib/odds/betfairLiquidity.ts` |
| confidence_score | `src/lib/odds/confidence.ts` |
| CLV tracking | `data/clv-log.jsonl` + utöka `/api/valuebets/analysis` |
| prop engine | `src/lib/odds/propEngine.ts` |
| registry | utöka `SOURCE_REGISTRY` i `vite.config.ts` (type: "sharp"/"exchange") |

---

## 15. Roll-klassificering per källa — primary / confirmation / weak / ignore

En källas **roll bestäms i runtime per cell** (sport × market × tier × phase × tts), inte globalt. Definition av rollerna:

| Roll | Betydelse | Får ensam skapa value? | Vikt i consensus |
|---|---|---|---|
| **primary** | får definiera fair-linjen | ja (om även confidence-grind passerar) | full |
| **confirmation** | får justera confidence upp/ned, ej definiera linjen ensam | nej | halv |
| **weak signal** | bidrar bara marginellt; höjer ej confidence över review-tröskel ensam | nej | låg |
| **ignore** | används inte alls som benchmark i denna cell | nej | 0 |

Regel för att härleda roll ur `effectiveTrust` i cellen:
```
role(effectiveTrust, isPinnacle, scenario):
    if isPinnacle and marketExists:      return "primary"
    if effectiveTrust >= 0.80:           return "primary"        // bara om Pinnacle saknas
    if effectiveTrust >= 0.55:           return "confirmation"
    if effectiveTrust >= 0.30:           return "weak"
    return "ignore"
```

### Roll-matris (typiska celler, T1 om inget annat anges)

| Källa | Fotboll AH/AsianTotal | Fotboll 1X2/total | Tennis ML T1 | Tennis T3 (Chall/ITF) | Basket spread/total | Player props |
|---|---|---|---|---|---|---|
| **Pinnacle** | **primary** | **primary** | **primary** | primary (om finns) | **primary** | ignore (har sällan) |
| **Betfair** | primary om likvid, annars confirmation | confirmation | **primary** om likvid | weak | confirmation (likvid) | **ignore** |
| **SBOBET** | **primary** (när Pin saknas) | confirmation | confirmation | weak | confirmation | **ignore** |
| **IBC/ISN** | **primary** (när Pin saknas) | confirmation | confirmation | weak | confirmation | **ignore** |
| **Singbet** | confirmation | weak | weak | ignore | weak | **ignore** |

**Läs så här:** När Pinnacle finns är allt annat `confirmation`/`weak` (de får aldrig överrösta Pinnacle, bara bekräfta). När Pinnacle saknas på fotboll-AH kan SBO/IBC bli `primary` — men korrelationsspärren (N_eff) gör att de inte räcker som *par* för auto-bet; de behöver en oberoende tredje röst (Singbet höjer knappt N_eff; Betfair-likvid gör det). Singbet är aldrig starkare än `confirmation`. Betfair växlar mellan `primary` och `confirmation` enbart på likviditet.

---

## 16. `source_weights` (explicit) — råvikter före runtime-modifierare

Detta är **baseTrust** komprimerat till en vikt-tabell för consensus-medelvärdet (avsnitt 5.2). Runtime-vikten = `source_weights[cell] × independenceWeight × liquidityFactor × clvMultiplier`.

```jsonc
// source_weights.json  — 0 = ignore
{
  "football": {
    "AH":          { "pinnacle": 1.00, "betfair": 0.85, "sbobet": 0.95, "ibc": 0.90, "singbet": 0.70 },
    "ASIAN_TOTAL": { "pinnacle": 1.00, "betfair": 0.80, "sbobet": 0.95, "ibc": 0.90, "singbet": 0.70 },
    "1X2":         { "pinnacle": 1.00, "betfair": 0.80, "sbobet": 0.70, "ibc": 0.65, "singbet": 0.40 },
    "TOTAL":       { "pinnacle": 1.00, "betfair": 0.80, "sbobet": 0.75, "ibc": 0.70, "singbet": 0.45 }
  },
  "tennis": {
    "ML_T1":       { "pinnacle": 1.00, "betfair": 0.90, "sbobet": 0.60, "ibc": 0.55, "singbet": 0.40 },
    "ML_T3":       { "pinnacle": 1.00, "betfair": 0.25, "sbobet": 0.20, "ibc": 0.20, "singbet": 0.00 },
    "AH":          { "pinnacle": 1.00, "betfair": 0.70, "sbobet": 0.60, "ibc": 0.55, "singbet": 0.35 },
    "TOTAL":       { "pinnacle": 1.00, "betfair": 0.60, "sbobet": 0.55, "ibc": 0.50, "singbet": 0.30 }
  },
  "basketball": {
    "SPREAD":      { "pinnacle": 1.00, "betfair": 0.70, "sbobet": 0.75, "ibc": 0.70, "singbet": 0.55 },
    "ASIAN_TOTAL": { "pinnacle": 1.00, "betfair": 0.70, "sbobet": 0.75, "ibc": 0.70, "singbet": 0.55 },
    "TOTAL":       { "pinnacle": 1.00, "betfair": 0.70, "sbobet": 0.70, "ibc": 0.65, "singbet": 0.50 },
    "ML_2WAY":     { "pinnacle": 1.00, "betfair": 0.70, "sbobet": 0.70, "ibc": 0.65, "singbet": 0.45 }
  },
  "_tierMultiplier": { "T1": 1.0, "T2": 0.7, "T3": 0.4 },   // multipliceras på ovan
  "_phaseMultiplier": { "prematch": 1.0, "live": 0.8 }       // live = snabbare, mer brus → lägre
}
```

---

## 17. Konkreta exempel (hela kedjan → beslut)

### Exempel A — Fotboll AH, Pinnacle finns → AUTO_BET
- **Match:** Real Madrid–Sevilla, La Liga (T1), prematch, 3h kvar (tts `1–6h`).
- **Soft book:** Unibet **AH Hemma −0.5 @ 2.02**.
- **Sharp-linor (no-vig P(Hemma −0.5)):** Pinnacle 1.90/2.00 → **0.5128**; SBO 1.91/1.99 → 0.5112; IBC 1.92/1.98 → 0.5120.
- **Scenario:** PINNACLE_ANCHOR (fair = Pinnacle 0.5128 → fair odds 1.950).
- **Dispersion** {0.5128, 0.5112, 0.5120} ≈ 0.0008 → agreement ≈ 1.0.
- **N_eff** = Pinnacle (1) + asian-grupp {sbo,ibc} k=2 → 1+0.3 = **2.3**.
- **edge** = 2.02 × 0.5128 − 1 = **+3.6 %**.
- **confidence** = 0.60 + 0.25·1.0 + 0.10·clamp((2.3−1)/2)=0.065 = **0.93** (×tts 1.0, ingen Betfair).
- **requiredEdge** = 1.5 + (1−0.93)·4.0 + 0 = **1.78 %**.
- **Beslut:** edge 3.6 ≥ 1.78, conf 0.93 ≥ 0.65, autoAllowed, anchor → **AUTO_BET** ✅. (Confirmers bekräftar Pinnacle → ingen disagreement-kill.)

### Exempel B — Tennis ML, Pinnacle SAKNAS → NO_BET trots positiv edge
- **Match:** ATP 250, R2 (T1), Pinnacle har **suspenderat** marknaden, ~2h kvar.
- **Soft book:** Bet365 **Spelare A @ 1.95**.
- **Betfair:** A 1.83 / B 2.10, matched £45k, spread 1.82/1.84 → passerar liquidity_filter, midpoint P(A)=**0.5343**.
- **SBOBET:** A 1.80 / B 2.05 → no-vig P(A)=**0.5325**. (IBC saknar matchen.)
- **Scenario:** CONSENSUS. **N_eff** = Betfair (1, oberoende) + SBO (1) = **2.0** → precis godkänt.
- **fairProb(A)** viktat (Betfair 0.90×liqf 0.95=0.855; SBO 0.60) = (0.855·0.5343 + 0.60·0.5325)/1.455 = **0.5335**.
- **edge** = 1.95 × 0.5335 − 1 = **+4.0 %**.
- **confidence** = 0.45 + 0.25·~1.0 + 0.10·clamp((2.0−1)/2)=0.05 → 0.75 × liqFactor 0.95 = **0.71**.
- **requiredEdge** = 2.0 + (1−0.71)·4.5 + **1.0 (CONSENSUS-tillägg)** = **4.31 %**.
- **Beslut:** edge 4.0 % < 4.31 % → **NO_BET** ("below edge"). Det högre kravet utan Pinnacle äter exakt den marginal som hade blivit en bet med Pinnacle. (Vid 1.97 → edge 5.1 % ≥ 4.31 och conf 0.71 ≥ 0.65, N_eff≥2 → då AUTO_BET.) Visar designmålet: hellre missa än chansa på svag referens.

### Exempel C — Basket total, olika linor + asiatisk korrelation → MANUAL_REVIEW/NO_BET
- **Match:** Euroleague (T1), Pinnacle har bara ML, **saknar totalen**, prematch.
- **Soft book:** Betsson **Över 163.0 @ 2.08**.
- **Sharp-linor (no-vig P(Över)):** SBO Över **162.5** 1.90/1.96 → 0.5078; IBC Över **163.5** 1.95/1.91 → 0.4948; Singbet Över **162.5** 1.88 → ~0.512.
- **Line-matching:** poola sharp-punkterna {(162.5, 0.5078), (163.5, 0.4948)}, interpolera (log-odds) till **163.0 → P(Över)=0.5013** (fair odds 1.995).
- **N_eff:** alla tre i asian-gruppen, k=3 → 1+2·0.3 = **1.6** → **< 2**.
- **edge** = 2.08 × 0.5013 − 1 = **+4.3 %**.
- **confidence** = 0.45 + 0.25·~0.9 + 0.10·clamp((1.6−1)/2)=0.03 → **0.70**.
- **requiredEdge** = 2.0 + (1−0.70)·4.5 + 1.0 = **4.35 %**.
- **Beslut:** edge 4.3 % < 4.35 % → **NO_BET**. *Även om* edge hade räckt (säg soft 2.10 → 5.2 %): scenario ≠ anchor **och N_eff 1.6 < 2** → **MANUAL_REVIEW**, aldrig auto. Två oberoende spärrar (edge-bar + korrelations-N_eff) skyddar mot att tre korrelerade asiatiska böcker felaktigt ser ut som starkt consensus.

### Exempel D — Player prop → NEEDS_VALIDATION (aldrig valuebet i v1)
- **Marknad:** "Isak Över 0.5 skott på mål", Unibet @ 2.10 (boostad).
- Pinnacle saknar marknaden; bara Unibet + Bet365 har den, och **Bet365 listar "skott" (ej skott på mål)** → regel-tuplerna matchar inte exakt.
- **Beslut:** `exactRuleMatchAcrossBooks` = falskt → **NO_BET ("rule mismatch")**. Hade reglerna matchat men <3 soft books → fortf. NO_BET; boost → **NEEDS_VALIDATION**. Props når aldrig AUTO_BET utan modell + CLV-historik.

---

## Sammanfattning av de viktigaste skydden mot falska valuebets
1. **Confidence-gate** + dynamiskt edge-krav: svag referens ⇒ orealistiskt hög edge krävs ⇒ ingen bet.
2. **Korrelations-nedräkning**: SBO+IBC+Singbet ≈ 1.6 röster, inte 3 ⇒ inget falskt "asiatiskt consensus".
3. **Disagreement-kill**: sharp-källor som pekar olika ⇒ NO_BET oavsett edge.
4. **Pinnacle-saknas ⇒ hårdare krav** (N_eff≥2, +edge, confidence-tak).
5. **Player props isolerade**: aldrig auto, kräver exakt regelmatch + soft-consensus + modell/CLV; boost ⇒ NEEDS_VALIDATION.
6. **CLV är facit**: trust höjs bara av bevisad positiv CLV, sänks snabbt av negativ.
7. **Shadow mode först**: allt loggar innan något auto-bet:as.
