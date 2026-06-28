#!/usr/bin/env bash
#
# Sätter upp network namespace "mv" där trafiken routas via Mullvad WireGuard.
# Resten av VPS:en (SSH, git push, övriga scrapers) använder Hetsners vanliga IP.
#
# SKOTTSÄKER: provar flera Mullvad-servrar i tur och ordning (nuvarande server
# först, sedan färska svenska servrar från Mullvads API) och använder den
# FÖRSTA som både får WireGuard-handshake OCH verklig uppkoppling (curl mot
# 1.1.1.1). Single-server-underhåll → auto-failover. Den fungerande servern
# skrivs tillbaka till configen.
#
# Idempotent. Användning: bash vps/mullvad-netns.sh
#
set -uo pipefail

NS=mv
WG_IF=mullvad
CONF="${MULLVAD_CONF:-/etc/wireguard/mullvad.conf}"

if [[ ! -f "$CONF" ]]; then
  echo "FEL: hittar inte $CONF"; exit 1
fi

PRIVKEY=$(awk -F'=[ ]*' '/^PrivateKey/{print substr($0, index($0,"=")+1)}' "$CONF" | tr -d ' ')
ADDR4=$(awk -F'=[ ]*' '/^Address/{print $2}' "$CONF" | tr -d ' ' | cut -d, -f1)
ADDR6=$(awk -F'=[ ]*' '/^Address/{print $2}' "$CONF" | tr -d ' ' | cut -d, -f2)
DNS=$(awk -F'=[ ]*' '/^DNS/{print $2}' "$CONF" | tr -d ' ' | cut -d, -f1)
CUR_PUB=$(awk -F'=[ ]*' '/^PublicKey/{print substr($0, index($0,"=")+1)}' "$CONF" | tr -d ' ')
CUR_EP=$(awk -F'=[ ]*' '/^Endpoint/{print $2}' "$CONF" | tr -d ' ')

if [[ -z "$PRIVKEY" || -z "$ADDR4" ]]; then
  echo "FEL: kunde inte läsa PrivateKey/Address ur $CONF"; exit 1
fi

# Bygg kandidatlista: nuvarande server först, sedan svenska servrar från API:t.
CANDS=()
[[ -n "$CUR_EP" && -n "$CUR_PUB" ]] && CANDS+=("$CUR_EP|$CUR_PUB")
RELAYS=$(curl -s --max-time 12 "https://api.mullvad.net/www/relays/wireguard/" 2>/dev/null || true)
if [[ -n "$RELAYS" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && CANDS+=("$line")
  done < <(printf '%s' "$RELAYS" | python3 -c '
import sys,json
try:
    d=json.load(sys.stdin)
    se=[r for r in d if r.get("country_code")=="se" and r.get("active") and r.get("ipv4_addr_in") and r.get("pubkey")]
    for r in se[:10]:
        print(f"{r[\"ipv4_addr_in\"]}:51820|{r[\"pubkey\"]}")
except Exception:
    pass
' 2>/dev/null)
fi

if [[ ${#CANDS[@]} -eq 0 ]]; then
  echo "FEL: inga kandidat-servrar (config saknar Endpoint/PublicKey och API svarade inte)"; exit 1
fi

setup_peer() { # $1=endpoint $2=pubkey
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$WG_IF" 2>/dev/null || true
  ip netns add "$NS"
  ip link add "$WG_IF" type wireguard
  ip link set "$WG_IF" netns "$NS"
  ip netns exec "$NS" wg set "$WG_IF" \
    private-key <(printf '%s' "$PRIVKEY") \
    peer "$2" endpoint "$1" allowed-ips 0.0.0.0/0,::/0 persistent-keepalive 25
  ip netns exec "$NS" ip addr add "$ADDR4" dev "$WG_IF"
  [[ -n "$ADDR6" ]] && ip netns exec "$NS" ip -6 addr add "$ADDR6" dev "$WG_IF" 2>/dev/null || true
  ip netns exec "$NS" ip link set lo up
  ip netns exec "$NS" ip link set "$WG_IF" up
  ip netns exec "$NS" ip route add default dev "$WG_IF"
  ip netns exec "$NS" ip -6 route add default dev "$WG_IF" 2>/dev/null || true
  mkdir -p /etc/netns/"$NS"
  { echo "nameserver ${DNS:-10.64.0.1}"; echo "nameserver 1.1.1.1"; } > /etc/netns/"$NS"/resolv.conf
}

tunnel_works() { # handshake != 0 OCH raw-IP nås (ingen DNS krävs)
  sleep 4
  local hs
  hs=$(ip netns exec "$NS" wg show "$WG_IF" latest-handshakes 2>/dev/null | awk '{print $2; exit}')
  [[ -n "$hs" && "$hs" != "0" ]] || return 1
  ip netns exec "$NS" curl -s --max-time 6 https://1.1.1.1 -o /dev/null 2>/dev/null
}

tried=0
for c in "${CANDS[@]}"; do
  ep="${c%%|*}"; pub="${c##*|}"
  [[ -z "$ep" || -z "$pub" ]] && continue
  tried=$((tried+1))
  setup_peer "$ep" "$pub"
  if tunnel_works; then
    echo "Mullvad-namespace '$NS' uppe via $ep (handshake + uppkoppling OK)"
    # Persistera fungerande server till configen
    if [[ "$ep" != "$CUR_EP" || "$pub" != "$CUR_PUB" ]]; then
      sed -i -E "s|^Endpoint = .*|Endpoint = $ep|" "$CONF" 2>/dev/null || true
      sed -i -E "s|^PublicKey = .*|PublicKey = $pub|" "$CONF" 2>/dev/null || true
      echo "  (bytte till fungerande server, sparade i config)"
    fi
    exit 0
  fi
  echo "  server $ep: ingen uppkoppling — provar nästa"
done

echo "VARNING: ingen av $tried Mullvad-servrar gav uppkoppling."
echo "  Trolig orsak: kontotid slut eller nyckeln blockerad (inte serverfel)."
exit 1
