const fs = require('fs');

// Load data
const categories = JSON.parse(fs.readFileSync('data/categories.json', 'utf8'));
const words = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

// Get category names in consistent order
const categoryNames = Object.keys(categories).sort();

console.log(`Loaded ${categoryNames.length} categories and ${Object.keys(words).length} words`);

// Precompute overlap matrix
console.log('Precomputing overlap matrix...');
const overlapMatrix = [];
const strictSubsetMap = new Map();

for (let i = 0; i < categoryNames.length; i++) {
    overlapMatrix[i] = [];
    strictSubsetMap.set(categoryNames[i], new Set());
}

for (let i = 0; i < categoryNames.length; i++) {
    for (let j = 0; j < categoryNames.length; j++) {
        if (i === j) {
            overlapMatrix[i][j] = 0; // Self-overlap not allowed
            continue;
        }

        const cat1 = categoryNames[i];
        const cat2 = categoryNames[j];
        const words1 = new Set(categories[cat1]);
        const words2 = new Set(categories[cat2]);

        // Check for strict subset relationship
        let isStrictSubset = false;
        if (words1.size < words2.size) {
            isStrictSubset = [...words1].every(word => words2.has(word));
        } else if (words2.size < words1.size) {
            isStrictSubset = [...words2].every(word => words1.has(word));
        }

        if (isStrictSubset) {
            overlapMatrix[i][j] = 0;
            strictSubsetMap.get(cat1).add(cat2);
            strictSubsetMap.get(cat2).add(cat1);
        } else {
            // Check for overlap
            const intersection = [...words1].filter(word => words2.has(word));
            overlapMatrix[i][j] = intersection.length > 0 ? 1 : 0;
        }
    }
}

console.log('Overlap matrix computed');

// Function to find valid next categories (lexicographical - only forward)
function findValidNextCategories(currentCategories, otherCategories, maxSize, minIndex = 0) {
    const valid = [];

    for (let i = minIndex; i < categoryNames.length; i++) {
        // Skip if already used
        if (currentCategories.includes(i) || otherCategories.includes(i)) continue;

        // Skip if would exceed max size
        if (currentCategories.length >= maxSize) continue;

        // Skip if this category is a strict subset of any existing category
        const catName = categoryNames[i];
        let isStrictSubset = false;
        for (const existingCat of [...currentCategories, ...otherCategories]) {
            const existingCatName = categoryNames[existingCat];
            if (strictSubsetMap.get(catName).has(existingCatName)) {
                isStrictSubset = true;
                break;
            }
        }
        if (isStrictSubset) continue;

        // Check if this category overlaps with all categories in the other dimension
        let isValid = true;
        for (const existingCat of otherCategories) {
            if (overlapMatrix[i][existingCat] === 0) {
                isValid = false;
                break;
            }
        }

        if (isValid) {
            // Test if adding this category would create a valid puzzle
            const testCategories = [...currentCategories, i];
            const testOtherCategories = [...otherCategories];

            // Create test puzzle
            const testRows = testCategories.map(idx => categoryNames[idx]);
            const testCols = testOtherCategories.map(idx => categoryNames[idx]);

            // Check if this would create a valid puzzle
            if (isValidPuzzle(testRows, testCols)) {
                valid.push(i);
            }
        }
    }

    return valid;
}

// Function to validate that a puzzle has unique solutions (each word fits exactly one cell)
function isValidPuzzle(rows, cols) {
    const wordToCells = new Map(); // Maps each word to the cells it can fit in

    // Check each cell and record which words can fit where
    for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < cols.length; j++) {
            const rowWords = categories[rows[i]];
            const colWords = categories[cols[j]];

            // Find intersection
            const intersection = rowWords.filter(word => colWords.includes(word));

            // Record each word and which cell it can fit in
            for (const word of intersection) {
                if (!wordToCells.has(word)) {
                    wordToCells.set(word, []);
                }
                wordToCells.get(word).push([i, j]);
            }
        }
    }

    // Check for words that can fit in multiple cells
    for (const [word, cells] of wordToCells.entries()) {
        if (cells.length > 1) {
            return false; // Word can fit in multiple cells - invalid puzzle
        }
    }

    return true; // All words fit in exactly one cell
}

// Function to solve a puzzle with given row and column categories
function solvePuzzle(rows, cols) {
    if (!isValidPuzzle(rows, cols)) {
        return []; // Invalid puzzle
    }

    const solutions = [];
    const usedWords = new Set();

    for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < cols.length; j++) {
            const rowWords = categories[rows[i]];
            const colWords = categories[cols[j]];

            // Find intersection
            const intersection = rowWords.filter(word => colWords.includes(word));

            // Find available word
            const availableWords = intersection.filter(word => !usedWords.has(word));
            const selectedWord = availableWords[0];

            solutions.push(selectedWord);
            usedWords.add(selectedWord);
        }
    }

    return solutions;
}

// Main search function using simple pointers
function findPuzzles() {
    const candidates = [];
    const maxRows = 4;
    const maxCols = 4;

    console.log('Starting systematic search...');

    // Get terminal width for truncation
    const terminalWidth = process.stdout.columns || 80;
    const maxCategoryLength = Math.max(20, Math.floor(terminalWidth * 0.6));

    // Try each category as the first row
    for (let firstRow = 0; firstRow < categoryNames.length; firstRow++) {
        // Initialize state with simple pointers
        let rows = [firstRow];
        let cols = [];
        let currentDimension = 'col'; // Start with column after first row
        let currentIndex = 0;
        let validOptions = [];
        let iterationsOnThisCategory = 0;

        while (true) {
            iterationsOnThisCategory++;

            // Update progress display (two lines)
            const currentCategories = [...rows.map(i => categoryNames[i]), ...cols.map(i => categoryNames[i])];
            const categoryString = currentCategories.join(', ');

            // Calculate available space for categories (accounting for other display elements)
            const otherElements = `Candidates: ${candidates.length} | Categories:  | Dim: ${currentDimension} | Index: ${currentIndex} | Iter: ${iterationsOnThisCategory}`;
            const availableSpace = process.stdout.columns - otherElements.length - 10; // 10 for safety margin

            let truncatedCategories;
            if (categoryString.length <= availableSpace) {
                truncatedCategories = categoryString;
            } else {
                // Truncate more aggressively to ensure it fits
                truncatedCategories = categoryString.substring(0, availableSpace - 3) + '...';
            }

            const progressPercent = ((firstRow + 1) / categoryNames.length * 100).toFixed(1);
            const progressBar = '█'.repeat(Math.floor(progressPercent / 2)) + '░'.repeat(50 - Math.floor(progressPercent / 2));

            // Clear both lines and write new content
            process.stdout.write('\r\x1b[K'); // Clear current line
            process.stdout.write('\x1b[1A\x1b[K'); // Move up and clear previous line
            process.stdout.write(`Progress: [${progressBar}] ${progressPercent}% (${firstRow + 1}/${categoryNames.length})\n`);
            process.stdout.write(`Candidates: ${candidates.length} | Categories: ${truncatedCategories} | Dim: ${currentDimension} | Index: ${currentIndex} | Iter: ${iterationsOnThisCategory}`);

            // If we haven't computed valid options for this state yet
            if (validOptions.length === 0) {
                if (currentDimension === 'col') {
                    validOptions = findValidNextCategories(cols, rows, maxCols, currentIndex);
                } else {
                    validOptions = findValidNextCategories(rows, cols, maxRows, currentIndex);
                }
            }

            // If we have valid options and haven't tried them all
            if (currentIndex < validOptions.length) {
                const nextCategory = validOptions[currentIndex];

                // Add the category to the appropriate dimension
                if (currentDimension === 'col') {
                    cols.push(nextCategory);
                } else {
                    rows.push(nextCategory);
                }

                // Check if we should record this as a candidate
                if (rows.length >= 2 && cols.length >= 2) {
                    const puzzle = {
                        rows: rows.map(i => categoryNames[i]),
                        cols: cols.map(i => categoryNames[i]),
                        size: `${rows.length}x${cols.length}`
                    };
                    candidates.push(puzzle);
                }

                // Check if we've reached max size in one dimension
                if (rows.length === maxRows || cols.length === maxCols) {
                    // Try next option
                    currentIndex++;
                    continue;
                }

                // Switch dimension and continue
                currentDimension = currentDimension === 'col' ? 'row' : 'col';
                currentIndex = 0;
                validOptions = [];

            } else {
                // No more options in current dimension, backtrack
                if (currentDimension === 'col') {
                    if (cols.length > 0) {
                        // Remove last column and try next option
                        cols.pop();
                        currentIndex++;
                    } else {
                        // No more columns, try next row
                        if (rows.length > 1) {
                            rows.pop();
                            currentDimension = 'col';
                            currentIndex = 0;
                        } else {
                            // No more rows, move to next starting category
                            break;
                        }
                    }
                } else {
                    // We're adding rows, try next row option
                    if (rows.length > 1) {
                        rows.pop();
                        currentIndex++;
                    } else {
                        // No more rows to try, move to next starting category
                        break;
                    }
                }
                validOptions = [];

                // Safety check: if we've tried too many options without progress, move to next category
                if (currentIndex > categoryNames.length) {
                    break;
                }

                // Additional safety: if we're stuck in a loop, force move to next category
                if (iterationsOnThisCategory > 1000) {
                    break;
                }
            }
        }
    }

    // Clear the progress lines
    process.stdout.write('\r\x1b[K\n\x1b[K'); // Clear both lines
    console.log(`Found ${candidates.length} candidate puzzles`);

    // Solve each candidate and categorize by size
    const solvedPuzzles = {
        '2x4': [],
        '3x4': [],
        '4x2': [],
        '4x3': [],
        '3x3': [],
        '4x4': []
    };

    let solvedCount = 0;
    for (const candidate of candidates) {
        const solutions = solvePuzzle(candidate.rows, candidate.cols);

        if (solutions.length > 0) {
            const solvedPuzzle = {
                ...candidate,
                solutions: solutions
            };

            // Determine size and transpose if needed
            let size = candidate.size;
            if (size === '2x4') {
                size = '4x2';
                solvedPuzzle.rows = candidate.cols;
                solvedPuzzle.cols = candidate.rows;
                solvedPuzzle.size = size;
            } else if (size === '3x4') {
                size = '4x3';
                solvedPuzzle.rows = candidate.cols;
                solvedPuzzle.cols = candidate.rows;
                solvedPuzzle.size = size;
            }

            if (solvedPuzzles[size]) {
                solvedPuzzles[size].push(solvedPuzzle);
            }
        }

        solvedCount++;
        if (solvedCount % 1000 === 0) {
            console.log(`Solved ${solvedCount}/${candidates.length} candidates`);
        }
    }

    // Save results to separate files
    for (const [size, puzzles] of Object.entries(solvedPuzzles)) {
        if (puzzles.length > 0) {
            // Clear the file first, then write new contents
            fs.writeFileSync(`puzzles_${size}.json`, '');
            fs.writeFileSync(`puzzles_${size}.json`, JSON.stringify(puzzles, null, 2));
            console.log(`Saved ${puzzles.length} ${size} puzzles to puzzles_${size}.json`);
        }
    }

    // Print summary
    console.log('\nSummary:');
    for (const [size, puzzles] of Object.entries(solvedPuzzles)) {
        console.log(`${size}: ${puzzles.length} puzzles`);
    }
}

// Run the solver
findPuzzles(); 