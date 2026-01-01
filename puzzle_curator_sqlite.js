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
import crypto from "crypto";
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
const DEFAULT_QUALITY_SAMPLE = Number(process.env.CURATOR_QUALITY_SAMPLE || 500);
const DEFAULT_MIN_QUALITY = Number(process.env.CURATOR_MIN_QUALITY || 0);
const GOOD_THRESHOLD = Number(process.env.PUZZLE_SCORE_GOOD || 12);
const MEDIUM_THRESHOLD = Number(process.env.PUZZLE_SCORE_MED || 6);
const HIGH_QUALITY_MIN = Number(process.env.CURATOR_HIGH_QUALITY_MIN || 20);

function scoreEmoji(score) {
    if (score >= GOOD_THRESHOLD) return '🟢';
    if (score >= MEDIUM_THRESHOLD) return '🟡';
    return '🔴';
}

function computePuzzleHash(rows, cols) {
    const s = rows.join("|") + cols.join("|");
    return crypto.createHash("sha256").update(s).digest("hex");
}

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
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
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

function getRandomPuzzle(db, targetCategories = null) {
    return new Promise((resolve, reject) => {
        const sampleSize = DEFAULT_QUALITY_SAMPLE;
        let params = [];

        // Build WHERE conditions for categories
        let whereClauses = [];
        if (targetCategories) {
            const categories = Array.isArray(targetCategories) ? targetCategories : [targetCategories];
            if (categories.length === 1) {
                const lowerCategory = categories[0].toLowerCase();
                whereClauses.push(`(LOWER(row0) = ? OR LOWER(row1) = ? OR LOWER(row2) = ? OR LOWER(row3) = ? 
                       OR LOWER(col0) = ? OR LOWER(col1) = ? OR LOWER(col2) = ? OR LOWER(col3) = ?)`);
                params.push(lowerCategory, lowerCategory, lowerCategory, lowerCategory,
                    lowerCategory, lowerCategory, lowerCategory, lowerCategory);
            } else {
                const conditions = [];
                for (const category of categories) {
                    const lowerCategory = category.toLowerCase();
                    conditions.push(`(LOWER(row0) = ? OR LOWER(row1) = ? OR LOWER(row2) = ? OR LOWER(row3) = ? 
                       OR LOWER(col0) = ? OR LOWER(col1) = ? OR LOWER(col2) = ? OR LOWER(col3) = ?)`);
                    params.push(lowerCategory, lowerCategory, lowerCategory, lowerCategory,
                        lowerCategory, lowerCategory, lowerCategory, lowerCategory);
                }
                whereClauses.push(`(${conditions.join(' AND ')})`);
            }
        }
        // Min quality threshold
        whereClauses.push(`COALESCE(puzzle_quality_score, 0) >= ?`);
        params.push(DEFAULT_MIN_QUALITY);

        const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const query = `
            WITH sample AS (
                SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp,
                       COALESCE(puzzle_quality_score, 0) AS q
                FROM puzzles
                ${whereSQL}
                AND ROWID >= (ABS(RANDOM()) % (SELECT MAX(ROWID) FROM puzzles))
                LIMIT ${sampleSize}
            )
            SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp, q
            FROM sample
            ORDER BY q DESC
            LIMIT 1
        `;

        db.get(query, params, (err, row) => {
            if (err) {
                reject(err);
            } else if (row) {
                // Skip if already curated by hash
                if (usedHashes.has(row.puzzle_hash)) {
                    resolve(null);
                    return;
                }
                resolve({
                    rows: [row.row0, row.row1, row.row2, row.row3],
                    cols: [row.col0, row.col1, row.col2, row.col3],
                    hash: row.puzzle_hash,
                    timestamp: row.timestamp,
                    qualityScore: row.q
                });
            } else {
                resolve(null);
            }
        });
    });
}

function getMultipleRandomPuzzles(db, count, targetCategories = null) {
    return new Promise((resolve, reject) => {
        const sampleSize = Math.max(count * 5, DEFAULT_QUALITY_SAMPLE);
        let params = [];

        // Build WHERE conditions
        let whereClauses = [`COALESCE(puzzle_quality_score, 0) >= ?`];
        params.push(DEFAULT_MIN_QUALITY);

        if (targetCategories) {
            const categories = Array.isArray(targetCategories) ? targetCategories : [targetCategories];
            if (categories.length === 1) {
                const lowerCategory = categories[0].toLowerCase();
                whereClauses.push(`(LOWER(row0) = ? OR LOWER(row1) = ? OR LOWER(row2) = ? OR LOWER(row3) = ? 
                       OR LOWER(col0) = ? OR LOWER(col1) = ? OR LOWER(col2) = ? OR LOWER(col3) = ?)`);
                params.push(lowerCategory, lowerCategory, lowerCategory, lowerCategory,
                    lowerCategory, lowerCategory, lowerCategory, lowerCategory);
            } else {
                const conditions = [];
                for (const category of categories) {
                    const lowerCategory = category.toLowerCase();
                    conditions.push(`(LOWER(row0) = ? OR LOWER(row1) = ? OR LOWER(row2) = ? OR LOWER(row3) = ? 
                       OR LOWER(col0) = ? OR LOWER(col1) = ? OR LOWER(col2) = ? OR LOWER(col3) = ?)`);
                    params.push(lowerCategory, lowerCategory, lowerCategory, lowerCategory,
                        lowerCategory, lowerCategory, lowerCategory, lowerCategory);
                }
                whereClauses.push(`(${conditions.join(' AND ')})`);
            }
        }
        const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const query = `
            WITH sample AS (
                SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp,
                       COALESCE(puzzle_quality_score, 0) AS q
                FROM puzzles
                ${whereSQL}
                AND ROWID >= (ABS(RANDOM()) % (SELECT MAX(ROWID) FROM puzzles))
                LIMIT ${sampleSize}
            )
            SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp, q
            FROM sample
            ORDER BY q DESC
            LIMIT ?
        `;
        params.push(count);

        db.all(query, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                const filtered = rows.filter(r => !usedHashes.has(r.puzzle_hash));
                resolve(filtered.map(row => ({
                    rows: [row.row0, row.row1, row.row2, row.row3],
                    cols: [row.col0, row.col1, row.col2, row.col3],
                    hash: row.puzzle_hash,
                    timestamp: row.timestamp,
                    qualityScore: row.q
                })));
            }
        });
    });
}

// Categories that should always be excluded by the secret sauce filter
const ALWAYS_EXCLUDED_CATEGORIES = [
    '21st Century',
    '20th Century',
    '2020s',
    '2010s',
    'Things American',
    'Flower-class Corvettes'
];

function getCategoriesFromLastNDays(numDays) {
    const recentCategories = new Set();

    // Get the last N days of puzzles from the daily puzzles file
    for (const puzzle of db) {
        // Since we don't have timestamps in the daily puzzles file, 
        // we'll use the last N puzzles as a proxy for "recent"
        // This is a reasonable approximation for daily puzzles
    }

    // For now, let's use the last N puzzles as "recent"
    const recentPuzzles = db.slice(-numDays);
    for (const puzzle of recentPuzzles) {
        for (const category of [...puzzle.rows, ...puzzle.cols]) {
            recentCategories.add(category);
        }
    }

    // Always exclude designated categories
    for (const cat of ALWAYS_EXCLUDED_CATEGORIES) {
        recentCategories.add(cat);
    }

    return Array.from(recentCategories);
}

async function findPuzzlesWithNoRecentCategories(sqliteDb, recentCategories, limit = 30) {
    // If no recent categories, just get quality-aware random puzzles
    if (!recentCategories || recentCategories.length === 0) {
        return getMultipleRandomPuzzles(sqliteDb, limit);
    }

    // Build a lowercase exclusion set for fast checks
    const exclusionSet = new Set(recentCategories.map(c => c.toLowerCase()));

    // Start with a reasonably small batch size for speed, then escalate if
    // we don't find enough puzzles, with a hard global cap so we never
    // search "forever" when they don't exist.
    let batchCount = DEFAULT_QUALITY_SAMPLE; // first call: fast path
    const maxBatchCount = DEFAULT_QUALITY_SAMPLE * 4; // escalate up to 4×
    const maxCandidatesChecked = 1_000_000; // absolute cap across all batches
    let candidatesChecked = 0;

    const validPuzzles = [];
    let invalidPuzzlesFound = 0;

    while (validPuzzles.length < limit && candidatesChecked < maxCandidatesChecked) {
        const remainingBudget = maxCandidatesChecked - candidatesChecked;
        const thisBatchCount = Math.min(batchCount, remainingBudget);

        // Grab a quality-aware random batch from SQLite
        const candidates = await getMultipleRandomPuzzles(sqliteDb, thisBatchCount);
        if (!candidates || candidates.length === 0) {
            break;
        }

        candidatesChecked += candidates.length;

        for (const puzzle of candidates) {
            if (validPuzzles.length >= limit) break;

            // Skip already-used hashes across sessions
            if (usedHashes.has(puzzle.hash)) continue;

            const allCategories = [...puzzle.rows, ...puzzle.cols];

            // Enforce "no recent categories" in JS (case-insensitive)
            let overlapsRecent = false;
            for (const cat of allCategories) {
                if (exclusionSet.has(String(cat).toLowerCase())) {
                    overlapsRecent = true;
                    break;
                }
            }
            if (overlapsRecent) continue;

            // Validate the puzzle against current word/meta rules
            if (!validatePuzzle(puzzle)) {
                invalidPuzzlesFound++;
                console.log(`⚠️  Found invalid puzzle in secret sauce search, deleting from database...`);
                // Fire-and-forget delete; don't block selection on this finishing
                deletePuzzleFromDatabase(sqliteDb, puzzle.hash).catch(err => {
                    console.error("Error deleting invalid puzzle:", err.message);
                });
                continue;
            }

            validPuzzles.push(puzzle);
        }

        // If we still don't have enough puzzles, search more aggressively
        if (validPuzzles.length < limit && batchCount < maxBatchCount) {
            batchCount = Math.min(batchCount * 2, maxBatchCount);
        }
    }

    console.log(`Found ${validPuzzles.length} valid puzzles (${invalidPuzzlesFound} invalid ones deleted) after checking ~${candidatesChecked} candidates`);
    return validPuzzles;
}

async function findHighQualityPuzzle() {
    const sqliteDb = await openDatabase();
    try {
        const sampleSize = DEFAULT_QUALITY_SAMPLE * 2;
        const query = `
            WITH sample AS (
                SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp,
                       COALESCE(puzzle_quality_score, 0) AS q
                FROM puzzles
                WHERE COALESCE(puzzle_quality_score, 0) >= ?
                AND ROWID >= (ABS(RANDOM()) % (SELECT MAX(ROWID) FROM puzzles))
                LIMIT ${sampleSize}
            )
            SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, timestamp, q
            FROM sample
            ORDER BY q DESC
            LIMIT 20
        `;
        return await new Promise((resolve, reject) => {
            sqliteDb.all(query, [HIGH_QUALITY_MIN], (err, rows) => {
                if (err) return reject(err);
                if (!rows || rows.length === 0) return resolve(null);
                for (const row of rows) {
                    if (usedHashes.has(row.puzzle_hash)) continue;
                    return resolve({
                        rows: [row.row0, row.row1, row.row2, row.row3],
                        cols: [row.col0, row.col1, row.col2, row.col3],
                        hash: row.puzzle_hash,
                        timestamp: row.timestamp,
                        qualityScore: row.q
                    });
                }
                resolve(null);
            });
        });
    } finally {
        sqliteDb.close();
    }
}

function deletePuzzleFromDatabase(db, puzzleHash) {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM puzzles WHERE puzzle_hash = ?", [puzzleHash], function (err) {
            if (err) {
                console.error("Error deleting puzzle:", err.message);
                reject(err);
            } else {
                console.log(`🗑️  Deleted invalid puzzle ${puzzleHash.substring(0, 8)}...`);
                resolve(this.changes);
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

// Build set of used hashes from existing daily puzzles to skip duplicates across sessions
const usedHashes = new Set();
for (const p of db) {
    const h = computePuzzleHash(p.rows, p.cols);
    usedHashes.add(h);
    usedHashes.add(computePuzzleHash(p.cols, p.rows)); // symmetric
}
console.log(`Built used hash set with ${usedHashes.size} entries`);

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

// Return the top N most-used categories from existing daily puzzles
function getTopUsedCategories(limit = 10) {
    return Object
        .entries(categoryUsage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([cat]) => cat);
}

// ──────────────── word look-ups ──────────────────────────────────
console.log("Loading categories...");
const categoriesJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "categories.json"))
);
console.log(`Loaded ${Object.keys(categoriesJson).length} categories`);

// Load meta-categories for validation
console.log("Loading meta-categories...");
const metaCatsJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "meta_categories.json"))
);
console.log(`Loaded ${Object.keys(metaCatsJson).length} meta-categories`);

// Create meta-category mapping (exclude "No Meta Category")
const metaMap = {};
for (const [metaCat, categories] of Object.entries(metaCatsJson)) {
    if (metaCat !== 'No Meta Category') {
        for (const category of categories) {
            metaMap[category] = metaCat;
        }
    }
}

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

function getExcludedCategories(rCat, cCat, allCats) {
    // Return the list of categories that are being excluded for this intersection
    return allCats.filter(cat => cat !== rCat && cat !== cCat);
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

    // Check meta-category constraints (max 2 per meta-category, except Letter Patterns which is max 1)
    const metaCounts = new Map();
    for (const category of allCategories) {
        const metaCat = metaMap[category];
        if (metaCat) {  // Skip categories not in any meta-category or in "No Meta Category"
            const count = metaCounts.get(metaCat) || 0;
            const maxAllowed = metaCat === "Letter Patterns" ? 1 : 2;
            if (count >= maxAllowed) {
                console.log(`❌ Meta-category constraint violated: "${metaCat}" appears ${count + 1} times (max ${maxAllowed} allowed)`);
                return false;
            }
            metaCounts.set(metaCat, count + 1);
        }
    }

    // Check that each cell intersection has at least one valid word  
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            const unique = uniqueWords(puzzle.rows[i], puzzle.cols[j], allCategories);
            if (unique.length === 0) {
                console.log(`❌ No valid word found for cell (${i},${j}): ${puzzle.rows[i]} × ${puzzle.cols[j]}`);
                return false;
            }
        }
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
async function findBestPuzzle(targetCategories = null) {
    const sqliteDb = await openDatabase();

    try {
        console.log("Searching for puzzle with minimal category overlap...");

        let bestPuzzle = null;
        let bestOverlap = Infinity;
        let puzzlesChecked = 0;
        let invalidPuzzlesFound = 0;
        const maxChecks = 100; // Check up to 100 random puzzles
        const maxInvalidPuzzles = 1000; // Circuit breaker for invalid puzzles (high limit since we're explicitly checking many to find the best)
        const batchSize = 20; // Fetch 20 puzzles at a time

        while (puzzlesChecked < maxChecks && invalidPuzzlesFound < maxInvalidPuzzles) {
            // Get a batch of random puzzles from the database
            const puzzlesToCheck = Math.min(batchSize, maxChecks - puzzlesChecked);
            const puzzles = await getMultipleRandomPuzzles(sqliteDb, puzzlesToCheck, targetCategories);

            if (!puzzles || puzzles.length === 0) {
                // If we've checked some puzzles but found none, return null
                if (puzzlesChecked > 0) {
                    console.log(`No more puzzles found after checking ${puzzlesChecked} puzzles`);
                    return null;
                }
                // If we haven't found any puzzles at all, return null immediately
                if (targetCategories) {
                    const categories = Array.isArray(targetCategories) ? targetCategories : [targetCategories];
                    const categoryDisplay = categories.join('", "');
                    console.log(`No puzzles found containing ALL categories: "${categoryDisplay}"`);
                } else {
                    console.log("No puzzles found in database");
                }
                return null;
            }

            // Process each puzzle in the batch
            for (const puzzle of puzzles) {
                puzzlesChecked++;

                // Check if this puzzle has already been used
                const key = makeKey(puzzle.rows, puzzle.cols);
                const reverseKey = makeKey(puzzle.cols, puzzle.rows);

                if (used.has(key) || used.has(reverseKey)) {
                    continue; // Skip already used puzzles
                }

                // Validate the puzzle first
                if (!validatePuzzle(puzzle)) {
                    invalidPuzzlesFound++;
                    console.log(`⚠️  Found invalid puzzle (${invalidPuzzlesFound}/${maxInvalidPuzzles}), deleting from database...`);

                    // Delete the invalid puzzle from database
                    await deletePuzzleFromDatabase(sqliteDb, puzzle.hash);

                    if (invalidPuzzlesFound >= maxInvalidPuzzles) {
                        console.log("❌ Too many invalid puzzles found, stopping search");
                        return null;
                    }
                    continue; // Try next puzzle
                }

                // Calculate overlap with previously used categories
                const allCategories = [...puzzle.rows, ...puzzle.cols];
                let overlap = 0;
                for (const category of allCategories) {
                    if (categoryUsage[category]) {
                        overlap += categoryUsage[category];
                    }
                }

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
            }

            // Show progress after each batch
            console.log(`  Checked ${puzzlesChecked}/${maxChecks} puzzles, best overlap so far: ${bestOverlap}`);
        }

        if (invalidPuzzlesFound >= maxInvalidPuzzles) {
            console.log("❌ Too many invalid puzzles found, stopping search");
            return null;
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

async function findAnyPuzzleWithCategory(targetCategories, excludedHash = null) {
    const sqliteDb = await openDatabase();

    try {
        // Handle both single category (string) and multiple categories (array)
        const categories = Array.isArray(targetCategories) ? targetCategories : [targetCategories];
        const categoryDisplay = categories.join('", "');
        console.log(`Finding any puzzle with ALL categories: "${categoryDisplay}"...`);

        let attempts = 0;
        let invalidPuzzlesFound = 0;
        const maxAttempts = 50; // Try up to 50 random puzzles with these categories
        const maxInvalidPuzzles = 10; // Circuit breaker for invalid puzzles

        while (attempts < maxAttempts && invalidPuzzlesFound < maxInvalidPuzzles) {
            attempts++;

            // Get a single random puzzle with these categories from the database
            const puzzle = await getRandomPuzzle(sqliteDb, targetCategories);

            if (!puzzle) {
                console.log(`No puzzles found containing ALL categories: "${categoryDisplay}"`);
                return null;
            }

            // Check if this puzzle has already been used
            const key = makeKey(puzzle.rows, puzzle.cols);
            const reverseKey = makeKey(puzzle.cols, puzzle.rows);

            if (used.has(key) || used.has(reverseKey)) {
                continue; // Skip already used puzzles
            }

            // Check if this is the puzzle we want to exclude
            if (excludedHash && puzzle.hash === excludedHash) {
                continue; // Skip the excluded puzzle
            }

            // Validate the puzzle
            if (!validatePuzzle(puzzle)) {
                invalidPuzzlesFound++;
                console.log(`⚠️  Found invalid puzzle (${invalidPuzzlesFound}/${maxInvalidPuzzles}), deleting from database...`);

                // Delete the invalid puzzle from database
                await deletePuzzleFromDatabase(sqliteDb, puzzle.hash);

                if (invalidPuzzlesFound >= maxInvalidPuzzles) {
                    console.log("❌ Too many invalid puzzles found, stopping search");
                    return null;
                }
                continue; // Try next puzzle
            }

            // Calculate overlap with previously used categories (for display only)
            const allCategories = [...puzzle.rows, ...puzzle.cols];
            let overlap = 0;
            for (const category of allCategories) {
                if (categoryUsage[category]) {
                    overlap += categoryUsage[category];
                }
            }

            console.log(`🎲 Found puzzle with ALL categories: "${categoryDisplay}" (${overlap} category overlaps)`);
            return { puzzle, overlap: overlap };
        }

        if (invalidPuzzlesFound >= maxInvalidPuzzles) {
            console.log("❌ Too many invalid puzzles found, stopping search");
        } else {
            console.log(`❌ No unused puzzles found with ALL categories: "${categoryDisplay}" after checking ${maxAttempts} puzzles`);
        }
        return null;
    } finally {
        sqliteDb.close();
    }
}

async function findTrulyRandomPuzzle() {
    const sqliteDb = await openDatabase();

    try {
        console.log("Finding a truly random puzzle...");

        let attempts = 0;
        let invalidPuzzlesFound = 0;
        const maxAttempts = 100; // Try up to 100 random puzzles
        const maxInvalidPuzzles = 10; // Circuit breaker for invalid puzzles (reasonable limit when just looking for 1 random puzzle)

        while (attempts < maxAttempts && invalidPuzzlesFound < maxInvalidPuzzles) {
            attempts++;

            // Get a single random puzzle from the database
            const puzzle = await getRandomPuzzle(sqliteDb);

            if (!puzzle) {
                console.log("No puzzles found in database");
                return null;
            }

            // Check if this puzzle has already been used
            const key = makeKey(puzzle.rows, puzzle.cols);
            const reverseKey = makeKey(puzzle.cols, puzzle.rows);

            if (used.has(key) || used.has(reverseKey)) {
                continue; // Skip already used puzzles
            }

            // Validate the puzzle
            if (!validatePuzzle(puzzle)) {
                invalidPuzzlesFound++;
                console.log(`⚠️  Found invalid puzzle (${invalidPuzzlesFound}/${maxInvalidPuzzles}), deleting from database...`);

                // Delete the invalid puzzle from database
                await deletePuzzleFromDatabase(sqliteDb, puzzle.hash);

                if (invalidPuzzlesFound >= maxInvalidPuzzles) {
                    console.log("❌ Too many invalid puzzles found, stopping search");
                    return null;
                }
                continue; // Try next puzzle
            }

            // Calculate overlap with previously used categories (for display only)
            const allCategories = [...puzzle.rows, ...puzzle.cols];
            let overlap = 0;
            for (const category of allCategories) {
                if (categoryUsage[category]) {
                    overlap += categoryUsage[category];
                }
            }

            console.log(`🎲 Found truly random puzzle with ${overlap} category overlaps`);
            return { puzzle, overlap: overlap };
        }

        if (invalidPuzzlesFound >= maxInvalidPuzzles) {
            console.log("❌ Too many invalid puzzles found, stopping search");
        } else {
            console.log("❌ No unused puzzles found after checking 100 puzzles");
        }
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
    let searchChoice = null;
    let tryingDifferentPuzzle = false;
    let excludedPuzzleHash = null;

    // Display initial total count
    const totalPuzzles = db.length;
    console.log(`📊 Total puzzles in daily_puzzles/puzzles.json: ${totalPuzzles}`);

    while (attempts < maxAttempts) {
        attempts++;

        // Ask user if they want to search for a specific category
        // Only reset search choice if we're starting fresh or if targetCategory is null
        // Don't reset if we're trying a different puzzle
        if (!tryingDifferentPuzzle && (curated === 0 || (targetCategory === null && searchChoice === null))) {
            searchChoice = await prompts.select({
                message: "What would you like to do?",
                choices: [
                    { name: "🏆 Find a high-quality puzzle (score ≥ 20)", value: "high_quality" },
                    { name: "🎲 Find a truly random puzzle", value: "truly_random" },
                    { name: "🔍 Search for puzzle with specific category", value: "search" },
                    { name: "🌶️ Secret Sauce: Find puzzle with NO categories from recent days", value: "secret_sauce" },
                    { name: "🛑 Stop curating", value: "stop" }
                ]
            });

            if (searchChoice === "stop") {
                break;
            }

            // Reset the flag when starting a new search
            tryingDifferentPuzzle = false;
            excludedPuzzleHash = null;

            if (searchChoice === "high_quality") {
                console.log("Searching for a high-quality puzzle...");
                const hq = await findHighQualityPuzzle();
                if (!hq) {
                    console.log("❌ No unused high-quality puzzles found right now");
                    // Reset to continue loop and offer menu again
                    searchChoice = null;
                    continue;
                }
                // Set result directly and skip the rest of menu setup
                targetCategory = null;
                result = { puzzle: hq, overlap: 0 };
                // fall through; after menu we will skip to display section
            } else if (searchChoice === "search") {
                // Get all available categories for tab completion
                const allCategories = Object.keys(categoriesJson).sort();

                // Show random example categories (sorted alphabetically)
                const shuffledCategories = [...allCategories].sort(() => Math.random() - 0.5);
                const exampleCategories = shuffledCategories.slice(0, 10).sort();

                console.log("\nExample categories:");
                exampleCategories.forEach(cat => console.log(`  ${cat}`));
                console.log("  ... and many more\n");

                // Collect multiple categories
                const selectedCategories = [];
                let categoryNumber = 1;

                while (true) {
                    console.log(`\nCategory ${categoryNumber}:`);

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
                                process.stdout.write(`Enter category name (or press Enter when done): ${input}`);
                                // Position cursor
                                process.stdout.write('\r');
                                process.stdout.write(`Enter category name (or press Enter when done): ${input.substring(0, cursorPos)}`);
                            };

                            displayInput();

                            const handleKey = (key) => {
                                if (key === '\u0003') { // Ctrl+C
                                    process.exit();
                                } else if (key === '\r' || key === '\n') { // Enter
                                    // Clean up raw mode properly
                                    process.stdin.setRawMode(false);
                                    process.stdin.pause();
                                    // Remove only our specific event listener
                                    process.stdin.off('data', handleKey);
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

                    const input = categoryInput.trim();

                    if (input === "") {
                        if (selectedCategories.length === 0) {
                            console.log("❌ Please enter at least one category.");
                            continue;
                        }
                        break;
                    }

                    if (input.toLowerCase() === "that's all" || input.toLowerCase() === "thats all") {
                        if (selectedCategories.length === 0) {
                            console.log("❌ Please enter at least one category.");
                            continue;
                        }
                        break;
                    }

                    // Check if category exists
                    if (!allCategories.includes(input)) {
                        console.log(`❌ Category "${input}" not found. Please enter a valid category.`);
                        continue;
                    }

                    // Check if category already selected
                    if (selectedCategories.includes(input)) {
                        console.log(`❌ Category "${input}" already selected.`);
                        continue;
                    }

                    selectedCategories.push(input);
                    console.log(`✅ Added: ${input}`);
                    console.log(`Selected categories (${selectedCategories.length}): ${selectedCategories.join(", ")}`);

                    categoryNumber++;

                    if (selectedCategories.length >= 8) {
                        console.log("✅ Maximum of 8 categories reached.");
                        break;
                    }
                }

                targetCategory = selectedCategories; // Now it's an array
                console.log(`🔍 Searching for puzzles containing ALL categories: ${selectedCategories.join(", ")}...`);
                tryingDifferentPuzzle = false;
                excludedPuzzleHash = null;

                // Only offer the simple option
                const searchType = await prompts.select({
                    message: "What type of search?",
                    choices: [
                        { name: "🎲 Find any puzzle with these categories (faster)", value: "any" }
                    ]
                });

                // Store the search type for later use
                searchChoice = searchType;
            } else if (searchChoice === "truly_random") {
                targetCategory = null;
            } else {
                targetCategory = null;
            }
        }

        let result;
        if (searchChoice === "truly_random") {
            result = await findTrulyRandomPuzzle();
        } else if (searchChoice === "any") {
            result = await findAnyPuzzleWithCategory(targetCategory, excludedPuzzleHash);
        } else if (searchChoice === "secret_sauce") {
            // Ask user for number of days
            const numDays = await prompts.input({
                message: "How many days of non-overlap would you like? (e.g., 13 for last 13 days)",
                initial: "13"
            });

            const rawDays = String(numDays).trim();
            if (rawDays === "") {
                console.log("Returning to main menu...");
                // Reset selection context to show main menu again
                targetCategory = null;
                searchChoice = null;
                tryingDifferentPuzzle = false;
                excludedPuzzleHash = null;
                continue;
            }

            const days = parseInt(rawDays);
            if (isNaN(days) || days < 1) {
                console.log("❌ Invalid number of days. Please enter a positive number.");
                continue;
            }

            console.log(`🌶️ Secret Sauce: Finding puzzle with NO categories from last ${days} days...`);
            const recentCategories = getCategoriesFromLastNDays(days);
            const topUsed = getTopUsedCategories(10);
            const combinedExclusions = Array.from(new Set([...recentCategories, ...topUsed]));
            console.log(`Recent categories to avoid: ${recentCategories.join(", ")}`);
            console.log(`Top used categories to avoid: ${topUsed.join(", ")}`);

            const sqliteDb = await openDatabase();
            try {
                const maxSecretSauceRetries = 3;
                const secretSauceLimit = 30;
                let puzzles = [];

                for (let attempt = 1; attempt <= maxSecretSauceRetries; attempt++) {
                    console.log(
                        `🌶️ Secret Sauce: Finding top ${secretSauceLimit} puzzles with NO categories from recent days (attempt ${attempt}/${maxSecretSauceRetries})...`
                    );

                    puzzles = await findPuzzlesWithNoRecentCategories(sqliteDb, combinedExclusions, secretSauceLimit);

                    if (puzzles.length > 0) {
                        break;
                    }

                    if (attempt < maxSecretSauceRetries) {
                        console.log("No valid puzzles found with no recent categories, retrying Secret Sauce search...");
                    }
                }

                if (puzzles.length === 0) {
                    console.log("❌ No valid puzzles found with no recent categories after multiple attempts");
                    result = null;
                } else {
                    console.log(`✅ Found ${puzzles.length} valid puzzles with no recent categories`);

                    // Sort by quality (highest first), then create menu choices
                    puzzles.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));

                    const puzzleChoices = puzzles.map((puzzle, index) => {
                        const allCategories = [...puzzle.rows, ...puzzle.cols];
                        const qs = Math.round(puzzle.qualityScore * 100) / 100;
                        const scoreIcon = scoreEmoji(puzzle.qualityScore);

                        return {
                            name: `${index + 1}. ${scoreIcon} Quality: ${qs.toFixed(2)} | Categories: ${allCategories.join(", ")}`,
                            value: index
                        };
                    });

                    // Add "None" option to go back to main menu
                    puzzleChoices.push({
                        name: "❌ None - return to main menu",
                        value: "none"
                    });

                    const selectedIndex = await prompts.select({
                        message: `Choose a puzzle from the top ${secretSauceLimit} (sorted by quality):`,
                        choices: puzzleChoices
                    });

                    if (selectedIndex === "none") {
                        console.log("Returning to main menu...");
                        result = null;
                    } else {
                        const selectedPuzzle = puzzles[selectedIndex];
                        // Calculate overlap for display (should be 0 for secret sauce)
                        const allCategories = [...selectedPuzzle.rows, ...selectedPuzzle.cols];
                        let overlap = 0;
                        for (const category of allCategories) {
                            if (categoryUsage[category]) {
                                overlap += categoryUsage[category];
                            }
                        }
                        result = { puzzle: selectedPuzzle, overlap: overlap };
                        console.log(`✅ Selected puzzle ${selectedIndex + 1} of ${puzzles.length}`);
                    }
                }
            } finally {
                sqliteDb.close();
            }
        } else {
            result = await findBestPuzzle(targetCategory);
        }
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
        if (typeof puzzle.qualityScore === 'number') {
            const qs = Math.round(puzzle.qualityScore * 100) / 100;
            console.log(`Quality score: ${qs.toFixed(2)} ${scoreEmoji(qs)}`);
        }
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
        let puzzleChoices = [
            { name: "✅ Continue with this puzzle", value: "continue" },
            { name: "🔄 Try a different puzzle", value: "different" },
            { name: "❌ Skip this puzzle", value: "skip" }
        ];

        // Only show "Try a different puzzle" option if we're searching for a specific category
        if (targetCategory && searchChoice === "any") {
            const continuePuzzle = await prompts.select({
                message: "What would you like to do?",
                choices: puzzleChoices
            });

            if (continuePuzzle === "skip") {
                console.log("Skipping puzzle...");
                // Reset search context and go back to main menu
                targetCategory = null;
                searchChoice = null;
                tryingDifferentPuzzle = false;
                excludedPuzzleHash = null;
                continue;
            } else if (continuePuzzle === "different") {
                console.log(`🔄 Finding another puzzle with "${targetCategory}"...`);
                tryingDifferentPuzzle = true;
                excludedPuzzleHash = puzzle.hash; // Store the current puzzle hash to exclude it
                continue; // Go back to the main loop to find another puzzle
            }
            // If continuePuzzle === "continue", fall through to the rest of the code
        } else {
            // For other search types, use the simple confirm dialog
            const continuePuzzle = await prompts.confirm({
                message: "Continue with this puzzle?",
                default: true
            });

            if (!continuePuzzle) {
                console.log("Skipping puzzle...");
                // Reset search context and go back to main menu
                targetCategory = null;
                searchChoice = null;
                tryingDifferentPuzzle = false;
                excludedPuzzleHash = null;
                continue;
            }
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

        // Curator chooses a word for each intersection, with Reset option
        let chosen;
        let usedWords;
        let puzzleAbandoned = false;
        while (true) {
            chosen = Array.from({ length: 4 }, () => Array(4));
            usedWords = new Set();
            let requestedReset = false;

            for (let r = 0; r < 4 && !puzzleAbandoned && !requestedReset; ++r) {
                for (let c = 0; c < 4 && !puzzleAbandoned && !requestedReset; ++c) {
                    // Show current progress
                    console.clear();
                    console.log("Rows:", puzzle.rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
                    console.log("\nCols:", puzzle.cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
                    console.log("\nCurrent puzzle state:");
                    console.table(chosen);
                    const excludedCats = getExcludedCategories(puzzle.rows[r], puzzle.cols[c], allCategories);
                    const excludedList = excludedCats.map(cat => formatWithUsage(cat, categoryUsage)).join(', ');
                    console.log(`\nChoosing word for: ${formatWithUsage(puzzle.rows[r], categoryUsage)} × ${formatWithUsage(puzzle.cols[c], categoryUsage)} AND NOT ${excludedList}\n`);

                    const opts = viableGrid[r][c].filter(w => !usedWords.has(w));

                    let pick;
                    const baseChoices = [
                        ...opts.map(w => ({ value: w, name: formatWithUsage(w, wordUsage) })),
                        { value: "RESET", name: "🔁 Reset puzzle curation (start over)" },
                        { value: "NONE", name: "❌ None - abandon this puzzle" }
                    ];

                    if (opts.length === 1) {
                        console.log(`Showing 1 option for selection...`);
                        pick = await prompts.select({
                            message: `Pick word for ${formatWithUsage(puzzle.rows[r], categoryUsage)} × ${formatWithUsage(puzzle.cols[c], categoryUsage)} AND NOT ${excludedList}`,
                            choices: baseChoices
                        });
                    } else {
                        console.log(`Showing ${opts.length} options for selection...`);
                        pick = await prompts.select({
                            message: `Pick word for ${formatWithUsage(puzzle.rows[r], categoryUsage)} × ${formatWithUsage(puzzle.cols[c], categoryUsage)} AND NOT ${excludedList}`,
                            choices: baseChoices
                        });
                    }

                    if (pick === "NONE") {
                        console.log("❌ Puzzle abandoned by user. Returning to main selection...");
                        puzzleAbandoned = true;
                        break;
                    }
                    if (pick === "RESET") {
                        console.log("🔁 Resetting current puzzle curation...");
                        requestedReset = true;
                        break;
                    }

                    chosen[r][c] = pick;
                    usedWords.add(pick);
                }
            }

            if (puzzleAbandoned) {
                break; // exit selection loop and go to main loop
            }
            if (requestedReset) {
                // Restart selection loop from scratch for same puzzle
                continue;
            }
            // Completed selection without reset/abandon
            break;
        }

        // If puzzle was abandoned, skip to next iteration of main loop
        if (puzzleAbandoned) {
            continue;
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
            // Also add to usedHashes so subsequent selections in this session skip it
            try {
                const forwardHash = computePuzzleHash(puzzle.rows, puzzle.cols);
                const reverseHash = computePuzzleHash(puzzle.cols, puzzle.rows);
                usedHashes.add(forwardHash);
                usedHashes.add(reverseHash);
            } catch { }

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
            const newTotal = db.length;
            console.log(`✅ Puzzle ${curated} saved!`);
            console.log(`📊 Total puzzles in daily_puzzles/puzzles.json: ${newTotal}`);
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
            message: `Continue curating? (${curated} puzzles saved this session, ${db.length} total in file)`,
            choices: continueChoices
        });

        if (continueAnswer === "stop") {
            break;
        } else if (continueAnswer === "same_category") {
            // Keep the same target category and continue
            console.log(`🔍 Searching for another puzzle containing "${targetCategory}"...`);
        } else {
            // Reset all search context for new search
            targetCategory = null;
            searchChoice = null;
            tryingDifferentPuzzle = false;
            excludedPuzzleHash = null;
        }
    }

    console.log(`\nCurated ${curated} puzzles in ${attempts} attempts.`);
    console.log(`Database saved to ${DB_FILE}`);
}

main().catch(console.error); 