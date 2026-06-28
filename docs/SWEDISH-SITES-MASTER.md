# 🇸🇪 MASTER — Svenska spelsajter för matched betting & valuebets

> ## 📌 VAR VI STANNADE (2026-06-21) — så plockar du upp tråden
> **Klart & pushat** (branch `claude/great-franklin-R2IGD`, ej mergat till main för att inte störa odds-pipelinen):
> - ✅ Casino-EV **live-verifierad** per sajt, filtrerat till **≤37,5×** → se `CASINO-BONUS-EV.md` + avsnitt nedan.
> - ✅ Sportbok-lista grupperad per plattform → se `SPORT-VALUE-AND-BONUS.md` + avsnittet "VALUE/SPORTBÖCKER" nedan.
>
> **Nästa steg (välj ett):**
> 1. **Exakt EV i kr** för rena ≤37,5×-kandidater (888 10×, unibet/goldenbull/1x2/x3000 30×, coolbet 35×) — kräver att exkluderingslistan (Book of 99/BBW-bidrag) bekräftas inloggad per sajt.
> 2. **Vig-mätning** mot Pinnacle/Smarkets på ComeOn-böckerna (mjukast → mest value), sen Kambi/Playtech.
>
> *För att se dessa docs i en NY container: `git checkout claude/great-franklin-R2IGD`.*

> **Senast verifierad: 2026-06-21** (casino-EV live-verifierad per sajt). Sammanställning av all research (5 delrapporter). ✅ = plattform vi REDAN skrapar (lätt integration). **Altenar borttaget** ur bonuslistorna (dåliga villkor/tunna marknader; kvar som odds-källor i koden). Ej primärverifierat = **"m.k."** — aldrig gissat.
>
> **Två syften:** **Bonus Finder/Optimizer** = välkomstbonusarna (casino + sport). **Valuebettern** = sportböcker med value-potential. **Break-even casino** (1/(1−RTP)): Big Bad Wolf 97,34% = 37,6× · 98% = 50× · 99% = 100×.

---

## 🏆 PRIORITETSLISTA (väg in: bonus-EV · sportbok · value · integration · risk)

### TIER 1 — kör först (vi skrapar plattformen + bra bonus/value)
| Sajt | Plattform ✅ | Sport-bonus | Casino-bonus (effektiv oms) | Value |
|---|---|---|---|---|
| **hajper.com** | ComeOn | **500 kr NO-WAGER** | 300%/600 kr (~26,7× ✅ MEN Book of 99 0%) | Medel-hög |
| **betsafe.com** | Playtech | **100 kr NO-WAGER** | 200 FS (35× FS-vinst) | Hög |
| **lyllocasino.com** | ComeOn | **100 kr NO-WAGER** (7 dgr) | 300%/600 kr (~26,7× ✅ MEN Book of 99 0%) | Medel-hög |
| **unibet.se** | Kambi | 500 kr **1x** | 1000 kr (**30×** bonus ✅) / 50 FS 1× | Hög |
| **comeon.com** | ComeOn | 500 kr 6x | 300%/750 kr (~26,7× ✅ MEN Book of 99 0%) | Medel-hög |
| **nordicbet.com** | Playtech | 100 kr+50 FS 6x | 500 kr+100 FS (**35×** bonus ✅ provisorisk basis) | Hög |
| **betsson.com** | Playtech | 250 kr **1x** | 1000 kr+50 FS (**60×** ❌ ins+bonus) | Hög — ⚠️ 6,5 MSEK AML |
| **888 / goldenbull / 1x2** | Egen/Kambi/PAF | 500–1000 kr 6–8x | **888 10×** ⭐ / goldenbull·1x2 30× bonus ✅ | Medel |

### TIER 2 — högt värde, eget scraper-jobb
| Sajt | Plattform | Sport-bonus | Casino-bonus (EV) | Value |
|---|---|---|---|---|
| **coolbet.com** | Egen (GAN) | 1000 kr 6x | 1500 kr (**35×** bonus ✅) + 50 FS | **Mycket hög** (skarp) |
| **leovegas.com** | Kambi | 600 kr 6x | 4000 kr (15× ins ✅ MEN **Book of 99 0%** ❌) | Hög |
| **betmgm.se** | Egen Tiger | 1000 kr freebet 10x | 4000 kr+200 FS (20× ins ✅ MEN Book of 99 0%, BBW antas 100%) | Hög |
| **mrgreen.se** | Kambi | **500 kr NO-WAGER** | 1000 kr (**35×** bonus ✅ MEN Book of 99 0%) | Hög — Medel risk (1 MSEK) |
| **expekt.se** | Kambi | 1000 kr+64 kr 15x | 2000 kr+100 FS (20× ins ✅ MEN **Book of 99 0%** ❌) | Hög |
| **bet365.com** | Egen | 1500 kr krediter | 100 FS | **Mycket hög** (djupast) — svår |
| **10bet.se** | Playtech | 1000 kr 15x | 1000 kr (**50×** ❌) | Hög |
| **interwetten.se** | Egen | 1000 kr 5x +150 kr | 5000 kr (**stegvis frisläpp** ❌ INGEN value) | Medel |
| **prontoodds/sport** | Delasport | **200 kr 1x** | — | Medel |
| **vbet.se** | Egen | 800 kr 10x | 1000 kr (**40×** ❌) | Medel |

### TIER 3 — bra CASINO-bonus (svag/ingen sport)
**888.se** (1000 kr, **10×** bonus ⭐ — bäst) · **gogocasino** (3000 kr, 20× ins, bonus = cash utan oms — "i steg"-ryktet motbevisat ✅) · **casinoepic** (200 FS, 35× FS-vinst) · **goldenbull/1x2** (30× bonus ✅) · **reviant** (~26,6×, BBW ej exkl. MEN ⚠️ KYC-fälla) · **casinostugan** (40× ❌) · **veraandjohn** (60× ❌). ⚠️ **megafortune = ~100× stegvis = INGEN value** (bekräftat). **Effektiv oms live-verifierad 2026-06-21 — enda kvarvarande "m.k." = exakt RTP-exkluderingslista per sajt.**

### TIER 4 — låg prio
casumo (40× ❌), yoyocasino (70× ❌), spelklubben casino (40× ❌ — men sport 1x bra), bethard (40× ❌, men high-RTP ej exkl.), pokerstars (14 dgr), supersnabbt, fastbet/turbovegas (bonusfri), cherry (sportbonus ej lanserad), atg/svenskaspel (statliga, tight). *speedybet (30× om bonus-only / 60× om ins+bonus — verifiera).*

### TIER 5 — UNDVIK
**lottoexperten · superlottoclub · impactwin** (ImpactWin/More Tech — 400k sanktion, abonnemangsfällor, Trustpilot 1,2/5).

---

## 💰 CASINOBONUS-EV — ≤37,5× (LIVE-VERIFIERAD 2026-06-21)
> Effektiv oms live-verifierad per sajt (basis × match × stegvis × spelbidrag). Detaljer + verbatim-citat: `CASINO-BONUS-EV.md`. **Tre fällor:** basis (ins+bonus dubblar på 100%-match) · stegvis frisläpp (bara megafortune+interwetten) · **RTP-exkludering (Book of 99 = 0% på leovegas/expekt/betmgm/mrgreen/comeon/hajper/lyllo)**.

### ✅ BEHÅLL — effektiv oms ≤ 37,5×
| Sajt | Effektiv ×bonus | Basis | Flagga |
|---|---|---|---|
| **888.se** | **10×** ⭐ | bonus | bäst multiplikator, non-sticky; exkl-lista m.k. |
| **leovegas** | 15× | ins | ❌ Book of 99 0% → kan ej omsätta på bästa sloten |
| **expekt / betmgm / gogocasino** | 20× | ins | expekt/betmgm: Book of 99 0%. gogocasino: cash utan oms (ej stegvis) ✅ |
| **snabbare / reviant / comeon / hajper / lyllo** | **~26,7×** | ins+bonus (300%) | **reviant = BBW ej exkl. (matematiskt bäst) MEN KYC-fälla-rykte**; övriga Book of 99 0% |
| **unibet / goldenbull / 1x2 / x3000** | 30× | bonus | rena basis; exkl-lista m.k.; x3000 = 50/50-modell (egen cash i risk) |
| **speedybet** | 30× / **60×** ⚠️ | motstridig | basis måste verifieras inloggad |
| **coolbet / mrgreen / nordicbet** | 35× | bonus | mrgreen: Book of 99 0%; nordicbet: basis vs Betsson oklar (kan vara 70×) |

*FS-erbjudanden (ej match):* betsafe & casinoepic = 200 FS, 35× på FS-vinst.

### ❌ SKIPPA — effektiv oms > 37,5×
**megafortune ~100× (stegvis)** · **interwetten** (10 steg) · yoyocasino 70× · **betsson 60×** · veraandjohn 60× · 10bet 50× · casinostugan/bethard/spelklubben/casumo/vbet **40×**.

---

## 🏟️ SPORT-BONUSAR (rankade för matched betting)
- **🟢 No-wager freebet (bäst):** mrgreen 500 kr · hajper 500 kr · betsafe 100 kr · lyllo 100 kr · paf (m.k.)
- **🟡 1x:** unibet 500 kr · betsson 250 kr · prontoodds 200 kr · bethard 1250 kr (**25-årsgräns**)
- **🟠 6x:** coolbet 1000 kr (+skarp odds) · leovegas 600 · comeon 500 · nordicbet 100 · x3000 1000 · goldenbull 500 · 1x2 500 (+64 kr wager-free) · interwetten 1000 (5x)
- **🔵 7–12x:** tipwin 7x · 888sport 8x · snabbare 8x · betmgm 10x · vbet 10x · speedybet 12x
- **🔴 15x+ (svagt):** expekt 15x · 10bet 15x · spelklubben 30x

Alla min odds ~1.80 (bethard 1.50, interwetten 1.70).

---

## 🎯 VALUE / SPORTBÖCKER (för valuebettern)
| Value | Sajter | Plattform |
|---|---|---|
| Referens | pinnacle, smarkets/betsbk | Vi kör ✅ |
| Mycket hög | coolbet, bet365 | Egen (eget jobb) |
| Hög | unibet, expekt, leovegas, mrgreen, 888sport, betmgm | **Kambi ✅** |
| Hög | betsson, bethard, spelklubben, nordicbet, betsafe, 10bet | **Playtech ✅** |
| Medel-hög | comeon, hajper, snabbare, casinostugan, lyllo, reviant | **ComeOn ✅** |
| Medel | vbet, x3000, goldenbull, 1x2, speedybet, prontoodds, interwetten, tipwin, veraandjohn, megafortune | div |

*Ingen sportbok: casinoepic, yoyocasino, pokerstars(SE), snurr, supersnabbt, lotterierna. Ninja = Altenar (exkl.).*

---

## ⚠️ RISK & UTTAG
- **CampoBet** (Altenar, borttagen ur bonus): licensierad, INGEN sanktion, men **KYC-loopar + försenade uttag** (en svensk verifierade i ~1 år) → **CAUTION**, gör full KYC innan insats.
- **AML-sanktioner:** betsson **6,5 MSEK**, comeon/snabbare **5,5 MSEK**, casumo 1,2 MSEK, videoslots 12 MSEK, pokerstars/TSG AML-böter.
- **KYC-fällor:** **reviant** (värsta — oändliga dokumentkrav), betinia (Altenar), interwetten, 10bet.
- **UNDVIK:** lottoexperten/superlottoclub/impactwin (400k sanktion, abonnemangsfällor).
- **Lagligt-men-irriterande** (normalt under SE-licens): KYC, AML-fördröjning, bonusoms, maxbet, max-vinst-tak. **Äkta flaggor** (anmäl): nekade verifierade uttag, "flyttade målstolpar"-KYC, styrning till sajt utanför licens.

---

## 🔧 REKOMMENDERAD INTEGRATIONS-ORDNING
1. **Plattformar vi redan skrapar** (snabbast): **Kambi** (unibet, expekt, leovegas, mrgreen, 888sport, x3000, goldenbull, 1x2, veraandjohn) · **Playtech** (betsson, bethard, spelklubben, nordicbet, betsafe, 10bet) · **ComeOn** (comeon, hajper, snabbare, lyllo, casinostugan, reviant) · **Smarkets** (betsbk).
2. **Egen scraper, högt värde:** coolbet (6x + skarp), bet365 (djupast, men anti-bot), betmgm, interwetten, tipwin, vbet, prontoodds (Delasport).
3. **Casino-only kandidater (EV OBEKRÄFTAT — verifiera frisläpp):** gogocasino (⚠️ "i steg"), casinoepic, 888. *(megafortune utgår — 100× stegvis.)*

## Status odds-flottan (2026-06-20)
Self-healing håller: **7/8 grön** ostört i timmar (per-källa-reaper + watchdog→keepalive + smarkets-täckning fungerar). **Smarkets** = kvarstående källside-block → behöver VPN-fix (egen session). Toleranspanelen korrekt (kambi 60s, altenar 30s, paf ~9 min).

---

## 📁 Delrapporter i repot
`SURVEY.md` (kartläggning) · `BONUS-ANALYSIS.md` (Tier 1–5) · `ALL-BONUSES.md` (casino/sport/båda + sportbok) · `CASINO-BONUS-EV.md` (EV-matte) · `SPORT-VALUE-AND-BONUS.md` (sport-fokus) · **`MASTER.md`** (denna).

*Allt "m.k." = verifiera på sajtens inloggade villkorssida + Spelinspektionens register innan beslut. Inget villkor gissat.*
