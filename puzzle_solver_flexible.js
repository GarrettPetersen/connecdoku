const fs = require('fs');

// ===== CONFIGURATION =====
// Set your desired grid dimensions here
const ROWS = 4;
const COLS = 3;
// =========================

// Load the words data
const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

// Extract categories (including pattern-based ones)
const categories = new Set();
for (const wordCategories of Object.values(wordsData)) {
    for (const category of wordCategories) {
        categories.add(category);
    }
}

// Create category to words mapping
const categoryToWords = {};
for (const [word, wordCategories] of Object.entries(wordsData)) {
    for (const category of wordCategories) {
        if (!categoryToWords[category]) {
            categoryToWords[category] = [];
        }
        categoryToWords[category].push(word);
    }
}

// Filter categories to only those with at least min(ROWS, COLS) words
const minWordsRequired = Math.min(ROWS, COLS);
const validCategories = Object.keys(categoryToWords).filter(cat =>
    categoryToWords[cat].length >= minWordsRequired
);

console.log(`Found ${validCategories.length} categories with at least ${minWordsRequired} words for ${ROWS}x${COLS} grid`);

// Utility function to create loading bars
function createLoadingBar(current, total, width = 50, label = 'Progress') {
    const percentage = Math.min(100, (current / total) * 100);
    const filledLength = Math.floor((current / total) * width);
    const bar = '█'.repeat(filledLength) + '░'.repeat(width - filledLength);
    return `\r${label}: [${bar}] ${percentage.toFixed(1)}% (${current.toLocaleString()}/${total.toLocaleString()})`;
}

// Graph theory class for finding valid category combinations (flexible version)
class CategoryGraph {
    constructor(rows, cols) {
        this.rows = rows;
        this.cols = cols;
        this.edges = new Map(); // (rowCat, colCat) -> word count
        this.strictSubsets = new Map(); // category -> set of categories it's a strict subset of
        this.findStrictSubsets();
        this.precomputeEdges();
    }

    // Find strict subset relationships between categories
    findStrictSubsets() {
        console.log('Finding strict subset relationships...');
        const categories = Object.keys(categoryToWords);
        let processedPairs = 0;
        const totalPairs = categories.length * categories.length;

        for (const cat1 of categories) {
            for (const cat2 of categories) {
                processedPairs++;

                // Update progress every 1000 pairs
                if (processedPairs % 1000 === 0) {
                    process.stdout.write(createLoadingBar(processedPairs, totalPairs, 50, 'Subset Check'));
                }

                if (cat1 !== cat2) {
                    const words1 = new Set(categoryToWords[cat1] || []);
                    const words2 = new Set(categoryToWords[cat2] || []);

                    // Check if cat1 is a strict subset of cat2
                    if (words1.size > 0 && words2.size > 0) {
                        let isSubset = true;
                        for (const word of words1) {
                            if (!words2.has(word)) {
                                isSubset = false;
                                break;
                            }
                        }

                        if (isSubset && words1.size < words2.size) {
                            // cat1 is a strict subset of cat2
                            if (!this.strictSubsets.has(cat1)) {
                                this.strictSubsets.set(cat1, new Set());
                            }
                            this.strictSubsets.get(cat1).add(cat2);
                        }
                    }
                }
            }
        }

        // Final progress update
        process.stdout.write(createLoadingBar(totalPairs, totalPairs, 50, 'Subset Check') + '\n');

        // Count and display strict subset relationships
        let totalSubsets = 0;
        for (const [cat, supersets] of this.strictSubsets) {
            totalSubsets += supersets.size;
        }
        console.log(`Found ${totalSubsets} strict subset relationships`);
    }

    // Check if two categories can coexist in a puzzle (not strict subset relationship)
    canCoexist(cat1, cat2) {
        if (cat1 === cat2) return false;

        // Check if cat1 is a strict subset of cat2
        const cat1Supersets = this.strictSubsets.get(cat1);
        if (cat1Supersets && cat1Supersets.has(cat2)) {
            return false;
        }

        // Check if cat2 is a strict subset of cat1
        const cat2Supersets = this.strictSubsets.get(cat2);
        if (cat2Supersets && cat2Supersets.has(cat1)) {
            return false;
        }

        return true;
    }

    // Check if two categories have significant overlap
    hasSignificantOverlap(cat1, cat2) {
        if (cat1 === cat2) return false;

        const words1 = new Set(categoryToWords[cat1] || []);
        const words2 = new Set(categoryToWords[cat2] || []);

        let overlapCount = 0;
        for (const word of words1) {
            if (words2.has(word)) {
                overlapCount++;
            }
        }

        // Any overlap is significant
        return overlapCount > 0;
    }

    // Check if categories can be used together in a puzzle
    canUseCategoriesTogether(categories) {
        for (let i = 0; i < categories.length; i++) {
            for (let j = i + 1; j < categories.length; j++) {
                const cat1 = categories[i];
                const cat2 = categories[j];

                // Disallow strict subset relationships only
                if (!this.canCoexist(cat1, cat2)) {
                    return false;
                }
            }
        }
        return true;
    }

    // Precompute edge weights for all category pairs
    precomputeEdges() {
        console.log('Precomputing category pair compatibility...');
        let totalPairs = 0;
        let compatiblePairs = 0;
        let processedPairs = 0;

        // Calculate total pairs first
        for (const rowCat of validCategories) {
            for (const colCat of validCategories) {
                if (rowCat !== colCat) {
                    totalPairs++;
                }
            }
        }

        for (const rowCat of validCategories) {
            for (const colCat of validCategories) {
                if (rowCat !== colCat) {
                    processedPairs++;

                    // Update progress every 1000 pairs
                    if (processedPairs % 1000 === 0) {
                        process.stdout.write(createLoadingBar(processedPairs, totalPairs, 50, 'Edge Computation'));
                    }

                    if (this.canCoexist(rowCat, colCat)) {
                        const wordCount = this.getWordCountForPair(rowCat, colCat);
                        if (wordCount > 0) {
                            this.edges.set(`${rowCat}|${colCat}`, wordCount);
                            compatiblePairs++;
                        }
                    }
                }
            }
        }

        // Final progress update
        process.stdout.write(createLoadingBar(totalPairs, totalPairs, 50, 'Edge Computation') + '\n');
        console.log(`Found ${compatiblePairs} compatible category pairs out of ${totalPairs} total pairs`);
    }

    // Get word count for a pair of categories
    getWordCountForPair(cat1, cat2) {
        const words1 = new Set(categoryToWords[cat1] || []);
        const words2 = new Set(categoryToWords[cat2] || []);

        let count = 0;
        for (const word of words1) {
            if (words2.has(word)) {
                count++;
            }
        }
        return count;
    }

    // Check if categories can form a valid puzzle
    canFormValidPuzzle(rowCategories, colCategories) {
        if (rowCategories.length !== this.rows || colCategories.length !== this.cols) {
            return false;
        }

        // Check if all categories can be used together
        const allCategories = [...rowCategories, ...colCategories];
        if (!this.canUseCategoriesTogether(allCategories)) {
            return false;
        }

        // Check if every row category intersects with every column category
        for (const rowCat of rowCategories) {
            for (const colCat of colCategories) {
                const wordCount = this.getWordCountForPair(rowCat, colCat);
                if (wordCount === 0) {
                    return false;
                }
            }
        }

        return true;
    }

    // Check if categories are almost valid (missing one edge)
    isAlmostValid(rowCategories, colCategories) {
        if (rowCategories.length !== this.rows || colCategories.length !== this.cols) {
            return false;
        }

        // Check if all categories can be used together
        const allCategories = [...rowCategories, ...colCategories];
        if (!this.canUseCategoriesTogether(allCategories)) {
            return false;
        }

        // Count missing edges
        let missingEdges = 0;
        for (const rowCat of rowCategories) {
            for (const colCat of colCategories) {
                const wordCount = this.getWordCountForPair(rowCat, colCat);
                if (wordCount === 0) {
                    missingEdges++;
                }
            }
        }

        return missingEdges === 1; // Exactly one missing edge
    }

    // Check for perfect matching in grid
    hasPerfectMatching(adjacencyMatrix) {
        const matching = new Array(this.cols).fill(-1); // col -> row mapping
        const visited = new Array(this.rows).fill(false);

        // Try to find a perfect matching
        let matchCount = 0;
        for (let row = 0; row < this.rows; row++) {
            visited.fill(false);
            if (this.findAugmentingPath(adjacencyMatrix, row, visited, matching)) {
                matchCount++;
            }
        }

        return matchCount === this.cols; // Perfect matching found
    }

    // Find augmenting path using DFS
    findAugmentingPath(adjacencyMatrix, row, visited, matching) {
        for (let col = 0; col < this.cols; col++) {
            // Check if there's an edge and it's not visited
            if (adjacencyMatrix[row][col] > 0 && !visited[col]) {
                visited[col] = true;

                // If column is unmatched or we can find an augmenting path from its match
                if (matching[col] === -1 ||
                    this.findAugmentingPath(adjacencyMatrix, matching[col], visited, matching)) {
                    matching[col] = row;
                    return true;
                }
            }
        }
        return false;
    }

    // Get valid category combinations that can form puzzles
    getValidCategoryCombinations() {
        console.log(`Finding valid ${this.rows}x${this.cols} category combinations using graph traversal...`);
        const validCombinations = [];
        const almostValidCombinations = [];
        const seenHashes = new Set();

        // Sort categories by number of words (most words first - easier to solve)
        const sortedCategories = validCategories.sort((a, b) => {
            const aWords = categoryToWords[a].length;
            const bWords = categoryToWords[b].length;
            if (aWords !== bWords) {
                return bWords - aWords;
            }
            // Secondary sort by category name for stability
            return a.localeCompare(b);
        });

        console.log(`Categories sorted by word count (most words first):`);
        sortedCategories.slice(0, 10).forEach((cat, i) => {
            console.log(`  ${i + 1}. ${cat}: ${categoryToWords[cat].length} words`);
        });

        // Build a graph of category relationships
        console.log('Building category relationship graph...');
        const graph = this.buildCategoryGraph();

        // Find valid category combinations using graph traversal
        console.log(`Finding valid ${this.rows}x${this.cols} category combinations using graph traversal...`);
        const combinations = this.findValidCategoryCombinations(graph, sortedCategories);

        console.log(`Found ${combinations.length} potential category combinations`);

        // Convert to row/column format and validate
        let combinationsChecked = 0;
        const totalCombinations = combinations.length;

        for (const combination of combinations) {
            combinationsChecked++;
            // Update progress every 10 combinations
            if (combinationsChecked % 10 === 0) {
                process.stdout.write(createLoadingBar(combinationsChecked, totalCombinations, 50, 'Combination Validation'));
            }
            const hash = [...combination.rowCategories, ...combination.colCategories].sort().join('|');
            if (seenHashes.has(hash)) continue;
            if (this.canFormValidPuzzle(combination.rowCategories, combination.colCategories)) {
                validCombinations.push(combination);
                seenHashes.add(hash);
            } else if (this.isAlmostValid(combination.rowCategories, combination.colCategories)) {
                almostValidCombinations.push({ ...combination, missingEdges: [] });
                seenHashes.add(hash);
            }
        }

        // Final progress update
        process.stdout.write(createLoadingBar(totalCombinations, totalCombinations, 50, 'Combination Validation') + '\n');
        console.log(`Found ${validCombinations.length} valid category combinations and ${almostValidCombinations.length} almost valid combinations`);

        return [...validCombinations, ...almostValidCombinations];
    }

    // Build category graph
    buildCategoryGraph() {
        const graph = new Map();
        for (const cat1 of validCategories) {
            graph.set(cat1, new Set());
            for (const cat2 of validCategories) {
                if (cat1 !== cat2) {
                    if (!this.canCoexist(cat1, cat2)) {
                        continue;
                    }
                    const edgeKey = `${cat1}|${cat2}`;
                    const wordCount = this.edges.get(edgeKey) || 0;
                    if (wordCount > 0) {
                        graph.get(cat1).add(cat2);
                    }
                }
            }
        }
        return graph;
    }

    // Find valid category combinations using constraint-based search
    findValidCategoryCombinations(graph, sortedCategories) {
        console.log(`Using constraint-based search to find valid ${this.rows}x${this.cols} category combinations...`);
        const combinations = [];
        let totalAttempts = 0;
        let foundCombinations = 0;
        const seenHashes = new Set();

        // Sort categories by word count for better performance
        const sortedCategoriesForSearch = validCategories.sort((a, b) => {
            const aWords = categoryToWords[a].length;
            const bWords = categoryToWords[b].length;
            if (aWords !== bWords) {
                return bWords - aWords;
            }
            return a.localeCompare(b);
        });

        const totalFirstRows = sortedCategoriesForSearch.length;
        const barWidth = 50;
        function printLoadingBar(current, total, found, currentCategories = []) {
            const percent = Math.min(1, current / total);
            const filled = Math.floor(percent * barWidth);
            const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

            // Build the base line without categories
            const baseLine = `Progress: [${bar}] ${(percent * 100).toFixed(1)}% (${current}/${total}) | Valid: ${found.toLocaleString()}`;

            // Calculate available space for categories
            const maxWidth = process.stdout.columns || 120;
            const availableSpace = maxWidth - baseLine.length - 15; // 15 for " | Checking: "

            let categoryInfo = '';
            if (currentCategories.length > 0 && availableSpace > 10) {
                // Truncate category names more aggressively
                const truncatedCategories = currentCategories.map(cat => {
                    if (cat.length > 8) return cat.substring(0, 5) + '...';
                    return cat;
                });

                // Join and truncate if still too long
                let categoryDisplay = truncatedCategories.join(', ');
                if (categoryDisplay.length > availableSpace) {
                    categoryDisplay = categoryDisplay.substring(0, availableSpace - 3) + '...';
                }

                categoryInfo = ` | Checking: ${categoryDisplay}`;
            }

            const line = baseLine + categoryInfo;
            // Clear the line and write the new content
            process.stdout.write(`\r${line.padEnd(maxWidth)}`);
        }

        console.log(`Starting constraint-based search with ${totalFirstRows} categories...`);

        // Try each category as the first row (only once per category)
        for (const [firstRowIdx, firstRow] of sortedCategoriesForSearch.entries()) {
            totalAttempts++;

            // Update loading bar
            if (firstRowIdx % 1 === 0) {
                printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow]);
            }

            // Find all categories that intersect with firstRow (potential columns)
            // Only consider categories that come AFTER firstRow to avoid duplicates
            const validFirstColumns = sortedCategoriesForSearch.filter((col, idx) =>
                idx > firstRowIdx && // Only consider categories after firstRow
                this.getWordCountForPair(firstRow, col) > 0
            );

            for (const firstCol of validFirstColumns) {
                // Skip if firstCol is a strict subset of firstRow
                const firstRowSupersets = this.strictSubsets.get(firstCol);
                if (firstRowSupersets && firstRowSupersets.has(firstRow)) {
                    continue;
                }

                // Update loading bar with current row and column
                printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow, firstCol]);

                // Find all categories that intersect with firstCol (potential second rows)
                // Only consider categories that come AFTER firstRow to avoid duplicates
                const validSecondRows = sortedCategoriesForSearch.filter((row, idx) =>
                    idx > firstRowIdx && // Only consider categories after firstRow
                    row !== firstCol &&
                    this.getWordCountForPair(row, firstCol) > 0
                );

                for (const secondRow of validSecondRows) {
                    // Skip if secondRow is a strict subset of firstRow or firstCol
                    const secondRowSupersets = this.strictSubsets.get(secondRow);
                    if (secondRowSupersets && (secondRowSupersets.has(firstRow) || secondRowSupersets.has(firstCol))) {
                        continue;
                    }

                    // Update loading bar with current categories
                    printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow, firstCol, secondRow]);

                    // Find all categories that intersect with both firstRow and secondRow (potential second columns)
                    // Only consider categories that come AFTER firstCol to avoid duplicates
                    const firstColIdx = sortedCategoriesForSearch.indexOf(firstCol);
                    const validSecondColumns = sortedCategoriesForSearch.filter((col, idx) =>
                        idx > firstColIdx && // Only consider categories after firstCol
                        col !== secondRow &&
                        this.getWordCountForPair(firstRow, col) > 0 &&
                        this.getWordCountForPair(secondRow, col) > 0
                    );

                    for (const secondCol of validSecondColumns) {
                        // Skip if secondCol is a strict subset of any existing categories
                        const secondColSupersets = this.strictSubsets.get(secondCol);
                        if (secondColSupersets && (secondColSupersets.has(firstRow) || secondColSupersets.has(firstCol) || secondColSupersets.has(secondRow))) {
                            continue;
                        }

                        // Update loading bar with current categories
                        printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow, firstCol, secondRow, secondCol]);

                        // For 4x3 grid, we need 2 more rows and 1 more column
                        const validThirdRows = sortedCategoriesForSearch.filter((row, idx) =>
                            idx > firstRowIdx && // Only consider categories after firstRow
                            row !== firstCol &&
                            row !== secondRow &&
                            row !== secondCol &&
                            this.getWordCountForPair(row, firstCol) > 0 &&
                            this.getWordCountForPair(row, secondCol) > 0
                        );

                        for (const thirdRow of validThirdRows) {
                            // Skip if thirdRow is a strict subset of any existing categories
                            const thirdRowSupersets = this.strictSubsets.get(thirdRow);
                            if (thirdRowSupersets && (thirdRowSupersets.has(firstRow) || thirdRowSupersets.has(firstCol) || thirdRowSupersets.has(secondRow) || thirdRowSupersets.has(secondCol))) {
                                continue;
                            }

                            // Update loading bar with current categories
                            printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow, firstCol, secondRow, secondCol, thirdRow]);

                            const validFourthRows = sortedCategoriesForSearch.filter((row, idx) =>
                                idx > firstRowIdx && // Only consider categories after firstRow
                                row !== firstCol &&
                                row !== secondRow &&
                                row !== secondCol &&
                                row !== thirdRow &&
                                this.getWordCountForPair(row, firstCol) > 0 &&
                                this.getWordCountForPair(row, secondCol) > 0
                            );

                            for (const fourthRow of validFourthRows) {
                                // Skip if fourthRow is a strict subset of any existing categories
                                const fourthRowSupersets = this.strictSubsets.get(fourthRow);
                                if (fourthRowSupersets && (fourthRowSupersets.has(firstRow) || fourthRowSupersets.has(firstCol) || fourthRowSupersets.has(secondRow) || fourthRowSupersets.has(secondCol) || fourthRowSupersets.has(thirdRow))) {
                                    continue;
                                }

                                // Update loading bar with current categories
                                printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow, firstCol, secondRow, secondCol, thirdRow, fourthRow]);
                                // For 4x3, we need one more column
                                const secondColIdx = sortedCategoriesForSearch.indexOf(secondCol);
                                const validThirdColumns = sortedCategoriesForSearch.filter((col, idx) =>
                                    idx > secondColIdx && // Only consider categories after secondCol
                                    col !== firstRow &&
                                    col !== secondRow &&
                                    col !== thirdRow &&
                                    col !== fourthRow &&
                                    this.getWordCountForPair(firstRow, col) > 0 &&
                                    this.getWordCountForPair(secondRow, col) > 0 &&
                                    this.getWordCountForPair(thirdRow, col) > 0 &&
                                    this.getWordCountForPair(fourthRow, col) > 0
                                );

                                for (const thirdCol of validThirdColumns) {
                                    // Skip if thirdCol is a strict subset of any existing categories
                                    const thirdColSupersets = this.strictSubsets.get(thirdCol);
                                    if (thirdColSupersets && (thirdColSupersets.has(firstRow) || thirdColSupersets.has(firstCol) || thirdColSupersets.has(secondRow) || thirdColSupersets.has(secondCol) || thirdColSupersets.has(thirdRow) || thirdColSupersets.has(fourthRow))) {
                                        continue;
                                    }

                                    // Update loading bar with current categories
                                    printLoadingBar(firstRowIdx + 1, totalFirstRows, foundCombinations, [firstRow, firstCol, secondRow, secondCol, thirdRow, fourthRow, thirdCol]);

                                    // We have a complete 4x3 combination
                                    const rowCategories = [firstRow, secondRow, thirdRow, fourthRow];
                                    const colCategories = [firstCol, secondCol, thirdCol];

                                    // Check if all categories can be used together (no strict subsets)
                                    const allCategories = [...rowCategories, ...colCategories];
                                    if (!this.canUseCategoriesTogether(allCategories)) {
                                        continue;
                                    }

                                    // Verify all intersections have at least one word
                                    let allIntersectionsValid = true;
                                    for (const rowCat of rowCategories) {
                                        for (const colCat of colCategories) {
                                            if (this.getWordCountForPair(rowCat, colCat) === 0) {
                                                allIntersectionsValid = false;
                                                break;
                                            }
                                        }
                                        if (!allIntersectionsValid) break;
                                    }

                                    if (allIntersectionsValid) {
                                        // Create a canonical hash to avoid duplicates
                                        const rowHash = rowCategories.sort().join('|');
                                        const colHash = colCategories.sort().join('|');
                                        const combinationHash = `${rowHash}||${colHash}`;

                                        if (!seenHashes.has(combinationHash)) {
                                            combinations.push({
                                                rowCategories: rowCategories,
                                                colCategories: colCategories
                                            });
                                            seenHashes.add(combinationHash);
                                            foundCombinations++;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Final progress update
        printLoadingBar(totalFirstRows, totalFirstRows, foundCombinations, []);
        process.stdout.write('\n');
        console.log(`\nConstraint-based search completed!`);
        console.log(`Total first rows attempted: ${totalAttempts}`);
        console.log(`Found ${combinations.length} unique valid category combinations`);
        return combinations;
    }

    // Find additional row categories that are connected to all potential column categories
    findAdditionalRowCategories(graph, currentRows, connectedCategories, sortedCategories) {
        const additionalRows = [];

        for (const category of sortedCategories) {
            if (currentRows.includes(category)) continue;

            // Check if this category can be used with current rows
            const testRows = [...currentRows, category];
            if (!this.canUseCategoriesTogether(testRows)) continue;

            // Much less restrictive: just add any category that can be used with current rows
            additionalRows.push(category);
            if (additionalRows.length >= this.rows - 1) break; // We only need more rows
        }

        return additionalRows;
    }

    // Get intersection of connections for all row categories
    getIntersectionOfConnections(graph, rowCategories) {
        // Much less restrictive: return all categories as potential columns
        const allCategories = new Set(validCategories);

        // Only exclude categories that are already used as rows
        for (const rowCat of rowCategories) {
            allCategories.delete(rowCat);
        }

        return allCategories;
    }

    // Find column categories from connected categories
    findColumnCategories(graph, rowCategories, connectedCategories, sortedCategories) {
        const columnCategories = [];
        const sortedConnected = Array.from(connectedCategories).sort((a, b) => {
            const aWords = categoryToWords[a].length;
            const bWords = categoryToWords[b].length;
            if (aWords !== bWords) {
                return bWords - aWords;
            }
            // Secondary sort by category name for stability
            return a.localeCompare(b);
        });

        for (const category of sortedConnected) {
            if (columnCategories.length >= this.cols) break; // We only need column categories

            // Check if this category can be used with current column categories
            const testCols = [...columnCategories, category];
            if (!this.canUseCategoriesTogether(testCols)) continue;

            // Much less restrictive: just add any category that can be used with current columns
            columnCategories.push(category);
        }

        return columnCategories;
    }
}

// Puzzle solver class for flexible grids
class PuzzleSolver {
    constructor(rows, cols, maxIterations = 100000000) {
        this.rows = rows;
        this.cols = cols;
        this.maxIterations = maxIterations;
        this.validPuzzles = [];
        this.iterationCount = 0;
    }

    // Get words that belong to both categories
    getWordsForCategories(cat1, cat2) {
        const words1 = new Set(categoryToWords[cat1] || []);
        const words2 = new Set(categoryToWords[cat2] || []);

        const intersection = [];
        for (const word of words1) {
            if (words2.has(word)) {
                intersection.push(word);
            }
        }
        return intersection;
    }

    // Check if a word is already used in the grid
    isWordUsed(grid, word) {
        for (let i = 0; i < this.rows; i++) {
            for (let j = 0; j < this.cols; j++) {
                if (grid[i][j] === word) {
                    return true;
                }
            }
        }
        return false;
    }

    // Check if a word can be placed in a specific cell
    canPlaceWord(grid, word, row, col, rowCategories, colCategories) {
        const rowCat = rowCategories[row];
        const colCat = colCategories[col];

        // Check if word belongs to both categories
        const wordCategories = wordsData[word] || [];
        const belongsToRowCat = wordCategories.includes(rowCat);
        const belongsToColCat = wordCategories.includes(colCat);

        if (!belongsToRowCat || !belongsToColCat) {
            return false;
        }

        // Check if word is already used anywhere in the grid
        if (this.isWordUsed(grid, word)) {
            return false;
        }

        // Check if word belongs to any category that's already assigned to a different row or column
        for (let i = 0; i < this.rows; i++) {
            if (i !== row) {
                const otherRowCat = rowCategories[i];
                if (wordCategories.includes(otherRowCat)) {
                    return false;
                }
            }
        }
        for (let j = 0; j < this.cols; j++) {
            if (j !== col) {
                const otherColCat = colCategories[j];
                if (wordCategories.includes(otherColCat)) {
                    return false;
                }
            }
        }

        return true;
    }

    // Get available words for a cell position
    getAvailableWords(grid, row, col, rowCategories, colCategories) {
        const rowCat = rowCategories[row];
        const colCat = colCategories[col];

        if (!rowCat || !colCat) {
            return [];
        }

        const availableWords = this.getWordsForCategories(rowCat, colCat);

        // Filter out words that can't be placed due to category conflicts
        return availableWords.filter(word => this.canPlaceWord(grid, word, row, col, rowCategories, colCategories));
    }

    // Check if grid is complete
    isComplete(grid) {
        for (let i = 0; i < this.rows; i++) {
            for (let j = 0; j < this.cols; j++) {
                if (!grid[i][j]) {
                    return false;
                }
            }
        }
        return true;
    }

    // Find next empty cell
    findNextEmpty(grid) {
        for (let i = 0; i < this.rows; i++) {
            for (let j = 0; j < this.cols; j++) {
                if (!grid[i][j]) {
                    return { row: i, col: j };
                }
            }
        }
        return null;
    }

    // Create a hash for the puzzle
    createPuzzleHash(grid, rowCategories, colCategories) {
        const gridStr = grid.map(row => row.join('|')).join('||');
        const categoriesStr = [...rowCategories, ...colCategories].join('|');
        return `${gridStr}||${categoriesStr}`;
    }

    // Solve the puzzle using backtracking
    solve(grid, rowCategories, colCategories, depth = 0) {
        this.iterationCount++;

        if (this.iterationCount > this.maxIterations) {
            console.log('Reached maximum iterations, stopping...');
            return false;
        }

        if (this.isComplete(grid)) {
            const puzzleHash = this.createPuzzleHash(grid, rowCategories, colCategories);
            const puzzle = {
                grid: grid.map(row => [...row]),
                rowCategories: [...rowCategories],
                colCategories: [...colCategories],
                hash: puzzleHash
            };
            this.validPuzzles.push(puzzle);
            return true;
        }

        const emptyCell = this.findNextEmpty(grid);
        if (!emptyCell) {
            return false;
        }

        const { row, col } = emptyCell;
        const availableWords = this.getAvailableWords(grid, row, col, rowCategories, colCategories);

        for (const word of availableWords) {
            grid[row][col] = word;

            if (this.solve(grid, rowCategories, colCategories, depth + 1)) {
                return true;
            }

            grid[row][col] = null;
        }

        return false;
    }

    // Try to solve puzzles for all valid category combinations
    tryValidCategoryCombinations() {
        const graph = new CategoryGraph(this.rows, this.cols);
        const validCombinations = graph.getValidCategoryCombinations();

        console.log(`\nAttempting to solve ${validCombinations.length} valid category combinations...`);

        let solvedCount = 0;
        let totalAttempts = 0;

        for (const combination of validCombinations) {
            totalAttempts++;

            if (totalAttempts % 10 === 0) {
                console.log(`Attempted ${totalAttempts}/${validCombinations.length} combinations, found ${solvedCount} puzzles`);
            }

            // Initialize empty grid
            const grid = Array(this.rows).fill(null).map(() => Array(this.cols).fill(null));

            if (this.solve(grid, combination.rowCategories, combination.colCategories)) {
                solvedCount++;
                console.log(`Found puzzle ${solvedCount}:`);
                console.log('Row categories:', combination.rowCategories);
                console.log('Column categories:', combination.colCategories);
                console.log('Grid:');
                for (const row of grid) {
                    console.log('  ' + row.join(' | '));
                }
                console.log('');
            }
        }

        console.log(`\nCompleted! Found ${solvedCount} valid ${this.rows}x${this.cols} puzzles out of ${totalAttempts} attempts.`);
        return this.validPuzzles;
    }

    // Save results to file
    saveResults() {
        const outputFile = `valid_puzzles_${this.rows}x${this.cols}.json`;
        const outputData = {
            gridSize: `${this.rows}x${this.cols}`,
            totalPuzzles: this.validPuzzles.length,
            puzzles: this.validPuzzles
        };

        fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
        console.log(`\nSaved ${this.validPuzzles.length} valid ${this.rows}x${this.cols} puzzles to ${outputFile}`);
    }
}

// Main execution
console.log(`Starting ${ROWS}x${COLS} puzzle solver...\n`);

const solver = new PuzzleSolver(ROWS, COLS);
const puzzles = solver.tryValidCategoryCombinations();
solver.saveResults();

console.log(`\n${ROWS}x${COLS} puzzle solver completed!`);

