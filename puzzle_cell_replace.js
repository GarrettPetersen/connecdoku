#!/usr/bin/env node
/**
 * puzzle_cell_replace.js
 * ------------------------------------------------------------------
 * Replace a specific cell in a saved puzzle, with validation.
 *
 * Validation:
 * - New word must be a valid option for (rowCategory × colCategory) under
 *   curator "unique word" constraints (not in any other 6 categories)
 * - New word must not duplicate another word already in the grid
 *
 * Behavior:
 * - By default, does NOT create backups (assumes you rely on git).
 * - Optional: pass --backup to create a timestamped .bak copy before writing.
 *
 * Usage:
 *   node puzzle_cell_replace.js --index -5 --row 3 --col 0 --word "The Rescuers Down Under"
 *
 * Optional:
 *   --file <path>   (defaults to daily_puzzles/puzzles.json)
 *   --dry-run       (validate only, do not write)
 *   --backup        (create timestamped backup before writing)
 */

"use strict";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAILY_DB_FILE = path.join(__dirname, "daily_puzzles", "puzzles.json");
const CATS_F = path.join(__dirname, "data", "categories.json");

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--index") args.index = argv[++i];
    else if (a === "--row") args.row = argv[++i];
    else if (a === "--col") args.col = argv[++i];
    else if (a === "--word") args.word = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--backup") args.backup = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else die(`Unknown arg: ${a}`);
  }
  return args;
}

function resolveIndex(n, idx) {
  if (idx < 0) return n + idx;
  return idx;
}

function uniqueOptions(categoriesJson, rCat, cCat, allCats) {
  const rowWords = new Set(categoriesJson[rCat] || []);
  const colWords = new Set(categoriesJson[cCat] || []);
  if (rowWords.size === 0) return [];
  if (colWords.size === 0) return [];

  let v = [...rowWords].filter((w) => colWords.has(w));
  for (const otherCat of allCats) {
    if (otherCat !== rCat && otherCat !== cCat) {
      const otherWords = new Set(categoriesJson[otherCat] || []);
      v = v.filter((w) => !otherWords.has(w));
    }
  }
  return v;
}

function flattenGrid(words) {
  const out = [];
  for (const row of words) for (const w of row) out.push(w);
  return out;
}

function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node puzzle_cell_replace.js --index -5 --row 3 --col 0 --word "The Rescuers Down Under" [--dry-run]`);
    process.exit(0);
  }
  if (args.index === undefined) die("--index is required");
  if (args.row === undefined) die("--row is required");
  if (args.col === undefined) die("--col is required");
  if (args.word === undefined) die("--word is required");

  const idxRaw = parseInt(String(args.index), 10);
  const row = parseInt(String(args.row), 10);
  const col = parseInt(String(args.col), 10);
  const newWord = String(args.word);
  if (!Number.isFinite(idxRaw)) die("Invalid --index");
  if (!Number.isFinite(row) || row < 0 || row > 3) die("Invalid --row (must be 0..3)");
  if (!Number.isFinite(col) || col < 0 || col > 3) die("Invalid --col (must be 0..3)");
  if (!newWord.trim()) die("Invalid --word (empty)");

  const puzzlesPath = args.file ? path.resolve(args.file) : DAILY_DB_FILE;
  if (!fs.existsSync(puzzlesPath)) die(`Puzzle file not found: ${puzzlesPath}`);
  if (!fs.existsSync(CATS_F)) die(`categories.json not found: ${CATS_F}`);

  const puzzles = JSON.parse(fs.readFileSync(puzzlesPath, "utf8"));
  if (!Array.isArray(puzzles) || puzzles.length === 0) die("No puzzles loaded");

  const idx = resolveIndex(puzzles.length, idxRaw);
  if (idx < 0 || idx >= puzzles.length) die(`Index out of range: ${idxRaw} (resolved ${idx}) for ${puzzles.length} puzzles`);

  const puzzle = puzzles[idx];
  if (!puzzle || !Array.isArray(puzzle.rows) || !Array.isArray(puzzle.cols) || !Array.isArray(puzzle.words)) {
    die(`Puzzle at index ${idx} has unexpected structure`);
  }

  const categoriesJson = JSON.parse(fs.readFileSync(CATS_F, "utf8"));
  const rCat = puzzle.rows[row];
  const cCat = puzzle.cols[col];
  const allCats = [...puzzle.rows, ...puzzle.cols];
  const currentWord = puzzle.words?.[row]?.[col];

  const opts = uniqueOptions(categoriesJson, rCat, cCat, allCats);
  const gridWords = flattenGrid(puzzle.words);
  const usedElsewhere = new Set(gridWords.filter((w, i) => i !== row * 4 + col));

  if (usedElsewhere.has(newWord)) {
    die(`New word duplicates an existing grid word: "${newWord}"`);
  }
  if (!opts.includes(newWord)) {
    const preview = opts.slice(0, 30);
    die(
      `New word is not a valid option for (${rCat} × ${cCat}) under uniqueness constraints.\n` +
        `Tried: "${newWord}"\n` +
        `Valid options count: ${opts.length}\n` +
        `First options: ${preview.join(", ")}${opts.length > preview.length ? ", …" : ""}`
    );
  }

  console.log(`Puzzle index: ${idxRaw} (resolved ${idx})`);
  console.log(`Cell: [${row}, ${col}]`);
  console.log(`Row category: ${rCat}`);
  console.log(`Col category: ${cCat}`);
  console.log(`Replace: "${currentWord}" -> "${newWord}"`);

  if (args.dryRun) {
    console.log("Dry run: not writing.");
    return;
  }

  // Optional backup before writing
  if (args.backup) {
    const backupPath = `${puzzlesPath}.bak.${timestampTag()}`;
    fs.copyFileSync(puzzlesPath, backupPath);
    console.log(`Backup written: ${backupPath}`);
  }

  puzzle.words[row][col] = newWord;
  puzzles[idx] = puzzle;
  fs.writeFileSync(puzzlesPath, JSON.stringify(puzzles, null, 2));
  console.log(`Updated: ${puzzlesPath}`);
}

main().catch((e) => die(e && e.message ? e.message : String(e)));


