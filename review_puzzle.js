import fs from 'fs';

/**
 * Puzzle Review Script
 * 
 * This script helps manually review puzzles for the Connecdoku game.
 * It breaks down each puzzle into rows, columns, and exclusions for systematic review.
 * 
 * USAGE:
 *   node review_puzzle.js [index]
 *   - index: The puzzle index (0-based). Defaults to 0 if not provided.
 * 
 * DATE CALCULATION:
 *   - Start date: 2025-07-21 (July 21, 2025)
 *   - Puzzle index 0 = 2025-07-21
 *   - Puzzle index 1 = 2025-07-22
 *   - etc.
 * 
 * REVIEW PROCESS:
 *   1. ROW REVIEW: Check each row - do all 4 words belong in that category?
 *   2. COLUMN REVIEW: Check each column - do all 4 words belong in that category?
 *   3. EXCLUSION REVIEW: Check each word - is it NOT in the other 6 categories?
 *   4. Use common sense - don't trust the word list, it can be wrong!
 *   5. Remember homonyms - words can have multiple meanings!
 */

// Function to calculate puzzle date from index
function getPuzzleDate(index) {
    const startDate = new Date('2025-07-21T00:00:00');
    const puzzleDate = new Date(startDate.getTime() + (index * 24 * 60 * 60 * 1000));
    return puzzleDate.toISOString().split('T')[0]; // Returns YYYY-MM-DD format
}

// Function to get puzzle data by index
function getPuzzleByIndex(index) {
    try {
        const puzzlesData = JSON.parse(fs.readFileSync('daily_puzzles/puzzles.json', 'utf8'));

        // Handle negative indexing (like Python)
        if (index < 0) {
            index = puzzlesData.length + index;
        }

        return puzzlesData[index];
    } catch (error) {
        console.error(`Error reading puzzle at index ${index}:`, error.message);
        return null;
    }
}

// Function to analyze a word's categories
function analyzeWord(word, rowCategory, colCategory, allRowCategories, allColCategories) {
    // Get the 6 categories it shouldn't be in
    const otherCategories = [...allRowCategories, ...allColCategories].filter(cat =>
        cat !== rowCategory && cat !== colCategory
    );

    return `${word}: Should be in ${rowCategory} and ${colCategory}, should NOT be in ${otherCategories.join(', ')}`;
}

// Main function
function reviewPuzzle(index) {
    const puzzleDate = getPuzzleDate(index);
    console.log(`=== REVIEWING PUZZLE INDEX ${index} (${puzzleDate}) ===\n`);

    const puzzle = getPuzzleByIndex(index);
    if (!puzzle) {
        console.log(`No puzzle found at index ${index}`);
        return;
    }

    const { rows, cols, words } = puzzle;

    console.log('Row categories:', rows.join(', '));
    console.log('Column categories:', cols.join(', '));
    console.log('');

    // Review by ROWS
    console.log('=== ROW REVIEW ===');
    console.log('For each row, verify that all 4 words belong in that row category:\n');

    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        console.log(`ROW ${rowIndex + 1} (${rows[rowIndex]}):`);
        for (let colIndex = 0; colIndex < 4; colIndex++) {
            const word = words[rowIndex][colIndex];
            console.log(`  [${rowIndex + 1},${colIndex + 1}] ${word}`);
        }
        console.log('');
    }

    // Review by COLUMNS
    console.log('=== COLUMN REVIEW ===');
    console.log('For each column, verify that all 4 words belong in that column category:\n');

    for (let colIndex = 0; colIndex < 4; colIndex++) {
        console.log(`COLUMN ${colIndex + 1} (${cols[colIndex]}):`);
        for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
            const word = words[rowIndex][colIndex];
            console.log(`  [${rowIndex + 1},${colIndex + 1}] ${word}`);
        }
        console.log('');
    }

    // Review EXCLUSIONS
    console.log('=== EXCLUSION REVIEW ===');
    console.log('For each word, verify it is NOT in the other 6 categories:\n');

    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        for (let colIndex = 0; colIndex < 4; colIndex++) {
            const word = words[rowIndex][colIndex];
            const otherCategories = [...rows, ...cols].filter(cat =>
                cat !== rows[rowIndex] && cat !== cols[colIndex]
            );
            console.log(`[${rowIndex + 1},${colIndex + 1}] ${word}: Should NOT be in ${otherCategories.join(', ')}`);
        }
    }

    console.log('\n=== MANUAL VERIFICATION GUIDE ===');
    console.log('1. ROW REVIEW: Check each row - do all 4 words belong in that category?');
    console.log('2. COLUMN REVIEW: Check each column - do all 4 words belong in that category?');
    console.log('3. EXCLUSION REVIEW: Check each word - is it NOT in the other 6 categories?');
    console.log('4. HOMONYMS: Remember words can have multiple meanings!');
    console.log('5. COMMON SENSE: Don\'t trust the word list - use your knowledge!');
}

// Get index from command line argument or use default
const index = parseInt(process.argv[2]) || 0;
reviewPuzzle(index);
