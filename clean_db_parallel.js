#!/usr/bin/env node
// clean_db_parallel.js - Parallel DB validator with resumable progress and Rust inner loop
"use strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import sqlite3 from "sqlite3";
import { Worker } from "worker_threads";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const META_CATS_F = path.join(DATA_DIR, "meta_categories.json");
const CAT_SCORES_F = path.join(DATA_DIR, "category_scores.json");
const DB_PATH = path.join(__dirname, "puzzles.db");
const PROGRESS_FILE = path.join(__dirname, "progress_clean.json");

const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const BAR_W = 30;
function bar(p) { const f = Math.round(p * BAR_W); return "█".repeat(f) + "░".repeat(BAR_W - f); }

function setupDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, err => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

async function countPuzzles(db) {
  return new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM puzzles", (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
  });
}

async function getHashRange(db) {
  return new Promise((resolve, reject) => {
    db.get("SELECT MIN(puzzle_hash) as min_hash, MAX(puzzle_hash) as max_hash FROM puzzles", (err, row) => err ? reject(err) : resolve(row ? { min: row.min_hash, max: row.max_hash } : null));
  });
}

(async () => {
  console.log("🔍 Puzzle Validator (parallel)");
  const wordListHash = sha256(fs.readFileSync(WORDS_F));
  console.log(`- Word list hash: ${wordListHash.slice(0, 12)}…`);
  console.log("- Starting initial setup…");
  try {
    const szWords = fs.statSync(WORDS_F).size;
    const szCats = fs.statSync(CATS_F).size;
    const szMeta = fs.statSync(META_CATS_F).size;
    console.log(`  • words.json: ${(szWords / 1024).toFixed(1)} KB, categories.json: ${(szCats / 1024).toFixed(1)} KB, meta_categories.json: ${(szMeta / 1024).toFixed(1)} KB`);
  } catch { }

  // Checkpoint WAL file at startup to clear any accumulated data from previous sessions
  console.log("- Performing initial WAL checkpoint to ensure clean database state...");
  try {
    const { execSync } = await import('child_process');
    execSync(`sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);"`, { timeout: 900000 }); // 15 minute timeout
    console.log("  ✓ Initial WAL checkpoint completed successfully");
  } catch (e) {
    console.log(`  ⚠️  Initial WAL checkpoint failed: ${e.message}`);
    console.log("     This may affect performance but cleanup will continue...");
  }

  function loadProgress() {
    if (!fs.existsSync(PROGRESS_FILE)) return { wordListHash: null, completed: [] };
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); } catch { return { wordListHash: null, completed: [] }; }
  }
  function saveProgress(obj) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(obj, null, 2)); }

  let totalValid = 0, totalInvalid = 0, totalDeleted = 0;
  const globalTally = Object.create(null);

  const saved = loadProgress();
  let completed = new Set();
  if (saved.wordListHash === wordListHash) {
    completed = new Set(saved.completed);
    console.log(`- Resuming: loaded ${completed.size} completed chunk(s) from progress file`);
    // Restore running totals/tally if present
    if (saved.totals && typeof saved.totals.valid === 'number') totalValid = saved.totals.valid;
    if (saved.totals && typeof saved.totals.invalid === 'number') totalInvalid = saved.totals.invalid;
    if (saved.totals && typeof saved.totals.deleted === 'number') totalDeleted = saved.totals.deleted;
    if (saved.tally && typeof saved.tally === 'object') Object.assign(globalTally, saved.tally);
  } else {
    if (fs.existsSync(PROGRESS_FILE)) {
      console.log("- Progress invalid (hash mismatch). Resetting progress file");
      fs.unlinkSync(PROGRESS_FILE);
    } else {
      console.log("- No prior progress file found (fresh run)");
    }
  }

  // Skip opening Node sqlite DB; workers handle WAL/synchronous/busy_timeout.
  console.log("- Skipping Node DB startup; workers will configure SQLite directly");
  console.log("- Skipping COUNT(*); using conservative chunking target.");
  // Assume full SHA-256 range to avoid slow MIN/MAX scan
  const MIN_HASH = '0'.repeat(64);
  const MAX_HASH = 'f'.repeat(64);
  const range = { min: MIN_HASH, max: MAX_HASH };
  console.log(`- Using assumed hash range: ${range.min.slice(0, 8)}… → ${range.max.slice(0, 8)}…`);

  const ASSUMED_TOTAL = 100_000_000n; // 100M
  const TARGET_PER_CHUNK = 50_000n;   // ~50k per chunk
  const BATCH_COUNT = Number(ASSUMED_TOTAL / TARGET_PER_CHUNK); // ~2000 chunks
  const step = (BigInt("0x" + range.max) - BigInt("0x" + range.min)) / BigInt(BATCH_COUNT);
  console.log(`- Planned ${BATCH_COUNT} chunks (~${Number(ASSUMED_TOTAL / BigInt(BATCH_COUNT))} puzzles/chunk assumed)`);

  const workQueue = [];
  for (let i = 0; i < BATCH_COUNT; i++) {
    if (completed.has(i)) continue;
    const minHash = (BigInt("0x" + range.min) + step * BigInt(i)).toString(16).padStart(64, '0');
    const maxHash = (i === BATCH_COUNT - 1) ? range.max : (BigInt("0x" + range.min) + step * BigInt(i + 1)).toString(16).padStart(64, '0');
    workQueue.push({ idx: i, minHash, maxHash });
  }
  console.log(`- Work queue ready: ${workQueue.length} chunk(s) to process`);

  const nWorkers = os.cpus().length;
  const status = Array.from({ length: nWorkers }, () => ({ current: null, valid: 0, invalid: 0, deleted: 0 }));
  let reservedPrinted = false;
  let progressStarted = false;
  const RESERVED_LINES = 4 + nWorkers; // overall + totals + checkpoint status + per-worker + spacer
  console.log(`- Spawning ${nWorkers} worker(s)`);
  let shuttingDown = false;
  let sigintCount = 0;
  function redraw() {
    const inProgress = status.filter(s => s.current && !s.current.done);
    const fractional = inProgress.reduce((sum, s) => sum + (s.current.total ? (s.current.processed / s.current.total) : 0), 0);
    const doneChunks = completed.size + status.filter(s => s.current && s.current.done).length;
    const pct = Math.min(1, (doneChunks + fractional) / BATCH_COUNT);

    if (!reservedPrinted) {
      process.stdout.write("\n".repeat(RESERVED_LINES));
      reservedPrinted = true;
      progressStarted = true;
    }

    // Move cursor up to the start of our reserved area
    process.stdout.write(`\x1b[${RESERVED_LINES}A`);

    // Clear and rewrite only our reserved lines
    const lines = [];
    lines.push(`Overall: [${bar(pct)}] ${(pct * 100).toFixed(1)}% (${doneChunks}/${BATCH_COUNT})`);
    lines.push(`Totals: valid=${totalValid}, invalid=${totalInvalid}, deleted=${totalDeleted}`);
    lines.push(`Checkpoint: ${checkpointStatus} (${checkpointRequests} pending)`);
    status.forEach((st, i) => {
      const s = st.current;
      const base = s ? `chunk ${s.idx}: ${s.processed}/${s.total}` : 'idle';
      lines.push(`W${i} ${base} | v=${st.valid}, inv=${st.invalid}, del=${st.deleted}`);
    });
    lines.push(""); // spacer

    // Write each line, clearing it first
    for (let i = 0; i < RESERVED_LINES; i++) {
      const text = lines[i] || "";
      process.stdout.write(`\x1b[2K\r${text}\n`);
    }
  }

  let active = nWorkers;
  const workers = [];
  let checkpointRequests = 0;
  let lastCheckpointTime = 0;
  let checkpointStatus = 'idle'; // idle, active, success, failed
  let workersWithWork = 0; // Track how many workers currently have work assigned
  let batchComplete = false; // Track when current batch is done

  // Function to assign work in batches to all available workers
  async function assignBatchWork() {
    batchComplete = false;
    workersWithWork = 0;

    // Assign work to all workers that are ready
    for (let id = 0; id < nWorkers; id++) {
      if (status[id].current === null) { // Worker is idle
        const job = workQueue.shift();
        if (job) {
          status[id].current = { idx: job.idx, processed: 0, total: 1 };
          workers[id].postMessage({ type: 'work', job });
          workersWithWork++;
        }
      }
    }

    // If no work was assigned, we're done
    if (workersWithWork === 0 && workQueue.length === 0) {
      console.log('\nAll work completed!');
      return false; // No more work to do
    }

    return true; // Work assigned, continue
  }

  // Function to perform batch checkpoint when all workers are idle
  async function performBatchCheckpoint() {
    if (workersWithWork > 0) return; // Don't checkpoint if workers are still working

    console.log('\nVerifying DB connections before checkpoint...');
    checkpointStatus = 'active';
    redraw();

    try {
      const { execSync } = await import('child_process');
      // Check for active connections by looking at the WAL file
      const result = execSync(`sqlite3 "${DB_PATH}" "PRAGMA database_list;"`, { timeout: 30000 });
      const dbList = result.toString();
      if (dbList.includes('main') && !dbList.includes('temp')) {
        console.log('✓ Database connections verified');
      } else {
        console.log('⚠ Active connections detected, proceeding anyway');
      }
    } catch (e) {
      console.log(`⚠ Connection check failed: ${e.message}, proceeding anyway`);
    }

    console.log('Performing batch checkpoint...');
    try {
      const { execSync } = await import('child_process');
      execSync(`sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);"`, { timeout: 900000 }); // 15 minute timeout
      checkpointStatus = 'success';
      console.log('Batch checkpoint completed successfully.');
    } catch (e) {
      checkpointStatus = 'failed';
      console.log(`Batch checkpoint failed: ${e.message}`);
    }

    redraw();
    setTimeout(() => {
      checkpointStatus = 'idle';
      redraw();
    }, 2000);
  }

  // Write permits removed
  for (let id = 0; id < nWorkers; id++) {
    const w = new Worker(new URL('./clean_db_worker.js', import.meta.url), { workerData: { id, DB_PATH, DATA_DIR, CAT_SCORES_F } });
    workers.push(w);
    w.on('message', async msg => {
      if (msg.type === 'ready') {
        // In batch mode, wait for all workers to be ready before assigning work
        w.postMessage({ type: 'wait_for_batch' });
      } else if (msg.type === 'request_write_permit' || msg.type === 'release_write_permit' || msg.type === 'cancel_write_permit_request') {
        // no-op; permits removed
      } else if (msg.type === 'tick') {
        if (typeof msg.validDelta === 'number') { status[msg.id].valid += msg.validDelta; totalValid += msg.validDelta; }
        if (typeof msg.invalidDelta === 'number') { status[msg.id].invalid += msg.invalidDelta; totalInvalid += msg.invalidDelta; }
        if (typeof msg.deletedDelta === 'number') { status[msg.id].deleted += msg.deletedDelta; totalDeleted += msg.deletedDelta; }
        status[msg.id].current = { idx: msg.idx, processed: msg.processed, total: msg.total };
        redraw();
      } else if (msg.type === 'fatal_mismatch') {
        // This should no longer be sent since we removed the fatal mismatch check
        process.stderr.write(`\nUnexpected fatal_mismatch from W${msg.id} chunk ${msg.idx}: ${msg.invalid} invalid, ${msg.deleted} deleted.\n`);
      } else if (msg.type === 'fatal_write') {
        shuttingDown = true;
        process.stderr.write(`\nFatal write failure on W${msg.id} chunk ${msg.idx}: ${msg.error}. Aborting.\n`);
        for (const wk of workers) { try { wk.postMessage({ type: 'shutdown' }); } catch { } }
        try { saveProgress({ wordListHash, completed: Array.from(completed), totals: { valid: totalValid, invalid: totalInvalid, deleted: totalDeleted }, tally: globalTally }); } catch { }
        setTimeout(() => process.exit(3), 50);
      } else if (msg.type === 'request_work') {
        if (shuttingDown) {
          w.postMessage({ type: 'cleanup' });
        } else {
          // Worker finished a chunk, decrement counter
          if (status[msg.id].current) {
            workersWithWork--;
            status[msg.id].current = null;
          }

          // Check if batch is complete (all workers idle)
          if (workersWithWork === 0 && workQueue.length > 0) {
            // All workers are done, perform checkpoint and start new batch
            performBatchCheckpoint().then(() => {
              assignBatchWork();
            });
          } else if (workersWithWork === 0 && workQueue.length === 0) {
            // All work is done
            w.postMessage({ type: 'cleanup' });
          } else {
            // Still work in progress, wait
            w.postMessage({ type: 'wait_for_batch' });
          }
        }
      } else if (msg.type === 'request_checkpoint') {
        // In batch mode, checkpoints are handled automatically when batches complete
        checkpointRequests++;
      } else if (msg.type === 'error') {
        // Log errors but don't interfere with progress display
        process.stderr.write(`\nW${msg.id} error: ${msg.message}\n`);
      } else if (msg.type === 'tally') {
        // merge local tally
        const t = msg.tally || {};
        for (const k of Object.keys(t)) globalTally[k] = (globalTally[k] || 0) + t[k];
      } else if (msg.type === 'done_chunk') {
        completed.add(msg.idx);
        saveProgress({ wordListHash, completed: Array.from(completed), totals: { valid: totalValid, invalid: totalInvalid, deleted: totalDeleted }, tally: globalTally });
        status[msg.id].current = { idx: msg.idx, processed: 1, total: 1, done: true };
        if (typeof msg.valid === 'number') { status[msg.id].valid += msg.valid; totalValid += msg.valid; }
        if (typeof msg.invalid === 'number') { status[msg.id].invalid += msg.invalid; totalInvalid += msg.invalid; }
        if (typeof msg.deleted === 'number') { status[msg.id].deleted += msg.deleted; totalDeleted += msg.deleted; }
        redraw();
        w.postMessage({ type: 'request_work' });
      } else if (msg.type === 'cleanup_done') {
        active--;
        if (active === 0) {
          console.log('\nAll workers finished.');
          console.log(`Totals: valid=${totalValid}, invalid=${totalInvalid}, deleted=${totalDeleted}`);
          // write tally
          try {
            const tallyOutputPath = path.join(DATA_DIR, 'category_tally.json');
            // sort
            const sorted = Object.entries(globalTally).sort(([, a], [, b]) => b - a).reduce((o, [k, v]) => { o[k] = v; return o; }, {});
            const totalValid = Object.values(globalTally).reduce((s, c) => s + c, 0) / 8; // 8 categories per puzzle
            const tallyData = { summary: { totalValidPuzzles: totalValid }, categoryUsage: sorted };
            fs.writeFileSync(tallyOutputPath, JSON.stringify(tallyData, null, 2));
            console.log(`Saved category tally to ${tallyOutputPath}`);
          } catch (e) { console.log('Warning: failed to save category tally:', e.message); }

          // Checkpoint the database to prevent WAL file growth
          console.log('Checkpointing database to clean up WAL file...');
          try {
            const { execSync } = await import('child_process');
            execSync(`sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);"`, { timeout: 900000 }); // 15 minute timeout
            console.log('Database checkpoint completed successfully.');
          } catch (e) {
            console.log(`Warning: database checkpoint failed: ${e.message}`);
            console.log('You may need to run "sqlite3 puzzles.db PRAGMA wal_checkpoint(TRUNCATE);" manually.');
          }

          // Ask workers to shutdown their native resources gracefully before exit
          for (const wk of workers) { try { wk.postMessage({ type: 'shutdown' }); } catch { } }
          setTimeout(() => process.exit(0), 50);
        }
      }
    });
  }

  // No periodic checkpoints in batch mode - checkpoints happen between batches

  // Initial batch assignment after all workers are ready
  setTimeout(async () => {
    console.log('\nStarting batch processing...');
    await assignBatchWork();
  }, 1000); // Give workers time to initialize

  // No custom SIGINT handler; allow Node's default behavior
})();


