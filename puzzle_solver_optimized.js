const fs = require('fs');
const { Matrix } = require('ml-matrix');
const { execSync } = require('child_process');

// Start timing the entire process
const startTime = Date.now();
let updateTime, loadTime, intersectionTime, twoAwayTime;

// Step 1: Run update_all_data to ensure data is current
console.log('Step 1: Updating all data files...');
const updateStart = Date.now();
try {
    execSync('node update_all_data.js', { stdio: 'inherit' });
    updateTime = Date.now() - updateStart;
    console.log(`Data files updated successfully! (${updateTime}ms)\n`);
} catch (error) {
    console.error('Error updating data files:', error.message);
    process.exit(1);
}

// Load data
const loadStart = Date.now();
const categories = JSON.parse(fs.readFileSync('data/categories.json', 'utf8'));
const words = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));
loadTime = Date.now() - loadStart;

// Get category names in consistent order
const categoryNames = Object.keys(categories).sort();

console.log(`Loaded ${categoryNames.length} categories and ${Object.keys(words).length} words (${loadTime}ms)`);

// Step 1: Compute intersection matrix, excluding subsets and identical categories
console.log('Step 1: Computing intersection matrix...');
const intersectionStart = Date.now();
const subsetMap = new Map(); // Maps category to set of categories it's a subset of

// Initialize subset map
for (let i = 0; i < categoryNames.length; i++) {
    subsetMap.set(categoryNames[i], new Set());
}

// Build intersection matrix using ml-matrix
const intersectionMatrix = new Matrix(categoryNames.length, categoryNames.length);

for (let i = 0; i < categoryNames.length; i++) {
    for (let j = 0; j < categoryNames.length; j++) {
        if (i === j) {
            intersectionMatrix.set(i, j, 0); // Self-intersection not allowed
            continue;
        }

        const cat1 = categoryNames[i];
        const cat2 = categoryNames[j];
        const words1 = new Set(categories[cat1]);
        const words2 = new Set(categories[cat2]);

        // Check for subset relationship (including identical)
        let isSubset = false;
        if (words1.size <= words2.size) {
            isSubset = [...words1].every(word => words2.has(word));
        } else {
            isSubset = [...words2].every(word => words1.has(word));
        }

        if (isSubset) {
            intersectionMatrix.set(i, j, 0);
            subsetMap.get(cat1).add(cat2);
            subsetMap.get(cat2).add(cat1);
        } else {
            // Check for intersection
            const intersection = [...words1].filter(word => words2.has(word));
            intersectionMatrix.set(i, j, intersection.length > 0 ? 1 : 0);
        }
    }
}

intersectionTime = Date.now() - intersectionStart;
console.log(`Intersection matrix computed (${intersectionTime}ms)`);

// Step 2: Compute 2-away matrix using optimized matrix multiplication
console.log('Step 2: Computing 2-away matrix...');
const twoAwayStart = Date.now();

// Use ml-matrix's optimized matrix multiplication
const twoAwayMatrix = intersectionMatrix.mmul(intersectionMatrix);

// Apply subset exclusions to the result
for (let i = 0; i < categoryNames.length; i++) {
    for (let j = 0; j < categoryNames.length; j++) {
        if (i === j) {
            twoAwayMatrix.set(i, j, 0); // Self-2-away not allowed
            continue;
        }

        // Zero out if either category is a subset of the other
        const cat1 = categoryNames[i];
        const cat2 = categoryNames[j];
        if (subsetMap.get(cat1).has(cat2) || subsetMap.get(cat2).has(cat1)) {
            twoAwayMatrix.set(i, j, 0);
        } else {
            // For 4x4 puzzles, we need at least 4 paths between categories in the same dimension
            const pathCount = twoAwayMatrix.get(i, j);
            twoAwayMatrix.set(i, j, pathCount >= 4 ? 1 : 0);
        }
    }
}

twoAwayTime = Date.now() - twoAwayStart;
console.log(`2-away matrix computed (${twoAwayTime}ms)`);

// Count 2-away connections for analysis
let twoAwayConnections = 0;
for (let i = 0; i < categoryNames.length; i++) {
    for (let j = 0; j < categoryNames.length; j++) {
        if (twoAwayMatrix.get(i, j) === 1) {
            twoAwayConnections++;
        }
    }
}
console.log(`Found ${twoAwayConnections} 2-away connections (with minimum 4 paths requirement)`);

// Function to validate that a puzzle has unique solutions (each word fits exactly one cell)
function isValidPuzzle(rows, cols) {
    // Try to find a valid solution by testing different word combinations
    return solvePuzzle(rows, cols).length > 0;
}

// Function to solve a puzzle with given row and column categories
function solvePuzzle(rows, cols) {
    // Try to find a valid solution by testing different word combinations
    const solutions = [];
    const usedWords = new Set();

    // Create a matrix of available words for each cell
    const availableWordsMatrix = [];
    for (let i = 0; i < rows.length; i++) {
        availableWordsMatrix[i] = [];
        for (let j = 0; j < cols.length; j++) {
            const rowWords = categories[rows[i]];
            const colWords = categories[cols[j]];

            // Find intersection
            const intersection = rowWords.filter(word => colWords.includes(word));
            availableWordsMatrix[i][j] = intersection;
        }
    }

    // Try to find a valid solution using backtracking
    function trySolve(row, col) {
        if (row >= rows.length) {
            return true; // All cells filled successfully
        }

        const nextRow = col + 1 >= cols.length ? row + 1 : row;
        const nextCol = col + 1 >= cols.length ? 0 : col + 1;

        // Try each available word for this cell
        for (const word of availableWordsMatrix[row][col]) {
            if (!usedWords.has(word)) {
                usedWords.add(word);
                solutions[row * cols.length + col] = word;

                if (trySolve(nextRow, nextCol)) {
                    return true; // Found a valid solution
                }

                // Backtrack
                usedWords.delete(word);
                solutions[row * cols.length + col] = undefined;
            }
        }

        return false; // No valid solution found
    }

    // Try to solve the puzzle
    if (trySolve(0, 0)) {
        return solutions.filter(word => word !== undefined);
    }

    return []; // No valid solution found
}

// Function to check if two categories can be in the same dimension using 2-away matrix
function canBeInSameDimension(cat1Index, cat2Index) {
    return twoAwayMatrix.get(cat1Index, cat2Index) === 1;
}

// Function to check if a category can be added to existing categories in the other dimension
function canAddToOtherDimension(catIndex, existingOtherCategories) {
    for (const existingCat of existingOtherCategories) {
        if (intersectionMatrix.get(catIndex, existingCat) === 0) {
            return false;
        }
    }
    return true;
}

// Main search function using the optimized 2-away approach
function findPuzzles() {
    const candidates = [];
    const maxRows = 4;
    const maxCols = 4;

    console.log('Starting optimized 2-away matrix search...');
    const searchStart = Date.now();

    // Get terminal width for truncation
    const terminalWidth = process.stdout.columns || 80;
    const maxCategoryLength = Math.max(20, Math.floor(terminalWidth * 0.6));

    // Try each category as the first row
    const searchStartTime = Date.now();
    for (let firstRow = 0; firstRow < categoryNames.length; firstRow++) {
        // Initialize state
        let rows = [firstRow];
        let cols = [];
        let currentDimension = 'col'; // Start with column after first row
        let currentIndex = 0;
        let validOptions = [];
        let iterationsOnThisCategory = 0;

        while (true) {
            iterationsOnThisCategory++;

            // Update progress display
            const currentCategories = [...rows.map(i => categoryNames[i]), ...cols.map(i => categoryNames[i])];
            const categoryString = currentCategories.join(', ');

            const otherElements = `Candidates: ${candidates.length} | Categories:  | Dim: ${currentDimension} | Index: ${currentIndex} | Iter: ${iterationsOnThisCategory}`;
            const availableSpace = process.stdout.columns - otherElements.length - 10;

            let truncatedCategories;
            if (categoryString.length <= availableSpace) {
                truncatedCategories = categoryString;
            } else {
                truncatedCategories = categoryString.substring(0, availableSpace - 3) + '...';
            }

            const progressPercent = ((firstRow + 1) / categoryNames.length * 100).toFixed(1);
            const progressBar = '█'.repeat(Math.floor(progressPercent / 2)) + '░'.repeat(50 - Math.floor(progressPercent / 2));
            
            // Calculate ETA
            const elapsed = Date.now() - searchStartTime;
            const progress = (firstRow + 1) / categoryNames.length;
            const eta = progress > 0 ? (elapsed / progress) - elapsed : 0;
            const etaMinutes = Math.floor(eta / 60000);
            const etaSeconds = Math.floor((eta % 60000) / 1000);

            process.stdout.write('\r\x1b[K');
            process.stdout.write('\x1b[1A\x1b[K');
            process.stdout.write(`Progress: [${progressBar}] ${progressPercent}% (${firstRow + 1}/${categoryNames.length}) - ETA: ${etaMinutes}m ${etaSeconds}s\n`);
            process.stdout.write(`Candidates: ${candidates.length} | Categories: ${truncatedCategories} | Dim: ${currentDimension} | Index: ${currentIndex} | Iter: ${iterationsOnThisCategory}`);

            // If we haven't computed valid options for this state yet
            if (validOptions.length === 0) {
                if (currentDimension === 'col') {
                    // Looking for columns - need 2-away with existing columns and 1-away with existing rows
                    validOptions = [];
                    // Only search forward from the highest existing category index to maintain lexicographical order
                    const maxExistingIndex = Math.max(...rows, ...cols, -1);
                    for (let i = maxExistingIndex + 1; i < categoryNames.length; i++) {
                        if (rows.includes(i) || cols.includes(i)) continue;
                        if (cols.length >= maxCols) continue;
                        
                        // Skip if this category is a subset of any existing category
                        const catName = categoryNames[i];
                        let isSubset = false;
                        for (const existingCat of [...rows, ...cols]) {
                            const existingCatName = categoryNames[existingCat];
                            if (subsetMap.get(catName).has(existingCatName)) {
                                isSubset = true;
                                break;
                            }
                        }
                        if (isSubset) continue;

                        let isValid = true;
                        
                        // Check 2-away with existing columns (same dimension)
                        for (const existingCol of cols) {
                            if (!canBeInSameDimension(i, existingCol)) {
                                isValid = false;
                                break;
                            }
                        }
                        
                        // Check 1-away with existing rows (different dimension)
                        if (isValid && !canAddToOtherDimension(i, rows)) {
                            isValid = false;
                        }
                        
                        if (isValid) {
                            validOptions.push(i);
                        }
                    }
                } else {
                    // Looking for rows - use 2-away matrix if we have columns, 1-away if we don't
                    validOptions = [];
                    // Only search forward from the highest existing category index to maintain lexicographical order
                    const maxExistingIndex = Math.max(...rows, ...cols, -1);
                    for (let i = maxExistingIndex + 1; i < categoryNames.length; i++) {
                        if (rows.includes(i) || cols.includes(i)) continue;
                        if (rows.length >= maxRows) continue;
                        
                        // Skip if this category is a subset of any existing category
                        const catName = categoryNames[i];
                        let isSubset = false;
                        for (const existingCat of [...rows, ...cols]) {
                            const existingCatName = categoryNames[existingCat];
                            if (subsetMap.get(catName).has(existingCatName)) {
                                isSubset = true;
                                break;
                            }
                        }
                        if (isSubset) continue;

                        let isValid = true;
                        
                        if (cols.length === 0) {
                            // No columns yet - use 2-away matrix to check if this row can be added
                            for (const existingRow of rows) {
                                if (!canBeInSameDimension(i, existingRow)) {
                                    isValid = false;
                                    break;
                                }
                            }
                        } else {
                            // We have columns - use 1-away matrix to check if this row can be added
                            if (!canAddToOtherDimension(i, cols)) {
                                isValid = false;
                            }
                        }
                        
                        if (isValid) {
                            validOptions.push(i);
                        }
                    }
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

                // Safety checks
                if (currentIndex > categoryNames.length) {
                    break;
                }
                if (iterationsOnThisCategory > 1000) {
                    break;
                }
            }
        }
    }

    // Clear the progress lines
    process.stdout.write('\r\x1b[K\n\x1b[K');
    const searchTime = Date.now() - searchStart;
    console.log(`Found ${candidates.length} candidate puzzles (${searchTime}ms)`);

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
    const solveStart = Date.now();
    const solveStartTime = Date.now();
    
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
        
        // Update progress every 1000 candidates or at the end
        if (solvedCount % 1000 === 0 || solvedCount === candidates.length) {
            const elapsed = Date.now() - solveStartTime;
            const progress = solvedCount / candidates.length;
            const eta = progress > 0 ? (elapsed / progress) - elapsed : 0;
            const etaMinutes = Math.floor(eta / 60000);
            const etaSeconds = Math.floor((eta % 60000) / 1000);
            
            const progressBar = '█'.repeat(Math.floor(progress * 50)) + '░'.repeat(50 - Math.floor(progress * 50));
            const percent = (progress * 100).toFixed(1);
            
            process.stdout.write('\r\x1b[K');
            process.stdout.write(`Solving: [${progressBar}] ${percent}% (${solvedCount}/${candidates.length}) - ETA: ${etaMinutes}m ${etaSeconds}s`);
        }
    }
    
    // Clear the progress line
    process.stdout.write('\r\x1b[K\n');
    const solveTime = Date.now() - solveStart;

    // Save results to separate files
    for (const [size, puzzles] of Object.entries(solvedPuzzles)) {
        if (puzzles.length > 0) {
            fs.writeFileSync(`puzzles_${size}.json`, JSON.stringify(puzzles, null, 2));
            console.log(`Saved ${puzzles.length} ${size} puzzles to puzzles_${size}.json`);
        }
    }

    // Print summary with timing
    const totalTime = Date.now() - startTime;
    console.log('\n=== TIMING SUMMARY ===');
    console.log(`Data update: ${updateTime}ms`);
    console.log(`Data loading: ${loadTime}ms`);
    console.log(`Intersection matrix: ${intersectionTime}ms`);
    console.log(`2-away matrix: ${twoAwayTime}ms`);
    console.log(`Search phase: ${searchTime}ms`);
    console.log(`Solve phase: ${solveTime}ms`);
    console.log(`Total time: ${totalTime}ms`);
    console.log('\n=== RESULTS SUMMARY ===');
    for (const [size, puzzles] of Object.entries(solvedPuzzles)) {
        console.log(`${size}: ${puzzles.length} puzzles`);
    }
}

// Run the optimized solver
findPuzzles();