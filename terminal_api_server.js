#!/usr/bin/env node

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUZZLES_FILE = path.join(__dirname, "daily_puzzles", "puzzles.json");
const START_DATE = new Date("2025-07-21T00:00:00");
const MAX_STRIKES = 5;
const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_STATE_TTL_SECONDS = Number(process.env.TERMINAL_API_STATE_TTL_SECONDS || 3600);
const MAX_STATE_TTL_SECONDS = Number(process.env.TERMINAL_API_MAX_STATE_TTL_SECONDS || 86400);
const TOKEN_SECRET = process.env.TERMINAL_API_SECRET || "dev-insecure-secret-change-me";

const RULES_OVERVIEW = {
  goal: "Find the 8 hidden categories by correctly guessing the 4 members in each of them.",
  actions: [
    "Swap two unlocked tiles.",
    "Guess a row index (0..3) or column index (0..3).",
  ],
  constraints: [
    "Locked tiles cannot be swapped.",
    "If 3 rows are solved, manual row guesses are blocked until columns advance (and vice versa).",
  ],
  scoring: {
    maxStrikes: MAX_STRIKES,
    incorrectGuess: "Adds one strike.",
    win: "All 4 rows and all 4 columns solved.",
    loss: `At ${MAX_STRIKES} strikes.`,
  },
  notes: [
    "The game may reorder the just-solved line to keep the puzzle solvable.",
    "When total solved lines reaches 6, the final row/column are auto-completed if valid.",
  ],
};

function warnIfInsecureSecret() {
  if (TOKEN_SECRET === "dev-insecure-secret-change-me") {
    console.warn("WARNING: TERMINAL_API_SECRET is not set; using insecure dev secret.");
    console.warn("Set TERMINAL_API_SECRET before exposing this API publicly.");
  }
}

function localDayIndexForDate(d) {
  const atMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const startMidnight = new Date(START_DATE.getFullYear(), START_DATE.getMonth(), START_DATE.getDate());
  return Math.floor((atMidnight.getTime() - startMidnight.getTime()) / 86400000);
}

function todayDayIndex() {
  return localDayIndexForDate(new Date());
}

function dateForDayIndex(dayIndex) {
  const d = new Date(START_DATE.getTime() + dayIndex * 86400000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseIsoDate(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function readPuzzles() {
  const raw = fs.readFileSync(PUZZLES_FILE, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("puzzles.json is empty or invalid");
  }
  return data;
}

function wrapIndex(i, n) {
  const m = i % n;
  return m < 0 ? m + n : m;
}

function hashSet(words) {
  return [...words].sort().join("|");
}

function copyGrid(grid) {
  return grid.map((row) => [...row]);
}

function flatten(grid) {
  return grid.flat();
}

function deterministicRng(seedText) {
  const hash = crypto.createHash("sha256").update(seedText).digest();
  let state = hash.readUInt32LE(0);
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledWords(words, seed) {
  const rng = seed ? deterministicRng(seed) : Math.random;
  const arr = [...words];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function allPermutations4() {
  const out = [];
  const a = [0, 1, 2, 3];
  function rec(l) {
    if (l === 4) {
      out.push([...a]);
      return;
    }
    for (let i = l; i < 4; i++) {
      [a[l], a[i]] = [a[i], a[l]];
      rec(l + 1);
      [a[l], a[i]] = [a[i], a[l]];
    }
  }
  rec(0);
  return out;
}

const PERMS = allPermutations4();

function buildLayouts(puzzle) {
  const normal = puzzle.words;
  const transposed = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 4 }, (_, c) => puzzle.words[c][r])
  );
  const layouts = [];
  for (const base of [normal, transposed]) {
    for (const rp of PERMS) {
      for (const cp of PERMS) {
        const g = Array.from({ length: 4 }, (_, r) =>
          Array.from({ length: 4 }, (_, c) => base[rp[r]][cp[c]])
        );
        layouts.push(g);
      }
    }
  }
  return layouts;
}

function lineWords(grid, kind, index) {
  if (kind === "row") return [...grid[index]];
  return [grid[0][index], grid[1][index], grid[2][index], grid[3][index]];
}

function unresolvedIndex(solvedSet) {
  for (let i = 0; i < 4; i++) if (!solvedSet.has(i)) return i;
  return -1;
}

function isSolvedCell(state, r, c) {
  return state.solvedRows.has(r) || state.solvedCols.has(c);
}

function base64urlEncode(bufferOrText) {
  const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText), "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecodeToBuffer(b64url) {
  const pad = b64url.length % 4;
  const normalized = b64url.replace(/-/g, "+").replace(/_/g, "/") + (pad ? "=".repeat(4 - pad) : "");
  return Buffer.from(normalized, "base64");
}

function signTokenPayload(payloadB64) {
  return base64urlEncode(crypto.createHmac("sha256", TOKEN_SECRET).update(payloadB64).digest());
}

function encodeStateToken(payloadObj) {
  const payloadB64 = base64urlEncode(JSON.stringify(payloadObj));
  const sigB64 = signTokenPayload(payloadB64);
  return `${payloadB64}.${sigB64}`;
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function decodeStateToken(token) {
  if (typeof token !== "string") throw new Error("Missing stateToken.");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid token format.");

  const [payloadB64, sigB64] = parts;
  const expectedSig = signTokenPayload(payloadB64);
  if (!timingSafeEqualStr(sigB64, expectedSig)) throw new Error("Invalid token signature.");

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToBuffer(payloadB64).toString("utf8"));
  } catch {
    throw new Error("Invalid token payload.");
  }

  if (!payload || typeof payload !== "object") throw new Error("Token payload must be an object.");
  if (payload.v !== 1) throw new Error("Unsupported token version.");
  if (!Number.isInteger(payload.exp) || Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("Token expired.");
  }

  return payload;
}

function buildPuzzleContext(puzzles, dayIndex, dataIndex) {
  const puzzle = puzzles[dataIndex];
  const ansBySet = new Map();
  for (let r = 0; r < 4; r++) ansBySet.set(hashSet(puzzle.words[r]), puzzle.rows[r]);
  for (let c = 0; c < 4; c++) ansBySet.set(hashSet([puzzle.words[0][c], puzzle.words[1][c], puzzle.words[2][c], puzzle.words[3][c]]), puzzle.cols[c]);
  const allLayouts = buildLayouts(puzzle);

  return {
    puzzle,
    dayIndex,
    dataIndex,
    puzzleDate: dateForDayIndex(dayIndex),
    ansBySet,
    allLayouts,
  };
}

function toMapSolved(arr) {
  const m = new Map();
  if (!Array.isArray(arr)) return m;
  for (const entry of arr) {
    if (!entry || !Number.isInteger(entry.index) || typeof entry.label !== "string") continue;
    m.set(entry.index, {
      label: entry.label,
      strikeLevel: Number.isInteger(entry.strikeLevel) ? entry.strikeLevel : 0,
    });
  }
  return m;
}

function serializeSolvedMap(map) {
  return [...map.entries()].map(([index, v]) => ({
    index,
    label: v.label,
    strikeLevel: Number.isInteger(v.strikeLevel) ? v.strikeLevel : 0,
  }));
}

function runtimeFromPayload(puzzles, payload) {
  if (!Number.isInteger(payload.dayIndex)) throw new Error("Invalid token: dayIndex");
  if (!Number.isInteger(payload.dataIndex)) throw new Error("Invalid token: dataIndex");
  const dataIndex = wrapIndex(payload.dataIndex, puzzles.length);

  const context = buildPuzzleContext(puzzles, payload.dayIndex, dataIndex);

  const grid = payload.board;
  if (!Array.isArray(grid) || grid.length !== 4 || !grid.every((r) => Array.isArray(r) && r.length === 4)) {
    throw new Error("Invalid token: board");
  }

  const solvedRows = toMapSolved(payload.solvedRows);
  const solvedCols = toMapSolved(payload.solvedCols);

  return {
    context,
    grid: copyGrid(grid),
    strikes: Number.isInteger(payload.strikes) ? payload.strikes : 0,
    finished: !!payload.finished,
    outcome: payload.outcome === "won" || payload.outcome === "lost" ? payload.outcome : null,
    solvedRows,
    solvedCols,
    turn: Number.isInteger(payload.turn) ? payload.turn : 0,
    seed: typeof payload.seed === "string" ? payload.seed : null,
  };
}

function payloadFromRuntime(runtime, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(MAX_STATE_TTL_SECONDS, Number.isFinite(ttlSeconds) ? ttlSeconds : DEFAULT_STATE_TTL_SECONDS));

  return {
    v: 1,
    dayIndex: runtime.context.dayIndex,
    dataIndex: runtime.context.dataIndex,
    puzzleDate: runtime.context.puzzleDate,
    board: copyGrid(runtime.grid),
    strikes: runtime.strikes,
    finished: runtime.finished,
    outcome: runtime.outcome,
    solvedRows: serializeSolvedMap(runtime.solvedRows),
    solvedCols: serializeSolvedMap(runtime.solvedCols),
    turn: runtime.turn,
    iat: now,
    exp: now + ttl,
    seed: runtime.seed,
  };
}

function serializePublicState(runtime) {
  const solvedRows = serializeSolvedMap(runtime.solvedRows);
  const solvedCols = serializeSolvedMap(runtime.solvedCols);

  return {
    puzzle: {
      date: runtime.context.puzzleDate,
      dayIndex: runtime.context.dayIndex,
      dataIndex: runtime.context.dataIndex,
      source: "daily",
    },
    board: copyGrid(runtime.grid),
    strikes: runtime.strikes,
    maxStrikes: MAX_STRIKES,
    finished: runtime.finished,
    outcome: runtime.outcome,
    solved: {
      rows: solvedRows,
      cols: solvedCols,
    },
    headers: {
      rows: Array.from({ length: 4 }, (_, i) => runtime.solvedRows.get(i)?.label || null),
      cols: Array.from({ length: 4 }, (_, i) => runtime.solvedCols.get(i)?.label || null),
    },
    rules: {
      canGuessRow: !(runtime.solvedRows.size >= 3 && runtime.solvedCols.size < 4),
      canGuessCol: !(runtime.solvedCols.size >= 3 && runtime.solvedRows.size < 4),
      remainingRows: 4 - runtime.solvedRows.size,
      remainingCols: 4 - runtime.solvedCols.size,
    },
    rulesOverview: RULES_OVERVIEW,
    turn: runtime.turn,
  };
}

function chooseCompatibleLayout(runtime, constraint) {
  const { allLayouts } = runtime.context;
  let best = null;
  let bestScore = Infinity;

  for (const candidate of allLayouts) {
    let valid = true;

    for (let r = 0; r < 4 && valid; r++) {
      for (let c = 0; c < 4 && valid; c++) {
        if (isSolvedCell(runtime, r, c) && runtime.grid[r][c] !== candidate[r][c]) valid = false;
      }
    }
    if (!valid) continue;

    if (constraint) {
      const want = hashSet(constraint.words);
      const got = hashSet(lineWords(candidate, constraint.kind, constraint.index));
      if (want !== got) continue;
    }

    let score = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (isSolvedCell(runtime, r, c)) continue;
        if (runtime.grid[r][c] !== candidate[r][c]) score++;
      }
    }

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      if (score === 0) return best;
    }
  }

  return best;
}

function alignJustSolvedLine(runtime, kind, index, words) {
  const aligned = chooseCompatibleLayout(runtime, { kind, index, words });
  if (!aligned) return;

  if (kind === "row") {
    for (let c = 0; c < 4; c++) {
      // Keep intersections with already-solved columns fixed.
      if (runtime.solvedCols.has(c)) continue;
      runtime.grid[index][c] = aligned[index][c];
    }
    return;
  }

  for (let r = 0; r < 4; r++) {
    // Keep intersections with already-solved rows fixed.
    if (runtime.solvedRows.has(r)) continue;
    runtime.grid[r][index] = aligned[r][index];
  }
}

function guessAllowed(runtime, kind, auto) {
  if (auto) return true;
  if (kind === "row" && runtime.solvedRows.size >= 3 && runtime.solvedCols.size < 4) return false;
  if (kind === "col" && runtime.solvedCols.size >= 3 && runtime.solvedRows.size < 4) return false;
  return true;
}

function applyCorrectGuess(runtime, kind, index, label, auto = false) {
  const words = lineWords(runtime.grid, kind, index);
  const shouldAlign =
    (kind === "row" && runtime.solvedRows.size >= 1) ||
    (kind === "col" && runtime.solvedCols.size >= 1);

  if (shouldAlign) {
    alignJustSolvedLine(runtime, kind, index, words);
  }

  const solved = kind === "row" ? runtime.solvedRows : runtime.solvedCols;
  solved.set(index, { label, strikeLevel: runtime.strikes });

  runAutoSolves(runtime);

  if (runtime.solvedRows.size === 4 && runtime.solvedCols.size === 4) {
    runtime.finished = true;
    runtime.outcome = "won";
  }

  return {
    ok: true,
    correct: true,
    auto,
    solved: { kind, index, label },
  };
}

function runAutoSolves(runtime) {
  if (runtime.finished) return;
  // Match frontend intent: only auto-solve remaining lines when total solved lines hits 6.
  if (runtime.solvedRows.size + runtime.solvedCols.size !== 6) return;

  const rowIdx = unresolvedIndex(runtime.solvedRows);
  const colIdx = unresolvedIndex(runtime.solvedCols);

  if (rowIdx >= 0 && !runtime.solvedRows.has(rowIdx)) {
    const rowWords = lineWords(runtime.grid, "row", rowIdx);
    const rowLabel = runtime.context.ansBySet.get(hashSet(rowWords));
    if (rowLabel) {
      runtime.solvedRows.set(rowIdx, { label: rowLabel, strikeLevel: runtime.strikes });
    }
  }

  if (colIdx >= 0 && !runtime.solvedCols.has(colIdx)) {
    const colWords = lineWords(runtime.grid, "col", colIdx);
    const colLabel = runtime.context.ansBySet.get(hashSet(colWords));
    if (colLabel) {
      runtime.solvedCols.set(colIdx, { label: colLabel, strikeLevel: runtime.strikes });
    }
  }

  if (runtime.solvedRows.size === 4 && runtime.solvedCols.size === 4) {
    runtime.finished = true;
    runtime.outcome = "won";
  }
}

function finalizeLoss(runtime) {
  const target = chooseCompatibleLayout(runtime, null);
  if (target) runtime.grid = copyGrid(target);

  runtime.finished = true;
  runtime.outcome = "lost";

  for (let r = 0; r < 4; r++) {
    if (!runtime.solvedRows.has(r)) {
      const label = runtime.context.ansBySet.get(hashSet(runtime.grid[r])) || runtime.context.puzzle.rows[r];
      runtime.solvedRows.set(r, { label, strikeLevel: runtime.strikes });
    }
  }
  for (let c = 0; c < 4; c++) {
    if (!runtime.solvedCols.has(c)) {
      const words = [runtime.grid[0][c], runtime.grid[1][c], runtime.grid[2][c], runtime.grid[3][c]];
      const label = runtime.context.ansBySet.get(hashSet(words)) || runtime.context.puzzle.cols[c];
      runtime.solvedCols.set(c, { label, strikeLevel: runtime.strikes });
    }
  }
}

function validateBoardWords(runtime) {
  const expected = new Set(flatten(runtime.context.puzzle.words));
  const actual = new Set(flatten(runtime.grid));
  if (expected.size !== 16 || actual.size !== 16) return false;
  for (const w of expected) if (!actual.has(w)) return false;
  return true;
}

function handleSwap(runtime, a, b) {
  if (runtime.finished) return { ok: false, status: 409, error: "Game is already finished." };
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) {
    return { ok: false, status: 400, error: "swap payload must include a and b as [row,col]." };
  }

  const [r1, c1] = a.map((v) => Number(v));
  const [r2, c2] = b.map((v) => Number(v));
  if (![r1, c1, r2, c2].every((v) => Number.isInteger(v) && v >= 0 && v < 4)) {
    return { ok: false, status: 400, error: "row/col indices must be integers in [0,3]." };
  }
  if (r1 === r2 && c1 === c2) return { ok: true, changed: false };

  if (isSolvedCell(runtime, r1, c1) || isSolvedCell(runtime, r2, c2)) {
    return { ok: false, status: 409, error: "Cannot swap a locked tile." };
  }

  [runtime.grid[r1][c1], runtime.grid[r2][c2]] = [runtime.grid[r2][c2], runtime.grid[r1][c1]];
  if (!validateBoardWords(runtime)) return { ok: false, status: 400, error: "Invalid board word set." };

  runtime.turn += 1;
  return { ok: true, changed: true };
}

function handleGuess(runtime, kind, index) {
  if (runtime.finished) return { ok: false, status: 409, error: "Game is already finished." };
  if (kind !== "row" && kind !== "col") return { ok: false, status: 400, error: "kind must be 'row' or 'col'." };
  if (!Number.isInteger(index) || index < 0 || index > 3) return { ok: false, status: 400, error: "index must be an integer from 0 to 3." };

  const solvedSet = kind === "row" ? runtime.solvedRows : runtime.solvedCols;
  if (solvedSet.has(index)) return { ok: false, status: 409, error: `${kind} ${index} is already solved.` };

  if (!guessAllowed(runtime, kind, false)) {
    const mustSolve = kind === "row" ? "column" : "row";
    return { ok: false, status: 409, error: `You must solve a ${mustSolve} now.` };
  }

  const words = lineWords(runtime.grid, kind, index);
  const label = runtime.context.ansBySet.get(hashSet(words));

  runtime.turn += 1;

  if (!label) {
    runtime.strikes += 1;
    if (runtime.strikes >= MAX_STRIKES) {
      finalizeLoss(runtime);
      return { ok: true, correct: false, strikes: runtime.strikes, lost: true };
    }
    return { ok: true, correct: false, strikes: runtime.strikes, lost: false };
  }

  return applyCorrectGuess(runtime, kind, index, label, false);
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function pickPuzzleSelection(body, puzzles) {
  if (Number.isInteger(body.puzzleIndex)) {
    if (body.puzzleIndex < 0 || body.puzzleIndex >= puzzles.length) {
      throw new Error(`puzzleIndex must be between 0 and ${puzzles.length - 1}.`);
    }
    return {
      dayIndex: body.puzzleIndex,
      dataIndex: body.puzzleIndex,
      date: dateForDayIndex(body.puzzleIndex),
    };
  }

  if (body.date !== undefined) {
    const dt = parseIsoDate(body.date);
    if (!dt) throw new Error("Invalid date format. Use YYYY-MM-DD.");
    const dayIndex = localDayIndexForDate(dt);
    if (dayIndex < 0) throw new Error("Requested date is before puzzle epoch.");
    return {
      dayIndex,
      dataIndex: wrapIndex(dayIndex, puzzles.length),
      date: dateForDayIndex(dayIndex),
    };
  }

  const dayIndex = todayDayIndex();
  return {
    dayIndex,
    dataIndex: wrapIndex(dayIndex, puzzles.length),
    date: dateForDayIndex(dayIndex),
  };
}

function tokenResponse(runtime, ttlSeconds) {
  const payload = payloadFromRuntime(runtime, ttlSeconds);
  const token = encodeStateToken(payload);
  return {
    stateToken: token,
    state: serializePublicState(runtime),
  };
}

const puzzles = readPuzzles();
warnIfInsecureSecret();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 204, { ok: true });

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/api/v1/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "connecdoku-terminal-api",
        puzzles: puzzles.length,
        stateless: true,
        now: new Date().toISOString(),
      });
    }

    if (method === "GET" && url.pathname === "/api/v1/rules") {
      return sendJson(res, 200, {
        ok: true,
        rules: RULES_OVERVIEW,
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/play/start") {
      const body = await parseBody(req);
      let selection;
      try {
        selection = pickPuzzleSelection(body, puzzles);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }

      const context = buildPuzzleContext(puzzles, selection.dayIndex, selection.dataIndex);
      const seed = typeof body.seed === "string" && body.seed.length ? body.seed : `${Date.now()}-${Math.random()}`;
      const shuffled = shuffledWords(flatten(context.puzzle.words), seed);
      const grid = Array.from({ length: 4 }, (_, r) => Array.from({ length: 4 }, (_, c) => shuffled[r * 4 + c]));

      const runtime = {
        context,
        grid,
        strikes: 0,
        finished: false,
        outcome: null,
        solvedRows: new Map(),
        solvedCols: new Map(),
        turn: 0,
        seed,
      };

      const ttl = Number.isFinite(Number(body.ttlSeconds)) ? Number(body.ttlSeconds) : DEFAULT_STATE_TTL_SECONDS;
      return sendJson(res, 201, {
        ok: true,
        message: "Game created",
        ...tokenResponse(runtime, ttl),
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/play/state") {
      const body = await parseBody(req);
      let payload;
      try {
        payload = decodeStateToken(body.stateToken);
      } catch (e) {
        return sendJson(res, 401, { ok: false, error: e.message });
      }

      let runtime;
      try {
        runtime = runtimeFromPayload(puzzles, payload);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }

      if (!validateBoardWords(runtime)) {
        return sendJson(res, 400, { ok: false, error: "Invalid board word set." });
      }

      return sendJson(res, 200, { ok: true, ...tokenResponse(runtime, DEFAULT_STATE_TTL_SECONDS) });
    }

    if (method === "POST" && (url.pathname === "/api/v1/play/swap" || url.pathname === "/api/v1/play/guess")) {
      const body = await parseBody(req);
      let payload;
      try {
        payload = decodeStateToken(body.stateToken);
      } catch (e) {
        return sendJson(res, 401, { ok: false, error: e.message });
      }

      let runtime;
      try {
        runtime = runtimeFromPayload(puzzles, payload);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }

      if (!validateBoardWords(runtime)) {
        return sendJson(res, 400, { ok: false, error: "Invalid board word set." });
      }

      const result = url.pathname.endsWith("/swap")
        ? handleSwap(runtime, body.a, body.b)
        : handleGuess(runtime, body.kind, Number(body.index));

      if (!result.ok) {
        return sendJson(res, result.status || 400, result);
      }

      return sendJson(res, 200, {
        ok: true,
        result,
        ...tokenResponse(runtime, DEFAULT_STATE_TTL_SECONDS),
      });
    }

    return sendJson(res, 404, {
      ok: false,
      error: "Not found",
      routes: [
        "GET  /api/v1/health",
        "GET  /api/v1/rules",
        "POST /api/v1/play/start",
        "POST /api/v1/play/state",
        "POST /api/v1/play/swap",
        "POST /api/v1/play/guess",
      ],
    });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
});

server.listen(DEFAULT_PORT, () => {
  console.log(`Connecdoku terminal API listening on http://localhost:${DEFAULT_PORT}`);
  console.log("Routes:");
  console.log("  GET  /api/v1/health");
  console.log("  GET  /api/v1/rules");
  console.log("  POST /api/v1/play/start");
  console.log("  POST /api/v1/play/state");
  console.log("  POST /api/v1/play/swap");
  console.log("  POST /api/v1/play/guess");
});
