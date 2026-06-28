#!/usr/bin/env node
/**
 * audit-i18n.mjs — hitta hårdkodad svensk UI-text i src/pages och src/components.
 *
 * Strategi:
 *   1. Läs varje .ts/.tsx-fil under src/pages och src/components
 *   2. Skippa src/lib/settings/i18n.ts (där svenska tillåts)
 *   3. Klipp bort comments + string-literals i import/typeof/className/key etc.
 *   4. Flagga rader som innehåller:
 *        a) Stränglitteraler med Å/Ä/Ö-tecken (svenska)
 *        b) Stränglitteraler med vanliga svenska ord (lista nedan)
 *   5. Skriv ut fil:rad text för manuell genomgång
 *
 * Tolerans (false-positive-reducering):
 *   - Comments auditeras separat och rapporteras som
 *     "comment" (warning, inte error)
 *   - Tekniska strängar (URL, locale-koder, font-mono, "kambi", "betsson"
 *     etc.) skippas via en allowlist
 *   - Strängar som bara består av ASCII-bokstäver utan svenska ord skippas
 *
 * Exit-kod alltid 0 — scriptet är en checklist, inte en gate.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src");
const SCAN_DIRS = ["pages", "components", "hooks"];
const SKIP_FILES = new Set([
  path.resolve(ROOT, "lib/settings/i18n.ts"),
]);

/**
 * Vanliga svenska UI-ord vi letar efter (case-insensitive, word-boundary).
 * Ord som lika gärna kunde vara engelska är medvetet borttagna ("kontrol"
 * existerar i båda etc.). Lägg gärna till fler ord i framtiden.
 */
const SWEDISH_WORDS = [
  "satsning", "satsa", "spela", "spel", "vinst", "förlust", "vinst om",
  "värde", "värdebet", "värdebets", "valuebets",
  "senast", "uppdatera", "uppdaterad", "uppdaterat",
  "tillbaka", "framåt",
  "inga", "ingen", "ingenting",
  "hittade", "visar", "rensa", "ta bort", "lägg till", "logga", "loggat",
  "källa", "marknad", "utfall", "tidsfönster", "tröskel", "samlar",
  "snart", "öppna", "stäng",
  "inställningar", "språk", "valuta",
  "laddar", "fel", "försök",
  "sparad", "sparat", "spara",
  "totalt", "summa", "summan",
  "pågående", "avbrutet", "annullerad", "avgjort",
  "alla", "minsta", "största",
  "timmar", "fönster", "minuter",
  "hemma", "borta", "oavgjort",
  "välj system", "välj",
  "matchar", "matchat",
  "kopiera", "kopierat",
  "manuellt", "manuell",
  "redigera", "raderas",
  "anteckningar",
  "frågor", "felmeddelande",
  "förväntad", "förväntat", "förväntade",
  "bankrulle", "enheter",
  "dataålder", "stale", // stale används också på engelska, tolereras
  "i kr", "kr)", "(kr",
];

const ALLOWLIST_SUBSTRINGS = [
  // tekniska identifierare som ofta innehåller svenska tecken / ord
  "sv-SE", "sv_SE", "locale", "BCP-47",
  // datasource-relaterade strängar
  "spelklubben", "betsson", "bethard", "comeon", "snabbare", "hajper",
  "valuebets-status", "value-bet", "valuebet",
  // CSS classes som råkar matcha
  "valuebets ", "tabular", "rounded",
];

// Exakt-matchande strängar som inte räknas som UI-text (brand names, internal codes).
const ALLOWLIST_EXACT = new Set([
  "stale", // type-union literal i ValueBets.tsx
  "Spel Klubben", // brand name (spelklubben.se) — INTE Swedish UI text
]);

const SE_CHAR = /[ÅÄÖåäö]/;

function listFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
  }
  return out;
}

function inAllowlist(str) {
  if (ALLOWLIST_EXACT.has(str)) return true;
  const lower = str.toLowerCase();
  return ALLOWLIST_SUBSTRINGS.some((s) => lower.includes(s.toLowerCase()));
}

/**
 * Bryt en rad i tre segment: kod, line-comment (efter //), string-litterals.
 * Vi gör en enkel tokenizer som inte är perfekt men räcker för UI-strängar i
 * praktiken (TSX-kod är välformad och har sällan strängar med escapad citation
 * + // inom samma string).
 */
function findStringLiterals(line) {
  const results = [];
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let start = -1;
  while (i < line.length) {
    const ch = line[i];
    const prev = line[i - 1];
    // Skip line-comment så vi inte flaggar svensk text i kommentarer
    if (!inSingle && !inDouble && !inBacktick && ch === "/" && line[i + 1] === "/") break;
    if (ch === '"' && !inSingle && !inBacktick && prev !== "\\") {
      if (inDouble) { results.push({ quote: '"', start, end: i, text: line.slice(start + 1, i) }); inDouble = false; }
      else { inDouble = true; start = i; }
    } else if (ch === "'" && !inDouble && !inBacktick && prev !== "\\") {
      if (inSingle) { results.push({ quote: "'", start, end: i, text: line.slice(start + 1, i) }); inSingle = false; }
      else { inSingle = true; start = i; }
    } else if (ch === "`" && !inSingle && !inDouble && prev !== "\\") {
      if (inBacktick) { results.push({ quote: "`", start, end: i, text: line.slice(start + 1, i) }); inBacktick = false; }
      else { inBacktick = true; start = i; }
    }
    i += 1;
  }
  return results;
}

function findJsxText(line) {
  // Enkel heuristik: text mellan > och < på samma rad, om det innehåller bokstäver
  // och INTE bara är en variabel-expression {x}.
  const out = [];
  const re = />([^<>{}]*[A-Za-zÅÄÖåäö][^<>{}]*)</g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    out.push({ start: m.index + 1, end: m.index + m[0].length - 1, text });
  }
  return out;
}

function isSwedish(text) {
  if (SE_CHAR.test(text)) return true;
  const lower = text.toLowerCase();
  for (const w of SWEDISH_WORDS) {
    // word-boundary match — undvik delsträngsfel-positives som "spelklubben"
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

function isInsideComment(content, fileOffset) {
  // Mycket grov: vi inspekterar en buffer 200 char före offset för att hitta
  // /* ... */-block-comments. Räcker oftast.
  const before = content.slice(Math.max(0, fileOffset - 600), fileOffset);
  const lastOpen = before.lastIndexOf("/*");
  const lastClose = before.lastIndexOf("*/");
  return lastOpen > lastClose;
}

function auditFile(file) {
  const rel = path.relative(process.cwd(), file);
  const text = fs.readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNumber = i + 1;
    const lineFileOffset = offset;

    // String-literals
    const literals = findStringLiterals(line);
    for (const lit of literals) {
      if (!lit.text) continue;
      if (!isSwedish(lit.text)) continue;
      if (inAllowlist(lit.text)) continue;
      const isComment = isInsideComment(text, lineFileOffset + lit.start);
      hits.push({
        file: rel,
        line: lineNumber,
        kind: isComment ? "comment-string" : "string",
        snippet: lit.text.length > 100 ? lit.text.slice(0, 100) + "…" : lit.text,
      });
    }

    // JSX-inner-text på samma rad
    const jsx = findJsxText(line);
    for (const j of jsx) {
      if (!isSwedish(j.text)) continue;
      if (inAllowlist(j.text)) continue;
      hits.push({
        file: rel,
        line: lineNumber,
        kind: "jsx-text",
        snippet: j.text.length > 100 ? j.text.slice(0, 100) + "…" : j.text,
      });
    }

    offset += line.length + 1; // +1 för \n
  }
  return hits;
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => listFiles(path.join(ROOT, d))).filter(
    (f) => !SKIP_FILES.has(path.resolve(f)),
  );
  console.log(`[audit-i18n] Scanning ${files.length} files…\n`);

  const byFile = new Map();
  let total = 0;
  for (const f of files) {
    const hits = auditFile(f);
    if (hits.length > 0) {
      byFile.set(f, hits);
      total += hits.length;
    }
  }

  if (total === 0) {
    console.log("✓ No Swedish UI-text candidates found.");
    return;
  }

  // Sortera filer på antal träffar (mest först)
  const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [file, hits] of sorted) {
    const rel = path.relative(process.cwd(), file);
    console.log(`\n── ${rel} (${hits.length})`);
    for (const h of hits) {
      const marker = h.kind === "jsx-text" ? "  [JSX]" : h.kind === "comment-string" ? "  [cmt]" : "  [str]";
      console.log(`${marker} ${h.line.toString().padStart(4)}: ${h.snippet}`);
    }
  }

  console.log(`\n[audit-i18n] Total: ${total} candidate strings across ${sorted.length} files.`);
  console.log("(Exit 0 — this is a checklist, not a gate.)");
}

main();
