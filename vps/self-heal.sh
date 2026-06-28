#!/usr/bin/env bash
#
# Universal self-healer — gör hela odds-pipelinen självläkande.
# Körs var 2:e minut av self-heal.timer.
#
# Logik:
#   1. Fråga health-endpointen vilka källor som är stale (samma trösklar som
#      övervakningen använder — en enda sanningskälla).
#   2. För varje stale källa: kör om dess scraper. Är det en Mullvad-källa
#      säkerställs tunneln först (annars meningslöst).
#   3. Svarar inte health-endpointen alls → starta om den.
#
# Skippar källor som redan kör (ingen överlappning). Beroende av mig, din dator
# eller internet till tredje part: noll. VPS:en lagar sig själv.
#
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/root/linusgan}"
HEALTH_URL="http://localhost:3001/health"

# ── Självuppdatering (kod, inte data) ──────────────────────────────────────
# self-heal kör var 2:e min via egen timer — oberoende av scrapers. Tidigare
# uppdaterades arbetsträdet BARA av run-scraper.sh:s git reset, vilket bara
# händer när en scraper LYCKAS. Failade alla scrapers frös VPS:en på gammal kod
# för alltid (t.ex. plockade aldrig upp den här heartbeaten). Nu hämtar self-heal
# själv senaste vps/ + scripts/ från main varje körning. VIKTIGT: vi rör INTE
# data/ (checkout av bara dessa två dirs) så pågående scrape-skrivningar inte
# nollställs, och vi tar git-låset så vi inte race:ar run-scraper.
(
  exec 8>/run/odds-git.lock 2>/dev/null
  if flock -w 15 8 2>/dev/null; then
    cd "$INSTALL_DIR" 2>/dev/null && {
      git fetch origin main >/dev/null 2>&1 || true
      git checkout origin/main -- vps scripts >/dev/null 2>&1 || true
    }
  fi
)

# ── VPS-heartbeat (bevisar att git-push fungerar) ──────────────────────────
# Var ~20:e min pushar vi en VPS-exklusiv heartbeat-fil. GHA rör den aldrig, så
# syns "chore(vps): heartbeat"-commits på main lever VPS:en och kan pusha — det
# är hur vi verifierar hot-standbyn utan att stänga av GHA. Rate-limitas via en
# /run-stämpel (rensas vid reboot). Körs först, oberoende av health-status.
HB_MARK="/run/odds-vps-heartbeat.ts"
HB_INTERVAL="${VPS_HEARTBEAT_INTERVAL_SEC:-1200}"
now_s=$(date +%s)
last_hb=0; [[ -f "$HB_MARK" ]] && last_hb=$(cat "$HB_MARK" 2>/dev/null || echo 0)
if (( now_s - last_hb >= HB_INTERVAL )); then
  echo "$now_s" > "$HB_MARK" 2>/dev/null || true
  INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/vps/heartbeat.sh" || true
fi

# datafil → scraper-key
declare -A KEY_OF=(
  [pinnacle-rows.json]=pinnacle
  [kambi-rows.json]=kambi
  [betsson-rows.json]=betsson
  [comeon-rows.json]=comeon
  [paf-brand-rows.json]=paf-brand
  [altenar-rows.json]=altenar
  [vbet-rows.json]=vbet
  # [PAUSAD 2026-05-31] sportybet / bet7 / bet9ja — Nigeria-bokisar, pausade
  # [BORTTAGEN] football-com — ej en bookmaker, borttagen på användarfråga
  [bet365-rows.json]=bet365
)

is_mullvad() { case "$1" in pinnacle|vbet|bet7|comeon|betsson) return 0;; *) return 1;; esac; }

ensure_tunnel() {
  if ! ip netns list 2>/dev/null | grep -q '^mv\b'; then
    echo "[self-heal] Mullvad-tunnel saknas — återskapar"
    bash "$INSTALL_DIR/vps/mullvad-netns.sh" >/dev/null 2>&1
    return
  fi
  local hs now
  hs=$(ip netns exec mv wg show mullvad latest-handshakes 2>/dev/null | awk '{print $2; exit}')
  now=$(date +%s)
  if [[ -z "$hs" || "$hs" == "0" ]] || (( now - hs > 180 )); then
    echo "[self-heal] Mullvad-tunnel stale (handshake) — återskapar"
    bash "$INSTALL_DIR/vps/mullvad-netns.sh" >/dev/null 2>&1
  fi
}

health=$(curl -s --max-time 8 "$HEALTH_URL" 2>/dev/null)
if [[ -z "$health" ]]; then
  echo "[self-heal] health-endpoint svarar inte — startar om odds-health.service"
  systemctl restart odds-health.service 2>/dev/null || true
  exit 0
fi

stale_files=$(printf '%s' "$health" | jq -r '.sources | to_entries[] | select(.value.stale==true) | .key' 2>/dev/null)
if [[ -z "$stale_files" ]]; then
  exit 0   # allt friskt — tyst
fi

tunnel_checked=0
for f in $stale_files; do
  key="${KEY_OF[$f]:-}"
  [[ -z "$key" ]] && { echo "[self-heal] okänd datafil: $f"; continue; }
  svc="odds-scraper@${key}.service"

  # Kör den redan? Då väntar vi (ingen överlappning).
  if systemctl is-active --quiet "$svc"; then
    echo "[self-heal] $key redan igång — väntar"
    continue
  fi

  # Mullvad-källa? Säkerställ tunneln (en gång per körning).
  if is_mullvad "$key" && (( tunnel_checked == 0 )); then
    ensure_tunnel
    tunnel_checked=1
  fi

  echo "[self-heal] $key STALE ($f) — kör om scrapern"
  systemctl start --no-block "$svc"
done
