import fs from 'fs';
import path from 'path';
import { loadCategorySimilarity, puzzleCategorySimilarity } from './similarity.js';

// Read the data files
const DATA_DIR = 'data';
const DP_DIR = 'daily_puzzles';
const wordsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'words.json'), 'utf8'));
const puzzlesData = JSON.parse(fs.readFileSync(path.join(DP_DIR, 'puzzles.json'), 'utf8'));
let categoryScores = {};
try {
  categoryScores = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'category_scores.json'), 'utf8'));
} catch (e) {
  console.log('Warning: data/category_scores.json not found; all categories will score as 0');
  categoryScores = {};
}

// Function to check if a word belongs to a category
function wordInCategory(word, category) {
  if (!wordsData[word]) {
    return false;
  }
  return wordsData[word].includes(category);
}

// Compute puzzle quality score by summing category scores for its 8 categories
function computePuzzleScore(rows, cols) {
  const allCats = [...rows, ...cols];
  let sum = 0;
  for (const c of allCats) sum += categoryScores[c] || 0;
  return Math.round(sum * 100) / 100;
}

// Map score to emoji tier (defaults can be overridden via env)
const GOOD_THRESHOLD = Number(process.env.PUZZLE_SCORE_GOOD || 12);
const MEDIUM_THRESHOLD = Number(process.env.PUZZLE_SCORE_MED || 6);
function scoreEmoji(score) {
  if (score >= GOOD_THRESHOLD) return '🟢';
  if (score >= MEDIUM_THRESHOLD) return '🟡';
  return '🔴';
}

// Similarity cutoff for "too similar to past puzzles"
// - If >= 1, similarity checking is disabled.
// - Otherwise, any future puzzle with maxSimilarityToPast >= cutoff is flagged as TOO SIMILAR.
const SIM_CUTOFF_RAW = process.env.CHECK_FUTURE_SIM_CUTOFF;
const SIM_CUTOFF = Number.isFinite(Number(SIM_CUTOFF_RAW)) ? Number(SIM_CUTOFF_RAW) : 0.625;
const simDb = SIM_CUTOFF < 1 ? loadCategorySimilarity(DATA_DIR) : null;
if (SIM_CUTOFF < 1 && !simDb) {
  console.log('Warning: data/category_similarity.json not found/invalid; similarity will fall back to exact category matches only.');
}
const categorySimFn = simDb ? simDb.categorySimilarity : (a, b) => (a === b ? 1 : 0);
const SIM_ENFORCE_INVALID = process.env.CHECK_FUTURE_SIM_ENFORCE === '1';

// Get current date to identify future puzzles
const currentDate = new Date();
const startDate = new Date('2025-07-21T00:00:00'); // Actual start date from the game
const daysSinceStart = Math.floor((currentDate - startDate) / (1000 * 60 * 60 * 24));
const currentPuzzleIndex = daysSinceStart;

console.log(`Current date: ${currentDate.toISOString().split('T')[0]}`);
console.log(`Current puzzle index: ${currentPuzzleIndex}`);
console.log(`Total puzzles: ${puzzlesData.length}`);
console.log(`Similarity cutoff: ${SIM_CUTOFF >= 1 ? 'disabled' : SIM_CUTOFF} (set CHECK_FUTURE_SIM_CUTOFF=1 to disable)`);
console.log(`Similarity enforcement: ${SIM_ENFORCE_INVALID ? 'INVALID' : 'separate flag'} (set CHECK_FUTURE_SIM_ENFORCE=1 to enforce)`);
console.log('');

// Check each future puzzle
let invalidFutureCount = 0;
let tooSimilarFutureCount = 0;
for (let i = currentPuzzleIndex; i < puzzlesData.length; i++) {
  const puzzle = puzzlesData[i];
  const { rows, cols, words } = puzzle;
  const allCategories = [...rows, ...cols];

  console.log(`=== PUZZLE ${i} (Future) ===`);
  console.log(`Rows: ${rows.join(', ')}`);
  console.log(`Cols: ${cols.join(', ')}`);
  const score = computePuzzleScore(rows, cols);
  const emoji = scoreEmoji(score);
  console.log(`Quality score: ${score.toFixed(2)} ${emoji}`);

  // Similarity check vs all past puzzles (by index)
  let maxSimilarityToPast = null;
  let closestPastIdx = -1;
  if (SIM_CUTOFF < 1) {
    let bestSim = 0;
    let bestIdx = -1;
    for (let j = 0; j < i; j++) {
      const past = puzzlesData[j];
      if (!past || !Array.isArray(past.rows) || !Array.isArray(past.cols)) continue;
      const s = puzzleCategorySimilarity(puzzle, past, categorySimFn);
      if (s > bestSim) {
        bestSim = s;
        bestIdx = j;
      }
      if (bestSim >= 1) break;
    }
    maxSimilarityToPast = Math.round(bestSim * 10000) / 10000;
    closestPastIdx = bestIdx;

    // Always print the max similarity + closest puzzle index for each entry.
    console.log(`MaxSimPast: ${maxSimilarityToPast.toFixed(4)} (closest puzzle index ${closestPastIdx})`);

    if (maxSimilarityToPast >= SIM_CUTOFF) {
      console.log(`⚠️ TOO SIMILAR: maxSimPast=${maxSimilarityToPast.toFixed(4)} (closest puzzle index ${bestIdx})`);
    } else if (maxSimilarityToPast >= Math.max(0, SIM_CUTOFF - 0.05)) {
      console.log(`⚠️ High similarity: maxSimPast=${maxSimilarityToPast.toFixed(4)} (closest puzzle index ${bestIdx})`);
    }
  }

  // Soft warning if any categories or words are shared with the previous day
  if (i > 0) {
    const prev = puzzlesData[i - 1];
    if (prev) {
      const prevCategories = new Set([...(prev.rows || []), ...(prev.cols || [])]);
      const currCategories = new Set([...rows, ...cols]);
      const sharedCategories = [...currCategories].filter(c => prevCategories.has(c));

      const prevWords = new Set((prev.words || []).flat());
      const currWords = new Set((words || []).flat());
      const sharedWords = [...currWords].filter(w => prevWords.has(w));

      if (sharedCategories.length > 0) {
        console.log(`⚠️ Shares ${sharedCategories.length} categor${sharedCategories.length === 1 ? 'y' : 'ies'} with previous day: ${sharedCategories.join(', ')}`);
      }
      if (sharedWords.length > 0) {
        console.log(`⚠️ Shares ${sharedWords.length} word${sharedWords.length === 1 ? '' : 's'} with previous day: ${sharedWords.join(', ')}`);
      }
    }
  }
  console.log('');

  let hasErrors = false;
  const errors = [];
  let isTooSimilar = false;

  // Similarity is a separate concern from "INVALID" (miscategorized words),
  // unless explicitly enforced via CHECK_FUTURE_SIM_ENFORCE=1.
  if (SIM_CUTOFF < 1 && typeof maxSimilarityToPast === 'number' && maxSimilarityToPast >= SIM_CUTOFF) {
    isTooSimilar = true;
    if (SIM_ENFORCE_INVALID) {
      errors.push(`Similarity too high vs past puzzle ${closestPastIdx}: maxSimPast=${maxSimilarityToPast.toFixed(4)} (cutoff=${SIM_CUTOFF})`);
      hasErrors = true;
    }
  }

  // Check each word in the puzzle
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const word = words[row][col];
      const rowCategory = rows[row];
      const colCategory = cols[col];

      // Check if word exists in our data
      if (!wordsData[word]) {
        errors.push(`"${word}" not found in words.json`);
        hasErrors = true;
        continue;
      }

      // Check inclusion rule: word must be in both row and column categories
      if (!wordInCategory(word, rowCategory)) {
        errors.push(`"${word}" is not in row category "${rowCategory}"`);
        hasErrors = true;
      }

      if (!wordInCategory(word, colCategory)) {
        errors.push(`"${word}" is not in column category "${colCategory}"`);
        hasErrors = true;
      }

      // Check exclusion rule: word must NOT be in the other 6 categories
      const otherCategories = allCategories.filter(cat => cat !== rowCategory && cat !== colCategory);
      for (const otherCat of otherCategories) {
        if (wordInCategory(word, otherCat)) {
          errors.push(`"${word}" is in category "${otherCat}" but should only be in "${rowCategory}" and "${colCategory}"`);
          hasErrors = true;
        }
      }
    }
  }

  if (hasErrors) {
    console.log('❌ INVALID - Errors found:');
    errors.forEach(error => console.log(`  ${error}`));
    invalidFutureCount++;
  } else {
    if (isTooSimilar) {
      console.log('✅ VALID (but TOO SIMILAR)');
      tooSimilarFutureCount++;
    } else {
      console.log('✅ VALID');
    }
  }

  console.log('');
}

// Print puzzle runway stats at the end
const runwayDays = Math.max(0, puzzlesData.length - currentPuzzleIndex);
const runwayEndDate = new Date(startDate.getTime());
runwayEndDate.setDate(runwayEndDate.getDate() + (puzzlesData.length - 1));
console.log(`Puzzle runway: ${runwayDays} day${runwayDays === 1 ? '' : 's'} remaining (through ${runwayEndDate.toISOString().split('T')[0]})`);
console.log(`Invalid future puzzles: ${invalidFutureCount}`);
console.log(`Too-similar future puzzles: ${tooSimilarFutureCount}`);