#!/usr/bin/env bash
# Oddexus autoclicker — setup för Mac/Linux.
# Skapar en virtuell Python-miljö, installerar Playwright och bot-Chrome.
set -e

cd "$(dirname "$0")"
echo "=== Oddexus autoclicker setup ==="

# Hitta en lämplig Python (helst 3.11+, annars 3.9+)
PY=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    VER="$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo 0.0)"
    MAJ="${VER%%.*}"; MIN="${VER##*.}"
    if [ "$MAJ" -ge 3 ] && [ "$MIN" -ge 9 ]; then PY="$cand"; break; fi
  fi
done

if [ -z "$PY" ]; then
  echo ""
  echo "✗ Hittade ingen Python 3.9+ (helst 3.11)."
  echo "  Installera Homebrew och Python 3.11 först:"
  echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo "    brew install python@3.11"
  echo "  Kör sedan: bash setup.sh"
  exit 1
fi

echo "Använder $($PY --version)"

# Virtuell miljö
if [ ! -d ".venv" ]; then
  echo "Skapar virtuell miljö (.venv)…"
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "Installerar Playwright…"
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

echo "Laddar ner bot-Chrome (Chromium)…"
python -m playwright install chromium

echo ""
echo "✓ Klart! Starta botten med:"
echo "    bash run.sh"
echo "  (eller: source .venv/bin/activate && python playwright_bot.py)"
