#!/usr/bin/env node
// clean_db.js - Validate all puzzles in database against current word list
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import sqlite3 from "sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── paths ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const META_CATS_F = path.join(DATA_DIR, "meta_categories.json");
const CAT_SCORES_F = path.join(DATA_DIR, "category_scores.json");
const DB_PATH = path.join(__dirname, "puzzles.db");

// ───────── helpers ──────────────────────────────────────────────────────────
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

// simple progress bar (copied from solver)
const BAR_W = 40, start = new Map();
let last = 0;
function fmt(s) {
    if (!isFinite(s)) return "??";
    const h = s / 3600 | 0, m = s / 60 % 60 | 0;
    return h ? `${h}h ${m}m` : m ? `${m}m` : `${s | 0}s`;
}
function pbar(done, total, stage, extra = "", force = false) {
    const now = Date.now();
    if (!force && now - last < 120) return;
    last = now;
    const pct = total ? done / total : 0, fill = Math.round(pct * BAR_W);
    const bar = "█".repeat(fill) + "░".repeat(BAR_W - fill);
    const el = (now - start.get(stage)) / 1000;
    const eta = pct ? el / pct - el : Infinity;
    process.stdout.write(
        `\r[${bar}] ${(pct * 100).toFixed(1).padStart(5)}% ${extra}  [${fmt(el)}/${fmt(eta)}] `
    );
}
function begin(stage) { start.set(stage, Date.now()); console.log(`\n${stage}...`); }
function end() { process.stdout.write("\n"); }

// ───────── validation functions ─────────────────────────────────────────────────────────────
const intersectSet = (a, b) => {
    const r = new Set();
    const s = a.size < b.size ? a : b, t = s === a ? b : a;
    for (const x of s) if (t.has(x)) r.add(x);
    return r;
};

function validatePuzzle(puzzle, categoriesJson, categoryToMeta) {
    const { row0, row1, row2, row3, col0, col1, col2, col3 } = puzzle;
    const rows = [row0, row1, row2, row3];
    const cols = [col0, col1, col2, col3];
    
    // Check if all categories exist in current word list
    for (const category of [...rows, ...cols]) {
        if (!categoriesJson[category]) {
            return { valid: false, reason: `Category "${category}" not found in current word list` };
        }
    }
    
    // Check meta-category constraint (max 2 per meta-category, except Letter Patterns which is max 1, excluding "No Meta Category")
    const metaCounts = new Map();
    for (const category of [...rows, ...cols]) {
        const metaCat = categoryToMeta.get(category);
        if (metaCat) {  // Skip categories not in any meta-category or in "No Meta Category"
            const count = metaCounts.get(metaCat) || 0;
            const maxAllowed = metaCat === "Letter Patterns" ? 1 : 2;
            if (count >= maxAllowed) {
                return { valid: false, reason: `Meta-category constraint violated: "${metaCat}" appears ${count + 1} times (max ${maxAllowed} allowed)` };
            }
            metaCounts.set(metaCat, count + 1);
        }
    }
    
    // Create word sets for all categories
    const wordSets = {};
    for (const category of [...rows, ...cols]) {
        wordSets[category] = new Set(categoriesJson[category]);
    }
    
    // Red-herring test: each cell must have at least one unique word
    const all = new Set([...rows, ...cols]);
    for (const row of rows) {
        for (const col of cols) {
            // Find intersection of row and column
            let intersection = intersectSet(wordSets[row], wordSets[col]);
            
            // Remove words that appear in any other category
            for (const other of all) {
                if (other !== row && other !== col) {
                    intersection = new Set([...intersection].filter(word => !wordSets[other].has(word)));
                }
            }
            
            // If no unique word exists for this cell, puzzle is invalid
            if (intersection.size === 0) {
                return { 
                    valid: false, 
                    reason: `No unique word exists for cell (${row}, ${col}) - intersection is empty after removing words from other categories` 
                };
            }
        }
    }
    
    return { valid: true };
}

// ───────── database functions ───────────────────────────────────────────────
function setupDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, err => {
            if (err) return reject(err);
            resolve(db);
        });
    });
}

async function countPuzzles(db) {
    return new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as count FROM puzzles", (err, row) => {
            if (err) reject(err);
            else resolve(row ? row.count : 0);
        });
    });
}

async function getPuzzleBatch(db, minHash, maxHash) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3 
             FROM puzzles 
             WHERE puzzle_hash > ? AND puzzle_hash <= ?
             ORDER BY puzzle_hash`,
            [minHash, maxHash],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

async function getHashRange(db) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT MIN(puzzle_hash) as min_hash, MAX(puzzle_hash) as max_hash 
             FROM puzzles`,
            (err, row) => {
                if (err) reject(err);
                else resolve(row ? { min: row.min_hash, max: row.max_hash } : null);
            }
        );
    });
}

async function deletePuzzleBatch(db, puzzleHashes) {
    if (puzzleHashes.length === 0) return 0;
    
    // SQLite has a limit of 999 parameters per statement, so we need to batch deletions
    const MAX_PARAMS = 900; // Leave some buffer
    let totalDeleted = 0;
    
    for (let i = 0; i < puzzleHashes.length; i += MAX_PARAMS) {
        const batch = puzzleHashes.slice(i, i + MAX_PARAMS);
        
        await new Promise((resolve, reject) => {
            const placeholders = batch.map(() => '?').join(',');
            const stmt = db.prepare(`DELETE FROM puzzles WHERE puzzle_hash IN (${placeholders})`);
            
            stmt.run(batch, function(err) {
                if (err) reject(err);
                else {
                    totalDeleted += this.changes;
                    resolve();
                }
            });
            
            stmt.finalize();
        });
    }
    
    return totalDeleted;
}

async function ensureQualityScoreColumn(db) {
    return new Promise((resolve, reject) => {
        db.all("PRAGMA table_info(puzzles)", (err, rows) => {
            if (err) { reject(err); return; }
            const hasCol = rows && rows.some(r => r.name === 'puzzle_quality_score');
            if (hasCol) { resolve(false); return; }
            db.run("ALTER TABLE puzzles ADD COLUMN puzzle_quality_score REAL", err2 => {
                if (err2) reject(err2); else resolve(true);
            });
        });
    });
}

async function updatePuzzleScoresBatch(db, updates) {
    if (!updates || updates.length === 0) return 0;
    const MAX_PARAMS = 900; // stay under sqlite limit
    // each row contributes 3 params (WHEN hash THEN score, and IN hash)
    const BATCH_SIZE = Math.max(1, Math.floor(MAX_PARAMS / 3));
    let totalUpdated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);
        const cases = batch.map(() => "WHEN ? THEN ?").join(" ");
        const inPh = batch.map(() => "?").join(",");
        const sql = `UPDATE puzzles SET puzzle_quality_score = CASE puzzle_hash ${cases} END WHERE puzzle_hash IN (${inPh})`;
        const params = [];
        for (const u of batch) { params.push(u.hash, u.score); }
        for (const u of batch) { params.push(u.hash); }
        // Wrap run in a promise and use changes() afterwards
        // SQLite's run doesn't return changes directly in this mode, so do a SELECT count(*) afterwards
        await new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err); else resolve();
            });
        });
        totalUpdated += batch.length;
    }
    return totalUpdated;
}

// ───────── main validation function ─────────────────────────────────────────
async function main() {
    console.log("🔍 Puzzle Validator - Checking database against current word list");
    console.log("=" * 60);
    
    // Load current word list, categories, meta-categories, and category scores
    begin("Loading word list, categories, meta-categories, and scores");
    const wordsJson = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));
    const categoriesJson = JSON.parse(fs.readFileSync(CATS_F, "utf8"));
    const metaCatsJson = JSON.parse(fs.readFileSync(META_CATS_F, "utf8"));
    let categoryScores = {};
    try {
        categoryScores = JSON.parse(fs.readFileSync(CAT_SCORES_F, "utf8"));
    } catch (e) {
        console.log(`Category scores file not found or invalid at ${CAT_SCORES_F}. All categories will score as 0.`);
        categoryScores = {};
    }
    
    // Build category to meta-category mapping
    const categoryToMeta = new Map();
    for (const [metaCat, categories] of Object.entries(metaCatsJson)) {
        if (metaCat !== "No Meta Category") {  // Skip "No Meta Category" for constraint checking
            for (const category of categories) {
                categoryToMeta.set(category, metaCat);
            }
        }
    }
    
    console.log(`Loaded ${Object.keys(categoriesJson).length} categories`);
    console.log(`Loaded ${Object.keys(wordsJson).length} words`);
    console.log(`Loaded ${Object.keys(metaCatsJson).length} meta-categories`);
    console.log(`Loaded ${Object.keys(categoryScores).length} category scores`);
    console.log(`Built mapping for ${categoryToMeta.size} categorized categories`);
    end();
    
    // Initialize category tally
    const categoryTally = {};
    for (const category of Object.keys(categoriesJson)) {
        categoryTally[category] = 0;
    }
    
    // Setup database
    begin("Connecting to database");
    const db = await setupDatabase();
    console.log(`Database connected: ${DB_PATH}`);
    // Ensure score column exists
    try {
        const added = await ensureQualityScoreColumn(db);
        if (added) console.log("Added column: puzzle_quality_score");
    } catch (e) {
        console.log(`Warning: could not ensure puzzle_quality_score column: ${e.message}`);
    }
    end();
    
    // Count total puzzles
    begin("Counting puzzles");
    const totalPuzzles = await countPuzzles(db);
    console.log(`Total puzzles in database: ${totalPuzzles}`);
    if (totalPuzzles === 0) {
        console.log("No puzzles to validate. Exiting.");
        db.close();
        return;
    }
    end();
    
    // Get hash range for batching
    begin("Getting hash range");
    const hashRange = await getHashRange(db);
    if (!hashRange) {
        console.log("No puzzles found in database.");
        db.close();
        return;
    }
    console.log(`Hash range: ${hashRange.min.substring(0, 8)}... to ${hashRange.max.substring(0, 8)}...`);
    end();
    
    // Validate puzzles in hash-based batches
    begin("Validating puzzles");
    const validPuzzles = [];
    const unknownCategories = new Set();
    let processed = 0;
    let totalInvalid = 0;
    // Streaming stats for puzzle_quality_score
    let scoreMin = Infinity;
    let scoreMax = -Infinity;
    let scoreSum = 0;
    let scoreCount = 0;
    const BATCH_COUNT = 100; // Split hash range into 100 batches
    const hashStep = (BigInt("0x" + hashRange.max) - BigInt("0x" + hashRange.min)) / BigInt(BATCH_COUNT);
    let currentHash = BigInt("0x" + hashRange.min);
    
    for (let i = 0; i < BATCH_COUNT; i++) {
        const nextHash = i === BATCH_COUNT - 1 ? hashRange.max : 
                        (BigInt("0x" + hashRange.min) + hashStep * BigInt(i + 1)).toString(16).padStart(64, '0');
        const currentHashStr = currentHash.toString(16).padStart(64, '0');
        
        const puzzles = await getPuzzleBatch(db, currentHashStr, nextHash);
        
        const batchInvalidHashes = [];
        const batchScoreUpdates = [];
        
        for (const puzzle of puzzles) {
            const validation = validatePuzzle(puzzle, categoriesJson, categoryToMeta);
            
            if (validation.valid) {
                validPuzzles.push(puzzle.puzzle_hash);
                
                // Tally categories for valid puzzles
                const { row0, row1, row2, row3, col0, col1, col2, col3 } = puzzle;
                const categories = [row0, row1, row2, row3, col0, col1, col2, col3];
                for (const category of categories) {
                    if (categoryTally.hasOwnProperty(category)) {
                        categoryTally[category]++;
                    }
                    // Build score and track unknowns
                    if (!(category in categoryScores)) {
                        unknownCategories.add(category);
                    }
                }
                // Compute score as sum of category scores (default 0)
                const puzzleScore = categories.reduce((sum, c) => sum + (categoryScores[c] || 0), 0);
                batchScoreUpdates.push({ hash: puzzle.puzzle_hash, score: puzzleScore });
                // Update streaming stats
                if (puzzleScore < scoreMin) scoreMin = puzzleScore;
                if (puzzleScore > scoreMax) scoreMax = puzzleScore;
                scoreSum += puzzleScore;
                scoreCount += 1;
            } else {
                batchInvalidHashes.push(puzzle.puzzle_hash);
            }
            
            processed++;
            pbar(processed, totalPuzzles, "Validating puzzles", 
                  `${validPuzzles.length} valid, ${totalInvalid + batchInvalidHashes.length} invalid`);
        }
        
        // Delete invalid puzzles from this batch
        if (batchInvalidHashes.length > 0) {
            const deleted = await deletePuzzleBatch(db, batchInvalidHashes);
            totalInvalid += deleted;
            pbar(processed, totalPuzzles, "Validating puzzles", 
                  `${validPuzzles.length} valid, ${totalInvalid} deleted`, true);
        }

        // Update quality scores for valid puzzles from this batch
        if (batchScoreUpdates.length > 0) {
            try {
                await updatePuzzleScoresBatch(db, batchScoreUpdates);
            } catch (e) {
                console.log(`Error updating puzzle scores for batch: ${e.message}`);
            }
        }
        
        currentHash = BigInt("0x" + nextHash);
    }
    
    pbar(totalPuzzles, totalPuzzles, "Validating puzzles", 
          `${validPuzzles.length} valid, ${totalInvalid} deleted`, true);
    end();
    
    // Report results
    console.log(`\n📊 Validation Results:`);
    console.log(`   Total puzzles: ${totalPuzzles}`);
    console.log(`   Valid puzzles: ${validPuzzles.length}`);
    console.log(`   Invalid puzzles deleted: ${totalInvalid}`);
    console.log(`   Invalid percentage: ${((totalInvalid / totalPuzzles) * 100).toFixed(2)}%`);

    if (unknownCategories.size > 0) {
        console.error(`\n⚠️  Categories missing from category_scores.json (${unknownCategories.size}):`);
        console.error(Array.from(unknownCategories).sort().join("\n"));
    }

    // Quality score summary (streaming, no full in-memory collection)
    if (scoreCount > 0 && isFinite(scoreMin) && isFinite(scoreMax)) {
        const scoreMean = scoreSum / scoreCount;
        console.log(`\n📈 Quality score stats (valid puzzles):`);
        console.log(`   Min: ${scoreMin.toFixed(2)}`);
        console.log(`   Max: ${scoreMax.toFixed(2)}`);
        console.log(`   Mean: ${scoreMean.toFixed(2)}`);
        console.log(`   Median: (skipped)`);
    } else {
        console.log(`\n📈 Quality score stats: no valid puzzles scored`);
    }
    
    if (totalInvalid === 0) {
        console.log("\n✅ All puzzles are valid! No cleanup needed.");
    } else {
        console.log(`\n✅ Cleanup Complete!`);
        console.log(`   Deleted ${totalInvalid} invalid puzzles`);
        console.log(`   Remaining valid puzzles: ${validPuzzles.length}`);
    }
    
    // Verify final count
    const finalCount = await countPuzzles(db);
    console.log(`   Final database count: ${finalCount}`);
    
    // Account for the fact that database count includes a metadata row
    const expectedDatabaseCount = validPuzzles.length + 1;
    
    if (finalCount !== expectedDatabaseCount) {
        console.log(`   ⚠️  Warning: Expected ${expectedDatabaseCount} total rows, but database has ${finalCount}`);
    } else {
        console.log(`   ✅ Database count matches expected count (${validPuzzles.length} puzzles + 1 metadata row)`);
    }
    
    // Save category tally to JSON file
    begin("Saving category tally");
    const tallyOutputPath = path.join(DATA_DIR, "category_tally.json");
    
    // Sort categories by usage count (descending)
    const sortedTally = Object.entries(categoryTally)
        .sort(([,a], [,b]) => b - a)
        .reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {});
    
    // Add summary statistics
    const totalValidPuzzles = validPuzzles.length;
    const totalCategoryUsages = Object.values(categoryTally).reduce((sum, count) => sum + count, 0);
    const averageCategoriesPerPuzzle = totalCategoryUsages / totalValidPuzzles;
    
    const tallyData = {
        summary: {
            totalValidPuzzles,
            totalCategoryUsages,
            averageCategoriesPerPuzzle: Math.round(averageCategoriesPerPuzzle * 100) / 100,
            totalCategories: Object.keys(categoriesJson).length,
            categoriesWithZeroUsage: Object.values(categoryTally).filter(count => count === 0).length
        },
        categoryUsage: sortedTally
    };
    
    fs.writeFileSync(tallyOutputPath, JSON.stringify(tallyData, null, 2));
    console.log(`Category tally saved to: ${tallyOutputPath}`);
    console.log(`   Most used category: ${Object.keys(sortedTally)[0]} (${Object.values(sortedTally)[0]} times)`);
    console.log(`   Categories with zero usage: ${tallyData.summary.categoriesWithZeroUsage}`);
    end();
    
    // Clean up
    db.close(err => {
        if (err) console.error("Error closing database:", err.message);
        else console.log("Database connection closed");
    });
}

// Run the validation
main().catch(err => {
    console.error("Error during validation:", err);
    process.exit(1);
});