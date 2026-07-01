#!/usr/bin/env bash
# Dubbelklicka för att kalibrera om SPIN + SALDO på ALLA sidor.
# Logga in + öppna spelet på alla casinon FÖRST — annars blir kalibreringen fel.
cd "$(dirname "$0")"
bash run.sh --recalibrate
echo ""
echo "── Klart. Tryck Enter för att stänga fönstret. ──"
read -r
