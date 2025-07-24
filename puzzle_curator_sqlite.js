#!/usr/bin/env node
/* puzzle_curator_sqlite.js  (red-herrings enforced, SQLite version)
   ------------------------------------------------------------------
   • Loads raw layouts from SQLite database
   • Presents only words that are unique to their row+column vs the
     other six categories
   • Lets you curate multiple puzzles in one run
   • Stores every approved puzzle as an element of
       daily_puzzles/puzzles.json
   • Guarantees no duplicate (rows,cols) or (cols,rows) ever saved
   • Shows usage counts for categories and words
   -----------------------------------------------------------------*/

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as prompts from "@inquirer/prompts";
import sqlite3 from "sqlite3";

console.log("Starting puzzle curator (SQLite version)...");

// ──────────────── paths ───────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "puzzles.db");
const OUT_DIR = path.join(__dirname, "daily_puzzles");
const DB_FILE = path.join(OUT_DIR, "puzzles.json");

console.log("Directories:");
console.log("  DB_PATH:", DB_PATH);
console.log("  OUT_DIR:", OUT_DIR);
console.log("  DB_FILE:", DB_FILE);

if (!fs.existsSync(OUT_DIR)) {
    console.log("Creating output directory...");
    fs.mkdirSync(OUT_DIR);
}

// ──────────────── database operations ─────────────────────────────
function openDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
                reject(err);
            } else {
                resolve(db);
            }
        });
    });
}

function getAllPuzzles(db) {
    return new Promise((resolve, reject) => {
        db.all(`
            SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp
            FROM puzzles
            ORDER BY timestamp DESC
        `, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows.map(row => ({
                    rows: [row.row0, row.row1, row.row2, row.row3],
                    cols: [row.col0, row.col1, row.col2, row.col3],
                    hash: row.puzzle_hash,
                    timestamp: row.timestamp
                })));
            }
        });
    });
}

function getRandomPuzzle(db, targetCategory = null) {
    return new Promise((resolve, reject) => {
        let query = `
            SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp
            FROM puzzles
        `;

        let params = [];

        if (targetCategory) {
            query += `
                WHERE row0 = ? OR row1 = ? OR row2 = ? OR row3 = ? 
                   OR col0 = ? OR col1 = ? OR col2 = ? OR col3 = ?
            `;
            params = [targetCategory, targetCategory, targetCategory, targetCategory,
                targetCategory, targetCategory, targetCategory, targetCategory];
        }

        query += ` ORDER BY RANDOM() LIMIT 1`;

        db.get(query, params, (err, row) => {
            if (err) {
                reject(err);
            } else if (row) {
                resolve({
                    rows: [row.row0, row.row1, row.row2, row.row3],
                    cols: [row.col0, row.col1, row.col2, row.col3],
                    hash: row.puzzle_hash,
                    timestamp: row.timestamp
                });
            } else {
                resolve(null);
            }
        });
    });
}

// ──────────────── load / init database ───────────────────────────
console.log("Loading database...");
let db = [];
if (fs.existsSync(DB_FILE)) {
    console.log("Database file exists, loading...");
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    console.log(`Loaded ${db.length} existing puzzles`);
} else {
    console.log("No existing database file found");
}

const canon = arr => [...arr].sort().join("|");
const makeKey = (rows, cols) => canon(rows) + "::" + canon(cols);
const used = new Set(
    db.flatMap(p => [makeKey(p.rows, p.cols), makeKey(p.cols, p.rows)])
);
console.log(`Built used puzzle set with ${used.size} keys`);

// ──────────────── usage tracking ──────────────────────────────────
console.log("Building usage counts...");
function buildUsageCounts() {
    const categoryUsage = {};
    const wordUsage = {};

    // Count usage from existing database
    for (const puzzle of db) {
        // Count categories
        for (const category of [...puzzle.rows, ...puzzle.cols]) {
            categoryUsage[category] = (categoryUsage[category] || 0) + 1;
        }

        // Count words
        for (const row of puzzle.words) {
            for (const word of row) {
                wordUsage[word] = (wordUsage[word] || 0) + 1;
            }
        }
    }

    return { categoryUsage, wordUsage };
}

const { categoryUsage, wordUsage } = buildUsageCounts();
console.log(`Usage tracking built: ${Object.keys(categoryUsage).length} categories, ${Object.keys(wordUsage).length} words`);

// ──────────────── word look-ups ──────────────────────────────────
console.log("Loading categories...");
const categoriesJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "categories.json"))
);
console.log(`Loaded ${Object.keys(categoriesJson).length} categories`);

const catSet = {};  // category → Set of words
for (const [cat, words] of Object.entries(categoriesJson)) {
    catSet[cat] = new Set(words);
}

function uniqueWords(rCat, cCat, allCats) {
    // Get words that are in BOTH row and column categories
    const rowWords = catSet[rCat];
    const colWords = catSet[cCat];
    if (!rowWords || !colWords) return [];

    // Find words that appear in both categories
    let v = [...rowWords].filter(w => colWords.has(w));

    // Filter out any words that appear in ANY other category
    for (const otherCat of allCats) {
        if (otherCat !== rCat && otherCat !== cCat) {
            const otherWords = catSet[otherCat];
            if (otherWords) {
                v = v.filter(w => !otherWords.has(w));
            }
        }
    }
    return v;
}

function validatePuzzle(puzzle) {
    const allCategories = [...puzzle.rows, ...puzzle.cols];

    // Check if all categories exist in our current word list
    for (const category of allCategories) {
        if (!catSet[category]) {
            console.log(`❌ Category "${category}" not found in current word list`);
            return false;
        }
    }

    // Generate words for each cell and check if they're valid
    const words = [];
    for (let i = 0; i < 4; i++) {
        const row = [];
        for (let j = 0; j < 4; j++) {
            const unique = uniqueWords(puzzle.rows[i], puzzle.cols[j], allCategories);
            if (unique.length === 0) {
                console.log(`❌ No valid word found for cell (${i},${j}): ${puzzle.rows[i]} × ${puzzle.cols[j]}`);
                return false;
            }
            row.push(unique[0]);
        }
        words.push(row);
    }

    return true;
}

function formatWithUsage(item, usageCount) {
    const count = usageCount[item] || 0;
    return `${item} (${count})`;
}

function findCommonPrefix(strings) {
    if (strings.length === 0) return "";
    if (strings.length === 1) return strings[0];

    const first = strings[0];
    let commonPrefix = "";

    for (let i = 0; i < first.length; i++) {
        const char = first[i];
        for (let j = 1; j < strings.length; j++) {
            if (strings[j][i] !== char) {
                return commonPrefix;
            }
        }
        commonPrefix += char;
    }

    return commonPrefix;
}

// ──────────────── puzzle selection ────────────────────────────────
async function findBestPuzzle(targetCategory = null) {
    const sqliteDb = await openDatabase();

    try {
        // Get a random puzzle from the database
        const puzzle = await getRandomPuzzle(sqliteDb, targetCategory);
        if (!puzzle) {
            if (targetCategory) {
                console.log(`No puzzles found containing category "${targetCategory}"`);
            } else {
                console.log("No puzzles found in database");
            }
            return null;
        }

        // Check if this puzzle has already been used
        const key = makeKey(puzzle.rows, puzzle.cols);
        const reverseKey = makeKey(puzzle.cols, puzzle.rows);

        if (used.has(key) || used.has(reverseKey)) {
            console.log("Puzzle already used, trying another...");
            return null;
        }

        // Calculate overlap with previously used categories
        const allCategories = [...puzzle.rows, ...puzzle.cols];
        let overlap = 0;
        for (const category of allCategories) {
            if (categoryUsage[category]) {
                overlap += categoryUsage[category];
            }
        }

        return {
            puzzle,
            overlap
        };
    } finally {
        sqliteDb.close();
    }
}

// ──────────────── main curation loop ─────────────────────────────
async function main() {
    console.log("\nStarting puzzle curation...");

    let curated = 0;
    const maxAttempts = 1000;
    let attempts = 0;
    let targetCategory = null;

    while (attempts < maxAttempts) {
        attempts++;

        // Ask user if they want to search for a specific category
        if (curated === 0 || targetCategory === null) {
            const searchChoice = await prompts.select({
                message: "What would you like to do?",
                choices: [
                    { name: "🎲 Find a random puzzle", value: "random" },
                    { name: "🔍 Search for puzzle with specific category", value: "search" },
                    { name: "🛑 Stop curating", value: "stop" }
                ]
            });

            if (searchChoice === "stop") {
                break;
            }

            if (searchChoice === "search") {
                // Get all available categories for tab completion
                const allCategories = Object.keys(categoriesJson).sort();

                // Show random example categories (sorted alphabetically)
                const shuffledCategories = [...allCategories].sort(() => Math.random() - 0.5);
                const exampleCategories = shuffledCategories.slice(0, 10).sort();

                console.log("\nExample categories:");
                exampleCategories.forEach(cat => console.log(`  ${cat}`));
                console.log("  ... and many more\n");

                // Custom tab completion input
                let categoryInput = "";
                let suggestions = [];
                let lastSuggestionLines = 0;

                while (true) {
                    // Clear previous suggestions
                    if (lastSuggestionLines > 0) {
                        for (let i = 0; i < lastSuggestionLines; i++) {
                            process.stdout.write('\x1b[1A\x1b[2K'); // Move up and clear line
                        }
                    }

                    const input = await prompts.input({
                        message: `Enter category name: ${categoryInput}`,
                        validate: (input) => {
                            if (!input.trim()) return "Please enter a category name";
                            if (!allCategories.includes(input.trim())) {
                                return `Category "${input.trim()}" not found.`;
                            }
                            return true;
                        }
                    });

                    // Check if input contains tab character
                    if (input.includes('\t')) {
                        const beforeTab = input.split('\t')[0];
                        const currentInput = categoryInput + beforeTab;

                        // Find matching categories
                        suggestions = allCategories.filter(cat =>
                            cat.toLowerCase().includes(currentInput.toLowerCase())
                        );

                        if (suggestions.length === 1) {
                            // Single match - complete it
                            categoryInput = suggestions[0];
                            console.log(`Completed: ${categoryInput}`);
                            lastSuggestionLines = 1;
                        } else if (suggestions.length > 1) {
                            // Multiple matches - show common prefix
                            const commonPrefix = findCommonPrefix(suggestions);
                            if (commonPrefix.length > currentInput.length) {
                                categoryInput = commonPrefix;
                                console.log(`Partial completion: ${categoryInput}`);
                                lastSuggestionLines = 1;
                            } else {
                                console.log("\nSuggestions:");
                                suggestions.slice(0, 10).forEach(s => console.log(`  ${s}`));
                                lastSuggestionLines = 11; // 1 for "Suggestions:" + 10 for items
                            }
                        } else {
                            console.log("No matches found");
                            lastSuggestionLines = 1;
                        }
                    } else {
                        // No tab - treat as normal input
                        categoryInput = input.trim();
                        break;
                    }
                }

                targetCategory = categoryInput.trim();
                console.log(`🔍 Searching for puzzles containing "${targetCategory}"...`);
            } else {
                targetCategory = null;
            }
        }

        const result = await findBestPuzzle(targetCategory);
        if (!result) {
            if (targetCategory) {
                console.log(`No puzzles found containing category "${targetCategory}"`);
            } else {
                console.log("No suitable puzzle found, trying again...");
            }
            continue;
        }

        const { puzzle, overlap } = result;

        // Validate that the puzzle is still valid with current word list
        if (!validatePuzzle(puzzle)) {
            console.log("❌ Puzzle is no longer valid with current word list, skipping...");
            continue;
        }

        const allCategories = [...puzzle.rows, ...puzzle.cols];

        console.log(`\n--- Puzzle ${curated + 1} (Attempt ${attempts}) ---`);
        console.log(`Overlap with previous puzzles: ${overlap}`);
        console.log(`Categories: ${allCategories.join(", ")}`);

        // Generate words for each cell (we know they exist because validatePuzzle passed)
        const words = [];
        for (let i = 0; i < 4; i++) {
            const row = [];
            for (let j = 0; j < 4; j++) {
                const unique = uniqueWords(puzzle.rows[i], puzzle.cols[j], allCategories);
                row.push(unique[0]); // We know this exists because validatePuzzle passed
            }
            words.push(row);
        }

        // Display the puzzle categories
        console.log("\nPuzzle Categories:");
        console.log("Rows:", puzzle.rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
        console.log("\nCols:", puzzle.cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));

        // Ask user if they want to continue with this puzzle
        const continuePuzzle = await prompts.confirm({
            message: "Continue with this puzzle?",
            default: true
        });

        if (!continuePuzzle) {
            console.log("Skipping puzzle...");
            continue;
        }

        // Build viable word matrix and check if any cell is empty
        console.log("Building viable word matrix...");
        const viableGrid = Array.from({ length: 4 }, () => Array(4));
        let cellOk = true;

        for (let r = 0; r < 4 && cellOk; ++r) {
            for (let c = 0; c < 4; ++c) {
                const opts = uniqueWords(puzzle.rows[r], puzzle.cols[c], allCategories);
                if (!opts.length) {
                    console.log(`  Cell [${r}][${c}] has no valid words`);
                    cellOk = false;
                    break;
                }
                viableGrid[r][c] = opts;
            }
        }

        if (!cellOk) {
            console.log("❌ Puzzle has empty cells, skipping...");
            continue;
        }

        console.log("Viable word matrix built successfully");

        // Curator chooses a word for each intersection
        const chosen = Array.from({ length: 4 }, () => Array(4));
        const usedWords = new Set();

        for (let r = 0; r < 4; ++r) {
            for (let c = 0; c < 4; ++c) {
                // Show current progress
                console.clear();
                console.log("Rows:", puzzle.rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
                console.log("\nCols:", puzzle.cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
                console.log("\nCurrent puzzle state:");
                console.table(chosen);
                console.log(`\nChoosing word for: ${formatWithUsage(puzzle.rows[r], categoryUsage)} × ${formatWithUsage(puzzle.cols[c], categoryUsage)}\n`);

                const opts = viableGrid[r][c].filter(w => !usedWords.has(w));

                let pick;
                if (opts.length === 1) {
                    pick = opts[0];
                    console.log(`auto: ${formatWithUsage(puzzle.rows[r], categoryUsage)} × ${formatWithUsage(puzzle.cols[c], categoryUsage)}  →  ${formatWithUsage(pick, wordUsage)}`);
                } else {
                    console.log(`Showing ${opts.length} options for selection...`);

                    pick = await prompts.select({
                        message: `Pick word for ${formatWithUsage(puzzle.rows[r], categoryUsage)} × ${formatWithUsage(puzzle.cols[c], categoryUsage)}`,
                        choices: opts.map(w => ({
                            value: w,
                            name: formatWithUsage(w, wordUsage)
                        }))
                    });
                }
                chosen[r][c] = pick;
                usedWords.add(pick);
            }
        }

        // Final duplicate check (paranoia)
        if (usedWords.size !== 16) {
            console.log("❌ Duplicate word detected—skip puzzle.");
            continue;
        }

        // Preview & approval
        console.clear();
        console.log("Final Puzzle Review:\n");
        console.log("Rows:", puzzle.rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
        console.log("\nCols:", puzzle.cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
        console.log("\nCompleted puzzle:");
        console.table(chosen);

        console.log("Asking for approval...");
        const approve = await prompts.confirm({ message: "Approve this puzzle?" });
        if (approve) {
            console.log("Puzzle approved, saving...");
            // Add puzzle to database
            const newPuzzle = {
                rows: puzzle.rows,
                cols: puzzle.cols,
                words: chosen
            };

            db.push(newPuzzle);
            used.add(makeKey(puzzle.rows, puzzle.cols));
            used.add(makeKey(puzzle.cols, puzzle.rows));

            // Update usage counts
            for (const category of allCategories) {
                categoryUsage[category] = (categoryUsage[category] || 0) + 1;
            }

            for (const row of chosen) {
                for (const word of row) {
                    wordUsage[word] = (wordUsage[word] || 0) + 1;
                }
            }

            // Save to file
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

            curated++;
            console.log(`✅ Puzzle ${curated} saved!`);
        }

        // Ask if they want to continue
        let continueChoices = [
            { name: "🔄 Continue with new search", value: "continue" },
            { name: "🛑 Stop", value: "stop" }
        ];

        // If we were searching for a specific category, offer to find another with same category
        if (targetCategory) {
            continueChoices.unshift({
                name: `🔍 Find another puzzle with "${targetCategory}"`,
                value: "same_category"
            });
        }

        const continueAnswer = await prompts.select({
            message: `Continue curating? (${curated} puzzles saved)`,
            choices: continueChoices
        });

        if (continueAnswer === "stop") {
            break;
        } else if (continueAnswer === "same_category") {
            // Keep the same target category and continue
            console.log(`🔍 Searching for another puzzle containing "${targetCategory}"...`);
        } else {
            // Reset target category for new search
            targetCategory = null;
        }
    }

    console.log(`\nCurated ${curated} puzzles in ${attempts} attempts.`);
    console.log(`Database saved to ${DB_FILE}`);
}

main().catch(console.error); 