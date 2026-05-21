import puzzles from "./daily_puzzles/puzzles.json";

const START_DATE = new Date("2025-07-21T00:00:00");
const MAX_STRIKES = 5;
const DEFAULT_STATE_TTL_SECONDS = 3600;
const MAX_STATE_TTL_SECONDS = 86400;
const DEFAULT_COMPETITION_TOKEN_TTL_SECONDS = 7 * 86400;

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

const encoder = new TextEncoder();
const hmacKeyCache = new Map();

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
  // xmur3 + mulberry32
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const t = (h ^= h >>> 16) >>> 0;
    return t / 4294967296;
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

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textToBase64Url(text) {
  return bytesToBase64Url(encoder.encode(text));
}

function base64UrlToBytes(b64url) {
  const pad = b64url.length % 4;
  const normalized = b64url.replace(/-/g, "+").replace(/_/g, "/") + (pad ? "=".repeat(4 - pad) : "");
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

async function getHmacKey(secret) {
  if (!hmacKeyCache.has(secret)) {
    hmacKeyCache.set(secret, crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    ));
  }
  return hmacKeyCache.get(secret);
}

async function signTokenPayload(payloadB64, secret) {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function encodeStateToken(payloadObj, secret) {
  const payloadB64 = textToBase64Url(JSON.stringify(payloadObj));
  const sigB64 = await signTokenPayload(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

function timingSafeEqualStr(a, b) {
  const aa = String(a);
  const bb = String(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    const ac = i < aa.length ? aa.charCodeAt(i) : 0;
    const bc = i < bb.length ? bb.charCodeAt(i) : 0;
    diff |= ac ^ bc;
  }
  return diff === 0;
}

async function decodeStateToken(token, secret) {
  if (typeof token !== "string") throw new Error("Missing stateToken.");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid token format.");

  const [payloadB64, sigB64] = parts;
  const expectedSig = await signTokenPayload(payloadB64, secret);
  if (!timingSafeEqualStr(sigB64, expectedSig)) throw new Error("Invalid token signature.");

  let payload;
  try {
    payload = JSON.parse(bytesToText(base64UrlToBytes(payloadB64)));
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

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildPuzzleContext(dayIndex, dataIndex) {
  const puzzle = puzzles[dataIndex];
  const ansBySet = new Map();
  for (let r = 0; r < 4; r++) ansBySet.set(hashSet(puzzle.words[r]), puzzle.rows[r]);
  for (let c = 0; c < 4; c++) {
    ansBySet.set(hashSet([puzzle.words[0][c], puzzle.words[1][c], puzzle.words[2][c], puzzle.words[3][c]]), puzzle.cols[c]);
  }
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

function runtimeFromPayload(payload) {
  if (!Number.isInteger(payload.dayIndex)) throw new Error("Invalid token: dayIndex");
  if (!Number.isInteger(payload.dataIndex)) throw new Error("Invalid token: dataIndex");
  const dataIndex = wrapIndex(payload.dataIndex, puzzles.length);

  const context = buildPuzzleContext(payload.dayIndex, dataIndex);

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

function serializePublicState(runtime, options = {}) {
  const competitionMode = options.mode === "competition";
  const competitionToken = typeof options.competitionToken === "string" ? options.competitionToken : null;
  const solvedRows = serializeSolvedMap(runtime.solvedRows);
  const solvedCols = serializeSolvedMap(runtime.solvedCols);
  const canGuessRow = !(runtime.solvedRows.size >= 3 && runtime.solvedCols.size < 4);
  const canGuessCol = !(runtime.solvedCols.size >= 3 && runtime.solvedRows.size < 4);
  const finished = runtime.finished;

  const allowedActions = ["state"];
  if (!finished) {
    allowedActions.push("swap");
    if (canGuessRow) allowedActions.push("guess_row");
    if (canGuessCol) allowedActions.push("guess_col");
  } else {
    allowedActions.push("submit_result");
  }

  const nextActionTemplates = [];
  if (!finished) {
    nextActionTemplates.push(
      {
        action: "swap",
      endpoint: competitionMode ? "/api/v1/competition/swap" : "/api/v1/play/swap",
      method: "POST",
      bodyTemplate: competitionMode
        ? { competitionToken: "<competition-token>", a: [0, 0], b: [0, 1] }
        : { stateToken: "<latest>", a: [0, 0], b: [0, 1] },
    },
    {
      action: "guess_row",
      endpoint: competitionMode ? "/api/v1/competition/guess" : "/api/v1/play/guess",
      method: "POST",
      bodyTemplate: competitionMode
        ? { competitionToken: "<competition-token>", kind: "row", index: 0 }
        : { stateToken: "<latest>", kind: "row", index: 0 },
    },
    {
      action: "guess_col",
      endpoint: competitionMode ? "/api/v1/competition/guess" : "/api/v1/play/guess",
      method: "POST",
      bodyTemplate: competitionMode
        ? { competitionToken: "<competition-token>", kind: "col", index: 0 }
        : { stateToken: "<latest>", kind: "col", index: 0 },
    }
  );
  } else {
    nextActionTemplates.push({
      action: "submit_result",
      endpoint: "/api/v1/competition/submit",
      method: "POST",
      bodyTemplate: competitionMode
        ? { competitionToken: "<competition-token>" }
        : { stateToken: "<latest>", model: "<model-id>", password: "<password>" },
    });
  }

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
      canGuessRow,
      canGuessCol,
      remainingRows: 4 - runtime.solvedRows.size,
      remainingCols: 4 - runtime.solvedCols.size,
    },
    protocol: {
      version: "v1",
      tokenHandling: competitionMode
        ? "Use competitionToken for all competition endpoints; stateToken is informational."
        : "Always use the latest response stateToken for your next API call.",
      goal: RULES_OVERVIEW.goal,
      allowedActions,
      nextActionTemplates,
    },
    competition: competitionMode
      ? {
          mode: true,
          token: competitionToken,
        }
      : null,
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
      if (runtime.solvedCols.has(c)) continue;
      runtime.grid[index][c] = aligned[index][c];
    }
    return;
  }

  for (let r = 0; r < 4; r++) {
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

function envNum(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function tokenSecret(env) {
  return env.TERMINAL_API_SECRET || "dev-insecure-secret-change-me";
}

function disableFuturePuzzles(env) {
  return envBool(env, "TERMINAL_API_DISABLE_FUTURE", true);
}

function sendJson(code, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

async function parseBody(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function pickPuzzleSelection(body, env) {
  const todayIdx = todayDayIndex();

  if (Number.isInteger(body.puzzleIndex)) {
    if (body.puzzleIndex < 0 || body.puzzleIndex >= puzzles.length) {
      throw new Error(`puzzleIndex must be between 0 and ${puzzles.length - 1}.`);
    }
    if (disableFuturePuzzles(env) && body.puzzleIndex > todayIdx) {
      throw new Error("Future puzzles are not available.");
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
    if (disableFuturePuzzles(env) && dayIndex > todayIdx) {
      throw new Error("Future puzzles are not available.");
    }
    return {
      dayIndex,
      dataIndex: wrapIndex(dayIndex, puzzles.length),
      date: dateForDayIndex(dayIndex),
    };
  }

  const dayIndex = todayIdx;
  return {
    dayIndex,
    dataIndex: wrapIndex(dayIndex, puzzles.length),
    date: dateForDayIndex(dayIndex),
  };
}

async function tokenResponse(runtime, env, ttlSeconds) {
  const payload = payloadFromRuntime(runtime, ttlSeconds);
  const token = await encodeStateToken(payload, tokenSecret(env));
  return {
    stateToken: token,
    state: serializePublicState(runtime),
  };
}

async function tokenResponseWithMode(runtime, env, ttlSeconds, options = {}) {
  const payload = payloadFromRuntime(runtime, ttlSeconds);
  const token = await encodeStateToken(payload, tokenSecret(env));
  return {
    stateToken: token,
    state: serializePublicState(runtime, options),
  };
}

function bearerToken(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function requireAdmin(req, env) {
  const required = env.COMPETITION_ADMIN_KEY;
  if (!required) return false;
  const provided = bearerToken(req);
  return provided && timingSafeEqualStr(provided, required);
}

async function competitorHash(env, model, password) {
  const salt = env.COMPETITION_PASSWORD_SALT;
  if (!salt || typeof salt !== "string") throw new Error("Server missing COMPETITION_PASSWORD_SALT.");
  return sha256Hex(`${salt}:${model}:${password}`);
}

async function ensureDb(env) {
  if (!env.DB) throw new Error("DB binding is not configured.");
}

async function registerCompetitor(env, model, password, displayName, active) {
  await ensureDb(env);
  if (!model || typeof model !== "string") throw new Error("model is required.");
  if (!password || typeof password !== "string") throw new Error("password is required.");

  const modelTrim = model.trim();
  if (!/^[A-Za-z0-9_.:-]{2,64}$/.test(modelTrim)) {
    throw new Error("model must match [A-Za-z0-9_.:-]{2,64}");
  }

  const hash = await competitorHash(env, modelTrim, password);
  const nowIso = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO competitors (model, display_name, password_hash, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET
       display_name=excluded.display_name,
       password_hash=excluded.password_hash,
       active=excluded.active,
       updated_at=excluded.updated_at`
  )
    .bind(modelTrim, displayName || modelTrim, hash, active ? 1 : 0, nowIso, nowIso)
    .run();

  return { model: modelTrim, displayName: displayName || modelTrim, active: !!active };
}

async function verifyCompetitor(env, model, password) {
  await ensureDb(env);
  if (!model || !password) return { ok: false, error: "model and password are required." };

  const row = await env.DB.prepare(
    `SELECT model, display_name, password_hash, active FROM competitors WHERE model = ? LIMIT 1`
  )
    .bind(model)
    .first();

  if (!row || Number(row.active) !== 1) {
    return { ok: false, error: "Unknown or inactive competitor." };
  }

  const expected = await competitorHash(env, model, password);
  if (!timingSafeEqualStr(String(row.password_hash || ""), expected)) {
    return { ok: false, error: "Invalid credentials." };
  }

  return { ok: true, competitor: row };
}

function competitionTokenTtlSeconds(env) {
  return envNum(env, "COMPETITION_TOKEN_TTL_SECONDS", DEFAULT_COMPETITION_TOKEN_TTL_SECONDS);
}

async function issueCompetitionToken(env, model, puzzleDate) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(300, Math.min(30 * 86400, competitionTokenTtlSeconds(env)));
  return encodeStateToken(
    {
      v: 1,
      type: "competition",
      model,
      puzzleDate,
      iat: now,
      exp: now + ttl,
    },
    tokenSecret(env)
  );
}

async function decodeCompetitionToken(env, token) {
  const payload = await decodeStateToken(token, tokenSecret(env));
  if (!payload || payload.type !== "competition") {
    throw new Error("Invalid competition token.");
  }
  if (typeof payload.model !== "string" || typeof payload.puzzleDate !== "string") {
    throw new Error("Invalid competition token payload.");
  }
  return payload;
}

function snapshotFromRuntime(runtime) {
  return {
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
    seed: runtime.seed,
  };
}

function runtimeFromSnapshot(snapshot) {
  const runtime = runtimeFromPayload(snapshot);
  if (!validateBoardWords(runtime)) throw new Error("Invalid stored attempt board.");
  return runtime;
}

function attemptFieldsFromRuntime(runtime) {
  return {
    finished: runtime.finished ? 1 : 0,
    outcome: runtime.outcome || null,
    strikes: runtime.strikes,
    turnCount: runtime.turn,
  };
}

async function getCompetitionAttempt(env, model, puzzleDate) {
  return env.DB.prepare(
    `SELECT
      model, puzzle_date, runtime_json, finished, outcome, strikes, turn_count,
      started_at, updated_at, submitted_at
     FROM competition_attempts
     WHERE model = ? AND puzzle_date = ?
     LIMIT 1`
  )
    .bind(model, puzzleDate)
    .first();
}

async function upsertCompetitionAttempt(env, model, puzzleDate, runtime, metadata = {}) {
  const nowIso = new Date().toISOString();
  const fields = attemptFieldsFromRuntime(runtime);
  const runtimeJson = JSON.stringify(snapshotFromRuntime(runtime));
  const startedAt = metadata.startedAt || nowIso;
  const submittedAt = runtime.finished ? (metadata.submittedAt || nowIso) : null;

  await env.DB.prepare(
    `INSERT INTO competition_attempts (
      model, puzzle_date, runtime_json, finished, outcome, strikes, turn_count,
      started_at, updated_at, submitted_at, source_ip, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model, puzzle_date) DO UPDATE SET
      runtime_json=excluded.runtime_json,
      finished=excluded.finished,
      outcome=excluded.outcome,
      strikes=excluded.strikes,
      turn_count=excluded.turn_count,
      updated_at=excluded.updated_at,
      submitted_at=COALESCE(excluded.submitted_at, competition_attempts.submitted_at),
      source_ip=COALESCE(excluded.source_ip, competition_attempts.source_ip),
      user_agent=COALESCE(excluded.user_agent, competition_attempts.user_agent)`
  )
    .bind(
      model,
      puzzleDate,
      runtimeJson,
      fields.finished,
      fields.outcome,
      fields.strikes,
      fields.turnCount,
      startedAt,
      nowIso,
      submittedAt,
      metadata.sourceIp || null,
      metadata.userAgent || null
    )
    .run();
}

async function loadCompetitionRuntime(env, competitionToken) {
  const payload = await decodeCompetitionToken(env, competitionToken);
  const row = await getCompetitionAttempt(env, payload.model, payload.puzzleDate);
  if (!row) throw new Error("No locked attempt found for this model and date. Start with /api/v1/competition/start.");

  let snapshot;
  try {
    snapshot = JSON.parse(row.runtime_json);
  } catch {
    throw new Error("Stored attempt payload is invalid.");
  }

  const runtime = runtimeFromSnapshot(snapshot);
  if (runtime.context.puzzleDate !== payload.puzzleDate) {
    throw new Error("Attempt date mismatch.");
  }

  return { payload, row, runtime };
}

async function competitionStart(req, env, body) {
  await ensureDb(env);

  const verify = await verifyCompetitor(env, body.model, body.password);
  if (!verify.ok) return sendJson(401, { ok: false, error: verify.error });

  let selection;
  try {
    selection = pickPuzzleSelection(body, env);
  } catch (e) {
    return sendJson(400, { ok: false, error: e.message });
  }

  const puzzleDate = selection.date;
  const model = verify.competitor.model;
  const existing = await getCompetitionAttempt(env, model, puzzleDate);
  const competitionToken = await issueCompetitionToken(env, model, puzzleDate);
  const ttl = envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS);

  if (existing) {
    let snapshot;
    try {
      snapshot = JSON.parse(existing.runtime_json);
    } catch {
      return sendJson(500, { ok: false, error: "Stored attempt payload is invalid." });
    }

    let runtime;
    try {
      runtime = runtimeFromSnapshot(snapshot);
    } catch (e) {
      return sendJson(500, { ok: false, error: e.message });
    }

    return sendJson(200, {
      ok: true,
      message: runtime.finished ? "Attempt already complete; resumed completed attempt." : "Existing attempt resumed.",
      lockedAttempt: true,
      model,
      competitionToken,
      ...(await tokenResponseWithMode(runtime, env, ttl, { mode: "competition", competitionToken })),
      attempt: {
        model,
        puzzleDate,
        finished: runtime.finished,
        outcome: runtime.outcome,
        strikes: runtime.strikes,
        turnCount: runtime.turn,
        startedAt: existing.started_at,
        updatedAt: existing.updated_at,
        submittedAt: existing.submitted_at || null,
      },
    });
  }

  const context = buildPuzzleContext(selection.dayIndex, selection.dataIndex);
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

  await upsertCompetitionAttempt(env, model, puzzleDate, runtime, {
    sourceIp: req.headers.get("cf-connecting-ip") || null,
    userAgent: req.headers.get("user-agent") || null,
  });

  const row = await getCompetitionAttempt(env, model, puzzleDate);
  return sendJson(201, {
    ok: true,
    message: "Attempt locked and started.",
    lockedAttempt: true,
    model,
    competitionToken,
    ...(await tokenResponseWithMode(runtime, env, ttl, { mode: "competition", competitionToken })),
    attempt: {
      model,
      puzzleDate,
      finished: false,
      outcome: null,
      strikes: 0,
      turnCount: 0,
      startedAt: row?.started_at || null,
      updatedAt: row?.updated_at || null,
      submittedAt: null,
    },
  });
}

async function competitionState(env, body) {
  const loaded = await loadCompetitionRuntime(env, body.competitionToken);
  const ttl = envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS);
  return sendJson(200, {
    ok: true,
    competitionToken: body.competitionToken,
    ...(await tokenResponseWithMode(loaded.runtime, env, ttl, { mode: "competition", competitionToken: body.competitionToken })),
    attempt: {
      model: loaded.payload.model,
      puzzleDate: loaded.payload.puzzleDate,
      finished: !!loaded.runtime.finished,
      outcome: loaded.runtime.outcome,
      strikes: loaded.runtime.strikes,
      turnCount: loaded.runtime.turn,
      startedAt: loaded.row.started_at,
      updatedAt: loaded.row.updated_at,
      submittedAt: loaded.row.submitted_at || null,
    },
  });
}

async function competitionSwap(req, env, body) {
  const loaded = await loadCompetitionRuntime(env, body.competitionToken);
  if (loaded.runtime.finished) return sendJson(409, { ok: false, error: "Game is already finished." });

  const result = handleSwap(loaded.runtime, body.a, body.b);
  if (!result.ok) return sendJson(result.status || 400, result);

  await upsertCompetitionAttempt(env, loaded.payload.model, loaded.payload.puzzleDate, loaded.runtime, {
    sourceIp: req.headers.get("cf-connecting-ip") || null,
    userAgent: req.headers.get("user-agent") || null,
  });

  const ttl = envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS);
  return sendJson(200, {
    ok: true,
    result,
    competitionToken: body.competitionToken,
    ...(await tokenResponseWithMode(loaded.runtime, env, ttl, { mode: "competition", competitionToken: body.competitionToken })),
  });
}

async function competitionGuess(req, env, body) {
  const loaded = await loadCompetitionRuntime(env, body.competitionToken);
  if (loaded.runtime.finished) return sendJson(409, { ok: false, error: "Game is already finished." });

  const result = handleGuess(loaded.runtime, body.kind, Number(body.index));
  if (!result.ok) return sendJson(result.status || 400, result);

  await upsertCompetitionAttempt(env, loaded.payload.model, loaded.payload.puzzleDate, loaded.runtime, {
    sourceIp: req.headers.get("cf-connecting-ip") || null,
    userAgent: req.headers.get("user-agent") || null,
    submittedAt: loaded.runtime.finished ? new Date().toISOString() : null,
  });

  const ttl = envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS);
  return sendJson(200, {
    ok: true,
    result,
    competitionToken: body.competitionToken,
    ...(await tokenResponseWithMode(loaded.runtime, env, ttl, { mode: "competition", competitionToken: body.competitionToken })),
  });
}

async function submitCompetitionResult(req, env, body) {
  await ensureDb(env);

  if (!body || typeof body.competitionToken !== "string" || !body.competitionToken.trim()) {
    return sendJson(400, {
      ok: false,
      error: "competitionToken is required. Start with /api/v1/competition/start using model+password.",
    });
  }

  let loaded;
  try {
    loaded = await loadCompetitionRuntime(env, body.competitionToken);
  } catch (e) {
    return sendJson(401, { ok: false, error: e.message });
  }

  const runtime = loaded.runtime;

  if (!validateBoardWords(runtime)) {
    return sendJson(400, { ok: false, error: "Invalid board word set." });
  }

  if (!runtime.finished) {
    return sendJson(409, { ok: false, error: "Game must be finished before submission." });
  }

  const puzzleDate = runtime.context.puzzleDate;
  const totalSolved = runtime.solvedRows.size + runtime.solvedCols.size;
  const nowIso = new Date().toISOString();
  const solvedDetail = {
    rows: Array.from({ length: 4 }, (_, index) => {
      const row = runtime.solvedRows.get(index);
      return row ? { index, label: row.label, strikeLevel: row.strikeLevel } : null;
    }),
    cols: Array.from({ length: 4 }, (_, index) => {
      const col = runtime.solvedCols.get(index);
      return col ? { index, label: col.label, strikeLevel: col.strikeLevel } : null;
    }),
  };
  const solvedDetailJson = JSON.stringify(solvedDetail);

  await env.DB.prepare(
    `INSERT INTO competition_results (
      model, puzzle_date, outcome, strikes, turn_count,
      solved_rows, solved_cols, solved_lines_total,
      solved_detail_json,
      submitted_at, source_ip, user_agent, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model, puzzle_date) DO UPDATE SET
      outcome=excluded.outcome,
      strikes=excluded.strikes,
      turn_count=excluded.turn_count,
      solved_rows=excluded.solved_rows,
      solved_cols=excluded.solved_cols,
      solved_lines_total=excluded.solved_lines_total,
      solved_detail_json=excluded.solved_detail_json,
      submitted_at=excluded.submitted_at,
      source_ip=excluded.source_ip,
      user_agent=excluded.user_agent,
      notes=excluded.notes`
  )
    .bind(
      loaded.payload.model,
      puzzleDate,
      runtime.outcome,
      runtime.strikes,
      runtime.turn,
      runtime.solvedRows.size,
      runtime.solvedCols.size,
      totalSolved,
      solvedDetailJson,
      nowIso,
      req.headers.get("cf-connecting-ip") || null,
      req.headers.get("user-agent") || null,
      typeof body.notes === "string" ? body.notes.slice(0, 500) : null
    )
    .run();

  const row = await env.DB.prepare(
    `SELECT id, model, puzzle_date, outcome, strikes, turn_count, solved_detail_json, notes, submitted_at
     FROM competition_results
     WHERE model = ? AND puzzle_date = ?
     LIMIT 1`
  )
    .bind(loaded.payload.model, puzzleDate)
    .first();

  await upsertCompetitionAttempt(env, loaded.payload.model, puzzleDate, runtime, {
    sourceIp: req.headers.get("cf-connecting-ip") || null,
    userAgent: req.headers.get("user-agent") || null,
    submittedAt: nowIso,
  });

  return sendJson(200, {
    ok: true,
    message: "Result submitted.",
    result: {
      ...row,
      solved_detail: row?.solved_detail_json ? JSON.parse(row.solved_detail_json) : null,
      comment: row?.notes || null,
    },
  });
}

async function leaderboard(env, url) {
  await ensureDb(env);
  const limitRaw = Number(url.searchParams.get("limit") || 50);
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));

  const rows = await env.DB.prepare(
    `SELECT
      r.model,
      COALESCE(c.display_name, r.model) AS display_name,
      COUNT(*) AS attempts,
      SUM(CASE WHEN r.outcome = 'won' THEN 1 ELSE 0 END) AS wins,
      AVG(CASE WHEN r.outcome = 'won' THEN r.strikes ELSE NULL END) AS avg_win_strikes,
      MAX(r.puzzle_date) AS last_puzzle_date,
      (
        SELECT cr.notes
        FROM competition_results cr
        WHERE cr.model = r.model
        ORDER BY cr.puzzle_date DESC, cr.submitted_at DESC
        LIMIT 1
      ) AS latest_comment
     FROM competition_results r
     LEFT JOIN competitors c ON c.model = r.model
     GROUP BY r.model
     ORDER BY wins DESC, attempts DESC, r.model ASC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return sendJson(200, {
    ok: true,
    leaderboard: rows.results || [],
  });
}

async function benchmarkData(env, url) {
  await ensureDb(env);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const hasFrom = typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from);
  const hasTo = typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to);

  let whereClause = "";
  const whereParams = [];
  if (hasFrom && hasTo) {
    whereClause = "WHERE r.puzzle_date BETWEEN ? AND ?";
    whereParams.push(from, to);
  } else if (hasFrom) {
    whereClause = "WHERE r.puzzle_date >= ?";
    whereParams.push(from);
  } else if (hasTo) {
    whereClause = "WHERE r.puzzle_date <= ?";
    whereParams.push(to);
  }

  const modelRows = await env.DB.prepare(
    `SELECT model, display_name, active
     FROM competitors
     WHERE active = 1
     ORDER BY display_name ASC`
  ).all();

  const resultQuery = `
    SELECT
      r.puzzle_date,
      r.model,
      COALESCE(c.display_name, r.model) AS display_name,
      r.outcome,
      r.strikes,
      r.turn_count,
      r.notes,
      r.submitted_at
    FROM competition_results r
    LEFT JOIN competitors c ON c.model = r.model
    ${whereClause}
    ORDER BY r.puzzle_date DESC, display_name ASC
  `;

  const resultStmt = env.DB.prepare(resultQuery);
  const resultRows = whereParams.length ? await resultStmt.bind(...whereParams).all() : await resultStmt.all();

  const dateRows = await (whereParams.length
    ? env.DB.prepare(
        `SELECT DISTINCT r.puzzle_date
         FROM competition_results r
         ${whereClause}
         ORDER BY r.puzzle_date DESC`
      )
        .bind(...whereParams)
        .all()
    : env.DB.prepare(
        `SELECT DISTINCT r.puzzle_date
         FROM competition_results r
         ORDER BY r.puzzle_date DESC`
      ).all());

  const leaderboardQuery = `
    SELECT
      r.model,
      COALESCE(c.display_name, r.model) AS display_name,
      COUNT(*) AS attempts,
      SUM(CASE WHEN r.outcome = 'won' THEN 1 ELSE 0 END) AS wins,
      AVG(r.strikes) AS avg_strikes,
      AVG(CASE WHEN r.outcome = 'won' THEN r.strikes ELSE NULL END) AS avg_win_strikes
    FROM competition_results r
    LEFT JOIN competitors c ON c.model = r.model
    ${whereClause}
    GROUP BY r.model
    ORDER BY avg_strikes ASC, attempts DESC, display_name ASC
  `;
  const leaderboardStmt = env.DB.prepare(leaderboardQuery);
  const leaderboardRows = whereParams.length ? await leaderboardStmt.bind(...whereParams).all() : await leaderboardStmt.all();

  return sendJson(200, {
    ok: true,
    models: modelRows.results || [],
    dates: (dateRows.results || []).map((d) => d.puzzle_date),
    results: resultRows.results || [],
    leaderboard: leaderboardRows.results || [],
  });
}

async function deleteCompetitionResult(env, body) {
  await ensureDb(env);

  let deleted = 0;
  if (Number.isInteger(body.id)) {
    const resp = await env.DB.prepare(`DELETE FROM competition_results WHERE id = ?`).bind(body.id).run();
    deleted = Number(resp.meta?.changes || 0);
  } else if (typeof body.model === "string" && typeof body.puzzleDate === "string") {
    const resp = await env.DB.prepare(`DELETE FROM competition_results WHERE model = ? AND puzzle_date = ?`)
      .bind(body.model, body.puzzleDate)
      .run();
    deleted = Number(resp.meta?.changes || 0);
  } else {
    throw new Error("Provide id OR model+puzzleDate.");
  }

  return { ok: true, deleted };
}

async function routeRequest(req, env) {
  try {
    if (req.method === "OPTIONS") return sendJson(204, { ok: true });

    const url = new URL(req.url);
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/api/v1/health") {
      return sendJson(200, {
        ok: true,
        service: "connecdoku-terminal-api-worker",
        puzzles: puzzles.length,
        statelessPlay: true,
        competitionStateful: true,
        now: new Date().toISOString(),
      });
    }

    if (method === "GET" && url.pathname === "/api/v1/rules") {
      return sendJson(200, {
        ok: true,
        rules: RULES_OVERVIEW,
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/play/start") {
      const body = await parseBody(req);
      let selection;
      try {
        selection = pickPuzzleSelection(body, env);
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }

      const context = buildPuzzleContext(selection.dayIndex, selection.dataIndex);
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

      const ttl = Number.isFinite(Number(body.ttlSeconds)) ? Number(body.ttlSeconds) : envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS);
      return sendJson(201, {
        ok: true,
        message: "Game created",
        ...(await tokenResponse(runtime, env, ttl)),
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/play/state") {
      const body = await parseBody(req);
      let payload;
      try {
        payload = await decodeStateToken(body.stateToken, tokenSecret(env));
      } catch (e) {
        return sendJson(401, { ok: false, error: e.message });
      }

      let runtime;
      try {
        runtime = runtimeFromPayload(payload);
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }

      if (!validateBoardWords(runtime)) {
        return sendJson(400, { ok: false, error: "Invalid board word set." });
      }

      return sendJson(200, { ok: true, ...(await tokenResponse(runtime, env, envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS))) });
    }

    if (method === "POST" && (url.pathname === "/api/v1/play/swap" || url.pathname === "/api/v1/play/guess")) {
      const body = await parseBody(req);
      let payload;
      try {
        payload = await decodeStateToken(body.stateToken, tokenSecret(env));
      } catch (e) {
        return sendJson(401, { ok: false, error: e.message });
      }

      let runtime;
      try {
        runtime = runtimeFromPayload(payload);
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }

      if (!validateBoardWords(runtime)) {
        return sendJson(400, { ok: false, error: "Invalid board word set." });
      }

      const result = url.pathname.endsWith("/swap")
        ? handleSwap(runtime, body.a, body.b)
        : handleGuess(runtime, body.kind, Number(body.index));

      if (!result.ok) {
        return sendJson(result.status || 400, result);
      }

      return sendJson(200, {
        ok: true,
        result,
        ...(await tokenResponse(runtime, env, envNum(env, "TERMINAL_API_STATE_TTL_SECONDS", DEFAULT_STATE_TTL_SECONDS))),
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/register") {
      if (!requireAdmin(req, env)) return sendJson(403, { ok: false, error: "Forbidden." });
      const body = await parseBody(req);
      try {
        const competitor = await registerCompetitor(env, body.model, body.password, body.displayName, body.active !== false);
        return sendJson(200, { ok: true, competitor });
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/start") {
      const body = await parseBody(req);
      return competitionStart(req, env, body);
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/state") {
      const body = await parseBody(req);
      if (!body || typeof body.competitionToken !== "string") {
        return sendJson(400, { ok: false, error: "competitionToken is required." });
      }
      try {
        return await competitionState(env, body);
      } catch (e) {
        return sendJson(401, { ok: false, error: e.message });
      }
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/swap") {
      const body = await parseBody(req);
      if (!body || typeof body.competitionToken !== "string") {
        return sendJson(400, { ok: false, error: "competitionToken is required." });
      }
      try {
        return await competitionSwap(req, env, body);
      } catch (e) {
        return sendJson(401, { ok: false, error: e.message });
      }
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/guess") {
      const body = await parseBody(req);
      if (!body || typeof body.competitionToken !== "string") {
        return sendJson(400, { ok: false, error: "competitionToken is required." });
      }
      try {
        return await competitionGuess(req, env, body);
      } catch (e) {
        return sendJson(401, { ok: false, error: e.message });
      }
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/submit") {
      const body = await parseBody(req);
      return submitCompetitionResult(req, env, body);
    }

    if (method === "GET" && url.pathname === "/api/v1/competition/leaderboard") {
      return leaderboard(env, url);
    }

    if (method === "GET" && url.pathname === "/api/v1/competition/benchmark") {
      return benchmarkData(env, url);
    }

    if (method === "POST" && url.pathname === "/api/v1/competition/delete-result") {
      if (!requireAdmin(req, env)) return sendJson(403, { ok: false, error: "Forbidden." });
      const body = await parseBody(req);
      try {
        return sendJson(200, await deleteCompetitionResult(env, body));
      } catch (e) {
        return sendJson(400, { ok: false, error: e.message });
      }
    }

    return sendJson(404, {
      ok: false,
      error: "Not found",
      routes: [
        "GET  /api/v1/health",
        "GET  /api/v1/rules",
        "POST /api/v1/play/start",
        "POST /api/v1/play/state",
        "POST /api/v1/play/swap",
        "POST /api/v1/play/guess",
        "POST /api/v1/competition/register",
        "POST /api/v1/competition/start",
        "POST /api/v1/competition/state",
        "POST /api/v1/competition/swap",
        "POST /api/v1/competition/guess",
        "POST /api/v1/competition/submit",
        "GET  /api/v1/competition/leaderboard",
        "GET  /api/v1/competition/benchmark",
        "POST /api/v1/competition/delete-result",
      ],
    });
  } catch (e) {
    return sendJson(500, { ok: false, error: e.message || String(e) });
  }
}

export default {
  async fetch(req, env) {
    return routeRequest(req, env);
  },
};
