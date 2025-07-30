#!/usr/bin/env node
// connecdoku_matrix_solver_sqlite.js  –  bit-vector edition
//
//  • bit-vectors for every category (fast  ∩ / ⊆ / ≠∅)
//  • memoised row–pair → third-row list
//  • early red-herring reject
//  • single “rank” for fast resume
//  • progress bar clocked once per i-loop
//
//  Committing every 500 puzzles (INSERT OR IGNORE, one per row)

"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { Matrix } from "ml-matrix";
import sqlite3 from "sqlite3";
import { performance } from "perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── paths ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const DB_PATH = path.join(__dirname, "puzzles.db");

// ───────── helpers ──────────────────────────────────────────────────────────
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

function fmtTime(s) {
  if (!isFinite(s)) return "??";
  const h = s / 3600 | 0, m = s / 60 % 60 | 0;
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s | 0}s`;
}
const BAR_W = 40;
function drawBar(pct, found, saved, elapsed) {
  const clampedPct = Math.min(pct, 1.0); // Clamp to 100%
  const fill = Math.round(clampedPct * BAR_W);
  const bar  = "█".repeat(fill) + "░".repeat(BAR_W - fill);
  const eta  = pct ? elapsed / pct - elapsed : Infinity;
  process.stdout.write(
    `\r[${bar}] ${(pct*100).toFixed(1).padStart(5)}%  ${found} seen, ${saved} new  [${fmtTime(elapsed)}/${fmtTime(eta)}] `
  );
}

// ───────── database ─────────────────────────────────────────────────────────
function setupDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, err => {
      if (err) return reject(err);
      db.run(
        `CREATE TABLE IF NOT EXISTS puzzles (
           puzzle_hash      TEXT PRIMARY KEY,
           row0  TEXT, row1 TEXT, row2 TEXT, row3 TEXT,
           col0  TEXT, col1 TEXT, col2 TEXT, col3 TEXT,
           word_list_hash   TEXT,
           timestamp        DATETIME DEFAULT CURRENT_TIMESTAMP,
           rank             INTEGER
         )`, e2 => (e2 ? reject(e2) : resolve(db))
      );
    });
  });
}

// ───────── load data ────────────────────────────────────────────────────────
const wordsJson      = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));
const categoriesJson = JSON.parse(fs.readFileSync(CATS_F, "utf8"));

// master word list & indices
const ALL_WORDS = Object.keys(wordsJson);
const WORD_IDX  = new Map(ALL_WORDS.map((w,i) => [w,i]));
const W         = ALL_WORDS.length;
const CHUNK     = 32;
const MASK_LEN  = Math.ceil(W / CHUNK);

// bit-vector helpers
const pop32 = n => n - ((n >>> 1) & 0x55555555) -
                     ((n >>> 2) & 0x33333333) -
                     ((n >>> 3) & 0x11111111)  >>> 0 & 0x0F0F0F0F;

function makeMask(wordArray) {
  const m = new Uint32Array(MASK_LEN);
  for (const w of wordArray) {
    const idx = WORD_IDX.get(w);
    if (idx === undefined) continue;
    m[idx >>> 5] |= 1 << (idx & 31);
  }
  return m;
}
function intersects(a,b){
  for (let i=0;i<MASK_LEN;i++) if (a[i] & b[i]) return true;
  return false;
}
function isSubsetMask(a,b){
  for (let i=0;i<MASK_LEN;i++) if ((a[i] & ~b[i]) !== 0) return false;
  return true;
}

// categories with ≥4 words
const cats = Object.keys(categoriesJson)
  .filter(k => categoriesJson[k].length >= 4)
  .sort();                       // canonical order
const n = cats.length;
console.log(`Total usable categories: ${n}`);

// bit-vector per category
const bitMasks = cats.map(c => makeMask(categoriesJson[c]));

// ───────── subset mask S  (using bit-vectors) ───────────────────────────────
console.log("Subset mask…");
const S = Array.from({length:n}, () => Array(n).fill(false));
for (let i=0;i<n;i++){
  for (let j=i+1;j<n;j++){
    if (isSubsetMask(bitMasks[i], bitMasks[j]) ||
        isSubsetMask(bitMasks[j], bitMasks[i]))
      S[i][j] = S[j][i] = true;
  }
}

// ───────── 1-away (A) and 2-away (B) matrices ──────────────────────────────
console.log("1-away matrix…");
const A = Matrix.zeros(n,n);
for (let i=0;i<n;i++){
  for (let j=i+1;j<n;j++){
    if (S[i][j]) continue;
    if (intersects(bitMasks[i], bitMasks[j])){
      A.set(i,j,1); A.set(j,i,1);
    }
  }
}
const neigh1 = Array.from({length:n},(_,i) =>
  new Set(A.getRow(i).flatMap((v,idx)=>v?idx:[]))
);

console.log("2-away matrix…");
const A2 = A.mmul(A);
const B  = Array.from({length:n}, () => Array(n).fill(false));
for (let i=0;i<n;i++){
  for (let j=i+1;j<n;j++){
    if (!S[i][j] && A2.get(i,j) >= 4) B[i][j]=B[j][i]=true;
  }
}
const neigh2 = Array.from({length:n},(_,i)=>
  new Set(B[i].flatMap((v,idx)=>v?idx:[]))
);

// memoised (i,j) → list(k) where k>j & k∈neigh2[i]∩neigh2[j]
const pairCache = new Map();
function tripleList(i,j){
  const key = (i<<11)|j;               // n<2048
  const cached = pairCache.get(key);
  if (cached) return cached;
  const arr = [...neigh2[i]].filter(k => k>j && neigh2[j].has(k))
                             .sort((a,b)=>a-b);
  pairCache.set(key,arr);
  return arr;
}

// ───────── utility for early red-herring prune ─────────────────────────────
function hasExclusiveWord(rows){
  // For each row, check it owns at least one word not in other rows
  for (let r=0;r<rows.length;r++){
    const mask = bitMasks[rows[r]];
    let others = new Uint32Array(MASK_LEN);
    for (let o=0;o<rows.length;o++){
      if (o===r) continue;
      for (let k=0;k<MASK_LEN;k++) others[k] |= bitMasks[rows[o]][k];
    }
    let ok=false;
    for (let k=0;k<MASK_LEN;k++){
      if (mask[k] & ~others[k]) { ok=true; break; }
    }
    if(!ok) return false;
  }
  return true;
}

// ───────── search ──────────────────────────────────────────────────────────
(async function main(){

  const db = await setupDatabase();
  console.log(`Database initialised at ${DB_PATH}`);

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO puzzles
       (puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3,word_list_hash,rank)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );

  const wordListHash = sha256(JSON.stringify(categoriesJson));

  // resume rank
  const startRank = await new Promise(res=>{
    db.get(
      `SELECT rank FROM puzzles
         WHERE word_list_hash = ?
         ORDER BY rank DESC LIMIT 1`,
      [wordListHash], (e,row)=> res(row? row.rank : -1)
    );
  });
  if (startRank>=0) console.log(`Resuming from rank ${startRank}`);

  // begin first txn
  await new Promise((r,j)=>db.run("BEGIN TRANSACTION",e=>e?j(e):r()));

  const BATCH_SIZE = 500;
  let batchCnt = 0, saved   = 0, seen   = 0, rank = -1;
  const t0 = performance.now();

  function commit(cb){
    db.run("COMMIT", err=>{
      if(err) return cb(err);
      db.run("BEGIN TRANSACTION", cb);
    });
  }

  // ----------- main nested loops (fixed ordering, rank only) --------------
  outer:
  for (let i=0;i<n;i++){
    const tLoop = performance.now();

    const jList=[...neigh2[i]].filter(j=>j>i).sort((a,b)=>a-b);
    for (const j of jList){

      const kList = tripleList(i,j);
      for (const k of kList){

        const lList = kList.filter(l=>l>k && neigh2[k].has(l));
        for (const l of lList){

          const rows = [i,j,k,l];  // already ascending
          if (!hasExclusiveWord(rows)) continue;          // early red-herring

          // candidate columns: intersection of 1-away sets w/ rows
          let cand = new Set(neigh1[i]);
          for (let r=1;r<4;r++){
            const tmp = new Set();
            for (const x of cand) if (neigh1[rows[r]].has(x)) tmp.add(x);
            cand = tmp;
          }
          for (const r of rows) cand.delete(r);
          cand = new Set([...cand].filter(c=>!rows.some(r=>S[r][c])));
          if (cand.size<4) continue;

          const cArr = [...cand].sort((a,b)=>a-b);
          const m = cArr.length;

          for (let a=0;a<m-3;a++)
            for (let b=a+1;b<m-2;b++){
              const x=cArr[a], y=cArr[b];
              if (!B[x][y]) continue;
              for (let c=b+1;c<m-1;c++){
                const z=cArr[c];
                if (!(B[x][z] && B[y][z])) continue;
                for (let d=c+1;d<m;d++){
                  const w=cArr[d];
                  if (!(B[x][w] && B[y][w] && B[z][w])) continue;

                  const cols=[x,y,z,w];
                  if (cats[rows[0]] > cats[cols[0]])  continue; // orientation

                  // full red-herring test (rows vs cols)
                  let ok=true;
                  const all = new Set([...rows,...cols]);
                  outerRH:
                  for (const r of rows)
                    for (const cc of cols){
                      let own = bitMasks[r].map((v,idx)=>v & bitMasks[cc][idx]);
                      for (const o of all) if (o!==r && o!==cc)
                        for (let k=0;k<MASK_LEN;k++)
                          own[k] &= ~bitMasks[o][k];
                      let nonEmpty=false;
                      for (let k=0;k<MASK_LEN;k++) if (own[k]) {nonEmpty=true; break;}
                      if(!nonEmpty){ok=false;break outerRH;}
                    }
                  if(!ok) continue;

                  // ---------- puzzle accepted ----------
                  rank++;
                  if(rank<=startRank) continue;   // skip until resume point

                  seen++;

                  const rowsNames = rows.map(v=>cats[v]);
                  const colsNames = cols.map(v=>cats[v]);
                  const puzzleHash = sha256(rowsNames.join("|")+colsNames.join("|"));

                  insertStmt.run(
                    [puzzleHash,...rowsNames,...colsNames,wordListHash,rank],
                    function(err){
                      if(err){ console.error(err); return; }
                      if(this.changes===1) saved++;
                    }
                  );
                  batchCnt++;

                  if (batchCnt>=BATCH_SIZE){
                    await new Promise((res,rej)=>commit(e=>e?rej(e):res()));
                    batchCnt=0;
                  }
                }
              }
            }
        }
      }
    }

    // progress update once per i-loop
    drawBar((i+1)/n, seen, saved, (performance.now()-t0)/1000);
  }

  // final commit
  await new Promise((res,rej)=>commit(e=>e?rej(e):res()));
  drawBar(1, seen, saved, (performance.now()-t0)/1000); process.stdout.write("\n");

  insertStmt.finalize();
  db.close(()=>console.log(`Done.  ${seen} puzzles visited, ${saved} new.`));
})().catch(console.error);
