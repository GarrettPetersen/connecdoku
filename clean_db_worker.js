"use strict";
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

const { id: WID, DB_PATH, DATA_DIR, CAT_SCORES_F } = workerData;

const categoriesJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'categories.json'), 'utf8'));
const metaCatsJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta_categories.json'), 'utf8'));
let categoryScores = {}; try { categoryScores = JSON.parse(fs.readFileSync(CAT_SCORES_F, 'utf8')); } catch {}

const metaMap = {}; for (const [m, cats] of Object.entries(metaCatsJson)) if (m !== 'No Meta Category') for (const c of cats) metaMap[c] = m;

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const cleanerRel = path.join(ROOT_DIR, 'rust_helper', 'target', 'release', 'cdx_cleaner');
const cleanerDbg = path.join(ROOT_DIR, 'rust_helper', 'target', 'debug', 'cdx_cleaner');
const WRITE_LOCK_DIR = path.join(ROOT_DIR, '.db_write_lock');
const cleanerPath = fs.existsSync(cleanerRel) ? cleanerRel : (fs.existsSync(cleanerDbg) ? cleanerDbg : null);

let cleaner = null, rl = null, queue = [], waitResolve = null;
async function ensureCleaner() {
  if (cleaner || !cleanerPath) return;
  cleaner = spawn(cleanerPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  rl = (await import('readline')).createInterface({ input: cleaner.stdout });
  rl.on('line', line => { queue.push(line); if (waitResolve) { const r = waitResolve; waitResolve = null; r(); } });
  cleaner.stdin.write(JSON.stringify({ type: 'Init', categories: categoriesJson, meta_map: metaMap }) + '\n');
}
async function readLine() { if (queue.length) return queue.shift(); await new Promise(res => waitResolve = res); return queue.shift(); }

function setupDb() { const db = new sqlite3.Database(DB_PATH); db.serialize(() => { db.run('PRAGMA journal_mode=WAL'); db.run('PRAGMA synchronous=OFF'); }); return db; }

async function acquireWriteLock() {
  while (true) {
    try { fs.mkdirSync(WRITE_LOCK_DIR); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await delay(50);
  }
}
function releaseWriteLock() { try { fs.rmdirSync(WRITE_LOCK_DIR); } catch {} }

parentPort.postMessage({ type: 'ready', id: WID });

parentPort.on('message', async msg => {
  if (msg.type === 'request_work') {
    parentPort.postMessage({ type: 'request_work', id: WID });
  } else if (msg.type === 'work') {
    const { job } = msg; await ensureCleaner();
    const db = setupDb();
    const puzzles = await new Promise((resolve, reject) => {
      db.all(`SELECT puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3 FROM puzzles WHERE puzzle_hash > ? AND puzzle_hash <= ? ORDER BY puzzle_hash`, [job.minHash, job.maxHash], (err, rows) => err ? reject(err) : resolve(rows || []));
    });
    const total = puzzles.length;
    let processed = 0;
    const invalid = [];
    const scoreUpdates = [];
    const localTally = Object.create(null);

    for (const p of puzzles) {
      cleaner.stdin.write(JSON.stringify({ type: 'Validate', rows: [p.row0,p.row1,p.row2,p.row3], cols: [p.col0,p.col1,p.col2,p.col3] }) + '\n');
      const resp = JSON.parse(await readLine());
      if (resp.type === 'Valid') {
        const cats = [p.row0,p.row1,p.row2,p.row3,p.col0,p.col1,p.col2,p.col3];
        const score = cats.reduce((s,c) => s + (categoryScores[c] || 0), 0);
        scoreUpdates.push({ hash: p.puzzle_hash, score });
        // tally categories
        for (const c of cats) {
          localTally[c] = (localTally[c] || 0) + 1;
        }
      } else if (resp.type === 'Invalid') {
        invalid.push(p.puzzle_hash);
      }
      processed++;
      if (processed % 200 === 0 || processed === total) parentPort.postMessage({ type: 'tick', id: WID, idx: job.idx, processed, total });
    }

    // Serialize write phase to avoid SQLITE_BUSY across workers
    if (invalid.length > 0 || scoreUpdates.length > 0) {
      await acquireWriteLock();
      // increase busy timeout during write window
      db.serialize(() => { db.run('PRAGMA busy_timeout=30000'); });
    }
    if (invalid.length > 0) {
      // delete in chunks under 900 params
      const MAX = 900; for (let i = 0; i < invalid.length; i += MAX) {
        const batch = invalid.slice(i, i + MAX);
        await new Promise((resolve, reject) => {
          const placeholders = batch.map(() => '?').join(',');
          const stmt = db.prepare(`DELETE FROM puzzles WHERE puzzle_hash IN (${placeholders})`);
          stmt.run(batch, function(err){ if (err) reject(err); else resolve(); });
          stmt.finalize();
        });
      }
    }
    if (scoreUpdates.length > 0) {
      // update in batches
      const MAX = 900; const B = Math.max(1, Math.floor(MAX/3));
      for (let i = 0; i < scoreUpdates.length; i += B) {
        const batch = scoreUpdates.slice(i, i + B);
        const cases = batch.map(() => 'WHEN ? THEN ?').join(' ');
        const inPh = batch.map(() => '?').join(',');
        const sql = `UPDATE puzzles SET puzzle_quality_score = CASE puzzle_hash ${cases} END WHERE puzzle_hash IN (${inPh})`;
        const params = []; for (const u of batch) { params.push(u.hash, u.score); } for (const u of batch) { params.push(u.hash); }
        await new Promise((resolve, reject) => { db.run(sql, params, function(err){ if (err) reject(err); else resolve(); }); });
      }
    }
    if (invalid.length > 0 || scoreUpdates.length > 0) {
      releaseWriteLock();
    }
    db.close();
    // Send tally for this chunk before signaling done
    parentPort.postMessage({ type: 'tally', id: WID, idx: job.idx, tally: localTally });
    parentPort.postMessage({ type: 'done_chunk', id: WID, idx: job.idx });
  } else if (msg.type === 'cleanup') {
    parentPort.postMessage({ type: 'cleanup_done', id: WID });
  }
});


