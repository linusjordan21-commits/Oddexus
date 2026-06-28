/**
 * Bonus Finder — analyserar oddsdata för att hitta matcher där användaren
 * kan omsätta en bonus-stake hos en specifik bookmaker med så låg
 * kvalificeringsförlust som möjligt.
 *
 * VIKTIGT — disclaimers:
 *   - Det här är ett ANALYSVERKTYG, inte ett garanterat vinstsystem.
 *   - Vinster är ALDRIG garanterade. Odds rör sig, marknader stänger,
 *     bookmaker-regler ändras.
 *   - Användaren ansvarar SJÄLV för:
 *       · att läsa och följa varje bookmakers regler/villkor
 *       · att hantera risk och stake-sizing
 *       · att kontrollera odds-freshness innan placering
 *   - Vi hjälper INTE att kringgå bookmaker-regler, limiteringar eller
 *     detection.
 *
 * Algoritm — 3-way dutching:
 *   För en soccer 1X2-match där användaren satsar S kr på outcome A hos
 *   bonus-bookmakeren (odds U_a):
 *     - Hitta bästa odds på outcome B och C hos ANDRA bookmakers (O_b, O_c)
 *     - Stake för balanserad return:
 *         S_b = S × U_a / O_b
 *         S_c = S × U_a / O_c
 *     - Total stake placed: S + S_b + S_c
 *     - Return at any winning outcome: S × U_a (balanced)
 *     - P&L: S × U_a - (S + S_b + S_c)
 *     - Loss %: -P&L / total_stake (negativt = vinst, positivt = förlust)
 *
 * Pinnacle-jämförelse:
 *   - no-vig fair odds från Pinnacle moneyline-marknad
 *   - implied probability per outcome
 *   - "edge" = (bookmaker_odds × pinnacle_fair_prob) - 1
 *     · positiv = bookmaker har högre odds än marknaden = lite värdedrag
 *     · negativ = bookmaker har sämre odds än marknaden
 */

/**
 * Två marknads-format stöds:
 *
 *   - "1X2"  — 3-vägs (fotboll, handboll, futsal): hemma/oavgjort/borta
 *   - "ML2"  — 2-vägs moneyline (tennis, hockey, basket, baseball, MMA):
 *              bara hemma/borta, ingen oavgjort
 *
 * För 2-vägs matcher lämnas `draw` undefined eller 0. Algoritmen detekterar
 * marknadstypen via `MatchData.marketType` (om satt) eller — som fallback —
 * via att alla rader saknar draw > 1.
 */
export type MarketType = "1X2" | "ML2";

export type OddsTriple = { home: number; draw?: number; away: number };

export type BookmakerOdds = {
  bookmakerId: string;
  bookmaker: string;
  home: number;
  draw?: number;
  away: number;
};

export type BonusFinderInput = {
  /** Bonus-bookmaker (måste finnas i match.oddsRows). */
  bonusBookmakerId: string;
  /** Bonus-bookmakerns visningsnamn (för fallback om bookmakerId inte hittas). */
  bonusBookmakerName?: string;
  /** Kvalificeringsstake i SEK. */
  stake: number;
  /** Lägsta accepterade odds på bonus-bet (oftast >= 1.5 för Unibet). */
  minOdds?: number;
  /** Högsta accepterade odds (valfritt, default ingen gräns). */
  maxOdds?: number;
  /** Tidsfönster — hur långt fram i tiden ska matcher hämtas? */
  hoursAhead?: number;
  /** Sport-filter (just nu bara "soccer" som datakälla finns). */
  sport?: string;
  /** Bookmakers att EXKLUDERA från hedge-poolen. */
  excludeBookmakerIds?: string[];
  /**
   * Bookmakers att BEGRÄNSA täckningen (hedge-poolen) till. Tom/odefinierad =
   * alla bookmakers är valbara som täckning (default: bästa odds per utfall).
   * Satt = ENDAST dessa bookmakers får användas som cover-ben. Med en enda vald
   * måste den bookmakern ha odds på ALLA övriga utfall för att en opportunity
   * ska kunna byggas.
   */
  includeCoverBookmakerIds?: string[];
  /** Hur många opportunities att returnera (top N efter ranking). */
  limit?: number;
  /** Min antal hedge-bookmakers krävs för en opportunity. */
  minHedgeBookmakers?: number;
};

export type Outcome = "home" | "draw" | "away";

export type HedgeLeg = {
  outcome: Outcome;
  bookmakerId: string;
  bookmaker: string;
  odds: number;
  stake: number;
  /** Return om denna leg vinner (stake × odds). */
  grossReturn: number;
};

export type PinnacleComparison = {
  pinnacleOdds: number;
  pinnacleFairOdds: number;
  pinnacleFairProb: number;
  /** (bookmaker_odds × pinnacle_fair_prob) - 1 */
  edge: number;
  /** Positiv: bonus-bookmaker har bättre odds än Pinnacle. */
  pinnacleEdgePct: number;
};

export type BonusOpportunity = {
  /** Unikt id (matchTitle:outcome) för React-keys. */
  id: string;
  matchTitle: string;
  startTs?: string;
  league?: string;
  sport: string;
  /** "1X2" eller "ML2" — UI använder för att visa/dölja Oavgjort-kolumn. */
  marketType: MarketType;
  /** Outcome som användaren satsar på hos bonus-bookmakern. */
  bonusOutcome: Outcome;
  bonusOutcomeLabel: string;
  bonusBookmaker: string;
  bonusBookmakerId: string;
  bonusOdds: number;
  bonusStake: number;
  /** Returnera vid vinst på bonus-bet (S × U_a). */
  bonusGrossReturn: number;
  /** Hedge-legs på de andra utfallen. */
  hedgeLegs: HedgeLeg[];
  /** Total stake placed (bonusStake + sum of hedge stakes). */
  totalStake: number;
  totalHedgeStake: number;
  /** Worst-case P&L över alla 3 utfall (negativt = förlust). */
  worstCasePnl: number;
  worstCasePnlPct: number;
  /**
   * "Pengar-retur": hur stor del av allt du satsat du får tillbaka i SÄMSTA
   * fall, i procent. 100% = du får tillbaka exakt allt du satsat (break-even),
   * >100% = arbitrage (du vinner mer än insatsen). Det här är måttet kunden
   * rankar på: vi vill hitta spelen där man förlorar minst / vinner allt åter.
   * moneyReturnPct = worstCasePnlPct + 100.
   */
  moneyReturnPct: number;
  /** True om ALLA täckningsben ligger på en sharp/exchange (Pinnacle/Smarkets/
   *  Betfair/Matchbook) → pengarna hamnar på en uttagbar sida. */
  coversOnSharp: boolean;
  /** Bästa-fall P&L (oftast bonusStake-utfall i 1X2). */
  bestCasePnl: number;
  /** Genomsnitt över alla 3 utfall (en proxy för "expected" — använd bara om alla 3 P&L är lika balanserade). */
  averagePnl: number;
  /** Pinnacle-jämförelse på bonus-outcome (om Pinnacle har match:n). */
  pinnacle?: PinnacleComparison;
  /** Hur många bookmakers vi jämfört mot. */
  hedgeBookmakerCount: number;
  /** Timestamp på odds (om dataset har den info). */
  oddsAgeSeconds?: number;
};

export type BonusFinderResult = {
  ok: true;
  bonusBookmakerId: string;
  bonusBookmaker: string;
  stake: number;
  matchesScanned: number;
  matchesWithBonusBookmaker: number;
  opportunitiesFound: number;
  opportunities: BonusOpportunity[];
  /** Disclaimer-text för UI. */
  disclaimer: string;
  /** Diagnostik: varför produceras (inte) opportunities. */
  diag?: {
    bonusOutcomesInRange: number;
    dutchNull: number;
    produced: number;
    coverMissing: Record<Outcome, number>;
    matchesMultiBook: number;
    avgBooksPerMatch: number;
  };
};

export const BONUS_FINDER_DISCLAIMER =
  "Detta är ett analysverktyg. Vinster är inte garanterade — odds rör sig och bookmaker-regler kan ändras. " +
  "Du ansvarar själv för att läsa bonus-villkor, kontrollera odds innan placering, och hantera risk.";

const OUTCOME_LABELS: Record<Outcome, string> = {
  home: "Hemma",
  draw: "Oavgjort",
  away: "Borta",
};

const OUTCOMES_3WAY: Outcome[] = ["home", "draw", "away"];
const OUTCOMES_2WAY: Outcome[] = ["home", "away"];

/** Sharp/exchange-sidor där täckning helst ska ligga (uttagbara, vassa odds). */
const SHARP_COVER_IDS = new Set(["pinnacle", "ps3838", "smarkets", "betfair", "matchbook"]);

/** Fysiskt rimligt tak för pengar-retur. Allt över = säkert fel-matchade odds. */
const MAX_REALISTIC_MONEY_RETURN_PCT = 120;

function outcomesForMarket(marketType: MarketType): Outcome[] {
  return marketType === "ML2" ? OUTCOMES_2WAY : OUTCOMES_3WAY;
}

/**
 * Detektera marknadstyp från en lista odds-rader. "1X2" om någon rad har
 * draw > 1, annars "ML2". Används som fallback när MatchData.marketType
 * inte är satt.
 */
function detectMarketTypeFromRows(rows: ReadonlyArray<OddsRowWithBookmaker>): MarketType {
  for (const row of rows) {
    if (row.draw != null && row.draw > 1) return "1X2";
  }
  return "ML2";
}

/**
 * Räknar dutching-hedge för antingen 2-vägs (tennis/hockey) eller 3-vägs (1X2).
 *
 * För bet på outcome A med stake S och odds U_a beräknar vi stakes på
 * resterande utfall (1 leg vid 2-vägs, 2 legs vid 3-vägs) så att total
 * return blir balanserad.
 *
 * Returnerar null om någon hedge-bookmaker saknas på något annat utfall
 * (då kan vi inte garantera coverage).
 */
export function calculateDutch(
  stake: number,
  bonusOdds: number,
  bonusOutcome: Outcome,
  bestExternalOdds: Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>>,
  marketType: MarketType = "1X2",
): { hedgeLegs: HedgeLeg[]; totalStake: number; totalHedgeStake: number; pnlPerOutcome: Record<Outcome, number> } | null {
  const outcomes = outcomesForMarket(marketType);
  // 2-vägs har ingen "draw" — guard mot felkall där någon försöker satsa på
  // draw i en ML2-marknad.
  if (marketType === "ML2" && bonusOutcome === "draw") return null;

  const bonusGross = stake * bonusOdds; // return vid vinst på bonus-bet
  const hedgeLegs: HedgeLeg[] = [];

  const otherOutcomes = outcomes.filter((o) => o !== bonusOutcome);
  for (const o of otherOutcomes) {
    const ext = bestExternalOdds[o];
    if (!ext || ext.odds <= 1) return null; // saknar hedge på något utfall
    const hedgeStake = bonusGross / ext.odds;
    hedgeLegs.push({
      outcome: o,
      bookmakerId: ext.bookmakerId,
      bookmaker: ext.bookmaker,
      odds: ext.odds,
      stake: hedgeStake,
      grossReturn: hedgeStake * ext.odds,
    });
  }

  const totalHedgeStake = hedgeLegs.reduce((s, l) => s + l.stake, 0);
  const totalStake = stake + totalHedgeStake;

  // P&L per outcome: vinst återges som "winnings only" - other stakes.
  // För ML2 lämnar vi draw=0 (faktiskt utfall kan aldrig vara draw, så det
  // påverkar inte worst-case-beräkningen).
  const pnlPerOutcome: Record<Outcome, number> = { home: 0, draw: 0, away: 0 };
  for (const winningOutcome of outcomes) {
    let totalReturn = 0;
    // Bonus-bet
    if (winningOutcome === bonusOutcome) totalReturn += stake * bonusOdds;
    // Hedge-legs
    for (const leg of hedgeLegs) {
      if (leg.outcome === winningOutcome) totalReturn += leg.grossReturn;
    }
    pnlPerOutcome[winningOutcome] = totalReturn - totalStake;
  }

  return { hedgeLegs, totalStake, totalHedgeStake, pnlPerOutcome };
}

/**
 * @deprecated Behåll bakåtkompat. Använd calculateDutch direkt.
 */
export const calculateThreeWayDutch = (
  stake: number,
  bonusOdds: number,
  bonusOutcome: Outcome,
  bestExternalOdds: Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>>,
) => calculateDutch(stake, bonusOdds, bonusOutcome, bestExternalOdds, "1X2");

/**
 * Pinnacle no-vig — beräkna fair odds genom att ta bort marknadens vig.
 * Returnerar fair probability per outcome. Stödjer både 2-vägs och 3-vägs.
 */
export function computePinnacleNoVig(odds: OddsTriple): { home: number; draw: number; away: number } | null {
  const hasDraw = odds.draw != null && odds.draw > 1;
  if (!(odds.home > 1 && odds.away > 1)) return null;
  if (hasDraw) {
    const impliedHome = 1 / odds.home;
    const impliedDraw = 1 / (odds.draw as number);
    const impliedAway = 1 / odds.away;
    const sum = impliedHome + impliedDraw + impliedAway;
    if (sum <= 0) return null;
    return { home: impliedHome / sum, draw: impliedDraw / sum, away: impliedAway / sum };
  }
  // 2-vägs (tennis/hockey moneyline): bara home + away
  const impliedHome = 1 / odds.home;
  const impliedAway = 1 / odds.away;
  const sum = impliedHome + impliedAway;
  if (sum <= 0) return null;
  return { home: impliedHome / sum, draw: 0, away: impliedAway / sum };
}

/**
 * Hitta bästa externa odds per outcome bland alla bookmaker-rader.
 * Exkluderar bonus-bookmakeren själv + ev. exkluderade ids.
 *
 * För 2-vägs marknader (ML2) skippas draw helt eftersom utfallet inte finns.
 */
export function bestExternalOddsByOutcome(
  rows: Array<OddsRowWithBookmaker>,
  excludeBookmakerIds: Set<string>,
  marketType: MarketType = "1X2",
  includeCoverBookmakerIds?: Set<string>,
): Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>> {
  const best: Partial<Record<Outcome, { bookmakerId: string; bookmaker: string; odds: number }>> = {};
  const includeDraw = marketType === "1X2";
  const hasIncludeFilter = includeCoverBookmakerIds != null && includeCoverBookmakerIds.size > 0;
  for (const row of rows) {
    if (excludeBookmakerIds.has(row.bookmakerId)) continue;
    // Cover-filter: om användaren valt specifika bookmakers att matcha mot,
    // släpp bara igenom de valda som täckning.
    if (hasIncludeFilter && !includeCoverBookmakerIds!.has(row.bookmakerId.toLowerCase())) continue;
    const candidates: Array<[Outcome, number | undefined]> = [
      ["home", row.home],
      ...(includeDraw ? [["draw", row.draw] as [Outcome, number | undefined]] : []),
      ["away", row.away],
    ];
    for (const [outcome, odds] of candidates) {
      if (odds == null || !(odds > 1)) continue;
      if (!best[outcome] || odds > best[outcome]!.odds) {
        best[outcome] = { bookmakerId: row.bookmakerId, bookmaker: row.bookmaker, odds };
      }
    }
  }
  return best;
}

export type OddsRowWithBookmaker = {
  bookmakerId: string;
  bookmaker: string;
  home: number;
  /** Saknas/0 för 2-vägs marknader (tennis, hockey, basket moneyline). */
  draw?: number;
  away: number;
};

export type MatchData = {
  title: string;
  startTs?: string;
  league?: string;
  sport?: string;
  /** "1X2" (fotboll) eller "ML2" (tennis, hockey moneyline). Default 1X2 om ej satt. */
  marketType?: MarketType;
  oddsRows: OddsRowWithBookmaker[];
  pinnacleOdds?: OddsTriple;
};

/**
 * Huvudfunktionen — räkna ut top opportunities för en given bonus-bookmaker.
 *
 * Loop:
 *   för varje match:
 *     hitta bonus-bookmakerns odds-rad
 *     för varje outcome (home/draw/away):
 *       om bookmaker har odds inom [minOdds, maxOdds]:
 *         räkna 3-way dutch med bästa externa odds på andra utfall
 *         om hedge möjlig: skapa opportunity
 *
 *   sortera efter worstCasePnl (lägst förlust först)
 *   returnera top N
 */
export function getBonusOpportunities(
  matches: MatchData[],
  input: BonusFinderInput,
): BonusFinderResult {
  const stake = Math.max(1, input.stake);
  const minOdds = input.minOdds ?? 1.5;
  const maxOdds = input.maxOdds ?? 100;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
  const minHedgeBookmakers = input.minHedgeBookmakers ?? 1;
  const excludeIds = new Set([
    input.bonusBookmakerId,
    ...(input.excludeBookmakerIds ?? []),
  ]);
  // Cover-filter (valfritt): begränsa täckningen till valda bookmakers. Tom =
  // alla. Lowercase så jämförelsen är robust mot blandad casing.
  const includeCoverIds = new Set(
    (input.includeCoverBookmakerIds ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const sportFilter = input.sport?.toLowerCase();

  let matchesWithBonusBookmaker = 0;
  const opportunities: BonusOpportunity[] = [];
  // DIAGNOSTIK: varför produceras (inte) opportunities? Surfas i resultatet.
  const diag = {
    bonusOutcomesInRange: 0, // utfall där bonus-odds passerade minOdds/maxOdds
    dutchNull: 0,            // dutch kunde inte byggas (saknade täckning)
    produced: 0,            // opportunities skapade
    coverMissing: { home: 0, draw: 0, away: 0 } as Record<Outcome, number>,
    matchesMultiBook: 0,    // matcher med >=2 distinkta bookmakers (hedge möjlig)
    booksPerMatchSum: 0,
  };

  for (const match of matches) {
    if (sportFilter && match.sport && match.sport.toLowerCase() !== sportFilter) continue;

    // Hitta bonus-bookmakerns odds-rad
    const bonusRow = match.oddsRows.find((r) => r.bookmakerId === input.bonusBookmakerId);
    if (!bonusRow) continue;
    matchesWithBonusBookmaker += 1;

    // Bestäm marknadstyp. Explicit på match vinner; annars detektera från rader.
    const marketType: MarketType = match.marketType ?? detectMarketTypeFromRows(match.oddsRows);
    const outcomes = outcomesForMarket(marketType);

    // Pinnacle no-vig om vi har det
    const pinnacleFair = match.pinnacleOdds ? computePinnacleNoVig(match.pinnacleOdds) : null;

    // Bästa externa odds per outcome (för hedge) — begränsat till valda
    // cover-bookmakers om användaren satt ett filter.
    const bestExternal = bestExternalOddsByOutcome(match.oddsRows, excludeIds, marketType, includeCoverIds);

    // Diagnostik: distinkta bookmakers på matchen (utöver bonus-bookmakern).
    const distinctBooks = new Set(match.oddsRows.map((r) => r.bookmakerId));
    diag.booksPerMatchSum += distinctBooks.size;
    if (distinctBooks.size >= 2) diag.matchesMultiBook += 1;

    for (const outcome of outcomes) {
      const bonusOdds = bonusRow[outcome];
      if (bonusOdds == null) continue;
      if (!(bonusOdds >= minOdds && bonusOdds <= maxOdds)) continue;
      diag.bonusOutcomesInRange += 1;

      // Vilka övriga utfall saknar extern täckning? (vanligaste orsaken till 0)
      for (const o of outcomes) {
        if (o === outcome) continue;
        if (!bestExternal[o] || bestExternal[o]!.odds <= 1) diag.coverMissing[o] += 1;
      }

      const dutch = calculateDutch(stake, bonusOdds, outcome, bestExternal, marketType);
      if (!dutch) { diag.dutchNull += 1; continue; }
      if (dutch.hedgeLegs.length < minHedgeBookmakers) continue;
      diag.produced += 1;

      const pnlValues = outcomes.map((o) => dutch.pnlPerOutcome[o]);
      const worstCasePnl = Math.min(...pnlValues);
      const bestCasePnl = Math.max(...pnlValues);
      const averagePnl = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;

      // SANITY-TAK: äkta dutching/arbitrage på dessa marknader ger som mest
      // ~105-110% pengar-retur. En retur långt över det är FYSISKT omöjlig med
      // korrekt riktade odds → det betyder att olika matcher matchats ihop
      // (fel täcknings-odds). Vi DÖLJER sådana helt så kunden aldrig ser falsk
      // +EV. (Kombineras med kickoff-veto i match-joinen som tar grundorsaken.)
      const moneyReturnPctCandidate = (worstCasePnl / dutch.totalStake) * 100 + 100;
      if (moneyReturnPctCandidate > MAX_REALISTIC_MONEY_RETURN_PCT) { diag.dutchNull += 1; continue; }

      // Pinnacle-jämförelse på bonus-outcome
      let pinnacleCmp: PinnacleComparison | undefined;
      if (pinnacleFair && match.pinnacleOdds) {
        const fairProb = pinnacleFair[outcome];
        const pinnacleOdds = outcome === "draw" ? (match.pinnacleOdds.draw ?? 0) : match.pinnacleOdds[outcome];
        const edge = bonusOdds * fairProb - 1;
        pinnacleCmp = {
          pinnacleOdds,
          pinnacleFairOdds: fairProb > 0 ? 1 / fairProb : 0,
          pinnacleFairProb: fairProb,
          edge,
          pinnacleEdgePct: edge * 100,
        };
      }

      const uniqueHedgeBookmakers = new Set(dutch.hedgeLegs.map((l) => l.bookmakerId));
      const worstCasePnlPct = (worstCasePnl / dutch.totalStake) * 100;
      const coversOnSharp =
        dutch.hedgeLegs.length > 0 &&
        dutch.hedgeLegs.every((l) => SHARP_COVER_IDS.has(l.bookmakerId.toLowerCase()));

      opportunities.push({
        id: `${match.title}:${outcome}`,
        matchTitle: match.title,
        startTs: match.startTs,
        league: match.league,
        sport: match.sport ?? "soccer",
        marketType,
        bonusOutcome: outcome,
        bonusOutcomeLabel: OUTCOME_LABELS[outcome],
        bonusBookmaker: bonusRow.bookmaker,
        bonusBookmakerId: bonusRow.bookmakerId,
        bonusOdds,
        bonusStake: stake,
        bonusGrossReturn: stake * bonusOdds,
        hedgeLegs: dutch.hedgeLegs,
        totalStake: dutch.totalStake,
        totalHedgeStake: dutch.totalHedgeStake,
        worstCasePnl,
        worstCasePnlPct,
        moneyReturnPct: worstCasePnlPct + 100,
        coversOnSharp,
        bestCasePnl,
        averagePnl,
        pinnacle: pinnacleCmp,
        hedgeBookmakerCount: uniqueHedgeBookmakers.size,
      });
    }
  }

  // Ranking: lägst förlust (worstCasePnl högst, alltså mindre negativt) först
  opportunities.sort((a, b) => b.worstCasePnl - a.worstCasePnl);

  return {
    ok: true,
    bonusBookmakerId: input.bonusBookmakerId,
    bonusBookmaker: input.bonusBookmakerName ?? input.bonusBookmakerId,
    stake,
    matchesScanned: matches.length,
    matchesWithBonusBookmaker,
    opportunitiesFound: opportunities.length,
    opportunities: opportunities.slice(0, limit),
    disclaimer: BONUS_FINDER_DISCLAIMER,
    diag: {
      bonusOutcomesInRange: diag.bonusOutcomesInRange,
      dutchNull: diag.dutchNull,
      produced: diag.produced,
      coverMissing: diag.coverMissing,
      matchesMultiBook: diag.matchesMultiBook,
      avgBooksPerMatch: matchesWithBonusBookmaker > 0 ? diag.booksPerMatchSum / matchesWithBonusBookmaker : 0,
    },
  };
}

/**
 * Bookmaker normalization — översätt mellan UI-slugar och interna ids.
 * Slugen kommer från URL:n (/bonus-finder?bookmaker=unibet, eller legacy
 * /bonus/unibet) och måste mappa till bookmakerId i oddsdata-cachen.
 */
export const BONUS_FINDER_BOOKMAKER_MAP: Record<string, { id: string; name: string }> = {
  unibet: { id: "unibet", name: "Unibet" },
  betsson: { id: "betsson", name: "Betsson" },
  bethard: { id: "bethard", name: "Bethard" },
  spelklubben: { id: "spelklubben", name: "Spelklubben" },
  comeon: { id: "comeon", name: "ComeOn" },
  hajper: { id: "hajper", name: "Hajper" },
  snabbare: { id: "snabbare", name: "Snabbare" },
  dbet: { id: "dbet", name: "DBET" },
  mrvegas: { id: "mrvegas", name: "MrVegas" },
  megariches: { id: "megariches", name: "MegaRiches" },
  x3000: { id: "x3000", name: "X3000" },
  goldenbull: { id: "goldenbull", name: "Golden Bull" },
  "1x2": { id: "1x2", name: "1x2" },
  speedybet: { id: "speedybet", name: "Speedybet" },
  vbet: { id: "vbet", name: "VBET" },
  // Nya bonus-finder-sajter (2026-06-26). nordicbet/betsafe = betsson-syskon (samma odds,
  // totals+AH); lucky/quick = Altenar (totals); tipwin = NSoft (totals).
  nordicbet: { id: "nordicbet", name: "NordicBet" },
  betsafe: { id: "betsafe", name: "Betsafe" },
  lucky: { id: "lucky", name: "LuckyCasino" },
  quick: { id: "quick", name: "QuickCasino" },
  tipwin: { id: "tipwin", name: "Tipwin" },
  // Nya bonus-finder-sajter (2026-06-26, omgång 2). Egen sportbok per sajt — odds-källa
  // under uppbyggnad, så finder listar dem men matchar inget förrän respektive scraper
  // matar odds. videoslots/kungaslottet = Videoslots Ltd (Betradar); svenskaspel = Oddset;
  // campobet = Soft2Bet (endast finder, ej optimizer).
  videoslots: { id: "videoslots", name: "Videoslots" },
  kungaslottet: { id: "kungaslottet", name: "Kungaslottet" },
  svenskaspel: { id: "svenskaspel", name: "Svenska Spel (Oddset)" },
  campobet: { id: "campobet", name: "CampoBet" },
  // Aliaser
  paf: { id: "1x2", name: "1x2" }, // Paf-brand → 1x2 är vanligaste
  leovegas: { id: "leovegas", name: "LeoVegas" }, // mappas till future entry
};

export function resolveBonusBookmakerSlug(slug: string): { id: string; name: string } | null {
  const key = slug.toLowerCase().trim();
  return BONUS_FINDER_BOOKMAKER_MAP[key] ?? null;
}
