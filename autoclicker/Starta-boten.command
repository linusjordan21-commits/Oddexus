#!/usr/bin/env bash
# Dubbelklicka denna fil för att starta Oddexus-boten.
# Första gången installeras allt som behövs (tar några minuter).
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  echo "Första gången: installerar allt som behövs (tar några minuter)…"
  bash setup.sh || { echo ""; echo "✗ Installationen misslyckades. Tryck Enter för att stänga."; read -r; exit 1; }
fi
bash run.sh
echo ""
echo "── Boten är klar/avslutad. Tryck Enter för att stänga fönstret. ──"
read -r
