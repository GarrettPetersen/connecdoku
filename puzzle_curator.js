#!/usr/bin/env node
/* puzzle_curator.js  (red-herrings enforced, looping version)
   ------------------------------------------------------------------
   • Loads raw layouts from  ./puzzles_matrix/*.json
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

console.log("Starting puzzle curator...");

// ──────────────── paths ───────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, "puzzles_matrix");
const OUT_DIR = path.join(__dirname, "daily_puzzles");
const DB_FILE = path.join(OUT_DIR, "puzzles.json");

console.log("Directories:");
console.log("  RAW_DIR:", RAW_DIR);
console.log("  OUT_DIR:", OUT_DIR);
console.log("  DB_FILE:", DB_FILE);

if (!fs.existsSync(OUT_DIR)) {
    console.log("Creating output directory...");
    fs.mkdirSync(OUT_DIR);
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

// ──────────────── display helpers ──────────────────────────────────
function formatWithUsage(item, usageCount) {
    const count = usageCount[item] || 0;
    return `${item} (${count})`;
}

// ──────────────── gather unseen raw layouts ─────────────────────
console.log("Checking for raw puzzle files...");
function unseenFiles() {
    if (!fs.existsSync(RAW_DIR)) {
        console.log("RAW_DIR does not exist:", RAW_DIR);
        return [];
    }
    
    const files = fs.readdirSync(RAW_DIR);
    console.log(`Found ${files.length} files in RAW_DIR`);
    
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    console.log(`Found ${jsonFiles.length} JSON files`);
    
    // If there are too many files, we need a more efficient approach
    if (jsonFiles.length > 1000) {
        console.log("Too many files, using batch processing...");
        
        // Process files in batches to avoid hanging
        const batchSize = 100;
        const unseen = [];
        
        for (let i = 0; i < jsonFiles.length; i += batchSize) {
            const batch = jsonFiles.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(jsonFiles.length/batchSize)} (${batch.length} files)`);
            
            for (const f of batch) {
                try {
                    const { rows, cols } = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f)));
                    const isUsed = used.has(makeKey(rows, cols)) || used.has(makeKey(cols, rows));
                    if (!isUsed) {
                        unseen.push(f);
                        // Limit to first 10 unseen files to avoid overwhelming the curator
                        if (unseen.length >= 10) {
                            console.log(`Found ${unseen.length} unseen files, limiting to first 10 for this session`);
                            return unseen;
                        }
                    }
                } catch (error) {
                    console.log(`  Error reading ${f}:`, error.message);
                }
            }
        }
        
        console.log(`Found ${unseen.length} unseen puzzle files (limited to first 10)`);
        return unseen;
    } else {
        // Original approach for smaller file counts
        const unseen = jsonFiles.filter(f => {
            try {
                const { rows, cols } = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f)));
                const isUsed = used.has(makeKey(rows, cols)) || used.has(makeKey(cols, rows));
                if (isUsed) {
                    console.log(`  Skipping ${f} (already used)`);
                }
                return !isUsed;
            } catch (error) {
                console.log(`  Error reading ${f}:`, error.message);
                return false;
            }
        });
        
        console.log(`Found ${unseen.length} unseen puzzle files`);
        return unseen;
    }
}

// ──────────────── interactive loop ──────────────────────────────
console.log("Starting interactive loop...");
let rawFiles = unseenFiles();
if (!rawFiles.length) {
    console.log("No unseen puzzles available. Bye!");
    process.exit(0);
}

console.log(`Ready to curate ${rawFiles.length} puzzles`);
let fileIdx = 0;
while (fileIdx < rawFiles.length) {

    const file = rawFiles[fileIdx];
    console.log(`\nProcessing file ${fileIdx + 1}/${rawFiles.length}: ${file}`);
    
    const { rows, cols } = JSON.parse(fs.readFileSync(path.join(RAW_DIR, file)));
    const allCats = [...rows, ...cols];
    console.log(`Puzzle has ${rows.length} rows and ${cols.length} columns`);

    // ---- show categories upfront ----------------------------------------
    console.clear();
    console.log("Categories for this puzzle:\n");
    console.log("Rows:", rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
    console.log("\nCols:", cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));

    // ---- ask if user wants to skip this puzzle ------------------------
    console.log("\nDo you want to continue with this puzzle?");
    const continuePuzzle = await prompts.confirm({ 
        message: "Continue with this puzzle?", 
        default: true 
    });
    
    if (!continuePuzzle) {
        console.log("Skipping puzzle...");
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `skip_${file}`));
        rawFiles = unseenFiles();
        continue;
    }

    // ---- build viable-word matrix, abort if any cell empty ----------
    console.log("Building viable word matrix...");
    const viableGrid = Array.from({ length: 4 }, () => Array(4));
    let cellOk = true;
    for (let r = 0; r < 4 && cellOk; ++r)
        for (let c = 0; c < 4; ++c) {
            const opts = uniqueWords(rows[r], cols[c], allCats);
            if (!opts.length) { 
                console.log(`  Cell [${r}][${c}] has no valid words`);
                cellOk = false; 
                break; 
            }
            viableGrid[r][c] = opts;
        }

    if (!cellOk) {                         // skip invalid grid
        console.log(`⚠️  skipped ${file} (red-herring violation)`);
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `bad_${file}`));
        rawFiles = unseenFiles();
        continue;
    }

    console.log("Viable word matrix built successfully");

    // ---- curator chooses a word for each intersection ---------------
    const chosen = Array.from({ length: 4 }, () => Array(4));
    const usedWords = new Set();

    for (let r = 0; r < 4; ++r) {
        for (let c = 0; c < 4; ++c) {
            // Show current progress
            console.clear();
            console.log("Rows:", rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
            console.log("\nCols:", cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
            console.log("\nCurrent puzzle state:");
            console.table(chosen);
            console.log(`\nChoosing word for: ${formatWithUsage(rows[r], categoryUsage)} × ${formatWithUsage(cols[c], categoryUsage)}\n`);

            const opts = viableGrid[r][c].filter(w => !usedWords.has(w));

            let pick;
            if (opts.length === 1) {
                pick = opts[0];
                console.log(`auto: ${formatWithUsage(rows[r], categoryUsage)} × ${formatWithUsage(cols[c], categoryUsage)}  →  ${formatWithUsage(pick, wordUsage)}`);
            } else {
                console.log(`Showing ${opts.length} options for selection...`);
                
                pick = await prompts.select({
                    message: `Pick word for ${formatWithUsage(rows[r], categoryUsage)} × ${formatWithUsage(cols[c], categoryUsage)}`,
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

    // ---- final duplicate check (paranoia) ---------------------------
    if (usedWords.size !== 16) {
        console.log("❌ Duplicate word detected—skip puzzle.");
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `dup_${file}`));
        rawFiles = unseenFiles();
        continue;
    }

    // ---- preview & approval ----------------------------------------
    console.clear();
    console.log("Final Puzzle Review:\n");
    console.log("Rows:", rows.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
    console.log("\nCols:", cols.map((cat, i) => `${i + 1}. ${formatWithUsage(cat, categoryUsage)}`).join('\n     '));
    console.log("\nCompleted puzzle:");
    console.table(chosen);

    console.log("Asking for approval...");
    const approve = await prompts.confirm({ message: "Approve this puzzle?" });
    if (approve) {
        console.log("Puzzle approved, saving...");
        // Add puzzle to database without a date
        db.push({ rows, cols, words: chosen });
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `used_${file}`));
        used.add(makeKey(rows, cols));
        used.add(makeKey(cols, rows));
        
        // Update usage counts for this session
        for (const category of [...rows, ...cols]) {
            categoryUsage[category] = (categoryUsage[category] || 0) + 1;
        }
        for (const row of chosen) {
            for (const word of row) {
                wordUsage[word] = (wordUsage[word] || 0) + 1;
            }
        }
        
        console.log(`✅ Added (total approved: ${db.length})`);
    } else {
        console.log("Puzzle rejected, skipping...");
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `skip_${file}`));
        console.log("⏭️  skipped");
    }

    // ---- continue? --------------------------------------------------
    console.log("Asking if user wants to continue...");
    const cont = await prompts.confirm({ message: "Curate another puzzle?" });
    if (!cont) {
        console.log("User chose to stop");
        break;
    }

    console.log("User chose to continue, refreshing file list...");
    rawFiles = unseenFiles();
    fileIdx = 0;
}

console.log("🎉  Curator session ended.");
