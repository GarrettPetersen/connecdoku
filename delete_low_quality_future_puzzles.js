#!/usr/bin/env node
"use strict";

import fs from "fs";
import path from "path";

// ───────── config ─────────
const DATA_DIR = "data";
const DP_DIR = "daily_puzzles";
const PUZZLES_F = path.join(DP_DIR, "puzzles.json");
const SCORES_F = path.join(DATA_DIR, "category_scores.json");
const CATEGORIES_F = path.join(DATA_DIR, "categories.json");

// Same epoch as check_future_puzzles.js
const DEFAULT_START_DATE = process.env.START_DATE || "2025-07-21T00:00:00";
const START_OFFSET_DAYS = Number(process.env.START_OFFSET_DAYS || 2); // two days in the future
const DELETE_THRESHOLD = Number(process.env.DELETE_QUALITY_THRESHOLD || process.env.PUZZLE_SCORE_MED || 6);
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() !== "false"; // default true

// ───────── helpers ─────────
function computeCurrentIndex(startDateStr) {
  const currentDate = new Date();
  const startDate = new Date(startDateStr);
  const daysSinceStart = Math.floor((currentDate - startDate) / (1000 * 60 * 60 * 24));
  return Math.max(0, daysSinceStart);
}

function dateForIndex(i, startDateStr) {
  const d = new Date(new Date(startDateStr).getTime() + i * 24 * 60 * 60 * 1000);
  return d.toISOString().split("T")[0];
}

function computePuzzleScore(categoryScores, rows, cols) {
  const cats = [...rows, ...cols];
  let sum = 0;
  for (const c of cats) sum += categoryScores[c] || 0;
  return Math.round(sum * 100) / 100;
}

// ───────── validation helpers ─────────
function loadCategories() {
  try {
    const categoriesJson = JSON.parse(fs.readFileSync(CATEGORIES_F, "utf8"));
    const catSet = {};
    for (const [cat, words] of Object.entries(categoriesJson)) {
      catSet[cat] = new Set(words);
    }
    return catSet;
  } catch (e) {
    console.error(`Missing or invalid categories file at ${CATEGORIES_F}`);
    process.exit(1);
  }
}

function uniqueWords(catSet, rCat, cCat, allCats) {
  // Get words that are in BOTH row and column categories
  const rowWords = catSet[rCat];
  const colWords = catSet[cCat];
  if (!rowWords || !colWords) return [];

  // Find words that appear in both categories
  let v = [...rowWords].filter(w => colWords.has(w));

  // Filter out any words that appear in ANY other category
  for (const otherCat of allCats) {
    if (otherCat !== rCat && otherCat !== cCat) {
      const otherWords = catSet[otherCat];
      if (otherWords) {
        v = v.filter(w => !otherWords.has(w));
      }
    }
  }
  return v;
}

function validatePuzzle(catSet, puzzle) {
  const allCategories = [...puzzle.rows, ...puzzle.cols];

  // Check if all categories exist in our current word list
  for (const category of allCategories) {
    if (!catSet[category]) {
      return { valid: false, reason: `Category "${category}" not found in current word list` };
    }
  }

  // Check that each cell intersection has at least one valid word  
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const unique = uniqueWords(catSet, puzzle.rows[i], puzzle.cols[j], allCategories);
      if (unique.length === 0) {
        return { valid: false, reason: `No valid word found for cell (${i},${j}): ${puzzle.rows[i]} × ${puzzle.cols[j]}` };
      }
    }
  }

  return { valid: true };
}

// ───────── main ─────────
function main() {
  if (!fs.existsSync(PUZZLES_F)) {
    console.error(`Missing puzzles file: ${PUZZLES_F}`);
    process.exit(1);
  }
  let categoryScores = {};
  try {
    categoryScores = JSON.parse(fs.readFileSync(SCORES_F, "utf8"));
  } catch (e) {
    console.error(`Missing or invalid category scores at ${SCORES_F}`);
    process.exit(1);
  }

  // Load categories for validation
  const catSet = loadCategories();
  console.log(`Loaded ${Object.keys(catSet).length} categories for validation`);

  const puzzles = JSON.parse(fs.readFileSync(PUZZLES_F, "utf8"));
  const startIdx = computeCurrentIndex(DEFAULT_START_DATE) + START_OFFSET_DAYS;

  console.log(`Start date: ${DEFAULT_START_DATE}`);
  console.log(`Current index: ${startIdx - START_OFFSET_DAYS}`);
  console.log(`Checking puzzles from index ${startIdx} (${dateForIndex(startIdx, DEFAULT_START_DATE)}) onward...`);
  console.log(`Quality threshold: < ${DELETE_THRESHOLD} (DRY_RUN=${DRY_RUN})`);

  const toDelete = [];
  let lowQualityCount = 0;
  let invalidCount = 0;

  for (let i = startIdx; i < puzzles.length; i++) {
    const p = puzzles[i];
    const date = dateForIndex(i, DEFAULT_START_DATE);

    // Check quality score
    const score = computePuzzleScore(categoryScores, p.rows, p.cols);
    const isLowQuality = score < DELETE_THRESHOLD;

    // Check validity
    const validation = validatePuzzle(catSet, p);
    const isValid = validation.valid;

    if (isLowQuality || !isValid) {
      const reason = isLowQuality ? `low quality (score=${score.toFixed(2)})` : `invalid: ${validation.reason}`;
      toDelete.push({
        index: i,
        date: date,
        score: score,
        reason: reason,
        isLowQuality: isLowQuality,
        isInvalid: !isValid
      });

      if (isLowQuality) lowQualityCount++;
      if (!isValid) invalidCount++;
    }
  }

  if (toDelete.length === 0) {
    console.log("No low-quality or invalid future puzzles found.");
    return;
  }

  console.log(`Found ${toDelete.length} puzzles to delete:`);
  console.log(`  - ${lowQualityCount} low-quality puzzles`);
  console.log(`  - ${invalidCount} invalid puzzles`);
  console.log("");

  for (const { index, date, score, reason, isLowQuality, isInvalid } of toDelete) {
    const type = isLowQuality && isInvalid ? "low-quality+invalid" :
      isLowQuality ? "low-quality" : "invalid";
    console.log(`  - idx ${index} (${date}) [${type}] ${reason}`);
    console.log(`    rows=[${puzzles[index].rows.join(", ")}]  cols=[${puzzles[index].cols.join(", ")}]`);
  }

  if (DRY_RUN) {
    console.log("DRY_RUN is true — not modifying puzzles.json. Set DRY_RUN=false to apply deletions.");
    return;
  }

  // Build filtered list by skipping marked indices
  const deleteSet = new Set(toDelete.map(x => x.index));
  const filtered = puzzles.filter((_, idx) => !deleteSet.has(idx));
  fs.writeFileSync(PUZZLES_F, JSON.stringify(filtered, null, 2));
  console.log(`Wrote updated ${PUZZLES_F}. Removed ${toDelete.length} puzzles. New length: ${filtered.length}`);
}

main();

