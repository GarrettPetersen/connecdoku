#!/usr/bin/env node
// connecdoku_matrix_solver_sqlite.js – parallel bit-vector edition with dynamic work stealing
//
// main thread:
//   • sets up DB (WAL, sync=OFF) and spawns one worker per CPU
//   • manages work queue and distributes chunks dynamically
//   • receives puzzles, inserts in 1 000-row batches
//   • draws a progress-bar line per worker
//
// worker thread:
//   • requests work chunks from main thread
//   • processes assigned work and posts results
//   • requests more work when done
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
import { spawn, spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const META_CATS_F = path.join(DATA_DIR, "meta_categories.json");
const DB_PATH = path.join(__dirname, "puzzles.db");
const PROGRESS_FILE = path.join(__dirname, "progress.json");

// ───────── helpers ──────────────────────────────────────────────
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const BAR_W = 30;
function bar(p) { const f = Math.round(p * BAR_W); return "█".repeat(f) + "░".repeat(BAR_W - f); }
function fmt(s) { if (!isFinite(s)) return "??"; const h = s / 3600 | 0, m = s / 60 % 60 | 0; return h ? `${h}h${m.toString().padStart(2, "0")}m` : m ? `${m}m` : `${s | 0}s`; }

// Progress file management
function saveProgress(wordListHash, completedChunks, completedChunkWork, partialChunkProgress) {
  const progress = {
    wordListHash,
    completedChunks,
    completedChunkWork, // Store actual j-step counts for completed chunks
    partialChunkProgress: Array.from(partialChunkProgress.entries()).map(([i, chunks]) => [i, Array.from(chunks)]),
    timestamp: new Date().toISOString()
  };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return { wordListHash: null, completedChunks: [], completedChunkWork: 0, partialChunkProgress: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    return {
      wordListHash: data.wordListHash,
      completedChunks: data.completedChunks || [],
      completedChunkWork: data.completedChunkWork || 0,
      partialChunkProgress: data.partialChunkProgress || []
    };
  } catch (e) {
    console.log("Invalid progress file, starting fresh");
    return { wordListHash: null, completedChunks: [], completedChunkWork: 0, partialChunkProgress: [] };
  }
}

/*─────────────────────────── MAIN THREAD ──────────────────────────*/
if (isMainThread) {
  const nWorkers = os.cpus().length;
  console.log(`Launching ${nWorkers} workers…`);

  // Pre-run data updater
  try {
    console.log("Running data update (pre)…");
    const upd = spawnSync('node', ['update_all_data.js'], { cwd: __dirname, stdio: 'inherit', encoding: 'utf8' });
    if (upd.status !== 0) console.warn('update_all_data.js (pre) exited non-zero');
  } catch (e) {
    console.warn('update_all_data.js (pre) failed:', e.message);
  }

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
  const wordListHash = sha256(fs.readFileSync(WORDS_F));

  // Check for existing progress and initialize completed work
  const savedProgress = loadProgress();

  // Check hash first before initializing progress variables
  console.log(`Current word list hash: ${wordListHash}`);
  console.log(`Saved word list hash: ${savedProgress.wordListHash}`);

  let completedChunks = new Set();
  let completedChunkWork = 0;
  let totalWorkEstimate = 0; // Track total work estimate from all chunks
  let totalCompletedWork = 0; // Track total completed j-steps across all workers
  let partialChunkProgress = new Map(); // Track progress on split chunks: i -> Set of completed chunk indices

  // Only restore progress if hash matches
  if (savedProgress.wordListHash === wordListHash) {
    completedChunks = new Set(savedProgress.completedChunks);
    completedChunkWork = savedProgress.completedChunkWork || 0;

    // Restore partial chunk progress
    if (savedProgress.partialChunkProgress) {
      for (const [i, chunks] of savedProgress.partialChunkProgress) {
        partialChunkProgress.set(i, new Set(chunks));
      }
    }
  } else if (savedProgress.wordListHash !== null) {
    console.log("Word list hash changed, starting fresh.");
    console.log(`Hash mismatch: saved="${savedProgress.wordListHash}" vs current="${wordListHash}"`);
    // Clear the progress file since hash doesn't match
    if (fs.existsSync(PROGRESS_FILE)) {
      console.log(`Deleting progress file: ${PROGRESS_FILE}`);
      fs.unlinkSync(PROGRESS_FILE);
    }
  } else {
    console.log("No previous progress found, starting fresh.");
  }

  // Calculate total work by building the complete 2-away matrix
  console.log("Calculating total work...");
  const categoriesJson = JSON.parse(fs.readFileSync(CATS_F, "utf8"));
  const cats = Object.keys(categoriesJson).filter(k => categoriesJson[k].length >= 4).sort();
  const n = cats.length;
  const wordsJson = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));
  const ALL_WORDS = Object.keys(wordsJson);
  const WORD_IDX = new Map(ALL_WORDS.map((w, i) => [w, i]));
  const MASK_LEN = Math.ceil(ALL_WORDS.length / 32);

  // Build masks once using the already loaded word index
  const mask = cats.map(c => {
    const words = categoriesJson[c];
    const m = new Uint32Array(MASK_LEN);
    for (const w of words) {
      const idx = WORD_IDX.get(w);
      if (idx !== undefined) m[idx >>> 5] |= 1 << (idx & 31);
    }
    return m;
  });

  // Build complete connectivity matrix
  const A = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Check if categories i and j have overlapping words
      let hasOverlap = false;
      for (let k = 0; k < mask[i].length; k++) {
        if (mask[i][k] & mask[j][k]) {
          hasOverlap = true;
          break;
        }
      }
      if (hasOverlap) {
        A[i][j] = A[j][i] = 1;
      }
    }
  }

  // Calculate complete 2-away matrix
  const A2 = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        A2[i][j] += A[i][k] * A[k][j];
      }
    }
  }

  // Calculate total work for all i values
  // Only consider i values that can form valid puzzles (need at least 8 categories total)
  let totalWork = 0;
  for (let i = 0; i < n - 7; i++) {
    let validJCount = 0;
    for (let j = i + 1; j < n; j++) {
      if (A2[i][j] >= 4) {
        validJCount++;
      }
    }
    totalWork += validJCount;
  }

  console.log(`Total work calculated: ${totalWork} j-steps`);

  // Initialize total work estimate with the calculated total
  totalWorkEstimate = totalWork;

  // If completedChunkWork is missing (old progress file), estimate it
  if (completedChunkWork === 0 && completedChunks.size > 0) {
    console.log("Estimating work from completed chunks...");
    // Calculate work for completed chunks using the same method as total work
    // Only count chunks that could have been valid (i < n - 7)
    for (const i of completedChunks) {
      if (i < n - 7) {
        let validJCount = 0;
        for (let j = i + 1; j < n; j++) {
          if (A2[i][j] >= 4) {
            validJCount++;
          }
        }
        completedChunkWork += validJCount;
      }
    }
    console.log(`Estimated ${completedChunkWork} j-steps from ${completedChunks.size} completed chunks`);
  }

  totalCompletedWork = completedChunkWork; // Initialize with completed work
  console.log(`Resuming from previous run. Found ${completedChunks.size} completed chunks with ${completedChunkWork} j-steps.`);

  // ── work queue management ──
  const workQueue = [];

  // First, calculate difficulties and create initial chunks
  const difficulties = new Map();

  // Only create chunks for i values that can form valid puzzles (need at least 8 categories total)
  for (let i = 0; i < n - 7; i++) {
    // Skip if this chunk was already completed
    if (completedChunks.has(i)) {
      continue;
    }

    // Calculate difficulty (number of valid j connections)
    let validJCount = 0;
    for (let j = i + 1; j < n; j++) {
      if (A2[i][j] >= 4) {
        validJCount++;
      }
    }
    difficulties.set(i, validJCount);

    // If there are zero valid j-steps for this i, mark it complete immediately
    if (validJCount === 0) {
      completedChunks.add(i);
      // No j-steps to add to completedChunkWork
      continue;
    }

    // Create initial chunk
    workQueue.push({
      start: i,
      end: i + 1,
      id: workQueue.length,
      difficulty: validJCount,
      totalJ: validJCount
    });
  }

  // Shuffle all chunks first
  for (let i = workQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [workQueue[i], workQueue[j]] = [workQueue[j], workQueue[i]];
  }

  // Then split hard chunks in place
  for (let i = 0; i < workQueue.length; i++) {
    const chunk = workQueue[i];
    if (chunk.difficulty > 50) {
      // Remove this chunk
      workQueue.splice(i, 1);
      i--; // Adjust index since we removed an item

      // Split into 4 smaller chunks
      const chunkSize = Math.ceil(chunk.difficulty / 4);
      for (let subChunk = 0; subChunk < 4; subChunk++) {
        // Skip if this sub-chunk was already completed
        if (partialChunkProgress.has(chunk.start) &&
          partialChunkProgress.get(chunk.start).has(subChunk)) {
          continue;
        }

        // Insert the sub-chunk at a random position
        const insertPos = Math.floor(Math.random() * (workQueue.length + 1));
        const sjStart = subChunk * chunkSize;
        const sjEnd = Math.min((subChunk + 1) * chunkSize, chunk.difficulty);
        workQueue.splice(insertPos, 0, {
          start: chunk.start,
          end: chunk.end,
          jStart: sjStart,
          jEnd: sjEnd,
          chunkIndex: subChunk,
          totalChunks: 4,
          id: workQueue.length,
          totalJ: Math.max(0, sjEnd - sjStart)
        });
      }
    }
  }

  // Log which chunks are being split
  const splitChunks = workQueue.filter(chunk => chunk.chunkIndex !== undefined);
  const splitIValues = [...new Set(splitChunks.map(chunk => chunk.start))];
  if (splitIValues.length > 0) {
    const displayValues = splitIValues.slice(0, 10).join(', ') + (splitIValues.length > 10 ? ', ...' : '');
    console.log(`Split ${splitIValues.length} hard i-values into ${splitChunks.length} smaller chunks: ${displayValues}`);
  }

  console.log(`Total work: ${n - 7} valid i-values in ${workQueue.length} chunks (${completedChunks.size} already completed)`);

  // Persist progress after marking zero-work i values as completed
  saveProgress(wordListHash, Array.from(completedChunks), completedChunkWork, partialChunkProgress);

  // ── compute adjacency once (main thread) and share with workers ──
  let N1Arr = null, N2Arr = null;
  {
    // JS build of adjacency: compute N1/N2 once in main thread
    const S = Array.from({ length: n }, () => Array(n).fill(false));
    const intersects = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] & b[i]) return true; return false; };
    const subset = (a, b) => { for (let i = 0; i < a.length; i++) if ((a[i] & ~b[i]) !== 0) return false; return true; };
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (subset(mask[i], mask[j]) || subset(mask[j], mask[i])) S[i][j] = S[j][i] = true;

    const A = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (!S[i][j] && intersects(mask[i], mask[j])) A[i][j] = A[j][i] = 1;

    const A2 = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        for (let k = 0; k < n; k++) A2[i][j] += A[i][k] * A[k][j];

    N1Arr = Array.from({ length: n }, (_, i) => A[i].map((v, idx) => v ? idx : -1).filter(x => x !== -1));
    const B = Array.from({ length: n }, () => Array(n).fill(false));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (!S[i][j] && A2[i][j] >= 4) B[i][j] = B[j][i] = true;
    N2Arr = Array.from({ length: n }, (_, i) => B[i].map((v, idx) => v ? idx : -1).filter(x => x !== -1));
  }

  // ── progress bookkeeping ──
  const status = Array.from({ length: nWorkers }, () => ({
    i: 0, total: 1, done: false, currentChunk: null, chunksCompleted: 0,
    puzzlesFound: 0, puzzlesInserted: 0, jProgress: 0, totalJ: 0
  }));
  const t0 = performance.now();
  let redrawTimeout = null;
  let isFirstRedraw = true;
  function redraw() {
    // Debounce rapid redraws
    if (redrawTimeout) {
      clearTimeout(redrawTimeout);
    }
    redrawTimeout = setTimeout(() => {
      const elapsed = (performance.now() - t0) / 1000;
      let out = "";

      // Overall progress bar - account for completed chunks + current progress
      const completedWork = completedChunkWork + status.reduce((sum, st) => sum + st.jProgress, 0);

      // Use the exact total work calculated upfront
      const overallProgress = totalWorkEstimate > 0 ? completedWork / totalWorkEstimate : 0;
      out += `\nOverall: [${bar(overallProgress)}] ${(overallProgress * 100).toFixed(1)}% (${completedWork}/${totalWorkEstimate} j-steps)`;
      out += `\nCompleted chunks: ${completedChunks.size}/${n - 7} i-values`;

      status.forEach((st, idx) => {
        let pct;
        if (st.done) {
          pct = 1; // Done workers show 100%
        } else if (st.totalJ === 0) {
          pct = 1; // Chunks with 0 j-steps are considered complete
        } else {
          pct = Math.min(st.jProgress / st.totalJ, 1);
        }

        const chunkInfo = st.currentChunk ?
          (st.currentChunk.chunkIndex !== undefined ?
            ` (i=${st.currentChunk.start}, chunk=${st.currentChunk.chunkIndex + 1}/${st.currentChunk.totalChunks}, j=${st.jProgress}/${st.totalJ})` :
            ` (i=${st.currentChunk.start}, j=${st.jProgress}/${st.totalJ})`) : "";
        const stats = st.done ?
          ` [${st.puzzlesFound} found, ${st.puzzlesInserted} inserted]` :
          ` [${st.puzzlesFound} found]`;
        out += `\nW${idx} [${bar(pct)}] ${(pct * 100).toFixed(1).padStart(6)}%${st.done ? " ✓" : ""}${chunkInfo}${stats}`;
      });
      out += `\nQueue: ${workQueue.length} chunks remaining   elapsed: ${fmt(elapsed)}`;

      // Only clear screen after the first redraw
      if (isFirstRedraw) {
        process.stdout.write("\n".repeat(14) + out);  // Add 20 blank lines + progress
        isFirstRedraw = false;
      } else {
        process.stdout.write("\x1b[H\x1b[J" + out);  // clear + write
      }
    }, 25); // 25ms debounce for more responsive updates
  }
  // Don't clear screen initially - let the first redraw handle it

  // ── spawn workers ──
  let active = nWorkers;
  // Track which workers have been sent cleanup and which acknowledged cleanup
  const cleanupSent = Array.from({ length: nWorkers }, () => false);
  const cleanupAcked = Array.from({ length: nWorkers }, () => false);
  let cleanedUpCount = 0;
  const workers = [];

  for (let id = 0; id < nWorkers; id++) {
    const w = new Worker(fileURLToPath(import.meta.url), {
      workerData: { id, nWorkers, cats, n, wordListHash, dbPath: DB_PATH, N1Arr, N2Arr }
    });
    workers.push(w);

    w.on("message", msg => {
      if (msg.type === "tick") {
        if (status[msg.id]) {
          // Update worker status with current progress
          status[msg.id] = { ...status[msg.id], jProgress: msg.jProgress, totalJ: msg.totalJ };
        }
        redraw();
      } else if (msg.type === "request_work") {
        // Worker finished current chunk, give it more work
        if (workQueue.length > 0) {
          const chunk = workQueue.shift();
          if (status[msg.id]) {
            // Add the completed work to the total
            totalCompletedWork += status[msg.id].totalJ;

            // Handle partial chunk completion
            const currentChunk = status[msg.id].currentChunk;
            if (currentChunk.chunkIndex !== undefined) {
              // For partial chunks, track which chunks of this i value are completed
              const i = currentChunk.start;
              if (!partialChunkProgress.has(i)) {
                partialChunkProgress.set(i, new Set());
              }
              partialChunkProgress.get(i).add(currentChunk.chunkIndex);

              // If all chunks for this i value are completed, mark it as done
              if (partialChunkProgress.get(i).size === currentChunk.totalChunks) {
                completedChunks.add(i);
                partialChunkProgress.delete(i); // Clean up
              }

              completedChunkWork += status[msg.id].totalJ;
            } else {
              // For regular chunks, mark the i value as completed
              completedChunks.add(currentChunk.start);
              completedChunkWork += status[msg.id].totalJ;
            }

            // Save progress
            saveProgress(wordListHash, Array.from(completedChunks), completedChunkWork, partialChunkProgress);

            status[msg.id].currentChunk = chunk;
            status[msg.id].chunksCompleted++;
            status[msg.id].jProgress = 0;
            status[msg.id].totalJ = chunk.totalJ;
            status[msg.id].puzzlesFound = msg.puzzlesFound || 0;
            status[msg.id].puzzlesInserted = msg.puzzlesInserted || 0;
          }
          w.postMessage({ type: "work", chunk });
        } else {
          // No more work – send cleanup to this worker if not already sent
          if (!cleanupSent[msg.id]) {
            cleanupSent[msg.id] = true;
            if (status[msg.id]) {
              status[msg.id].puzzlesFound = msg.puzzlesFound || 0;
              status[msg.id].puzzlesInserted = msg.puzzlesInserted || 0;
            }
            w.postMessage({ type: "cleanup" });
          }
          redraw();
        }
      } else if (msg.type === "stats") {
        // Incremental stats from worker after a batch flush
        if (status[msg.id]) {
          status[msg.id].puzzlesFound = msg.puzzlesFound || status[msg.id].puzzlesFound;
          status[msg.id].puzzlesInserted = msg.puzzlesInserted || status[msg.id].puzzlesInserted;
        }
        redraw();
      } else if (msg.type === "cleanup_done") {
        // Worker acknowledged cleanup
        if (!cleanupAcked[msg.id]) {
          cleanupAcked[msg.id] = true;
          cleanedUpCount++;
          if (status[msg.id]) {
            status[msg.id].done = true;
            status[msg.id].puzzlesFound = msg.puzzlesFound || 0;
            status[msg.id].puzzlesInserted = msg.puzzlesInserted || 0;
          }
          active--;
        }
        redraw();

        // Check if all workers have cleaned up
        if (cleanedUpCount === nWorkers) {
          // Wait a moment for any final database writes to complete
          console.log("All workers cleaned up. Closing database...");
          setTimeout(() => {
            db.close(() => {
              const totalFound = status.reduce((sum, st) => sum + st.puzzlesFound, 0);
              const totalInserted = status.reduce((sum, st) => sum + st.puzzlesInserted, 0);
              console.log(`\nAll done. Total: ${totalFound} puzzles found, ${totalInserted} inserted.`);

              // Run database cleanup
              // Post-run data updater
              try {
                console.log("Running data update (post)…");
                const upd2 = spawnSync('node', ['update_all_data.js'], { cwd: __dirname, stdio: 'inherit', encoding: 'utf8' });
                if (upd2.status !== 0) console.warn('update_all_data.js (post) exited non-zero');
              } catch (e) {
                console.warn('update_all_data.js (post) failed:', e.message);
              }

              console.log("Running database cleanup (parallel validator)...");
              // Always reset cleaner progress so it validates newly-found puzzles too
              try {
                const cleanProgress = path.join(__dirname, "progress_clean.json");
                if (fs.existsSync(cleanProgress)) fs.unlinkSync(cleanProgress);
              } catch (e) {
                console.warn("Warning: could not remove progress_clean.json:", e.message);
              }
              import('child_process').then(({ spawn }) => {
                const cleanup = spawn('node', ['clean_db_parallel.js'], {
                  stdio: 'inherit',
                  cwd: __dirname
                });

                cleanup.on('close', (code) => {
                  if (code === 0) {
                    console.log("Database cleanup completed successfully.");
                  } else {
                    console.log(`Database cleanup failed with code ${code}.`);
                  }
                  process.exit(0);
                });
              });
            });
          }, 1000); // Wait 1 second for final writes
        }
      }
    });
    w.on("error", e => console.error("worker error:", e));

    // Give initial work to worker, or send cleanup if nothing to do
    if (workQueue.length > 0) {
      const chunk = workQueue.shift();
      status[id].currentChunk = chunk;
      w.postMessage({ type: "work", chunk });
    } else {
      if (!cleanupSent[id]) {
        cleanupSent[id] = true;
        w.postMessage({ type: "cleanup" });
      }
    }
  }

  /*────────────────────────── WORKER THREAD ─────────────────────────*/
} else {

  const { id: WID, nWorkers: NW, cats, n, wordListHash, dbPath, N1Arr, N2Arr } = workerData;

  // ── load data ──
  const wordsJson = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));
  const categoriesJson = JSON.parse(fs.readFileSync(CATS_F, "utf8"));
  const metaCatsJson = JSON.parse(fs.readFileSync(META_CATS_F, "utf8"));
  const ALL_WORDS = Object.keys(wordsJson);
  const WORD_IDX = new Map(ALL_WORDS.map((w, i) => [w, i]));
  const MASK_LEN = Math.ceil(ALL_WORDS.length / 32);

  // ── worker database setup ──
  const db = new sqlite3.Database(dbPath);
  db.serialize(() => {
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=OFF");
  });

  // Batch management
  const BATCH_SIZE = 100;
  let puzzleBatch = [];
  let puzzlesFound = 0;
  let puzzlesInserted = 0;

  function flushBatch() {
    if (puzzleBatch.length === 0) return;

    const ph = puzzleBatch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
    const flat = puzzleBatch.flatMap(p => [p.hash, ...p.rows, ...p.cols, wordListHash]);

    db.run(`INSERT OR IGNORE INTO puzzles (puzzle_hash,row0,row1,row2,row3,col0,col1,col2,col3,word_list_hash) VALUES ${ph}`, flat, (err) => {
      if (err) {
        console.error("Batch insert error:", err);
        return;
      }
      // Count how many were actually inserted
      db.get("SELECT changes() as count", (err, row) => {
        if (!err && row) {
          puzzlesInserted += row.count;
          // Report incremental stats to main thread
          parentPort.postMessage({
            type: "stats",
            id: WID,
            puzzlesFound,
            puzzlesInserted
          });
        }
      });
    });

    puzzleBatch = [];
  }

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
  function subset(a, b) { for (let i = 0; i < MASK_LEN; i++) if ((a[i] & ~b[i]) !== 0) return false; return true; }

  const mask = cats.map(c => makeMask(categoriesJson[c]));

  // subset mask
  const S = Array.from({ length: n }, () => Array(n).fill(false));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (subset(mask[i], mask[j]) || subset(mask[j], mask[i])) S[i][j] = S[j][i] = true;

  // Use precomputed adjacency from main thread
  const N1 = N1Arr.map(arr => new Set(arr));
  const N2 = N2Arr.map(arr => new Set(arr));

  // Build B matrix from N2 (needed for column validation regardless of whether we used Rust or JS)
  const B = Array.from({ length: n }, () => Array(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (const j of N2[i]) {
      B[i][j] = B[j][i] = true;
    }
  }

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

  // ── Rust inner-loop integration ──
  const rustPathRel = path.join(__dirname, "rust_helper", "target", "release", "cdx_worker");
  const rustPathDbg = path.join(__dirname, "rust_helper", "target", "debug", "cdx_worker");
  const rustPath = fs.existsSync(rustPathRel) ? rustPathRel : (fs.existsSync(rustPathDbg) ? rustPathDbg : null);
  let rustProc = null;
  let rustRL = null;
  let currentResolve = null;

  async function ensureRust() {
    if (rustProc || !rustPath) return;
    rustProc = spawn(rustPath, [], { stdio: ["pipe", "pipe", "inherit"] });
    rustRL = (await import('readline')).createInterface({ input: rustProc.stdout });
    const metaMap = cats.map(c => categoryToMeta.get(c) || null);
    rustProc.stdin.write(JSON.stringify({ type: "Init", masks: mask.map(m => Array.from(m)), n1: N1Arr, n2: N2Arr, categories: cats, meta_map: metaMap }) + "\n");
    rustRL.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "Tick") {
          parentPort.postMessage({ type: "tick", id: WID, jProgress: msg.jProgress, totalJ: msg.totalJ });
        } else if (msg.type === "Found") {
          const rowsCats = msg.rows.map((v) => cats[v]);
          const colsCats = msg.cols.map((v) => cats[v]);
          const puzzleHash = sha256(rowsCats.join("|") + colsCats.join("|"));
          puzzleBatch.push({ hash: puzzleHash, rows: rowsCats, cols: colsCats });
                    puzzlesFound++;
          if (puzzleBatch.length >= BATCH_SIZE) flushBatch();
        } else if (msg.type === "Done") {
          if (currentResolve) { const r = currentResolve; currentResolve = null; r(); }
        }
      } catch {}
    });
  }

  async function processChunk(chunk) {
    const { start, end, jStart, jEnd } = chunk;
    if (!rustPath) throw new Error("Rust inner worker binary not found");
    if (!rustProc) {
      // dynamic import for readline in ESM
      await ensureRust();
    }
    await new Promise((resolve) => {
      currentResolve = resolve;
      rustProc.stdin.write(JSON.stringify({ type: "Work", start, end, jStart, jEnd }) + "\n");
    });
    flushBatch();
  }

  // ── message handling ──
  parentPort.on("message", async msg => {
    if (msg.type === "work") {
      await processChunk(msg.chunk);
      // Request more work when done, sending current statistics
      parentPort.postMessage({
        type: "request_work",
        id: WID,
        puzzlesFound: puzzlesFound,
        puzzlesInserted: puzzlesInserted
      });
    } else if (msg.type === "cleanup") {
      // Flush any remaining puzzles and close database
      flushBatch();
      db.close(() => {
        parentPort.postMessage({
          type: "cleanup_done",
          id: WID,
          puzzlesFound: puzzlesFound,
          puzzlesInserted: puzzlesInserted
        });
        // Allow worker to exit naturally
        if (parentPort && parentPort.close) {
          try { parentPort.close(); } catch {}
        }
      });
    }
  });
}
