# 🗄️ Databas-planen: från "loggbok" till riktig databas

*Skriven för icke-kodare. Senast uppdaterad: 2026-06-11.*

## Varför gör vi det här?

Idag sparar odds-robotarna sina odds genom att skriva i en gemensam **loggbok**
(GitHub). Bara en robot kan skriva åt gången → kö → ett tak för hur ofta vi kan
hämta odds. Det är därför pinnacle inte kan köra var 30:e sekund idag.

Vi byter till en **riktig databas** (Supabase) — ett snabbt arkiv där alla
robotar skriver samtidigt och appen läser direkt. Ingen kö, inget tak.

```
Robotar ──skriver direkt──► SUPABASE (databas) ──läser direkt──► Appen
            (idag: via den långsamma loggboken = GitHub)
```

**Resultat när vi är klara:** pinnacle var 30:e sekund (eller snabbare), fler
sidor, plats att växa — och slut på "sidorna känns stale".

## Planen i 5 steg (vi river aldrig det som fungerar)

| Steg | Vad | Vem | Status |
|---|---|---|---|
| 0 | Skapa Supabase-konto + klistra in 2 nycklar i GitHub | **Du** (~15 min) | ⏳ guide nedan |
| 1 | Bygga "röret" mellan robotarna och databasen | Claude | ✅ klart (inert tills nycklar finns) |
| 2 | Dubbelskrivning: robotarna fyller databasen parallellt med loggboken | Automatiskt | ⏳ startar själv när steg 0 är klart |
| 3 | Appen börjar läsa från databasen (loggboken som reserv) | Claude | efter att steg 2 bevisats |
| 4 | Bytet: pinnacle kan köras var 30:e sekund | Claude | efter steg 3 |
| 5 | (valfritt) Flytta även bet-logg/licenser till databasen | Claude | senare |

**Kostnad:** 0 kr (Supabase gratisnivå räcker länge). Vid framtida tillväxt: ~250-300 kr/mån.

---

## 📋 STEG 0 — Din klick-för-klick-guide (~15 min)

### Del A: Skapa kontot och projektet

1. Gå till **https://supabase.com** och klicka **"Start your project"**.
2. Välj **"Continue with GitHub"** och logga in med ditt GitHub-konto
   (samma som du använder för projektet). Godkänn om den frågar.
3. Klicka **"New project"**.
   - **Name:** `linusgan-odds`
   - **Database password:** klicka **Generate** och **SPARA lösenordet**
     någonstans säkert (t.ex. anteckningar/lösenordshanterare).
   - **Region:** välj **Stockholm** om den finns i listan, annars
     **Frankfurt** (närmast Sverige).
   - Plan: **Free** (gratis).
   - Klicka **"Create new project"** och vänta ~2 minuter.

### Del B: Skapa odds-tabellen (en kopiera-klistra)

4. I vänstermenyn, klicka **"SQL Editor"**.
5. Kopiera **hela** rutan nedan, klistra in i det stora fältet och klicka
   **"Run"** (du ska få "Success. No rows returned"):

```sql
-- Tabellen som odds-robotarna speglar sina odds till.
-- En rad per källa (pinnacle-rows, betsson-rows, ...), skrivs över varje gång.
create table if not exists public.odds_cache (
  source_id  text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

-- Lås tabellen för utomstående: bara våra hemliga server-nycklar kommer åt den.
alter table public.odds_cache enable row level security;
```

### Del C: Hämta de två värdena

6. Klicka kugghjulet **"Project Settings"** (längst ner i vänstermenyn).
7. Gå till **"API"** (kan heta **"API Keys"** / "Data API" i nyare versioner).
8. Kopiera dessa två värden:
   - **Project URL** — ser ut som `https://abcdefgh.supabase.co`
   - **Den hemliga nyckeln** — heter **`service_role`** (klicka "Reveal"/ögat
     för att visa den) eller **"Secret key"** (börjar med `sb_secret_`) i
     nyare projekt. ⚠️ Denna är hemlig — dela den aldrig öppet.

### Del D: Klistra in dem i GitHub (precis som du gjorde med Mullvad-nyckeln)

9. Gå till **github.com/Lilgunner24/linusgan** → **Settings** →
   **Secrets and variables** → **Actions** → **"New repository secret"**.
10. Skapa **två** secrets (exakt dessa namn):

| Name (exakt så här) | Secret (värdet) |
|---|---|
| `SUPABASE_URL` | Project URL från steg 8 |
| `SUPABASE_SERVICE_KEY` | den hemliga nyckeln från steg 8 |

11. **Klart!** Säg till Claude att steg 0 är gjort.

### Vad händer sen — automatiskt

Röret är redan byggt och inkopplat. Inom någon minut efter att du sparat
nycklarna börjar pinnacle-roboten **automatiskt** spegla sina odds till
databasen vid varje hämtning (du behöver inte göra något mer). Claude
verifierar i robotarnas loggar att det fungerar, kopplar sedan på resten av
robotarna och därefter appen (steg 3-4).

---

## Tekniska detaljer (för framtida referens)

- **Spegling:** `scripts/lib/odds-db.mjs`, inkopplad i `scripts/lib/scrape-guard.mjs`
  → `atomicWriteString()` (den gemensamma skrivpunkten för alla 10 scrapers).
  Fire-and-forget, 5 s timeout, kastar aldrig, no-op utan secrets.
- **Pilot:** bara pinnacle-workflows har SUPABASE-env just nu. Övriga scrapers
  får env i en batch när piloten bevisats (en commit, för att undvika
  omstarts-churn).
- **Upsert:** PostgREST `POST /rest/v1/odds_cache?on_conflict=source_id` med
  `Prefer: resolution=merge-duplicates`. `updated_at` skickas alltid explicit
  (default now() gäller bara INSERT, inte upsert-UPDATE).
- **Säkerhet:** RLS på utan policies → endast service-nyckeln (server-sidan)
  kommer åt tabellen. Nyckeln finns bara i GitHub Secrets + (senare) Render env.
- **Läs-sidan (steg 3):** Render-backend läser `GET /rest/v1/odds_cache?source_id=eq.X`
  med samma nyckel, med GitHub-filerna som fallback tills bytet (steg 4).
