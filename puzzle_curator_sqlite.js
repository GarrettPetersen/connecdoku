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

function getRandomPuzzle(db) {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp
            FROM puzzles
            ORDER BY RANDOM()
            LIMIT 1
        `, (err, row) => {
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
    const intersection = new Set();
    for (const word of rowWords) {
        if (colWords.has(word)) {
            intersection.add(word);
        }
    }

    // Filter out words that appear in any of the other 6 categories
    const otherCats = allCats.filter(cat => cat !== rCat && cat !== cCat);
    const uniqueWords = [];

    for (const word of intersection) {
        let isUnique = true;
        for (const otherCat of otherCats) {
            const otherWords = catSet[otherCat];
            if (otherWords && otherWords.has(word)) {
                isUnique = false;
                break;
            }
        }
        if (isUnique) {
            uniqueWords.push(word);
        }
    }

    return uniqueWords;
}

function formatWithUsage(item, usageCount) {
    const count = usageCount[item] || 0;
    return `${item} (${count})`;
}

// ──────────────── puzzle selection ────────────────────────────────
async function findBestPuzzle() {
    const sqliteDb = await openDatabase();

    try {
        // Get a random puzzle from the database
        const puzzle = await getRandomPuzzle(sqliteDb);
        if (!puzzle) {
            console.log("No puzzles found in database");
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

    while (attempts < maxAttempts) {
        attempts++;

        const result = await findBestPuzzle();
        if (!result) {
            console.log("No suitable puzzle found, trying again...");
            continue;
        }

        const { puzzle, overlap } = result;
        const allCategories = [...puzzle.rows, ...puzzle.cols];

        console.log(`\n--- Puzzle ${curated + 1} (Attempt ${attempts}) ---`);
        console.log(`Overlap with previous puzzles: ${overlap}`);
        console.log(`Categories: ${allCategories.join(", ")}`);

        // Generate words for each cell
        const words = [];
        for (let i = 0; i < 4; i++) {
            const row = [];
            for (let j = 0; j < 4; j++) {
                const unique = uniqueWords(puzzle.rows[i], puzzle.cols[j], allCategories);
                row.push(unique.length > 0 ? unique[0] : "NO_WORD");
            }
            words.push(row);
        }

        // Display the puzzle
        console.log("\nPuzzle:");
        console.log("Rows:", puzzle.rows);
        console.log("Cols:", puzzle.cols);
        console.log("\nWords:");
        for (let i = 0; i < 4; i++) {
            console.log(`  ${puzzle.rows[i]}: ${words[i].join(" | ")}`);
        }
        console.log("  " + puzzle.cols.map(c => c.padEnd(20)).join(" | "));

        // Check if puzzle is valid (has at least one word in each cell)
        const hasEmptyCells = words.some(row => row.some(word => word === "NO_WORD"));
        if (hasEmptyCells) {
            console.log("❌ Puzzle has empty cells, skipping...");
            continue;
        }

        // Ask user if they want to keep this puzzle
        const answer = await prompts.select({
            message: "Keep this puzzle?",
            choices: [
                { name: "✅ Yes, keep it", value: "yes" },
                { name: "❌ No, skip it", value: "no" },
                { name: "🛑 Stop curating", value: "stop" }
            ]
        });

        if (answer === "stop") {
            break;
        }

        if (answer === "yes") {
            // Add to database
            const newPuzzle = {
                rows: puzzle.rows,
                cols: puzzle.cols,
                words: words
            };

            db.push(newPuzzle);
            used.add(makeKey(puzzle.rows, puzzle.cols));
            used.add(makeKey(puzzle.cols, puzzle.rows));

            // Update usage counts
            for (const category of allCategories) {
                categoryUsage[category] = (categoryUsage[category] || 0) + 1;
            }

            for (const row of words) {
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
        const continueAnswer = await prompts.select({
            message: `Continue curating? (${curated} puzzles saved)`,
            choices: [
                { name: "🔄 Continue", value: "continue" },
                { name: "🛑 Stop", value: "stop" }
            ]
        });

        if (continueAnswer === "stop") {
            break;
        }
    }

    console.log(`\nCurated ${curated} puzzles in ${attempts} attempts.`);
    console.log(`Database saved to ${DB_FILE}`);
}

main().catch(console.error); 