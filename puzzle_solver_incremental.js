const fs = require('fs');
const { Matrix } = require('ml-matrix');

console.log('Loading main dataset...');
const startTime = Date.now();

// Load main data
const words = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));
const categories = JSON.parse(fs.readFileSync('data/categories.json', 'utf8'));

const loadTime = Date.now() - startTime;

// Extract category names and create mapping
const categoryNames = Object.keys(categories);
const categoryToIndex = new Map();
categoryNames.forEach((name, index) => categoryToIndex.set(name, index));

// Pre-filter categories to only include those with at least 4 words
const filteredCategoryNames = categoryNames.filter(name => categories[name].length >= 4);
console.log(`Loaded ${filteredCategoryNames.length} categories and ${Object.keys(words).length} words (${loadTime}ms)`);
console.log(`Pre-filtered from ${categoryNames.length} to ${filteredCategoryNames.length} categories (removed ${categoryNames.length - filteredCategoryNames.length} with <4 words)`);

// Update categoryToIndex mapping for filtered categories
const filteredCategoryToIndex = new Map();
filteredCategoryNames.forEach((name, index) => filteredCategoryToIndex.set(name, index));

console.log('Step 1: Computing intersection matrix...');
const intersectionStart = Date.now();

// Initialize working category list
let workingCategoryNames = [...filteredCategoryNames];
let categoriesRemoved = true;
let iterationCount = 0;

// Global matrices that will be updated in each iteration
let intersectionMatrix;
let twoAwayMatrix;

while (categoriesRemoved) {
    iterationCount++;
    console.log(`\n--- Iteration ${iterationCount} ---`);
    console.log(`Working with ${workingCategoryNames.length} categories...`);
    
    // Update category to index mapping for current working set
    const workingCategoryToIndex = new Map();
    workingCategoryNames.forEach((name, index) => workingCategoryToIndex.set(name, index));
    
    // Compute intersection matrix using current working categories
    intersectionMatrix = new Matrix(workingCategoryNames.length, workingCategoryNames.length);
    for (let i = 0; i < workingCategoryNames.length; i++) {
        for (let j = 0; j < workingCategoryNames.length; j++) {
            const cat1Words = categories[workingCategoryNames[i]];
            const cat2Words = categories[workingCategoryNames[j]];
            
            const intersection = cat1Words.filter(word => cat2Words.includes(word));
            intersectionMatrix.set(i, j, intersection.length);
        }
    }

    console.log('Computing 2-away matrix...');
    const twoAwayStart = Date.now();

    // Compute 2-away matrix using matrix multiplication
    const twoAwayMatrixRaw = intersectionMatrix.mmul(intersectionMatrix);
    twoAwayMatrix = new Matrix(workingCategoryNames.length, workingCategoryNames.length);

    // Apply minimum path count threshold (≥4 for 4x4 puzzles) and set diagonal to 0
    const minPaths = 4;
    let twoAwayCount = 0;
    for (let i = 0; i < workingCategoryNames.length; i++) {
        for (let j = 0; j < workingCategoryNames.length; j++) {
            if (i === j) {
                twoAwayMatrix.set(i, j, 0); // Diagonal entries are 0
            } else {
                const paths = twoAwayMatrixRaw.get(i, j);
                if (paths >= minPaths) {
                    twoAwayMatrix.set(i, j, 1);
                    twoAwayCount++;
                } else {
                    twoAwayMatrix.set(i, j, 0);
                }
            }
        }
    }

    const twoAwayTime = Date.now() - twoAwayStart;
    console.log(`2-away matrix computed (${twoAwayTime}ms)`);
    console.log(`Found ${twoAwayCount} 2-away connections (with minimum ${minPaths} paths requirement)`);

    // Check each category against the two criteria
    const categoriesToRemove = [];
    
    for (let i = 0; i < workingCategoryNames.length; i++) {
        const categoryName = workingCategoryNames[i];
        
        // Criterion 1: Check if category is 1-away from at least 4 other categories
        let oneAwayCount = 0;
        for (let j = 0; j < workingCategoryNames.length; j++) {
            if (i !== j && intersectionMatrix.get(i, j) > 0) {
                oneAwayCount++;
            }
        }
        
        // Criterion 2: Check if category is 2-away from at least 3 other categories via at least 4 different routes
        let twoAwayCount = 0;
        for (let j = 0; j < workingCategoryNames.length; j++) {
            twoAwayCount += twoAwayMatrix.get(i, j);
        }
        
        // Check if category meets both criteria
        if (oneAwayCount < 4 || twoAwayCount < 3) {
            categoriesToRemove.push(i);
            console.log(`Removing ${categoryName}: 1-away=${oneAwayCount}, 2-away=${twoAwayCount}`);
        }
    }
    
    // Remove categories that don't meet criteria
    if (categoriesToRemove.length > 0) {
        console.log(`Removing ${categoriesToRemove.length} categories that don't meet criteria`);
        workingCategoryNames = workingCategoryNames.filter((_, index) => !categoriesToRemove.includes(index));
        categoriesRemoved = true;
    } else {
        console.log('No categories removed - all remaining categories meet criteria');
        categoriesRemoved = false;
    }
}

const intersectionTime = Date.now() - intersectionStart;
console.log(`\nFinal intersection matrix computed (${intersectionTime}ms)`);
console.log(`Final category count: ${workingCategoryNames.length} (down from ${filteredCategoryNames.length})`);

// Update the main category list to use the filtered working categories
filteredCategoryNames.length = 0;
filteredCategoryNames.push(...workingCategoryNames);
filteredCategoryToIndex.clear();
filteredCategoryNames.forEach((name, index) => filteredCategoryToIndex.set(name, index));

// Rebuild the matrices with the final filtered categories
console.log('Rebuilding matrices with final filtered categories...');
intersectionMatrix = new Matrix(filteredCategoryNames.length, filteredCategoryNames.length);
for (let i = 0; i < filteredCategoryNames.length; i++) {
    for (let j = 0; j < filteredCategoryNames.length; j++) {
        const cat1Words = categories[filteredCategoryNames[i]];
        const cat2Words = categories[filteredCategoryNames[j]];
        
        const intersection = cat1Words.filter(word => cat2Words.includes(word));
        intersectionMatrix.set(i, j, intersection.length);
    }
}

// Zero out the diagonal (categories don't intersect with themselves)
for (let i = 0; i < filteredCategoryNames.length; i++) {
    intersectionMatrix.set(i, i, 0);
}

// Rebuild 2-away matrix
const twoAwayMatrixRaw = intersectionMatrix.mmul(intersectionMatrix);
twoAwayMatrix = new Matrix(filteredCategoryNames.length, filteredCategoryNames.length);

// Apply minimum path count threshold (≥4 for 4x4 puzzles) and set diagonal to 0
const minPaths = 4;
let twoAwayCount = 0;
for (let i = 0; i < filteredCategoryNames.length; i++) {
    for (let j = 0; j < filteredCategoryNames.length; j++) {
        if (i === j) {
            twoAwayMatrix.set(i, j, 0); // Diagonal entries are 0
        } else {
            const paths = twoAwayMatrixRaw.get(i, j);
            if (paths >= minPaths) {
                twoAwayMatrix.set(i, j, 1);
                twoAwayCount++;
            } else {
                twoAwayMatrix.set(i, j, 0);
            }
        }
    }
}

console.log(`Final 2-away matrix: ${twoAwayCount} connections (with minimum ${minPaths} paths requirement)`);

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

// Function to solve a puzzle with given row and column categories
function solvePuzzle(rows, cols) {
    // Simple set intersection approach: find one word per intersection that's unique
    const solution = [];
    const usedWords = new Set();
    
    // For each of the 16 intersections (4x4 grid)
    for (let row = 0; row < rows.length; row++) {
        for (let col = 0; col < cols.length; col++) {
            const rowWords = categories[rows[row]];
            const colWords = categories[cols[col]];
            
            // Find intersection of row and column categories
            const intersection = rowWords.filter(word => colWords.includes(word));
            
            // Filter out words that are already used
            const availableWords = intersection.filter(word => !usedWords.has(word));
            
            // If no valid words for this intersection, puzzle is impossible
            if (availableWords.length === 0) {
                return [];
            }
            
            // Pick one word randomly from available options
            const selectedWord = availableWords[Math.floor(Math.random() * availableWords.length)];
            solution.push(selectedWord);
            usedWords.add(selectedWord);
        }
    }
    
    return solution;
}

// Function to check if a new category is compatible with existing categories
function isCompatible(newCatIndex, existingRows, existingCols) {
    // Check compatibility with existing rows (2-away relationship)
    for (const rowIndex of existingRows) {
        if (!canBeInSameDimension(newCatIndex, rowIndex)) {
            return false;
        }
    }
    
    // Check compatibility with existing columns (2-away relationship)
    for (const colIndex of existingCols) {
        if (!canBeInSameDimension(newCatIndex, colIndex)) {
            return false;
        }
    }
    
    // Check compatibility with opposite dimension (1-away relationship)
    if (existingRows.length > 0 && existingCols.length > 0) {
        // If adding a row, check it has 1-away with all existing columns
        if (existingRows.length < 4) {
            if (!canAddToOtherDimension(newCatIndex, existingCols)) {
                return false;
            }
        }
        // If adding a column, check it has 1-away with all existing rows
        else if (existingCols.length < 4) {
            if (!canAddToOtherDimension(newCatIndex, existingRows)) {
                return false;
            }
        }
    }
    
    return true;
}

// Function to create a unique key for a puzzle
function createPuzzleKey(rows, cols) {
    return `${rows.sort().join(',')}-${cols.sort().join(',')}`;
}

// Incremental search function that builds combinations step by step
function findPuzzles() {
    const candidates = [];
    const maxCandidates = 100000;
    const seenPuzzles = new Set(); // Track seen puzzles to prevent duplicates

    console.log('Starting incremental search...');
    const searchStart = Date.now();

    // Create a list of all possible category positions
    // Each category can be either a row or column, so we have 2 * categoryNames.length positions
    const allPositions = [];
    for (let i = 0; i < filteredCategoryNames.length; i++) {
        allPositions.push({ categoryIndex: i, isRow: true });
        allPositions.push({ categoryIndex: i, isRow: false });
    }

    // Initialize pointers: start with first position (which must be a row)
    let pointers = [0]; // Start with first position (first category as row)
    let searchCount = 0;
    let lastProgressUpdate = 0;
    
    // Infinite loop circuit breaker
    const seenPointerStates = new Set();
    const circuitBreakerInterval = 1000000; // Check every million iterations

    // Get terminal width for truncation
    const terminalWidth = process.stdout.columns || 80;
    const maxCategoryLength = Math.max(20, Math.floor(terminalWidth * 0.6));

    while (true) {
        searchCount++;
        
        // Debug: Print current state every 100k iterations
        if (searchCount % 100000 === 0) {
            const currentRows = [];
            const currentCols = [];
            for (const pointer of pointers) {
                // Check if pointer is valid
                if (pointer >= allPositions.length) {
                    console.error(`\n🚨 INVALID POINTER: ${pointer} >= ${allPositions.length}`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                const position = allPositions[pointer];
                if (!position) {
                    console.error(`\n🚨 NULL POSITION: pointer ${pointer} returned null`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                if (position.isRow) {
                    currentRows.push(filteredCategoryNames[position.categoryIndex]);
                } else {
                    currentCols.push(filteredCategoryNames[position.categoryIndex]);
                }
            }
            console.log(`\n--- Iteration ${searchCount} ---`);
            console.log(`Pointers: [${pointers.join(', ')}]`);
            console.log(`Rows (${currentRows.length}): [${currentRows.join(', ')}]`);
            console.log(`Cols (${currentCols.length}): [${currentCols.join(', ')}]`);
            console.log(`Candidates found so far: ${candidates.length}`);
        }
        
        // Infinite loop circuit breaker
        if (searchCount % circuitBreakerInterval === 0) {
            const pointerState = pointers.join(',');
            if (seenPointerStates.has(pointerState)) {
                console.error('\n🚨 INFINITE LOOP DETECTED!');
                console.error(`Current pointer state: [${pointers.join(', ')}]`);
                console.error(`This state was seen before at iteration ${searchCount - circuitBreakerInterval}`);
                console.error(`Total iterations: ${searchCount}`);
                console.error(`Candidates found: ${candidates.length}`);
                process.exit(1);
            }
            seenPointerStates.add(pointerState);
        }
        
        // Check if we have a complete 4x4 puzzle (4 rows + 4 columns = 8 pointers)
        if (pointers.length === 8) {
            // Extract rows and columns from pointers
            const rows = [];
            const cols = [];
            
            for (const pointer of pointers) {
                // Check if pointer is valid
                if (pointer >= allPositions.length) {
                    console.error(`\n🚨 INVALID POINTER: ${pointer} >= ${allPositions.length}`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                const position = allPositions[pointer];
                if (!position) {
                    console.error(`\n🚨 NULL POSITION: pointer ${pointer} returned null`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                if (position.isRow) {
                    rows.push(filteredCategoryNames[position.categoryIndex]);
                } else {
                    cols.push(filteredCategoryNames[position.categoryIndex]);
                }
            }
            
            // Check that we have exactly 4 rows and 4 columns
            if (rows.length === 4 && cols.length === 4) {
                // Assert that we have exactly 4 rows and 4 columns
                if (rows.length !== 4 || cols.length !== 4) {
                    console.error(`\n🚨 ASSERTION FAILED: Expected 4 rows and 4 columns, got ${rows.length} rows and ${cols.length} columns`);
                    console.error(`Rows: [${rows.join(', ')}]`);
                    console.error(`Cols: [${cols.join(', ')}]`);
                    process.exit(1);
                }
                
                const puzzleKey = createPuzzleKey(rows, cols);
                
                // Check for duplicates
                if (seenPuzzles.has(puzzleKey)) {
                    console.log('ERROR: Duplicate puzzle detected!', puzzleKey);
                    process.exit(1);
                }
                
                seenPuzzles.add(puzzleKey);
                
                const puzzle = {
                    rows: rows,
                    cols: cols,
                    size: '4x4'
                };
                candidates.push(puzzle);
                
                // Check if this is our simple puzzle
                const isSimplePuzzle = rows.includes("Things Chinese") && 
                                     rows.includes("Things American") &&
                                     rows.includes("Things British") &&
                                     rows.includes("Things Japanese") &&
                                     cols.includes("People") &&
                                     cols.includes("Foods") &&
                                     cols.includes("Movies") &&
                                     cols.includes("Books");
                if (isSimplePuzzle) {
                    console.log('\n🎉 FOUND THE SIMPLE PUZZLE!');
                    console.log('Rows:', rows);
                    console.log('Cols:', cols);
                }
                
                if (candidates.length >= maxCandidates) {
                    console.log(`\nReached maximum candidate limit (${maxCandidates})`);
                    break;
                }
            }
            
            // After recording a valid 8-pointer combination, advance the search position
            // This ensures we don't find the same combination again
            console.log(`Found valid combination! Advancing search position...`);
            
            // Use the same backtracking logic as the main search
            // Remove last pointer and advance the previous one
            pointers.pop();
            
            // If we've backtracked to the beginning, we're done
            if (pointers.length === 0) {
                break;
            }
            
            // Advance the pointer of the last remaining pointer
            // Special case: first pointer increments by 2 to skip column positions
            if (pointers.length === 1) {
                pointers[pointers.length - 1] += 2;
            } else {
                pointers[pointers.length - 1]++;
            }
            
            // Check if the advanced pointer is still valid
            if (pointers[pointers.length - 1] >= allPositions.length) {
                // If we've advanced beyond the array, backtrack further
                pointers.pop();
                if (pointers.length === 0) {
                    break;
                }
                // Continue to next iteration to try advancing the previous pointer
                continue;
            }
            
            continue;
        }
        
        // Try to add next pointer
        let addedPointer = false;
        
        // Find next compatible position
        let nextPointerIndex;
        if (pointers.length === 0) {
            nextPointerIndex = 0;
        } else {
            nextPointerIndex = pointers[pointers.length - 1] + 1;
        }
        
        while (nextPointerIndex < allPositions.length) {
            const nextPosition = allPositions[nextPointerIndex];
            
            // Debug: Print what we're checking every 100k iterations
            if (searchCount % 100000 === 0 && nextPointerIndex < 10) {
                console.log(`  Checking position ${nextPointerIndex}: ${filteredCategoryNames[nextPosition.categoryIndex]} (${nextPosition.isRow ? 'row' : 'col'})`);
            }
            
            // Constraint: First pointer can only be a row position
            if (pointers.length === 0 && !nextPosition.isRow) {
                nextPointerIndex++;
                continue;
            }
            
            // Extract current rows and columns from existing pointers
            const currentRows = [];
            const currentCols = [];
            
            for (const pointer of pointers) {
                // Check if pointer is valid
                if (pointer >= allPositions.length) {
                    console.error(`\n🚨 INVALID POINTER: ${pointer} >= ${allPositions.length}`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                const position = allPositions[pointer];
                if (!position) {
                    console.error(`\n🚨 NULL POSITION: pointer ${pointer} returned null`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                if (position.isRow) {
                    currentRows.push(position.categoryIndex);
                } else {
                    currentCols.push(position.categoryIndex);
                }
            }
            
            // Check if we can add this position
            let canAdd = true;
            
            // Check that we don't already have this category
            if (currentRows.includes(nextPosition.categoryIndex) || 
                currentCols.includes(nextPosition.categoryIndex)) {
                canAdd = false;
            }
            
            // Check that we don't exceed 4 rows or 4 columns
            if (nextPosition.isRow && currentRows.length >= 4) {
                canAdd = false;
            }
            if (!nextPosition.isRow && currentCols.length >= 4) {
                canAdd = false;
            }
            
            // Additional validation: ensure we don't exceed 8 pointers total
            if (pointers.length >= 8) {
                canAdd = false;
            }
            
            // Debug: Log when we're about to add a pointer
            if (canAdd) {
                console.log(`Adding ${nextPosition.isRow ? 'row' : 'col'} ${filteredCategoryNames[nextPosition.categoryIndex]} (${currentRows.length} rows, ${currentCols.length} cols)`);
                console.log(`  Current rows: [${currentRows.map(i => filteredCategoryNames[i]).join(', ')}]`);
                console.log(`  Current cols: [${currentCols.map(i => filteredCategoryNames[i]).join(', ')}]`);
            }
            
            // Check compatibility with existing categories
            if (canAdd) {
                canAdd = isCompatible(nextPosition.categoryIndex, currentRows, currentCols);
            }
            
            if (canAdd) {
                // Add this pointer
                pointers.push(nextPointerIndex);
                addedPointer = true;
                
                // Debug: Check if we're exceeding the 8-pointer limit
                if (pointers.length > 8) {
                    console.error(`\n🚨 TOO MANY POINTERS: ${pointers.length} pointers`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                
                break;
            }
            
            nextPointerIndex++;
        }
        
        // If we couldn't add a pointer, backtrack
        if (!addedPointer) {
            // Remove last pointer
            const removedPointer = pointers.pop();
            const removedPosition = allPositions[removedPointer];
            const removedCategory = filteredCategoryNames[removedPosition.categoryIndex];
            
            console.log(`Backtracking: Removed ${removedCategory} (${removedPosition.isRow ? 'row' : 'col'}) at pointer ${removedPointer}`);
            
            // If we've backtracked to the beginning, we're done
            if (pointers.length === 0) {
                console.log('Backtracking: Reached beginning, search complete');
                break;
            }
            
            // Advance the pointer of the last remaining pointer
            // Special case: first pointer increments by 2 to skip column positions
            const oldPointer = pointers[pointers.length - 1];
            if (pointers.length === 1) {
                pointers[pointers.length - 1] += 2;
            } else {
                pointers[pointers.length - 1]++;
            }
            const newPointer = pointers[pointers.length - 1];
            
            console.log(`Backtracking: Advanced pointer ${pointers.length - 1} from ${oldPointer} to ${newPointer}`);
            
            // Check if the advanced pointer is still valid
            if (pointers[pointers.length - 1] >= allPositions.length) {
                // If we've advanced beyond the array, backtrack further
                pointers.pop();
                if (pointers.length === 0) {
                    break;
                }
                // Continue to next iteration to try advancing the previous pointer
                continue;
            }
            
            // Validate the new pointer state after advancement
            const newRows = [];
            const newCols = [];
            for (const pointer of pointers) {
                const position = allPositions[pointer];
                if (position.isRow) {
                    newRows.push(position.categoryIndex);
                } else {
                    newCols.push(position.categoryIndex);
                }
            }
            
            // Check if the new state violates constraints
            if (newRows.length > 4 || newCols.length > 4 || pointers.length > 8) {
                // If the new state still violates the limits, keep back-tracking/advancing
                continue;               // let the while-loop iterate; it will either
            }                           // advance this pointer further or pop again
            
            // Continue to next iteration to try the advanced pointer
            continue;
        }
        
        // Update progress with nice progress bars
        if (searchCount - lastProgressUpdate >= 1000) {
            // Debug: Check for invalid pointer states
            const currentRows = [];
            const currentCols = [];
            for (const pointer of pointers) {
                // Check if pointer is valid
                if (pointer >= allPositions.length) {
                    console.error(`\n🚨 INVALID POINTER: ${pointer} >= ${allPositions.length}`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                const position = allPositions[pointer];
                if (!position) {
                    console.error(`\n🚨 NULL POSITION: pointer ${pointer} returned null`);
                    console.error(`Pointers: [${pointers.join(', ')}]`);
                    process.exit(1);
                }
                if (position.isRow) {
                    currentRows.push(position.categoryIndex);
                } else {
                    currentCols.push(position.categoryIndex);
                }
            }
            
            // Debug: Log if we have too many rows or columns
            if (currentRows.length > 4 || currentCols.length > 4) {
                console.error(`\n🚨 INVALID STATE: ${currentRows.length} rows, ${currentCols.length} columns`);
                console.error(`Pointers: [${pointers.join(', ')}]`);
                console.error(`Rows: [${currentRows.join(', ')}]`);
                console.error(`Cols: [${currentCols.join(', ')}]`);
                
                // Debug: Check what position 164 actually contains
                if (164 < allPositions.length) {
                    const pos164 = allPositions[164];
                    console.error(`Position 164: ${JSON.stringify(pos164)}`);
                    console.error(`Position 164 isRow: ${pos164.isRow}`);
                }
                
                process.exit(1);
            }
            
            const currentCategories = pointers.map(p => {
                const pos = allPositions[p];
                return `${filteredCategoryNames[pos.categoryIndex]}(${pos.isRow ? 'R' : 'C'})`;
            }).join(', ');
            
            // Calculate available space more conservatively
            const otherElements = `Candidates: ${candidates.length} | `;
            
            // Category list is on a separate line, so we can use most of the terminal width
            // But account for the "Candidates: 262 | " prefix
            const availableSpace = process.stdout.columns - otherElements.length - 20;
            
            let truncatedCategories;
            if (currentCategories.length <= availableSpace) {
                truncatedCategories = currentCategories;
            } else {
                truncatedCategories = currentCategories.substring(0, availableSpace - 3) + '...';
            }
            
            // Calculate progress based on first two pointer positions
            const firstPointerPos = pointers.length > 0 ? pointers[0] : 0;
            const secondPointerPos = pointers.length > 1 ? pointers[1] : 0;
            
            // Calculate progress as a weighted combination of first two pointers
            // First pointer has more weight because it explores the largest space
            const firstWeight = 0.7;
            const secondWeight = 0.3;
            const progress = (firstPointerPos * firstWeight + secondPointerPos * secondWeight) / allPositions.length;
            const progressPercent = (progress * 100).toFixed(1);
            const progressBar = '█'.repeat(Math.floor(progress * 50)) + '░'.repeat(50 - Math.floor(progress * 50));
            
            // Calculate ETA based on this more accurate progress
            const elapsed = Date.now() - searchStart;
            const eta = progress > 0 ? (elapsed / progress) - elapsed : 0;
            const etaHours = Math.floor(eta / 3600000);
            const etaMinutes = Math.floor((eta % 3600000) / 60000);
            const etaSeconds = Math.floor((eta % 60000) / 1000);
            
            // Dynamic line checking - count actual lines printed
            const categoryLine = `Candidates: ${candidates.length} | Categories: ${truncatedCategories}`;
            const linesNeeded = Math.ceil(categoryLine.length / process.stdout.columns);
            
            process.stdout.write('\r\x1b[K');
            process.stdout.write('\x1b[1A\x1b[K');
            process.stdout.write(`Progress: [${progressBar}] ${progressPercent}% (P1:${firstPointerPos}, P2:${secondPointerPos}/${allPositions.length}) - ETA: ${etaHours}h ${etaMinutes}m ${etaSeconds}s\n`);
            process.stdout.write(`Candidates: ${candidates.length} | Categories: ${truncatedCategories}`);
            
            // If category line wraps to multiple lines, clear extra lines
            if (linesNeeded > 1) {
                for (let i = 1; i < linesNeeded; i++) {
                    process.stdout.write('\x1b[1A\x1b[K');
                }
            }
            
            lastProgressUpdate = searchCount;
        }
    }

    const searchTime = Date.now() - searchStart;
    console.log(`\nFound ${candidates.length} candidate puzzles (${searchTime}ms)`);
    
    // Save candidate puzzles for inspection
    if (candidates.length > 0) {
        fs.writeFileSync('candidate_puzzles_incremental_4x4.json', JSON.stringify(candidates, null, 2));
        console.log(`Saved ${candidates.length} candidate puzzles to candidate_puzzles_incremental_4x4.json`);
    }

    // Solve each candidate with progress bars
    const solvedPuzzles = [];
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
            solvedPuzzles.push(solvedPuzzle);
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

    // Save results to file
    if (solvedPuzzles.length > 0) {
        fs.writeFileSync('puzzles_incremental_4x4.json', JSON.stringify(solvedPuzzles, null, 2));
        console.log(`Saved ${solvedPuzzles.length} 4x4 puzzles to puzzles_incremental_4x4.json`);
    }

    // Print summary with timing
    const totalTime = Date.now() - startTime;
    console.log('\n=== TIMING SUMMARY ===');
    console.log(`Data loading: ${loadTime}ms`);
    console.log(`Intersection matrix: ${intersectionTime}ms`);
    console.log(`2-away matrix: ${twoAwayTime}ms`);
    console.log(`Search phase: ${searchTime}ms`);
    console.log(`Solve phase: ${solveTime}ms`);
    console.log(`Total time: ${totalTime}ms`);
    console.log('\n=== RESULTS SUMMARY ===');
    console.log(`4x4: ${solvedPuzzles.length} puzzles`);
}

// Run the incremental solver
findPuzzles(); 