# VPS-runbook — kör Oddexus UTAN GitHub (Supabase-only)

Mål: köra scrapers + persist + settle på en egen VPS som skriver **direkt till
Supabase `odds_cache`** (ingen `git push`, ingen GitHub Actions). Render-appen
läser odds **Supabase-först** (`fetchOddsDbPayload`, vite.config.ts) → den
serverar färska odds utan att GitHub är inblandat och **utan ny deploy**.

> Skiljer sig från `docs/VPS-MIGRATION-PLAN.md` / `vps/bootstrap.sh` som pushar
> till GitHub. **Kör INTE `vps/bootstrap.sh`** här — den är GitHub-baserad. Följ
> stegen nedan i stället (de använder `ODDS_NO_GIT=1`).

## Du behöver
- En **Ubuntu 22.04-VPS** (Hetzner CX22, 2 vCPU/4 GB, ~62 kr/mån) + din SSH-nyckel.
- Dina **Supabase**-värden: `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (service_role).
- Din **Mullvad WireGuard .conf** (för VPN-källor: Pinnacle/Betfair/VBET/Betsson/ComeOn).
- Render-appens bas-URL (t.ex. `https://oddexus.com`).
- Backup-bundlen: `~/Documents/oddexus-backup/oddexus-allrefs.bundle` (koden — GitHub-clone går ej).

## Steg 0 — kontrollera Render (engång)
Render-dashboard → tjänsten → **Environment**: se att **`SUPABASE_URL`** och
**`SUPABASE_SERVICE_KEY`** finns (de behövs redan för persist). Finns de → appen
läser odds från Supabase automatiskt. Ingen redeploy behövs.

## Steg 1 — provisionera + logga in
Skapa VPS (Ubuntu 22.04), lägg upp SSH-nyckel, `ssh root@VPS_IP`. Sedan:
```bash
apt update && apt upgrade -y
apt install -y git jq wireguard wireguard-tools python3 ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
ufw allow OpenSSH && ufw allow 3001/tcp && ufw --force enable
```

## Steg 2 — koden via bundlen (ingen GitHub)
**På din Mac:**
```bash
scp ~/Documents/oddexus-backup/oddexus-allrefs.bundle root@VPS_IP:/root/
```
**På VPS:n:**
```bash
git clone /root/oddexus-allrefs.bundle /root/linusgan
cd /root/linusgan && git checkout main
npm install
npx playwright install --with-deps chromium    # för Cloudflare-källor (betsson/comeon/vbet)
```

## Steg 3 — secrets/env
```bash
cat > /etc/odds-scraper.env <<'EOF'
ODDS_NO_GIT=1
SUPABASE_URL=https://DIN.supabase.co
SUPABASE_SERVICE_KEY=DIN_SERVICE_ROLE_KEY
VALUEBETS_URL=https://oddexus.com
# valfri: BETSAPI_TOKEN=...
EOF
chmod 600 /etc/odds-scraper.env

# Mullvad-config (klistra in HELA .conf-innehållet):
printf '%s\n' "PASTE_MULLVAD_CONF_HERE" > /etc/wireguard/mullvad.conf
chmod 600 /etc/wireguard/mullvad.conf
```

## Steg 4 — scraper-timers (mirror→Supabase, ingen git)
`run-scraper.sh` hoppar git automatiskt tack vare `ODDS_NO_GIT=1` och speglar
till Supabase. Installera mallarna (samma som `vps/systemd`, INSTALL_DIR injiceras):
```bash
cd /root/linusgan
for f in vps/systemd/odds-scraper@.service vps/systemd/mullvad-netns.service \
         vps/systemd/mullvad-watchdog.service vps/systemd/mullvad-watchdog.timer \
         vps/systemd/odds-scraper@*.timer; do
  sed "s#__INSTALL_DIR__#/root/linusgan#g" "$f" > "/etc/systemd/system/$(basename "$f")"
done
systemctl daemon-reload
systemctl enable --now mullvad-netns.service        # VPN-namespace (mv)
ip netns exec mv curl -s https://am.i.mullvad.net/json | jq .country   # ska visa "Sweden"
for t in pinnacle kambi betsson comeon paf-brand altenar vbet coolbet; do
  systemctl enable --now "odds-scraper@$t.timer"
done
systemctl enable --now mullvad-watchdog.timer
```
> **Hoppa över `self-heal.service`** — den pushar en git-heartbeat (GitHub) och behövs inte här.

## Steg 5 — persist + settle som egna timers (ersätter GitHub Actions)
```bash
# persist-signals var 5:e min
cat > /etc/systemd/system/oddexus-persist.service <<'EOF'
[Unit]
Description=Oddexus persist-signals -> Supabase
After=network.target
[Service]
Type=oneshot
WorkingDirectory=/root/linusgan
EnvironmentFile=/etc/odds-scraper.env
ExecStart=/usr/bin/npx vite-node scripts/persist-signals.mjs
TimeoutSec=240
EOF
cat > /etc/systemd/system/oddexus-persist.timer <<'EOF'
[Unit]
Description=Run persist-signals every 5 min
[Timer]
OnBootSec=120s
OnUnitActiveSec=300s
[Install]
WantedBy=timers.target
EOF

# closing-capture + CLV-settle var 5:e min
cat > /etc/systemd/system/oddexus-clv.service <<'EOF'
[Unit]
Description=Oddexus closing capture + CLV settle -> Supabase
After=network.target
[Service]
Type=oneshot
WorkingDirectory=/root/linusgan
EnvironmentFile=/etc/odds-scraper.env
ExecStart=/bin/bash -lc 'npx vite-node scripts/capture-pinnacle-closing.ts 15 2 || true; npx vite-node scripts/settle-tracking-clv.mjs'
TimeoutSec=300
EOF
cat > /etc/systemd/system/oddexus-clv.timer <<'EOF'
[Unit]
Description=Run closing capture + CLV settle every 5 min
[Timer]
OnBootSec=180s
OnUnitActiveSec=300s
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now oddexus-persist.timer oddexus-clv.timer
```
> Pinnacle-closing-capture kräver Mullvad (kör ev. `capture` inom `mv`-namespace om 403 — lägg `ip netns exec mv` före kommandot).

## Steg 6 — verifiera
```bash
systemctl list-timers | grep -E 'odds-scraper|oddexus'   # nästa körning per timer
journalctl -u 'odds-scraper@pinnacle.service' -n 20      # senaste Pinnacle-körning
journalctl -u oddexus-persist.service -n 20
curl -s http://localhost:3001/health | jq                # (om health-server startad)
```
**I Supabase** (fylls inom minuter):
```sql
select source_id, updated_at, now() - updated_at as age
from odds_cache order by updated_at desc;          -- scrapers skriver hit
select count(*) from decision_snapshots where taken_at > now() - interval '10 minutes';  -- persist
select status, count(*) from valuebet_signals group by 1;  -- settle/lifecycle
```
**På Render:** `/api/valuebets` ska visa färska valuebets (läser odds_cache).

## Felsökning
- **Inget i odds_cache** → kolla att `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` i `/etc/odds-scraper.env` stämmer; `journalctl -u odds-scraper@pinnacle.service`.
- **Pinnacle/Betfair 403** → måste köra i `mv`-namespacet (Mullvad). Verifiera "Sweden" enligt steg 4.
- **persist/settle-fel** → `journalctl -u oddexus-persist.service` / `oddexus-clv.service`; kontrollera `VALUEBETS_URL`.
- **vite-node saknas** → `npm install` måste ha kört med devDeps (kör om i `/root/linusgan`).

## Återställ GitHub senare (valfritt)
När kontot är tillbaka: pusha den lokala koden + `ODDS_NO_GIT`-toggeln + denna
runbook. Du kan då välja att behålla VPS→Supabase (robustast) ELLER återgå till
GitHub Actions. VPS:en kan köras parallellt som hot-standby.
