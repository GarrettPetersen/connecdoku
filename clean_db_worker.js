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
        // Flush only when enough invalids have accumulated to justify a write
        if (invalid.length >= 500) {
          await performWriteBatch(db, invalid, scoreUpdates);
          invalid = [];
          scoreUpdates = [];
        }
      }

      // Final flush
      if (invalid.length > 0 || scoreUpdates.length > 0) await performWriteBatch(db, invalid, scoreUpdates);
      db.close();
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

  if (invalid.length > 0) {
    const MAX = 900; for (let i = 0; i < invalid.length; i += MAX) {
      const batch = invalid.slice(i, i + MAX);
      await runWithRetry(() => new Promise((resolve, reject) => {
        const placeholders = batch.map(() => '?').join(',');
        const stmt = db.prepare(`DELETE FROM puzzles WHERE puzzle_hash IN (${placeholders})`);
        stmt.run(batch, function(err){ if (err) reject(err); else resolve(); });
        stmt.finalize();
      }));
    }
  }
  if (scoreUpdates.length > 0) {
    const MAX = 900; const B = Math.max(1, Math.floor(MAX/3));
    for (let i = 0; i < scoreUpdates.length; i += B) {
      const batch = scoreUpdates.slice(i, i + B);
      const cases = batch.map(() => 'WHEN ? THEN ?').join(' ');
      const inPh = batch.map(() => '?').join(',');
      const sql = `UPDATE puzzles SET puzzle_quality_score = CASE puzzle_hash ${cases} END WHERE puzzle_hash IN (${inPh})`;
      const params = []; for (const u of batch) { params.push(u.hash, u.score); } for (const u of batch) { params.push(u.hash); }
      await runWithRetry(() => new Promise((resolve, reject) => db.run(sql, params, function(err){ if (err) reject(err); else resolve(); })));
    }
  }
  await runWithRetry(() => new Promise((resolve, reject) => db.run('COMMIT', err => err ? reject(err) : resolve())));
  releaseWritePermit();
}


