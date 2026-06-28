#!/usr/bin/env bash
#
# Kör en scraper, committa dess data-fil, pusha till GitHub med retry.
# Anropas av systemd-timers (odds-scraper@<key>.service).
#
# Användning: run-scraper.sh <key>
#   key ∈ pinnacle|kambi|betsson|comeon|paf-brand|altenar|vbet|sportybet|bet7|bet9ja
#
set -uo pipefail

KEY="${1:-}"
INSTALL_DIR="${INSTALL_DIR:-/root/linusgan}"
cd "$INSTALL_DIR" || exit 1

# Mappa key → (script, datafil). Pinnacle använder direct-HTTP (ingen Chromium).
case "$KEY" in
  pinnacle)     SCRIPT="scripts/fetch-pinnacle-direct.mjs";        FILE="data/pinnacle-rows.json" ;;
  kambi)        SCRIPT="scripts/fetch-kambi-github-action.mjs";    FILE="data/kambi-rows.json" ;;
  betsson)      SCRIPT="scripts/fetch-betsson-github-action.mjs";  FILE="data/betsson-rows.json" ;;
  comeon)       SCRIPT="scripts/fetch-comeon-github-action.mjs";   FILE="data/comeon-rows.json" ;;
  paf-brand)    SCRIPT="scripts/fetch-paf-brand-github-action.mjs"; FILE="data/paf-brand-rows.json" ;;
  altenar)      SCRIPT="scripts/fetch-altenar-github-action.mjs";  FILE="data/altenar-rows.json" ;;
  vbet)         SCRIPT="scripts/fetch-vbet-github-action.mjs";     FILE="data/vbet-rows.json" ;;
  sportybet)    SCRIPT="scripts/fetch-sportybet-ng-github-action.mjs"; FILE="data/sportybet-ng-rows.json" ;;
  bet7)         SCRIPT="scripts/fetch-bet7-github-action.mjs";     FILE="data/bet7-rows.json" ;;
  bet9ja)       SCRIPT="scripts/fetch-bet9ja-github-action.mjs";   FILE="data/bet9ja-rows.json" ;;
  bet365)       SCRIPT="scripts/fetch-bet365-api.mjs";             FILE="data/bet365-rows.json" ;;
  coolbet)      SCRIPT="scripts/fetch-coolbet-github-action.mjs"; FILE="data/coolbet-rows.json" ;;
  *) echo "Okänd scraper-key: $KEY"; exit 1 ;;
esac

echo "[$KEY] $(date -u +%H:%M:%S) startar $SCRIPT"

# Dessa källor 403:as på Hetzners datacenter-IP (Cloudflare/bot-block) men
# funkar via Mullvads rena exit-IP. Kör dem inuti network-namespacet "mv"
# (sätts upp av mullvad-netns.service). Allt annat — git pull/push och övriga
# scrapers — sker på vanliga IP:n. Fallback: saknas namespacet körs direkt.
RUN_PREFIX=""
case "$KEY" in
  pinnacle|vbet|bet7|comeon|betsson|coolbet)
    if ip netns list 2>/dev/null | grep -q '^mv\b'; then
      RUN_PREFIX="ip netns exec mv"
      echo "[$KEY] kör via Mullvad-namespace (mv)"
    fi
    ;;
esac

# Kör scrapern (UTAN git-lås — scrapers ska köra parallellt; det är det långsamma)
if ! $RUN_PREFIX node "$SCRIPT"; then
  echo "[$KEY] scraper exit != 0 — hoppar över commit"
  exit 1
fi

# Validera JSON innan commit (skydda mot trasig data)
if ! jq empty "$FILE" >/dev/null 2>&1; then
  echo "[$KEY] $FILE är inte giltig JSON — hoppar över commit"
  exit 1
fi

# Stämpla "senast bekräftad på GitHub" per källa. Health-endpointen mäter DENNA
# istället för lokal filålder → övervakningen speglar GitHub-verkligheten, inte
# bara att scrapern kört lokalt. Om pushar tystnar slutar stämpeln uppdateras →
# health blir degraded → UptimeRobot larmar. /run rensas vid reboot (tmpfs).
mark_pushed() { mkdir -p /run/odds-push 2>/dev/null; : > "/run/odds-push/$(basename "$FILE")" 2>/dev/null || true; }

# ===== GitHub-FRITT läge (ODDS_NO_GIT=1) =====
# Scrapern har redan speglat datan till Supabase odds_cache via
# scrape-guard.atomicWriteString → mirrorOddsFile (kräver SUPABASE_URL +
# SUPABASE_SERVICE_KEY i env). Render läser odds Supabase-FÖRST, så ingen
# git-commit/push behövs i drift-loopen. Används när GitHub-kontot inte är
# tillgängligt eller pipelinen körs helt mot Supabase.
if [ -n "${ODDS_NO_GIT:-}" ] && [ "${ODDS_NO_GIT}" != "0" ]; then
  mark_pushed
  echo "[$KEY] ODDS_NO_GIT — speglat till Supabase, hoppar git"
  exit 0
fi

# ===== Git-sektion: SERIALISERAD med flock =====
# Alla 11 scrapers delar samma arbetsträd och git-index. Utan lås race:ar deras
# git add/commit/push varandra och commits tappas — särskilt för långsamma vbet
# (under dess 6 min hinner pinnacle m.fl. committa dussintals gånger och svepa
# med/nollställa vbets staged ändring → "inget att committa", ingen push).
# Låset gör att bara EN scraper rör git åt gången. Scrapningen ovan var olåst.
exec 9>/run/odds-git.lock
if ! flock -w 120 9; then
  echo "[$KEY] kunde inte få git-låset inom 120s — hoppar över (timern försöker igen)"
  exit 1
fi

# Rensa stale git-lås från en TIDIGARE dödad git-process (t.ex. en scraper som
# killades av systemd TimeoutSec mitt i en commit). flock garanterar att ingen
# annan scraper rör git just nu, så alla kvarvarande .lock-filer under .git är
# per definition stale → ofarligt att ta bort. Utan detta blockerar ett kvarglömt
# .git/index.lock alla efterföljande commits ("Another git process seems to be
# running") tills någon raderar det manuellt.
find .git -name '*.lock' -delete 2>/dev/null || true

# Spara undan vår färska scrape — git-operationerna nedan skriver över $FILE.
TMP="/tmp/odds-${KEY}-fresh.json"
cp -f "$FILE" "$TMP"

# Robust publicering. INGEN rebase, INGEN autostash — den gamla logiken kunde
# lämna repot i detached HEAD/halv-rebase och då slutade ALLA pushar fungera.
# Istället, varje försök: börja från en garanterat ren main = senaste
# origin/main, lägg tillbaka vår enda fil, committa, pusha (fast-forward).
# Kan omöjligt detacha eller fastna. Vid push-miss (remote rörde sig pga
# GitHub Actions) → loopa om från senaste remote och behåll vår scrape.
for attempt in 1 2 3 4 5 6 7 8; do
  git fetch origin main >/dev/null 2>&1 || true
  git checkout -f main >/dev/null 2>&1 || true   # reattach om vi råkat hamna detached
  git reset --hard origin/main >/dev/null 2>&1   # ren utgångspunkt = senaste remote
  cp -f "$TMP" "$FILE"                            # lägg tillbaka vår färska scrape

  if git diff --quiet -- "$FILE"; then
    # Vår scrape == origin/main → GitHub har redan aktuell data.
    mark_pushed
    echo "[$KEY] ingen förändring i $FILE"
    exit 0
  fi
  git add "$FILE"
  git commit -m "chore($KEY): refresh odds data" >/dev/null 2>&1 || { mark_pushed; echo "[$KEY] inget att committa"; exit 0; }

  if git push origin main >/dev/null 2>&1; then
    mark_pushed
    echo "[$KEY] pushade (försök $attempt)"
    exit 0
  fi
  echo "[$KEY] push misslyckades (försök $attempt) — synkar om och försöker igen"
  sleep "$attempt"
done
echo "[$KEY] push misslyckades efter 8 försök"
exit 1
