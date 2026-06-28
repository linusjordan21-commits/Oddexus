# Setup cron-job.org — fixar stale-data idag

## Vad är problemet det löser?

GitHub Actions cron är opålitlig. Workflows som ska köras var 5:e minut körs i praktiken bara var 2-3:e timme på publika repos. Vi behöver en **extern tjänst som pingar GitHub var 60:e sekund** och tvingar igång workflows.

Cron-job.org gör exakt det. Gratis (upp till 50 jobs).

## Tidsåtgång: ~15 minuter total

---

## Steg 1: Skapa GitHub Personal Access Token (PAT)

Vi behöver en token som tillåter cron-job.org att trigga workflows åt dig.

1. Gå till: **https://github.com/settings/personal-access-tokens/new**
2. Fyll i:
   - **Token name:** `cron-job-org-workflow-trigger`
   - **Expiration:** `90 days` (du får påminnelse att förnya)
   - **Repository access:** välj **Only select repositories** → välj `Lilgunner24/linusgan`
   - **Repository permissions:** Scrolla ner till **Actions** → ändra från `No access` till **`Read and write`**
3. Klicka **Generate token**
4. **Kopiera token:n direkt** (visas bara en gång). Den börjar med `github_pat_...`. Spara den temporärt i en textfil.

---

## Steg 2: Skapa konto på cron-job.org

1. Gå till: **https://cron-job.org/en/signup/**
2. Registrera med din e-postadress (gratis)
3. Verifiera mejlet
4. Logga in

---

## Steg 3: Skapa cron-jobs (ett per workflow)

För varje workflow vi vill pinga, skapar du ett separat job i cron-job.org.

### Workflow-lista att konfigurera

| # | Workflow | Cron-cadence | Prioritet |
|---|----------|--------------|-----------|
| 1 | `pinnacle-fetch.yml` | **Var 60:e sekund** | KRITISK |
| 2 | `kambi-fetch.yml` | Var 5:e min | HÖG |
| 3 | `betsson-fetch.yml` | Var 5:e min | HÖG |
| 4 | `comeon-fetch.yml` | Var 5:e min | HÖG |
| 5 | `paf-brand-fetch.yml` | Var 10:e min | MEDIUM |
| 6 | `altenar-fetch.yml` | Var 10:e min | MEDIUM |
| 7 | `vbet-fetch.yml` | Var 10:e min | MEDIUM |
| 8 | `sportybet-fetch.yml` | Var 15:e min | LÅG |
| 9 | `bet7-fetch.yml` | Var 15:e min | LÅG |
| 10 | `bet9ja-fetch.yml` | Var 15:e min | LÅG |

**Börja med #1 (Pinnacle) — det är värsta problemet.**

### För varje workflow:

1. I cron-job.org dashboard: klicka **Create cronjob**
2. Fyll i:

   **Title:** `Pinnacle Odds Refresh` (eller namn på workflow)

   **URL:** `https://api.github.com/repos/Lilgunner24/linusgan/actions/workflows/pinnacle-fetch.yml/dispatches`

   (Byt ut `pinnacle-fetch.yml` mot rätt workflow-fil för varje job)

   **Schedule:** Klicka "Edit" → välj cadence (se tabellen ovan)
   - För Pinnacle: kryssa "Every 1 minutes" (det är minimum på gratiskonto)

   **Klicka "Advanced" eller "Request settings":**

   **Request method:** `POST`

   **Request body:** Klicka "Add request body" och klistra in:
   ```json
   {"ref":"main"}
   ```

   **Request headers:** Klicka "Add header" två gånger och fyll i:

   | Header | Value |
   |--------|-------|
   | `Accept` | `application/vnd.github+json` |
   | `Authorization` | `Bearer github_pat_DIN_TOKEN_HÄR` |
   | `X-GitHub-Api-Version` | `2022-11-28` |

   *(Ersätt `github_pat_DIN_TOKEN_HÄR` med token:n från Steg 1)*

3. Klicka **Create** / **Save**

4. Testa med "Test execution"-knappen — du ska få **HTTP 204** som svar.
   - Om du får 401: token är fel
   - Om du får 404: workflow-namnet är felstavat eller saknar `workflow_dispatch:` i sin YAML
   - Om du får 422: `{"ref":"main"}` body saknas

---

## Steg 4: Verifiera att det funkar

1. Gå till **https://github.com/Lilgunner24/linusgan/actions/workflows/pinnacle-fetch.yml**
2. Du ska se nya körningar med trigger `workflow_dispatch` (cron-job.org)
3. Inom ~5 minuter ska Pinnacle-data uppdateras på matched-betting.onrender.com
4. Öppna `/api/sources/status` (admin) → Pinnacle ska visa fresh, inte stale

---

## Tips

- **Börja med bara Pinnacle.** Verifiera att det funkar. Lägg sedan till de andra.
- Om alla 11 jobs kör samtidigt kan GitHub Actions ändå köa dem. Förlita dig inte på exakt cadence.
- Cron-job.org gratis-konto: max 50 jobs (du behöver bara 11)
- Om din PAT går ut om 90 dagar måste du generera ny + uppdatera alla 11 jobs

---

## Felsökning

**Problem: cron-job.org säger "Failed: HTTP 401"**
→ Token är ogiltig eller saknar Actions write-scope. Generera ny PAT.

**Problem: Workflow körs men data uppdateras inte ändå**
→ Workflow:n själv är trasig (Cloudflare blockerar, secrets utgångna). Kolla workflow-loggen på GitHub Actions-fliken.

**Problem: GitHub säger "rate limit exceeded"**
→ Du pingar för ofta från samma PAT. Pinnacle är OK på 1/min, men inte mer.
