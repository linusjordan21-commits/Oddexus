#!/usr/bin/env bash
#
# VPS-heartbeat — skriver en VPS-exklusiv fil (data/vps-heartbeat.json) och
# pushar den till GitHub. GitHub Actions rör ALDRIG denna fil, så varje
# uppdatering av den på main bevisar att VPS:ens git-push fungerar (auth +
# nätverk) — oberoende av odds-data-racet mot GHA (där GHA nästan alltid
# committar samma data först och VPS:en ser "ingen förändring").
#
# Det är så vi verifierar hot-standbyn utan att stänga av GHA: syns
# "chore(vps): heartbeat ..."-commits på main → VPS:en lever och kan pusha.
# Syns de inte → VPS:en är död/felkonfigurerad.
#
# Anropas rate-limitat av self-heal.sh (default var 20:e minut).
#
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/root/linusgan}"
cd "$INSTALL_DIR" || exit 1
FILE="data/vps-heartbeat.json"

NOW="$(date -u +%FT%TZ)"
HOST="$(hostname 2>/dev/null || echo unknown)"
# Mullvad-land via namespacet (om det finns) — bevisar att VPN-exiten är svensk.
MV_COUNTRY="$(ip netns exec mv curl -s --max-time 8 https://am.i.mullvad.net/json 2>/dev/null | jq -r '.country // "n/a"' 2>/dev/null || echo n/a)"
# Lokal health-snapshot (ålder per källa) — bra diagnostik direkt i commit-datan.
HEALTH="$(curl -s --max-time 5 http://localhost:3001/health 2>/dev/null || echo '{}')"

# Bygg heartbeat-payload (atomiskt via temp + mv). jq om möjligt, annars printf.
TMP_HB="$(mktemp 2>/dev/null || echo /tmp/vps-hb-build.json)"
if ! jq -n --arg now "$NOW" --arg host "$HOST" --arg mv "$MV_COUNTRY" \
      --argjson health "${HEALTH:-{}}" \
      '{updatedAt:$now, source:"vps-heartbeat", host:$host, mullvadCountry:$mv, health:$health}' \
      > "$TMP_HB" 2>/dev/null; then
  printf '{"updatedAt":"%s","source":"vps-heartbeat","host":"%s","mullvadCountry":"%s"}\n' \
    "$NOW" "$HOST" "$MV_COUNTRY" > "$TMP_HB"
fi

# Git-sektion: SAMMA flock som run-scraper.sh så vi inte race:ar dess git-index.
exec 9>/run/odds-git.lock
if ! flock -w 60 9; then
  echo "[heartbeat] git-lås upptaget inom 60s — skippar (self-heal försöker igen)"
  exit 0
fi
# Rensa ev. stale .lock från en tidigare dödad git-process (flock garanterar att
# ingen annan rör git just nu → kvarvarande lås är per definition stale).
find .git -name '*.lock' -delete 2>/dev/null || true

# git reset --hard nedan skriver över arbetsträdet → spara undan vår heartbeat.
TMP="/tmp/vps-heartbeat-fresh.json"
cp -f "$TMP_HB" "$TMP"
rm -f "$TMP_HB"

# Robust publicering (samma mönster som run-scraper.sh): börja från ren
# origin/main, lägg tillbaka filen, committa, fast-forward-pusha. Vid push-miss
# (GHA rörde remote) → loopa om från senaste remote.
for attempt in 1 2 3 4 5; do
  git fetch origin main >/dev/null 2>&1 || true
  git checkout -f main >/dev/null 2>&1 || true
  git reset --hard origin/main >/dev/null 2>&1
  mkdir -p data
  cp -f "$TMP" "$FILE"
  git add "$FILE"
  git commit -m "chore(vps): heartbeat $NOW" >/dev/null 2>&1 || {
    echo "[heartbeat] inget att committa"; exit 0;
  }
  if git push origin main >/dev/null 2>&1; then
    echo "[heartbeat] pushade (försök $attempt) — VPS-push bevisad OK"
    exit 0
  fi
  echo "[heartbeat] push misslyckades (försök $attempt) — synkar om och försöker igen"
  sleep "$attempt"
done
echo "[heartbeat] push misslyckades efter 5 försök"
exit 1
