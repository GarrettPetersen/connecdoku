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
   -----------------------------------------------------------------*/

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as prompts from "@inquirer/prompts";

// ──────────────── paths ───────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, "puzzles_matrix");
const OUT_DIR = path.join(__dirname, "daily_puzzles");
const DB_FILE = path.join(OUT_DIR, "puzzles.json");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

// ──────────────── load / init database ───────────────────────────
let db = [];
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));

const canon = arr => [...arr].sort().join("|");
const makeKey = (rows, cols) => canon(rows) + "::" + canon(cols);
const used = new Set(
    db.flatMap(p => [makeKey(p.rows, p.cols), makeKey(p.cols, p.rows)])
);

// ──────────────── word look-ups ──────────────────────────────────
const categoriesJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "categories.json"))
);
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

// ──────────────── gather unseen raw layouts ─────────────────────
function unseenFiles() {
    return fs.readdirSync(RAW_DIR)
        .filter(f => f.endsWith(".json"))
        .filter(f => {
            const { rows, cols } = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f)));
            return !used.has(makeKey(rows, cols)) &&
                !used.has(makeKey(cols, rows));
        });
}

// ──────────────── interactive loop ──────────────────────────────
let rawFiles = unseenFiles();
if (!rawFiles.length) {
    console.log("No unseen puzzles available. Bye!");
    process.exit(0);
}

let fileIdx = 0;
while (fileIdx < rawFiles.length) {

    const file = rawFiles[fileIdx];
    const { rows, cols } = JSON.parse(fs.readFileSync(path.join(RAW_DIR, file)));
    const allCats = [...rows, ...cols];

    // ---- show categories upfront ----------------------------------------
    console.clear();
    console.log("Categories for this puzzle:\n");
    console.log("Rows:", rows.map((cat, i) => `${i + 1}. ${cat}`).join('\n     '));
    console.log("\nCols:", cols.map((cat, i) => `${i + 1}. ${cat}`).join('\n     '));
    console.log("\nPress Enter to start choosing words...");
    await prompts.input({ message: '' });

    // ---- build viable-word matrix, abort if any cell empty ----------
    const viableGrid = Array.from({ length: 4 }, () => Array(4));
    let cellOk = true;
    for (let r = 0; r < 4 && cellOk; ++r)
        for (let c = 0; c < 4; ++c) {
            const opts = uniqueWords(rows[r], cols[c], allCats);
            if (!opts.length) { cellOk = false; break; }
            viableGrid[r][c] = opts;
        }

    if (!cellOk) {                         // skip invalid grid
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `bad_${file}`));
        console.log(`⚠️  skipped ${file} (red-herring violation)`);
        rawFiles = unseenFiles();
        continue;
    }

    // ---- curator chooses a word for each intersection ---------------
    const chosen = Array.from({ length: 4 }, () => Array(4));
    const usedWords = new Set();

    for (let r = 0; r < 4; ++r) {
        for (let c = 0; c < 4; ++c) {
            // Show current progress
            console.clear();
            console.log("Rows:", rows.map((cat, i) => `${i + 1}. ${cat}`).join('\n     '));
            console.log("\nCols:", cols.map((cat, i) => `${i + 1}. ${cat}`).join('\n     '));
            console.log("\nCurrent puzzle state:");
            console.table(chosen);
            console.log(`\nChoosing word for: ${rows[r]} × ${cols[c]}\n`);

            const opts = viableGrid[r][c].filter(w => !usedWords.has(w));

            let pick;
            if (opts.length === 1) {
                pick = opts[0];
                console.log(`auto: ${rows[r]} × ${cols[c]}  →  ${pick}`);
            } else {
                pick = await prompts.select({
                    message: `Pick word for ${rows[r]} × ${cols[c]}`,
                    choices: opts.map(w => ({ value: w, label: w }))
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
    console.log("Rows:", rows.map((cat, i) => `${i + 1}. ${cat}`).join('\n     '));
    console.log("\nCols:", cols.map((cat, i) => `${i + 1}. ${cat}`).join('\n     '));
    console.log("\nCompleted puzzle:");
    console.table(chosen);

    const approve = await prompts.confirm({ message: "Approve this puzzle?" });
    if (approve) {
        // Add puzzle to database without a date
        db.push({ rows, cols, words: chosen });
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `used_${file}`));
        used.add(makeKey(rows, cols));
        used.add(makeKey(cols, rows));
        console.log(`✅ Added (total approved: ${db.length})`);
    } else {
        fs.renameSync(path.join(RAW_DIR, file),
            path.join(RAW_DIR, `skip_${file}`));
        console.log("⏭️  skipped");
    }

    // ---- continue? --------------------------------------------------
    const cont = await prompts.confirm({ message: "Curate another puzzle?" });
    if (!cont) break;

    rawFiles = unseenFiles();
    fileIdx = 0;
}

console.log("🎉  Curator session ended.");
