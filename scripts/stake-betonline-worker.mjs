import fs from "node:fs";
import path from "node:path";

// MOLN-GUARD: på Render körs denna worker i samma container som webbservern
// (blueprint-startCommand = start:cloud, även om dashboarden visar "npm run start").
// Playwright-browsern saknas på Render (versions-skew playwright/rebrowser-playwright)
// → workern kraschloopar var 25:e sekund och svälter ut webbserverns boot, så webben
// hinner inte binda sin port → Render "port scan timeout, no open ports" → sajten nere.
// Stake/BetOnline-skrapning hör hemma i GitHub Actions, inte i web-containern.
// Stäng av den här i molnet. Sätt STAKE_BETONLINE_ENABLED=1 för att tvinga igång den.
if (process.env.RENDER && process.env.STAKE_BETONLINE_ENABLED !== "1") {
  console.log(
    "[stake-betonline-worker] avstängd på Render (frigör resurser så webben kan binda porten). Sätt STAKE_BETONLINE_ENABLED=1 för att aktivera.",
  );
  process.exit(0);
}

const CACHE_DIR = path.resolve(process.cwd(), ".matched-betting-cache");
const PROFILE_DIR = path.join(CACHE_DIR, "stake-betonline-browser-profile");
const CACHE_FILE = path.join(CACHE_DIR, "stake-betonline-cache.json");
const INTERVAL_MS = Number(process.env.STAKE_BETONLINE_INTERVAL_MS || 5 * 60 * 1000);
const STAKE_FIXTURE_LIMIT_PER_SPORT = Number(process.env.STAKE_BETONLINE_STAKE_LIMIT || 60);
const BETONLINE_URL = process.env.BETONLINE_URL || "https://www.betonline.ag/sportsbook/basketball";

const STAKE_API_BASE = "https://odds-data.stake.com";
const STAKE_FETCH_HEADERS = {
  accept: "application/json",
  origin: "https://stake.com",
  referer: "https://stake.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const STAKE_DEFAULT_SPORTS = [
  "soccer",
  "basketball",
  "tennis",
  "ice-hockey",
  "american-football",
  "baseball",
  "mma",
  "boxing",
];

const STAKE_POPULAR_TOURNAMENTS = [
  { sport: "soccer", category: "england", tournament: "premier-league" },
  { sport: "soccer", category: "spain", tournament: "laliga" },
  { sport: "soccer", category: "italy", tournament: "serie-a" },
  { sport: "soccer", category: "germany", tournament: "bundesliga" },
  { sport: "soccer", category: "france", tournament: "ligue-1" },
  { sport: "soccer", category: "international-clubs", tournament: "uefa-champions-league" },
  { sport: "soccer", category: "international-clubs", tournament: "uefa-europa-league" },
  { sport: "soccer", category: "england", tournament: "championship" },
  { sport: "soccer", category: "england", tournament: "fa-cup" },
  { sport: "soccer", category: "usa", tournament: "major-league-soccer" },
  { sport: "soccer", category: "spain", tournament: "copa-del-rey" },
  { sport: "basketball", category: "usa", tournament: "nba" },
  { sport: "basketball", category: "international", tournament: "euroleague" },
  { sport: "basketball", category: "usa", tournament: "ncaa" },
  { sport: "ice-hockey", category: "usa", tournament: "nhl" },
  { sport: "american-football", category: "usa", tournament: "nfl" },
  { sport: "american-football", category: "usa", tournament: "ncaa" },
  { sport: "baseball", category: "usa", tournament: "mlb" },
  { sport: "tennis", category: "atp", tournament: "atp-madrid" },
  { sport: "tennis", category: "wta", tournament: "wta-madrid" },
];

function americanToDecimal(value) {
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

function parseMarketLine(...values) {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).replace(",", ".");
    const match = text.match(/(?:^|[^\d])([+-]?\d+(?:\.\d+)?)(?!\d)/);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function formatMarketLine(value) {
  const abs = Math.abs(value);
  const text = abs.toLocaleString("sv-SE", { maximumFractionDigits: 2 });
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return "0";
}

function stakeFixtureStartTime(fixture) {
  return fixture?.startTime ?? fixture?.date ?? fixture?.feedStartTime;
}

function findDecimalLineCandidates(node, pathParts = []) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.flatMap((child, index) => findDecimalLineCandidates(child, [...pathParts, String(index)]));
  }

  const out = [];
  const decimal = Number(node.DecimalLine ?? node.DecimalOdds ?? node.Decimal ?? 0);
  if (decimal > 1) {
    const pathText = pathParts.join(" ");
    const line = parseMarketLine(
      node.Points,
      node.PointSpread,
      node.Spread,
      node.Total,
      node.Handicap,
      node.Line,
      node.Name,
      node.Description,
      pathText,
    );
    out.push({ decimal, line, pathText, node });
  }

  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      out.push(...findDecimalLineCandidates(value, [...pathParts, key]));
    }
  }
  return out;
}

function firstCandidate(node, include, exclude = /moneyline|money line/i) {
  return findDecimalLineCandidates(node).find(
    (candidate) => include.test(candidate.pathText) && !exclude.test(candidate.pathText),
  );
}

function findDrawDecimal(game) {
  const direct = Number(
    game?.DrawLine?.MoneyLine?.DecimalLine ??
      game?.TieLine?.MoneyLine?.DecimalLine ??
      game?.Draw?.MoneyLine?.DecimalLine ??
      game?.Tie?.MoneyLine?.DecimalLine ??
      game?.MoneyLine?.DrawLine?.DecimalLine ??
      0,
  );
  if (direct > 1) return direct;
  const candidate = findDecimalLineCandidates(game).find(
    (item) => /\b(draw|tie|x)\b/i.test(item.pathText) && /moneyline|money line|line/i.test(item.pathText),
  );
  return candidate?.decimal > 1 ? candidate.decimal : undefined;
}

function normalizeMatchName(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(fc|afc|cf|sc|bk|if|ac|bc|united|city|club)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchSimilarity(a, b) {
  const aTokens = new Set(normalizeMatchName(a).split(/\s+/).filter((token) => token.length >= 3));
  const bTokens = new Set(normalizeMatchName(b).split(/\s+/).filter((token) => token.length >= 3));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let hits = 0;
  for (const token of aTokens) if (bTokens.has(token)) hits += 1;
  return hits / Math.max(aTokens.size, bTokens.size);
}

const SAME_FIXTURE_TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000;

function startTimeConflict(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) > SAME_FIXTURE_TIME_TOLERANCE_MS;
}

function leagueLooksDifferent(a, b) {
  if (!a || !b) return false;
  const norm = (value) =>
    new Set(
      String(value)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((tok) => tok.length >= 3),
    );
  const aT = norm(a);
  const bT = norm(b);
  if (aT.size === 0 || bT.size === 0) return false;
  for (const tok of aT) if (bT.has(tok)) return false;
  return true;
}

async function fetchStakeJson(pathSuffix, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${STAKE_API_BASE}${pathSuffix}`, {
      headers: STAKE_FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Stake API ${pathSuffix} HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function selectStakeWinnerMarket(payload) {
  if (!payload?.groups) return null;
  const candidates = [];
  for (const group of payload.groups) {
    if (group?.name && group.name !== "main" && !/winner|moneyline|head/i.test(group.name)) continue;
    for (const marketArr of group?.markets ?? []) {
      for (const market of marketArr ?? []) {
        if (!market?.name || market.status === "deactivated" || market.status === "suspended") continue;
        if (market.specifiers && market.specifiers.length > 0) continue;
        const lower = market.name.toLowerCase();
        let priority = -1;
        if (lower === "1x2") priority = 100;
        else if (lower === "match winner" || lower === "match winner - threeway") priority = 95;
        else if (lower === "winner (incl. overtime)") priority = 90;
        else if (lower === "match winner - twoway" || lower === "winner") priority = 85;
        else if (lower === "moneyline") priority = 82;
        else if (lower === "head to head" || lower === "to win match") priority = 80;
        else if (
          lower.includes("winner") &&
          !lower.includes("half") &&
          !lower.includes("quarter") &&
          !lower.includes("set")
        )
          priority = 60;
        if (priority < 0) continue;
        const outcomes = (market.outcomes ?? []).filter((o) => Number.isFinite(o?.odds) && (o?.odds ?? 0) > 1);
        if (outcomes.length < 2) continue;
        candidates.push({ market: { ...market, outcomes }, priority });
      }
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates[0]?.market ?? null;
}

function extractStakeWinnerOdds(sport, meta, payload) {
  const market = selectStakeWinnerMarket(payload);
  if (!market || !market.outcomes) return null;

  const fixture = payload.fixture ?? meta ?? {};
  const competitors = fixture.competitors ?? meta?.competitors ?? [];
  const matchName = fixture.name ?? meta?.name ?? competitors.join(" - ");
  if (!matchName) return null;

  const homeName = competitors[0];
  const awayName = competitors[1];

  const findOutcome = (predicate) => market.outcomes.find(predicate);

  let drawOutcome;
  let homeOutcome;
  let awayOutcome;

  if (market.outcomes.length === 3) {
    drawOutcome = findOutcome((o) => /^(draw|x|tie)$/i.test(o?.name ?? ""));
  }
  if (homeName) {
    homeOutcome = findOutcome((o) => (o?.name ?? "").trim().toLowerCase() === homeName.toLowerCase());
  }
  if (awayName) {
    awayOutcome = findOutcome((o) => (o?.name ?? "").trim().toLowerCase() === awayName.toLowerCase());
  }

  if (!homeOutcome || !awayOutcome) {
    const remaining = market.outcomes.filter((o) => o !== drawOutcome);
    homeOutcome = homeOutcome ?? remaining[0];
    awayOutcome = awayOutcome ?? remaining[1] ?? remaining[remaining.length - 1];
  }
  if (!homeOutcome || !awayOutcome) return null;

  const homeOdds = Number(homeOutcome?.odds);
  const awayOdds = Number(awayOutcome?.odds);
  if (!(homeOdds > 1 && awayOdds > 1)) return null;
  const drawOddsValue = drawOutcome ? Number(drawOutcome.odds) : undefined;

  return {
    source: "stake",
    sport,
    match: matchName,
    startTime: stakeFixtureStartTime(fixture) ?? stakeFixtureStartTime(meta),
    status: fixture.status ?? meta?.status,
    category: fixture.category ?? meta?.category,
    tournament: fixture.tournament ?? meta?.tournament,
    homeName: homeOutcome?.name ?? homeName,
    awayName: awayOutcome?.name ?? awayName,
    homeOdds,
    awayOdds,
    drawOdds: Number.isFinite(drawOddsValue) && (drawOddsValue ?? 0) > 1 ? drawOddsValue : undefined,
    marketName: market.name ?? "Match Winner",
    fixtureSlug: fixture.slug ?? meta?.slug,
    fixtureId: fixture.id ?? meta?.id,
  };
}

async function listStakeFixturesForSport(sport) {
  const seen = new Map();
  const addAll = (arr) => {
    for (const fixture of arr ?? []) {
      const key = fixture?.slug ?? fixture?.id;
      if (!key || seen.has(key)) continue;
      seen.set(key, fixture);
    }
  };

  const tournamentRequests = STAKE_POPULAR_TOURNAMENTS.filter((t) => t.sport === sport).map((t) =>
    fetchStakeJson(
      `/sport/${t.sport}/category/${t.category}/tournament/${t.tournament}/fixture`,
    )
      .then((data) => addAll(data?.fixture))
      .catch(() => undefined),
  );

  await Promise.all([
    fetchStakeJson(`/sport/${sport}/fixture`)
      .then((data) => addAll(data?.fixture))
      .catch(() => undefined),
    fetchStakeJson(`/schedule/sport/${sport}`)
      .then((data) => {
        for (const entry of data?.schedule ?? []) {
          addAll(entry?.fixture);
          addAll(entry?.fixtures);
        }
      })
      .catch(() => undefined),
    ...tournamentRequests,
  ]);

  return [...seen.values()].filter((fixture) => fixture?.preMatchEnabled !== false);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch {
        results[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function buildStakeRowsForSport(sport, fixtureLimit = 32) {
  const fixtures = await listStakeFixturesForSport(sport).catch(() => []);
  const now = Date.now();
  const preMatch = fixtures.filter(
    (fixture) =>
      fixture?.status !== "live" &&
      fixture?.status !== "ended" &&
      Number.isFinite(stakeFixtureStartTime(fixture)) &&
      (stakeFixtureStartTime(fixture) ?? 0) > now,
  );
  const trimmed = preMatch
    .slice()
    .sort((a, b) => (stakeFixtureStartTime(a) ?? Infinity) - (stakeFixtureStartTime(b) ?? Infinity))
    .slice(0, fixtureLimit);
  const results = await mapLimit(trimmed, 6, async (fixture) => {
    const slug = fixture?.slug ?? fixture?.id;
    if (!slug) return null;
    try {
      const payload = await fetchStakeJson(`/fixtures/${slug}`);
      const row = extractStakeWinnerOdds(sport, fixture, payload);
      if (!row) return null;
      if (row.status === "live" || row.status === "ended") return null;
      return row;
    } catch {
      return null;
    }
  });
  return results.filter(Boolean);
}

async function buildStakeRowsAllSports() {
  const all = [];
  for (const sport of STAKE_DEFAULT_SPORTS) {
    try {
      const rows = await buildStakeRowsForSport(sport, STAKE_FIXTURE_LIMIT_PER_SPORT);
      all.push(...rows);
      console.log(`[stake-betonline-worker] stake ${sport}: ${rows.length} rows`);
    } catch (error) {
      console.warn(`[stake-betonline-worker] stake ${sport} failed:`, error?.message ?? error);
    }
  }
  return all;
}

function parseBetOnlineRenderedText(lines) {
  return lines.flatMap((rawLine) => {
    const raw = rawLine.replace(/\s+/g, " ").trim();
    if (!raw || !/moneyline/i.test(raw)) return [];
    const moneylineIndex = raw.toLowerCase().indexOf("moneyline");
    const moneylinePart = raw.slice(moneylineIndex);
    const americanOdds = [...moneylinePart.matchAll(/(?:^|\s)([+-]\d{3,4})(?=\s|$)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));
    if (americanOdds.length < 2) return [];

    const matchText = raw
      .slice(0, moneylineIndex)
      .replace(/^(today|tomorrow|mon,|tue,|wed,|thu,|fri,|sat,|sun,)?\s*\d{1,2}:\d{2}\s*(am|pm)\s+/i, "")
      .replace(/\+\d+\s+/g, " ")
      .replace(/\b\d{3,4}\s+-\s+/g, "")
      .replace(/\b(run line|total)\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

    return [
      {
        source: "betonline",
        match: matchText || raw.slice(0, moneylineIndex).trim(),
        homeOdds: americanToDecimal(americanOdds[0]),
        awayOdds: americanToDecimal(americanOdds[1]),
        raw,
      },
    ];
  });
}

const BETONLINE_SPORT_TO_STAKE = {
  basketball: "basketball",
  soccer: "soccer",
  ice_hockey: "ice-hockey",
  football: "american-football",
  baseball: "baseball",
  tennis: "tennis",
  mma: "mma",
  boxing: "boxing",
  rugby: "rugby",
  cricket: "cricket",
  handball: "handball",
  volleyball: "volleyball",
  table_tennis: "table-tennis",
  snooker: "snooker",
  darts: "darts",
};

function parseBetOnlineStartTime(entry, game) {
  const candidates = [
    entry?.StartTime,
    entry?.GameDateTime,
    entry?.GameDateTimeUTC,
    entry?.GameDate,
    entry?.GameTime,
    entry?.EventDateTime,
    game?.StartTime,
    game?.GameDateTime,
    game?.GameDateTimeUTC,
    game?.GameDate,
    game?.GameTime,
  ];
  for (const value of candidates) {
    if (value == null) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }
    const ms = Date.parse(String(value));
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function parseBetOnlineOffering(data, sportTag, leagueTag) {
  const games = data?.GameOffering?.GamesDescription ?? [];
  return games.flatMap((entry) => {
    const game = entry?.Game;
    const away = game?.AwayTeam;
    const home = game?.HomeTeam;
    if (!home || !away) return [];
    const startTime = parseBetOnlineStartTime(entry, game);
    const league = leagueTag ?? null;
    const rows = [];

    // Moneyline (1X2 om draw odds finns)
    const homeMl = Number(game?.HomeLine?.MoneyLine?.DecimalLine ?? 0);
    const awayMl = Number(game?.AwayLine?.MoneyLine?.DecimalLine ?? 0);
    const drawMl = Number(game?.DrawLine?.MoneyLine?.DecimalLine ?? 0);
    const drawOdds = drawMl > 1 ? drawMl : undefined;
    if (homeMl > 1 && awayMl > 1) {
      rows.push({
        source: "betonline",
        sport: sportTag ?? null,
        match: `${home} vs ${away}`,
        homeName: home,
        awayName: away,
        homeOdds: homeMl,
        awayOdds: awayMl,
        drawOdds,
        drawOutcomeLabel: drawOdds ? "Oavgjort" : undefined,
        marketType: "moneyline",
        marketLabel: drawOdds ? "1X2" : "Moneyline",
        raw: `${away} @ ${home}`,
      });
    }

    // Spread / handicap / run line / puck line: matchande line på båda sidorna.
    const homeSpread = game?.HomeLine?.SpreadLine;
    const awaySpread = game?.AwayLine?.SpreadLine;
    const homeSpreadOdds = Number(homeSpread?.DecimalLine ?? 0);
    const awaySpreadOdds = Number(awaySpread?.DecimalLine ?? 0);
    const homeSpreadPoint = Number(homeSpread?.Point ?? NaN);
    const awaySpreadPoint = Number(awaySpread?.Point ?? NaN);
    if (
      homeSpreadOdds > 1 &&
      awaySpreadOdds > 1 &&
      Number.isFinite(homeSpreadPoint) &&
      Number.isFinite(awaySpreadPoint) &&
      Math.abs(homeSpreadPoint + awaySpreadPoint) < 0.05
    ) {
      rows.push({
        source: "betonline",
        sport: sportTag ?? null,
        match: `${home} vs ${away}`,
        homeName: home,
        awayName: away,
        homeOdds: homeSpreadOdds,
        awayOdds: awaySpreadOdds,
        homeLine: homeSpreadPoint,
        awayLine: awaySpreadPoint,
        homeOutcomeLabel: `${home} ${formatMarketLine(homeSpreadPoint)}`,
        awayOutcomeLabel: `${away} ${formatMarketLine(awaySpreadPoint)}`,
        marketType: "spread",
        line: Math.abs(homeSpreadPoint),
        marketLabel: `Spread ${Math.abs(homeSpreadPoint).toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
        raw: `${away} @ ${home} spread`,
      });
    }

    // Total (game) over/under
    const totalLine = game?.TotalLine?.TotalLine;
    const totalPoint = Number(totalLine?.Point ?? NaN);
    const overOdds = Number(totalLine?.Over?.DecimalLine ?? 0);
    const underOdds = Number(totalLine?.Under?.DecimalLine ?? 0);
    if (Number.isFinite(totalPoint) && totalPoint > 0 && overOdds > 1 && underOdds > 1) {
      rows.push({
        source: "betonline",
        sport: sportTag ?? null,
        match: `${home} vs ${away}`,
        homeName: home,
        awayName: away,
        homeOdds: overOdds,
        awayOdds: underOdds,
        homeOutcomeLabel: `Över ${totalPoint.toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
        awayOutcomeLabel: `Under ${totalPoint.toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
        marketType: "total",
        line: totalPoint,
        marketLabel: `Total ${totalPoint.toLocaleString("sv-SE", { maximumFractionDigits: 2 })}`,
        raw: `${away} @ ${home} total ${totalPoint}`,
      });
    }

    return rows.map((row) => ({
      ...row,
      ...(Number.isFinite(startTime) ? { startTime } : {}),
      ...(league ? { league } : {}),
    }));
  });
}

// Bred lista över ligor som BetOnline brukar erbjuda.
// Ligor som inte finns just nu returnerar tomt och hoppas tyst över.
const BETONLINE_LEAGUES = [
  // Soccer - Topp-Europa
  { sport: "soccer", league: "premier_league" },
  { sport: "soccer", league: "championship" },
  { sport: "soccer", league: "league_one" },
  { sport: "soccer", league: "league_two" },
  { sport: "soccer", league: "fa_cup" },
  { sport: "soccer", league: "efl_cup" },
  { sport: "soccer", league: "la_liga" },
  { sport: "soccer", league: "la_liga_2" },
  { sport: "soccer", league: "copa_del_rey" },
  { sport: "soccer", league: "serie_a" },
  { sport: "soccer", league: "serie_b" },
  { sport: "soccer", league: "coppa_italia" },
  { sport: "soccer", league: "bundesliga" },
  { sport: "soccer", league: "bundesliga_2" },
  { sport: "soccer", league: "dfb_pokal" },
  { sport: "soccer", league: "ligue_1" },
  { sport: "soccer", league: "ligue_2" },
  { sport: "soccer", league: "coupe_de_france" },
  { sport: "soccer", league: "eredivisie" },
  { sport: "soccer", league: "primeira_liga" },
  { sport: "soccer", league: "scottish_premiership" },
  { sport: "soccer", league: "belgian_pro_league" },
  { sport: "soccer", league: "swiss_super_league" },
  { sport: "soccer", league: "austrian_bundesliga" },
  { sport: "soccer", league: "danish_superliga" },
  { sport: "soccer", league: "norwegian_eliteserien" },
  { sport: "soccer", league: "swedish_allsvenskan" },
  { sport: "soccer", league: "allsvenskan" },
  { sport: "soccer", league: "finnish_veikkausliiga" },
  { sport: "soccer", league: "polish_ekstraklasa" },
  { sport: "soccer", league: "czech_first_league" },
  { sport: "soccer", league: "russian_premier_league" },
  { sport: "soccer", league: "ukrainian_premier_league" },
  { sport: "soccer", league: "turkish_super_lig" },
  { sport: "soccer", league: "greek_super_league" },
  { sport: "soccer", league: "romanian_liga_i" },
  { sport: "soccer", league: "bulgarian_first_league" },
  { sport: "soccer", league: "hungarian_nb_i" },
  { sport: "soccer", league: "irish_premier_division" },
  // Soccer - UEFA-cup
  { sport: "soccer", league: "champions_league" },
  { sport: "soccer", league: "europa_league" },
  { sport: "soccer", league: "conference_league" },
  { sport: "soccer", league: "europa_conference_league" },
  { sport: "soccer", league: "uefa_nations_league" },
  { sport: "soccer", league: "uefa_super_cup" },
  // Soccer - Nord/Sydamerika
  { sport: "soccer", league: "mls" },
  { sport: "soccer", league: "us_open_cup" },
  { sport: "soccer", league: "concacaf_champions_league" },
  { sport: "soccer", league: "liga_mx" },
  { sport: "soccer", league: "liga_mx_apertura" },
  { sport: "soccer", league: "liga_mx_clausura" },
  { sport: "soccer", league: "brazilian_serie_a" },
  { sport: "soccer", league: "brasileirao" },
  { sport: "soccer", league: "brazilian_serie_b" },
  { sport: "soccer", league: "argentine_primera" },
  { sport: "soccer", league: "argentine_primera_division" },
  { sport: "soccer", league: "copa_libertadores" },
  { sport: "soccer", league: "copa_sudamericana" },
  { sport: "soccer", league: "colombian_primera_a" },
  { sport: "soccer", league: "chilean_primera" },
  { sport: "soccer", league: "ecuadorian_primera_a" },
  { sport: "soccer", league: "peruvian_primera" },
  { sport: "soccer", league: "uruguayan_primera" },
  { sport: "soccer", league: "paraguayan_primera" },
  // Soccer - Asien/Oceanien/Övrigt
  { sport: "soccer", league: "saudi_pro_league" },
  { sport: "soccer", league: "uae_pro_league" },
  { sport: "soccer", league: "qatari_stars_league" },
  { sport: "soccer", league: "chinese_super_league" },
  { sport: "soccer", league: "j_league_1" },
  { sport: "soccer", league: "j_league_2" },
  { sport: "soccer", league: "k_league_1" },
  { sport: "soccer", league: "a_league" },
  { sport: "soccer", league: "international_friendlies" },
  { sport: "soccer", league: "world_cup" },
  { sport: "soccer", league: "world_cup_qualifying" },
  { sport: "soccer", league: "european_championship" },
  { sport: "soccer", league: "copa_america" },
  { sport: "soccer", league: "africa_cup_of_nations" },
  { sport: "soccer", league: "club_world_cup" },
  // Basket
  { sport: "basketball", league: "nba" },
  { sport: "basketball", league: "nba_preseason" },
  { sport: "basketball", league: "nba_summer_league" },
  { sport: "basketball", league: "wnba" },
  { sport: "basketball", league: "ncaa_basketball" },
  { sport: "basketball", league: "ncaa_mens_basketball" },
  { sport: "basketball", league: "ncaa_womens_basketball" },
  { sport: "basketball", league: "ncaa_tournament" },
  { sport: "basketball", league: "g_league" },
  { sport: "basketball", league: "euroleague" },
  { sport: "basketball", league: "eurocup" },
  { sport: "basketball", league: "spanish_acb" },
  { sport: "basketball", league: "italian_lba" },
  { sport: "basketball", league: "german_bbl" },
  { sport: "basketball", league: "french_lnb" },
  { sport: "basketball", league: "turkish_tbsl" },
  { sport: "basketball", league: "greek_basketball_a1" },
  { sport: "basketball", league: "chinese_cba" },
  { sport: "basketball", league: "nbl_australia" },
  { sport: "basketball", league: "argentine_lnb" },
  { sport: "basketball", league: "brazilian_nbb" },
  // Hockey
  { sport: "ice_hockey", league: "nhl" },
  { sport: "ice_hockey", league: "nhl_preseason" },
  { sport: "ice_hockey", league: "ncaa_hockey" },
  { sport: "ice_hockey", league: "ahl" },
  { sport: "ice_hockey", league: "khl" },
  { sport: "ice_hockey", league: "shl" },
  { sport: "ice_hockey", league: "shl_sweden" },
  { sport: "ice_hockey", league: "hockey_allsvenskan" },
  { sport: "ice_hockey", league: "liiga_finland" },
  { sport: "ice_hockey", league: "czech_extraliga" },
  { sport: "ice_hockey", league: "slovak_extraliga" },
  { sport: "ice_hockey", league: "swiss_national_league" },
  { sport: "ice_hockey", league: "german_del" },
  { sport: "ice_hockey", league: "world_championship_hockey" },
  // Baseball
  { sport: "baseball", league: "mlb" },
  { sport: "baseball", league: "mlb_preseason" },
  { sport: "baseball", league: "minor_league_baseball" },
  { sport: "baseball", league: "ncaa_baseball" },
  { sport: "baseball", league: "npb_japan" },
  { sport: "baseball", league: "kbo_korea" },
  { sport: "baseball", league: "lmb_mexican" },
  { sport: "baseball", league: "venezuelan_winter_league" },
  { sport: "baseball", league: "dominican_winter_league" },
  { sport: "baseball", league: "world_baseball_classic" },
  // American football
  { sport: "football", league: "nfl" },
  { sport: "football", league: "nfl_preseason" },
  { sport: "football", league: "ncaa_football" },
  { sport: "football", league: "cfl" },
  { sport: "football", league: "xfl" },
  { sport: "football", league: "usfl" },
  { sport: "football", league: "arena_football" },
  // Tennis
  { sport: "tennis", league: "atp" },
  { sport: "tennis", league: "wta" },
  { sport: "tennis", league: "atp_singles" },
  { sport: "tennis", league: "wta_singles" },
  { sport: "tennis", league: "atp_doubles" },
  { sport: "tennis", league: "wta_doubles" },
  { sport: "tennis", league: "atp_finals" },
  { sport: "tennis", league: "wta_finals" },
  { sport: "tennis", league: "atp_madrid" },
  { sport: "tennis", league: "wta_madrid" },
  { sport: "tennis", league: "atp_rome" },
  { sport: "tennis", league: "wta_rome" },
  { sport: "tennis", league: "atp_french_open" },
  { sport: "tennis", league: "wta_french_open" },
  { sport: "tennis", league: "atp_wimbledon" },
  { sport: "tennis", league: "wta_wimbledon" },
  { sport: "tennis", league: "atp_us_open" },
  { sport: "tennis", league: "wta_us_open" },
  { sport: "tennis", league: "atp_australian_open" },
  { sport: "tennis", league: "wta_australian_open" },
  { sport: "tennis", league: "challenger_tour" },
  { sport: "tennis", league: "itf" },
  { sport: "tennis", league: "davis_cup" },
  { sport: "tennis", league: "billie_jean_king_cup" },
  // MMA / Boxing
  { sport: "mma", league: "ufc" },
  { sport: "mma", league: "bellator" },
  { sport: "mma", league: "pfl" },
  { sport: "mma", league: "one_championship" },
  { sport: "boxing", league: "boxing" },
  // Övrigt populärt
  { sport: "rugby", league: "rugby_union" },
  { sport: "rugby", league: "rugby_league" },
  { sport: "rugby", league: "six_nations" },
  { sport: "rugby", league: "super_rugby" },
  { sport: "rugby", league: "premiership_rugby" },
  { sport: "rugby", league: "top_14" },
  { sport: "rugby", league: "nrl" },
  { sport: "cricket", league: "ipl" },
  { sport: "cricket", league: "t20" },
  { sport: "cricket", league: "test" },
  { sport: "cricket", league: "odi" },
  { sport: "cricket", league: "big_bash" },
  { sport: "cricket", league: "psl" },
  { sport: "handball", league: "ehf_champions_league" },
  { sport: "handball", league: "german_handball_bundesliga" },
  { sport: "volleyball", league: "fivb_world_league" },
  { sport: "volleyball", league: "italian_serie_a1" },
  { sport: "volleyball", league: "polish_plus_liga" },
  { sport: "table_tennis", league: "ittf" },
  { sport: "snooker", league: "world_snooker" },
  { sport: "darts", league: "pdc" },
];

async function fetchBetOnlineLeagueRows(page, sport, league) {
  const result = await page.evaluate(
    async ({ sport, league }) => {
      try {
        const response = await fetch(
          "https://api-offering.betonline.ag/api/offering/Sports/offering-by-league",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              gsetting: "bolsassite",
              "utc-offset": "-120",
            },
            body: JSON.stringify({ Sport: sport, League: league, ScheduleText: null, filterTime: 0 }),
          },
        );
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    },
    { sport, league },
  );

  if (result && process.env.STAKE_BETONLINE_DEBUG_DUMP === "1") {
    try {
      const debugFile = path.join(CACHE_DIR, `debug-betonline-${sport}-${league}.json`);
      const sample = result?.GameOffering?.GamesDescription?.slice?.(0, 3) ?? result;
      fs.writeFileSync(debugFile, JSON.stringify(sample, null, 2), "utf-8");
      console.log(`[stake-betonline-worker] Dump: ${debugFile}`);
    } catch (error) {
      console.warn("[stake-betonline-worker] Debug dump failed:", error?.message ?? error);
    }
  }
  return result;
}

async function fetchBetOnlineBySport(page, sport) {
  // Försök bulk-endpoint som vissa BetOnline-fronter använder; returnerar alla aktiva ligor.
  return await page.evaluate(
    async ({ sport }) => {
      const candidates = [
        ["POST", "/api/offering/Sports/offering-by-sport", { Sport: sport, filterTime: 0 }],
        ["POST", "/api/offering/Sports/get-offering-by-sport", { Sport: sport, filterTime: 0 }],
        ["POST", "/api/offering/Sports/Schedule", { Sport: sport, filterTime: 0 }],
      ];
      for (const [method, p, body] of candidates) {
        try {
          const r = await fetch("https://api-offering.betonline.ag" + p, {
            method,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              gsetting: "bolsassite",
              "utc-offset": "-120",
            },
            body: JSON.stringify(body),
          });
          if (!r.ok) continue;
          return { endpoint: p, data: await r.json() };
        } catch {
          // försök nästa
        }
      }
      return null;
    },
    { sport },
  );
}

async function fetchBetOnlineSportLeagueList(page, sport) {
  return await page.evaluate(
    async ({ sport }) => {
      const candidates = [
        ["POST", "/api/offering/Sports/get-leagues-by-sport", { Sport: sport }],
        ["GET", `/api/offering/Sports/leagues?sport=${encodeURIComponent(sport)}`, null],
        ["POST", "/api/offering/Sports/leagues-by-sport", { Sport: sport }],
        ["POST", "/api/offering/Sports/get-tree", { Sport: sport }],
      ];
      for (const [method, p, body] of candidates) {
        try {
          const r = await fetch("https://api-offering.betonline.ag" + p, {
            method,
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              gsetting: "bolsassite",
              "utc-offset": "-120",
            },
            body: body ? JSON.stringify(body) : undefined,
          });
          if (!r.ok) continue;
          return { endpoint: p, data: await r.json() };
        } catch {
          // försök nästa
        }
      }
      return null;
    },
    { sport },
  );
}

function parseBetOnlineSportPayload(payload, sportTag) {
  // payload kan ha olika struktur beroende på endpoint. Vi gräver oss ner till GameOffering.GamesDescription.
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (Array.isArray(node.GamesDescription)) {
      out.push(...parseBetOnlineOffering({ GameOffering: { GamesDescription: node.GamesDescription } }, sportTag));
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(payload);
  return out;
}

function mergeBetOnlineRows(current, next) {
  if (!current) return next;
  return {
    ...current,
    ...next,
    homeOdds: Math.max(Number(current.homeOdds ?? 0), Number(next.homeOdds ?? 0)),
    awayOdds: Math.max(Number(current.awayOdds ?? 0), Number(next.awayOdds ?? 0)),
    drawOdds: Math.max(Number(current.drawOdds ?? 0), Number(next.drawOdds ?? 0)) || undefined,
    raw: [current.raw, next.raw].filter(Boolean).join(" | "),
  };
}

function normalizeBetOnlineLeague(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z0-9_]{2,80}$/.test(normalized)) return null;
  if (
    [
      "all",
      "live",
      "today",
      "tomorrow",
      "sport",
      "sports",
      "league",
      "leagues",
      "event",
      "events",
      "betonline",
    ].includes(normalized)
  ) {
    return null;
  }
  return normalized;
}

function extractBetOnlineLeagues(payload) {
  const leagues = new Set();
  const visit = (node, parentKey = "") => {
    if (typeof node === "string") {
      if (/league|competition|tournament|category|slug|url|path/i.test(parentKey)) {
        const urlPieces = node.split(/[/?#]/).filter(Boolean);
        for (const candidate of [node, ...urlPieces]) {
          const league = normalizeBetOnlineLeague(candidate);
          if (league) leagues.add(league);
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parentKey);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const lowerKey = key.toLowerCase();
      if (typeof value === "string") {
        if (/league|competition|tournament|category|slug|url|path/i.test(lowerKey) || /league/i.test(parentKey)) {
          const urlPieces = value.split(/[/?#]/).filter(Boolean);
          const candidates = [value, ...urlPieces];
          for (const candidate of candidates) {
            const league = normalizeBetOnlineLeague(candidate);
            if (league) leagues.add(league);
          }
        }
      } else {
        visit(value, key);
      }
    }
  };

  visit(payload);
  return [...leagues];
}

async function discoverBetOnlineLeagueEntries(page, sports) {
  const discovered = [];
  await mapLimit(sports, 3, async (sport) => {
    try {
      const result = await fetchBetOnlineSportLeagueList(page, sport);
      if (!result?.data) return;
      const leagues = extractBetOnlineLeagues(result.data);
      for (const league of leagues) discovered.push({ sport, league });
      if (leagues.length > 0) {
        console.log(
          `[stake-betonline-worker] BetOnline ${sport}: upptäckte ${leagues.length} ligor via ${result.endpoint}`,
        );
      }
    } catch (error) {
      console.warn(`[stake-betonline-worker] BetOnline league discovery ${sport} failed:`, error?.message ?? error);
    }
  });
  return discovered;
}

async function readPageTextRows(page) {
  await page.waitForTimeout(4_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const linkTexts = await page
    .locator("a")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
    )
    .catch(() => []);
  const buttonTexts = await page
    .locator("button")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
    )
    .catch(() => []);
  const bodyLines = ((await page.locator("body").textContent().catch(() => "")) || "")
    .split(/(?=Today|Tomorrow|Mon,|Tue,|Wed,|Thu,|Fri,|Sat,|Sun,|\n)/i)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...linkTexts, ...buttonTexts, ...bodyLines];
}

async function ensureBetOnlinePage(context, targetUrl = BETONLINE_URL) {
  const existing = context
    .pages()
    .find((page) => page.url().startsWith("https://www.betonline.ag/"));
  const page = existing ?? (await context.newPage());
  if (!existing || !page.url().startsWith(targetUrl.replace(/\/$/, ""))) {
    console.log(`[stake-betonline-worker] Öppnar ${targetUrl}...`);
    await page
      .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((error) => {
        console.warn(`[stake-betonline-worker] Navigeringsfel: ${error?.message ?? error}`);
      });
  }

  // Vänta på att Cloudflare ska släppa igenom (titel och cookies).
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await page.waitForTimeout(2_500);
    const title = await page.title().catch(() => "");
    const cookies = await context.cookies("https://www.betonline.ag").catch(() => []);
    const hasClearance = cookies.some((cookie) => cookie.name === "cf_clearance" || cookie.name === "__cf_bm");
    if (
      hasClearance &&
      !/just a moment|attention required|cloudflare|welcome to sportsbook/i.test(title)
    ) {
      console.log(
        `[stake-betonline-worker] BetOnline-sidan klar (titel: "${title}", cookies: ${cookies.length}).`,
      );
      break;
    }
    if (attempt === 0) {
      console.log(
        "[stake-betonline-worker] Väntar på Cloudflare/sidladdning (lös ev. captcha i fönstret)...",
      );
    }
  }
  // Lite mänsklig aktivitet hjälper React/Cloudflare att slutföra hydration
  await page.evaluate(() => window.scrollBy(0, 250)).catch(() => undefined);
  await page.waitForTimeout(1500);
  return page;
}

const BETONLINE_SPORT_PAGE_PATHS = {
  basketball: "https://www.betonline.ag/sportsbook/basketball",
  soccer: "https://www.betonline.ag/sportsbook/soccer",
  baseball: "https://www.betonline.ag/sportsbook/baseball",
  ice_hockey: "https://www.betonline.ag/sportsbook/hockey",
  football: "https://www.betonline.ag/sportsbook/football",
  tennis: "https://www.betonline.ag/sportsbook/tennis",
  mma: "https://www.betonline.ag/sportsbook/martial-arts",
  boxing: "https://www.betonline.ag/sportsbook/boxing",
  rugby: "https://www.betonline.ag/sportsbook/rugby",
  cricket: "https://www.betonline.ag/sportsbook/cricket",
  handball: "https://www.betonline.ag/sportsbook/handball",
  volleyball: "https://www.betonline.ag/sportsbook/volleyball",
  table_tennis: "https://www.betonline.ag/sportsbook/table-tennis",
  snooker: "https://www.betonline.ag/sportsbook/snooker",
  darts: "https://www.betonline.ag/sportsbook/darts",
};

async function navigateToSportPage(context, sport) {
  const target = BETONLINE_SPORT_PAGE_PATHS[sport];
  if (!target) return null;
  const page = await ensureBetOnlinePage(context, target);
  return page;
}

async function scrapeBetOnlineRows(context) {
  const aggregated = new Map();
  const addRow = (row) => {
    const matchKey = normalizeMatchName(row.match);
    if (!matchKey) return;
    const key = [
      matchKey,
      row.marketType ?? "moneyline",
      row.line ?? "",
      row.homeLine ?? "",
      row.awayLine ?? "",
      row.drawOdds ? "1x2" : "2way",
    ].join("|");
    aggregated.set(key, mergeBetOnlineRows(aggregated.get(key), row));
  };

  // En sida räcker för att passera Cloudflare och kalla alla sport/league-endpoints.
  const page = await ensureBetOnlinePage(context, BETONLINE_URL);
  const uniqueSports = [...new Set(BETONLINE_LEAGUES.map((l) => l.sport))];

  // 1) Bulk per sport (allt som finns för en sport på en gång).
  await mapLimit(uniqueSports, 4, async (sport) => {
    try {
      const result = await fetchBetOnlineBySport(page, sport);
      if (result?.data) {
        const stakeSport = BETONLINE_SPORT_TO_STAKE[sport] ?? null;
        const rows = parseBetOnlineSportPayload(result.data, stakeSport);
        for (const row of rows) addRow(row);
        if (rows.length > 0) {
          console.log(
            `[stake-betonline-worker] BetOnline ${sport} (bulk via ${result.endpoint}): ${rows.length} rows`,
          );
        }
      }
    } catch (error) {
      console.warn(`[stake-betonline-worker] BetOnline bulk ${sport} failed:`, error?.message ?? error);
    }
  });

  // 2) Hitta dynamiska ligor och slå ihop med vår fallback-lista.
  const discoveredLeagues = await discoverBetOnlineLeagueEntries(page, uniqueSports);
  const leagueMap = new Map();
  for (const entry of [...BETONLINE_LEAGUES, ...discoveredLeagues]) {
    leagueMap.set(`${entry.sport}:${entry.league}`, entry);
  }
  const leagueEntries = [...leagueMap.values()];
  if (discoveredLeagues.length > 0) {
    console.log(
      `[stake-betonline-worker] BetOnline använder ${leagueEntries.length} ligor (${discoveredLeagues.length} upptäckta kandidater).`,
    );
  }

  // 3) Per-liga (parallell, max 6 i taget).
  const beforePerLeague = aggregated.size;
  await mapLimit(leagueEntries, 6, async ({ sport, league }) => {
    try {
      const data = await fetchBetOnlineLeagueRows(page, sport, league);
      if (data) {
        const stakeSport = BETONLINE_SPORT_TO_STAKE[sport] ?? null;
        const rows = parseBetOnlineOffering(data, stakeSport, league);
        for (const row of rows) addRow(row);
      }
    } catch {
      // tysta fel - många ligor finns inte just nu
    }
  });
  if (aggregated.size > beforePerLeague) {
    console.log(
      `[stake-betonline-worker] BetOnline per-liga lade till ${aggregated.size - beforePerLeague} rader (totalt ${aggregated.size}).`,
    );
  }

  // 4) Sista fallback: synlig text från sidan.
  if (aggregated.size === 0) {
    try {
      const lines = await readPageTextRows(page);
      for (const row of parseBetOnlineRenderedText(lines)) addRow(row);
    } catch (error) {
      console.warn("[stake-betonline-worker] BetOnline visible-text fallback failed:", error?.message ?? error);
    }
  }

  return [...aggregated.values()];
}

function buildOpportunities(stakeRows, betOnlineRows) {
  const opportunities = [];
  const baseStake = 1000;
  for (const stakeRow of stakeRows) {
    const ranked = betOnlineRows
      .filter((row) => {
        // Veto: blockera bara när tid eller liga **säger emot** varandra. Saknad data = ingen blockering.
        if (startTimeConflict(stakeRow.startTime, row.startTime)) return false;
        if (leagueLooksDifferent(stakeRow.tournament, row.league)) return false;
        return true;
      })
      .map((row) => ({ row, score: matchSimilarity(stakeRow.match, row.match) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < 0.4) continue;
    const betOnlineRow = best.row;
    const combos = [
      {
        stakeSide: "home",
        stakeOdds: stakeRow.homeOdds,
        betOnlineSide: "away",
        betOnlineOdds: betOnlineRow.awayOdds,
      },
      {
        stakeSide: "away",
        stakeOdds: stakeRow.awayOdds,
        betOnlineSide: "home",
        betOnlineOdds: betOnlineRow.homeOdds,
      },
    ];
    for (const combo of combos) {
      if (!(combo.stakeOdds && combo.betOnlineOdds)) continue;
      const betOnlineStake = (baseStake * combo.stakeOdds) / combo.betOnlineOdds;
      const totalStake = baseStake + betOnlineStake;
      const payout = baseStake * combo.stakeOdds;
      const profit = payout - totalStake;
      opportunities.push({
        match: stakeRow.match,
        sport: stakeRow.sport,
        startTime: stakeRow.startTime,
        tournament: stakeRow.tournament,
        stakeMatch: stakeRow.match,
        betOnlineMatch: betOnlineRow.match,
        stakeSide: combo.stakeSide,
        stakeOdds: combo.stakeOdds,
        betOnlineSide: combo.betOnlineSide,
        betOnlineOdds: combo.betOnlineOdds,
        stakeStake: baseStake,
        betOnlineStake,
        totalStake,
        payout,
        profit,
        edgePct: (profit / totalStake) * 100,
      });
    }
  }
  return opportunities.sort((a, b) => b.edgePct - a.edgePct).slice(0, 50);
}

// ---------------------------------------------------------------------------
// Pinnacle via headless Chromium
// ---------------------------------------------------------------------------
// Pinnacles guest-API (guest.api.arcadia.pinnacle.com) skyddas av Cloudflare som
// blockerar Render/datacenter-IP:n med HTTP 403. Lösningen: ladda pinnacle.com
// först, vänta in cf_clearance-cookien, och gör sedan fetch-anrop *från sidans
// kontext* med page.evaluate(). Då passerar request:en som vanlig browser-trafik.

const PINNACLE_RAW_CACHE_FILE = path.join(CACHE_DIR, "pinnacle-rows.json");
const PINNACLE_API_BASE = "https://guest.api.arcadia.pinnacle.com";
const PINNACLE_SITE_URL = "https://www.pinnacle.com";
const PINNACLE_SPORT_IDS = [
  { id: 29, tag: "soccer" },
  { id: 4, tag: "basketball" },
  { id: 33, tag: "tennis" },
  { id: 19, tag: "ice-hockey" },
  { id: 15, tag: "american-football" },
  { id: 3, tag: "baseball" },
  { id: 22, tag: "mma" },
  { id: 6, tag: "boxing" },
];

async function ensurePinnaclePageReady(context) {
  let page = context.pages().find((p) => p.url().startsWith(PINNACLE_SITE_URL));
  let navigationError = null;
  if (!page) {
    page = await context.newPage();
    console.log(`[stake-betonline-worker] Pinnacle: öppnar ${PINNACLE_SITE_URL}...`);
    await page
      .goto(PINNACLE_SITE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch((error) => {
        navigationError = error?.message ?? String(error);
        console.warn(`[stake-betonline-worker] Pinnacle navigeringsfel: ${navigationError}`);
      });
  }

  let lastTitle = "";
  let lastCookieCount = 0;
  let hasClearance = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await page.waitForTimeout(2_000);
    lastTitle = await page.title().catch(() => "");
    const cookies = await context.cookies(PINNACLE_SITE_URL).catch(() => []);
    lastCookieCount = cookies.length;
    hasClearance = cookies.some(
      (cookie) => cookie.name === "cf_clearance" || cookie.name === "__cf_bm",
    );
    if (hasClearance && !/just a moment|attention required|cloudflare/i.test(lastTitle)) {
      console.log(
        `[stake-betonline-worker] Pinnacle redo (titel: "${lastTitle}", cookies: ${lastCookieCount}).`,
      );
      return { page, status: { hasClearance: true, title: lastTitle, cookieCount: lastCookieCount, navigationError } };
    }
    if (attempt === 0) {
      console.log("[stake-betonline-worker] Pinnacle: väntar på Cloudflare clearance...");
    }
  }
  console.warn(
    `[stake-betonline-worker] Pinnacle: cf_clearance saknas efter timeout (titel="${lastTitle}", cookies=${lastCookieCount}).`,
  );
  return { page, status: { hasClearance, title: lastTitle, cookieCount: lastCookieCount, navigationError } };
}

async function fetchPinnacleSportRaw(context, sportId) {
  // context.request gör server-side fetch som ärver browserns cookies + UA + TLS-stack
  // (utan CORS-spärr som blockerar window.fetch i sidans kontext mot annan origin).
  const baseHeaders = {
    accept: "application/json",
    "x-api-key": "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R",
    origin: "https://www.pinnacle.com",
    referer: "https://www.pinnacle.com/",
  };
  const fetchPath = async (path) => {
    try {
      const r = await context.request.get(`${PINNACLE_API_BASE}${path}`, {
        headers: baseHeaders,
        timeout: 25_000,
      });
      const status = r.status();
      if (status < 200 || status >= 300) return { ok: false, status };
      const data = await r.json();
      return { ok: true, status, data };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };
  const [matchupsRes, marketsRes] = await Promise.all([
    fetchPath(`/0.1/sports/${sportId}/matchups`),
    fetchPath(`/0.1/sports/${sportId}/markets/straight`),
  ]);
  return {
    matchupsOk: matchupsRes.ok,
    marketsOk: marketsRes.ok,
    matchups: matchupsRes.ok ? matchupsRes.data : null,
    markets: marketsRes.ok ? marketsRes.data : null,
    matchupsStatus: matchupsRes.status ?? null,
    marketsStatus: marketsRes.status ?? null,
  };
}

async function scrapePinnacleViaBrowser(context) {
  const ready = await ensurePinnaclePageReady(context);
  const bySport = {};
  let totalMatchups = 0;
  let totalMarkets = 0;
  let okSports = 0;

  for (const sport of PINNACLE_SPORT_IDS) {
    try {
      const result = await fetchPinnacleSportRaw(context, sport.id);
      const matchupsCount = Array.isArray(result.matchups) ? result.matchups.length : 0;
      const marketsCount = Array.isArray(result.markets) ? result.markets.length : 0;
      bySport[sport.tag] = {
        sportId: sport.id,
        ok: result.matchupsOk && result.marketsOk,
        matchupsStatus: result.matchupsStatus,
        marketsStatus: result.marketsStatus,
        matchups: result.matchups ?? [],
        markets: result.markets ?? [],
      };
      totalMatchups += matchupsCount;
      totalMarkets += marketsCount;
      if (result.matchupsOk && result.marketsOk) okSports += 1;
      console.log(
        `[stake-betonline-worker] Pinnacle ${sport.tag}: matchups=${matchupsCount} markets=${marketsCount}`,
      );
    } catch (error) {
      console.warn(
        `[stake-betonline-worker] Pinnacle ${sport.tag} misslyckades: ${error?.message ?? error}`,
      );
      bySport[sport.tag] = { sportId: sport.id, ok: false, matchups: [], markets: [] };
    }
  }

  return { bySport, totalMatchups, totalMarkets, okSports, pageStatus: ready.status };
}

function persistPinnacleRaw(scrapeResult, extraStatus = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Skriv alltid en payload — även vid 0 OK-sporter — så att API-diagnostiken
  // kan se senaste statusen. När okSports === 0 lagras inte rådata (matchups/markets
  // är ändå tomma), men summary + per-sport-status sparas för felsökning.
  const includeData = scrapeResult.okSports > 0;
  const payload = {
    updatedAt: new Date().toISOString(),
    ...(includeData ? { bySport: scrapeResult.bySport } : {}),
    summary: {
      totalMatchups: scrapeResult.totalMatchups,
      totalMarkets: scrapeResult.totalMarkets,
      okSports: scrapeResult.okSports,
      perSportStatus: Object.fromEntries(
        Object.entries(scrapeResult.bySport).map(([tag, entry]) => [
          tag,
          {
            ok: entry.ok,
            matchupsStatus: entry.matchupsStatus ?? null,
            marketsStatus: entry.marketsStatus ?? null,
            matchupsCount: Array.isArray(entry.matchups) ? entry.matchups.length : 0,
            marketsCount: Array.isArray(entry.markets) ? entry.markets.length : 0,
          },
        ]),
      ),
      ...extraStatus,
    },
  };
  fs.writeFileSync(PINNACLE_RAW_CACHE_FILE, JSON.stringify(payload), "utf-8");
  if (includeData) {
    console.log(
      `[stake-betonline-worker] Pinnacle cache: ${scrapeResult.totalMatchups} matchups, ${scrapeResult.totalMarkets} markets, ${scrapeResult.okSports}/${PINNACLE_SPORT_IDS.length} sporter OK.`,
    );
  } else {
    console.warn(
      "[stake-betonline-worker] Pinnacle: 0 OK-sporter — skriver bara status till disk.",
    );
  }
}

async function scrapeOnce(context) {
  // OBS: Pinnacle-fetchen är *inte* aktiv i workern längre. Cloudflare blockerar
  // Render-IP:n (HTTP 403 även med stealth) så fetchen misslyckas alltid och
  // varje försök kostar Chromium-minne — bidrog till OOM-krash på 512MB-planen.
  // Pinnacle-data hämtas nu via .github/workflows/pinnacle-fetch.yml som kör
  // på GitHub-runners och commit:ar data/pinnacle-rows.json. Funktionerna
  // scrapePinnacleViaBrowser/persistPinnacleRaw/ensurePinnaclePageReady
  // lämnas kvar för lokal användning men anropas inte här.

  const stakeStarted = Date.now();
  const stakeRows = await buildStakeRowsAllSports();
  const stakeMs = Date.now() - stakeStarted;

  const betOnlineStarted = Date.now();
  let betOnlineRows = [];
  try {
    betOnlineRows = await scrapeBetOnlineRows(context);
  } catch (error) {
    console.warn("[stake-betonline-worker] BetOnline scrape failed:", error?.message ?? error);
  }
  const betOnlineMs = Date.now() - betOnlineStarted;

  if (betOnlineRows.length === 0 && fs.existsSync(CACHE_FILE)) {
    try {
      const previous = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      if (Array.isArray(previous?.betOnlineRows) && previous.betOnlineRows.length > 0) {
        betOnlineRows = previous.betOnlineRows;
        console.warn(
          `[stake-betonline-worker] BetOnline gav 0 rader; behåller tidigare cache (${betOnlineRows.length} rader).`,
        );
      }
    } catch {
      // Om gammal cache inte kan läsas fortsätter vi med aktuell tom hämtning.
    }
  }
  if (betOnlineRows.length === 0) {
    console.warn("[stake-betonline-worker] BetOnline gav 0 rader; skriver inte över cachefilen.");
    return;
  }

  const opportunities = buildOpportunities(stakeRows, betOnlineRows);

  const payload = {
    updatedAt: new Date().toISOString(),
    betOnlineUrl: BETONLINE_URL,
    stakeRows,
    betOnlineRows,
    opportunities,
    timing: { stakeMs, betOnlineMs },
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf-8");
  console.log(
    `[stake-betonline-worker] ${payload.updatedAt} stake=${stakeRows.length} (${stakeMs}ms) betonline=${betOnlineRows.length} (${betOnlineMs}ms) opportunities=${opportunities.length}`,
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchBrowserWithRetries() {
  // playwright-extra + stealth-plugin maskerar headless-fingerprintet (navigator.webdriver,
  // chrome-objektet, plugins, languages m.m.) som Cloudflare's bot-detektion använder för
  // att blockera headless Chromium. Pinnacles WAF är strängare än BetOnlines och kräver
  // detta för att släppa igenom.
  const { chromium: chromiumExtra } = await import("playwright-extra");
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  chromiumExtra.use(StealthPlugin());
  const chromium = chromiumExtra;
  let delayMs = 5000;
  for (;;) {
    let browser;
    try {
      console.log("[stake-betonline-worker] Startar browser...");
      browser = await chromium.launch({
        headless: process.env.STAKE_BETONLINE_HEADLESS === "1",
        args: [
          // Render/Docker-liknande miljöer kräver ofta no-sandbox för att Chromium ska starta.
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "en-US",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      });
      return { browser, context };
    } catch (error) {
      if (browser) {
        await browser.close().catch(() => {});
      }
      console.error(
        `[stake-betonline-worker] browser/context misslyckades (nytt försök om ${Math.round(delayMs / 1000)}s)`,
        error,
      );
      await sleep(delayMs);
      delayMs = Math.min(Math.floor(delayMs * 1.5), 120_000);
    }
  }
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (process.env.STAKE_BETONLINE_WORKER_ENABLED === "0") {
    console.log(
      "[stake-betonline-worker] Avstängd (STAKE_BETONLINE_WORKER_ENABLED=0). Web körs utan BetOnline-scrape.",
    );
    await new Promise(() => {});
    return;
  }

  let { browser, context } = await launchBrowserWithRetries();

  console.log("[stake-betonline-worker] Browser öppnad (krävs bara för BetOnline).");
  console.log("[stake-betonline-worker] Lös Cloudflare/logga in vid behov i BetOnline-fliken.");
  console.log(`[stake-betonline-worker] Uppdaterar var ${Math.round(INTERVAL_MS / 1000)} sekunder.`);

  // MINNESLÄCKA-FIX (2026-06-15): tidigare återanvändes EN Chromium-instans i
  // timmar (en scrape var 5:e min på samma browser) → minnet växte stadigt tills
  // hela Render-instansen (delad med webben, 2 GB) fick slut på RAM och startade
  // om = "snabbt i ~10h, sen segt, sen omstart". Nu recyclas browsern med jämna
  // mellanrum (default var 12:e scrape ≈ 1h) → Chromium-minnet frigörs helt.
  const RECYCLE_EVERY = Math.max(1, Number(process.env.STAKE_BETONLINE_RECYCLE_EVERY || 12));
  let scrapeCount = 0;

  const tick = async () => {
    await scrapeOnce(context).catch((error) => console.error("[stake-betonline-worker] scrape failed", error));
    if (++scrapeCount >= RECYCLE_EVERY) {
      scrapeCount = 0;
      console.log("[stake-betonline-worker] Recyclar browser för att frigöra minne…");
      try { await browser.close(); } catch { /* best-effort */ }
      try {
        const fresh = await launchBrowserWithRetries();
        browser = fresh.browser;
        context = fresh.context;
        console.log("[stake-betonline-worker] Ny browser igång.");
      } catch (error) {
        console.error("[stake-betonline-worker] kunde inte starta om browser", error);
      }
    }
  };

  await tick();
  setInterval(() => { void tick(); }, INTERVAL_MS);
}

main().catch((error) => {
  console.error("[stake-betonline-worker] oväntat fel (processen avslutas inte — försök starta om tjänsten)", error);
});
