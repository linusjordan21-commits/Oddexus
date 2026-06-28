# Källpålitlighet — arkitektur & roadmap

Målet: odds-källorna ska kunna följas **så ofta som möjligt** och **aldrig dö i
tysthet**. Det här dokumentet beskriver nuläget, vad som är gjort, och planen
framåt.

## Nuläge (arkitektur)

```
  GitHub Actions (cron)  ──scrape──►  data/*-rows.json  ──commit──►  main
                                                                       │
                                                            Render-backend läser
                                                          (raw.githubusercontent
                                                           / GitHub contents API)
                                                                       │
                                                                  Frontend
```

- 11 fetch-workflows scrapar var sin källa på cron-schema (`*/5`–`*/20`).
- Varje workflow committar sin datafil till `main`; backend läser därifrån.
- `scripts/audit-source-freshness.mjs` är *single source of truth* för varje
  källas `staleAfterSec` + effektiva intervall.

### Två klasser av källor

| Klass | Källor | Begränsning |
|-------|--------|-------------|
| **Oblockerade** | Pinnacle, Kambi, Altenar, SportyBet, Paf-brand, Bet9ja | Nås från vilken IP som helst |
| **Geo-/WAF-blockerade** | ComeOn, Betsson, VBET, Bet7 | Kräver Azure-IP (GHA) och/eller Mullvad-VPN |

Denna uppdelning styr hela roadmappen: de oblockerade källorna kan pollas var
som helst (även från backenden), de blockerade är låsta till GitHub Actions.

## ✅ Gjort

1. **Korsvis avbrytning fixad** — `paths-ignore: "data/**"` i alla fetch-workflows.
   Tidigare triggade en källas data-commit *alla andra* workflows, som med
   `cancel-in-progress` avbröt varandra. Var grundorsaken till att ComeOn/VBET
   fastnade.
2. **VBET conf.json-probe icke-fatal** — en transient timeout dödade inte
   längre hela jobbet före scraping.
3. **Självläkande watchdog** (`watchdog.yml` + `scripts/watchdog.mjs`) — kör
   var 5:e minut, auto-omstartar stale källor, för `data/source-health.json`,
   och öppnar GitHub-issue om en källa är stale länge. **Ingen källa kan längre
   dö i tysthet.**

## 🛣️ Roadmap

### Tier 2 — Högre frekvens för oblockerade källor

GitHub Actions schedule-cron är opålitligt (kan släpa 10–30 min under last) och
har 5-min minimum. Pinnacle kringgår redan detta med extern **cron-job.org** som
pingar `workflow_dispatch` var ~60s.

**Plan:** lägg samma externa cron-trigger på de lätta oblockerade källorna
(Kambi ~1s scrape, Altenar ~2s, SportyBet ~50s). Dessa tål 1–5 min cadens utan
att bygga kö.

- [ ] Registrera cron-job.org-jobb (eller GHA `*/5` + extern ping) per källa.
- [ ] Bekräfta att `concurrency.cancel-in-progress` är `false` för dessa så köade
      pings inte avbryter pågående scrape (jfr Pinnacle-kommentaren).
- [ ] Uppdatera `effectiveIntervalSec` i audit-registret så watchdog/maxAge
      räknar med den faktiska takten.

> ⚠️ Kräver manuellt steg: cron-job.org-jobben sätts upp i deras UI med en
> `workflow_dispatch`-PAT. Workflow-sidan är redan klar (alla har
> `workflow_dispatch`).

### Tier 3 — Hybrid: persistent poller i backenden

Den största frekvensvinsten. De oblockerade källorna behöver varken Azure-IP
eller VPN — så Render-backenden (som ändå kör dygnet runt) kan polla dem direkt
var 30–60s och skriva till sin egen cache. Det tar bort beroendet av GHA-schemat
helt för dessa.

```
  Render-backend (setInterval 30–60s)
      ├─ poll Pinnacle / Kambi / Altenar / SportyBet / Paf / Bet9ja  ► in-memory + disk cache
      └─ läser GHA-committad data för ComeOn / Betsson / VBET / Bet7 (geo-blockerade)
  GitHub Actions
      └─ scrapar BARA de geo-blockerade + fungerar som backup för resten
```

- [ ] Lyft ut scrape-logiken ur `scripts/fetch-*-github-action.mjs` till delade
      moduler som både GHA och backenden kan importera.
- [ ] Lägg en `pollerLoop` i backenden med per-källa intervall + jitter.
- [ ] Behåll GHA som backup (cron kvar) så en backend-omstart inte ger glapp.
- [ ] Watchdogen övervakar båda vägarna via samma `source-health.json`.

**Avvägning:** mer kod i backenden + den måste tåla scrape-last, men ger
sub-minut-färskhet och eliminerar GHA-schemats opålitlighet för 6 av 11 källor.

### Tier 4 — Publik status-sida

`src/components/SourcesStatus.tsx` finns redan. Mata den från
`data/source-health.json` (som watchdogen producerar) så uptime syns publikt.

- [ ] Backend-endpoint `/api/source-health` som serverar `source-health.json`.
- [ ] `SourcesStatus.tsx`: visa per källa status-badge, ålder, senaste
      lyckade hämtning, antal omstarter senaste dygnet.
- [ ] Grön/gul/röd indikator + “senast kontrollerad”-tidsstämpel.

## Designprinciper

1. **Single source of truth** — alla trösklar bor i audit-registret; watchdog,
   maxAge och status-sida läser därifrån. Ändra på ETT ställe.
2. **Self-healing före alerting** — försök omstarta automatiskt först, larma
   bara när det inte hjälper.
3. **Tyst i steady state** — committa/larma bara vid faktiska tillstånds­ändringar,
   inte var 5:e minut.
4. **Data-commits triggar aldrig robotar** — `paths-ignore: "data/**"` håller
   data-flödet isolerat från kod-/workflow-triggers.
