#!/usr/bin/env node
/**
 * Kopierar autoclicker-share.zip från ~/Downloads till private_downloads/
 * Kör: npm run copy:autoclicker-zip
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SOURCE = path.join(os.homedir(), "Downloads", "autoclicker-share.zip");
const DEST_DIR = path.resolve(process.cwd(), "private_downloads");
const DEST = path.join(DEST_DIR, "autoclicker-share.zip");

if (!fs.existsSync(SOURCE)) {
  console.error("✗ Hittade inte zippen:");
  console.error(`  ${SOURCE}`);
  console.error("");
  console.error("Bygg zip i autoclicker-projektet först (bash pack.sh),");
  console.error("eller kopiera manuellt till Downloads/autoclicker-share.zip");
  process.exit(1);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(SOURCE, DEST);

const stat = fs.statSync(DEST);
console.log("✓ Kopierade autoclicker-share.zip");
console.log(`  Från: ${SOURCE}`);
console.log(`  Till:  ${DEST}`);
console.log(`  Storlek: ${stat.size} bytes`);
