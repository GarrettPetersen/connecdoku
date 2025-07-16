const fs = require('fs');

// ===== CONFIGURATION =====
// Set your desired grid dimensions here
const ROWS = 4;
const COLS = 2;
// =========================

// Load the words data
const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

// Extract categories (excluding pattern-based ones)
const categories = new Set();
for (const wordCategories of Object.values(wordsData)) {
    for (const category of wordCategories) {
        if (!category.startsWith('Starts with ') && !category.startsWith('Ends with ')) {
            categories.add(category);
        }
    }
}

// Create category to words mapping
const categoryToWords = {};
for (const [word, wordCategories] of Object.entries(wordsData)) {
    for (const category of wordCategories) {
        if (!category.startsWith('Starts with ') && !category.startsWith('Ends with ')) {
            if (!categoryToWords[category]) {
                categoryToWords[category] = [];
            }
            categoryToWords[category].push(word);
        }
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
        const sortedCategories = validCategories.sort((a, b) =>
            (categoryToWords[b].length - categoryToWords[a].length)
        );

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

    // Find valid category combinations using graph traversal
    findValidCategoryCombinations(graph, sortedCategories) {
        console.log(`Using graph traversal to find valid ${this.rows}x${this.cols} category combinations...`);
        const combinations = [];
        let processedNodes = 0;
        const totalNodes = sortedCategories.length;

        console.log(`Starting from ${totalNodes} categories as potential row categories...`);

        for (const startCategory of sortedCategories) {
            processedNodes++;

            // Update progress every 10 nodes
            if (processedNodes % 10 === 0) {
                process.stdout.write(createLoadingBar(processedNodes, totalNodes, 50, 'Graph Traversal'));
            }

            // Try this category as a row category
            const rowCategories = [startCategory];
            const connectedCategories = new Set(graph.get(startCategory) || []);

            // Find more row categories that are connected to all column categories
            const additionalRows = this.findAdditionalRowCategories(graph, rowCategories, connectedCategories, sortedCategories);

            if (additionalRows.length >= this.rows - 1) {
                // We have enough row categories, now find column categories
                rowCategories.push(...additionalRows.slice(0, this.rows - 1));

                // Check if all row categories can be used together
                if (!this.canUseCategoriesTogether(rowCategories)) {
                    continue;
                }

                const allConnectedCategories = this.getIntersectionOfConnections(graph, rowCategories);

                if (allConnectedCategories.size >= this.cols) {
                    // Find column categories from the connected ones
                    const columnCategories = this.findColumnCategories(graph, rowCategories, allConnectedCategories, sortedCategories);

                    if (columnCategories.length === this.cols) {
                        // Check if all column categories can be used together
                        if (!this.canUseCategoriesTogether(columnCategories)) {
                            continue;
                        }

                        // Check if row and column categories can be used together
                        const allCategories = [...rowCategories, ...columnCategories];
                        if (!this.canUseCategoriesTogether(allCategories)) {
                            continue;
                        }

                        combinations.push({
                            rowCategories: rowCategories,
                            colCategories: columnCategories
                        });

                        // Limit total combinations to prevent memory issues
                        if (combinations.length >= 100000) {
                            console.log(`Reached limit of 100000 combinations, stopping search...`);
                            return combinations;
                        }
                    }
                }
            }
        }

        // Final progress update
        process.stdout.write(createLoadingBar(totalNodes, totalNodes, 50, 'Graph Traversal') + '\n');
        console.log(`Found ${combinations.length} potential category combinations`);
        return combinations;
    }

    // Find additional row categories that are connected to all potential column categories
    findAdditionalRowCategories(graph, currentRows, connectedCategories, sortedCategories) {
        const additionalRows = [];
        const requiredConnections = Math.max(1, Math.floor(connectedCategories.size * 0.5)); // Relax requirement to 50% of connections

        for (const category of sortedCategories) {
            if (currentRows.includes(category)) continue;

            // Check if this category can be used with current rows
            const testRows = [...currentRows, category];
            if (!this.canUseCategoriesTogether(testRows)) continue;

            // Count how many of the connected categories this row connects to
            const rowConnections = graph.get(category) || new Set();
            let connectionCount = 0;
            for (const connectedCat of connectedCategories) {
                if (rowConnections.has(connectedCat)) {
                    connectionCount++;
                }
            }

            if (connectionCount >= requiredConnections) {
                additionalRows.push(category);
                if (additionalRows.length >= this.rows - 1) break; // We only need more rows
            }
        }

        return additionalRows;
    }

    // Get intersection of connections for all row categories
    getIntersectionOfConnections(graph, rowCategories) {
        const intersection = new Set();
        let first = true;

        for (const rowCat of rowCategories) {
            const connections = graph.get(rowCat) || new Set();
            if (first) {
                // Add all connections from the first row category
                for (const cat of connections) {
                    intersection.add(cat);
                }
                first = false;
            } else {
                // Keep only categories that are connected to ALL row categories
                for (const cat of intersection) {
                    if (!connections.has(cat)) {
                        intersection.delete(cat);
                    }
                }
            }
        }

        return intersection;
    }

    // Find column categories from connected categories
    findColumnCategories(graph, rowCategories, connectedCategories, sortedCategories) {
        const columnCategories = [];
        const sortedConnected = Array.from(connectedCategories).sort((a, b) =>
            (categoryToWords[b].length - categoryToWords[a].length)
        );

        for (const category of sortedConnected) {
            if (columnCategories.length >= this.cols) break; // We only need column categories

            // Check if this category can be used with current column categories
            const testCols = [...columnCategories, category];
            if (!this.canUseCategoriesTogether(testCols)) continue;

            // Check if this category connects to all row categories
            const categoryConnections = graph.get(category) || new Set();
            let connectsToAll = true;
            for (const rowCat of rowCategories) {
                if (!categoryConnections.has(rowCat)) {
                    connectsToAll = false;
                    break;
                }
            }

            if (connectsToAll) {
                columnCategories.push(category);
            }
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

