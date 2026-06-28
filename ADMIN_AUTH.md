# Admin authentication

Oddexus kräver `username` + `password` för att komma åt webbtjänsten och alla `/api/*`-endpoints. Den här filen förklarar hur du som admin hanterar inloggningen.

> **Quick links**
> [Byt lösenord via `/admin`](#byt-lösenord-via-admin) ·
> [Återställ lösenord via reset-script](#återställ-lösenord-via-reset-script) ·
> [Env vs file](#skillnaden-mellan-env-och-file-credentials) ·
> [Render persistent disk](#render-persistent-disk-viktigt)

---

## Auth-prioritet (hur appen läser credentials)

```
1. data/admin-auth.json      ← admin-editerbar via /admin (file source)
2. Render env vars           ← bootstrap default (env source)
   • APP_USERNAME
   • APP_PASSWORD_HASH   (preferred — scrypt-format)
   • APP_PASSWORD        (fallback — plaintext, mindre säkert)
```

Om `data/admin-auth.json` finns och är välformad används den. Annars faller appen tillbaka till env. Vid parse-fel loggas en warning och env används som säkerhet.

---

## Förstagångs-setup på Render

1. **Generera hash + secret lokalt:**
   ```bash
   node scripts/generate-password-hash.mjs 'ditt-lösenord-här'
   ```
   Scriptet skriver ut `APP_PASSWORD_HASH` och `SESSION_SECRET` direkt till terminalen.

2. **Render → Service → Environment → Add Environment Variable:**

   | Key | Value | Krav |
   |---|---|---|
   | `APP_USERNAME` | t.ex. `linus` | Required |
   | `APP_PASSWORD_HASH` | output från scriptet | Preferred |
   | `APP_PASSWORD` | plaintext | Fallback (sätt EN av hash/plain) |
   | `SESSION_SECRET` | 64-char hex (också från scriptet) | Required — rotera bara om alla ska tvångsloggas ut |

3. **Save & redeploy.** Vid första `/` redirectar appen till `/login`.

> Saknas `SESSION_SECRET` i prod → **fail closed**: alla skyddade endpoints returnerar 401.

---

## Byt lösenord via `/admin`

Den enkla vägen efter förstagångs-setup:

1. Logga in på appen
2. Klicka på username top-right → **Admin**
3. Fyll i `current password` + `new password` (≥10 tecken, ≥1 siffra, ≥1 bokstav)
4. Klicka **Change password**

Vad som händer i backend:
- Nytt lösenord hashas med scrypt
- Skrivs till `data/admin-auth.json` (atomisk write, mode `0o600`)
- Auth-source flippar från `env` → `file`
- Din egen cookie re-issueras → du förblir inloggad

**Logga ut alla sessioner:** klicka **Logout all sessions** på `/admin`. Bumpar `sessionVersion` → alla andra cookies blir omedelbart 401.

---

## Återställ lösenord via reset-script

Om du **glömt** lösenordet du satte via `/admin`:

```bash
node scripts/reset-admin-auth.mjs
```

Vad scriptet gör:
- Tar backup till `data/admin-auth.backup.<timestamp>.json` (mode `0o600`)
- Tar bort `data/admin-auth.json`
- Appen faller automatiskt tillbaka till env-credentials på nästa request
- **Alla inloggade användare slängs ut** (env har `sessionVersion=0`, gamla file-cookies hade ≥1)

Scriptet är **idempotent** — om filen redan saknas händer inget skadligt:
```
ℹ  No admin-auth.json found.
   App is already using env credentials (APP_USERNAME + APP_PASSWORD_HASH).
```

**Var kör jag scriptet?**

| Miljö | Hur |
|---|---|
| Lokal dev | `node scripts/reset-admin-auth.mjs` |
| Render Shell | Service → Shell → kör samma kommando |
| CI/CD | Inkludera i deploy-script om du vill nollställa vid varje deploy |

**Säkerhetsgaranti:**
- Scriptet rör **inte** några env vars
- Scriptet skriver **aldrig** `passwordHash` till stdout
- Backup-filen har samma restriktiva mode (`0o600`) som original
- `.gitignore` täcker både `data/admin-auth.json` och alla backup-filer → kan inte committas av misstag

---

## Skillnaden mellan env och file credentials

| | `env` source | `file` source |
|---|---|---|
| Var lagras lösenordet | Render dashboard env vars | `data/admin-auth.json` på filsystem |
| Hur ändras det | Edit env vars + redeploy | `/admin`-form eller `change-password` API |
| Survives redeploy | ✅ Alltid | ⚠️ Bara med persistent disk (se nedan) |
| Survives instance restart | ✅ | ✅ |
| sessionVersion | Alltid `0` (logout-all möjligt först efter file-migration) | `1+`, bumpas av logout-all |
| Säkerhetsnivå | Samma — båda använder scrypt-hash | Samma — båda använder scrypt-hash |

Båda är scrypt-hashade. Skillnaden är **var hashen lagras** och **vem som kan ändra den**.

---

## Render persistent disk (viktigt!)

På Render **utan persistent disk** är filsystemet **ephemeral**:
- Filer i `data/` försvinner vid varje redeploy
- `data/admin-auth.json` försvinner → auth faller tillbaka till env

Det betyder att lösenord du satt via `/admin` är **tillfälligt** om du inte har persistent disk.

`/admin`-sidan visar en warning när `authSource: "file"`:
> "Password stored in data/admin-auth.json. On Render free/standard without persistent disk this file is reset on redeploy. Configure a persistent disk to keep changes permanent."

**Lösningar:**

1. **Konfigurera Render persistent disk** (Service → Settings → Disks → Add Disk → mount path `/opt/render/project/src/data`). Då persisteras `admin-auth.json` mellan redeploys.

2. **Eller hantera lösenord enbart via env vars.** Glöm `/admin`-vägen och uppdatera `APP_PASSWORD_HASH` när du vill byta lösenord. Mer manuellt men permanent.

3. **Eller acceptera ephemeral mode** — `/admin` är då bekvämt för temporära byten (t.ex. dela tillfällig access) men varje redeploy återställer till env-lösenordet.

---

## Säkerhetsegenskaper

- ✅ Lösenord lagras **aldrig** i frontend/localStorage
- ✅ Lösenord **loggas aldrig** (varken klartext eller hash)
- ✅ Cookie är `HttpOnly` + `Secure` (prod) + `SameSite=Lax`
- ✅ Session-cookie signeras med HMAC-SHA256 + `SESSION_SECRET`
- ✅ Password compare är timing-safe (`crypto.timingSafeEqual`)
- ✅ Login error är alltid `"Invalid credentials"` — avslöjar inte vilket fält som var fel
- ✅ Rate limit: 5 attempts / 15 min / IP på `/api/auth/login` och `/api/admin/change-password`
- ✅ `data/admin-auth.json` skrivs atomiskt (`.tmp` → `rename`) med mode `0o600`
- ✅ `data/admin-auth.json` + backups är gitignored
- ✅ `getAuthFromRequest` verifierar `cookie.v >= currentSessionVersion` så logout-all invaliderar gamla cookies

---

## Filer

| Fil | Vad |
|---|---|
| `vite.config.ts` | Auth-modul + admin-endpoints (`/api/auth/*`, `/api/admin/*`) |
| `src/pages/Login.tsx` | Login-formulär |
| `src/pages/Admin.tsx` | Admin-sidan (byta lösenord, logout-all) |
| `src/contexts/AuthContext.tsx` | React auth-state |
| `src/components/ProtectedRoute.tsx` | Route-wrapper som redirectar till `/login` |
| `src/components/UserMenu.tsx` | Top-right meny med Admin-länk + Sign out |
| `scripts/generate-password-hash.mjs` | Generera `APP_PASSWORD_HASH` + `SESSION_SECRET` |
| `scripts/reset-admin-auth.mjs` | Ta bort `data/admin-auth.json` → fallback till env |
| `data/admin-auth.json` | Admin-editerbara credentials (gitignored) |
