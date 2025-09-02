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
 *   2. COLUMN REVIEW: Check each column - do all 4 words belong in that column category?
 *   3. EXCLUSION REVIEW: Check each word - is it NOT in the other 6 categories?
 *   4. HOMONYM ANALYSIS: Identify potential homonyms and multiple meanings!
 *   5. Use common sense - don't trust the word list, it can be wrong!
 *   6. Remember homonyms - words can have multiple meanings!
 */

// Function to calculate puzzle date from index
function getPuzzleDate(index) {
    try {
        const puzzlesData = JSON.parse(fs.readFileSync('daily_puzzles/puzzles.json', 'utf8'));
        
        // For negative indices, calculate backwards from the end
        if (index < 0) {
            const actualIndex = puzzlesData.length + index;
            const startDate = new Date('2025-07-21T00:00:00');
            const puzzleDate = new Date(startDate.getTime() + (actualIndex * 24 * 60 * 60 * 1000));
            return puzzleDate.toISOString().split('T')[0];
        } else {
            // For positive indices, calculate forward from start date
            const startDate = new Date('2025-07-21T00:00:00');
            const puzzleDate = new Date(startDate.getTime() + (index * 24 * 60 * 60 * 1000));
            return puzzleDate.toISOString().split('T')[0];
        }
    } catch (error) {
        // Fallback to original calculation if file read fails
        const startDate = new Date('2025-07-21T00:00:00');
        const puzzleDate = new Date(startDate.getTime() + (index * 24 * 60 * 60 * 1000));
        return puzzleDate.toISOString().split('T')[0];
    }
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

// Function to identify potential homonyms and multiple meanings
function analyzeHomonyms(word, rowCategory, colCategory) {
    const homonymNotes = [];
    
    // Check for words that might have multiple interpretations
    if (word.includes(',') || word.includes(' ')) {
        homonymNotes.push(`🔍 MULTI-WORD: "${word}" - consider each part separately`);
    }
    
    // Check for proper nouns that might have multiple associations
    if (word.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/)) {
        homonymNotes.push(`👤 PROPER NOUN: "${word}" - could refer to person, place, or thing`);
    }
    
    // Check for words that might have multiple meanings (general guidance)
    if (word.length > 3 && !word.includes(' ')) {
        homonymNotes.push(`💡 Consider: "${word}" might have multiple meanings or interpretations`);
    }
    
    return homonymNotes;
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
    console.log('For each row, verify that all 4 words belong in that row category:');
    console.log('⚠️  PAY SPECIAL ATTENTION TO HOMONYMS AND MULTIPLE MEANINGS!\n');

    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        console.log(`ROW ${rowIndex + 1} (${rows[rowIndex]}):`);
        for (let colIndex = 0; colIndex < 4; colIndex++) {
            const word = words[rowIndex][colIndex];
            const homonymNotes = analyzeHomonyms(word, rows[rowIndex], cols[colIndex]);
            console.log(`  [${rowIndex + 1},${colIndex + 1}] ${word}`);
            homonymNotes.forEach(note => console.log(`    ${note}`));
        }
        console.log('');
    }

    // Review by COLUMNS
    console.log('=== COLUMN REVIEW ===');
    console.log('For each column, verify that all 4 words belong in that column category:');
    console.log('⚠️  PAY SPECIAL ATTENTION TO HOMONYMS AND MULTIPLE MEANINGS!\n');

    for (let colIndex = 0; colIndex < 4; colIndex++) {
        console.log(`COLUMN ${colIndex + 1} (${cols[colIndex]}):`);
        for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
            const word = words[rowIndex][colIndex];
            const homonymNotes = analyzeHomonyms(word, rows[rowIndex], cols[colIndex]);
            console.log(`  [${rowIndex + 1},${colIndex + 1}] ${word}`);
            homonymNotes.forEach(note => console.log(`    ${note}`));
        }
        console.log('');
    }

    // Review EXCLUSIONS
    console.log('=== EXCLUSION REVIEW ===');
    console.log('For each word, verify it is NOT in the other 6 categories:');
    console.log('⚠️  REMEMBER: Homonyms can belong to multiple categories!\n');

    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        for (let colIndex = 0; colIndex < 4; colIndex++) {
            const word = words[rowIndex][colIndex];
            const otherCategories = [...rows, ...cols].filter(cat =>
                cat !== rows[rowIndex] && cat !== cols[colIndex]
            );
            console.log(`[${rowIndex + 1},${colIndex + 1}] ${word}: Should NOT be in ${otherCategories.join(', ')}`);
        }
    }

    // NEW: Dedicated HOMONYM ANALYSIS section
    console.log('\n=== 🔍 HOMONYM ANALYSIS ===');
    console.log('This section highlights potential homonyms and multiple meanings:');
    console.log('Words that might fit multiple categories due to different interpretations:\n');
    
    const allHomonyms = [];
    for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
        for (let colIndex = 0; colIndex < 4; colIndex++) {
            const word = words[rowIndex][colIndex];
            const homonymNotes = analyzeHomonyms(word, rows[rowIndex], cols[colIndex]);
            if (homonymNotes.length > 0) {
                allHomonyms.push({ word, position: `[${rowIndex + 1},${colIndex + 1}]`, notes: homonymNotes });
            }
        }
    }
    
    if (allHomonyms.length === 0) {
        console.log('✅ No obvious homonyms detected in this puzzle.');
    } else {
        allHomonyms.forEach(({ word, position, notes }) => {
            console.log(`${position} "${word}":`);
            notes.forEach(note => console.log(`  ${note}`));
            console.log('');
        });
    }

    // Add homonym examples and guidance
    console.log('=== 💡 HOMONYM EXAMPLES & GUIDANCE ===');
    console.log('Common homonym patterns to watch for:');
    console.log('• Words with multiple meanings (e.g., "cricket" = insect/sport)');
    console.log('• Place names that are also titles (e.g., "Manhattan" = island/film)');
    console.log('• Character names that are also concepts (e.g., "Batman" = character/stories)');
    console.log('• Titles that refer to both movie and book (e.g., "Dracula" = novel/film)');
    console.log('• Names that refer to both person and company (e.g., "Tesla" = Nikola Tesla/Tesla Inc.)');
    console.log('• Eponymous titles refer to both works and people (e.g., "Hamlet" = character/play, "The Great Gatsby" = character/novel)');
    console.log('• Titles that refer to both works and subjects (e.g., "Titanic" = movie/ship, "The Red Shoes" = film/ballet)');
    console.log('• Multi-word entries that can be interpreted differently');
    console.log('• Proper nouns with multiple associations');
    console.log('• Words that fit multiple categories through different interpretations\n');

    console.log('=== MANUAL VERIFICATION GUIDE ===');
    console.log('1. ROW REVIEW: Check each row - do all 4 words belong in that category?');
    console.log('2. COLUMN REVIEW: Check each column - do all 4 words belong in that column category?');
    console.log('3. EXCLUSION REVIEW: Check each word - is it NOT in the other 6 categories?');
    console.log('4. 🔍 HOMONYM ANALYSIS: Carefully consider words with multiple meanings!');
    console.log('5. COMMON SENSE: Don\'t trust the word list - use your knowledge!');
    console.log('6. ⚠️  HOMONYMS: Words can belong to multiple categories based on different interpretations!');
}

// Get index from command line argument or use default
const index = parseInt(process.argv[2]) || 0;
reviewPuzzle(index);
