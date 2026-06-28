/**
 * Bet365Adapter — provider-ready, men INAKTIV tills riktig källa kopplas in.
 *
 * Designprincip:
 *   - Bet365 ska behandlas som en vanlig bookmaker i ValueBets-pipelinen
 *     (samma format som Pinnacle / ComeOn / Betsson / Hajper / Snabbare /
 *     Bethard / Spelklubben / VBET / etc).
 *   - Adaptern är *inaktiv* i version 1: ingen mock, ingen synthetic data,
 *     inga fake odds. fetchOdds() returnerar tom array.
 *   - När en riktig provider finns kopplas den in genom att injicera en
 *     loader via Bet365AdapterConfig (se TODO nedan). Adapter-shape förblir
 *     oförändrad så resten av pipelinen behöver inga ändringar.
 *
 * SÄKERHETSREGEL:
 *   API-nycklar exponeras ALDRIG client-side. Riktig provider-fetch måste
 *   ske server-side (GitHub Actions cron, Render backend route, separat
 *   worker). Frontend läser bara cachad fil eller backend-endpoint —
 *   aldrig direkt fetch mot provider.
 *
 * Konvertering från provider-payload till NormalizedOdds[] sker här när en
 * riktig loader injiceras. Tills dess är `defaultLoader` deaktiverad.
 */

import type { BookmakerAdapter, NormalizedOdds, SnapshotMeta } from "../types.ts";

/** Konfiguration injicerad av caller. Alla loaders är optional — saknas
 *  alla → adaptern är inaktiv och returnerar tom array. */
export interface Bet365AdapterConfig {
  /**
   * Läs cachad fil (data/bet365-rows.json eller motsvarande), redan i
   * NormalizedOdds[]-format. Filen skapas av ett server-side jobb som
   * hämtar från en riktig provider med API-nyckel.
   *
   * Browser-säkert: laddar bara en statisk fil, ingen API-nyckel.
   */
  loadCache?: () => Promise<{ events: NormalizedOdds[]; updatedAt: string } | null>;

  /**
   * Direkt fetch mot riktig provider — SERVER-SIDE ONLY.
   * Returnerar redan-normaliserad lista. Kallas bara om
   * BET365_ODDS_PROVIDER_URL + BET365_ODDS_API_KEY env är satta.
   */
  fetchLiveProvider?: () => Promise<{ events: NormalizedOdds[]; updatedAt: string } | null>;
}

/**
 * Skapar Bet365-adaptern. Utan injicerade loaders är adaptern inaktiv
 * och returnerar tom array.
 *
 * ── HUR DU KOPPLAR IN RIKTIG BET365-DATA ────────────────────────────────
 *
 * Steg 1 — välj odds-provider (laglig kommersiell API):
 *   Exempel på providers som har Bet365 i feed:
 *     - OddsJam, The Odds API, OpticOdds, BetsAPI, etc.
 *
 * Steg 2 — server-side sync-jobb:
 *   Skapa en ny GitHub Actions workflow eller Render cron som:
 *     a) Fetchar provider med API-nyckel från env:
 *          const res = await fetch(process.env.BET365_ODDS_PROVIDER_URL, {
 *            headers: { Authorization: `Bearer ${process.env.BET365_ODDS_API_KEY}` }
 *          });
 *     b) Normaliserar provider:s response till NormalizedOdds[] —
 *        implementera `normalize<Provider>Payload(raw): NormalizedOdds[]`.
 *     c) Skriver resultatet till data/bet365-rows.json:
 *          { updatedAt: "...", events: NormalizedOdds[] }
 *
 * Steg 3 — backend integration (vite.config.ts):
 *   Lägg till "bet365" i BOOKMAKER_SCRAPERS-arrayen + skapa en
 *   `scrapeBet365Bookmaker`-funktion som läser data/bet365-rows.json
 *   och returnerar `BookmakerScrapeResult` per match. Pipeline:n
 *   inkluderar då automatiskt Bet365 i /api/valuebets-svaret.
 *
 * Steg 4 — frontend:
 *   Inga ändringar behövs. Bet365 dyker upp som en vanlig bookmaker-rad
 *   i ValueBets-listan när /api/valuebets innehåller bet365-rader.
 *
 * Tills steg 1-3 är klart returnerar adaptern tom array → ingen Bet365
 * i listan, ingen UI-ändring för slutanvändaren.
 */
export function createBet365Adapter(config: Bet365AdapterConfig = {}): BookmakerAdapter {
  let lastMeta: SnapshotMeta = { source: "empty", updatedAt: null };

  const isLiveConfigured = () => {
    if (typeof process === "undefined" || !process.env) return false;
    return Boolean(process.env.BET365_ODDS_PROVIDER_URL && process.env.BET365_ODDS_API_KEY);
  };

  return {
    id: "bet365",
    displayName: "Bet365",

    async fetchOdds(): Promise<NormalizedOdds[]> {
      // 1) Live provider (server-side) — om injicerad + env-konfigurerad.
      if (config.fetchLiveProvider && isLiveConfigured()) {
        try {
          const live = await config.fetchLiveProvider();
          if (live) {
            lastMeta = {
              source: "live-provider",
              updatedAt: live.updatedAt,
              oddsCount: live.events.length,
            };
            return live.events;
          }
        } catch (error) {
          console.warn("[bet365-adapter] live-provider failed, fallback to cache:", error);
        }
      }

      // 2) Cache — om injicerad.
      if (config.loadCache) {
        try {
          const cached = await config.loadCache();
          if (cached && cached.events.length > 0) {
            lastMeta = {
              source: "cache",
              updatedAt: cached.updatedAt,
              oddsCount: cached.events.length,
            };
            return cached.events;
          }
        } catch (error) {
          console.warn("[bet365-adapter] cache-loader failed:", error);
        }
      }

      // 3) Ingen källa konfigurerad → adaptern är inaktiv.
      //    Ingen mock, ingen synthetic, inga fake odds.
      lastMeta = { source: "empty", updatedAt: null, oddsCount: 0 };
      return [];
    },

    async getSnapshotMeta(): Promise<SnapshotMeta> {
      return lastMeta;
    },
  };
}
