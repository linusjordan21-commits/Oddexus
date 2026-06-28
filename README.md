# Matched Betting

React/Vite-app för oddsjämförelse, bonusoptimering och fortsatta omsättningsrundor.

## Snabb setup (inkl. valfri autoklicker)

```bash
bash setup.sh
```

Kopierar `gs-auto-clicker.exe` från `~/Downloads` till `tools/` om den finns. Skapa zip att skicka till kompisar:

```bash
bash setup.sh --pack
```

Se `tools/README.md` för autoklicker på Windows vs Mac.

## Redigera appen

Kör utvecklingsservern:

```bash
npm install
npm run dev
```

Öppna URL:en som terminalen visar, oftast:

```text
http://127.0.0.1:8080/
```

Du kan fortsätta redigera filer som vanligt. När du sparar laddas sidan om automatiskt.

## Bygg för publicering

```bash
npm run build
```

Den färdiga frontend-builden hamnar i:

```text
dist/
```

## Kör som manuell publiceringsserver

Eftersom appen använder egna API-rutter för odds och bonusoptimering ska du inte bara lägga `dist/` på statisk hosting om du vill att allt ska fungera. Använd i stället preview-servern som nu även kör API-rutterna:

```bash
npm run publish:local
```

Eller efter att du redan byggt:

```bash
npm run serve
```

Servern lyssnar på port `8080` och kan nås på:

```text
http://localhost:8080/
```

På en egen server/VPS kan du köra samma kommando och lägga Nginx/Caddy framför port `8080`.

## Uppdatera efter ändringar

När du har gjort ändringar:

```bash
npm run build
npm run serve
```

Om servern redan körs, stoppa den med `Ctrl+C` och starta den igen.

## Viktigt

- `npm run dev` används när du redigerar.
- `npm run publish:local` används när andra ska kunna använda appen via din dator/server.
- API-rutterna för odds körs i Node-processen, så datorn/servern måste vara igång för att andra ska kunna använda hela tjänsten.
