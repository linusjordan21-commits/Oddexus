# Privata nedladdningar

Bot-zip för kunder (skyddad nedladdning via `/autoclicker/download`).

## Standard (lokal)

```text
private_downloads/autoclicker-share.zip
```

Kopiera från din Mac:

```bash
cp ~/Downloads/autoclicker-share.zip private_downloads/autoclicker-share.zip
```

## Render (production)

Sätt env:

```text
AUTOCLICKER_DOWNLOAD_DIR=/opt/render/project/src/.matched-betting-cache/autoclicker-data/downloads
```

Lägg filen där som `autoclicker-share.zip` (via Render Shell efter deploy).

Kontrollera:

```bash
curl -s https://DIN-APP.onrender.com/api/autoclicker/health
```

`zip_exists` ska vara `true`.

Zip committas **inte** till git.
