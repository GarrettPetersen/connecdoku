/* eslint-disable no-console */
/**
 * similarity.js
 * ------------------------------------------------------------------
 * Category and puzzle similarity utilities.
 *
 * - Category similarity: Jaccard overlap on word sets:
 *     sim(A,B) = |A∩B| / |A∪B|
 *   so diagonal is 1, disjoint is 0, partial overlap is in-between.
 *
 * - Puzzle similarity: best assignment between the 8 categories of each puzzle
 *   (rows+cols), using category similarity. This is transpose-invariant:
 *   if two puzzles have the same set of categories (even with rows/cols swapped),
 *   similarity is 1.
 */

import fs from "fs";
import path from "path";

export const CATEGORY_SIMILARITY_FILENAME = "category_similarity.json";

export function loadJsonOrNull(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Loads the saved category similarity structure produced by update_all_data.js.
 *
 * Expected format:
 * {
 *   metric: "jaccard",
 *   categories: [string...],
 *   neighbors: Array<Array<[number, number]>>,
 *   topKPerCategory: number,
 *   minSimilarity: number
 * }
 */
export function loadCategorySimilarity(dataDir) {
  const fp = path.join(dataDir, CATEGORY_SIMILARITY_FILENAME);
  const obj = loadJsonOrNull(fp);
  if (!obj || !Array.isArray(obj.categories) || !Array.isArray(obj.neighbors)) {
    return null;
  }

  const idx = new Map();
  obj.categories.forEach((c, i) => idx.set(c, i));

  // Build sparse lookup: "i|j" -> sim (store both directions).
  const sim = new Map();
  for (let i = 0; i < obj.neighbors.length; i++) {
    const list = obj.neighbors[i];
    if (!Array.isArray(list)) continue;
    for (const pair of list) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [j, v] = pair;
      if (typeof j !== "number" || typeof v !== "number") continue;
      // Clamp for safety.
      const vv = Math.max(0, Math.min(1, v));
      sim.set(`${i}|${j}`, vv);
      sim.set(`${j}|${i}`, vv);
    }
  }

  const categorySimilarity = (a, b) => {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ia = idx.get(a);
    const ib = idx.get(b);
    if (ia === undefined || ib === undefined) return 0;
    return sim.get(`${ia}|${ib}`) ?? 0;
  };

  return {
    categories: obj.categories,
    index: idx,
    sparse: sim,
    categorySimilarity,
  };
}

/**
 * Max-weight assignment between two equal-sized lists of categories.
 * Uses DP over bitmasks: O(n^2 * 2^n), n=8 for puzzles (fast).
 */
export function maxAssignmentAverage(simMatrix) {
  const n = simMatrix.length;
  if (n === 0) return 0;
  for (const row of simMatrix) {
    if (!Array.isArray(row) || row.length !== n) throw new Error("simMatrix must be square");
  }

  const dp = new Float64Array(1 << n);
  const seen = new Uint8Array(1 << n);
  dp.fill(-1e9);
  dp[0] = 0;
  seen[0] = 1;

  for (let i = 0; i < n; i++) {
    const next = new Float64Array(1 << n);
    next.fill(-1e9);
    const nextSeen = new Uint8Array(1 << n);
    for (let mask = 0; mask < (1 << n); mask++) {
      if (!seen[mask]) continue;
      const base = dp[mask];
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const nm = mask | (1 << j);
        const v = base + simMatrix[i][j];
        if (!nextSeen[nm] || v > next[nm]) {
          next[nm] = v;
          nextSeen[nm] = 1;
        }
      }
    }
    dp.set(next);
    seen.set(nextSeen);
  }

  const best = dp[(1 << n) - 1];
  return Math.max(0, Math.min(1, best / n));
}

/**
 * Puzzle similarity between two puzzles' categories (rows+cols), transpose-invariant.
 * Returns value in [0,1], where 1 means the category sets are identical.
 */
export function puzzleCategorySimilarity(puzA, puzB, categorySimilarityFn) {
  const aCats = [...(puzA.rows || []), ...(puzA.cols || [])];
  const bCats = [...(puzB.rows || []), ...(puzB.cols || [])];
  if (aCats.length !== 8 || bCats.length !== 8) return 0;

  const n = 8;
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    const ai = aCats[i];
    for (let j = 0; j < n; j++) {
      const bj = bCats[j];
      m[i][j] = categorySimilarityFn(ai, bj);
    }
  }
  return maxAssignmentAverage(m);
}

