#!/usr/bin/env node
/* ai_curator.js
   ------------------------------------------------------------------
   • File-based version of puzzle_curator_sqlite.js for AI interaction
   • Reads state from curator_state.json
   • Writes human-readable output to curator_output.md
   • Accepts commands via CLI arguments
   -----------------------------------------------------------------*/

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";

// ──────────────── paths ───────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "puzzles.db");
const OUT_DIR = path.join(__dirname, "daily_puzzles");
const DB_FILE = path.join(OUT_DIR, "puzzles.json");
const STATE_FILE = path.join(__dirname, "curator_state.json");
const OUTPUT_FILE = path.join(__dirname, "curator_output.md");

const DEFAULT_QUALITY_SAMPLE = Number(process.env.CURATOR_QUALITY_SAMPLE || 500);
const DEFAULT_MIN_QUALITY = Number(process.env.CURATOR_MIN_QUALITY || 0);
const GOOD_THRESHOLD = Number(process.env.PUZZLE_SCORE_GOOD || 12);
const MEDIUM_THRESHOLD = Number(process.env.PUZZLE_SCORE_MED || 6);
const HIGH_QUALITY_MIN = Number(process.env.CURATOR_HIGH_QUALITY_MIN || 20);

// ──────────────── helper functions ─────────────────────────────
function scoreEmoji(score) {
    if (score >= GOOD_THRESHOLD) return '🟢';
    if (score >= MEDIUM_THRESHOLD) return '🟡';
    return '🔴';
}

function computePuzzleHash(rows, cols) {
    const s = rows.join("|") + cols.join("|");
    return crypto.createHash("sha256").update(s).digest("hex");
}

const canon = arr => [...arr].sort().join("|");
const makeKey = (rows, cols) => canon(rows) + "::" + canon(cols);

// ──────────────── database operations ─────────────────────────────
function openDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve(db);
            }
        });
    });
}

function getRandomPuzzle(db, targetCategories = null) {
    return new Promise((resolve, reject) => {
        const sampleSize = DEFAULT_QUALITY_SAMPLE;
        let params = [];

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

function getMultipleRandomPuzzles(db, count, targetCategories = null, usedHashes = new Set()) {
    return new Promise((resolve, reject) => {
        const sampleSize = Math.max(count * 5, DEFAULT_QUALITY_SAMPLE);
        let params = [];

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

const ALWAYS_EXCLUDED_CATEGORIES = [
    '21st Century', '20th Century', '2020s', '2010s', 'Things American', 'Flower-class Corvettes'
];

function getCategoriesFromLastNDays(dailyDb, numDays) {
    const recentCategories = new Set();
    const recentPuzzles = dailyDb.slice(-numDays);
    for (const puzzle of recentPuzzles) {
        for (const category of [...puzzle.rows, ...puzzle.cols]) {
            recentCategories.add(category);
        }
    }
    for (const cat of ALWAYS_EXCLUDED_CATEGORIES) {
        recentCategories.add(cat);
    }
    return Array.from(recentCategories);
}

// ──────────────── Data Loading ─────────────────────────────
let categoriesJson, metaCatsJson, catSet, metaMap;

function loadCategories() {
    categoriesJson = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "categories.json")));
    metaCatsJson = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "meta_categories.json")));
    catSet = {};
    for (const [cat, words] of Object.entries(categoriesJson)) {
        catSet[cat] = new Set(words);
    }
    metaMap = {};
    for (const [metaCat, categories] of Object.entries(metaCatsJson)) {
        if (metaCat !== 'No Meta Category') {
            for (const category of categories) {
                metaMap[category] = metaCat;
            }
        }
    }
}

// Load categories on startup
loadCategories();

function uniqueWords(rCat, cCat, allCats) {
    const rowWords = catSet[rCat];
    const colWords = catSet[cCat];
    if (!rowWords || !colWords) return [];

    let v = [...rowWords].filter(w => colWords.has(w));

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
    for (const category of allCategories) {
        if (!catSet[category]) return false;
    }

    const metaCounts = new Map();
    for (const category of allCategories) {
        const metaCat = metaMap[category];
        if (metaCat) {
            const count = metaCounts.get(metaCat) || 0;
            const maxAllowed = metaCat === "Letter Patterns" ? 1 : 2;
            if (count >= maxAllowed) return false;
            metaCounts.set(metaCat, count + 1);
        }
    }

    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            const unique = uniqueWords(puzzle.rows[i], puzzle.cols[j], allCategories);
            if (unique.length === 0) return false;
        }
    }
    return true;
}

// ──────────────── State Management ─────────────────────────────
let state = {
    curatedCount: 0,
    attempts: 0,
    phase: "MAIN_MENU",
    searchChoice: null,
    targetCategories: [],
    currentPuzzle: null,
    viableGrid: null,
    chosen: Array.from({ length: 4 }, () => Array(4).fill(null)),
    usedWords: [],
    currentRow: 0,
    currentCol: 0,
    excludedPuzzleHash: null,
    puzzles: [], // results for secret sauce or search
    message: "Welcome to AI Curator!"
};

function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function renderOutput() {
    let output = `# Connecdoku AI Curator\n\n`;
    output += `**Status:** ${state.message}\n\n`;
    output += `**Curated this session:** ${state.curatedCount}\n\n`;

    if (state.phase === "MAIN_MENU") {
        output += `## Main Menu\n\nPlease select a search type:\n`;
        output += `1. **high_quality**: Find a high-quality puzzle (score ≥ 20)\n`;
        output += `2. **truly_random**: Find a truly random puzzle\n`;
        output += `3. **search**: Search for puzzle with specific category\n`;
        output += `4. **secret_sauce**: Find puzzle with NO categories from recent days\n`;
        output += `5. **stop**: Stop curating\n\n`;
        output += `**Command:** \`node ai_curator.js select <value>\` (e.g., \`node ai_curator.js select high_quality\`)`;
    } else if (state.phase === "SEARCH_CATEGORY") {
        output += `## Search Category\n\n`;
        output += `Currently selected: ${state.targetCategories.join(", ") || "None"}\n\n`;
        output += `Enter a category name to add it, or 'done' to finish.\n\n`;
        output += `**Command:** \`node ai_curator.js input "<category>"\` or \`node ai_curator.js select done\``;
    } else if (state.phase === "SECRET_SAUCE_DAYS") {
        output += `## Secret Sauce\n\nHow many days of non-overlap would you like? (e.g., 13)\n\n`;
        output += `**Command:** \`node ai_curator.js input <number>\``;
    } else if (state.phase === "PUZZLE_LIST") {
        output += `## Select a Puzzle\n\n`;
        state.puzzles.forEach((p, i) => {
            const qs = p.qualityScore ? p.qualityScore.toFixed(2) : "N/A";
            output += `${i}. ${scoreEmoji(p.qualityScore)} Quality: ${qs} | Categories: ${[...p.rows, ...p.cols].join(", ")}\n`;
        });
        output += `\n**Command:** \`node ai_curator.js select <index>\` or \`node ai_curator.js select none\``;
    } else if (state.phase === "PUZZLE_REVIEW") {
        const p = state.currentPuzzle;
        output += `## Review Puzzle\n\n`;
        output += `**Quality Score:** ${p.qualityScore.toFixed(2)} ${scoreEmoji(p.qualityScore)}\n`;
        output += `**Rows:**\n${p.rows.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}\n`;
        output += `**Cols:**\n${p.cols.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}\n\n`;
        output += `Options:\n`;
        output += `- **continue**: Continue with this puzzle\n`;
        output += `- **different**: Try a different puzzle\n`;
        output += `- **skip**: Skip this puzzle and return to main menu\n\n`;
        output += `**Command:** \`node ai_curator.js select continue\`, \`different\`, or \`skip\``;
    } else if (state.phase === "WORD_SELECTION") {
        const p = state.currentPuzzle;
        output += `## Word Selection\n\n`;
        output += `**Cell [${state.currentRow}, ${state.currentCol}]:** ${p.rows[state.currentRow]} × ${p.cols[state.currentCol]}\n\n`;
        
        output += `**Current Grid:**\n\n| | Col 1 | Col 2 | Col 3 | Col 4 |\n|---|---|---|---|---|\n`;
        for (let r = 0; r < 4; r++) {
            output += `| **Row ${r + 1}** | ${state.chosen[r].map(w => w || "---").join(" | ")} |\n`;
        }
        output += `\n`;

        const options = state.viableGrid[state.currentRow][state.currentCol].filter(w => !state.usedWords.includes(w));
        output += `**Options for current cell:**\n`;
        options.forEach((w, i) => {
            const firstLetter = w.trim().charAt(0).toUpperCase();
            output += `${i}. ${w} [${firstLetter}]\n`;
        });
        output += `\n- **reset**: Reset word selection for this puzzle
- **abandon**: Abandon this puzzle\n\n`;
        output += `⚠️ **IMPORTANT: You must manually review ALL options and choose the BEST word for this cell!**\n`;
        output += `⚠️ **The letter requirement forces you to review each choice - don't just pick option 0!**\n\n`;
        output += `**Command:** \`node ai_curator.js select <index><letter>\` (e.g., \`node ai_curator.js select 0B\` for option 0 with first letter B) or \`reset\`, \`abandon\``;
    } else if (state.phase === "FINAL_APPROVAL") {
        output += `## Final Approval\n\n`;
        output += `**Rows:** ${state.currentPuzzle.rows.join(", ")}\n`;
        output += `**Cols:** ${state.currentPuzzle.cols.join(", ")}\n\n`;
        output += `**Words:**\n\n| | Col 1 | Col 2 | Col 3 | Col 4 |\n|---|---|---|---|---|\n`;
        for (let r = 0; r < 4; r++) {
            output += `| **Row ${r + 1}** | ${state.chosen[r].join(" | ")} |\n`;
        }
        output += `\n`;
        output += `**Command:** \`node ai_curator.js select approve\` or \`node ai_curator.js select reject\``;
    }

    fs.writeFileSync(OUTPUT_FILE, output);
}

async function handleAction(action, value) {
    const dailyDb = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, "utf8")) : [];
    const usedHashes = new Set();
    for (const p of dailyDb) {
        usedHashes.add(computePuzzleHash(p.rows, p.cols));
        usedHashes.add(computePuzzleHash(p.cols, p.rows));
    }

    if (state.phase === "MAIN_MENU") {
        if (action === "select") {
            if (value === "high_quality") {
                const db = await openDatabase();
                const hq = await getMultipleRandomPuzzles(db, 20, null, usedHashes);
                db.close();
                const filtered = hq.filter(p => validatePuzzle(p)).slice(0, 1);
                if (filtered.length > 0) {
                    state.currentPuzzle = filtered[0];
                    state.phase = "PUZZLE_REVIEW";
                    state.message = "High-quality puzzle found!";
                } else {
                    state.message = "No high-quality puzzles found right now.";
                }
            } else if (value === "truly_random") {
                const db = await openDatabase();
                let found = null;
                for (let i = 0; i < 50; i++) {
                    const p = await getRandomPuzzle(db);
                    if (p && !usedHashes.has(p.hash) && validatePuzzle(p)) {
                        found = p;
                        break;
                    }
                }
                db.close();
                if (found) {
                    state.currentPuzzle = found;
                    state.phase = "PUZZLE_REVIEW";
                    state.message = "Random puzzle found!";
                } else {
                    state.message = "Failed to find a valid random puzzle.";
                }
            } else if (value === "search") {
                state.phase = "SEARCH_CATEGORY";
                state.targetCategories = [];
                state.message = "Enter categories for search.";
            } else if (value === "secret_sauce") {
                state.phase = "SECRET_SAUCE_DAYS";
                state.message = "Enter number of days for non-overlap.";
            } else if (value === "stop") {
                state.message = "Stopped.";
                process.exit(0);
            }
        }
    } else if (state.phase === "SEARCH_CATEGORY") {
        if (action === "input") {
            if (categoriesJson[value]) {
                if (!state.targetCategories.includes(value)) {
                    state.targetCategories.push(value);
                    state.message = `Added category: ${value}`;
                } else {
                    state.message = `Category already added: ${value}`;
                }
            } else {
                state.message = `Category not found: ${value}`;
            }
        } else if (action === "select" && value === "done") {
            if (state.targetCategories.length > 0) {
                const db = await openDatabase();
                const puzzles = await getMultipleRandomPuzzles(db, 20, state.targetCategories, usedHashes);
                db.close();
                const filtered = puzzles.filter(p => validatePuzzle(p));
                if (filtered.length > 0) {
                    state.puzzles = filtered;
                    state.phase = "PUZZLE_LIST";
                    state.message = `Found ${filtered.length} puzzles.`;
                } else {
                    state.phase = "MAIN_MENU";
                    state.message = "No valid puzzles found with those categories.";
                }
            } else {
                state.message = "Please add at least one category.";
            }
        }
    } else if (state.phase === "SECRET_SAUCE_DAYS") {
        if (action === "input") {
            const days = parseInt(value);
            if (!isNaN(days) && days > 0) {
                const recentCats = getCategoriesFromLastNDays(dailyDb, days);
                const db = await openDatabase();
                
                let foundPuzzles = [];
                let attempts = 0;
                const maxSearch = 20000; // batches
                const batchSize = 500; // total 10M

                while (foundPuzzles.length < 20 && attempts < maxSearch) {
                    attempts++;
                    const candidates = await getMultipleRandomPuzzles(db, batchSize, null, usedHashes);
                    if (!candidates || candidates.length === 0) break;

                    const filtered = candidates.filter(p => {
                        if (!validatePuzzle(p)) return false;
                        const allP = [...p.rows, ...p.cols];
                        return !allP.some(c => recentCats.includes(c));
                    });
                    
                    foundPuzzles = [...foundPuzzles, ...filtered];
                }
                
                db.close();
                const finalPuzzles = foundPuzzles.slice(0, 20);

                if (finalPuzzles.length > 0) {
                    state.puzzles = finalPuzzles;
                    state.phase = "PUZZLE_LIST";
                    state.message = `Found ${finalPuzzles.length} puzzles with no overlap after searching ${attempts * batchSize} candidates.`;
                } else {
                    state.phase = "MAIN_MENU";
                    state.message = "No puzzles found with no overlap.";
                }
            } else {
                state.message = "Invalid number of days.";
            }
        }
    } else if (state.phase === "PUZZLE_LIST") {
        if (action === "select") {
            if (value === "none") {
                state.phase = "MAIN_MENU";
                state.message = "Returned to main menu.";
            } else {
                const idx = parseInt(value);
                if (!isNaN(idx) && idx >= 0 && idx < state.puzzles.length) {
                    state.currentPuzzle = state.puzzles[idx];
                    state.phase = "PUZZLE_REVIEW";
                    state.message = "Puzzle selected.";
                } else {
                    state.message = "Invalid selection.";
                }
            }
        }
    } else if (state.phase === "PUZZLE_REVIEW") {
        if (action === "select") {
            if (value === "continue") {
                const p = state.currentPuzzle;
                const allCats = [...p.rows, ...p.cols];
                const grid = Array.from({ length: 4 }, () => Array(4));
                for (let r = 0; r < 4; r++) {
                    for (let c = 0; c < 4; c++) {
                        grid[r][c] = uniqueWords(p.rows[r], p.cols[c], allCats);
                    }
                }
                state.viableGrid = grid;
                state.chosen = Array.from({ length: 4 }, () => Array(4).fill(null));
                state.usedWords = [];
                state.currentRow = 0;
                state.currentCol = 0;
                state.phase = "WORD_SELECTION";
                state.message = "Starting word selection.";
            } else if (value === "different") {
                // Return to previous search if possible, or main menu
                if (state.puzzles && state.puzzles.length > 1) {
                    state.phase = "PUZZLE_LIST";
                    state.message = "Choose another puzzle.";
                } else {
                    state.phase = "MAIN_MENU";
                    state.message = "No other puzzles in current search. Returned to main menu.";
                }
            } else if (value === "skip") {
                state.phase = "MAIN_MENU";
                state.message = "Puzzle skipped.";
            }
        }
    } else if (state.phase === "WORD_SELECTION") {
        if (action === "select") {
            if (value === "reset") {
                // Reload categories in case words.json was updated
                loadCategories();
                
                // Rebuild viable grid with updated categories
                const p = state.currentPuzzle;
                const allCats = [...p.rows, ...p.cols];
                const grid = Array.from({ length: 4 }, () => Array(4));
                for (let r = 0; r < 4; r++) {
                    for (let c = 0; c < 4; c++) {
                        grid[r][c] = uniqueWords(p.rows[r], p.cols[c], allCats);
                    }
                }
                state.viableGrid = grid;
                
                state.chosen = Array.from({ length: 4 }, () => Array(4).fill(null));
                state.usedWords = [];
                state.currentRow = 0;
                state.currentCol = 0;
                state.message = "Word selection reset. Categories reloaded.";
            } else if (value === "abandon") {
                state.phase = "MAIN_MENU";
                state.message = "Puzzle abandoned.";
            } else {
                const options = state.viableGrid[state.currentRow][state.currentCol].filter(w => !state.usedWords.includes(w));
                let selectedWord = null;

                // Parse value: should be like "0B" (number + first letter)
                const match = value.match(/^(\d+)([A-Za-z])$/);
                if (match) {
                    const idx = parseInt(match[1]);
                    const providedLetter = match[2].toUpperCase();
                    
                    if (idx >= 0 && idx < options.length) {
                        const word = options[idx];
                        const expectedLetter = word.trim().charAt(0).toUpperCase();
                        
                        if (providedLetter === expectedLetter) {
                            selectedWord = word;
                        } else {
                            state.message = `⚠️ Letter mismatch: expected ${expectedLetter} for option ${idx} (${word}), got ${providedLetter}. This mismatch is INTENTIONAL to force you to review ALL options and manually choose the BEST word - don't just pick option 0! Please review all options carefully.`;
                        }
                    } else {
                        state.message = `Invalid index: ${idx} (valid range: 0-${options.length - 1})`;
                    }
                } else if (options.includes(value)) {
                    // Still allow full word name for backwards compatibility
                    selectedWord = value;
                } else {
                    state.message = `Invalid format: expected <number><letter> (e.g., "0B") or full word name. Got: ${value}. ⚠️ Remember: You must manually review ALL options and choose the BEST word - the letter requirement forces careful review of each choice!`;
                }

                if (selectedWord) {
                    state.chosen[state.currentRow][state.currentCol] = selectedWord;
                    state.usedWords.push(selectedWord);
                    state.currentCol++;
                    if (state.currentCol === 4) {
                        state.currentCol = 0;
                        state.currentRow++;
                    }
                    if (state.currentRow === 4) {
                        state.phase = "FINAL_APPROVAL";
                        state.message = "All words chosen. Please approve.";
                    } else {
                        state.message = `Word chosen: ${selectedWord}`;
                    }
                }
            }
        }
    } else if (state.phase === "FINAL_APPROVAL") {
        if (action === "select") {
            if (value === "approve") {
                const newPuzzle = {
                    rows: state.currentPuzzle.rows,
                    cols: state.currentPuzzle.cols,
                    words: state.chosen
                };
                dailyDb.push(newPuzzle);
                fs.writeFileSync(DB_FILE, JSON.stringify(dailyDb, null, 2));
                state.curatedCount++;
                state.phase = "MAIN_MENU";
                state.message = "Puzzle saved successfully!";
            } else if (value === "reject") {
                state.phase = "MAIN_MENU";
                state.message = "Puzzle rejected.";
            }
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    loadState();

    if (args.length > 0) {
        const action = args[0];
        const value = args.slice(1).join(" ");
        await handleAction(action, value);
        saveState();
    }

    renderOutput();
    console.log(`Current phase: ${state.phase}`);
    console.log(`Message: ${state.message}`);
    console.log(`Output written to curator_output.md`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

