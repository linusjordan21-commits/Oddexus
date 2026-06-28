/**
 * bookmakerGroups.ts — mappar systerbrands till sin PLATTFORMS-GRUPP.
 *
 * Flera sajter delar samma plattform och DÄRMED identiska odds (de hämtas ur
 * samma *-rows.json). Ett value-bet pa en sadan match ar i praktiken EN bet
 * aven om det syns pa flera systersajter. For CLV-sparning maste de raknas
 * som EN — annars blir samma bet raknad N ganger (en per systersajt).
 *
 * Anvands i dedupe-nyckeln (clvDedupe.ts): candidateBook ersatts av gruppen,
 * sa systerbrands kollapsar till ETT sample. Genuint olika plattformar (med
 * egna odds) halls isar.
 *
 * Okand bok → sin egen grupp (boknamnet sjalvt), sa inget kollapsas av misstag.
 */

const GROUP_BY_BOOK: Record<string, string> = {
  // ── ComeOn-plattform (delar comeon-rows.json, identiska odds) ──
  comeon: "comeon",
  hajper: "comeon",
  snabbare: "comeon",
  casinostugan: "comeon",
  lyllo: "comeon",
  lyllocasino: "comeon",
  reviant: "comeon",

  // ── Betsson/Playtech-grupp (delar betsson-rows.json) ──
  betsson: "betsson",
  bethard: "betsson",
  spelklubben: "betsson",
  nordicbet: "betsson",
  betsafe: "betsson",

  // ── Kambi (delar kambi-rows.json) ──
  unibet: "kambi",
  expekt: "kambi",
  leovegas: "kambi",
  "888sport": "kambi",
  mrgreen: "kambi",
  veraandjohn: "kambi",
};

/** Plattforms-grupp for en bookmaker (lowercase). Okand → boknamnet sjalvt. */
export function bookmakerGroup(book: string): string {
  const key = (book ?? "").trim().toLowerCase();
  return GROUP_BY_BOOK[key] ?? key;
}
