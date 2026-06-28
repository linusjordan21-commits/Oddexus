# Supabase migrations

Reproducerbar databas-struktur via versionerade SQL-filer i `migrations/`.
Inget manuellt klistrande i dashboarden — **utom en (1) engångs-bootstrap** (se nedan).

## Hur det fungerar

- `migrations/NNNN_namn.sql` — numrerade, **idempotenta** migrationer (`create ... if not exists`, `on conflict do nothing`). Säkra att köra om.
- `scripts/db/apply-migrations.mjs` — applicerar pending migrationer via `fetch` + Supabase-RPC:n `exec_sql`, bokför i `schema_migrations`. Använder din **befintliga `SUPABASE_SERVICE_KEY`** (ingen ny secret, ingen ny dependency).
- `.github/workflows/db-migrate.yml` — kör scriptet automatiskt när en migrationsfil ändras på `main` (eller manuellt via *Run workflow*).

## Engångs-bootstrap (en gång, ~30 sek)

PostgREST (service-key-API:t) kan inte köra DDL/schemaändringar — bara läsa/skriva
rader. Därför behövs en liten bootstrap som skapar `schema_migrations` + funktionen
`exec_sql`. **Kör innehållet i `migrations/0000_bootstrap.sql` en gång** i Supabase →
SQL Editor → New query → Run.

> `exec_sql` är `security definer` men `revoke`:ad från alla utom service-rollen.
> Service-nyckeln har redan full DB-access (bypassar RLS), så detta utökar inte
> angreppsytan — det gör bara DDL möjlig via API:t.

Efter det sköts allt automatiskt.

## Köra migrationer

**CI (rekommenderat):** pusha en ny `migrations/*.sql` till `main` → `db-migrate`-workflowen kör den. Eller kör workflowen manuellt.

**Lokalt:**
```bash
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/db/apply-migrations.mjs
# Dry-run (lista bara pending, kör inget):
DRY_RUN=1 SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/db/apply-migrations.mjs
```

## Lägga till en migration

1. Skapa `migrations/NNNN_beskrivning.sql` (nästa nummer). Gör den idempotent.
2. Pusha till `main` → CI applicerar. (Eller kör scriptet lokalt.)

## Nuvarande migrationer

| Fil | Innehåll |
|---|---|
| `0000_bootstrap.sql` | **manuell engångskörning** — `schema_migrations` + `exec_sql` |
| `0001_odds_cache.sql` | baslinje: befintliga `odds_cache` (idempotent) |
| `0002_system_config.sql` | config-driven trösklar (`system_config`) + seed |
| `0003_normalized_markets.sql` | stabil market-registry (`normalized_markets`) |
