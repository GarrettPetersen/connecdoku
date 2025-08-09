#!/usr/bin/env node
"use strict";

import fs from "fs";
import path from "path";

// ───────── config ─────────
const DATA_DIR = "data";
const DP_DIR = "daily_puzzles";
const PUZZLES_F = path.join(DP_DIR, "puzzles.json");
const SCORES_F = path.join(DATA_DIR, "category_scores.json");

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

  const puzzles = JSON.parse(fs.readFileSync(PUZZLES_F, "utf8"));
  const startIdx = computeCurrentIndex(DEFAULT_START_DATE) + START_OFFSET_DAYS;

  console.log(`Start date: ${DEFAULT_START_DATE}`);
  console.log(`Current index: ${startIdx - START_OFFSET_DAYS}`);
  console.log(`Deleting low-quality puzzles from index ${startIdx} (${dateForIndex(startIdx, DEFAULT_START_DATE)}) onward...`);
  console.log(`Threshold: < ${DELETE_THRESHOLD} (DRY_RUN=${DRY_RUN})`);

  const toDelete = [];
  for (let i = startIdx; i < puzzles.length; i++) {
    const p = puzzles[i];
    const score = computePuzzleScore(categoryScores, p.rows, p.cols);
    if (score < DELETE_THRESHOLD) {
      toDelete.push({ index: i, date: dateForIndex(i, DEFAULT_START_DATE), score });
    }
  }

  if (toDelete.length === 0) {
    console.log("No low-quality future puzzles found.");
    return;
  }

  console.log(`Found ${toDelete.length} low-quality future puzzles to delete:`);
  for (const { index, date, score } of toDelete) {
    console.log(`  - idx ${index} (${date}) score=${score.toFixed(2)}  rows=[${puzzles[index].rows.join(", ")}]  cols=[${puzzles[index].cols.join(", ")}]`);
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

