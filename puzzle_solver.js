// connecdoku_parallel_search.js – multi‑worker, resumable 8‑pointer solver
// ──────────────────────────────────────────────────────────────────────────────
// Builds full 1‑away / 2‑away matrices **with iterative pruning**:
//   * ≥ 4 distinct 1‑away neighbours
//   * ≥ 3 distinct 2‑away neighbours (each with ≥ 4 independent paths)
//   * Subset and self‑edges are zeroed before every 2‑away build.
// Splits the first‑pointer search space across WORKERS (stride = 2·WORKERS).
// Checkpoints to progress/ and writes each solved puzzle to puzzles/ (<sha>.json).
// Extra debug: workers print detailed exit diagnostics if <100 iterations.
//
// Usage examples:
//   node connecdoku_parallel_search.js                 # resume / continue run
//   node connecdoku_parallel_search.js --fresh         # ignore checkpoints
//   WORKERS=12 SAVE_INTERVAL=20000 node connecdoku_parallel_search.js --fresh
//
// Env vars (override defaults):
//   WORKERS       – number of worker threads (default 6)
//   SAVE_INTERVAL – checkpoint interval in iterations  (default 50000)
//   LOG_INTERVAL  – progress log interval              (default 10000)
//   FRESH         – if set to "1" start fresh (same as --fresh)
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { Matrix } = require('ml-matrix');
const { execSync } = require('child_process');

// ───────────────────────────── helper utils ──────────────────────────────────
const sha = (str) => crypto.createHash('sha256').update(str).digest('hex');
const ensure = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };

// Progress bar utils
const BAR_WIDTH = 40;
const formatBar = (progress, width) => {
    const filled = Math.round(progress * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
};
const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
};

// ───────────────────────────── dirs / paths  ─────────────────────────────────
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUZZLE_DIR = path.join(ROOT, 'puzzles');
const PROG_DIR = path.join(ROOT, 'progress');
ensure(PUZZLE_DIR); ensure(PROG_DIR);

const WORDS_F = path.join(DATA_DIR, 'words.json');
const CATS_F = path.join(DATA_DIR, 'categories.json');

// ───────────────────────────── env / options ─────────────────────────────────
const WORKERS = +process.env.WORKERS || 6;
const SAVE_INTERVAL = +process.env.SAVE_INTERVAL || 10000;  // Save more frequently
const LOG_INTERVAL = +process.env.LOG_INTERVAL || 1000;
const IS_FRESH = process.argv.includes('--fresh') || process.env.FRESH === '1';

// ───────────────────────────── main thread  ──────────────────────────────────
if (isMainThread) {
    // First run update_all_data.js
    console.log('Running update_all_data.js...');
    execSync('node update_all_data.js', { stdio: 'inherit' });
    console.log('Data update complete.\n');

    const words = JSON.parse(fs.readFileSync(WORDS_F, 'utf8'));
    const categories = JSON.parse(fs.readFileSync(CATS_F, 'utf8'));
    let cats = Object.keys(categories).filter(c => categories[c].length >= 4);

    // Check for and clean up old checkpoint files
    const wordHash = sha(JSON.stringify(Object.keys(words).sort()));
    const checkpointFiles = fs.readdirSync(PROG_DIR);
    let oldHashFound = false;
    checkpointFiles.forEach(file => {
        const hash = file.split('_')[0];
        if (hash !== wordHash) {
            oldHashFound = true;
            fs.unlinkSync(path.join(PROG_DIR, file));
        }
    });
    if (oldHashFound) {
        console.log('Detected word list changes, cleared old checkpoints.');
    }

    /* ------------------- iterative 1‑/2‑away pruning loop ------------------- */
    let changed = true; let one, two;
    const isSub = (a, b) => categories[a].every(w => categories[b].includes(w));

    while (changed) {
        const n = cats.length; changed = false;
        one = new Matrix(n, n);
        for (let i = 0; i < n; i++) {
            const w1 = categories[cats[i]];
            for (let j = 0; j < n; j++) {
                if (i === j) { one.set(i, j, 0); continue; }
                const w2 = categories[cats[j]];
                one.set(i, j, w1.filter(w => w2.includes(w)).length);
            }
        }
        // zero subset edges
        for (let i = 0; i < cats.length; i++) {
            for (let j = 0; j < cats.length; j++) {
                if (i !== j && (isSub(cats[i], cats[j]) || isSub(cats[j], cats[i]))) one.set(i, j, 0);
            }
        }
        // build 2‑away
        const twoRaw = one.mmul(one); const n2 = cats.length;
        two = new Matrix(n2, n2);
        for (let i = 0; i < n2; i++) for (let j = 0; j < n2; j++) two.set(i, j, (i !== j && twoRaw.get(i, j) >= 4) ? 1 : 0);

        // prune categories
        const keep = [];
        for (let i = 0; i < n2; i++) {
            const oneAway = one.getRow(i).reduce((s, v) => s + (v > 0), 0);
            const twoAway = two.getRow(i).reduce((s, v) => s + v, 0);
            if (oneAway >= 4 && twoAway >= 3) keep.push(cats[i]); else changed = true;
        }
        cats = keep;
    }

    const n = cats.length;
    const payload = {
        cats, n, saveEvery: SAVE_INTERVAL, logEvery: LOG_INTERVAL,
        one: one.to1DArray(), two: two.to1DArray(), words
    };

    console.log('Word‑list hash:', wordHash.slice(0, 16));
    console.log(`Filtered categories: ${n}`);
    console.log(`Launching ${WORKERS} workers... (fresh=${IS_FRESH})\n`);

    // Progress tracking
    const workerStates = new Array(WORKERS).fill(null).map(() => ({
        solved: 0,
        iter: 0,
        cat1: '',
        cat2: '',
        lastUpdate: Date.now(),
        lines: 1,
        rootPtr: 0,
        maxPtr: n * 2  // Each worker's total search space
    }));
    let lastDrawn = 0;
    let startTime = Date.now();
    let lastRedraw = 0;
    const REDRAW_INTERVAL = 250;  // Limit redraw rate to 4 times per second

    // Clear progress bars and redraw
    const redrawProgress = () => {
        const now = Date.now();
        if (now - lastRedraw < REDRAW_INTERVAL) return;
        lastRedraw = now;

        // Calculate how many lines we need to clear (all workers + ETA + blank line)
        const linesToClear = WORKERS + 2;

        // Move cursor up and clear screen from cursor down
        if (lastDrawn > 0) {
            process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
        }
        lastDrawn = linesToClear;

        // Calculate global stats
        const totalIters = workerStates.reduce((sum, state) => sum + state.iter, 0);
        const totalSolved = workerStates.reduce((sum, state) => sum + state.solved, 0);
        const elapsed = (now - startTime) / 1000;
        const rate = totalIters / elapsed;

        // Draw each worker's progress
        workerStates.forEach((state, i) => {
            // Calculate progress based on lexicographical ordering
            let progress = 0;
            if (state.stack && state.stack.length > 0) {
                const maxPos = state.maxPtr;
                const firstPtr = state.stack[0];

                // First pointer defines the primary range
                progress = firstPtr / maxPos;

                // Second pointer (if exists) gives precision within that range
                if (state.stack.length > 1) {
                    const secondPtr = state.stack[1];
                    // Each first pointer position has (maxPos - firstPtr - 1) possible second pointers
                    const remainingForSecond = maxPos - firstPtr - 1;
                    if (remainingForSecond > 0) {
                        const secondProgress = (secondPtr - (firstPtr + 1)) / remainingForSecond;
                        // Add fractional progress from second pointer
                        progress += (1 / maxPos) * secondProgress;
                    }
                }

                // Account for the fact that higher first pointer values have fewer possibilities
                // This means we're actually further along than linear progress suggests
                const quadraticAdjustment = (firstPtr / maxPos) * 0.5; // Rough approximation of the effect
                progress += quadraticAdjustment;
            }

            const bar = formatBar(Math.min(1, progress), BAR_WIDTH);
            const percent = (progress * 100).toFixed(2).padStart(6);
            console.log(`Worker ${i}: ${bar} ${percent}% | ${state.solved} puzzles | ${state.cat1 || 'searching'} × ${state.cat2 || '...'}`);
        });

        // Draw ETA using same progress calculation
        const avgProgress = workerStates.reduce((sum, state) => {
            let progress = 0;
            if (state.stack && state.stack.length > 0) {
                const maxPos = state.maxPtr;
                const firstPtr = state.stack[0];
                progress = firstPtr / maxPos;

                if (state.stack.length > 1) {
                    const secondPtr = state.stack[1];
                    const remainingForSecond = maxPos - firstPtr - 1;
                    if (remainingForSecond > 0) {
                        const secondProgress = (secondPtr - (firstPtr + 1)) / remainingForSecond;
                        progress += (1 / maxPos) * secondProgress;
                    }
                }

                const quadraticAdjustment = (firstPtr / maxPos) * 0.5;
                progress += quadraticAdjustment;
            }
            return sum + progress;
        }, 0) / WORKERS;

        const remaining = avgProgress > 0 ? (elapsed * (1 - avgProgress) / avgProgress) : 0;
        console.log('');  // blank line
        console.log(`ETA: ${formatTime(remaining)} (${Math.round(rate)} iterations/sec, ${totalSolved} puzzles found)`);
    };

    // Create workers and handle messages
    for (let wid = 0; wid < WORKERS; wid++) {
        const w = new Worker(__filename, { workerData: { wid, stride: WORKERS, payload, wordHash, isFresh: IS_FRESH } });
        w.on('message', msg => {
            workerStates[msg.wid] = { ...workerStates[msg.wid], ...msg, stack: msg.stack };  // Include full stack in state
            redrawProgress();
        });
        w.on('exit', c => {
            workerStates[wid].cat1 = 'DONE';
            workerStates[wid].cat2 = '';
            workerStates[wid].rootPtr = workerStates[wid].maxPtr;
            workerStates[wid].stack = [];
            redrawProgress();
        });
    }
    return;
}

// ───────────────────────────── worker thread ────────────────────────────────
const { wid, stride, payload, wordHash, isFresh } = workerData;
const { cats, n, saveEvery, logEvery, one, two, words } = payload;

const oneM = Matrix.from1DArray(n, n, one);
const twoM = Matrix.from1DArray(n, n, two);
const canSame = (a, b) => twoM.get(a, b) === 1;
const canCross = (a, b) => oneM.get(a, b) > 0;

// generate position list: even index = row, odd = col
const pos = []; for (let i = 0; i < n; i++) { pos.push({ idx: i, isRow: true }); pos.push({ idx: i, isRow: false }); }

// checkpoint helpers
const progF = path.join(PROG_DIR, `${wordHash}_${wid}.json`);
let cp = null;
if (!isFresh) { try { cp = JSON.parse(fs.readFileSync(progF, 'utf8')); } catch { } }
if (!cp || !Array.isArray(cp.stack) || cp.stack.length === 0) { cp = { stack: [wid * 2], iter: 0, solved: 0, rootPtr: wid * 2 }; }
let { stack, iter, solved, rootPtr } = cp;
if (!rootPtr) rootPtr = stack[0]; // Handle old checkpoint files that don't have rootPtr

const saveCP = () => fs.writeFileSync(progF, JSON.stringify({ stack, iter, solved, rootPtr }));
const savePuzzle = (rows, cols) => {
    const key = sha(rows.sort().join(',') + cols.sort().join(','));
    try { fs.writeFileSync(path.join(PUZZLE_DIR, `${key}.json`), JSON.stringify({ rows, cols, size: '4x4' }), { flag: 'wx' }); } catch { }
};

// compatibility helpers
function isCompatible(idx, rows, cols, newIsRow) {
    if (newIsRow) {               // adding a *row*
        for (const r of rows) if (!canSame(idx, r)) return false;   // row‑row 2‑away
        for (const c of cols) if (!canCross(idx, c)) return false;  // row‑col 1‑away
    } else {                      // adding a *column*
        for (const c of cols) if (!canSame(idx, c)) return false;   // col‑col 2‑away
        for (const r of rows) if (!canCross(r, idx)) return false;  // col‑row 1‑away
    }
    return true;
}

function fastSolve(rows, cols) {
    const used = new Set();
    for (const r of rows) {
        const rCat = cats[r];
        for (const c of cols) {
            const cCat = cats[c];
            const rWords = words[rCat] || [];
            const cWords = words[cCat] || [];
            const ints = rWords.filter(w => cWords.includes(w)).filter(w => !used.has(w));
            if (ints.length === 0) return false;
            used.add(ints[0]);
        }
    }
    return true;
}

// Modified progress reporting to include full stack
const reportProgress = () => {
    parentPort.postMessage({
        wid,
        iter,
        solved,
        cat1: stack.length > 0 ? cats[pos[stack[0]].idx] : '',
        cat2: stack.length > 1 ? cats[pos[stack[1]].idx] : '',
        lastUpdate: Date.now(),
        rootPtr: rootPtr,
        stack: [...stack]  // Send full stack state
    });
};

// search parameters
const MAX_PTR = 8;
let lastLog = iter;
let lastSave = iter;

while (true) {
    iter++;

    // complete puzzle?
    if (stack.length === MAX_PTR) {
        const rows = [], cols = [];
        for (const p of stack) { const { idx, isRow } = pos[p]; (isRow ? rows : cols).push(idx); }
        if (rows.length === 4 && cols.length === 4) {
            if (fastSolve(rows, cols)) {
                savePuzzle(rows.map(i => cats[i]), cols.map(i => cats[i]));
                solved++;
                saveCP();  // Save immediately after finding a puzzle
                lastSave = iter;
            }
        }
        // backtrack
        const last = stack.pop();
        if (stack.length) {
            stack[stack.length - 1] += (stack.length === 1) ? stride * 2 : 1;
            continue;
        }
        // stack empty → advance root pointer
        rootPtr += stride * 2;
        if (rootPtr >= pos.length) break; // slice exhausted
        stack = [rootPtr];
        saveCP();  // Save when advancing root pointer
        lastSave = iter;
        continue;
    }

    // try to add next pointer
    let added = false;
    let next = stack[stack.length - 1] + 1; // always +1 when adding
    while (next < pos.length) {
        const { idx, isRow } = pos[next];
        const rows = [], cols = []; for (const p of stack) { const q = pos[p]; (q.isRow ? rows : cols).push(q.idx); }
        if ((isRow && rows.length === 4) || (!isRow && cols.length === 4)) { next++; continue; }
        if (rows.includes(idx) || cols.includes(idx)) { next++; continue; }
        if (isCompatible(idx, rows, cols, isRow)) { stack.push(next); added = true; break; }
        next++;
    }
    if (!added) {
        const removed = stack.pop();
        if (stack.length) {
            stack[stack.length - 1] += (stack.length === 1) ? stride * 2 : 1;
            continue;
        }
        // emptied: advance root pointer
        rootPtr += stride * 2;
        if (rootPtr >= pos.length) break;
        stack = [rootPtr];
        continue;
    }

    // logging & checkpoint
    if (iter - lastLog >= LOG_INTERVAL) {
        reportProgress();
        lastLog = iter;
    }

    // separate checkpoint interval
    if (iter - lastSave >= SAVE_INTERVAL) {
        saveCP();
        lastSave = iter;
    }

    // Save periodically when making significant progress
    if (stack.length >= 4 && iter - lastSave >= SAVE_INTERVAL / 2) {
        saveCP();
        lastSave = iter;
    }
}

// Final save before exit
saveCP();
reportProgress();
process.exit(0);
