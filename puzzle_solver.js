const fs = require('fs');

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

// Filter categories to only those with at least 4 words
const validCategories = Object.keys(categoryToWords).filter(cat =>
    categoryToWords[cat].length >= 4
);

console.log(`Found ${validCategories.length} categories with at least 4 words`);

// Utility function to create loading bars
function createLoadingBar(current, total, width = 50, label = 'Progress') {
    const percentage = Math.min(100, (current / total) * 100);
    const filledLength = Math.floor((current / total) * width);
    const bar = '█'.repeat(filledLength) + '░'.repeat(width - filledLength);
    return `\r${label}: [${bar}] ${percentage.toFixed(1)}% (${current.toLocaleString()}/${total.toLocaleString()})`;
}

// Graph theory class for finding valid category combinations
class CategoryGraph {
    constructor() {
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

        // Show some examples
        let examplesShown = 0;
        for (const [cat, supersets] of this.strictSubsets) {
            if (examplesShown < 5) {
                console.log(`  ${cat} is a strict subset of: ${Array.from(supersets).join(', ')}`);
                examplesShown++;
            }
        }

        // Debug: Check Birds vs Types of Animals specifically
        const birds = new Set(categoryToWords['Birds'] || []);
        const typesOfAnimals = new Set(categoryToWords['Types of Animals'] || []);
        console.log(`\nDEBUG: Birds has ${birds.size} words, Types of Animals has ${typesOfAnimals.size} words`);
        let allBirdsInTypes = true;
        for (const bird of birds) {
            if (!typesOfAnimals.has(bird)) {
                console.log(`  Bird not in Types of Animals: ${bird}`);
                allBirdsInTypes = false;
            }
        }
        console.log(`All birds in Types of Animals: ${allBirdsInTypes}`);
        if (allBirdsInTypes && birds.size < typesOfAnimals.size) {
            console.log('Birds SHOULD be a strict subset of Types of Animals');
        } else {
            console.log('Birds is NOT a strict subset of Types of Animals');
        }
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

    // Check if two categories have significant overlap (more than 50% of words in common)
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

        // Any overlap is significant (changed from 50% threshold)
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

        console.log(`Total category pairs to check: ${totalPairs.toLocaleString()}`);

        for (const rowCat of validCategories) {
            for (const colCat of validCategories) {
                if (rowCat !== colCat) {
                    processedPairs++;

                    // Update progress every 1000 pairs or every 1%
                    if (processedPairs % 1000 === 0 || processedPairs % Math.max(1, Math.floor(totalPairs / 100)) === 0) {
                        process.stdout.write(createLoadingBar(processedPairs, totalPairs, 50, 'Category Pair Check'));
                    }

                    // Skip if categories can't coexist due to strict subset relationship
                    if (!this.canCoexist(rowCat, colCat)) {
                        continue;
                    }

                    const wordCount = this.getWordCountForPair(rowCat, colCat);
                    if (wordCount > 0) {
                        this.edges.set(`${rowCat}|${colCat}`, wordCount);
                        compatiblePairs++;
                    }
                }
            }
        }

        // Final progress update
        process.stdout.write(createLoadingBar(totalPairs, totalPairs, 50, 'Category Pair Check') + '\n');
        console.log(`Found ${compatiblePairs} compatible category pairs out of ${totalPairs} total pairs (after subset filtering)`);
    }

    // Get number of words that belong to both categories
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

    // Check if a set of row and column categories can form a valid puzzle
    canFormValidPuzzle(rowCategories, colCategories) {
        // Quick check: if any intersection has 0 words, this combination is impossible
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                const edgeKey = `${rowCategories[i]}|${colCategories[j]}`;
                const wordCount = this.edges.get(edgeKey) || 0;
                if (wordCount === 0) {
                    return false; // Early termination - impossible combination
                }
            }
        }

        // Build adjacency matrix for the bipartite graph
        const adjacencyMatrix = [];
        for (let i = 0; i < 4; i++) {
            adjacencyMatrix[i] = [];
            for (let j = 0; j < 4; j++) {
                const edgeKey = `${rowCategories[i]}|${colCategories[j]}`;
                const wordCount = this.edges.get(edgeKey) || 0;
                adjacencyMatrix[i][j] = wordCount;
            }
        }

        // Check if we can find a perfect matching with at least 1 word per cell
        return this.hasPerfectMatching(adjacencyMatrix);
    }

    // Check if bipartite graph has a perfect matching using Hungarian algorithm
    hasPerfectMatching(adjacencyMatrix) {
        const n = 4;
        const matching = new Array(n).fill(-1); // col -> row mapping
        const visited = new Array(n).fill(false);

        // Try to find a perfect matching
        let matchCount = 0;
        for (let row = 0; row < n; row++) {
            visited.fill(false);
            if (this.findAugmentingPath(adjacencyMatrix, row, visited, matching)) {
                matchCount++;
            }
        }

        return matchCount === n; // Perfect matching found
    }

    // Find augmenting path using DFS
    findAugmentingPath(adjacencyMatrix, row, visited, matching) {
        const n = 4;

        for (let col = 0; col < n; col++) {
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
        console.log('Finding valid category combinations using graph traversal...');
        const validCombinations = [];

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
        console.log('Finding valid category combinations using graph traversal...');
        const combinations = this.findValidCategoryCombinations(graph, sortedCategories);

        console.log(`Found ${combinations.length} valid category combinations`);

        // Convert to row/column format and validate
        let combinationsChecked = 0;
        const totalCombinations = combinations.length;

        for (const combination of combinations) {
            combinationsChecked++;

            // Update progress every 10 combinations
            if (combinationsChecked % 10 === 0) {
                process.stdout.write(createLoadingBar(combinationsChecked, totalCombinations, 50, 'Combination Validation'));
            }

            if (this.canFormValidPuzzle(combination.rowCategories, combination.colCategories)) {
                validCombinations.push(combination);

                // Stop if we found enough valid combinations
                if (validCombinations.length >= 100) {
                    process.stdout.write(createLoadingBar(totalCombinations, totalCombinations, 50, 'Combination Validation') + '\n');
                    console.log(`\nFound ${validCombinations.length} valid combinations, stopping search`);
                    return validCombinations;
                }
            }
        }

        // Final progress update
        process.stdout.write(createLoadingBar(totalCombinations, totalCombinations, 50, 'Combination Validation') + '\n');
        console.log(`Found ${validCombinations.length} valid category combinations out of ${combinationsChecked.toLocaleString()} checked`);
        return validCombinations;
    }

    // Find valid category combinations using graph traversal
    findValidCategoryCombinations(graph, sortedCategories) {
        console.log('Using graph traversal to find valid category combinations...');
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

            console.log(`\nTrying ${startCategory} as row category. Connected to ${connectedCategories.size} categories:`,
                Array.from(connectedCategories).slice(0, 5).join(', ') + (connectedCategories.size > 5 ? '...' : ''));

            // Find 3 more row categories that are connected to all column categories
            const additionalRows = this.findAdditionalRowCategories(graph, rowCategories, connectedCategories, sortedCategories);

            console.log(`Found ${additionalRows.length} additional row categories:`, additionalRows.join(', '));

            if (additionalRows.length >= 3) {
                // We have 4 row categories, now find 4 column categories
                rowCategories.push(...additionalRows.slice(0, 3));

                // Check if all row categories can be used together
                if (!this.canUseCategoriesTogether(rowCategories)) {
                    console.log(`Skipping - row categories have conflicts: ${rowCategories.join(', ')}`);
                    continue;
                }

                const allConnectedCategories = this.getIntersectionOfConnections(graph, rowCategories);

                console.log(`Intersection of all row connections: ${allConnectedCategories.size} categories`);

                if (allConnectedCategories.size >= 4) {
                    // Find 4 column categories from the connected ones
                    const columnCategories = this.findColumnCategories(graph, rowCategories, allConnectedCategories, sortedCategories);

                    console.log(`Selected ${columnCategories.length} column categories:`, columnCategories.join(', '));

                    if (columnCategories.length === 4) {
                        // Check if all column categories can be used together
                        if (!this.canUseCategoriesTogether(columnCategories)) {
                            console.log(`Skipping - column categories have conflicts: ${columnCategories.join(', ')}`);
                            continue;
                        }

                        // Check if row and column categories can be used together
                        const allCategories = [...rowCategories, ...columnCategories];
                        if (!this.canUseCategoriesTogether(allCategories)) {
                            console.log(`Skipping - row and column categories have conflicts`);
                            continue;
                        }

                        combinations.push({
                            rowCategories: rowCategories,
                            colCategories: columnCategories
                        });

                        console.log(`Found valid combination #${combinations.length}!`);
                        console.log(`Rows: ${rowCategories.join(', ')}`);
                        console.log(`Columns: ${columnCategories.join(', ')}`);

                        // Stop if we found enough combinations
                        if (combinations.length >= 1000) {
                            process.stdout.write(createLoadingBar(totalNodes, totalNodes, 50, 'Graph Traversal') + '\n');
                            console.log(`\nFound ${combinations.length} combinations, stopping search`);
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

        console.log(`Looking for row categories with at least ${requiredConnections} connections (out of ${connectedCategories.size} total)`);

        for (const category of sortedCategories) {
            if (currentRows.includes(category)) continue;

            // Check if this category is connected to enough of the connected categories
            const categoryConnections = graph.get(category) || new Set();
            let connectionCount = 0;

            for (const connectedCat of connectedCategories) {
                if (categoryConnections.has(connectedCat)) {
                    connectionCount++;
                }
            }

            // If this category is connected to enough potential column categories, it's a good row candidate
            if (connectionCount >= requiredConnections) {
                additionalRows.push(category);
                console.log(`  ${category}: ${connectionCount}/${connectedCategories.size} connections`);
                if (additionalRows.length >= 3) break; // We only need 3 more
            }
        }

        return additionalRows;
    }

    // Get the intersection of all connections from the row categories
    getIntersectionOfConnections(graph, rowCategories) {
        if (rowCategories.length === 0) return new Set();

        let intersection = new Set(graph.get(rowCategories[0]) || []);

        for (let i = 1; i < rowCategories.length; i++) {
            const connections = graph.get(rowCategories[i]) || new Set();
            intersection = new Set([...intersection].filter(cat => connections.has(cat)));
        }

        return intersection;
    }

    // Find 4 column categories from the connected categories
    findColumnCategories(graph, rowCategories, connectedCategories, sortedCategories) {
        const columnCandidates = Array.from(connectedCategories);
        const columnCategories = [];

        // Sort candidates by number of connections to row categories (prefer more connected ones)
        columnCandidates.sort((a, b) => {
            const aConnections = this.countConnectionsToRows(graph, a, rowCategories);
            const bConnections = this.countConnectionsToRows(graph, b, rowCategories);
            return bConnections - aConnections;
        });

        console.log(`Column candidates (sorted by connections):`);
        columnCandidates.slice(0, 10).forEach(cat => {
            const connections = this.countConnectionsToRows(graph, cat, rowCategories);
            console.log(`  ${cat}: ${connections}/${rowCategories.length} connections`);
        });

        // Take the first 4 that have at least 2 connections to row categories
        for (const candidate of columnCandidates) {
            if (columnCategories.length >= 4) break;

            // Check if this candidate has good connections to row categories
            const connections = this.countConnectionsToRows(graph, candidate, rowCategories);
            if (connections >= 2) { // Relax requirement to at least 2 connections
                columnCategories.push(candidate);
            }
        }

        return columnCategories.slice(0, 4);
    }

    // Count how many row categories this column category is connected to
    countConnectionsToRows(graph, columnCategory, rowCategories) {
        const columnConnections = graph.get(columnCategory) || new Set();
        let count = 0;

        for (const rowCategory of rowCategories) {
            if (columnConnections.has(rowCategory)) {
                count++;
            }
        }

        return count;
    }

    // Build a graph where nodes are categories and edges represent word overlap
    buildCategoryGraph() {
        console.log('Building category relationship graph...');
        const graph = new Map();
        let processedEdges = 0;
        const totalEdges = validCategories.length * validCategories.length;

        for (const cat1 of validCategories) {
            graph.set(cat1, new Set());
            for (const cat2 of validCategories) {
                processedEdges++;

                // Update progress every 1000 edges
                if (processedEdges % 1000 === 0) {
                    process.stdout.write(createLoadingBar(processedEdges, totalEdges, 50, 'Graph Building'));
                }

                if (cat1 !== cat2) {
                    // Skip if categories can't coexist due to strict subset relationship
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

        // Final progress update
        process.stdout.write(createLoadingBar(totalEdges, totalEdges, 50, 'Graph Building') + '\n');
        return graph;
    }

    // Calculate number of combinations C(n,k)
    calculateCombinations(n, k) {
        if (k > n) return 0;
        if (k === 0 || k === n) return 1;

        let result = 1;
        for (let i = 0; i < k; i++) {
            result = result * (n - i) / (i + 1);
        }
        return Math.floor(result);
    }

    // Get all combinations of size k from array (keeping for reference, but not used in main flow)
    getCombinations(arr, k) {
        if (k === 0) return [[]];
        if (arr.length === 0) return [];

        const [first, ...rest] = arr;
        const withoutFirst = this.getCombinations(rest, k);
        const withFirst = this.getCombinations(rest, k - 1).map(combo => [first, ...combo]);

        return [...withoutFirst, ...withFirst];
    }

    // Check if a set of nodes forms a clique (all connected to each other)
    isClique(graph, nodes) {
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                if (!graph.get(nodes[i]).has(nodes[j])) {
                    return false;
                }
            }
        }
        return true;
    }

    // Generate different ways to split a clique into 4 rows and 4 columns
    generateRowColumnCombinations(clique) {
        const combinations = [];

        // Try different ways to split the 8 categories
        const splits = this.getCombinations(clique, 4);

        for (const rowCategories of splits) {
            const colCategories = clique.filter(cat => !rowCategories.includes(cat));
            combinations.push({
                rowCategories: rowCategories,
                colCategories: colCategories
            });
        }

        return combinations;
    }
}

class PuzzleSolver {
    constructor(maxIterations = 100000000) {
        this.validPuzzles = [];
        this.missingPairs = new Map(); // category pair -> count
        this.iterations = 0;
        this.maxIterations = maxIterations;
        this.graph = new CategoryGraph();
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

    // Check if a word is already used in the puzzle
    isWordUsed(grid, word) {
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (grid[i][j] === word) {
                    return true;
                }
            }
        }
        return false;
    }

    // Check if a word can be placed in a specific cell based on category constraints
    canPlaceWord(grid, word, row, col, rowCategories, colCategories) {
        const rowCat = rowCategories[row];
        const colCat = colCategories[col];

        // Check if word belongs to both categories
        const wordCategories = wordsData[word] || [];
        const belongsToRowCat = wordCategories.includes(rowCat);
        const belongsToColCat = wordCategories.includes(colCat);

        if (!belongsToRowCat || !belongsToColCat) {
            return false; // Word must belong to both categories
        }

        // Check if word is already used anywhere in the grid (prevent duplicates)
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (grid[i][j] === word) {
                    return false; // Word already used somewhere in the grid
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
            return []; // Need both categories assigned
        }

        const availableWords = this.getWordsForCategories(rowCat, colCat);
        return availableWords.filter(word => this.canPlaceWord(grid, word, row, col, rowCategories, colCategories));
    }

    // Check if puzzle is complete
    isComplete(grid) {
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (!grid[i][j]) {
                    return false;
                }
            }
        }
        return true;
    }

    // Find next empty cell
    findNextEmpty(grid) {
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (!grid[i][j]) {
                    return [i, j];
                }
            }
        }
        return null;
    }

    // Create hash for puzzle uniqueness
    createPuzzleHash(grid, rowCategories, colCategories) {
        const words = [];
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                words.push(grid[i][j]);
            }
        }
        const wordHash = words.sort().join('|');
        const categoryHash = [...rowCategories, ...colCategories].sort().join('|');
        return `${wordHash}|${categoryHash}`;
    }

    // Record missing category pair
    recordMissingPair(cat1, cat2, depth, currentPuzzleCategories = null) {
        const pair = [cat1, cat2].sort().join('|');
        if (!this.missingPairs.has(pair)) {
            // Find actual overlapping words between the two categories
            const words1 = new Set(categoryToWords[cat1] || []);
            const words2 = new Set(categoryToWords[cat2] || []);
            const overlappingWords = [];

            for (const word of words1) {
                if (words2.has(word)) {
                    overlappingWords.push(word);
                }
            }

            // Find what other categories the overlapping words belong to
            // Only include categories that are actually being used in the current puzzle attempt
            const wordCategoryConflicts = {};
            for (const word of overlappingWords) {
                const wordCategories = wordsData[word] || [];
                let otherCategories;

                if (currentPuzzleCategories) {
                    // Only show categories that are actually in the current puzzle attempt
                    otherCategories = wordCategories.filter(cat =>
                        cat !== cat1 && cat !== cat2 &&
                        !cat.startsWith('Starts with ') &&
                        !cat.startsWith('Ends with ') &&
                        categoryToWords[cat] && categoryToWords[cat].length >= 4 &&
                        currentPuzzleCategories.includes(cat)
                    );
                } else {
                    // Fallback: show all valid categories (for backward compatibility)
                    otherCategories = wordCategories.filter(cat =>
                        cat !== cat1 && cat !== cat2 &&
                        !cat.startsWith('Starts with ') &&
                        !cat.startsWith('Ends with ') &&
                        categoryToWords[cat] && categoryToWords[cat].length >= 4
                    );
                }

                if (otherCategories.length > 0) {
                    wordCategoryConflicts[word] = otherCategories;
                }
            }

            this.missingPairs.set(pair, {
                count: 0,
                maxDepth: 0,
                overlappingWords: overlappingWords,
                wordCategoryConflicts: wordCategoryConflicts
            });
        }
        const entry = this.missingPairs.get(pair);
        entry.count++;
        entry.maxDepth = Math.max(entry.maxDepth, depth);
    }

    // Solve puzzle using DFS with backtracking
    solve(grid, rowCategories, colCategories, depth = 0) {
        this.iterations++;
        if (this.iterations > this.maxIterations) {
            console.log('Reached max iterations');
            return;
        }

        // Early termination: if we already found a puzzle for this combination, stop
        if (this.validPuzzles.length > 0) {
            return;
        }

        if (this.isComplete(grid)) {
            // Found a valid puzzle!
            const hash = this.createPuzzleHash(grid, rowCategories, colCategories);
            this.validPuzzles.push({
                grid: grid.map(row => [...row]),
                rowCategories: [...rowCategories],
                colCategories: [...colCategories],
                hash: hash
            });
            console.log(`Found puzzle #${this.validPuzzles.length}`);
            return;
        }

        const emptyCell = this.findNextEmpty(grid);
        if (!emptyCell) {
            return;
        }

        const [row, col] = emptyCell;
        const availableWords = this.getAvailableWords(grid, row, col, rowCategories, colCategories);

        if (availableWords.length === 0) {
            // No words available for this cell - record missing pair
            const rowCat = rowCategories[row];
            const colCat = colCategories[col];
            if (rowCat && colCat) {
                // Add debugging for depth 1 failures
                if (depth === 1) {
                    console.log(`DEBUG: Failed at depth 1 for cell (${row},${col})`);
                    console.log(`  Row category: ${rowCat}`);
                    console.log(`  Column category: ${colCat}`);
                    console.log(`  All words in ${rowCat}: ${categoryToWords[rowCat]?.join(', ') || 'none'}`);
                    console.log(`  All words in ${colCat}: ${categoryToWords[colCat]?.join(', ') || 'none'}`);
                    const intersection = this.getWordsForCategories(rowCat, colCat);
                    console.log(`  Intersection: ${intersection.join(', ')}`);
                    console.log(`  Grid so far:`);
                    for (let i = 0; i < 4; i++) {
                        console.log(`    [${grid[i].map(cell => cell || '_').join(', ')}]`);
                    }
                }
                // Get all categories being used in the current puzzle attempt
                const currentPuzzleCategories = [...rowCategories, ...colCategories];
                this.recordMissingPair(rowCat, colCat, depth, currentPuzzleCategories);
            }
            return;
        }

        // Sort words by how many options they leave for remaining cells (prefer words that leave more options)
        const sortedWords = availableWords.sort((a, b) => {
            // Place word a temporarily and count remaining options
            grid[row][col] = a;
            const optionsAfterA = this.countRemainingOptions(grid, rowCategories, colCategories);
            grid[row][col] = null;

            // Place word b temporarily and count remaining options
            grid[row][col] = b;
            const optionsAfterB = this.countRemainingOptions(grid, rowCategories, colCategories);
            grid[row][col] = null;

            return optionsAfterB - optionsAfterA; // Prefer words that leave more options
        });

        // Try each available word (sorted by best first)
        for (const word of sortedWords) {
            grid[row][col] = word;
            this.solve(grid, rowCategories, colCategories, depth + 1);
            grid[row][col] = null; // backtrack

            // Early termination: if we found a puzzle, stop trying more words for this cell
            if (this.validPuzzles.length > 0) {
                return;
            }
        }
    }

    // Count how many word options remain for all empty cells
    countRemainingOptions(grid, rowCategories, colCategories) {
        let totalOptions = 0;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                if (!grid[i][j]) {
                    const options = this.getAvailableWords(grid, i, j, rowCategories, colCategories);
                    totalOptions += options.length;
                }
            }
        }
        return totalOptions;
    }

    // Try category combinations that passed the graph theory pre-filter
    tryValidCategoryCombinations() {
        console.log('Starting puzzle solver with graph theory pre-filtering...');

        // Get valid category combinations using graph theory
        const validCombinations = this.graph.getValidCategoryCombinations();

        if (validCombinations.length === 0) {
            console.log('No valid category combinations found!');
            return;
        }

        console.log(`Trying ${validCombinations.length} valid category combinations...`);

        let currentCombination = 0;
        const totalCombinations = validCombinations.length;
        let successfulCombinations = 0;

        for (const combination of validCombinations) {
            currentCombination++;
            const puzzlesBefore = this.validPuzzles.length;

            // Update progress every combination
            const progress = (currentCombination / totalCombinations * 100).toFixed(2);
            const barLength = 50;
            const filledLength = Math.floor((currentCombination / totalCombinations) * barLength);
            const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
            process.stdout.write(`\rPuzzle Solving: [${bar}] ${progress}% (${currentCombination}/${totalCombinations}) | Puzzles: ${this.validPuzzles.length} | Iterations: ${this.iterations.toLocaleString()}`);

            // Initialize empty grid
            const grid = Array(4).fill().map(() => Array(4).fill(null));

            // Try to solve with these category assignments
            this.solve(grid, combination.rowCategories, combination.colCategories);

            const puzzlesAfter = this.validPuzzles.length;
            if (puzzlesAfter > puzzlesBefore) {
                successfulCombinations++;
                console.log(`\n✓ Found puzzle for combination ${currentCombination}:`);
                console.log(`  Rows: ${combination.rowCategories.join(', ')}`);
                console.log(`  Cols: ${combination.colCategories.join(', ')}`);
            } else {
                console.log(`\n✗ No puzzle found for combination ${currentCombination}:`);
                console.log(`  Rows: ${combination.rowCategories.join(', ')}`);
                console.log(`  Cols: ${combination.colCategories.join(', ')}`);
            }

            if (this.iterations > this.maxIterations && this.maxIterations > 0) {
                console.log('\nStopping due to max iterations');
                return;
            }
        }

        // Final progress update
        const progress = '100';
        const bar = '█'.repeat(50);
        process.stdout.write(`\rPuzzle Solving: [${bar}] ${progress}% (${currentCombination}/${totalCombinations}) | Puzzles: ${this.validPuzzles.length} | Iterations: ${this.iterations.toLocaleString()}\n`);
        console.log(`\nSummary: Found ${successfulCombinations} puzzles out of ${totalCombinations} combinations`);
    }

    // Save results to files
    saveResults() {
        console.log('Saving results to files...');

        // Save valid puzzles
        const puzzleData = this.validPuzzles.map(puzzle => ({
            hash: puzzle.hash,
            grid: puzzle.grid,
            rowCategories: puzzle.rowCategories,
            colCategories: puzzle.colCategories
        }));

        fs.writeFileSync('valid_puzzles.json', JSON.stringify(puzzleData, null, 2));
        console.log(`Saved ${this.validPuzzles.length} valid puzzles`);

        // Save missing pairs
        const missingPairsArray = Array.from(this.missingPairs.entries()).map(([pair, data]) => ({
            categories: pair.split('|'),
            count: data.count,
            maxDepth: data.maxDepth,
            overlappingWords: data.overlappingWords,
            wordCategoryConflicts: data.wordCategoryConflicts
        })).sort((a, b) => b.maxDepth - a.maxDepth); // Sort by depth (closest to completion first)

        fs.writeFileSync('missing_word_pairs.json', JSON.stringify(missingPairsArray, null, 2));
        console.log(`Saved ${missingPairsArray.length} missing category pairs`);
    }
}

// Run the solver
// Set maxIterations to 0 for unlimited iterations, or a number like 100000000 for a cap
const maxIterations = 100000000; // Change to 0 for unlimited
const solver = new PuzzleSolver(maxIterations);
solver.tryValidCategoryCombinations();
solver.saveResults();

console.log(`Total iterations: ${solver.iterations}`);
console.log(`Found ${solver.validPuzzles.length} valid puzzles`);
console.log(`Found ${solver.missingPairs.size} missing category pairs`); 