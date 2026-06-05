#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";

const rawArgs = process.argv.slice(2);

function parseArgs(argv) {
  const out = { flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.flags[key] = next;
      i++;
    } else {
      out.flags[key] = true;
    }
  }
  return out;
}

const parsed = parseArgs(rawArgs);
const flags = parsed.flags;
const positionals = parsed.positionals;

function flag(name, fallback = null) {
  return Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : fallback;
}

function hasFlag(name) {
  return Object.prototype.hasOwnProperty.call(flags, name);
}

const API_BASE = String(flag("api", process.env.CONNECDOKU_API || "https://connecdoku.com")).replace(/\/+$/, "");
const DATE = flag("date", null);
const INDEX_RAW = flag("index", null);
const SEED = flag("seed", null);
const COMMAND = (positionals[0] || "play").toLowerCase();
const HAS_EXPLICIT_START_OPTIONS = DATE !== null || INDEX_RAW !== null || SEED !== null;

function resolveStatsDir() {
  const explicit = process.env.CONNECDOKU_STATS_DIR;
  if (explicit) return path.resolve(explicit);
  const preferred = path.join(os.homedir(), ".connecdoku");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return path.resolve(".connecdoku");
  }
}

const STATS_DIR = resolveStatsDir();
const STATS_FILE = path.join(STATS_DIR, "terminal_stats.json");
const SESSION_FILE = path.join(STATS_DIR, "terminal_session.json");

function localDateString(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateString(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function nextDateString(s) {
  const dt = parseDateString(s);
  if (!dt) return null;
  dt.setDate(dt.getDate() + 1);
  return localDateString(dt);
}

function daysBetween(aStr, bStr) {
  const a = parseDateString(aStr);
  const b = parseDateString(bStr);
  if (!a || !b) return null;
  const am = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const bm = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.floor((bm - am) / 86400000);
}

function ensureStatsDir() {
  fs.mkdirSync(STATS_DIR, { recursive: true });
}

function loadStats() {
  ensureStatsDir();
  if (!fs.existsSync(STATS_FILE)) return { games: {} };
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    if (!data || typeof data !== "object" || typeof data.games !== "object" || data.games === null) {
      return { games: {} };
    }
    return data;
  } catch {
    return { games: {} };
  }
}

function saveStats(stats) {
  ensureStatsDir();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function loadSessions() {
  ensureStatsDir();
  if (!fs.existsSync(SESSION_FILE)) return { byApi: {} };
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    if (!data || typeof data !== "object" || typeof data.byApi !== "object" || data.byApi === null) {
      return { byApi: {} };
    }
    return data;
  } catch {
    return { byApi: {} };
  }
}

function saveSessions(data) {
  ensureStatsDir();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

function loadSessionForApi(apiBase) {
  const all = loadSessions();
  return all.byApi?.[apiBase] || null;
}

function saveSessionForApi(apiBase, stateToken, state) {
  const all = loadSessions();
  if (!all.byApi || typeof all.byApi !== "object") all.byApi = {};
  all.byApi[apiBase] = {
    stateToken,
    puzzleDate: state?.puzzle?.date || null,
    finished: !!state?.finished,
    updatedAt: new Date().toISOString(),
  };
  saveSessions(all);
}

function clearSessionForApi(apiBase) {
  const all = loadSessions();
  if (all.byApi && Object.prototype.hasOwnProperty.call(all.byApi, apiBase)) {
    delete all.byApi[apiBase];
    saveSessions(all);
  }
}

function deriveStats(stats) {
  const games = stats.games || {};
  const dates = Object.keys(games).sort();
  const totalGames = dates.length;
  const totalWins = dates.filter((d) => !!games[d].won).length;

  let currentWinStreak = 0;
  let longestWinStreak = 0;
  let rollingWin = 0;
  let prevDate = null;

  let currentAttemptStreak = 0;
  let longestAttemptStreak = 0;
  let rollingAttempt = 0;

  for (const d of dates) {
    const result = games[d];
    const contiguous = prevDate ? daysBetween(prevDate, d) === 1 : true;

    if (!contiguous) {
      rollingWin = 0;
      rollingAttempt = 0;
    }

    rollingAttempt += 1;
    if (rollingAttempt > longestAttemptStreak) longestAttemptStreak = rollingAttempt;

    if (result.won) {
      rollingWin += 1;
      if (rollingWin > longestWinStreak) longestWinStreak = rollingWin;
    } else {
      rollingWin = 0;
    }

    prevDate = d;
  }

  if (dates.length) {
    const lastDate = dates[dates.length - 1];
    currentWinStreak = games[lastDate].won ? rollingTailWinStreak(games, lastDate) : 0;
    currentAttemptStreak = rollingTailAttemptStreak(games, lastDate);
  }

  return {
    totalGames,
    totalWins,
    winRate: totalGames ? totalWins / totalGames : 0,
    currentWinStreak,
    longestWinStreak,
    currentAttemptStreak,
    longestAttemptStreak,
  };
}

function rollingTailAttemptStreak(games, tailDate) {
  let streak = 0;
  let cursor = tailDate;
  while (games[cursor]) {
    streak++;
    const prev = nextDateString(cursor);
    if (!prev) break;
    const prevDateObj = parseDateString(cursor);
    prevDateObj.setDate(prevDateObj.getDate() - 1);
    const prevStr = localDateString(prevDateObj);
    if (!games[prevStr]) break;
    cursor = prevStr;
  }
  return streak;
}

function rollingTailWinStreak(games, tailDate) {
  let streak = 0;
  let cursor = tailDate;
  while (games[cursor] && games[cursor].won) {
    streak++;
    const prevDateObj = parseDateString(cursor);
    prevDateObj.setDate(prevDateObj.getDate() - 1);
    const prevStr = localDateString(prevDateObj);
    if (!games[prevStr] || !games[prevStr].won) break;
    cursor = prevStr;
  }
  return streak;
}

function recordFinishedGame(state) {
  if (!state || !state.finished) return { saved: false, reason: "not-finished" };
  const date = state?.puzzle?.date;
  if (typeof date !== "string") return { saved: false, reason: "missing-date" };

  const stats = loadStats();
  if (stats.games[date]) {
    return { saved: false, reason: "already-recorded", stats: deriveStats(stats) };
  }

  stats.games[date] = {
    won: state.outcome === "won",
    strikes: Number(state.strikes || 0),
    completedAt: new Date().toISOString(),
  };
  saveStats(stats);

  return { saved: true, date, stats: deriveStats(stats) };
}

async function api(pathname, body) {
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach API at ${API_BASE}. If this is the public endpoint, it may not be deployed yet. Try again later or pass --api to a reachable endpoint.`
    );
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const msg = json.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function apiGet(pathname) {
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    throw new Error(
      `Cannot reach API at ${API_BASE}. If this is the public endpoint, it may not be deployed yet. Try again later or pass --api to a reachable endpoint.`
    );
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const msg = json.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function parseCoord(str) {
  if (typeof str !== "string") return null;
  const m = str.match(/^(\d),(\d)$/);
  if (!m) return null;
  const r = Number(m[1]);
  const c = Number(m[2]);
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 3 || c < 0 || c > 3) return null;
  return [r, c];
}

function printBoard(s) {
  const b = s.board;
  const solvedRows = new Set((s.solved.rows || []).map((x) => x.index));
  const solvedCols = new Set((s.solved.cols || []).map((x) => x.index));

  const sep = "+----------------------+----------------------+----------------------+----------------------+";
  console.log(`\nPuzzle ${s.puzzle.date}  Strikes ${s.strikes}/${s.maxStrikes}  Turn ${s.turn}`);
  console.log(`Rows solved: ${s.solved.rows.length}/4 | Cols solved: ${s.solved.cols.length}/4`);
  console.log(sep);
  for (let r = 0; r < 4; r++) {
    const rowLabel = s.headers.rows[r] ? ` [ROW ${r} ✓ ${s.headers.rows[r]}]` : "";
    const cells = [];
    for (let c = 0; c < 4; c++) {
      const lock = solvedRows.has(r) || solvedCols.has(c) ? "*" : " ";
      const text = `${lock}[${r},${c}] ${String(b[r][c])}`;
      cells.push(text.padEnd(22));
    }
    console.log(`|${cells.map((x) => ` ${x}`).join("|")}|${rowLabel}`);
    console.log(sep);
  }

  const colLabels = Array.from({ length: 4 }, (_, c) =>
    s.headers.cols[c] ? `[COL ${c} ✓ ${s.headers.cols[c]}]` : `[COL ${c}]`
  );
  console.log(colLabels.join("  "));

  if (!s.rules.canGuessRow) console.log("Rule: row guesses are blocked until columns advance. Swaps between unlocked tiles are still allowed.");
  if (!s.rules.canGuessCol) console.log("Rule: column guesses are blocked until rows advance. Swaps between unlocked tiles are still allowed.");

  if (s.finished) {
    console.log(`\nGame over: ${String(s.outcome || "unknown").toUpperCase()}`);
    const rec = recordFinishedGame(s);
    if (rec.saved) {
      console.log(`Recorded result for ${rec.date}.`);
      console.log(`Win streak: ${rec.stats.currentWinStreak} (best ${rec.stats.longestWinStreak})`);
      console.log(`Attempt streak: ${rec.stats.currentAttemptStreak} (best ${rec.stats.longestAttemptStreak})`);
    }
  }
}

function printStats() {
  const stats = loadStats();
  const d = deriveStats(stats);
  console.log("\nTerminal Stats");
  console.log(`Results file: ${STATS_FILE}`);
  console.log(`Games: ${d.totalGames}`);
  console.log(`Wins: ${d.totalWins}`);
  console.log(`Win rate: ${(d.winRate * 100).toFixed(1)}%`);
  console.log(`Current win streak: ${d.currentWinStreak}`);
  console.log(`Longest win streak: ${d.longestWinStreak}`);
  console.log(`Current attempt streak: ${d.currentAttemptStreak}`);
  console.log(`Longest attempt streak: ${d.longestAttemptStreak}`);
}

function printHelp() {
  console.log(`\nCommands:\n  swap r1 c1 r2 c2               Swap two tiles\n  guess row i                    Guess row i (0..3)\n  guess col i                    Guess column i (0..3)\n  state                          Refresh and print board\n  rules                          Show basic gameplay rules\n  token                          Print current token(s)\n  stats                          Show local streak stats\n  auth MODEL PASS                Lock/resume competition attempt for today (or --date)\n  submit [COMMENT...]            Submit finished result (requires auth/competition mode)\n  leaderboard [N]                Show competition leaderboard (default 20)\n  next                           Load next daily puzzle if available (after local midnight)\n  help                           Show commands\n  quit                           Exit\n`);
}

function printRulesOverview() {
  console.log("\nBasic Rules");
  console.log("- Goal: Find the 8 hidden categories by correctly guessing the 4 members in each of them.");
  console.log("- You see 16 words; category names are hidden.");
  console.log("- Swap two unlocked tiles with: swap r1 c1 r2 c2");
  console.log("- Guess a full row/column category with: guess row i / guess col i");
  console.log("- Correct guess locks that line; wrong guess adds a strike.");
  console.log("- At 5 strikes, you lose.");
  console.log("- If 3 rows are solved, row guesses are blocked until columns advance (and vice versa). Swaps between unlocked tiles are still allowed.");
  console.log("- The game may reorder the just-solved line to keep the puzzle solvable.");
}

function startBodyFromFlags(defaultToLocalDate = true) {
  const body = {};
  if (DATE) body.date = DATE;
  if (INDEX_RAW !== null) {
    const idx = Number(INDEX_RAW);
    if (!Number.isInteger(idx)) throw new Error("--index must be an integer");
    body.puzzleIndex = idx;
  }
  if (SEED) body.seed = SEED;

  if (!Object.prototype.hasOwnProperty.call(body, "date") && !Object.prototype.hasOwnProperty.call(body, "puzzleIndex") && defaultToLocalDate) {
    body.date = localDateString();
  }
  return body;
}

async function runOneShot() {
  if (COMMAND === "stats") {
    const stats = loadStats();
    const derived = deriveStats(stats);
    console.log(JSON.stringify({ file: STATS_FILE, games: stats.games, derived }, null, 2));
    return;
  }

  if (COMMAND === "start") {
    const model = String(flag("model", "")).trim();
    const password = String(flag("password", "")).trim();
    const startBody = startBodyFromFlags(true);
    const resp = model || password
      ? await api("/api/v1/competition/start", { ...startBody, model, password })
      : await api("/api/v1/play/start", startBody);
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  const token = flag("token", null);
  const competitionToken = flag("competition-token", null);
  const competitionModel = String(flag("model", "")).trim();
  const competitionPassword = String(flag("password", "")).trim();

  function hasCompetitionCreds() {
    return !!competitionModel && !!competitionPassword;
  }

  async function resolveCompetitionToken() {
    if (competitionToken) return competitionToken;
    if (!hasCompetitionCreds()) return null;

    const startBody = startBodyFromFlags(true);
    const startResp = await api("/api/v1/competition/start", {
      ...startBody,
      model: competitionModel,
      password: competitionPassword,
    });
    return startResp.competitionToken || startResp?.state?.competition?.token || null;
  }

  if (COMMAND === "state") {
    const compToken = await resolveCompetitionToken();
    if (!token && !compToken) {
      throw new Error("state requires --token OR --competition-token OR --model+--password");
    }
    const resp = compToken
      ? await api("/api/v1/competition/state", { competitionToken: compToken })
      : await api("/api/v1/play/state", { stateToken: token });
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (COMMAND === "swap") {
    const compToken = await resolveCompetitionToken();
    if (!token && !compToken) {
      throw new Error("swap requires --token OR --competition-token OR --model+--password");
    }
    const a = parseCoord(String(flag("a", "")));
    const b = parseCoord(String(flag("b", "")));
    if (!a || !b) throw new Error("swap requires --a r,c --b r,c (0..3)");
    const resp = compToken
      ? await api("/api/v1/competition/swap", { competitionToken: compToken, a, b })
      : await api("/api/v1/play/swap", { stateToken: token, a, b });
    if (resp?.state?.finished) recordFinishedGame(resp.state);
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (COMMAND === "guess") {
    const compToken = await resolveCompetitionToken();
    if (!token && !compToken) {
      throw new Error("guess requires --token OR --competition-token OR --model+--password");
    }
    const kind = String(flag("kind", "")).toLowerCase();
    const line = Number(flag("line", NaN));
    if (kind !== "row" && kind !== "col") throw new Error("guess requires --kind row|col");
    if (!Number.isInteger(line) || line < 0 || line > 3) throw new Error("guess requires --line 0..3");

    const resp = compToken
      ? await api("/api/v1/competition/guess", { competitionToken: compToken, kind, index: line })
      : await api("/api/v1/play/guess", { stateToken: token, kind, index: line });
    if (resp?.state?.finished) recordFinishedGame(resp.state);
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (COMMAND === "register") {
    const model = String(flag("model", "")).trim();
    const password = String(flag("password", "")).trim();
    const displayName = String(flag("display-name", model)).trim();
    const adminKey = String(flag("admin-key", process.env.CONNECDOKU_ADMIN_KEY || "")).trim();
    if (!model) throw new Error("register requires --model");
    if (!password) throw new Error("register requires --password");
    if (!adminKey) throw new Error("register requires --admin-key or CONNECDOKU_ADMIN_KEY");

    const resp = await fetch(`${API_BASE}/api/v1/competition/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify({
        model,
        password,
        displayName,
      }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) throw new Error(json.error || `HTTP ${resp.status}`);
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  if (COMMAND === "submit") {
    const compToken = await resolveCompetitionToken();
    if (!compToken) {
      throw new Error("submit requires --competition-token or --model+--password");
    }
    const notes = String(flag("notes", flag("note", flag("comment", "")))).trim();
    const resp = await api("/api/v1/competition/submit", {
      competitionToken: compToken,
      notes: notes || undefined,
    });
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  if (COMMAND === "leaderboard") {
    const limit = Number(flag("limit", 50));
    const capped = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50;
    const resp = await apiGet(`/api/v1/competition/leaderboard?limit=${capped}`);
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  throw new Error(`Unknown command '${COMMAND}'`);
}

if (hasFlag("help") || hasFlag("h")) {
  console.log(`Usage:\n  Interactive:\n    node terminal_play_cli.js [--api URL] [--date YYYY-MM-DD | --index N] [--seed TEXT]\n\n  One-shot (AI/script-friendly):\n    node terminal_play_cli.js start [--api URL] [--date YYYY-MM-DD | --index N] [--seed TEXT]\n    node terminal_play_cli.js start --api URL --model <MODEL_ID> --password <PASSWORD> [--date YYYY-MM-DD]\n    node terminal_play_cli.js state --api URL --token <STATE_TOKEN>\n    node terminal_play_cli.js state --api URL --competition-token <COMP_TOKEN>\n    node terminal_play_cli.js state --api URL --model <MODEL_ID> --password <PASSWORD> [--date YYYY-MM-DD]\n    node terminal_play_cli.js swap --api URL (--competition-token <COMP_TOKEN> | --model <MODEL_ID> --password <PASSWORD>) --a r,c --b r,c\n    node terminal_play_cli.js guess --api URL (--competition-token <COMP_TOKEN> | --model <MODEL_ID> --password <PASSWORD>) --kind row|col --line N\n    node terminal_play_cli.js submit --api URL (--competition-token <COMP_TOKEN> | --model <MODEL_ID> --password <PASSWORD>) [--notes \"...\"]\n    node terminal_play_cli.js register --api URL --admin-key <ADMIN_KEY> --model <MODEL_ID> --password <PASSWORD> [--display-name NAME]\n    node terminal_play_cli.js leaderboard [--api URL] [--limit 50]\n    node terminal_play_cli.js stats\n\nExamples:\n  node terminal_play_cli.js guess --api https://example.com --model gpt-5.5 --password secret --kind row --line 1\n  node terminal_play_cli.js submit --api https://example.com --model gpt-5.5 --password secret --notes \"Fun puzzle\"\n`);
  process.exit(0);
}

if (COMMAND !== "play") {
  runOneShot().catch((e) => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
} else {
  let stateToken = null;
  let competitionToken = null;
  let state = null;

  function persistSession() {
    if (!stateToken || !state) return;
    saveSessionForApi(API_BASE, stateToken, state);
  }

  async function refreshState() {
    const resp = competitionToken
      ? await api("/api/v1/competition/state", { competitionToken })
      : await api("/api/v1/play/state", { stateToken });
    stateToken = resp.stateToken;
    competitionToken = resp.competitionToken || competitionToken || resp?.state?.competition?.token || null;
    state = resp.state;
    persistSession();
    return state;
  }

  async function startGame(bodyOverride = null) {
    const body = bodyOverride || startBodyFromFlags(true);
    const resp = await api("/api/v1/play/start", body);
    stateToken = resp.stateToken;
    competitionToken = null;
    state = resp.state;
    persistSession();
    printBoard(state);
  }

  async function authCompetition(model, password, bodyOverride = null) {
    if (!model || !password) throw new Error("Usage: auth MODEL PASS");
    const body = bodyOverride || startBodyFromFlags(true);
    const resp = await api("/api/v1/competition/start", {
      ...body,
      model,
      password,
    });
    competitionToken = resp.competitionToken || resp?.state?.competition?.token || null;
    stateToken = resp.stateToken;
    state = resp.state;
    persistSession();
    console.log(resp.message || "Competition attempt locked.");
    printBoard(state);
  }

  async function doSwap(parts) {
    if (parts.length !== 5) throw new Error("Usage: swap r1 c1 r2 c2");
    const nums = parts.slice(1).map((x) => Number(x));
    if (!nums.every((x) => Number.isInteger(x) && x >= 0 && x < 4)) {
      throw new Error("Indices must be integers 0..3");
    }

    const [r1, c1, r2, c2] = nums;
    const resp = competitionToken
      ? await api("/api/v1/competition/swap", {
          competitionToken,
          a: [r1, c1],
          b: [r2, c2],
        })
      : await api("/api/v1/play/swap", {
          stateToken,
          a: [r1, c1],
          b: [r2, c2],
        });
    stateToken = resp.stateToken;
    competitionToken = resp.competitionToken || competitionToken || resp?.state?.competition?.token || null;
    state = resp.state;
    persistSession();
    console.log(resp.result.changed ? "Swap applied." : "No-op swap.");
    printBoard(state);
  }

  async function doGuess(parts) {
    if (parts.length !== 3) throw new Error("Usage: guess row|col i");
    const kind = parts[1].toLowerCase();
    const index = Number(parts[2]);
    if (kind !== "row" && kind !== "col") throw new Error("kind must be row or col");
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error("index must be 0..3");

    const resp = competitionToken
      ? await api("/api/v1/competition/guess", { competitionToken, kind, index })
      : await api("/api/v1/play/guess", { stateToken, kind, index });
    stateToken = resp.stateToken;
    competitionToken = resp.competitionToken || competitionToken || resp?.state?.competition?.token || null;
    state = resp.state;
    persistSession();

    if (resp.result.correct) {
      const solved = resp.result.solved;
      console.log(`Correct: ${solved.kind} ${solved.index} = ${solved.label}`);
    } else {
      console.log(`Incorrect. Strikes: ${resp.result.strikes}/${state.maxStrikes}`);
    }
    printBoard(state);
  }

  async function doSubmit(parts) {
    if (!competitionToken) {
      throw new Error("Use 'auth MODEL PASS' first. Submission now requires a locked competition attempt.");
    }
    const notes = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
    const resp = await api("/api/v1/competition/submit", {
      competitionToken,
      notes: notes || undefined,
    });
    console.log(`Submitted: ${resp?.result?.model || "competition"} ${resp?.result?.puzzle_date || ""}`.trim());
  }

  async function doLeaderboard(parts) {
    const n = Number(parts[1] || 20);
    const limit = Number.isInteger(n) ? Math.max(1, Math.min(200, n)) : 20;
    const resp = await apiGet(`/api/v1/competition/leaderboard?limit=${limit}`);
    const rows = Array.isArray(resp.leaderboard) ? resp.leaderboard : [];
    if (!rows.length) {
      console.log("No competition results yet.");
      return;
    }
    console.log("\nLeaderboard");
    rows.forEach((row, i) => {
      console.log(`${String(i + 1).padStart(2, " ")}. ${row.display_name} (${row.model}) wins=${row.wins} attempts=${row.attempts}`);
    });
  }

  async function startNextPuzzleFromCurrent() {
    const baseDate = state?.puzzle?.date;
    const today = localDateString();
    let targetDate = today;
    if (baseDate && parseDateString(baseDate)) {
      const candidate = nextDateString(baseDate);
      if (candidate && candidate <= today) {
        targetDate = candidate;
      } else {
        console.log("No next daily puzzle is available yet. Try 'next' after local midnight.");
        return;
      }
    }

    await startGame({ date: targetDate, seed: SEED || undefined });
  }

  async function mainInteractive() {
    if (!HAS_EXPLICIT_START_OPTIONS) {
      const saved = loadSessionForApi(API_BASE);
      const today = localDateString();
      if (saved && saved.stateToken && saved.puzzleDate === today) {
        try {
          const resp = await api("/api/v1/play/state", { stateToken: saved.stateToken });
          stateToken = resp.stateToken;
          state = resp.state;
          persistSession();
          console.log(`Resumed saved game for ${state.puzzle.date}.`);
          printBoard(state);
        } catch {
          clearSessionForApi(API_BASE);
          await startGame();
        }
      } else {
        await startGame();
      }
    } else {
      await startGame();
    }
    printRulesOverview();
    printHelp();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "connecdoku> " });
    rl.prompt();

    rl.on("line", async (line) => {
      const txt = line.trim();
      if (!txt) {
        rl.prompt();
        return;
      }

      try {
        const parts = txt.split(/\s+/);
        const cmd = parts[0].toLowerCase();

        if (cmd === "quit" || cmd === "exit") {
          rl.close();
          return;
        }
        if (cmd === "help") {
          printHelp();
        } else if (cmd === "rules") {
          printRulesOverview();
        } else if (cmd === "state") {
          await refreshState();
          printBoard(state);
        } else if (cmd === "swap") {
          await doSwap(parts);
        } else if (cmd === "guess") {
          await doGuess(parts);
        } else if (cmd === "token") {
          console.log(stateToken);
          if (competitionToken) console.log(`competitionToken=${competitionToken}`);
        } else if (cmd === "stats") {
          printStats();
        } else if (cmd === "auth") {
          if (parts.length < 3) throw new Error("Usage: auth MODEL PASS");
          await authCompetition(String(parts[1]).trim(), String(parts[2]).trim());
        } else if (cmd === "submit") {
          await doSubmit(parts);
        } else if (cmd === "leaderboard") {
          await doLeaderboard(parts);
        } else if (cmd === "next") {
          await startNextPuzzleFromCurrent();
        } else {
          console.log("Unknown command. Type 'help'.");
        }
      } catch (e) {
        console.log(`Error: ${e.message}`);
      }

      if (state && state.finished) {
        console.log("Puzzle complete. Use 'next' after local midnight for the new daily puzzle.");
      }
      rl.prompt();
    });

    rl.on("close", () => {
      process.exit(0);
    });
  }

  mainInteractive().catch((e) => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
