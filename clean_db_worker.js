"use strict";
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

const { id: WID, DB_PATH, DATA_DIR, CAT_SCORES_F } = workerData;

// Extended timeouts to reduce false-positive stalls under load
const RUST_RESPONSE_TIMEOUT_MS = 300000; // 5 minutes

const categoriesJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'categories.json'), 'utf8'));
const metaCatsJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta_categories.json'), 'utf8'));
let categoryScores = {}; try { categoryScores = JSON.parse(fs.readFileSync(CAT_SCORES_F, 'utf8')); } catch { }

const metaMap = {}; for (const [m, cats] of Object.entries(metaCatsJson)) if (m !== 'No Meta Category') for (const c of cats) metaMap[c] = m;

const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const cleanerRel = path.join(ROOT_DIR, 'rust_helper', 'target', 'release', 'cdx_cleaner');
const cleanerDbg = path.join(ROOT_DIR, 'rust_helper', 'target', 'debug', 'cdx_cleaner');
const cleanerPath = fs.existsSync(cleanerRel) ? cleanerRel : (fs.existsSync(cleanerDbg) ? cleanerDbg : null);
const writerRel = path.join(ROOT_DIR, 'rust_helper', 'target', 'release', 'cdx_writer');
const writerDbg = path.join(ROOT_DIR, 'rust_helper', 'target', 'debug', 'cdx_writer');
const writerPath = fs.existsSync(writerRel) ? writerRel : (fs.existsSync(writerDbg) ? writerDbg : null);

let cleaner = null, rl = null, queue = [], waitResolve = null;
let writer = null, wrl = null, wqueue = [], wwaitResolve = null;
async function ensureCleaner() {
  if (cleaner) return;
  if (!cleanerPath) {
    throw new Error('Rust cleaner binary not found. Please run: cargo build -p rust_helper --bin cdx_cleaner --release');
  }
  cleaner = spawn(cleanerPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  cleaner.on('error', (e) => {
    parentPort.postMessage({ type: 'error', id: WID, message: 'Rust cleaner spawn error: ' + (e && e.message ? e.message : String(e)) });
  });
  cleaner.on('exit', (code, signal) => {
    parentPort.postMessage({ type: 'error', id: WID, message: `Rust cleaner exited (code=${code}, signal=${signal})` });
  });
  rl = (await import('readline')).createInterface({ input: cleaner.stdout });
  rl.on('line', line => { queue.push(line); if (waitResolve) { const r = waitResolve; waitResolve = null; r(); } });
  cleaner.stdin.write(JSON.stringify({ type: 'Init', categories: categoriesJson, meta_map: metaMap }) + '\n');
}
async function readLine() { if (queue.length) return queue.shift(); await new Promise(res => waitResolve = res); return queue.shift(); }
async function readLineWithTimeout(ms = RUST_RESPONSE_TIMEOUT_MS) {
  if (queue.length) return queue.shift();
  return await Promise.race([
    new Promise(res => { waitResolve = res; }),
    (async () => { await delay(ms); throw new Error(`Timeout waiting for rust cleaner response after ${ms}ms`); })()
  ]).then(() => queue.shift());
}

async function ensureWriter() {
  if (writer) return;
  if (!writerPath) throw new Error('Rust writer binary not found. Please build cdx_writer');

  // Add a small delay to stagger writer initializations and reduce database contention
  await delay(WID * 100); // Stagger by worker ID

  console.log(`Worker ${WID}: Starting writer process...`);
  writer = spawn(writerPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  wrl = (await import('readline')).createInterface({ input: writer.stdout });
  wrl.on('line', line => { wqueue.push(line); if (wwaitResolve) { const r = wwaitResolve; wwaitResolve = null; r(); } });
  console.log(`Worker ${WID}: Sending init to writer...`);
  writer.stdin.write(JSON.stringify({ type: 'Init', db_path: DB_PATH }) + '\n');
  console.log(`Worker ${WID}: Waiting for writer ready...`);
  const line = await readWriterLineWithTimeout(10000); // 10 second timeout for init
  console.log(`Worker ${WID}: Got response: ${line}`);
  let msg; try { msg = JSON.parse(line); } catch { throw new Error('Invalid writer init: ' + line); }
  if (msg.type !== 'Ready') throw new Error('Writer failed to init: ' + line);
  console.log(`Worker ${WID}: Writer ready`);
}
async function readWriterLineWithTimeout(ms = RUST_RESPONSE_TIMEOUT_MS) {
  if (wqueue.length) return wqueue.shift();
  return await Promise.race([
    new Promise(res => { wwaitResolve = res; }),
    (async () => { await delay(ms); throw new Error(`Timeout waiting for rust writer response after ${ms}ms`); })()
  ]).then(() => wqueue.shift());
}

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

// Write permits removed — rely on WAL and rusqlite backoff

parentPort.on('message', async msg => {
  if (msg.type === 'request_work') {
    parentPort.postMessage({ type: 'request_work', id: WID });
  } else if (msg.type === 'work') {
    const { job } = msg;
    try {
      await ensureCleaner();
      const db = await setupDb();
      await ensureWriter();
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
            if (e && e.code === 'SQLITE_BUSY' && i < attempts - 1) { await delay(50 + Math.random() * 200); continue; }
            throw e;
          }
        }
      };
      const puzzles = await selectWithRetry();
      if (!Array.isArray(puzzles)) throw new Error('Select returned non-array');
      const total = puzzles.length;
      let processed = 0;
      let invalid = [];
      let scoreUpdates = [];
      const localTally = Object.create(null);
      // stats tracking
      let validCount = 0, invalidCount = 0;
      let validDelta = 0, invalidDelta = 0;

      // send an initial tick so orchestrator knows totals
      parentPort.postMessage({ type: 'tick', id: WID, idx: job.idx, processed, total, validDelta: 0, invalidDelta: 0 });

      const FLUSH_THRESHOLD = 100;
      for (const p of puzzles) {
        cleaner.stdin.write(JSON.stringify({ type: 'Validate', rows: [p.row0, p.row1, p.row2, p.row3], cols: [p.col0, p.col1, p.col2, p.col3] }) + '\n');
        const line = await readLineWithTimeout(RUST_RESPONSE_TIMEOUT_MS);
        let resp;
        try { resp = JSON.parse(line); } catch (e) { throw new Error('Invalid JSON from rust cleaner: ' + line); }
        if (resp.type === 'Valid') {
          const cats = [p.row0, p.row1, p.row2, p.row3, p.col0, p.col1, p.col2, p.col3];
          const score = cats.reduce((s, c) => s + (categoryScores[c] || 0), 0);
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
        if (invalid.length >= FLUSH_THRESHOLD || scoreUpdates.length >= FLUSH_THRESHOLD) {
          await performWriteBatchRust(invalid, scoreUpdates);
          invalid = [];
          scoreUpdates = [];
          // Small delay to reduce database contention
          await delay(10);
        }
        if (processed % 50 === 0 || processed === total) {
          parentPort.postMessage({ type: 'tick', id: WID, idx: job.idx, processed, total, validDelta, invalidDelta });
          validDelta = 0; invalidDelta = 0;
        }
        // No mid-chunk flush; defer to a single transaction at the end of the chunk
      }

      // Final flush
      if (invalid.length > 0 || scoreUpdates.length > 0) await performWriteBatchRust(invalid, scoreUpdates);
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
    try { if (cleaner && cleaner.stdin && !cleaner.killed) cleaner.stdin.end(); } catch { }
    try { if (rl) rl.close(); } catch { }
    try { if (cleaner && !cleaner.killed) cleaner.kill(); } catch { }
    try { if (writer && writer.stdin && !writer.killed) writer.stdin.end(); } catch { }
    try { if (wrl) wrl.close(); } catch { }
    try { if (writer && !writer.killed) writer.kill(); } catch { }
    process.exit(0);
  }
});

// Signal readiness after message handler is set to avoid race on first request
parentPort.postMessage({ type: 'ready', id: WID });

// performWriteBatch (Node sqlite) kept for fallback, but currently unused

async function performWriteBatchRust(invalid, scoreUpdates) {
  try {
    if (invalid.length > 0) {
      console.log(`Worker ${WID}: Sending delete batch of ${invalid.length} items...`);
      writer.stdin.write(JSON.stringify({ type: 'Delete', hashes: invalid }) + '\n');
      const line = await readWriterLineWithTimeout(30000); // 30 second timeout
      console.log(`Worker ${WID}: Got delete response: ${line}`);
      let resp; try { resp = JSON.parse(line); } catch { throw new Error('Invalid JSON from writer (Delete): ' + line); }
      if (resp.type !== 'Ack') throw new Error('Writer Delete failed: ' + line);
    }
    if (scoreUpdates.length > 0) {
      console.log(`Worker ${WID}: Sending score update batch of ${scoreUpdates.length} items...`);
      writer.stdin.write(JSON.stringify({ type: 'UpsertScores', items: scoreUpdates.map(u => [u.hash, u.score]) }) + '\n');
      const line = await readWriterLineWithTimeout(30000); // 30 second timeout
      console.log(`Worker ${WID}: Got score response: ${line}`);
      let resp; try { resp = JSON.parse(line); } catch { throw new Error('Invalid JSON from writer (UpsertScores): ' + line); }
      if (resp.type !== 'Ack') throw new Error('Writer UpsertScores failed: ' + line);
    }
  } catch (e) {
    // If writer operations fail, log the error but continue processing
    console.error(`Worker ${WID} write batch failed:`, e.message);
    // Don't throw - let the worker continue with the next batch
  }
}


