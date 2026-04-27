#!/usr/bin/env node
/* ai_curator.js
   ------------------------------------------------------------------
   • File-based curator for AI interaction (DB-free)
   • Reads state from curator_state.json
   • Writes human-readable output to curator_output.md
   • Accepts commands via CLI arguments
   -----------------------------------------------------------------*/

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// ──────────────── paths ───────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

/** Curator list / review: one score = final (penalized), fallback to quality for legacy state. */
function curatorDisplayScore(p) {
    if (typeof p.finalScore === "number") return p.finalScore;
    if (typeof p.qualityScore === "number") return p.qualityScore;
    return null;
}

function computePuzzleHash(rows, cols) {
    const s = rows.join("|") + cols.join("|");
    return crypto.createHash("sha256").update(s).digest("hex");
}

const canon = arr => [...arr].sort().join("|");
const makeKey = (rows, cols) => canon(rows) + "::" + canon(cols);

// (DB search removed — Connecdoku now uses a DB-free solve-and-curate pipeline.)

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
        output += `## Main Menu\n\n`;
        output += `This curator no longer reads from a database.\n\n`;
        output += `To generate candidate puzzles, run:\n`;
        output += `- \`make solve-and-curate\`\n\n`;
        output += `If you already have a puzzle list loaded, choose one:\n`;
        output += `- \`node ai_curator.js select list\`\n\n`;
        output += `Or stop:\n`;
        output += `- \`node ai_curator.js select stop\`\n`;
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
            const sc = curatorDisplayScore(p);
            const scStr = sc !== null ? sc.toFixed(2) : "N/A";
            const ms = typeof p.maxSimilarityToPast === "number" ? p.maxSimilarityToPast.toFixed(3) : null;
            const extras = [ms ? `MaxSimPast: ${ms}` : null].filter(Boolean).join(" | ");
            const emojiScore = sc !== null ? sc : 0;
            output += `${i}. ${scoreEmoji(emojiScore)} Score: ${scStr}${extras ? ` | ${extras}` : ""} | Categories: ${[...p.rows, ...p.cols].join(", ")}\n`;
        });
        output += `\n**Command:** \`node ai_curator.js select <index>\` or \`node ai_curator.js select none\``;
    } else if (state.phase === "PUZZLE_REVIEW") {
        const p = state.currentPuzzle;
        output += `## Review Puzzle\n\n`;
        {
            const sc = curatorDisplayScore(p);
            const scStr = sc !== null ? sc.toFixed(2) : "N/A";
            const emojiScore = sc !== null ? sc : 0;
            output += `**Score:** ${scStr} ${scoreEmoji(emojiScore)}\n`;
        }
        if (typeof p.maxSimilarityToPast === "number") output += `**Max similarity to past:** ${p.maxSimilarityToPast.toFixed(3)}\n`;
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
        output += `⚠️ **Anti-autopick rule:** for cells with 2+ options, you must provide BOTH your best choice and a runner-up.\n\n`;
        output += `**Command:**\n`;
        output += `- Single-option cell: \`node ai_curator.js select <index><letter>\` (e.g., \`0B\`)\n`;
        output += `- Multi-option cell: \`node ai_curator.js select <bestIndex><bestLetter>/<runnerIndex><runnerLetter>\` (e.g., \`2L/5T\`)\n`;
        output += `- Or: \`reset\`, \`abandon\``;
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
            if (value === "list") {
                if (state.puzzles && state.puzzles.length > 0) {
                    state.phase = "PUZZLE_LIST";
                    state.message = `Loaded ${state.puzzles.length} puzzle(s).`;
                } else {
                    state.message = "No puzzle list loaded. Run `make solve-and-curate` first.";
                }
            } else if (value === "stop") {
                state.message = "Stopped.";
                process.exit(0);
            } else {
                state.message = "Unknown option. Run `make solve-and-curate`, then `node ai_curator.js select list`.";
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
                    state.message = "No other puzzles in current list. Returned to main menu.";
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

                // Single-option cell: exact title also allowed (avoids "01" vs index 1 ambiguity for digit-leading titles).
                if (options.length === 1 && value === options[0]) {
                    selectedWord = options[0];
                }

                // Single-option cell: allow simple format "0B" (second char may be digit if the title starts with a digit).
                const simpleMatch = value.match(/^(\d+)([A-Za-z0-9])$/);
                // Multi-option cell: require best + runner-up format "2L/5T".
                const dualMatch = value.match(/^(\d+)([A-Za-z0-9])\/(\d+)([A-Za-z0-9])$/);
                if (options.length <= 1) {
                    if (selectedWord) {
                        // already chosen via exact match
                    } else if (simpleMatch) {
                        const idx = parseInt(simpleMatch[1], 10);
                        const providedLetter = simpleMatch[2].toUpperCase();
                        if (idx >= 0 && idx < options.length) {
                            const word = options[idx];
                            const expectedCh = word.trim().charAt(0).toUpperCase();
                            const gotCh = providedLetter.toUpperCase();
                            if (gotCh === expectedCh) {
                                selectedWord = word;
                            } else {
                                state.message = `⚠️ Letter mismatch: expected ${expectedCh} for option ${idx} (${word}), got ${gotCh}.`;
                            }
                        } else {
                            state.message = `Invalid index: ${idx} (valid range: 0-${options.length - 1})`;
                        }
                    } else {
                        state.message = `Invalid format for single-option cell. Expected <index><letter> (e.g., "0B"). Got: ${value}`;
                    }
                } else if (dualMatch) {
                    const bestIdx = parseInt(dualMatch[1], 10);
                    const bestLetter = dualMatch[2].toUpperCase();
                    const altIdx = parseInt(dualMatch[3], 10);
                    const altLetter = dualMatch[4].toUpperCase();

                    if (bestIdx === altIdx) {
                        state.message = `Invalid runner-up: best and runner-up indices must be different.`;
                    } else if (
                        bestIdx < 0 || bestIdx >= options.length ||
                        altIdx < 0 || altIdx >= options.length
                    ) {
                        state.message = `Invalid index in ${value} (valid range: 0-${options.length - 1})`;
                    } else {
                        const bestWord = options[bestIdx];
                        const altWord = options[altIdx];
                        const expectedBest = bestWord.trim().charAt(0).toUpperCase();
                        const expectedAlt = altWord.trim().charAt(0).toUpperCase();
                        if (bestLetter.toUpperCase() !== expectedBest) {
                            state.message = `⚠️ Best-choice letter mismatch: expected ${expectedBest} for option ${bestIdx} (${bestWord}), got ${bestLetter.toUpperCase()}.`;
                        } else if (altLetter.toUpperCase() !== expectedAlt) {
                            state.message = `⚠️ Runner-up letter mismatch: expected ${expectedAlt} for option ${altIdx} (${altWord}), got ${altLetter.toUpperCase()}.`;
                        } else {
                            selectedWord = bestWord;
                        }
                    }
                } else {
                    state.message = `Invalid format for multi-option cell. Expected <bestIndex><bestLetter>/<runnerIndex><runnerLetter> (e.g., "2L/5T"). Got: ${value}`;
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
