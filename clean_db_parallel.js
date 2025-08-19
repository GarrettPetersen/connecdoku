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

  function loadProgress() {
    if (!fs.existsSync(PROGRESS_FILE)) return { wordListHash: null, completed: [] };
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); } catch { return { wordListHash: null, completed: [] }; }
  }
  function saveProgress(obj) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify(obj, null, 2)); }

  let totalValid = 0, totalInvalid = 0;
  const globalTally = Object.create(null);

  const saved = loadProgress();
  let completed = new Set();
  if (saved.wordListHash === wordListHash) {
    completed = new Set(saved.completed);
    console.log(`- Resuming: loaded ${completed.size} completed chunk(s) from progress file`);
    // Restore running totals/tally if present
    if (saved.totals && typeof saved.totals.valid === 'number') totalValid = saved.totals.valid;
    if (saved.totals && typeof saved.totals.invalid === 'number') totalInvalid = saved.totals.invalid;
    if (saved.tally && typeof saved.tally === 'object') Object.assign(globalTally, saved.tally);
  } else {
    if (fs.existsSync(PROGRESS_FILE)) {
      console.log("- Progress invalid (hash mismatch). Resetting progress file");
      fs.unlinkSync(PROGRESS_FILE);
    } else {
      console.log("- No prior progress file found (fresh run)");
    }
  }

  console.log("- Opening database…");
  const tOpen = Date.now();
  const db = await setupDatabase();
  console.log(`  • Database handle acquired in ${((Date.now() - tOpen) / 1000).toFixed(2)}s`);
  db.serialize(() => {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=OFF");
    db.run("PRAGMA busy_timeout=30000");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)", (err) => { if (err) console.warn("wal_checkpoint(TRUNCATE) failed:", err.message); });
  });
  console.log(`- Database opened: ${DB_PATH}`);

  // Startup cleanup: clear any leftover temporary tables (fast)
  console.log("- Performing startup cleanup...");
  try {
    await new Promise((resolve, reject) => {
      db.exec(`
        DROP TABLE IF EXISTS temp_to_delete;
        DROP TABLE IF EXISTS temp_scores;
        DROP TABLE IF EXISTS temp_validation;
      `, (err) => {
        if (err) {
          console.warn("  • Startup cleanup warnings:", err.message);
        } else {
          console.log("  • Startup cleanup completed (temp tables cleared)");
        }
        resolve();
      });
    });
  } catch (e) {
    console.warn("  • Startup cleanup failed:", e.message);
  }
  console.log("- Skipping COUNT(*); using conservative chunking target.");
  // Assume full SHA-256 range to avoid slow MIN/MAX scan
  const MIN_HASH = '0'.repeat(64);
  const MAX_HASH = 'f'.repeat(64);
  const range = { min: MIN_HASH, max: MAX_HASH };
  db.close();
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
  const status = Array.from({ length: nWorkers }, () => ({ current: null, valid: 0, invalid: 0 }));
  let reservedPrinted = false;
  let progressStarted = false;
  const RESERVED_LINES = 3 + nWorkers; // overall + totals + per-worker + spacer
  console.log(`- Spawning ${nWorkers} worker(s)`);
  let shuttingDown = false;
  let sigintCount = 0;
  function redraw() {
    const inProgress = status.filter(s => s.current && !s.current.done);
    const fractional = inProgress.reduce((sum, s) => sum + (s.current.total ? (s.current.processed / s.current.total) : 0), 0);
    const doneChunks = completed.size + status.filter(s => s.current && s.current.done).length;
    const pct = Math.min(1, (doneChunks + fractional) / BATCH_COUNT);
    const lines = [];
    lines.push(`Overall: [${bar(pct)}] ${(pct * 100).toFixed(1)}% (${doneChunks}/${BATCH_COUNT})`);
    lines.push(`Totals: valid=${totalValid}, deleted=${totalInvalid}`);
    status.forEach((st, i) => {
      const s = st.current;
      const base = s ? `chunk ${s.idx}: ${s.processed}/${s.total}` : 'idle';
      lines.push(`W${i} ${base} | v=${st.valid}, d=${st.invalid}`);
    });
    lines.push(""); // spacer

    if (!reservedPrinted) {
      process.stdout.write("\n".repeat(RESERVED_LINES));
      reservedPrinted = true;
      progressStarted = true;
    }
    // Move cursor up and overwrite only our reserved block
    process.stdout.write(`\x1b[${RESERVED_LINES}A`);
    for (let i = 0; i < RESERVED_LINES; i++) {
      const text = lines[i] || "";
      process.stdout.write(`\x1b[2K\r${text}\n`); // clear line, write, newline
    }
  }

  let active = nWorkers;
  const workers = [];
  // Write permits removed
  for (let id = 0; id < nWorkers; id++) {
    const w = new Worker(new URL('./clean_db_worker.js', import.meta.url), { workerData: { id, DB_PATH, DATA_DIR, CAT_SCORES_F } });
    workers.push(w);
    w.on('message', msg => {
      if (msg.type === 'ready') {
        if (!progressStarted) console.log(`  • Worker ${msg.id} ready`);
        // Assign immediately if queue has work; otherwise ask worker to request
        const job = workQueue.shift();
        if (job) {
          status[msg.id].current = { idx: job.idx, processed: 0, total: 1 };
          w.postMessage({ type: 'work', job });
        } else {
          w.postMessage({ type: 'request_work' });
        }
      } else if (msg.type === 'request_write_permit' || msg.type === 'release_write_permit' || msg.type === 'cancel_write_permit_request') {
        // no-op; permits removed
      } else if (msg.type === 'tick') {
        if (typeof msg.validDelta === 'number') { status[msg.id].valid += msg.validDelta; totalValid += msg.validDelta; }
        if (typeof msg.invalidDelta === 'number') { status[msg.id].invalid += msg.invalidDelta; totalInvalid += msg.invalidDelta; }
        status[msg.id].current = { idx: msg.idx, processed: msg.processed, total: msg.total };
        redraw();
      } else if (msg.type === 'request_work') {
        if (shuttingDown) {
          w.postMessage({ type: 'cleanup' });
        } else {
          const job = workQueue.shift();
          if (job) {
            status[msg.id].current = { idx: job.idx, processed: 0, total: 1 };
            w.postMessage({ type: 'work', job });
          } else {
            w.postMessage({ type: 'cleanup' });
          }
        }
      } else if (msg.type === 'error') {
        console.log(`Worker ${msg.id} error:`, msg.message);
      } else if (msg.type === 'tally') {
        // merge local tally
        const t = msg.tally || {};
        for (const k of Object.keys(t)) globalTally[k] = (globalTally[k] || 0) + t[k];
      } else if (msg.type === 'done_chunk') {
        completed.add(msg.idx);
        saveProgress({ wordListHash, completed: Array.from(completed), totals: { valid: totalValid, invalid: totalInvalid }, tally: globalTally });
        if (!progressStarted) console.log(`  • Worker ${msg.id} finished chunk ${msg.idx} (${completed.size}/${BATCH_COUNT})`);
        status[msg.id].current = { idx: msg.idx, processed: 1, total: 1, done: true };
        if (typeof msg.valid === 'number') { status[msg.id].valid += msg.valid; totalValid += msg.valid; }
        if (typeof msg.invalid === 'number') { status[msg.id].invalid += msg.invalid; totalInvalid += msg.invalid; }
        redraw();
        w.postMessage({ type: 'request_work' });
      } else if (msg.type === 'cleanup_done') {
        active--;
        if (active === 0) {
          console.log('\nAll workers finished.');
          console.log(`Totals: valid=${totalValid}, deleted=${totalInvalid}`);
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
          // Ask workers to shutdown their native resources gracefully before exit
          for (const wk of workers) { try { wk.postMessage({ type: 'shutdown' }); } catch { } }
          setTimeout(() => process.exit(0), 50);
        }
      }
    });
  }

  // No custom SIGINT handler; allow Node's default behavior
})();


