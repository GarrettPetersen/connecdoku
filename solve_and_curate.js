#!/usr/bin/env node
/**
 * solve_and_curate.js
 * ------------------------------------------------------------------
 * Brand new pipeline: solve-and-curate (no DB).
 *
 * - Computes "secret sauce" exclusions:
 *    - categories used in last N daily puzzles (default 13)
 *    - always-excluded categories
 *    - top-used categories (default 10)
 * - Runs Rust-backed solver in "stream results" mode, pre-pruning excluded
 *   categories up-front (so it never searches them).
 * - Stores puzzles in-memory and stops early when enough candidates are found.
 * - Scores candidates using existing category scoring (category_scores.json).
 * - Produces a diversified ordering: highest score first, then greedily pick
 *   the highest scoring puzzle with minimal overlap with already-selected
 *   categories.
 * - Hands the resulting list to the existing AI curator by writing
 *   curator_state.json in PUZZLE_LIST phase and re-rendering curator_output.md.
 */
/* eslint-disable no-console */

"use strict";

import os from "os";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { spawn, spawnSync } from "child_process";
import * as prompts from "@inquirer/prompts";
import { loadCategorySimilarity, puzzleCategorySimilarity } from "./similarity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");
const CATS_F = path.join(DATA_DIR, "categories.json");
const META_CATS_F = path.join(DATA_DIR, "meta_categories.json");
const CAT_SCORES_F = path.join(DATA_DIR, "category_scores.json");

const OUT_DIR = path.join(__dirname, "daily_puzzles");
const DAILY_DB_FILE = path.join(OUT_DIR, "puzzles.json");
const STATE_FILE = path.join(__dirname, "curator_state.json");
const OUTPUT_FILE = path.join(__dirname, "curator_output.md");

const DEBUG = process.env.SOLVE_CURATE_DEBUG === "1";
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const ALWAYS_EXCLUDED_CATEGORIES = [
  "21st Century",
  "20th Century",
  "2020s",
  "2010s",
  "Things American",
  "Flower-class Corvettes",
];

function computePuzzleHash(rows, cols) {
  const s = rows.join("|") + cols.join("|");
  return crypto.createHash("sha256").update(s).digest("hex");
}

function readJsonOr(pathname, fallback) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

function loadDailyDb() {
  if (!fs.existsSync(DAILY_DB_FILE)) return [];
  try {
    const db = JSON.parse(fs.readFileSync(DAILY_DB_FILE, "utf8"));
    return Array.isArray(db) ? db : [];
  } catch {
    return [];
  }
}

function buildUsageCounts(dailyDb) {
  const categoryUsage = Object.create(null);
  for (const puzzle of dailyDb) {
    const cats = [...(puzzle.rows || []), ...(puzzle.cols || [])];
    for (const c of cats) {
      if (!c) continue;
      categoryUsage[c] = (categoryUsage[c] || 0) + 1;
    }
  }
  return categoryUsage;
}

function getTopUsedCategories(categoryUsage, limit) {
  return Object.entries(categoryUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([cat]) => cat);
}

function getCategoriesFromLastNDays(dailyDb, numDays) {
  const recentCategories = new Set();
  const n = Math.max(0, numDays | 0);
  const recentPuzzles = dailyDb.slice(-n);
  for (const puzzle of recentPuzzles) {
    for (const c of [...(puzzle.rows || []), ...(puzzle.cols || [])]) recentCategories.add(c);
  }
  for (const c of ALWAYS_EXCLUDED_CATEGORIES) recentCategories.add(c);
  return Array.from(recentCategories);
}

function scorePuzzle(allCats, categoryScores) {
  let s = 0;
  for (const c of allCats) s += Number(categoryScores[c] || 0);
  return s;
}

function computeCategoryMovieOverlap(categoriesJson) {
  const movies = new Set(categoriesJson["Movies"] || []);
  const overlaps = Object.create(null);
  if (!movies.size) return overlaps;

  for (const [cat, words] of Object.entries(categoriesJson)) {
    if (!Array.isArray(words) || words.length === 0) {
      overlaps[cat] = 0;
      continue;
    }
    let intersection = 0;
    for (const w of words) {
      if (movies.has(w)) intersection++;
    }
    // Explicit overlap ratio of this category with Movies.
    overlaps[cat] = intersection / words.length;
  }
  return overlaps;
}

function parseYearCategory(cat) {
  if (!/^\d{4}$/.test(cat)) return null;
  return parseInt(cat, 10);
}

function parseDecadeCategory(cat) {
  const m = cat.match(/^(\d{3}0)s$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function parseCenturyCategory(cat) {
  const m = cat.match(/^(\d+)(st|nd|rd|th) Century$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function computeTemporalPenalty(allCats, params) {
  let yearProximityPenalty = 0;
  let adjacentDecadePenalty = 0;
  let adjacentCenturyPenalty = 0;

  const years = allCats.map(parseYearCategory).filter((v) => Number.isFinite(v));
  const decades = allCats.map(parseDecadeCategory).filter((v) => Number.isFinite(v));
  const centuries = allCats.map(parseCenturyCategory).filter((v) => Number.isFinite(v));

  for (let i = 0; i < years.length; i++) {
    for (let j = i + 1; j < years.length; j++) {
      const d = Math.abs(years[i] - years[j]);
      if (d < 10) {
        // Descending penalty: diff 0 => full weight, diff 9 => 10% weight.
        yearProximityPenalty += params.yearProximityPenaltyWeight * ((10 - d) / 10);
      }
    }
  }

  for (let i = 0; i < decades.length; i++) {
    for (let j = i + 1; j < decades.length; j++) {
      if (Math.abs(decades[i] - decades[j]) === 10) {
        adjacentDecadePenalty += params.adjacentDecadePenaltyWeight;
      }
    }
  }

  for (let i = 0; i < centuries.length; i++) {
    for (let j = i + 1; j < centuries.length; j++) {
      if (Math.abs(centuries[i] - centuries[j]) === 1) {
        adjacentCenturyPenalty += params.adjacentCenturyPenaltyWeight;
      }
    }
  }

  return {
    yearProximityPenalty,
    adjacentDecadePenalty,
    adjacentCenturyPenalty,
    temporalPenalty: yearProximityPenalty + adjacentDecadePenalty + adjacentCenturyPenalty,
  };
}

function countOverlapWithSet(allCats, usedSet) {
  let o = 0;
  for (const c of allCats) if (usedSet.has(c)) o++;
  return o;
}

function diversifiedGreedyOrder(puzzles, k) {
  if (!puzzles.length) return [];
  const getScore = (p) => (typeof p.finalScore === "number" ? p.finalScore : (p.qualityScore || 0));
  const sorted = [...puzzles].sort((a, b) => getScore(b) - getScore(a));
  const selected = [];
  const usedCats = new Set();

  // First = highest score.
  const first = sorted.shift();
  selected.push(first);
  for (const c of [...first.rows, ...first.cols]) usedCats.add(c);

  while (selected.length < k && sorted.length) {
    let bestIdx = -1;
    let bestOverlap = Infinity;
    let bestScore = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const cats = [...p.rows, ...p.cols];
      const overlap = countOverlapWithSet(cats, usedCats);
      const score = getScore(p);
      if (overlap < bestOverlap || (overlap === bestOverlap && score > bestScore)) {
        bestOverlap = overlap;
        bestScore = score;
        bestIdx = i;
      }
    }
    const next = sorted.splice(bestIdx, 1)[0];
    selected.push(next);
    for (const c of [...next.rows, ...next.cols]) usedCats.add(c);
  }
  return selected;
}

function getEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = parseInt(String(raw), 10);
  return Number.isFinite(v) ? v : fallback;
}

function getEnvFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = parseFloat(String(raw));
  return Number.isFinite(v) ? v : fallback;
}

async function getParamsInteractive() {
  const cpuCount = os.cpus().length;
  const params = {
    daysLag: getEnvInt("SOLVE_CURATE_DAYS", 13),
    topUsedExclude: getEnvInt("SOLVE_CURATE_TOP_USED_EXCLUDE", 10),
    candidatePoolSize: getEnvInt("SOLVE_CURATE_POOL_SIZE", 250),
    optionsToShow: getEnvInt("SOLVE_CURATE_OPTIONS", 30),
    workers: getEnvInt("SOLVE_CURATE_WORKERS", Math.max(1, Math.min(cpuCount, 8))),
    jChunk: getEnvInt("SOLVE_CURATE_J_CHUNK", 15),
    maxSeconds: getEnvFloat("SOLVE_CURATE_MAX_SECONDS", 180),
    minScore: getEnvFloat("SOLVE_CURATE_MIN_SCORE", -Infinity),
    simPenaltyWeight: getEnvFloat("SOLVE_CURATE_SIM_PENALTY_WEIGHT", 8),
    simCutoff: getEnvFloat("SOLVE_CURATE_SIM_CUTOFF", 0.625),
    // 0 or unset default: score every candidate for finalScore (sort/curator use final only).
    // Set SOLVE_CURATE_SIM_EVAL_TOPN to a positive N to only score the top N by quality first (faster).
    simEvalTopN: getEnvInt("SOLVE_CURATE_SIM_EVAL_TOPN", 0),
    movieOverlapPenaltyWeight: getEnvFloat("SOLVE_CURATE_MOVIE_OVERLAP_PENALTY_WEIGHT", 4),
    yearProximityPenaltyWeight: getEnvFloat("SOLVE_CURATE_YEAR_PROXIMITY_PENALTY_WEIGHT", 2),
    adjacentDecadePenaltyWeight: getEnvFloat("SOLVE_CURATE_ADJ_DECADE_PENALTY_WEIGHT", 0.6),
    adjacentCenturyPenaltyWeight: getEnvFloat("SOLVE_CURATE_ADJ_CENTURY_PENALTY_WEIGHT", 0.35),
  };

  // If explicitly non-interactive, skip prompts.
  if (process.env.SOLVE_CURATE_NONINTERACTIVE === "1") return params;
  // If there's no interactive terminal, don't block on prompts.
  if (!process.stdin.isTTY) return params;

  console.log("\nSolve-and-curate parameters (press Enter to accept defaults):\n");

  const daysLagRaw = await prompts.input({
    message: "Secret-sauce lag (days to exclude recent categories)",
    initial: String(params.daysLag),
  });
  const topUsedRaw = await prompts.input({
    message: "Exclude top-used categories (count)",
    initial: String(params.topUsedExclude),
  });
  const poolRaw = await prompts.input({
    message: "How many candidate puzzles to collect before stopping (pool size)",
    initial: String(params.candidatePoolSize),
  });
  const optionsRaw = await prompts.input({
    message: "How many diversified options to hand to the AI curator",
    initial: String(params.optionsToShow),
  });
  const workersRaw = await prompts.input({
    message: "Solver workers (CPU parallelism)",
    initial: String(params.workers),
  });
  const jChunkRaw = await prompts.input({
    message: "Chunk size in j-steps (smaller = stops earlier, larger = faster per overhead)",
    initial: String(params.jChunk),
  });
  const maxSecRaw = await prompts.input({
    message: "Max seconds to search before stopping (0 = no limit)",
    initial: String(params.maxSeconds),
  });
  const minScoreRaw = await prompts.input({
    message: "Minimum score to keep a candidate (optional; blank = no min)",
    initial: params.minScore === -Infinity ? "" : String(params.minScore),
  });
  const simPenaltyRaw = await prompts.input({
    message: "Similarity penalty weight vs past puzzles (bigger = more diversity pressure)",
    initial: String(params.simPenaltyWeight),
  });
  const simCutoffRaw = await prompts.input({
    message: "Similarity cutoff vs past puzzles (>= cutoff will be rejected; 1.0 disables)",
    initial: String(params.simCutoff),
  });
  const simTopNRaw = await prompts.input({
    message: "Only compute similarity for top-N by quality (0 = all candidates; slower but full final ranking)",
    initial: String(params.simEvalTopN),
  });
  const movieOverlapPenaltyRaw = await prompts.input({
    message: "Movie-overlap penalty weight (per-category overlap with Movies)",
    initial: String(params.movieOverlapPenaltyWeight),
  });
  const yearProximityPenaltyRaw = await prompts.input({
    message: "Year proximity penalty weight (pairs within 10 years)",
    initial: String(params.yearProximityPenaltyWeight),
  });
  const adjDecadePenaltyRaw = await prompts.input({
    message: "Adjacent decade penalty weight",
    initial: String(params.adjacentDecadePenaltyWeight),
  });
  const adjCenturyPenaltyRaw = await prompts.input({
    message: "Adjacent century penalty weight",
    initial: String(params.adjacentCenturyPenaltyWeight),
  });

  const parseOr = (raw, dflt, parseFn) => {
    const t = String(raw).trim();
    if (t === "") return dflt;
    const v = parseFn(t);
    return Number.isFinite(v) ? v : dflt;
  };

  params.daysLag = Math.max(1, parseOr(daysLagRaw, params.daysLag, (s) => parseInt(s, 10)));
  params.topUsedExclude = Math.max(0, parseOr(topUsedRaw, params.topUsedExclude, (s) => parseInt(s, 10)));
  params.candidatePoolSize = Math.max(1, parseOr(poolRaw, params.candidatePoolSize, (s) => parseInt(s, 10)));
  params.optionsToShow = Math.max(1, parseOr(optionsRaw, params.optionsToShow, (s) => parseInt(s, 10)));
  params.workers = Math.max(1, parseOr(workersRaw, params.workers, (s) => parseInt(s, 10)));
  params.jChunk = Math.max(1, parseOr(jChunkRaw, params.jChunk, (s) => parseInt(s, 10)));
  params.maxSeconds = Math.max(0, parseOr(maxSecRaw, params.maxSeconds, (s) => parseFloat(s)));
  params.minScore = minScoreRaw.trim() === "" ? -Infinity : parseOr(minScoreRaw, params.minScore, (s) => parseFloat(s));
  params.simPenaltyWeight = Math.max(0, parseOr(simPenaltyRaw, params.simPenaltyWeight, (s) => parseFloat(s)));
  params.simCutoff = Math.max(0, Math.min(1, parseOr(simCutoffRaw, params.simCutoff, (s) => parseFloat(s))));
  params.simEvalTopN = Math.max(0, parseOr(simTopNRaw, params.simEvalTopN, (s) => parseInt(s, 10)));
  params.movieOverlapPenaltyWeight = Math.max(
    0,
    parseOr(movieOverlapPenaltyRaw, params.movieOverlapPenaltyWeight, (s) => parseFloat(s))
  );
  params.yearProximityPenaltyWeight = Math.max(
    0,
    parseOr(yearProximityPenaltyRaw, params.yearProximityPenaltyWeight, (s) => parseFloat(s))
  );
  params.adjacentDecadePenaltyWeight = Math.max(
    0,
    parseOr(adjDecadePenaltyRaw, params.adjacentDecadePenaltyWeight, (s) => parseFloat(s))
  );
  params.adjacentCenturyPenaltyWeight = Math.max(
    0,
    parseOr(adjCenturyPenaltyRaw, params.adjacentCenturyPenaltyWeight, (s) => parseFloat(s))
  );

  return params;
}

/*─────────────────────────── SOLVER MAIN THREAD ──────────────────────────*/
async function solveCandidatesInMemory({
  excludedSet,
  candidatePoolSize,
  workers,
  jChunk,
  maxSeconds,
  categoryScores,
  minScore,
}) {
  // Pre-run data updater (reuse existing behavior from full solver)
  // You can skip this for faster iteration / safety via SOLVE_CURATE_SKIP_UPDATE=1
  if (process.env.SOLVE_CURATE_SKIP_UPDATE !== "1") {
    try {
      console.log("Running data update (pre)…");
      const upd = spawnSync("node", ["update_all_data.js"], { cwd: __dirname, stdio: "inherit", encoding: "utf8" });
      if (upd.status !== 0) console.warn("update_all_data.js (pre) exited non-zero");
    } catch (e) {
      console.warn("update_all_data.js (pre) failed:", e.message);
    }
  } else {
    console.log("Skipping data update (pre) due to SOLVE_CURATE_SKIP_UPDATE=1");
  }

  const categoriesJson = readJsonOr(CATS_F, {});
  const allCats = Object.keys(categoriesJson)
    .filter((k) => Array.isArray(categoriesJson[k]) && categoriesJson[k].length >= 4)
    .filter((k) => !excludedSet.has(k))
    .sort();

  if (allCats.length < 8) {
    throw new Error(`Too few allowed categories after exclusions (${allCats.length}).`);
  }
  console.log(`Allowed categories: ${allCats.length} (excluded: ${excludedSet.size})`);

  // Build masks and adjacency (copied from the legacy solver, simplified)
  const wordsJson = readJsonOr(WORDS_F, {});
  const ALL_WORDS = Object.keys(wordsJson);
  const WORD_IDX = new Map(ALL_WORDS.map((w, i) => [w, i]));
  const MASK_LEN = Math.ceil(ALL_WORDS.length / 32);

  const mask = allCats.map((c) => {
    const words = categoriesJson[c] || [];
    const m = new Uint32Array(MASK_LEN);
    for (const w of words) {
      const idx = WORD_IDX.get(w);
      if (idx !== undefined) m[idx >>> 5] |= 1 << (idx & 31);
    }
    return m;
  });

  const intersects = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] & b[i]) return true;
    return false;
  };
  const subset = (a, b) => {
    for (let i = 0; i < a.length; i++) if ((a[i] & ~b[i]) !== 0) return false;
    return true;
  };

  const n = allCats.length;
  const S = Array.from({ length: n }, () => Array(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (subset(mask[i], mask[j]) || subset(mask[j], mask[i])) S[i][j] = S[j][i] = true;
    }
  }

  const A = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!S[i][j] && intersects(mask[i], mask[j])) A[i][j] = A[j][i] = 1;
    }
  }

  // Derive N1/N2 arrays (threshold from env to keep behavior aligned)
  const N2_THRESHOLD = Math.max(1, getEnvInt("SOLVER_N2_THRESHOLD", 4));
  const N1Arr = Array.from({ length: n }, (_, i) => A[i].map((v, idx) => (v ? idx : -1)).filter((x) => x !== -1));

  // N2: sparse count of 2-step paths using N1 (avoids O(n^3) A^2 computation)
  // A2[i][j] = sum_k A[i][k] * A[k][j]
  const N2Arr = Array.from({ length: n }, () => []);
  const counts = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    counts.fill(0);
    const n1 = N1Arr[i];
    for (let a = 0; a < n1.length; a++) {
      const k = n1[a];
      const n1k = N1Arr[k];
      for (let b = 0; b < n1k.length; b++) {
        const j = n1k[b];
        if (j === i) continue;
        // subset pairs are excluded from N2 like in the original solver
        if (S[i][j]) continue;
        // saturation prevents wrap for very high-degree nodes
        if (counts[j] < 65535) counts[j]++;
      }
    }
    const out = [];
    for (let j = 0; j < n; j++) {
      if (counts[j] >= N2_THRESHOLD) out.push(j);
    }
    N2Arr[i] = out;
  }

  // Create shuffled i-order, but generate work lazily in small j-chunks.
  const iValues = [];
  for (let i = 0; i < n - 7; i++) iValues.push(i);
  for (let i = iValues.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [iValues[i], iValues[j]] = [iValues[j], iValues[i]];
  }

  let iPtr = 0;
  let currentISegments = null; // { i, totalJ, nextJStart }
  function nextWorkItem() {
    while (true) {
      if (!currentISegments) {
        if (iPtr >= iValues.length) return null;
        const i = iValues[iPtr++];
        const js = N2Arr[i].filter((j) => j > i);
        if (js.length === 0) continue;
        currentISegments = { i, totalJ: js.length, nextJStart: 0 };
      }
      const { i, totalJ, nextJStart } = currentISegments;
      if (nextJStart >= totalJ) {
        currentISegments = null;
        continue;
      }
      const jStart = nextJStart;
      const jEnd = Math.min(totalJ, jStart + jChunk);
      currentISegments.nextJStart = jEnd;
      return { start: i, end: i + 1, jStart, jEnd, totalJ: jEnd - jStart };
    }
  }

  const wordListHash = sha256(fs.readFileSync(WORDS_F));
  const candidatesByHash = new Map();
  const startedAt = Date.now();
  const deadlineMs = maxSeconds > 0 ? maxSeconds * 1000 : Infinity;
  let stopRequested = false;

  const status = Array.from({ length: workers }, () => ({ found: 0, inFlight: null }));
  let active = workers;

  function shouldStop() {
    if (stopRequested) return true;
    if (candidatesByHash.size >= candidatePoolSize) return true;
    if (Date.now() - startedAt > deadlineMs) return true;
    return false;
  }

  function maybeAccept(p) {
    const all = [...p.rows, ...p.cols];
    const qualityScore = scorePuzzle(all, categoryScores);
    if (qualityScore < minScore) return;
    const hash = p.hash || computePuzzleHash(p.rows, p.cols);
    if (candidatesByHash.has(hash)) return;
    candidatesByHash.set(hash, { ...p, hash, qualityScore });
  }

  console.log(`Launching ${workers} worker(s)… (jChunk=${jChunk}, stop at pool=${candidatePoolSize} or ${maxSeconds}s)`);

  const wObjs = [];
  const workerFile = fileURLToPath(import.meta.url);
  for (let id = 0; id < workers; id++) {
    const w = new Worker(workerFile, {
      workerData: {
        id,
        cats: allCats,
        n,
        wordListHash,
        N1Arr,
        N2Arr,
        writeMode: "memory",
      },
    });
    wObjs.push(w);
    w.on("message", (msg) => {
      if (msg.type === "request_work") {
        status[msg.id].found = msg.found || status[msg.id].found;
        if (shouldStop()) {
          stopRequested = true;
          try {
            w.postMessage({ type: "cleanup" });
          } catch {}
          return;
        }
        const chunk = nextWorkItem();
        if (!chunk) {
          stopRequested = true;
          try {
            w.postMessage({ type: "cleanup" });
          } catch {}
          return;
        }
        status[msg.id].inFlight = chunk;
        w.postMessage({ type: "work", chunk });
      } else if (msg.type === "found_batch") {
        if (Array.isArray(msg.puzzles)) {
          for (const p of msg.puzzles) maybeAccept(p);
        }
        if (DEBUG) console.log(`[main] candidates=${candidatesByHash.size}`);
      } else if (msg.type === "cleanup_done") {
        active--;
        if (active === 0) {
          // done
        }
      } else if (msg.type === "error") {
        console.warn(`Worker ${msg.id} error: ${msg.message}`);
      }
    });
    w.on("error", (e) => console.error("worker error:", e));
  }

  // Kick off initial work for all workers
  for (let id = 0; id < workers; id++) {
    const w = wObjs[id];
    if (shouldStop()) {
      try {
        w.postMessage({ type: "cleanup" });
      } catch {}
      continue;
    }
    const chunk = nextWorkItem();
    if (!chunk) {
      stopRequested = true;
      try {
        w.postMessage({ type: "cleanup" });
      } catch {}
      continue;
    }
    status[id].inFlight = chunk;
    w.postMessage({ type: "work", chunk });
  }

  // Wait until workers cleanup (or we time out and then cleanup)
  while (active > 0) {
    if (!stopRequested && shouldStop()) {
      stopRequested = true;
      for (const w of wObjs) {
        try {
          w.postMessage({ type: "cleanup" });
        } catch {}
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }

  const candidates = Array.from(candidatesByHash.values());
  candidates.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
  console.log(`Found ${candidates.length} candidate puzzle(s) (after score/min-score filters).`);
  return candidates;
}

function writeAiCuratorStateWithPuzzles(puzzles, message) {
  const state = {
    curatedCount: 0,
    attempts: 0,
    phase: "PUZZLE_LIST",
    searchChoice: "solve_and_curate",
    targetCategories: [],
    currentPuzzle: null,
    viableGrid: null,
    chosen: Array.from({ length: 4 }, () => Array(4).fill(null)),
    usedWords: [],
    currentRow: 0,
    currentCol: 0,
    excludedPuzzleHash: null,
    puzzles,
    message,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function mainSolveAndCurate() {
  const params = await getParamsInteractive();

  // Load daily puzzles for secret sauce exclusions
  const dailyDb = loadDailyDb();
  const categoryUsage = buildUsageCounts(dailyDb);
  const recent = getCategoriesFromLastNDays(dailyDb, params.daysLag);
  const topUsed = getTopUsedCategories(categoryUsage, params.topUsedExclude);
  const excluded = new Set([...recent, ...topUsed]);

  if (process.env.SOLVE_CURATE_EXCLUDE_MOVIE_HEAVY === "1") {
    const beforeMovie = excluded.size;
    const meta = readJsonOr(META_CATS_F, {});
    for (const c of meta["Movie Makers"] || []) excluded.add(c);
    const catsJson = readJsonOr(CATS_F, {});
    for (const cat of Object.keys(catsJson)) {
      if (cat === "Movies" || cat.startsWith("Movies featuring ") || cat.startsWith("Movies named ")) {
        excluded.add(cat);
      }
    }
    console.log(
      `\nMovie-heavy filter (SOLVE_CURATE_EXCLUDE_MOVIE_HEAVY=1): +${excluded.size - beforeMovie} categories ` +
        `(Movie Makers + \"Movies\" + Movies featuring/named).`
    );
  }

  console.log("\nSecret-sauce exclusions:");
  console.log(`- Recent (${params.daysLag}d) + always-excluded: ${recent.length}`);
  console.log(`- Top used (${params.topUsedExclude}): ${topUsed.length}`);
  console.log(`- Total excluded: ${excluded.size}`);

  const categoryScores = readJsonOr(CAT_SCORES_F, {});
  const categoriesJson = readJsonOr(CATS_F, {});
  const categoryMovieOverlap = computeCategoryMovieOverlap(categoriesJson);
  const candidates = await solveCandidatesInMemory({
    excludedSet: excluded,
    candidatePoolSize: params.candidatePoolSize,
    workers: params.workers,
    jChunk: params.jChunk,
    maxSeconds: params.maxSeconds,
    categoryScores,
    minScore: params.minScore,
  });

  // Similarity-to-past penalty / cutoff (diversity)
  const simDb = loadCategorySimilarity(DATA_DIR);
  if (!simDb) {
    console.warn("Category similarity file not found/invalid; falling back to exact-match-only similarity.");
  }
  const categorySimFn = simDb ? simDb.categorySimilarity : (a, b) => (a === b ? 1 : 0);
  const pastPuzzles = dailyDb.filter((p) => Array.isArray(p?.rows) && Array.isArray(p?.cols));

  // Score candidates for finalScore (quality − penalties). Default: all candidates (simEvalTopN 0).
  const byQuality = [...candidates].sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0));
  const cap = params.simEvalTopN;
  const toScore =
    !Number.isFinite(cap) || cap <= 0 || cap >= byQuality.length ? byQuality : byQuality.slice(0, cap);
  if (toScore.length < candidates.length) {
    console.log(
      `Similarity scoring: evaluating top ${toScore.length}/${candidates.length} by quality ` +
        `(set SOLVE_CURATE_SIM_EVAL_TOPN=0 to score all for final-only ranking).`
    );
  } else {
    console.log(`Similarity scoring: evaluating all ${candidates.length} candidates for final score.`);
  }

  const scoredCandidates = [];
  let rejectedBySim = 0;
  for (const c of toScore) {
    const allCats = [...c.rows, ...c.cols];
    let maxSim = 0;
    for (const past of pastPuzzles) {
      const s = puzzleCategorySimilarity(c, past, categorySimFn);
      if (s > maxSim) maxSim = s;
      if (maxSim >= 1) break;
    }

    let movieOverlapPenalty = 0;
    for (const cat of allCats) {
      movieOverlapPenalty += params.movieOverlapPenaltyWeight * Number(categoryMovieOverlap[cat] || 0);
    }

    const temporalParts = computeTemporalPenalty(allCats, params);
    const maxSimilarityToPast = Math.round(maxSim * 10000) / 10000;
    const similarityPenalty = params.simPenaltyWeight * maxSimilarityToPast;
    const finalScore =
      (c.qualityScore || 0) - similarityPenalty - movieOverlapPenalty - (temporalParts.temporalPenalty || 0);
    const out = {
      ...c,
      maxSimilarityToPast,
      similarityPenalty,
      movieOverlapPenalty,
      ...temporalParts,
      finalScore,
    };
    if (params.simCutoff < 1 && maxSimilarityToPast >= params.simCutoff) {
      rejectedBySim++;
      continue;
    }
    scoredCandidates.push(out);
  }

  scoredCandidates.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));

  if (!candidates.length) {
    writeAiCuratorStateWithPuzzles([], "Solve-and-curate: no candidates found. Try increasing maxSeconds/poolSize, lowering minScore, or reducing exclusions.");
  } else {
    const topDiversified = diversifiedGreedyOrder(scoredCandidates, Math.min(params.optionsToShow, scoredCandidates.length));
    const msg =
      `Solve-and-curate complete. Found ${candidates.length} candidates; ` +
      (rejectedBySim ? `rejected ${rejectedBySim} for similarity>=${params.simCutoff}; ` : "") +
      `showing ${topDiversified.length} diversified options (highest final score first, then minimal category overlap). ` +
      `Use: node ai_curator.js select <index> to review.`;
    writeAiCuratorStateWithPuzzles(topDiversified, msg);
  }

  // Re-render AI curator output using the existing renderer.
  try {
    spawnSync("node", ["ai_curator.js"], { cwd: __dirname, stdio: "inherit", encoding: "utf8" });
  } catch (e) {
    console.warn("Failed to render ai curator output:", e.message);
  }

  console.log(`\nState written: ${STATE_FILE}`);
  console.log(`Output written: ${OUTPUT_FILE}`);
}

/*─────────────────────────── WORKER THREAD ──────────────────────────*/
async function workerMain() {
  const { id: WID, cats, n, wordListHash, N1Arr, N2Arr, writeMode } = workerData;

  const wordsJson = readJsonOr(WORDS_F, {});
  const categoriesJson = readJsonOr(CATS_F, {});
  const metaCatsJson = readJsonOr(META_CATS_F, {});

  const ALL_WORDS = Object.keys(wordsJson);
  const WORD_IDX = new Map(ALL_WORDS.map((w, i) => [w, i]));
  const MASK_LEN = Math.ceil(ALL_WORDS.length / 32);

  // Build category->meta mapping
  const categoryToMeta = new Map();
  for (const [metaCat, categories] of Object.entries(metaCatsJson)) {
    if (metaCat === "No Meta Category") continue;
    for (const c of categories) categoryToMeta.set(c, metaCat);
  }

  function makeMask(arr) {
    const m = new Uint32Array(MASK_LEN);
    for (const w of arr) {
      const idx = WORD_IDX.get(w);
      if (idx !== undefined) m[idx >>> 5] |= 1 << (idx & 31);
    }
    return m;
  }

  const masks = cats.map((c) => makeMask(categoriesJson[c] || []));

  const rustPathRel = path.join(__dirname, "rust_helper", "target", "release", "cdx_worker");
  const rustPathDbg = path.join(__dirname, "rust_helper", "target", "debug", "cdx_worker");
  const rustPath = fs.existsSync(rustPathRel) ? rustPathRel : (fs.existsSync(rustPathDbg) ? rustPathDbg : null);
  if (!rustPath) throw new Error("Rust inner worker binary not found (cdx_worker). Run: make build");

  let rustProc = null;
  let rustRL = null;
  let currentResolve = null;

  // Batch up Found messages to reduce IPC overhead.
  const BATCH_SIZE = 50;
  let batch = [];
  let found = 0;

  async function flushFound() {
    if (!batch.length) return;
    const puzzles = batch;
    batch = [];
    parentPort.postMessage({ type: "found_batch", id: WID, puzzles });
  }

  async function ensureRust() {
    if (rustProc) return;
    rustProc = spawn(rustPath, [], { stdio: ["pipe", "pipe", "inherit"] });
    rustRL = (await import("readline")).createInterface({ input: rustProc.stdout });
    const metaMap = cats.map((c) => categoryToMeta.get(c) || null);
    const initMsg = {
      type: "Init",
      masks: masks.map((m) => Array.from(m)),
      n1: N1Arr,
      n2: N2Arr,
      categories: cats,
      meta_map: metaMap,
    };
    rustProc.stdin.write(JSON.stringify(initMsg) + "\n");

    let ready = false;
    rustRL.on("line", async (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "Ready") {
        ready = true;
        return;
      }
      if (!ready) return;
      if (msg.type === "Found") {
        const rowsCats = msg.rows.map((v) => cats[v]);
        const colsCats = msg.cols.map((v) => cats[v]);
        const hash = computePuzzleHash(rowsCats, colsCats);
        batch.push({ hash, rows: rowsCats, cols: colsCats, timestamp: null, qualityScore: 0 });
        found++;
        if (batch.length >= BATCH_SIZE) await flushFound();
      } else if (msg.type === "Done") {
        if (currentResolve) {
          const r = currentResolve;
          currentResolve = null;
          r();
        }
      } else if (msg.type === "Error") {
        parentPort.postMessage({ type: "error", id: WID, message: msg.message || "rust error" });
      }
    });

    // Wait for Ready (simple poll)
    const start = Date.now();
    while (!ready) {
      if (Date.now() - start > 10_000) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async function processChunk(chunk) {
    await ensureRust();
    await new Promise((resolve) => {
      currentResolve = resolve;
      rustProc.stdin.write(JSON.stringify({ type: "Work", ...chunk }) + "\n");
    });
    await flushFound();
  }

  parentPort.on("message", async (msg) => {
    if (msg.type === "work") {
      try {
        await processChunk(msg.chunk);
      } catch (e) {
        parentPort.postMessage({ type: "error", id: WID, message: e && e.message ? e.message : String(e) });
      }
      parentPort.postMessage({ type: "request_work", id: WID, found });
    } else if (msg.type === "cleanup") {
      try {
        await flushFound();
      } catch {}
      try {
        if (rustRL) {
          rustRL.removeAllListeners("line");
          rustRL.close();
        }
      } catch {}
      try {
        if (rustProc) rustProc.stdin.end();
      } catch {}
      parentPort.postMessage({ type: "cleanup_done", id: WID, found });
      try {
        if (parentPort && parentPort.close) parentPort.close();
      } catch {}
    }
  });

  // Signal readiness by requesting work
  parentPort.postMessage({ type: "request_work", id: WID, found });
}

if (isMainThread) {
  mainSolveAndCurate().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  workerMain().catch((e) => {
    try {
      parentPort.postMessage({ type: "error", id: workerData?.id, message: e && e.message ? e.message : String(e) });
    } catch {}
    process.exit(1);
  });
}

