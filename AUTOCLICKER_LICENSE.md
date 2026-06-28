# Autoclicker-licenser — production (Render)

## Zip — enklaste metoden (admin-upload)

1. Gå till **`/admin/autoclicker-licenses`** (inloggad admin)
2. Under **Autoclicker zip** → välj `autoclicker-share.zip` → **Ladda upp ny zip**
3. Kontrollera health:
   ```bash
   curl -s http://127.0.0.1:8080/api/autoclicker/health | python3 -m json.tool
   ```
   (Render: byt till `https://DIN-APP.onrender.com/api/autoclicker/health`)
4. `zip_exists` ska vara **`true`**

API: `POST /api/admin/autoclicker-licenses/upload-zip` (multipart, fält `file`, max 50 MB, endast `.zip`).

---

## Zip — alternativ (CLI)

**Lokalt:**
```bash
npm run copy:autoclicker-zip
```
Kopierar `~/Downloads/autoclicker-share.zip` → `private_downloads/autoclicker-share.zip`

**Render (utan admin-upload):** Shell/SCP — se avsnitt C nedan.

Zippen lagras som:
```text
$AUTOCLICKER_DOWNLOAD_DIR/autoclicker-share.zip
```
Standard på Render:
```text
/opt/render/project/src/.matched-betting-cache/autoclicker-data/downloads/autoclicker-share.zip
```

---

## Flöde live

1. Kund loggar in → `/autoclicker`
2. Ser nyckel + laddar ner zip → `/autoclicker/download`
3. Kör botten lokalt
4. Botten → `POST /api/bot-license`

## Botten (`license_client.py`)

```python
LICENSE_SERVER_URL = "https://DIN-APP.onrender.com/api/bot-license"
```

---

## Health (kontrollera att allt lever)

**Lokal:**
```bash
curl -s http://127.0.0.1:8080/api/autoclicker/health | python3 -m json.tool
```

**Render:**
```bash
curl -s https://DIN-APP.onrender.com/api/autoclicker/health | python3 -m json.tool
```

Förväntat när OK:
```json
{
  "ok": true,
  "license_file_exists": true,
  "license_count": 1,
  "zip_exists": true,
  "expected_license_path": "...",
  "expected_zip_path": "..."
}
```

---

## Licens-API (botten)

**Lokal:**
```bash
node scripts/seed-autoclicker-license.mjs --reset-device

curl -s -X POST http://127.0.0.1:8080/api/bot-license \
  -H "Content-Type: application/json" \
  -d '{"license_key":"TEST-OK-123","device_id":"DEVICE-1","bot_version":"1.0.0"}'
```

**Render:**
```bash
curl -s -X POST https://DIN-APP.onrender.com/api/bot-license \
  -H "Content-Type: application/json" \
  -d '{"license_key":"TEST-OK-123","device_id":"DEVICE-1","bot_version":"1.0.0"}'
```

---

## Testlicens

```bash
node scripts/seed-autoclicker-license.mjs ditt-användarnamn
node scripts/seed-autoclicker-license.mjs --reset-device
```

Skapar `TEST-OK-123` · active · 30 dagar · device_id=null · max_devices=1

---

## Zip-fil (lokal utveckling)

```bash
cp ~/Downloads/autoclicker-share.zip private_downloads/autoclicker-share.zip
```

Standard-sökväg: `private_downloads/autoclicker-share.zip` (relativt projektrot).

---

## Render — det du måste göra i Dashboard

### A) Persistent Disk (rekommenderas)

Utan disk **försvinner** `data/autoclicker-licenses.json` och zip vid redeploy.

1. Gå till **Render Dashboard** → din web service (`matched-betting`)
2. **Disks** → **Add Disk** (eller utöka befintlig disk)
3. **Mount Path:** t.ex.  
   `/opt/render/project/src/.matched-betting-cache/autoclicker-data`  
   (kan dela samma disk-volym som bonus-cache, annan undermapp)
4. **Size:** 1 GB räcker

### B) Environment Variables

**Settings** → **Environment** → **Add Environment Variable:**

| Key | Value |
|-----|--------|
| `APP_USERS_DATA_DIR` | `/opt/render/project/src/.matched-betting-cache/app-data/users` |
| `AUTOCLICKER_DATA_DIR` | `/opt/render/project/src/.matched-betting-cache/autoclicker-data/licenses` |
| `AUTOCLICKER_DOWNLOAD_DIR` | `/opt/render/project/src/.matched-betting-cache/autoclicker-data/downloads` |

**Render Disk mount path måste vara:**

```
/opt/render/project/src/.matched-betting-cache
```

(Mount path måste matcha din disk — skapa undermappar `app-data/users`, `autoclicker-data/licenses` och `autoclicker-data/downloads` om de saknas.)

### C) Ladda upp zip till Render

**Rekommenderat — admin-upload (ingen Shell/SCP):**
1. Deploya med persistent disk + env vars (A + B ovan)
2. Logga in → `/admin/autoclicker-licenses`
3. Ladda upp `autoclicker-share.zip` via **Autoclicker zip**
4. Verifiera: `curl -s https://DIN-APP.onrender.com/api/autoclicker/health` → `"zip_exists": true`

**Alternativ — Shell/SCP:**

Efter första deploy med disk:

**Option 1 — Shell (Render Dashboard):**
1. **Shell** på web service
2. Kör:
   ```bash
   mkdir -p /opt/render/project/src/.matched-betting-cache/autoclicker-data/downloads
   ```
3. Ladda upp `autoclicker-share.zip` via Render Shell eller SCP till downloads-mappen som  
   `autoclicker-share.zip`

**Option 2 — lokalt bygg + manuell copy vid deploy:**  
Zip committas **inte** till git. Du måste kopiera den till disk efter deploy (eller via deploy-script).

### D) Skapa första licens på Render

**Shell på Render:**
```bash
cd /opt/render/project/src
node scripts/seed-autoclicker-license.mjs DITT_APP_USERNAME
```

Eller skapa via `/admin/autoclicker-licenses` i webbläsaren.

### E) Verifiera live

```bash
curl -s https://DIN-APP.onrender.com/api/autoclicker/health
curl -s -X POST https://DIN-APP.onrender.com/api/bot-license \
  -H "Content-Type: application/json" \
  -d '{"license_key":"TEST-OK-123","device_id":"DEVICE-1","bot_version":"1.0.0"}'
```

---

## Env-variabler (sammanfattning)

| Variabel | Fallback | Innehåll |
|----------|----------|----------|
| `APP_USERS_DATA_DIR` | `./data/` | `users.json` |
| `AUTOCLICKER_DATA_DIR` | `./data/` | `autoclicker-licenses.json` |
| `AUTOCLICKER_DOWNLOAD_DIR` | `./private_downloads/` | `autoclicker-share.zip` |

---

## Sidor live

| URL | Kräver |
|-----|--------|
| `POST /api/bot-license` | Inget (publik) |
| `GET /api/autoclicker/health` | Inget (publik) |
| `/autoclicker` | Inloggning |
| `/autoclicker/download` | Inloggning + aktiv licens |
| `/admin/autoclicker-licenses` | Inloggning (admin) |
| `POST /api/admin/autoclicker-licenses/upload-zip` | Inloggning (admin) — ladda upp zip |

---

## .gitignore (medvetet)

- `data/autoclicker-licenses.json` — kunddata
- `private_downloads/*.zip` — binär distribution
- `data/autoclicker-licenses.json.corrupt.*.bak` — trasiga backups

README-filer committas. Zip och licenser **inte**.
