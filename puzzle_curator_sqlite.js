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
import readline from "readline";

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
                WHERE LOWER(row0) = ? OR LOWER(row1) = ? OR LOWER(row2) = ? OR LOWER(row3) = ? 
                   OR LOWER(col0) = ? OR LOWER(col1) = ? OR LOWER(col2) = ? OR LOWER(col3) = ?
            `;
            const lowerCategory = targetCategory.toLowerCase();
            params = [lowerCategory, lowerCategory, lowerCategory, lowerCategory,
                lowerCategory, lowerCategory, lowerCategory, lowerCategory];
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
        console.log("Searching for puzzle with minimal category overlap...");

        let bestPuzzle = null;
        let bestOverlap = Infinity;
        let puzzlesChecked = 0;
        const maxChecks = 100; // Check up to 100 random puzzles

        while (puzzlesChecked < maxChecks) {
            // Get a random puzzle from the database
            const puzzle = await getRandomPuzzle(sqliteDb, targetCategory);
            if (!puzzle) {
                // If we've checked some puzzles but found none, return null
                if (puzzlesChecked > 0) {
                    console.log(`No more puzzles found after checking ${puzzlesChecked} puzzles`);
                    return null;
                }
                // If we haven't found any puzzles at all, return null immediately
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
                continue; // Skip already used puzzles
            }

            // Calculate overlap with previously used categories
            const allCategories = [...puzzle.rows, ...puzzle.cols];
            let overlap = 0;
            for (const category of allCategories) {
                if (categoryUsage[category]) {
                    overlap += categoryUsage[category];
                }
            }

            puzzlesChecked++;

            // If we find a puzzle with 0 overlap, use it immediately
            if (overlap === 0) {
                console.log(`✅ Found puzzle with 0 overlap after checking ${puzzlesChecked} puzzles`);
                return { puzzle, overlap: 0 };
            }

            // Keep track of the puzzle with the lowest overlap so far
            if (overlap < bestOverlap) {
                bestOverlap = overlap;
                bestPuzzle = puzzle;
                console.log(`  New best: puzzle with ${overlap} overlaps (checked ${puzzlesChecked})`);
            }

            // Show progress every 20 puzzles
            if (puzzlesChecked % 20 === 0) {
                console.log(`  Checked ${puzzlesChecked}/${maxChecks} puzzles, best overlap so far: ${bestOverlap}`);
            }
        }

        if (bestPuzzle) {
            console.log(`🏆 Best puzzle found: ${bestOverlap} category overlaps after checking ${puzzlesChecked} puzzles`);
            return { puzzle: bestPuzzle, overlap: bestOverlap };
        }

        console.log("❌ No suitable puzzles found");
        return null;
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

                // Custom input with TAB completion using readline
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                let categoryInput = "";

                const getInputWithTabCompletion = () => {
                    return new Promise((resolve) => {
                        // Set up raw mode to capture TAB key
                        process.stdin.setRawMode(true);
                        process.stdin.resume();
                        process.stdin.setEncoding('utf8');

                        let input = categoryInput;
                        let cursorPos = input.length;

                        const displayInput = () => {
                            process.stdout.write('\r\x1b[K'); // Clear line
                            process.stdout.write(`Enter category name: ${input}`);
                            // Position cursor
                            process.stdout.write('\r');
                            process.stdout.write(`Enter category name: ${input.substring(0, cursorPos)}`);
                        };

                        displayInput();

                        const handleKey = (key) => {
                            if (key === '\u0003') { // Ctrl+C
                                process.exit();
                            } else if (key === '\r' || key === '\n') { // Enter
                                process.stdin.setRawMode(false);
                                process.stdin.pause();
                                resolve(input);
                            } else if (key === '\u007f') { // Backspace
                                if (cursorPos > 0) {
                                    input = input.substring(0, cursorPos - 1) + input.substring(cursorPos);
                                    cursorPos--;
                                    displayInput();
                                }
                            } else if (key === '\t') { // TAB
                                // Find matching categories (case-insensitive)
                                const matches = allCategories.filter(cat =>
                                    cat.toLowerCase().startsWith(input.toLowerCase())
                                );

                                if (matches.length === 1) {
                                    // Single match - complete it with correct case
                                    input = matches[0];
                                    cursorPos = input.length;
                                    displayInput();
                                } else if (matches.length > 1) {
                                    // Multiple matches - find common prefix
                                    const commonPrefix = findCommonPrefix(matches);
                                    if (commonPrefix.length > input.length) {
                                        // Extend to common prefix
                                        input = commonPrefix;
                                        cursorPos = input.length;
                                        displayInput();
                                    } else {
                                        // Show suggestions only if we can't extend further
                                        process.stdout.write('\n');
                                        console.log("Suggestions:");
                                        matches.slice(0, 5).forEach(match => {
                                            console.log(`  ${match}`);
                                        });
                                        if (matches.length > 5) {
                                            console.log(`  ... and ${matches.length - 5} more`);
                                        }
                                        displayInput();
                                    }
                                }
                            } else if (key.length === 1) { // Regular character
                                input = input.substring(0, cursorPos) + key + input.substring(cursorPos);
                                cursorPos++;
                                displayInput();
                            }
                        };

                        process.stdin.on('data', handleKey);
                    });
                };

                categoryInput = await getInputWithTabCompletion();
                rl.close();

                targetCategory = categoryInput.trim();
                console.log(`🔍 Searching for puzzles containing "${targetCategory}"...`);
            } else {
                targetCategory = null;
            }
        }

        const result = await findBestPuzzle(targetCategory);
        if (!result) {
            if (targetCategory) {
                console.log(`❌ No puzzles found containing category "${targetCategory}"`);
                console.log("💡 Try searching for a different category or use random puzzles");
                // Reset target category to avoid infinite loop
                targetCategory = null;
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