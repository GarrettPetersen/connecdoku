#!/usr/bin/env node
// connecdoku_matrix_solver_sqlite.js   (de-duplicated, canonically ordered, batched inserts)
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { Matrix } from "ml-matrix";
import sqlite3 from "sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── paths ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const DB_PATH = path.join(__dirname, "puzzles.db");

// ───────── helpers ──────────────────────────────────────────────────────────
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const intersectSet = (a, b) => {
    const r = new Set();
    const s = a.size < b.size ? a : b, t = s === a ? b : a;
    for (const x of s) if (t.has(x)) r.add(x);
    return r;
};
const isSubset = (a, b, dict) => dict[a].every(w => dict[b].includes(w));
const isC4 = (g, i, j, k, l) =>
    g[i][j] && g[i][k] && g[i][l] && g[j][k] && g[j][l] && g[k][l];

// simple progress bar
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

// ───────── database setup ───────────────────────────────────────────────────
function setupDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, err => {
            if (err) return reject(err);
            db.run(
                `CREATE TABLE IF NOT EXISTS puzzles (
                    puzzle_hash TEXT PRIMARY KEY,
                    row0 TEXT, row1 TEXT, row2 TEXT, row3 TEXT,
                    col0 TEXT, col1 TEXT, col2 TEXT, col3 TEXT,
                    word_list_hash TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    iterators TEXT
                )`,
                err2 => (err2 ? reject(err2) : resolve(db))
            );
        });
    });
}

// ───────── load data ────────────────────────────────────────────────────────
const wordsJson = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));
const categoriesJson = JSON.parse(fs.readFileSync(CATS_F, "utf8"));
const cats = Object.keys(categoriesJson).filter(c => categoriesJson[c].length >= 4);
const n = cats.length;
console.log(`Total usable categories: ${n}`);
const wordSets = cats.map(c => new Set(categoriesJson[c]));

// ───────── subset mask S ────────────────────────────────────────────────────
begin("Subset mask");
const S = Array.from({ length: n }, () => Array(n).fill(false));
for (let i = 0; i < n; ++i) {
    for (let j = i + 1; j < n; ++j)
        if (isSubset(cats[i], cats[j], categoriesJson) || isSubset(cats[j], cats[i], categoriesJson))
            S[i][j] = S[j][i] = true;
    if (!(i & 15)) pbar(i + 1, n, "Subset mask");
}
pbar(n, n, "Subset mask", "", true); end();

// ───────── 1-away A ─────────────────────────────────────────────────────────
begin("1-away matrix");
const A = Matrix.zeros(n, n);
for (let i = 0; i < n; ++i) {
    const si = wordSets[i];
    for (let j = i + 1; j < n; ++j) {
        if (S[i][j]) continue;
        const sj = wordSets[j], small = si.size < sj.size ? si : sj, big = small === si ? sj : si;
        for (const w of small) if (big.has(w)) { A.set(i, j, 1); A.set(j, i, 1); break; }
    }
    if (!(i & 15)) pbar(i + 1, n, "1-away matrix");
}
pbar(n, n, "1-away matrix", "", true); end();
const neigh1 = Array.from({ length: n }, (_, i) => new Set(A.getRow(i).flatMap((v, idx) => v ? idx : [])));

// ───────── 2-away B ─────────────────────────────────────────────────────────
begin("2-away matrix");
const A2 = A.mmul(A);
const B = Array.from({ length: n }, () => Array(n).fill(false));
for (let i = 0; i < n; ++i) {
    for (let j = i + 1; j < n; ++j)
        if (!S[i][j] && A2.get(i, j) >= 4) B[i][j] = B[j][i] = true;
    if (!(i & 15)) pbar(i + 1, n, "2-away matrix");
}
pbar(n, n, "2-away matrix", "", true); end();
const neigh2 = Array.from({ length: n }, (_, i) => new Set(B[i].flatMap((v, idx) => v ? idx : [])));

// ───────── main search ──────────────────────────────────────────────────────
async function main() {
    const db = await setupDatabase();
    console.log(`Database initialised at ${DB_PATH}`);

    // one prepared statement for the whole run
    const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO puzzles
         (puzzle_hash, row0, row1, row2, row3,
          col0, col1, col2, col3,
          word_list_hash, iterators)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // all inserts happen in one big transaction
    await new Promise((res, rej) => db.run("BEGIN TRANSACTION", err => (err ? rej(err) : res())));

    // Create word-list hash
    const wordListHash = sha256(JSON.stringify(categoriesJson));
    console.log(`Word list hash: ${wordListHash}`);

    // ── resume logic ───────────────────────────────────────────────────────
    function getLastIterators() {
        return new Promise(resolve => {
            db.get(
                `SELECT iterators FROM puzzles
                 WHERE word_list_hash = ?
                 ORDER BY timestamp DESC
                 LIMIT 1`,
                [wordListHash],
                (err, row) => {
                    if (err || !row) return resolve(null);
                    try { resolve(JSON.parse(row.iterators)); }
                    catch { resolve(null); }
                }
            );
        });
    }

    const last = await getLastIterators();
    let startI = 0, startJ = 0, startK = 0, startL = 0;
    let startA = 0, startB = 0, startC = 0, startD = 0;
    if (last) {
        console.log("Resuming from", last);
        ({ i: startI = 0, j: startJ = 0, k: startK = 0, l: startL = 0,
           a: startA = 0, b: startB = 0, c: startC = 0, d: startD = 0 } = last);
    }

    // helper to run the prepared insert stmt and return whether it wrote
    const savePuzzle = (rows, cols, iter) => new Promise((resolve, reject) => {
        const puzzleHash = sha256(rows.join("|") + cols.join("|"));
        insertStmt.run(
            [puzzleHash, ...rows, ...cols, wordListHash, JSON.stringify(iter)],
            function (err) {
                if (err) reject(err);
                else resolve(this.changes === 1);   // true on actual insert
            }
        );
    });

    begin("Search");
    let saved = 0, totalFound = 0;

    for (let i = startI; i < n; ++i) {
        pbar(i + 1, n, "Search", `${totalFound} found, ${saved} new`);

        // second row: all 2-away neighbours of i that are > i (sorted)
        const jList = [...neigh2[i]].filter(j => j > i).sort((a, b) => a - b);
        for (const j of jList) {
            if (i === startI && j < startJ) continue;
            const ij = intersectSet(neigh2[i], neigh2[j]);

            // third row candidates > j
            const kList = [...ij].filter(k => k > j).sort((a, b) => a - b);
            for (const k of kList) {
                if (i === startI && j === startJ && k < startK) continue;
                const ijk = intersectSet(ij, neigh2[k]);

                // fourth row candidates > k
                const lList = [...ijk].filter(l => l > k).sort((a, b) => a - b);
                for (const l of lList) {
                    if (i === startI && j === startJ && k === startK && l < startL) continue;

                    const R = [i, j, k, l];                 // rows ascending

                    // columns that intersect all rows and are not subsets/ supersets
                    let cand = new Set(neigh1[R[0]]);
                    for (let t = 1; t < 4; ++t) cand = intersectSet(cand, neigh1[R[t]]);
                    for (const r of R) cand.delete(r);
                    cand = new Set([...cand].filter(c => !R.some(r => S[r][c])));
                    if (cand.size < 4) continue;

                    const cArr = [...cand].sort((x, y) => x - y);   // canonical order
                    const m = cArr.length;

                    for (let a = (i === startI && j === startJ && k === startK && l === startL) ? startA : 0; a < m; ++a)
                    for (let b = (i === startI && j === startJ && k === startK && l === startL && a === startA) ? Math.max(startB, a + 1) : a + 1; b < m; ++b) {
                        const x = cArr[a], y = cArr[b];
                        if (!B[x][y]) continue;

                        for (let c = (i === startI && j === startJ && k === startK && l === startL && a === startA && b === startB) ? Math.max(startC, b + 1) : b + 1; c < m; ++c) {
                            const z = cArr[c];
                            if (!(B[x][z] && B[y][z])) continue;

                            for (let d = (i === startI && j === startJ && k === startK && l === startL && a === startA && b === startB && c === startC) ? Math.max(startD, c + 1) : c + 1; d < m; ++d) {
                                const w = cArr[d];
                                if (!isC4(B, x, y, z, w)) continue;

                                const C = [x, y, z, w];           // columns ascending

                                // orientation rule: R[0] must be lexicographically ≤ C[0]
                                if (cats[R[0]] > cats[C[0]]) continue;

                                // red-herring test
                                const all = new Set([...R, ...C]);
                                let ok = true;
                                outer: for (const r of R)
                                    for (const cc of C) {
                                        let v = intersectSet(wordSets[r], wordSets[cc]);
                                        for (const o of all)
                                            if (o !== r && o !== cc)
                                                v = new Set([...v].filter(wd => !wordSets[o].has(wd)));
                                        if (!v.size) { ok = false; break outer; }
                                    }
                                if (!ok) continue;

                                ++totalFound;
                                try {
                                    const wasNew = await savePuzzle(
                                        R.map(v => cats[v]),
                                        C.map(v => cats[v]),
                                        { i, j, k, l, a, b, c, d }
                                    );
                                    if (wasNew) ++saved;
                                    pbar(i + 1, n, "Search", `${totalFound} found, ${saved} new`, true);
                                } catch (err) {
                                    console.error("Error saving puzzle:", err);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pbar(n, n, "Search", `${totalFound} found, ${saved} new`, true); end();
    console.log(`\n${totalFound} puzzles found, ${saved} new puzzles saved to database`);

    // commit and clean up
    await new Promise((res, rej) => db.run("COMMIT", err => (err ? rej(err) : res())));
    insertStmt.finalize();
    db.close(err => {
        if (err) console.error("Error closing database:", err.message);
        else     console.log("Database connection closed");
    });
}

main().catch(console.error);
