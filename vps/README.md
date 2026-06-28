# VPS odds-scraper setup

Kör alla odds-scrapers på en egen VPS med pålitligt schema istället för
GitHub Actions cron (som bara kör ~7-10 ggr/dygn på publika repos).

## Snabbstart (Hetzner CX22, ~62 kr/mån)

1. Skapa VPS: Ubuntu 22.04, 2 vCPU, 4GB RAM. Lägg upp din SSH-nyckel.
2. SSH in som root.
3. Skapa GitHub PAT med **Contents: write** på `Lilgunner24/linusgan`:
   https://github.com/settings/personal-access-tokens/new
4. Kör (sätt secrets som env-vars — bootstrap skriver dem säkert till disk):
   ```bash
   export GITHUB_PAT=github_pat_xxx          # KRÄVS (Contents: write)
   export GIT_USER_EMAIL="vps@dindomän.se"   # valfri
   # Mullvad WireGuard-config (HELA .conf-filens innehåll) — KRÄVS för
   # VPN-källorna VBET/Bet7/Betsson/ComeOn. Samma värde som GitHub-secret:en.
   export MULLVAD_WG_CONF="$(cat din-mullvad.conf)"
   # bet365 via BetsAPI — VALFRI. Utan token hoppas bet365 helt över.
   export BETSAPI_TOKEN=xxxxx
   curl -fsSL https://raw.githubusercontent.com/Lilgunner24/linusgan/main/vps/bootstrap.sh | bash
   ```
   > Kör du via `curl | bash` måste env-varsen vara `export`ade i samma shell.
   > Alternativt: klona repot och kör `sudo -E bash vps/bootstrap.sh` (`-E`
   > behåller env-varsen).

Det är allt. Bootstrap-scriptet:
- Installerar Node 20 + Playwright Chromium + **WireGuard** (krävs för Mullvad)
- Klonar repot, konfigurerar git push med din PAT
- Skriver `/etc/wireguard/mullvad.conf` (från `MULLVAD_WG_CONF`) och
  `/etc/odds-scraper.env` (från `BETSAPI_TOKEN`), båda `chmod 600`
- Startar **Mullvad-namespacet (mv)** + systemd-timers (en per källa)
- Startar health-endpoint på port 3001

## Vad körs?

| Källa | Cadence | Script | Chromium? |
|-------|---------|--------|-----------|
| Pinnacle | 90s | fetch-pinnacle-direct.mjs | Nej (direkt HTTP på ren IP) |
| Kambi/Unibet | 5min | fetch-kambi-github-action.mjs | Nej |
| Betsson-grupp | 5min | fetch-betsson-github-action.mjs | Ja (Cloudflare) |
| ComeOn-grupp | 5min | fetch-comeon-github-action.mjs | Ja |
| Paf-brand | 10min | fetch-paf-brand-github-action.mjs | Nej |
| Altenar-grupp | 10min | fetch-altenar-github-action.mjs | Nej |
| VBET | 10min | fetch-vbet-github-action.mjs | Nej (swarm-WS) + Mullvad VPN |
| SportyBet | 15min | fetch-sportybet-ng-github-action.mjs | Nej |
| Bet7 | 15min | fetch-bet7-github-action.mjs | Mullvad VPN |
| Bet9ja | 15min | fetch-bet9ja-github-action.mjs | Mullvad VPN |

## Verifiera

```bash
systemctl list-timers | grep odds     # se nästa körning per timer
journalctl -u 'odds-scraper@pinnacle.service' -n 20   # se senaste Pinnacle-körning
curl http://localhost:3001/health | jq # ålder per källa
git log --oneline -10                  # se commits scrapers pushat
```

## VPN-källor (VBET, Bet7, Betsson, ComeOn + Pinnacle)

Dessa 403:as på Hetzners datacenter-IP men funkar via Mullvads rena svenska
exit-IP. Bootstrap sköter allt automatiskt om du satte `MULLVAD_WG_CONF`:

- `wireguard`/`wireguard-tools` installeras av bootstrap.
- Configen skrivs till `/etc/wireguard/mullvad.conf`.
- `mullvad-netns.service` skapar ett **network namespace `mv`** som routar BARA
  dessa scrapers genom Mullvad — resten av VPS:en (SSH, git push, övriga
  scrapers) använder Hetzners vanliga IP.

> ⚠️ Kör **INTE** `wg-quick up mullvad` manuellt — det skapar ett interface med
> samma namn som namespacet använder och krockar (Mullvad tillåter dessutom bara
> en peer åt gången). Låt `mullvad-netns.service` äga tunneln.

Lägga till/byta config i efterhand:
```bash
printf '%s\n' "$MULLVAD_WG_CONF" > /etc/wireguard/mullvad.conf && chmod 600 /etc/wireguard/mullvad.conf
systemctl restart mullvad-netns.service
ip netns exec mv curl -s https://am.i.mullvad.net/json | jq .country   # ska visa "Sweden"
```

## Verifiera att VPS:en faktiskt kan pusha (hot-standby-bevis)

GHA committar nästan alltid samma odds-data först, så VPS:en ser "ingen
förändring" och pushar sällan riktig odds-data — frånvaron av `vps-scraper`-
commits bevisar därför INTE att den är trasig. För ett oberoende bevis pushar
self-heal var ~20:e min en **VPS-exklusiv heartbeat** (`data/vps-heartbeat.json`)
som GHA aldrig rör:

```bash
git log --author=vps-scraper --oneline -5     # syns heartbeat-commits? → VPS lever & kan pusha
git log --oneline -20 | grep "vps): heartbeat"
cat data/vps-heartbeat.json | jq              # tidsstämpel, host, mullvadCountry, health
```

Syns inga heartbeat-commits inom ~25 min efter att detta deployats → VPS:en kör
inte eller kan inte pusha (kolla `journalctl -u self-heal.service -n 50` och att
PAT:en har Contents: write). Justera kadens med `VPS_HEARTBEAT_INTERVAL_SEC`.

## Stäng av GitHub Actions (när VPS verifierats 24h)

I `.github/workflows/*-fetch.yml`: kommentera ut `schedule:`-blocket men
behåll `workflow_dispatch:` som manuell backup. Commit + push.

## Monitoring

Sätt upp UptimeRobot (gratis) → pinga `http://VPS_IP:3001/health` var 5:e min.
Health-endpoint returnerar HTTP 503 om någon källa är stale → larm via mejl.

## Felsökning

**Pinnacle direct-fetch ger 403** → VPS-IP är Cloudflare-blockerad. Byt till
fetch-pinnacle-github-action.mjs (Chromium) i `vps/run-scraper.sh`, eller byt
VPS-region.

**Push rejected** → run-scraper.sh har redan retry med rebase. Om det ändå
failar, kolla att PAT har Contents: write.
