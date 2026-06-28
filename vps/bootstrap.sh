#!/usr/bin/env bash
#
# VPS bootstrap — sätter upp alla odds-scrapers som systemd-timers på en
# ren Ubuntu 22.04-server (Hetzner/DigitalOcean/Vultr).
#
# Förutsättningar:
#   - Ubuntu 22.04 LTS, root-access
#   - Ett GitHub PAT med "Contents: write" på Lilgunner24/linusgan
#
# Användning:
#   export GITHUB_PAT=github_pat_xxx
#   export GIT_USER_EMAIL="vps@dindomän.se"
#   curl -fsSL https://raw.githubusercontent.com/Lilgunner24/linusgan/main/vps/bootstrap.sh | bash
#
#   ELLER klona repot manuellt och kör: sudo -E bash vps/bootstrap.sh
#
set -euo pipefail

REPO_URL="https://github.com/Lilgunner24/linusgan.git"
INSTALL_DIR="/root/linusgan"
NODE_MAJOR=20

echo "=== VPS Bootstrap för matched-betting odds-scrapers ==="

if [[ -z "${GITHUB_PAT:-}" ]]; then
  echo "FEL: sätt GITHUB_PAT (GitHub token med Contents: write)."
  echo "  export GITHUB_PAT=github_pat_xxx"
  exit 1
fi
GIT_USER_EMAIL="${GIT_USER_EMAIL:-vps-scraper@localhost}"

echo "--- [1/7] Systempaket ---"
apt-get update -y
apt-get upgrade -y
# wireguard/wireguard-tools krävs för Mullvad-namespacet (mv) som VPN-källorna
# (VBET/Bet7/Betsson/ComeOn/Pinnacle) routas igenom. python3 krävs av
# mullvad-netns.sh:s relay-parser. Utan dessa kan tunneln ALDRIG startas och
# alla skyddade källor faller tillbaka på den Cloudflare-blockerade VPS-IP:n.
apt-get install -y curl git ca-certificates gnupg jq ufw wireguard wireguard-tools python3
command -v wg >/dev/null || { echo "FEL: 'wg' saknas efter install — Mullvad kan inte sättas upp"; exit 1; }

echo "--- [2/7] Node.js $NODE_MAJOR ---"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v), npm: $(npm -v)"

echo "--- [3/7] Klona/uppdatera repo ---"
# Full klon (inte --depth 1): scrapers pushar samtidigt som GitHub Actions
# skriver till main, så vi vill ha full historik för pålitliga rebase/push.
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch origin main
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# Konfigurera git push med PAT
git remote set-url origin "https://x-access-token:${GITHUB_PAT}@github.com/Lilgunner24/linusgan.git"
git config user.name "vps-scraper"
git config user.email "$GIT_USER_EMAIL"

echo "--- [4/7] Hemligheter (Mullvad VPN-config + bet365-token) ---"
# Mullvad WireGuard-config för VPN-källorna (VBET/Bet7/Betsson/ComeOn/Pinnacle).
# Skickas in som env MULLVAD_WG_CONF (exakt samma innehåll som GitHub-secret:en
# MULLVAD_WG_CONF). Utan den kan Mullvad-namespacet inte startas → de källorna
# får ingen färsk data (men skriver aldrig över gammal cache).
if [[ -n "${MULLVAD_WG_CONF:-}" ]]; then
  mkdir -p /etc/wireguard
  printf '%s\n' "$MULLVAD_WG_CONF" > /etc/wireguard/mullvad.conf
  chmod 600 /etc/wireguard/mullvad.conf
  echo "  skrev /etc/wireguard/mullvad.conf"
elif [[ -f /etc/wireguard/mullvad.conf ]]; then
  echo "  /etc/wireguard/mullvad.conf finns redan — behåller"
else
  echo "  VARNING: ingen MULLVAD_WG_CONF och ingen befintlig /etc/wireguard/mullvad.conf."
  echo "           VPN-källorna (VBET/Bet7/Betsson/ComeOn) får ingen färsk data förrän"
  echo "           du lägger din Mullvad .conf där och kör 'systemctl restart mullvad-netns'."
fi
# bet365 via BetsAPI (tredjeparts-API). VALFRI — utan token aktiveras inte
# bet365 alls (annars exitar scrapern 1 varje körning och health fastnar i 503).
if [[ -n "${BETSAPI_TOKEN:-}" ]]; then
  printf 'BETSAPI_TOKEN=%s\n' "$BETSAPI_TOKEN" > /etc/odds-scraper.env
  chmod 600 /etc/odds-scraper.env
  echo "  skrev /etc/odds-scraper.env (bet365 aktiveras)"
else
  echo "  ingen BETSAPI_TOKEN → bet365 hoppas över (valfri källa)"
fi

echo "--- [5/7] npm install (inkl. Playwright för Cloudflare-källor) ---"
npm install --include=dev
# Chromium behövs bara för Cloudflare-blockerade källor (betsson, comeon, vbet).
# Pinnacle använder fetch-pinnacle-direct.mjs (ingen Chromium) på ren VPS-IP.
npx playwright install --with-deps chromium || echo "VARNING: Playwright install misslyckades — Cloudflare-källor kanske inte funkar"

echo "--- [6/7] Installera systemd services + timers ---"
# Kopiera in service/timer-mallar och injicera INSTALL_DIR
for unit in "$INSTALL_DIR"/vps/systemd/*.service "$INSTALL_DIR"/vps/systemd/*.timer; do
  base="$(basename "$unit")"
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$unit" > "/etc/systemd/system/$base"
done
systemctl daemon-reload

# Starta Mullvad-namespacet FÖRST (VPN-källorna routas genom 'mv'). Bara om en
# config finns — annars hoppar vi och källorna faller tillbaka på direkt-IP
# (cache bevaras). mullvad-netns.service har ingen .timer så den måste enable:as
# explicit här (annars skapas namespacet aldrig vid boot).
if [[ -f /etc/wireguard/mullvad.conf ]]; then
  if systemctl enable --now mullvad-netns.service; then
    echo "  aktiverade mullvad-netns.service (Mullvad-tunnel uppe)"
  else
    echo "  VARNING: mullvad-netns.service startade inte (kolla 'journalctl -u mullvad-netns')"
  fi
else
  echo "  hoppar mullvad-netns.service (ingen /etc/wireguard/mullvad.conf)"
fi

# Verifiera att tunneln faktiskt ger en SVENSK exit. DETTA var den tysta
# felkällan sist: utan wireguard kom tunneln aldrig upp, VPN-källorna 403:ades
# på rå IP — utan något tydligt fel. Nu syns det direkt.
MV_OK=0
if [[ -f /etc/wireguard/mullvad.conf ]]; then
  sleep 3
  MV_COUNTRY=$(ip netns exec mv curl -s --max-time 12 https://am.i.mullvad.net/json 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("country",""))' 2>/dev/null || echo "")
  if [[ "$MV_COUNTRY" == "Sweden" ]]; then
    echo "  ✅ Mullvad-exit verifierad: svensk IP ($MV_COUNTRY)"
    MV_OK=1
  else
    echo "  ⚠️  Mullvad-exit gav '${MV_COUNTRY:-inget svar}' (väntade Sweden)."
    echo "      VPN-källorna (VBET/Bet7/Betsson/ComeOn) kan vara blockerade."
    echo "      Felsök: journalctl -u mullvad-netns ; ip netns exec mv wg show"
  fi
fi

# Aktivera alla timers (odds-scraper@*, mullvad-watchdog, self-heal).
for timer in "$INSTALL_DIR"/vps/systemd/*.timer; do
  name="$(basename "$timer")"
  # bet365 kräver BETSAPI_TOKEN — hoppa dess timer om token saknas, annars
  # exitar scrapern 1 varje körning och self-heal/health fastnar i en larm-loop.
  if [[ "$name" == "odds-scraper@bet365.timer" && -z "${BETSAPI_TOKEN:-}" ]]; then
    echo "  hoppar $name (ingen BETSAPI_TOKEN)"
    continue
  fi
  systemctl enable --now "$name"
  echo "  aktiverade $name"
done

echo "--- [7/7] Brandvägg + health-server ---"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 3001/tcp >/dev/null 2>&1 || true  # health endpoint
yes | ufw enable >/dev/null 2>&1 || true

# Starta health-server som egen service
cat > /etc/systemd/system/odds-health.service <<EOF
[Unit]
Description=Odds scraper health endpoint
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node vps/health-server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now odds-health.service

echo ""
echo "--- Snabbtest (GO/NO-GO) ---"
# Kör en snabb icke-VPN-källa (kambi) och en VPN-källa (pinnacle via netns) en
# gång var, så du ser DIREKT om pipeline + tunnel fungerar — i stället för att
# upptäcka det timmar senare. run-scraper.sh validerar JSON, committar och
# pushar, så detta testar hela kedjan inkl. GitHub-push.
smoke() { # $1=key $2=label
  echo "  testar $2 ..."
  if timeout 150 bash "$INSTALL_DIR/vps/run-scraper.sh" "$1" >"/tmp/smoke-$1.log" 2>&1; then
    echo "  ✅ $2 OK"
  else
    echo "  ⚠️  $2 FAIL — sista raderna:"; tail -4 "/tmp/smoke-$1.log" | sed 's/^/      /'
  fi
}
smoke kambi "Kambi (icke-VPN)"
if [[ "$MV_OK" == "1" ]]; then
  smoke pinnacle "Pinnacle (via Mullvad)"
else
  echo "  ⏭  hoppar Pinnacle-test (Mullvad ej verifierad ovan)"
fi

echo ""
echo "=== KLART ==="
[[ "$MV_OK" == "1" ]] && echo "  Mullvad: ✅ svensk exit" || echo "  Mullvad: ⚠️  EJ verifierad — VPN-källor kan vara nere (se varning ovan)"
[[ -f /etc/odds-scraper.env ]] && echo "  bet365:  ✅ aktiverad" || echo "  bet365:  ⏭  hoppad (ingen BETSAPI_TOKEN)"
echo ""
echo "Verifiera löpande:"
echo "  curl -s http://localhost:3001/health | jq                 # ålder per källa (vänta ~10 min)"
echo "  systemctl list-timers | grep odds                          # nästa körning per källa"
echo "  ip netns exec mv curl -s https://am.i.mullvad.net/json | jq .country   # ska visa \"Sweden\""
echo "  git -C $INSTALL_DIR log --oneline -8                       # commits scrapers pushat"
echo ""
echo "Scrapers pushar nu data till GitHub på schema. Render läser därifrån."
echo "Stäng av GitHub Actions cron FÖRST när du verifierat 24h stabilitet (docs/VPS-MIGRATION-PLAN.md)."
