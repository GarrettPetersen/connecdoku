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

function setupDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, err => {
      if (err) return reject(err);
      // Only set connection-local busy timeout here. Global WAL/synchronous is set by the main thread.
      db.exec('PRAGMA busy_timeout=30000;', err2 => {
        if (err2) return reject(err2);
        resolve(db);
      });
    });
  });
}

function requestWritePermit() { parentPort.postMessage({ type: 'request_write_permit', id: WID }); }
function releaseWritePermit() { parentPort.postMessage({ type: 'release_write_permit', id: WID }); }

parentPort.postMessage({ type: 'ready', id: WID });

parentPort.on('message', async msg => {
  if (msg.type === 'request_work') {
    parentPort.postMessage({ type: 'request_work', id: WID });
  } else if (msg.type === 'work') {
    const { job } = msg;
    try {
      await ensureCleaner();
      const db = await setupDb();
      // SELECT with retry on SQLITE_BUSY
      const selectWithRetry = async (attempts = 5) => {
        for (let i = 0; i < attempts; i++) {
          try {
            return await new Promise((resolve, reject) => {
              db.all(
                `SELECT puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3 FROM puzzles WHERE puzzle_hash > ? AND puzzle_hash <= ?`,
                [job.minHash, job.maxHash],
                (err, rows) => err ? reject(err) : resolve(rows || [])
              );
            });
          } catch (e) {
            if (e && e.code === 'SQLITE_BUSY' && i < attempts - 1) { await delay(50 + Math.random()*200); continue; }
            throw e;
          }
        }
      };
      const puzzles = await selectWithRetry();
      const total = puzzles.length;
      let processed = 0;
      let invalid = [];
      let scoreUpdates = [];
      const localTally = Object.create(null);
      // stats tracking
      let validCount = 0, invalidCount = 0;
      let validDelta = 0, invalidDelta = 0;

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
          validCount++; validDelta++;
        } else if (resp.type === 'Invalid') {
          invalid.push(p.puzzle_hash);
          invalidCount++; invalidDelta++;
        }
        processed++;
        if (processed % 200 === 0 || processed === total) {
          parentPort.postMessage({ type: 'tick', id: WID, idx: job.idx, processed, total, validDelta, invalidDelta });
          validDelta = 0; invalidDelta = 0;
        }
        // No mid-chunk flush; defer to a single transaction at the end of the chunk
      }

      // Final flush
      if (invalid.length > 0 || scoreUpdates.length > 0) await performWriteBatch(db, invalid, scoreUpdates);
      await new Promise(resolve => db.close(() => resolve()));
      // Send tally for this chunk before signaling done
      // flush any remaining deltas
      if (validDelta || invalidDelta) parentPort.postMessage({ type: 'stats', id: WID, validDelta, invalidDelta });
      parentPort.postMessage({ type: 'tally', id: WID, idx: job.idx, tally: localTally });
      parentPort.postMessage({ type: 'done_chunk', id: WID, idx: job.idx, valid: validCount, invalid: invalidCount });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id: WID, idx: msg?.job?.idx, message: e && e.message ? e.message : String(e) });
      // Small delay before asking for new work to avoid hot error loop
      await delay(200);
      parentPort.postMessage({ type: 'request_work', id: WID });
    }
  } else if (msg.type === 'cleanup') {
    parentPort.postMessage({ type: 'cleanup_done', id: WID });
  } else if (msg.type === 'shutdown') {
    // Attempt to gracefully stop the Rust cleaner
    try { if (cleaner && cleaner.stdin && !cleaner.killed) cleaner.stdin.end(); } catch {}
    try { if (rl) rl.close(); } catch {}
    try { if (cleaner && !cleaner.killed) cleaner.kill(); } catch {}
    process.exit(0);
  }
});

async function performWriteBatch(db, invalid, scoreUpdates) {
  // acquire permit from main to keep concurrency low
  requestWritePermit();
  await new Promise(resolve => {
    // Wait for permit grant message
    const handler = (msg) => {
      if (msg && msg.type === 'write_permit') {
        parentPort.off('message', handler);
        resolve();
      }
    };
    parentPort.on('message', handler);
  });

  // Write with retry/backoff on SQLITE_BUSY
  const runWithRetry = (fn, attempts = 5) => new Promise(async (resolve, reject) => {
    for (let i = 0; i < attempts; i++) {
      try { await fn(); return resolve(); } catch (e) {
        if (e && e.code === 'SQLITE_BUSY' && i < attempts - 1) {
          await delay(50 + Math.random() * 200);
          continue;
        }
        return reject(e);
      }
    }
  });

  await runWithRetry(() => new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', err => err ? reject(err) : resolve())));

  // Ensure TEMP tables exist for this connection
  await runWithRetry(() => new Promise((resolve, reject) => db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS temp_to_delete(hash TEXT PRIMARY KEY);
     CREATE TEMP TABLE IF NOT EXISTS temp_scores(hash TEXT PRIMARY KEY, score INTEGER);`,
    err => err ? reject(err) : resolve()
  )));

  // Populate and apply deletes
  if (invalid.length > 0) {
    await runWithRetry(() => new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT OR IGNORE INTO temp_to_delete(hash) VALUES (?)');
      for (const h of invalid) stmt.run(h);
      stmt.finalize(err => err ? reject(err) : resolve());
    }));
    await runWithRetry(() => new Promise((resolve, reject) => db.run(
      'DELETE FROM puzzles WHERE puzzle_hash IN (SELECT hash FROM temp_to_delete)',
      err => err ? reject(err) : resolve()
    )));
    // Clear temp table for next use
    await runWithRetry(() => new Promise((resolve, reject) => db.run('DELETE FROM temp_to_delete', err => err ? reject(err) : resolve())));
  }

  // Populate and apply score updates
  if (scoreUpdates.length > 0) {
    await runWithRetry(() => new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT OR REPLACE INTO temp_scores(hash, score) VALUES (?, ?)');
      for (const u of scoreUpdates) stmt.run(u.hash, u.score);
      stmt.finalize(err => err ? reject(err) : resolve());
    }));
    await runWithRetry(() => new Promise((resolve, reject) => db.run(
      `UPDATE puzzles
         SET puzzle_quality_score = (
           SELECT score FROM temp_scores WHERE temp_scores.hash = puzzles.puzzle_hash
         )
       WHERE puzzle_hash IN (SELECT hash FROM temp_scores)`,
      err => err ? reject(err) : resolve()
    )));
    // Clear temp table for next use
    await runWithRetry(() => new Promise((resolve, reject) => db.run('DELETE FROM temp_scores', err => err ? reject(err) : resolve())));
  }

  await runWithRetry(() => new Promise((resolve, reject) => db.run('COMMIT', err => err ? reject(err) : resolve())));
  releaseWritePermit();
}


