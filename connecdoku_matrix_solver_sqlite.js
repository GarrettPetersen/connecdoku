#!/usr/bin/env node
// connecdoku_matrix_solver_sqlite.js – parallel bit-vector edition
//
// main thread:
//   • sets up DB (WAL, sync=OFF) and spawns one worker per CPU
//   • receives puzzles, inserts in 1 000-row batches
//   • draws a progress-bar line per worker
//
// worker thread:
//   • runs the full solver but only for i ≡ id (mod nWorkers)
//   • posts {puzzle}, {tick}, {done} messages
//
// ---------------------------------------------------------------

"use strict";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import sqlite3 from "sqlite3";
import { Matrix } from "ml-matrix";
import { performance } from "perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, "data");
const WORDS_F   = path.join(DATA_DIR, "words.json");
const CATS_F    = path.join(DATA_DIR, "categories.json");
const META_CATS_F = path.join(DATA_DIR, "meta_categories.json");
const DB_PATH   = path.join(__dirname, "puzzles.db");

// ───────── helpers ──────────────────────────────────────────────
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const BAR_W = 30;
function bar(p) { const f = Math.round(p * BAR_W); return "█".repeat(f) + "░".repeat(BAR_W - f); }
function fmt(s) { if (!isFinite(s)) return "??"; const h = s/3600|0, m = s/60%60|0; return h?`${h}h${m.toString().padStart(2,"0")}m`:m?`${m}m`:`${s|0}s`; }

/*─────────────────────────── MAIN THREAD ──────────────────────────*/
if (isMainThread) {
  const nWorkers = os.cpus().length;
  console.log(`Launching ${nWorkers} workers…`);

  // ── DB setup ──
  const db = new sqlite3.Database(DB_PATH);
  db.serialize(() => {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=OFF");
    db.run(`CREATE TABLE IF NOT EXISTS puzzles (
              puzzle_hash TEXT PRIMARY KEY,
              row0 TEXT,row1 TEXT,row2 TEXT,row3 TEXT,
              col0 TEXT,col1 TEXT,col2 TEXT,col3 TEXT,
              word_list_hash TEXT,
              timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
              rank INTEGER
            )`);
  });
  const wordListHash = sha256(fs.readFileSync(CATS_F));

  // prepared statement template for multi-row insert
  const insert = (rows, cb) => {
    if (!rows.length) return cb && cb();
    const ph = rows.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
    const flat = rows.flatMap(p => [p.hash, ...p.rows, ...p.cols, wordListHash]);
    db.run(`INSERT OR IGNORE INTO puzzles
            (puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3,word_list_hash)
            VALUES ${ph}`, flat, cb);
  };

  const BATCH_SZ = 1000;
  let batch = [];

  // ── progress bookkeeping ──
  const status = Array.from({ length: nWorkers }, () => ({ i: 0, total: 1, done: false }));
  const t0 = performance.now();
  function redraw() {
    const elapsed = (performance.now() - t0) / 1000;
    let out = "";
    status.forEach((st, idx) => {
      const pct = Math.min(st.i / st.total, 1);
      out += `\nW${idx} [${bar(pct)}] ${(pct*100).toFixed(1).padStart(6)}%${st.done?" ✓":""}`;
    });
    out += `\nBatch ${batch.length}/${BATCH_SZ}   elapsed ${fmt(elapsed)}`;
    process.stdout.write("\x1b[H\x1b[J" + out);  // clear + write
  }
  process.stdout.write("\x1b[2J\x1b[H");        // clear screen once

  // ── spawn workers ──
  let active = nWorkers;
  for (let id = 0; id < nWorkers; id++) {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { id, nWorkers } });
    w.on("message", msg => {
      if (msg.type === "puzzle") {
        batch.push(msg);
        if (batch.length >= BATCH_SZ) insert(batch.splice(0, BATCH_SZ), redraw);
      } else if (msg.type === "tick") {
        status[msg.id] = { ...status[msg.id], i: msg.i, total: msg.total };
        redraw();
      } else if (msg.type === "done") {
        status[msg.id].done = true;
        active--;
        redraw();
        if (active === 0) insert(batch, () => db.close(() => console.log("\nAll done.")));
      }
    });
    w.on("error", e => console.error("worker error:", e));
  }

/*────────────────────────── WORKER THREAD ─────────────────────────*/
} else {

  const { id: WID, nWorkers: NW } = workerData;

  // ── load data ──
  const wordsJson      = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));
  const categoriesJson = JSON.parse(fs.readFileSync(CATS_F,  "utf8"));
  const metaCatsJson   = JSON.parse(fs.readFileSync(META_CATS_F, "utf8"));
  const ALL_WORDS      = Object.keys(wordsJson);
  const WORD_IDX       = new Map(ALL_WORDS.map((w, i) => [w, i]));
  const MASK_LEN       = Math.ceil(ALL_WORDS.length / 32);

  // Build category to meta-category mapping
  const categoryToMeta = new Map();
  for (const [metaCat, categories] of Object.entries(metaCatsJson)) {
    if (metaCat !== "No Meta Category") {  // Skip "No Meta Category" for constraint checking
      for (const category of categories) {
        categoryToMeta.set(category, metaCat);
      }
    }
  }

  // Check if a set of categories violates the meta-category constraint (max 2 per meta-category)
  function checkMetaCategoryConstraint(categories) {
    const metaCounts = new Map();
    for (const category of categories) {
      const metaCat = categoryToMeta.get(category);
      if (metaCat) {
        const count = metaCounts.get(metaCat) || 0;
        if (count >= 2) return false;  // Already have 2 from this meta-category
        metaCounts.set(metaCat, count + 1);
      }
    }
    return true;
  }

  function makeMask(arr) {
    const m = new Uint32Array(MASK_LEN);
    for (const w of arr) {
      const idx = WORD_IDX.get(w);
      if (idx !== undefined) m[idx >>> 5] |= 1 << (idx & 31);
    }
    return m;
  }
  function intersects(a, b) { for (let i = 0; i < MASK_LEN; i++) if (a[i] & b[i]) return true; return false; }
  function subset(a, b)      { for (let i = 0; i < MASK_LEN; i++) if ((a[i] & ~b[i]) !== 0) return false; return true; }

  const cats = Object.keys(categoriesJson).filter(k => categoriesJson[k].length >= 4).sort();
  const n    = cats.length;
  const mask = cats.map(c => makeMask(categoriesJson[c]));

  // subset mask
  const S = Array.from({ length: n }, () => Array(n).fill(false));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (subset(mask[i], mask[j]) || subset(mask[j], mask[i])) S[i][j] = S[j][i] = true;

  // 1-away
  const A = Matrix.zeros(n, n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (!S[i][j] && intersects(mask[i], mask[j])) A.set(i, j, 1), A.set(j, i, 1);
  const N1 = Array.from({ length: n }, (_, i) =>
    new Set(A.getRow(i).flatMap((v, idx) => v ? idx : []))
  );

  // 2-away
  const A2 = A.mmul(A);
  const B  = Array.from({ length: n }, () => Array(n).fill(false));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (!S[i][j] && A2.get(i, j) >= 4) B[i][j] = B[j][i] = true;
  const N2 = Array.from({ length: n }, (_, i) =>
    new Set(B[i].flatMap((v, idx) => v ? idx : []))
  );

  // memoised pair → third-row list
  const cache = new Map();
  const tList = (i, j) => {
    const key = (i << 11) | j;
    if (cache.has(key)) return cache.get(key);
    const arr = [...N2[i]].filter(k => k > j && N2[j].has(k)).sort((a, b) => a - b);
    cache.set(key, arr);
    return arr;
  };
  const excl = rows => {               // early row red-herring
    for (let r = 0; r < 4; r++) {
      const m = mask[rows[r]];
      let other = new Uint32Array(MASK_LEN);
      for (let o = 0; o < 4; o++) if (o !== r)
        for (let k = 0; k < MASK_LEN; k++) other[k] |= mask[rows[o]][k];
      let ok = false;
      for (let k = 0; k < MASK_LEN; k++) if (m[k] & ~other[k]) { ok = true; break; }
      if (!ok) return false;
    }
    return true;
  };

  /*──── search (only i ≡ WID mod NW) ────*/
  const totalOuter = Math.ceil((n - WID) / NW);
  let outer = 0;

  for (let i = WID; i < n; i += NW) {
    const jList = [...N2[i]].filter(j => j > i).sort((a, b) => a - b);
    for (const j of jList) {
      const kList = tList(i, j);
      for (const k of kList) {
        const lList = kList.filter(l => l > k && N2[k].has(l));
        for (const l of lList) {

          const rows = [i, j, k, l];
          if (!excl(rows)) continue;
          
          // Check meta-category constraint for rows
          const rowCategories = rows.map(idx => cats[idx]);
          if (!checkMetaCategoryConstraint(rowCategories)) continue;

          // column candidates
          let cand = new Set(N1[i]);
          for (let r = 1; r < 4; r++) {
            const tmp = new Set();
            for (const x of cand) if (N1[rows[r]].has(x)) tmp.add(x);
            cand = tmp;
          }
          for (const r of rows) cand.delete(r);
          cand = new Set([...cand].filter(c => !rows.some(r => S[r][c])));
          if (cand.size < 4 || Math.min(...cand) <= rows[0]) continue;

          const cArr = [...cand].sort((a, b) => a - b), m = cArr.length;
          for (let a = 0; a < m - 3; a++)
            for (let b = a + 1; b < m - 2; b++) {
              const x = cArr[a], y = cArr[b];
              if (!B[x][y]) continue;
              for (let c = b + 1; c < m - 1; c++) {
                const z = cArr[c];
                if (!(B[x][z] && B[y][z])) continue;
                for (let d = c + 1; d < m; d++) {
                  const w = cArr[d];
                  if (!(B[x][w] && B[y][w] && B[z][w])) continue;
                  const cols = [x, y, z, w];

                  // Check meta-category constraint for complete puzzle (rows + columns)
                  const allCategories = [...rowCategories, ...cols.map(idx => cats[idx])];
                  if (!checkMetaCategoryConstraint(allCategories)) continue;

                  // full uniqueness check
                  let ok = true;
                  const all = new Set([...rows, ...cols]);
                  outerRH:
                  for (const r of rows)
                    for (const cc of cols) {
                      const own = mask[r].map((v, idx) => v & mask[cc][idx]);
                      for (const o of all) if (o !== r && o !== cc)
                        for (let k = 0; k < MASK_LEN; k++) own[k] &= ~mask[o][k];
                      let nz = false;
                      for (let k = 0; k < MASK_LEN; k++) if (own[k]) { nz = true; break; }
                      if (!nz) { ok = false; break outerRH; }
                    }
                  if (!ok) continue;

                  parentPort.postMessage({
                    type: "puzzle",
                    hash: sha256(rows.map(v => cats[v]).join("|") + cols.map(v => cats[v]).join("|")),
                    rows: rows.map(v => cats[v]),
                    cols: cols.map(v => cats[v])
                  });
                }
              }
            }
        }
      }
    }
    outer++;
    parentPort.postMessage({ type: "tick", id: WID, i: outer, total: totalOuter });
  }
  parentPort.postMessage({ type: "done", id: WID });
}
