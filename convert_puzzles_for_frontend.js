const fs = require('fs');

// Load the categories data to get word lists
const categories = JSON.parse(fs.readFileSync('categories.json', 'utf8'));

// Function to create a canonical key for a puzzle (agnostic of row/column order)
function createCanonicalKey(puzzle) {
    // Get all categories from both rows and columns
    const allCategories = [...puzzle.rows, ...puzzle.cols].sort();
    return allCategories.join('|');
}

// Function to create a word-based key for duplicate detection
function createWordKey(puzzle) {
    // Get all words from the solution, sorted
    const allWords = [...puzzle.solutions].sort();
    return allWords.join('|');
}

// Function to convert a puzzle to frontend format
function convertPuzzle(puzzle) {
    // Create word lists for each category
    const categoryWords = {};
    
    // Add words for row categories
    puzzle.rows.forEach(category => {
        categoryWords[category] = categories[category] || [];
    });
    
    // Add words for column categories
    puzzle.cols.forEach(category => {
        categoryWords[category] = categories[category] || [];
    });
    
    // Create the frontend puzzle format
    return {
        id: Math.random().toString(36).substr(2, 9), // Random ID
        categories: {
            rows: puzzle.rows,
            cols: puzzle.cols
        },
        words: categoryWords,
        solution: puzzle.solutions,
        size: puzzle.size
    };
}

// Main conversion function
function convertPuzzles() {
    console.log('Loading puzzles...');
    
    // Load existing frontend puzzles if they exist
    let existingPuzzles = [];
    let existingCanonicalKeys = new Set();
    let existingWordKeys = new Set();
    
    try {
        const existingData = JSON.parse(fs.readFileSync('frontend_puzzles.json', 'utf8'));
        existingPuzzles = existingData.puzzles || [];
        
        // Build sets of existing keys for duplicate detection
        existingPuzzles.forEach(puzzle => {
            const canonicalKey = createCanonicalKey(puzzle);
            const wordKey = createWordKey(puzzle);
            existingCanonicalKeys.add(canonicalKey);
            existingWordKeys.add(wordKey);
        });
        
        console.log(`Found ${existingPuzzles.length} existing puzzles`);
    } catch (error) {
        console.log('No existing frontend puzzles found, starting fresh');
    }
    
    // Load new puzzles
    const newPuzzles = JSON.parse(fs.readFileSync('puzzles_incremental_4x4.json', 'utf8'));
    console.log(`Loaded ${newPuzzles.length} new puzzles`);
    
    // Convert and filter new puzzles
    let addedCount = 0;
    let duplicateCategoryCount = 0;
    let duplicateWordCount = 0;
    
    newPuzzles.forEach(puzzle => {
        // Create canonical key (agnostic of row/column order)
        const canonicalKey = createCanonicalKey(puzzle);
        
        // Create word-based key
        const wordKey = createWordKey(puzzle);
        
        // Check for duplicates
        if (existingCanonicalKeys.has(canonicalKey)) {
            duplicateCategoryCount++;
            return;
        }
        
        if (existingWordKeys.has(wordKey)) {
            duplicateWordCount++;
            return;
        }
        
        // Convert to frontend format
        const frontendPuzzle = convertPuzzle(puzzle);
        
        // Add to existing puzzles
        existingPuzzles.push(frontendPuzzle);
        existingCanonicalKeys.add(canonicalKey);
        existingWordKeys.add(wordKey);
        addedCount++;
    });
    
    // Randomize the order of all puzzles
    for (let i = existingPuzzles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [existingPuzzles[i], existingPuzzles[j]] = [existingPuzzles[j], existingPuzzles[i]];
    }
    
    // Save the combined and randomized puzzles
    const outputData = {
        puzzles: existingPuzzles,
        metadata: {
            totalPuzzles: existingPuzzles.length,
            lastUpdated: new Date().toISOString(),
            source: 'puzzles_incremental_4x4.json'
        }
    };
    
    fs.writeFileSync('frontend_puzzles.json', JSON.stringify(outputData, null, 2));
    
    console.log('\n=== CONVERSION SUMMARY ===');
    console.log(`New puzzles processed: ${newPuzzles.length}`);
    console.log(`Puzzles added: ${addedCount}`);
    console.log(`Duplicate category combinations skipped: ${duplicateCategoryCount}`);
    console.log(`Duplicate word combinations skipped: ${duplicateWordCount}`);
    console.log(`Total puzzles in frontend format: ${existingPuzzles.length}`);
    console.log(`Saved to: frontend_puzzles.json`);
}

// Run the conversion
convertPuzzles(); 