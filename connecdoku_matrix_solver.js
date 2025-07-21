#!/usr/bin/env node
// connecdoku_matrix_solver.js   (lexicographic orientation enforced)
"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { Matrix } from "ml-matrix";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── paths ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const PUZZLE_DIR = path.join(__dirname, "puzzles_matrix");
if (!fs.existsSync(PUZZLE_DIR)) fs.mkdirSync(PUZZLE_DIR);

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

// ───────── load already-saved puzzles to avoid re-writes ────────────────────
begin("Loading saved puzzles");
const seen = new Set();
if (fs.existsSync(PUZZLE_DIR))
    for (const f of fs.readdirSync(PUZZLE_DIR).filter(x => x.endsWith(".json"))) {
        const p = JSON.parse(fs.readFileSync(path.join(PUZZLE_DIR, f)));
        if (p.rows && p.cols) seen.add([...p.rows, "|", ...p.cols].sort().join("|"));
    }
pbar(1, 1, "Loading saved puzzles", "", true); end();

// ───────── main search ──────────────────────────────────────────────────────
begin("Search");
let saved = 0;
for (let i = 0; i < n; ++i) {
    pbar(i + 1, n, "Search", `${saved} puzzles`);
    for (const j of neigh2[i]) if (j > i) {
        const ij = intersectSet(neigh2[i], neigh2[j]);
        for (const k of [...ij].filter(k => k > j)) {
            const ijk = intersectSet(ij, neigh2[k]);
            for (const l of [...ijk].filter(l => l > k)) {
                const R = [i, j, k, l];                          // rows (ascending)
                // columns that intersect all rows
                let cand = new Set(neigh1[R[0]]);
                for (let t = 1; t < 4; ++t) cand = intersectSet(cand, neigh1[R[t]]);
                for (const r of R) cand.delete(r);
                cand = new Set([...cand].filter(c => !R.some(r => S[r][c])));
                if (cand.size < 4) continue;

                const cArr = [...cand], m = cArr.length;
                for (let a = 0; a < m; ++a)
                    for (let b = a + 1; b < m; ++b) {
                        const x = cArr[a], y = cArr[b];
                        if (!B[x][y]) continue;
                        for (let c = a + 1; c < m; ++c) {
                            const z = cArr[c];
                            if (!(B[x][z] && B[y][z])) continue;
                            for (let d = c + 1; d < m; ++d) {
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
                                const key = [...rows, "|", ...cols].sort().join("|");
                                if (seen.has(key)) continue;
                                seen.add(key);

                                const fileKey = sha256(rows.join("|") + cols.join("|")).slice(0, 12);
                                fs.writeFileSync(
                                    path.join(PUZZLE_DIR, `${fileKey}.json`),
                                    JSON.stringify({ rows, cols, size: "4x4" }, null, 2)
                                );
                                ++saved;
                            }
                        }
                    }
            }
        }
    }
}
pbar(n, n, "Search", `${saved} puzzles`, true); end();
console.log(`\nSaved ${saved} new puzzles to ${PUZZLE_DIR}/`);
