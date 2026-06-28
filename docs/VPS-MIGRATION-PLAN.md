# VPS-migrationsplan — produktionsstabilitet inför lansering

## Varför behövs detta?

GitHub Actions cron är opålitlig (kör 7-10 ggr/dag istället för 288 ggr/dag).
Cron-job.org löser det MESTA men:
- Pinnacle-workflows kör Playwright + Chromium varje gång (10-30 sek setup)
- Kostnaderna i GitHub Actions-minuter går upp
- Du är fortfarande beroende av GitHub:s tillgänglighet
- Cloudflare kan börja blockera GitHub Actions IP-pool (det har hänt andra)

**En egen VPS = full kontroll, garanterad cadence, oberoende infrastruktur.**

---

## Rekommenderad setup

### Provider: Hetzner Cloud

**Varför Hetzner:**
- Billigast i Europa: **€4.51/mån** (~50 kr) för CX22-instans (2 vCPU, 4GB RAM)
- EU-baserad (svensk data + GDPR-vänligt)
- Egen IP som inte är blockerad av bookmakers
- Stabilt sedan 1997 — ingen "kommer-och-går"-tjänst

Alternativ: **DigitalOcean** ($6/mån, lättare UI), **Vultr** ($6/mån)

### Specs som behövs

- **2 vCPU minimum** (Chromium + Node behöver headroom)
- **4 GB RAM** (Playwright + JSON-parsing av Pinnacle ~35MB)
- **40 GB SSD** (logs, persistent cache, Chromium binary)
- **Ubuntu 22.04 LTS** (mest stöd för Playwright)

### Total kostnad

| Item | €/mån | kr/mån |
|------|------|--------|
| Hetzner CX22 | 4.51 | ~52 |
| Backup (rekommenderat) | 0.90 | ~10 |
| **Total** | **5.41** | **~62 kr** |

---

## Vad ska köra på VPS:n?

Bara **scrapers** — inte hela appen. Render fortsätter köra UI + API.

```
┌─────────────────────────────────────┐
│   Hetzner VPS                       │
│                                     │
│   - Node.js script per bookmaker    │
│   - Egen cron (systemd timers)      │
│   - Pushar till GitHub var X min    │
│   - ELLER pushar direkt till Render │
└─────────────────────────────────────┘
            │
            │ git push
            ▼
┌─────────────────────────────────────┐
│   GitHub repo (data/*.json)         │
└─────────────────────────────────────┘
            │
            │ raw.githubusercontent.com
            ▼
┌─────────────────────────────────────┐
│   Render (matched-betting.onrender) │
│   - Läser senaste data från GitHub  │
│   - Serverar UI + API               │
└─────────────────────────────────────┘
```

**Fördel:** Render behöver inte ändras — bara dataflödet bakom blir pålitligt.

---

## Migrationsplan — 4 faser

### Fas 1: Setup VPS (30 min)
1. Skapa Hetzner-konto + verifiera betalkort
2. Skapa CX22 instans, välj Ubuntu 22.04
3. Lägg upp SSH-nyckel (`ssh-keygen -t ed25519`)
4. Logga in via SSH
5. Kör basic hardening:
   ```bash
   ufw allow OpenSSH
   ufw enable
   apt update && apt upgrade -y
   apt install -y nodejs npm git
   ```

### Fas 2: Deploya en scraper (1h)
**Börja med Pinnacle** — det är mest kritiskt.

1. Klona repot på VPS:n: `git clone https://github.com/Lilgunner24/linusgan.git`
2. Installera deps: `cd linusgan && npm install`
3. Installera Playwright deps: `npx playwright install --with-deps chromium`
4. Skapa GitHub PAT med write-access till repot
5. Konfigurera git push:
   ```bash
   git remote set-url origin https://USERNAME:PAT@github.com/Lilgunner24/linusgan.git
   git config user.name "vps-scraper"
   git config user.email "vps@example.com"
   ```
6. Testa: `node scripts/fetch-pinnacle-github-action.mjs`
7. Verifiera att `data/pinnacle-rows.json` uppdateras

### Fas 3: Systemd timer (30 min)
Ersätter GitHub Actions cron.

Skapa `/etc/systemd/system/pinnacle-fetch.service`:
```ini
[Unit]
Description=Pinnacle odds fetcher
After=network.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/root/linusgan
ExecStart=/usr/bin/node scripts/fetch-pinnacle-github-action.mjs
ExecStartPost=/bin/bash -c 'cd /root/linusgan && git add data/pinnacle-rows.json && git commit -m "chore(pinnacle): refresh" || true && git push'
TimeoutSec=300
```

Skapa `/etc/systemd/system/pinnacle-fetch.timer`:
```ini
[Unit]
Description=Run Pinnacle fetch every 90s
Requires=pinnacle-fetch.service

[Timer]
OnBootSec=30s
OnUnitActiveSec=90s
AccuracySec=1s

[Install]
WantedBy=timers.target
```

Aktivera:
```bash
systemctl daemon-reload
systemctl enable --now pinnacle-fetch.timer
```

Verifiera: `systemctl status pinnacle-fetch.timer` ska säga "Active: active (waiting)".

### Fas 4: Migrera övriga scrapers (2-3h)

Upprepa Fas 3 för varje:
- `kambi-fetch.yml` → systemd timer (5 min)
- `betsson-fetch.yml` → systemd timer (5 min)
- `comeon-fetch.yml` → systemd timer (5 min)
- `paf-brand-fetch.yml` → systemd timer (10 min)
- `altenar-fetch.yml` → systemd timer (10 min)
- `vbet-fetch.yml` → systemd timer (10 min, behåll MULLVAD VPN)

För bookmakers bakom Cloudflare som kräver VPN: installera WireGuard på VPS:n med Mullvad-config.

### Fas 5: Stäng av GitHub Actions cron (15 min)

När VPS-timers kör stabilt i 24h:

1. Kommentera ut `schedule:` block i alla `.github/workflows/*-fetch.yml`
2. Behåll `workflow_dispatch:` så du kan triggas manuellt om VPS:n går ner
3. Commit + push

---

## Monitoring & alerts

### Health check endpoint på VPS:n

Lägg till en enkel Express-server som svarar med senaste-fetch-timestamp per scraper:

```js
// /root/linusgan/vps-health-server.mjs
import express from "express";
import fs from "node:fs/promises";
const app = express();
app.get("/health", async (req, res) => {
  const stats = {};
  for (const src of ["pinnacle", "kambi", "betsson", "comeon"]) {
    try {
      const path = `/root/linusgan/data/${src}-rows.json`;
      const stat = await fs.stat(path);
      stats[src] = {
        lastModified: stat.mtime.toISOString(),
        ageSeconds: Math.round((Date.now() - stat.mtimeMs) / 1000),
      };
    } catch { stats[src] = { error: "missing" }; }
  }
  res.json(stats);
});
app.listen(3001);
```

### Externa pingar (free)

- **UptimeRobot.com** (gratis) → pingar `http://VPS_IP:3001/health` var 5:e min
- Skickar mejl när någon scraper är >10 min gammal

---

## Risker & redundans

| Risk | Mitigation |
|------|-----------|
| VPS:n går ner | Behåll GitHub Actions som backup (workflow_dispatch) |
| Disk fylls | Logrotate + `journalctl --vacuum-time=7d` |
| Hetzner billing-problem | Sätt upp auto-betalning + reserve credit |
| Scraper-bug pushar trasig data | Validera JSON innan git commit (jq) |
| GitHub PAT går ut | Använd machine-user istället, eller GitHub App |

---

## Beräknad timeline

- **Vecka 1:** Setup VPS + migrera Pinnacle. Verifiera stabilitet 48h.
- **Vecka 2:** Migrera Kambi + Betsson + ComeOn.
- **Vecka 3:** Migrera resten + sätt upp monitoring.
- **Vecka 4:** Stäng av GitHub Actions cron. Skarp produktion.

**Total dev-tid:** ~6-8 timmar fördelat över 3 veckor.

---

## När ska du göra detta?

**Innan du börjar betala-kunder.** Det är okej att köra på cron-job.org under MVP-fas, men för riktig SaaS-produkt behövs en VPS.

Indikatorer att det är dags:
- Du har 5+ betalande kunder
- Du börjar få supportärenden om "data är gammal"
- Du behöver 99.9% uptime garanterad
