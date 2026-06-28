# Publicera sidan via Render

Sidan är konfigurerad för att deployas till [Render](https://render.com) som en fullständig
Node-server. Frontend, alla `/api`-endpoints (Stake/BetOnline-jämförelse, bonusoptimering,
oddsscraping) och BetOnline-workern körs i samma container.

> **Auto-deploy:** varje gång du pushar till `main` på GitHub byggs sidan om automatiskt.
> Du och jag kan alltså fortsätta iterera precis som vanligt.

## 1. Engångsuppsättning på Render (~5 minuter)

1. Skapa ett konto på [https://render.com](https://render.com). Logga in med GitHub.
2. Klicka **New → Blueprint** uppe till höger.
3. Välj repo `**Lilgunner24/linusgan`**.
4. Render läser `render.yaml` och föreslår en webbservice + en disk. Klicka **Apply**.
5. Bekräfta plan **Starter** ($7/månad) för att hålla servern alltid aktiv.
  - Free-plan finns men servern somnar efter 15 min, vilket gör att första anropet
   tar ~30 sekunder. Inte trevligt för dina kompisar.
6. Vänta ~5 minuter på första bygget. Render visar en URL som
  `https://matched-betting.onrender.com` när det är klart.

Skicka URL:en till dina kompisar.

## 2. Hur uppdateringar funkar

Kör som vanligt lokalt:

```bash
npm run dev
```

När du är nöjd med en ändring:

```bash
git add .
git commit -m "Förbättrade bonusoptimeringen"
git push
```

Render plockar upp pushen, bygger om automatiskt, och deployar utan downtime.
Hela processen tar 2–4 minuter och du behöver inte göra något manuellt.

## 3. Vad funkar i molnet?


| Del                            | Status                             |
| ------------------------------ | ---------------------------------- |
| Frontend / UI                  | ✅                                  |
| Bonus optimering               | ✅                                  |
| Välkomstbonus / oddsjämförelse | ✅                                  |
| Stake-odds (publik API)        | ✅                                  |
| Pinnacle-odds (publik API)     | ✅                                  |
| BetOnline-odds via Cloudflare  | ⚠️ kan ibland blockeras (se nedan) |


### BetOnline + Cloudflare

BetOnline gömmer sitt odds-API bakom Cloudflare. När workern körs lokalt på din maskin
är det enkelt: din IP är "vanlig" och eventuell utmaning kan lösas i ett browserfönster.
På Render är det svårare:

- Datacenter-IP:er är ibland flaggade och kan få 403 från Cloudflare.
- Workern kör headless (`STAKE_BETONLINE_HEADLESS=1`) så ingen kan klicka bort en captcha.

I praktiken får workern ofta igenom data ändå (Cloudflare kollar mest cookies + JS, vilket
Playwright löser automatiskt). Om Cloudflare börjar blockera kan vi:

- Sätta `BETONLINE_URL` till en mindre populär sida för att smyga in.
- Använda en residential proxy (kostar pengar).
- Köra workern lokalt på din dator när du vill ha färska BetOnline-odds; cachen
sparas på diskvolymen och servern läser den. Det funkar, men kräver att din dator
är på vid de tillfällena.

## 4. Felsökning

- **Render-bygget tar lång tid:** `npx playwright install --with-deps chromium` laddar
ner ~150 MB första gången, sen är det cachat.
- **"Cannot find module"** efter deploy: säkerställ att `NPM_CONFIG_PRODUCTION=false` är
satt (gjort automatiskt via `render.yaml`).
- **BetOnline ger 0 rader:** logga in på Render-dashboarden och titta i loggen efter
`[stake-betonline-worker]`. Om Cloudflare blockerar syns det där.

## 5. Persistent Disk — users och autoclicker-licenser

**Utan persistent disk försvinner users och licenser vid varje redeploy.**

### Render Disk mount path

```
/opt/render/project/src/.matched-betting-cache
```

### Environment variables (Render Dashboard → Environment)

| Key | Value |
|-----|--------|
| `APP_USERS_DATA_DIR` | `/opt/render/project/src/.matched-betting-cache/app-data/users` |
| `AUTOCLICKER_DATA_DIR` | `/opt/render/project/src/.matched-betting-cache/autoclicker-data/licenses` |
| `AUTOCLICKER_DOWNLOAD_DIR` | `/opt/render/project/src/.matched-betting-cache/autoclicker-data/downloads` |

### Var filerna hamnar på Render

| Data | Path |
|------|------|
| Users | `.../app-data/users/users.json` |
| Licenser | `.../autoclicker-data/licenses/autoclicker-licenses.json` |
| Bot-zip | `.../autoclicker-data/downloads/autoclicker-share.zip` |

Vid första start efter deploy migreras befintliga `data/users.json` och
`data/autoclicker-licenses.json` automatiskt till persistent path om target-filen saknas.

Verifiera efter deploy (inloggad som admin):

```bash
curl -s -b "pp_session=..." https://matched-betting.onrender.com/api/admin/storage/health
```

Eller öppna `/admin` → **Persistent lagring**.

## 6. Lokalt utan Render

Allt fungerar fortfarande lokalt:

```bash
npm install
npm run dev               # frontend + alla API:er på 127.0.0.1:8080
npm run worker:stake-betonline   # öppnar browser för BetOnline-scraping
```