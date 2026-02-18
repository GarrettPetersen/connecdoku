#!/usr/bin/env node
/**
 * puzzle_cell_options.js
 * ------------------------------------------------------------------
 * Show valid replacement options for a specific cell in a saved puzzle.
 *
 * Valid option definition (matches curator logic):
 * - Word must be in BOTH the row category and the column category
 * - Word must NOT be in ANY of the other 6 categories (row/col categories)
 * - Additionally for replacement, we filter out words already used elsewhere
 *   in the 4x4 grid (to preserve the "16 unique words" rule).
 *
 * Usage:
 *   node puzzle_cell_options.js --index -5 --row 3 --col 0
 *
 * Notes:
 * - row/col are 0-based indices into the 4x4 words grid
 * - index supports negatives (like Python): -1 = last puzzle
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
    else if (a === "--file") args.file = argv[++i];
    else if (a === "--json") args.json = true;
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node puzzle_cell_options.js --index -5 --row 3 --col 0 [--file daily_puzzles/puzzles.json] [--json]`);
    process.exit(0);
  }
  if (args.index === undefined) die("--index is required");
  if (args.row === undefined) die("--row is required");
  if (args.col === undefined) die("--col is required");

  const idxRaw = parseInt(String(args.index), 10);
  const row = parseInt(String(args.row), 10);
  const col = parseInt(String(args.col), 10);
  if (!Number.isFinite(idxRaw)) die("Invalid --index");
  if (!Number.isFinite(row) || row < 0 || row > 3) die("Invalid --row (must be 0..3)");
  if (!Number.isFinite(col) || col < 0 || col > 3) die("Invalid --col (must be 0..3)");

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
  const filtered = opts.filter((w) => !usedElsewhere.has(w));
  filtered.sort((a, b) => String(a).localeCompare(String(b)));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          index: idxRaw,
          resolvedIndex: idx,
          row,
          col,
          rowCategory: rCat,
          colCategory: cCat,
          currentWord,
          options: filtered,
          optionsCount: filtered.length,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Puzzle index: ${idxRaw} (resolved ${idx})`);
  console.log(`Cell: [${row}, ${col}]`);
  console.log(`Row category: ${rCat}`);
  console.log(`Col category: ${cCat}`);
  console.log(`Current word: ${currentWord ?? "(null)"}`);
  console.log("");
  console.log(`Valid replacement options (unique vs other 6 categories, and not already used in grid): ${filtered.length}`);
  filtered.forEach((w, i) => console.log(`${i}. ${w}`));
}

main().catch((e) => die(e && e.message ? e.message : String(e)));


