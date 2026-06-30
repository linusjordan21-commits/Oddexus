#!/usr/bin/env bash
# Startar Oddexus-boten (kund-version). Kör 'bash setup.sh' först (en gång).
set -e
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  echo "Kör 'bash setup.sh' först (en gång)."
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python loader.py "$@"
