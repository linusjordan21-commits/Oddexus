#!/usr/bin/env bash
# Startar Oddexus autoclicker. Kör 'bash setup.sh' först (en gång).
set -e
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  echo "Kör 'bash setup.sh' först."
  exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python playwright_bot.py "$@"
