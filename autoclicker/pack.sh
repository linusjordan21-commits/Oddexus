#!/usr/bin/env bash
# Bygger autoclicker-share.zip för distribution till kunder.
# Lägger zippen i ../private_downloads/ (samma plats som servern läser från lokalt).
set -e
cd "$(dirname "$0")"

OUT="autoclicker-share.zip"
rm -f "$OUT"

zip -r "$OUT" \
  playwright_bot.py \
  license_client.py \
  sites.json \
  requirements.txt \
  setup.sh \
  run.sh \
  setup-windows.bat \
  run-windows.bat \
  README.txt \
  -x '*/__pycache__/*' '*.pyc'

DEST="../private_downloads/autoclicker-share.zip"
mkdir -p ../private_downloads
cp "$OUT" "$DEST"

echo "✓ Byggde $OUT"
echo "✓ Kopierade till $DEST"
echo ""
echo "Ladda upp den i /admin/autoclicker-licenses (Autoclicker zip) för att gå live,"
echo "eller använd 'npm run copy:autoclicker-zip' om den ligger i ~/Downloads."
