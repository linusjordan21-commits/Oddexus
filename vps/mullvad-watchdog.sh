#!/usr/bin/env bash
#
# Mullvad-watchdog — gör Mullvad-källorna (pinnacle/vbet/bet7/comeon/betsson)
# självläkande. Körs var 60:e sekund av mullvad-watchdog.timer.
#
# Kollar att network-namespacet "mv" finns OCH att WireGuard-handshaken är
# färsk. Om tunneln är nere eller handshaken är för gammal → återskapa
# namespacet via mullvad-netns.sh. Då kan en död tunnel som mest orsaka ~60s
# staleness istället för timmar.
#
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/root/linusgan}"
NS=mv
WG_IF=mullvad
MAX_HS_AGE=180   # sekunder. Med keepalive=25 ska handshaken vara <~120s.

recreate() {
  echo "[mullvad-watchdog] $(date -u +%H:%M:%S) tunnel nere/stale ($1) — återskapar"
  if bash "$INSTALL_DIR/vps/mullvad-netns.sh" >/dev/null 2>&1; then
    echo "[mullvad-watchdog] namespace återskapat OK"
  else
    echo "[mullvad-watchdog] VARNING: återskapning misslyckades"
  fi
}

# 1. Finns namespacet?
if ! ip netns list 2>/dev/null | grep -q "^${NS}\b"; then
  recreate "namespace saknas"
  exit 0
fi

# 2. Verklig uppkoppling genom tunneln? Raw-IP (1.1.1.1, ingen DNS) fångar
# BÅDE död tunnel OCH "handshake-ok-men-trasig-routing/DNS" — mycket bättre än
# att bara kolla handshake-ålder. Vid fel: återskapa (mullvad-netns.sh provar
# då flera servrar och väljer en som faktiskt har uppkoppling).
if ip netns exec "$NS" curl -s --max-time 8 https://1.1.1.1 -o /dev/null 2>/dev/null; then
  exit 0   # allt ok — tyst
fi
recreate "ingen uppkoppling (raw-IP onåbar)"
exit 0
