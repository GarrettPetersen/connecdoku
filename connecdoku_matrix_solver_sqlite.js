#!/usr/bin/env node
// connecdoku_matrix_solver_sqlite.js   (lexicographic orientation enforced)
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
const intersectSet = (a, b) => { const r = new Set(); const s = a.size < b.size ? a : b, t = s === a ? b : a; for (const x of s) if (t.has(x)) r.add(x); return r; };
const isSubset = (a, b, dict) => dict[a].every(w => dict[b].includes(w));
const isC4 = (g, i, j, k, l) => g[i][j] && g[i][k] && g[i][l] && g[j][k] && g[j][l] && g[k][l];

// simple progress bar
const BAR_W = 40, start = new Map(); let last = 0;
function fmt(s) { if (!isFinite(s)) return "??"; const h = s / 3600 | 0, m = s / 60 % 60 | 0; return h ? `${h}h ${m}m` : m ? `${m}m` : `${s | 0}s`; }
function pbar(done, total, stage, extra = "", force = false) {
    const now = Date.now(); if (!force && now - last < 120) return; last = now;
    const pct = total ? done / total : 0, fill = Math.round(pct * BAR_W);
    const bar = "█".repeat(fill) + "░".repeat(BAR_W - fill);
    const el = (now - start.get(stage)) / 1000; const eta = pct ? el / pct - el : Infinity;
    process.stdout.write(`\r[${bar}] ${(pct * 100).toFixed(1).padStart(5)}% ${extra}  [${fmt(el)}/${fmt(eta)}] `);
}
function begin(stage) { start.set(stage, Date.now()); console.log(`\n${stage}...`); }
function end() { process.stdout.write("\n"); }

// ───────── database setup ────────────────────────────────────────────────────
function setupDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
                reject(err);
                return;
            }

            db.run(`CREATE TABLE IF NOT EXISTS puzzles (
                puzzle_hash TEXT PRIMARY KEY,
                row0 TEXT,
                row1 TEXT,
                row2 TEXT,
                row3 TEXT,
                col0 TEXT,
                col1 TEXT,
                col2 TEXT,
                col3 TEXT,
                word_list_hash TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                iterators TEXT
            )`, (err) => {
                if (err) {
                    console.error('Error creating table:', err.message);
                    reject(err);
                    return;
                }
                resolve(db);
            });
        });
    });
}

// ───────── database operations ───────────────────────────────────────────────
function savePuzzle(db, puzzleHash, rows, cols, wordListHash, iterators) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO puzzles 
            (puzzle_hash, row0, row1, row2, row3, col0, col1, col2, col3, word_list_hash, iterators)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run([
            puzzleHash,
            rows[0], rows[1], rows[2], rows[3],
            cols[0], cols[1], cols[2], cols[3],
            wordListHash,
            JSON.stringify(iterators)
        ], function (err) {
            if (err) {
                console.error('Error saving puzzle:', err.message);
                reject(err);
            } else {
                // this.changes will be 1 if INSERT succeeded, 0 if IGNORE (already existed)
                resolve(this.changes === 1);
            }
        });

        stmt.finalize();
    });
}

function getLastIterators(db, wordListHash) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT iterators FROM puzzles 
             WHERE word_list_hash = ? 
             ORDER BY timestamp DESC 
             LIMIT 1`,
            [wordListHash],
            (err, row) => {
                if (err) {
                    reject(err);
                } else if (row) {
                    try {
                        resolve(JSON.parse(row.iterators));
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            }
        );
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
    for (let j = i + 1; j < n; ++j) if (!S[i][j] && A2.get(i, j) >= 4) B[i][j] = B[j][i] = true;
    if (!(i & 15)) pbar(i + 1, n, "2-away matrix");
}
pbar(n, n, "2-away matrix", "", true); end();

const neigh2 = Array.from({ length: n }, (_, i) => new Set(B[i].flatMap((v, idx) => v ? idx : [])));

// ───────── main search ──────────────────────────────────────────────────────
async function main() {
    const db = await setupDatabase();
    console.log(`Database initialized at ${DB_PATH}`);

    // Create word list hash for this run
    const wordListHash = sha256(JSON.stringify(categoriesJson));
    console.log(`Word list hash: ${wordListHash}`);

    // Get last iterators if we have them
    const lastIterators = await getLastIterators(db, wordListHash);
    let startI = 0, startJ = 0, startK = 0, startL = 0;
    let startA = 0, startB = 0, startC = 0, startD = 0;

    if (lastIterators) {
        console.log(`Resuming from previous search position:`, lastIterators);
        startI = lastIterators.i || 0;
        startJ = lastIterators.j || 0;
        startK = lastIterators.k || 0;
        startL = lastIterators.l || 0;
        startA = lastIterators.a || 0;
        startB = lastIterators.b || 0;
        startC = lastIterators.c || 0;
        startD = lastIterators.d || 0;
    } else {
        console.log(`Starting fresh search (no previous iterators found)`);
    }

    begin("Search");
    let saved = 0;
    let totalFound = 0;

    for (let i = startI; i < n; ++i) {
        pbar(i + 1, n, "Search", `${totalFound} found, ${saved} new`);

        for (const j of neigh2[i]) if (j > i) {
            const jStart = (i === startI) ? Math.max(j, startJ) : j;
            for (const jj of [...neigh2[i]].filter(jj => jj >= jStart)) {
                const ij = intersectSet(neigh2[i], neigh2[jj]);
                const kStart = (i === startI && jj === startJ) ? Math.max(startK, jj + 1) : jj + 1;
                for (const k of [...ij].filter(k => k >= kStart)) {
                    const ijk = intersectSet(ij, neigh2[k]);
                    const lStart = (i === startI && jj === startJ && k === startK) ? Math.max(startL, k + 1) : k + 1;
                    for (const l of [...ijk].filter(l => l >= lStart)) {
                        const R = [i, jj, k, l];                          // rows (ascending)
                        // columns that intersect all rows
                        let cand = new Set(neigh1[R[0]]);
                        for (let t = 1; t < 4; ++t) cand = intersectSet(cand, neigh1[R[t]]);
                        for (const r of R) cand.delete(r);
                        cand = new Set([...cand].filter(c => !R.some(r => S[r][c])));
                        if (cand.size < 4) continue;

                        const cArr = [...cand], m = cArr.length;
                        const aStart = (i === startI && jj === startJ && k === startK && l === startL) ? startA : 0;
                        for (let a = aStart; a < m; ++a) {
                            const bStart = (i === startI && jj === startJ && k === startK && l === startL && a === startA) ? startB : a + 1;
                            for (let b = bStart; b < m; ++b) {
                                const x = cArr[a], y = cArr[b];
                                if (!B[x][y]) continue;
                                const cStart = (i === startI && jj === startJ && k === startK && l === startL && a === startA && b === startB) ? startC : a + 1;
                                for (let c = cStart; c < m; ++c) {
                                    const z = cArr[c];
                                    if (!(B[x][z] && B[y][z])) continue;
                                    const dStart = (i === startI && jj === startJ && k === startK && l === startL && a === startA && b === startB && c === startC) ? startD : c + 1;
                                    for (let d = dStart; d < m; ++d) {
                                        const w = cArr[d];
                                        if (!isC4(B, x, y, z, w)) continue;
                                        const C = [x, y, z, w];                 // columns (ascending)

                                        // orientation rule: only keep if rows[0] < cols[0] lexicographically
                                        if (cats[R[0]] > cats[C[0]]) continue;

                                        // red-herring test
                                        const all = new Set([...R, ...C]);
                                        let ok = true;
                                        outer: for (const r of R)
                                            for (const cc of C) {
                                                let v = intersectSet(wordSets[r], wordSets[cc]);
                                                for (const o of all)
                                                    if (o !== r && o !== cc)
                                                        v = new Set([...v].filter(w => !wordSets[o].has(w)));
                                                if (!v.size) { ok = false; break outer; }
                                            }
                                        if (!ok) continue;

                                        const rows = R.map(v => cats[v]), cols = C.map(v => cats[v]);
                                        const puzzleHash = sha256(rows.join("|") + cols.join("|"));

                                        // Count total found
                                        ++totalFound;

                                        // Save to database
                                        try {
                                            const wasNew = await savePuzzle(db, puzzleHash, rows, cols, wordListHash, {
                                                i, j: jj, k, l, a, b, c, d
                                            });
                                            if (wasNew) {
                                                ++saved;
                                            }

                                            // Update progress bar immediately when a puzzle is found
                                            pbar(i + 1, n, "Search", `${totalFound} found, ${saved} new`, true);

                                            // Save current position every 100 puzzles
                                            if (saved % 100 === 0) {
                                                await savePuzzle(db, puzzleHash, rows, cols, wordListHash, {
                                                    i, j: jj, k, l, a, b, c, d
                                                });
                                            }
                                        } catch (err) {
                                            console.error('Error saving puzzle:', err);
                                        }
                                    }
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

    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        } else {
            console.log('Database connection closed');
        }
    });
}

main().catch(console.error); 