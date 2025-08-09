import fs from 'fs';
import path from 'path';

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

// Get current date to identify future puzzles
const currentDate = new Date();
const startDate = new Date('2025-07-21T00:00:00'); // Actual start date from the game
const daysSinceStart = Math.floor((currentDate - startDate) / (1000 * 60 * 60 * 24));
const currentPuzzleIndex = daysSinceStart;

console.log(`Current date: ${currentDate.toISOString().split('T')[0]}`);
console.log(`Current puzzle index: ${currentPuzzleIndex}`);
console.log(`Total puzzles: ${puzzlesData.length}`);
console.log('');

// Check each future puzzle
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
  console.log('');
  
  let hasErrors = false;
  const errors = [];
  
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
  } else {
    console.log('✅ VALID');
  }
  
  console.log('');
} 