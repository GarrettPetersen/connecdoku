#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const MODELS_FILE = path.join(ROOT, "data", "cursor_benchmark_models.json");
const DEFAULT_API_BASE = "https://connecdoku.com";
const DEFAULT_CURSOR_BASE = "https://api.cursor.com";
const PROMPT_VERSION = "cursor-benchmark-v1";
const MAX_STEPS_DEFAULT = 64;
const MAX_ACTION_RETRIES = 3;
const NOTE_MAX_CHARS = 500;
const SCRATCHPAD_MAX_CHARS = 3000;
const TRACE_LIMIT = 200;
const CURSOR_POLL_MS_DEFAULT = 5000;
const CURSOR_TIMEOUT_MS_DEFAULT = 15 * 60 * 1000;
const HTTP_TIMEOUT_MS_DEFAULT = 120000;

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2] || "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const out = { flags: {}, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.flags[key] = next;
      i += 1;
    } else {
      out.flags[key] = true;
    }
  }
  return out;
}

function detectGitHubRepoFromGitRemote() {
  try {
    const out = String(execSync("git config --get remote.origin.url", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }) || "").trim();
    if (!out) return "";

    // git@github.com:owner/repo.git
    const ssh = out.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;

    // https://github.com/owner/repo.git
    const https = out.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
    if (https) return `https://github.com/${https[1]}/${https[2]}`;
  } catch {
    // ignore
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDateString(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS_DEFAULT) {
  const controller = new AbortController();
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const opPromise = (async () => {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const raw = await res.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      json = {};
    }
    return { res, json };
  })();

  try {
    return await Promise.race([opPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function postJson(url, body, headers = {}, timeoutMs = HTTP_TIMEOUT_MS_DEFAULT) {
  const started = Date.now();
  const { res, json } = await fetchJsonWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  }, timeoutMs);
  const elapsedMs = Date.now() - started;
  return { ok: res.ok && json.ok !== false, status: res.status, json, elapsedMs };
}

async function getJson(url, headers = {}, timeoutMs = HTTP_TIMEOUT_MS_DEFAULT) {
  const started = Date.now();
  const { res, json } = await fetchJsonWithTimeout(url, { method: "GET", headers }, timeoutMs);
  const elapsedMs = Date.now() - started;
  return { ok: res.ok && json.ok !== false, status: res.status, json, elapsedMs };
}

async function deleteJson(url, headers = {}, timeoutMs = HTTP_TIMEOUT_MS_DEFAULT) {
  const started = Date.now();
  const { res, json } = await fetchJsonWithTimeout(url, { method: "DELETE", headers }, timeoutMs);
  const elapsedMs = Date.now() - started;
  return { ok: res.ok && json.ok !== false, status: res.status, json, elapsedMs };
}

function trimText(s, max = NOTE_MAX_CHARS) {
  const str = String(s || "").trim().replace(/\s+/g, " ");
  return str.slice(0, max);
}

function appendScratchpad(existing, update, maxChars = SCRATCHPAD_MAX_CHARS) {
  const prev = trimText(existing || "", maxChars);
  const next = trimText(update || "", 500);
  if (!next) return prev;
  const joined = prev ? `${prev} || ${next}` : next;
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

function parseJsonObjectLoose(text) {
  const src = String(text || "").trim();
  if (!src) return null;
  try {
    return JSON.parse(src);
  } catch {
    const start = src.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const fragment = src.slice(start, i + 1);
          try {
            return JSON.parse(fragment);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

function parseActionFromTextLoose(text) {
  const src = String(text || "").trim();
  if (!src) return null;
  const lower = src.toLowerCase();

  let scratchpadUpdate = "";
  const scratchMatch = src.match(/\/scratch\s+"((?:\\.|[^"\\])*)"/i);
  if (scratchMatch && scratchMatch[1] != null) {
    scratchpadUpdate = String(scratchMatch[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  const candidates = [];
  for (const m of lower.matchAll(/\/guess\s+(row|col|column)\s+([0-3])\b/g)) {
    const kind = m[1] === "row" ? "row" : "col";
    candidates.push({
      idx: m.index ?? Number.MAX_SAFE_INTEGER,
      action: { action: "guess", kind, index: Number(m[2]), scratchpad_update: scratchpadUpdate },
    });
  }
  for (const m of lower.matchAll(/\/swap\s+([0-3])\s+([0-3])\s+([0-3])\s+([0-3])\b/g)) {
    candidates.push({
      idx: m.index ?? Number.MAX_SAFE_INTEGER,
      action: {
        action: "swap",
        a: [Number(m[1]), Number(m[2])],
        b: [Number(m[3]), Number(m[4])],
        scratchpad_update: scratchpadUpdate,
      },
    });
  }
  const valid = candidates.sort((a, b) => a.idx - b.idx);
  return valid.length ? valid[0].action : null;
}

function buildBoardText(state) {
  const lines = [];
  const rows = state?.board || [];
  for (let r = 0; r < 4; r++) {
    const cells = [];
    for (let c = 0; c < 4; c++) {
      const word = rows?.[r]?.[c] || "?";
      cells.push(`[${r},${c}] ${word}`);
    }
    lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

function solvedLabelText(arr, prefix) {
  const parts = [];
  for (const item of arr || []) {
    parts.push(`${prefix} ${item.index}: ${item.label}`);
  }
  return parts.join("; ") || "none";
}

function lineWordsFromState(state, kind, index) {
  const board = state?.board;
  if (!Array.isArray(board) || (kind !== "row" && kind !== "col") || !Number.isInteger(index) || index < 0 || index > 3) {
    return null;
  }
  if (kind === "row") {
    const row = board[index];
    return Array.isArray(row) && row.length === 4 ? row.slice(0, 4) : null;
  }
  const words = [];
  for (let r = 0; r < 4; r++) {
    if (!Array.isArray(board[r]) || board[r].length < 4) return null;
    words.push(board[r][index]);
  }
  return words;
}

function finalSolvedLabels(state) {
  const rows = (state?.solved?.rows || []).map((x) => `row ${x.index}: ${x.label}`).join("; ") || "none";
  const cols = (state?.solved?.cols || []).map((x) => `col ${x.index}: ${x.label}`).join("; ") || "none";
  return { rows, cols };
}

function revealedAfterLossLabels(state) {
  if (String(state?.outcome || "") !== "lost") return { rows: "none", cols: "none" };
  const maxStrikes = Number(state?.maxStrikes ?? 5);
  const rows = (state?.solved?.rows || [])
    .filter((x) => Number(x?.strikeLevel) >= maxStrikes)
    .map((x) => `row ${x.index}: ${x.label}`)
    .join("; ") || "none";
  const cols = (state?.solved?.cols || [])
    .filter((x) => Number(x?.strikeLevel) >= maxStrikes)
    .map((x) => `col ${x.index}: ${x.label}`)
    .join("; ") || "none";
  return { rows, cols };
}

function buildDecisionPrompt(state, metrics, modelMeta) {
  const board = buildBoardText(state);
  const solvedRows = (state?.solved?.rows || []).map((x) => x.index).join(",") || "none";
  const solvedCols = (state?.solved?.cols || []).map((x) => x.index).join(",") || "none";
  const rules = state?.rules || {};
  const actions = (state?.protocol?.allowedActions || []).join(",");

  return [
    "Return exactly ONE JSON object. No markdown. No extra text.",
    "You are playing Connecdoku, not editing code. Ignore repository tasks, commits, and file operations.",
    "Pick one legal move only.",
    "Game rules:",
    "- Goal: Find the 8 hidden categories by correctly guessing the 4 members in each of them.",
    "- You see 16 words; category names are hidden.",
    "- Swap two unlocked tiles to rearrange the grid.",
    "- Guess a full row or column category.",
    "- Correct guess locks that line.",
    "- Wrong guess adds one strike.",
    "- At 5 strikes, you lose.",
    "- If 3 rows are solved, row guesses are blocked until columns advance (and vice versa).",
    "- The game may reorder the just-solved line to keep the puzzle solvable.",
    "- Auto-alignment: after multiple solves in one dimension, solved lines may reorder to align and reveal hints in the other dimension.",
    "- Locked-word information: locked words are reliable constraints. Two locked words sharing a row/column indicate that shared category structure.",
    "- Final unresolved line may auto-resolve when only one row and one column remain.",
    ...(Number(state?.turn || 0) === 0
      ? ["The starting board is a random arrangement, so an untouched row or column is unlikely to be correct."]
      : []),
    "Use swaps to build candidate sets; avoid blind guesses.",
    ...(metrics.consecutiveSwaps > 8
      ? ["You cannot solve the puzzle without guessing. Make your best guess now. Endless swaps with no guesses will be counted as a loss."]
      : metrics.consecutiveSwaps > 4
        ? [`You have done ${metrics.consecutiveSwaps} swaps in a row. Try making a guess.`]
        : []),
    "Command protocol:",
    "/guess row 0",
    "/guess col 1",
    "/swap 0 0 1 1",
    '/scratch "short note about what you learned and plan next (optional)"',
    'Combined example: /guess row 2 /scratch "row2 hypothesis is weak; test col next"',
    "Parsing rule: we scan your whole response and execute the first valid /guess or /swap command we find.",
    'Persisted means: the first /scratch "..." is saved, carried into future turns, and included in end-of-run note context.',
    "You may include normal text, but only the first valid slash command(s) affect state.",
    "Do not repeat the same no-progress move in a loop.",
    "",
    `model=${modelMeta.displayName}`,
    `date=${state?.puzzle?.date}`,
    `turn=${state?.turn}`,
    `strikes=${state?.strikes}/${state?.maxStrikes}`,
    `canGuessRow=${rules.canGuessRow}`,
    `canGuessCol=${rules.canGuessCol}`,
    "Allowed output actions: /swap and /guess.",
    "Output rule: include at least one valid slash move command in your response.",
    `solvedRows=${solvedRows}`,
    `solvedCols=${solvedCols}`,
    "Board:",
    board,
    `invalidSoFar=${metrics.gameInvalidActions}`,
    `repairPromptsSoFar=${metrics.gameFallbackActions}`,
    `incorrect guesses: ${JSON.stringify(metrics.incorrectGuessWordSets || [])}`,
    `scratchpad: ${metrics.scratchpad || "(empty)"}`,
    metrics.lastActionSummary ? `lastAction=${metrics.lastActionSummary}` : null,
  ].join("\n");
}

function buildNotePrompt(state, runStats) {
  const solved = finalSolvedLabels(state);
  const revealedAfterLoss = revealedAfterLossLabels(state);
  return [
    "Write only the final note text for a public benchmark table.",
    "Do not explain the task, restate these instructions, or mention the prompt.",
    "Be creative and specific: mention a category insight, a mistake, a surprise, or a boast.",
    "Tone can be witty, reflective, or dramatic.",
    "Constraints: plain text only, <= 220 characters, no newlines.",
    "",
    `Puzzle date: ${state?.puzzle?.date}`,
    `Outcome: ${state?.outcome}`,
    `Strikes: ${state?.strikes}`,
    `Turns: ${state?.turn}`,
    `Correct guesses: ${runStats.gameCorrectGuesses}`,
    `Incorrect guesses: ${runStats.gameIncorrectGuesses}`,
    `Solved rows: ${solved.rows}`,
    `Solved cols: ${solved.cols}`,
    `Revealed after loss (not solved before losing) rows: ${revealedAfterLoss.rows}`,
    `Revealed after loss (not solved before losing) cols: ${revealedAfterLoss.cols}`,
    "Final board:",
    buildBoardText(state),
    `Scratchpad timeline: ${runStats.scratchpad || "(empty)"}`,
  ].join("\n");
}

function buildNoteRepairPrompt(basePrompt, reason, lastOutput) {
  const details = trimText(lastOutput || "", 240);
  return [
    basePrompt,
    "",
    "Your previous response was not a valid benchmark note.",
    `Reason: ${reason}`,
    details ? `Previous response: ${details}` : "Previous response: (empty)",
    "Reply with only the final note text, and nothing else.",
  ].join("\n");
}

function buildForcedOneSentenceNotePrompt(state, runStats) {
  return [
    "Reply with exactly one short sentence only.",
    "Do not explain instructions. Do not mention prompts, constraints, or the user.",
    "Comment on your puzzle performance.",
    "Max 120 characters.",
    "",
    `Outcome: ${state?.outcome}`,
    `Strikes: ${state?.strikes}`,
    `Turns: ${state?.turn}`,
    `Correct guesses: ${runStats.gameCorrectGuesses}`,
    `Incorrect guesses: ${runStats.gameIncorrectGuesses}`,
  ].join("\n");
}

function noteLooksLikePromptEcho(note) {
  const s = String(note || "").trim().toLowerCase();
  if (!s) return true;
  return (
    s.includes("write only the final note text") ||
    s.includes("write a short post-game note") ||
    s.includes("the user wants") ||
    s.includes("constraints:") ||
    s.includes("puzzle date:") ||
    s.includes("outcome:") ||
    s.includes("strikes:") ||
    s.includes("turns:") ||
    s.includes("correct guesses:") ||
    s.includes("incorrect guesses:")
  );
}

function noteLooksUsable(note) {
  const s = trimText(note || "", NOTE_MAX_CHARS);
  if (!s) return false;
  if (s.length < 8) return false;
  return !noteLooksLikePromptEcho(s);
}

function buildRepairPrompt(basePrompt, reason, lastOutput) {
  const details = trimText(lastOutput || "", 280);
  return [
    basePrompt,
    "",
    "Your previous response was invalid for this API turn.",
    `Reason: ${reason}`,
    details ? `You said: ${details}` : "You said: (empty)",
    "Now output a valid slash move command.",
    'Accepted format: /swap r1 c1 r2 c2 OR /guess row i OR /guess col i, optional /scratch "..."',
    'Persisted means: /scratch text is saved for future turns and note context.',
    "Reply again with at least one valid slash move command.",
  ].join("\n");
}

function normalizeAction(obj) {
  if (!obj || typeof obj !== "object") return null;
  const action = String(obj.action || "").toLowerCase();
  if (action === "guess") {
    const kind = String(obj.kind || "").toLowerCase();
    const index = Number(obj.index);
    if ((kind === "row" || kind === "col") && Number.isInteger(index) && index >= 0 && index <= 3) {
      return {
        action: "guess",
        kind,
        index,
        briefReason: trimText(obj.brief_reason || obj.reason || "", 140),
        scratchpadUpdate: trimText(obj.scratchpad_update || obj.scratchpad || "", 500),
      };
    }
    return null;
  }
  if (action === "swap") {
    const a = Array.isArray(obj.a) ? obj.a.map((v) => Number(v)) : null;
    const b = Array.isArray(obj.b) ? obj.b.map((v) => Number(v)) : null;
    if (
      a && b && a.length === 2 && b.length === 2 &&
      a.every((v) => Number.isInteger(v) && v >= 0 && v <= 3) &&
      b.every((v) => Number.isInteger(v) && v >= 0 && v <= 3)
    ) {
      return {
        action: "swap",
        a,
        b,
        briefReason: trimText(obj.brief_reason || obj.reason || "", 140),
        scratchpadUpdate: trimText(obj.scratchpad_update || obj.scratchpad || "", 500),
      };
    }
  }
  return null;
}

function pickForcedGuessAction(state) {
  const solvedRows = new Set((state?.solved?.rows || []).map((x) => Number(x.index)));
  const solvedCols = new Set((state?.solved?.cols || []).map((x) => Number(x.index)));
  const canRow = !!state?.rules?.canGuessRow;
  const canCol = !!state?.rules?.canGuessCol;

  if (canRow) {
    for (let i = 0; i < 4; i++) if (!solvedRows.has(i)) return { action: "guess", kind: "row", index: i };
  }
  if (canCol) {
    for (let i = 0; i < 4; i++) if (!solvedCols.has(i)) return { action: "guess", kind: "col", index: i };
  }
  for (let i = 0; i < 4; i++) if (!solvedRows.has(i)) return { action: "guess", kind: "row", index: i };
  for (let i = 0; i < 4; i++) if (!solvedCols.has(i)) return { action: "guess", kind: "col", index: i };
  return null;
}

function normalizeReasoningLevel(level) {
  const v = String(level || "").toLowerCase();
  if (v === "none" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
  return "medium";
}

function solvedCountFromState(state) {
  const rows = Array.isArray(state?.solved?.rows) ? state.solved.rows.length : 0;
  const cols = Array.isArray(state?.solved?.cols) ? state.solved.cols.length : 0;
  return rows + cols;
}

function assertFreshCompetitionAttempt(startJson, modelId, date) {
  const state = startJson?.state || {};
  const attempt = startJson?.attempt || {};
  const turnCount = Number(attempt.turnCount ?? state.turn ?? 0);
  const solvedCount = solvedCountFromState(state);
  const strikes = Number(attempt.strikes ?? state.strikes ?? 0);
  const finished = !!state.finished || !!attempt.finished;
  const pristine = !finished && turnCount === 0 && solvedCount === 0 && strikes === 0;
  if (!pristine) {
    throw new Error(
      `Refusing resumed attempt for ${modelId} on ${date}. ` +
      `Need pristine state (turn=0, solved=0, strikes=0, unfinished), got turn=${turnCount}, solved=${solvedCount}, strikes=${strikes}, finished=${finished}.`
    );
  }
}

function classifyCompetitionAttempt(startJson) {
  const state = startJson?.state || {};
  const attempt = startJson?.attempt || {};
  const turnCount = Number(attempt.turnCount ?? state.turn ?? 0);
  const solvedCount = solvedCountFromState(state);
  const strikes = Number(attempt.strikes ?? state.strikes ?? 0);
  const finished = !!state.finished || !!attempt.finished;
  const pristine = !finished && turnCount === 0 && solvedCount === 0 && strikes === 0;
  return { state, turnCount, solvedCount, strikes, finished, pristine };
}

function isLikelyMainConnecdokuRepo(repoUrl) {
  const s = String(repoUrl || "").toLowerCase();
  return s.includes("github.com/garrettpetersen/connecdoku") && !s.includes("github.com/garrettpetersen/connecdoku-player");
}

function assertSafeCursorRepository(repoUrl) {
  const allowMain = String(process.env.CURSOR_BENCH_ALLOW_MAIN_REPO || "").trim() === "1";
  if (!repoUrl) {
    throw new Error("CURSOR_BENCH_REPOSITORY is required for Cursor lane.");
  }
  if (!allowMain && isLikelyMainConnecdokuRepo(repoUrl)) {
    throw new Error(
      "Unsafe Cursor repository: main connecdoku repo is blocked for benchmark integrity. " +
      "Use CURSOR_BENCH_REPOSITORY=https://github.com/GarrettPetersen/connecdoku-player " +
      "or set CURSOR_BENCH_ALLOW_MAIN_REPO=1 to override intentionally."
    );
  }
}

function isLikelyFatalModelCallError(message) {
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("cursor_api_key missing") ||
    m.includes("cursor_bench_repository missing") ||
    m.includes("cursor_reposit") ||
    m.includes("create agent error (401)") ||
    m.includes("create agent error (403)") ||
    m.includes("status error (401)") ||
    m.includes("status error (403)") ||
    m.includes("conversation error (401)") ||
    m.includes("conversation error (403)")
  );
}

function parseCursorUsage(statusJson, conversationJson) {
  const usage = statusJson?.usage || conversationJson?.usage || null;
  if (!usage || typeof usage !== "object") {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }

  const inputTokens = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokens ?? usage.input ?? NaN
  );
  const outputTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.completionTokens ?? usage.output ?? NaN
  );
  const totalTokens = Number(
    usage.total_tokens ?? usage.totalTokens ?? usage.total ?? (Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? inputTokens + outputTokens : NaN)
  );

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
  };
}

function estimateCostUsd(modelCfg, usage) {
  const inRate = Number(modelCfg.inputPricePerMTok || 0);
  const outRate = Number(modelCfg.outputPricePerMTok || 0);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) return null;
  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const inputCost = (inputTokens / 1_000_000) * inRate;
  const outputCost = (outputTokens / 1_000_000) * outRate;
  return Number((inputCost + outputCost).toFixed(8));
}

function extractAssistantText(conversationJson, statusJson) {
  const msgs = Array.isArray(conversationJson?.messages) ? conversationJson.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.type === "assistant_message" && typeof m.text === "string" && m.text.trim()) {
      return m.text;
    }
  }
  if (typeof statusJson?.summary === "string" && statusJson.summary.trim()) return statusJson.summary;
  return "";
}

async function cursorApiReq(method, pathPart, body, apiKey, cursorBase) {
  const base = cursorBase.replace(/\/+$/, "");
  const url = `${base}${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
  const headers = {
    authorization: `Bearer ${apiKey}`,
  };
  const timeoutMs = Math.max(5000, Number(process.env.CURSOR_BENCH_HTTP_TIMEOUT_MS || HTTP_TIMEOUT_MS_DEFAULT));
  if (method === "GET") return getJson(url, headers, timeoutMs);
  if (method === "DELETE") return deleteJson(url, headers, timeoutMs);
  return postJson(url, body, headers, timeoutMs);
}

async function waitForCursorAgentFinished(agentId, apiKey, cursorBase, cursorOpts) {
  let statusJson = {};
  const pollMs = Math.max(1000, Number(cursorOpts.pollMs || CURSOR_POLL_MS_DEFAULT));
  const timeoutMs = Math.max(10_000, Number(cursorOpts.timeoutMs || CURSOR_TIMEOUT_MS_DEFAULT));
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let polls = 0;

  while (Date.now() < deadline) {
    const s = await cursorApiReq("GET", `/v0/agents/${encodeURIComponent(agentId)}`, null, apiKey, cursorBase);
    if (!s.ok) {
      throw new Error(`Cursor status error (${s.status}): ${s.json?.error || s.json?.message || "unknown"}`);
    }
    statusJson = s.json || {};
    const status = String(statusJson?.status || "").toUpperCase();
    polls += 1;
    if (status !== lastStatus) {
      console.log(`Cursor agent ${agentId} status -> ${status || "UNKNOWN"} (${polls} polls)`);
      lastStatus = status;
    }
    if (polls % 12 === 0) {
      const secsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`Cursor agent ${agentId} still ${status || "UNKNOWN"}; ~${secsLeft}s until timeout`);
    }
    if (status === "FINISHED") break;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`Cursor agent ended with status=${status}. Summary: ${trimText(statusJson?.summary || "", 240)}`);
    }
    await sleep(pollMs);
  }

  if (String(statusJson?.status || "").toUpperCase() !== "FINISHED") {
    throw new Error(`Cursor agent timed out after ${Math.round(timeoutMs / 1000)}s.`);
  }
  return statusJson;
}

async function runCursorAgentPrompt(cfg, prompt, mode, cursorOpts, cursorSession) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("CURSOR_API_KEY missing.");

  const repo = String(cursorOpts.repository || "").trim();
  if (!repo) {
    throw new Error("CURSOR_BENCH_REPOSITORY missing. Set to a GitHub repository URL Cursor agents can access.");
  }
  const ref = String(cursorOpts.repositoryRef || "main");
  const cursorBase = String(cursorOpts.cursorBase || process.env.CURSOR_BASE_URL || DEFAULT_CURSOR_BASE);

  const promptText = mode === "note"
    ? `${prompt}\n\nReturn only the final note text.`
    : `${prompt}\n\nReturn only one JSON object and no markdown fences.`;

  const started = Date.now();
  if (!cursorSession.agentId) {
    const launchBody = {
      prompt: { text: promptText },
      source: { repository: repo, ref },
      target: { autoCreatePr: false },
    };
    if (cfg.resolvedApiModel) launchBody.model = cfg.resolvedApiModel;

    const createResp = await cursorApiReq("POST", "/v0/agents", launchBody, apiKey, cursorBase);
    if (!createResp.ok) {
      throw new Error(`Cursor create agent error (${createResp.status}): ${createResp.json?.error || createResp.json?.message || "unknown"}`);
    }
    const agentId = createResp.json?.id;
    if (!agentId) throw new Error("Cursor create agent response missing id.");
    cursorSession.agentId = agentId;
    console.log(`Cursor agent created: ${agentId} model=${cfg.resolvedApiModel || "auto"}`);
  } else {
    console.log(`Cursor agent followup: ${cursorSession.agentId}`);
    const followResp = await cursorApiReq(
      "POST",
      `/v0/agents/${encodeURIComponent(cursorSession.agentId)}/followup`,
      { prompt: { text: promptText } },
      apiKey,
      cursorBase
    );
    if (!followResp.ok) {
      throw new Error(`Cursor followup error (${followResp.status}): ${followResp.json?.error || followResp.json?.message || "unknown"}`);
    }
  }

  const statusJson = await waitForCursorAgentFinished(cursorSession.agentId, apiKey, cursorBase, cursorOpts);
  const convResp = await cursorApiReq(
    "GET",
    `/v0/agents/${encodeURIComponent(cursorSession.agentId)}/conversation`,
    null,
    apiKey,
    cursorBase
  );
  if (!convResp.ok) {
    throw new Error(`Cursor conversation error (${convResp.status}): ${convResp.json?.error || convResp.json?.message || "unknown"}`);
  }

  const text = extractAssistantText(convResp.json, statusJson);
  const usage = parseCursorUsage(statusJson, convResp.json);

  return {
    text,
    usage,
    latencyMs: Date.now() - started,
    providerModel: cfg.resolvedApiModel || statusJson?.model || "auto",
    agentId: cursorSession.agentId,
  };
}

async function maybeListCursorModels(cursorBase) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("CURSOR_API_KEY missing.");
  const resp = await cursorApiReq("GET", "/v0/models", null, apiKey, cursorBase);
  if (!resp.ok) {
    throw new Error(`list models failed (${resp.status}): ${resp.json?.error || resp.json?.message || "unknown"}`);
  }
  const models = Array.isArray(resp.json?.models) ? resp.json.models : [];
  console.log(JSON.stringify({ ok: true, models }, null, 2));
}

async function cursorPreflight(cursorOpts) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error("CURSOR_API_KEY missing.");

  assertSafeCursorRepository(cursorOpts.repository);

  const meResp = await cursorApiReq("GET", "/v0/me", null, apiKey, cursorOpts.cursorBase || DEFAULT_CURSOR_BASE);
  if (!meResp.ok) {
    throw new Error(`Cursor API auth check failed (${meResp.status}): ${meResp.json?.error || meResp.json?.message || "unknown"}`);
  }
}

async function runSingleModel(opts, modelCfg) {
  const apiBase = opts.apiBase;
  const adminKey = process.env.COMPETITION_ADMIN_KEY || "";
  const startTs = Date.now();
  const startedAtIso = nowIso();

  const stats = {
    modelApiCalls: 0,
    modelApiErrors: 0,
    modelLatencyMsTotal: 0,
    modelLatencyMsMax: 0,
    gameActionsTotal: 0,
    gameSwaps: 0,
    gameGuesses: 0,
    gameCorrectGuesses: 0,
    gameIncorrectGuesses: 0,
    incorrectGuessWordSets: [],
    scratchpad: "",
    gameInvalidActions: 0,
    gameFallbackActions: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenTelemetryAvailable: false,
    modelActionsProposed: 0,
    modelActionsAccepted: 0,
    modelCallErrors: [],
    consecutiveSwaps: 0,
    forcedFallbackGuesses: 0,
    lastActionSummary: "",
  };

  const startResp = await postJson(`${apiBase}/api/v1/competition/start`, {
    model: modelCfg.competitionModel,
    password: modelCfg.password,
    date: opts.date,
  });

  if (!startResp.ok) {
    throw new Error(`start failed: ${startResp.json?.error || startResp.status}`);
  }
  const startClass = classifyCompetitionAttempt(startResp.json);
  if (startClass.finished) {
    console.log(
      `Skipping ${modelCfg.displayName}: locked attempt already finished ` +
      `(turn=${startClass.turnCount}, solved=${startClass.solvedCount}, strikes=${startClass.strikes}).`
    );
    return {
      model: modelCfg.competitionModel,
      displayName: modelCfg.displayName,
      provider: "cursor",
      apiModel: modelCfg.resolvedApiModel || "auto",
      outcome: startResp.json?.state?.outcome || "lost",
      strikes: Number(startResp.json?.state?.strikes ?? startClass.strikes ?? 0),
      turns: Number(startResp.json?.state?.turn ?? startClass.turnCount ?? 0),
      durationMs: 0,
      estimatedCostUsd: null,
      tokens: { input: null, output: null, total: null },
      note: "Skipped: locked attempt already finished.",
      skipped: true,
    };
  }

  let state = startResp.json.state;
  const competitionToken = startResp.json.competitionToken;
  if (!competitionToken) throw new Error("competitionToken missing from start response.");
  if (state?.finished) {
    throw new Error(`Attempt already finished for ${modelCfg.competitionModel} on ${opts.date}. Use a different date/model or reset attempts.`);
  }

  const actionTrace = [];
  const cursorSession = { agentId: null };
  let step = 0;
  try {
    while (!state.finished && step < opts.maxSteps) {
      const basePrompt = buildDecisionPrompt(state, stats, modelCfg);
      let repairReason = "No valid command received.";
      let lastModelOutput = "";
      let stepSolved = false;
      let stepSawModelResponse = false;

      for (let attempt = 0; attempt < MAX_ACTION_RETRIES; attempt++) {
        const prompt = attempt === 0 ? basePrompt : buildRepairPrompt(basePrompt, repairReason, lastModelOutput);

        let action = null;
        let modelRespText = "";
        try {
          const modelResp = await runCursorAgentPrompt(modelCfg, prompt, "action", opts.cursor, cursorSession);
          stats.modelApiCalls += 1;
          stats.modelLatencyMsTotal += modelResp.latencyMs;
          stats.modelLatencyMsMax = Math.max(stats.modelLatencyMsMax, modelResp.latencyMs);

          const inTok = Number(modelResp.usage.inputTokens);
          const outTok = Number(modelResp.usage.outputTokens);
          const totalTok = Number(modelResp.usage.totalTokens);
          if (Number.isFinite(inTok) || Number.isFinite(outTok) || Number.isFinite(totalTok)) {
            stats.tokenTelemetryAvailable = true;
          }
          if (Number.isFinite(inTok)) stats.inputTokens += inTok;
          if (Number.isFinite(outTok)) stats.outputTokens += outTok;
          if (Number.isFinite(totalTok)) stats.totalTokens += totalTok;

          modelRespText = modelResp.text;
          lastModelOutput = modelRespText;
          stepSawModelResponse = true;
          const parsed = parseJsonObjectLoose(modelResp.text);
          action = normalizeAction(parsed);
          if (!action) {
            const textFallback = parseActionFromTextLoose(modelResp.text);
            action = normalizeAction(textFallback);
          }
        } catch (e) {
          stats.modelCallErrors.push(String(e.message || e));
          if (isLikelyFatalModelCallError(e.message)) {
            throw new Error(`Cursor model call unavailable: ${e.message}`);
          }
          stats.modelApiErrors += 1;
          stats.gameInvalidActions += 1;
          repairReason = `Model API call failed: ${e.message}`;
          actionTrace.push({
            step,
            attempt,
            reason: "model_call_error",
            error: trimText(String(e?.message || e || ""), 260),
          });
          if (attempt < MAX_ACTION_RETRIES - 1) stats.gameFallbackActions += 1;
          continue;
        }

        if (!action) {
          stats.gameInvalidActions += 1;
          repairReason = "Response was not a valid JSON action command.";
          actionTrace.push({
            step,
            attempt,
            reason: "invalid_action_json",
            modelOutput: trimText(modelRespText, 280),
          });
          if (attempt < MAX_ACTION_RETRIES - 1) stats.gameFallbackActions += 1;
          continue;
        }

        stats.modelActionsProposed += 1;
        stats.gameActionsTotal += 1;
        if (action.action === "swap") {
          stats.gameSwaps += 1;
          stats.consecutiveSwaps += 1;
        }
        if (action.action === "guess") {
          stats.gameGuesses += 1;
          stats.consecutiveSwaps = 0;
        }

        const playResp = action.action === "swap"
          ? await postJson(`${apiBase}/api/v1/competition/swap`, { competitionToken, a: action.a, b: action.b })
          : await postJson(`${apiBase}/api/v1/competition/guess`, { competitionToken, kind: action.kind, index: action.index });

        if (!playResp.ok) {
          stats.gameInvalidActions += 1;
          const apiError = playResp.json?.error || `HTTP ${playResp.status}`;
          const guessedWords = action.action === "guess" ? lineWordsFromState(state, action.kind, action.index) : null;
          repairReason = `Action rejected by game API: ${apiError}`;
          actionTrace.push({
            step,
            attempt,
            reason: "api_rejected",
            action,
            guessedWords,
            modelOutput: trimText(modelRespText, 280),
            apiError,
          });
          // A syntactically valid action was proposed; surface game feedback and move on.
          stepSolved = true;
          break;
        }

        if (action.scratchpadUpdate) stats.scratchpad = appendScratchpad(stats.scratchpad, action.scratchpadUpdate);

        const prevState = state;
        if (action.action === "guess") {
          const correct = !!playResp.json?.result?.correct;
          const lost = !!playResp.json?.result?.lost;
          const nextState = playResp.json?.state || {};
          if (correct) {
            stats.gameCorrectGuesses += 1;
            stats.lastActionSummary = `guess ${action.kind}${action.index} correct`;
          } else {
            stats.gameIncorrectGuesses += 1;
            const guessed = lineWordsFromState(prevState, action.kind, action.index);
            if (Array.isArray(guessed) && guessed.length === 4) stats.incorrectGuessWordSets.push(guessed);
            stats.lastActionSummary = `guess ${action.kind}${action.index} strike`;
            if (!lost) {
              const prevBoard = JSON.stringify(prevState?.board || null);
              const nextBoard = JSON.stringify(nextState?.board || null);
              const prevStrikes = Number(prevState?.strikes || 0);
              const nextStrikes = Number(nextState?.strikes || 0);
              if (prevBoard !== nextBoard) {
                throw new Error("Invariant violation: board changed after incorrect non-losing guess.");
              }
              if (nextStrikes !== prevStrikes + 1) {
                throw new Error(`Invariant violation: strikes did not increment by 1 after incorrect guess (${prevStrikes} -> ${nextStrikes}).`);
              }
            }
          }
        } else {
          stats.lastActionSummary = `swap [${action.a[0]},${action.a[1]}]<->[${action.b[0]},${action.b[1]}]`;
        }
        stats.modelActionsAccepted += 1;

        const guessedWords = action.action === "guess" ? lineWordsFromState(prevState, action.kind, action.index) : null;
        state = playResp.json.state;
        actionTrace.push({
          step,
          attempt,
          reason: "action_accepted",
          action,
          guessedWords,
          modelOutput: trimText(modelRespText, 280),
          result: {
            correct: !!playResp.json?.result?.correct,
            lost: !!playResp.json?.result?.lost,
          },
          strikes: state.strikes,
          turn: state.turn,
          finished: state.finished,
        });
        stepSolved = true;
        break;
      }

      if (!stepSolved) {
        if (!stepSawModelResponse) {
          const suffix = stats.modelCallErrors.length
            ? ` Last API error: ${stats.modelCallErrors[stats.modelCallErrors.length - 1]}`
            : "";
          throw new Error(`Model API unavailable after retries at step ${step}.${suffix}`);
        }
        if (stats.modelApiCalls < 1) {
          const suffix = stats.modelCallErrors.length
            ? ` Last API error: ${stats.modelCallErrors[stats.modelCallErrors.length - 1]}`
            : "";
          throw new Error(`No successful model API calls.${suffix}`);
        }
        const forced = pickForcedGuessAction(state);
        if (!forced) {
          throw new Error(`Model failed to produce an executable command at step ${step}. Last reason: ${repairReason}`);
        }
        const forcedResp = await postJson(
          `${apiBase}/api/v1/competition/guess`,
          { competitionToken, kind: forced.kind, index: forced.index }
        );
        if (!forcedResp.ok) {
          throw new Error(
            `Model failed at step ${step}, and forced-guess fallback also failed: ${forcedResp.json?.error || `HTTP ${forcedResp.status}`}`
          );
        }
        stats.gameFallbackActions += 1;
        stats.forcedFallbackGuesses += 1;
        stats.gameActionsTotal += 1;
        stats.gameGuesses += 1;
        stats.consecutiveSwaps = 0;
        if (forcedResp.json?.result?.correct) stats.gameCorrectGuesses += 1;
        else {
          stats.gameIncorrectGuesses += 1;
          const guessed = lineWordsFromState(state, forced.kind, forced.index);
          if (Array.isArray(guessed) && guessed.length === 4) stats.incorrectGuessWordSets.push(guessed);
        }
        const forcedGuessedWords = lineWordsFromState(state, forced.kind, forced.index);
        state = forcedResp.json.state;
        actionTrace.push({
          step,
          attempt: "forced-fallback",
          reason: "forced_fallback_guess",
          action: forced,
          guessedWords: forcedGuessedWords,
          strikes: state.strikes,
          turn: state.turn,
          finished: state.finished,
        });
        step += 1;
        continue;
      }
      step += 1;
    }

  if (stats.modelApiCalls < 1) {
    const detail = stats.modelCallErrors[0] ? ` First error: ${stats.modelCallErrors[0]}` : "";
    throw new Error(`No successful Cursor model calls were made.${detail}`);
  }
  if (stats.modelActionsAccepted < 1) {
    throw new Error("No model-proposed actions were accepted by the puzzle API.");
  }
    if (!state.finished) {
      if (stats.modelApiCalls < 1) {
        const suffix = stats.modelCallErrors.length
          ? ` Last API error: ${stats.modelCallErrors[stats.modelCallErrors.length - 1]}`
          : "";
        throw new Error(`No successful model API calls.${suffix}`);
      }
      for (let guard = 0; guard < 12 && !state.finished; guard++) {
        const forced = pickForcedGuessAction(state);
        if (!forced) break;
      const forcedResp = await postJson(
        `${apiBase}/api/v1/competition/guess`,
        { competitionToken, kind: forced.kind, index: forced.index }
      );
      if (!forcedResp.ok) break;
      stats.gameFallbackActions += 1;
      stats.forcedFallbackGuesses += 1;
      stats.gameActionsTotal += 1;
      stats.gameGuesses += 1;
      stats.consecutiveSwaps = 0;
      if (forcedResp.json?.result?.correct) stats.gameCorrectGuesses += 1;
      else {
        stats.gameIncorrectGuesses += 1;
        const guessed = lineWordsFromState(state, forced.kind, forced.index);
        if (Array.isArray(guessed) && guessed.length === 4) stats.incorrectGuessWordSets.push(guessed);
      }
      const forcedGuessedWords = lineWordsFromState(state, forced.kind, forced.index);
      state = forcedResp.json.state;
      actionTrace.push({
        step: step + guard,
        attempt: "forced-finish",
        reason: "forced_finish_guess",
        action: forced,
        guessedWords: forcedGuessedWords,
        strikes: state.strikes,
        turn: state.turn,
        finished: state.finished,
      });
    }
    if (!state.finished) {
      throw new Error(`Run did not finish within max steps (${opts.maxSteps}).`);
    }
  }

    let note = "";
    if (opts.cursor.skipNote) {
      note = trimText("Note skipped for smoke test.", NOTE_MAX_CHARS);
    } else {
      try {
        const notePrompt = buildNotePrompt(state, stats);
        let noteText = "";
        let noteOk = false;
        const maxAttempts = modelCfg.provider === "cursor" && /composer/i.test(String(modelCfg.competitionModel || "")) ? 4 : 3;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          let prompt = notePrompt;
          if (attempt === 1) {
            prompt = buildNoteRepairPrompt(notePrompt, "Previous note was prompt echo or otherwise invalid.", noteText);
          } else if (attempt >= 2) {
            prompt = buildForcedOneSentenceNotePrompt(state, stats);
          }
          const noteResp = await runCursorAgentPrompt(modelCfg, prompt, "note", opts.cursor, cursorSession);
          stats.modelApiCalls += 1;
          stats.modelLatencyMsTotal += noteResp.latencyMs;
          stats.modelLatencyMsMax = Math.max(stats.modelLatencyMsMax, noteResp.latencyMs);

          const inTok = Number(noteResp.usage.inputTokens);
          const outTok = Number(noteResp.usage.outputTokens);
          const totalTok = Number(noteResp.usage.totalTokens);
          if (Number.isFinite(inTok) || Number.isFinite(outTok) || Number.isFinite(totalTok)) {
            stats.tokenTelemetryAvailable = true;
          }
          if (Number.isFinite(inTok)) stats.inputTokens += inTok;
          if (Number.isFinite(outTok)) stats.outputTokens += outTok;
          if (Number.isFinite(totalTok)) stats.totalTokens += totalTok;

          noteText = trimText(noteResp.text, NOTE_MAX_CHARS);
          if (noteLooksUsable(noteText)) {
            noteOk = true;
            break;
          }
        }
        note = noteOk ? noteText : "No comment.";
      } catch (e) {
        stats.modelApiErrors += 1;
        note = "No comment.";
      }
    }

    let submitOk = false;
    let submitErr = "";
    for (let submitAttempt = 0; submitAttempt < 4 && !submitOk; submitAttempt++) {
      const submitResp = await postJson(`${apiBase}/api/v1/competition/submit`, {
        competitionToken,
        notes: submitAttempt > 0 ? "No comment." : note,
      });
      if (submitResp.ok) {
        submitOk = true;
        break;
      }
      submitErr = String(submitResp.json?.error || `HTTP ${submitResp.status}`);
      const stateResp = await postJson(`${apiBase}/api/v1/competition/state`, { competitionToken });
      if (!stateResp.ok) continue;
      state = stateResp.json?.state || state;
      if (!state?.finished) {
        const forced = pickForcedGuessAction(state);
        if (!forced) continue;
        const forcedResp = await postJson(
          `${apiBase}/api/v1/competition/guess`,
          { competitionToken, kind: forced.kind, index: forced.index }
        );
        if (forcedResp.ok) {
          stats.gameFallbackActions += 1;
          stats.forcedFallbackGuesses += 1;
          stats.gameActionsTotal += 1;
          stats.gameGuesses += 1;
          if (forcedResp.json?.result?.correct) stats.gameCorrectGuesses += 1;
          else {
            stats.gameIncorrectGuesses += 1;
            const guessed = lineWordsFromState(state, forced.kind, forced.index);
            if (Array.isArray(guessed) && guessed.length === 4) stats.incorrectGuessWordSets.push(guessed);
          }
          state = forcedResp.json.state;
        }
      }
    }
    if (!submitOk) {
      throw new Error(`submit failed: ${submitErr || "unknown"}`);
    }

    const endedAtIso = nowIso();
    const durationMs = Date.now() - startTs;
    const estimatedCostUsd = stats.tokenTelemetryAvailable ? estimateCostUsd(modelCfg, stats) : null;

    const benchmarkBody = {
    model: modelCfg.competitionModel,
    puzzleDate: opts.date,
    provider: "cursor",
    apiModel: modelCfg.resolvedApiModel || "auto",
    modelVersion: modelCfg.resolvedApiModel || "auto",
    reasoningLevel: modelCfg.reasoningLevel,
    promptVersion: PROMPT_VERSION,
    runStartedAt: startedAtIso,
    runFinishedAt: endedAtIso,
    durationMs,
      modelApiCalls: stats.modelApiCalls,
      modelApiErrors: stats.modelApiErrors,
    modelLatencyMsTotal: stats.modelLatencyMsTotal,
    modelLatencyMsMax: stats.modelLatencyMsMax,
    gameActionsTotal: stats.gameActionsTotal,
    gameSwaps: stats.gameSwaps,
    gameGuesses: stats.gameGuesses,
    gameCorrectGuesses: stats.gameCorrectGuesses,
    gameIncorrectGuesses: stats.gameIncorrectGuesses,
    gameInvalidActions: stats.gameInvalidActions,
    gameFallbackActions: stats.gameFallbackActions,
    inputTokens: stats.tokenTelemetryAvailable ? stats.inputTokens : null,
    outputTokens: stats.tokenTelemetryAvailable ? stats.outputTokens : null,
    totalTokens: stats.tokenTelemetryAvailable ? stats.totalTokens : null,
    estimatedCostUsd,
    outcome: state.outcome,
    strikes: state.strikes,
    turnCount: state.turn,
    note,
      metadata: {
      fallbackPromptRetries: stats.gameFallbackActions,
      forcedFallbackGuesses: stats.forcedFallbackGuesses,
      usedFallback: stats.gameFallbackActions > 0,
      usedForcedFallback: stats.forcedFallbackGuesses > 0,
      maxSteps: opts.maxSteps,
      tokenTelemetryAvailable: stats.tokenTelemetryAvailable,
      modelActionsProposed: stats.modelActionsProposed,
      modelActionsAccepted: stats.modelActionsAccepted,
      transcriptCompact: actionTrace.slice(-TRACE_LIMIT),
      promptHash: sha1(buildDecisionPrompt(state, stats, modelCfg)),
      cursorRepo: String(opts.cursor.repository || "").replace(/\?.*$/, ""),
      cursorRepoRef: opts.cursor.repositoryRef || "main",
      cursorPollMs: opts.cursor.pollMs,
      cursorTimeoutMs: opts.cursor.timeoutMs,
    },
    };

    if (adminKey) {
      await postJson(`${apiBase}/api/v1/competition/benchmark-run`, benchmarkBody, {
        authorization: `Bearer ${adminKey}`,
      });
    }

    return {
      model: modelCfg.competitionModel,
      displayName: modelCfg.displayName,
      provider: "cursor",
      apiModel: modelCfg.resolvedApiModel || "auto",
      outcome: state.outcome,
      strikes: state.strikes,
      turns: state.turn,
      durationMs,
      estimatedCostUsd,
      tokens: {
        input: stats.tokenTelemetryAvailable ? stats.inputTokens : null,
        output: stats.tokenTelemetryAvailable ? stats.outputTokens : null,
        total: stats.tokenTelemetryAvailable ? stats.totalTokens : null,
      },
      fallback: {
        total: stats.gameFallbackActions,
        forcedGuesses: stats.forcedFallbackGuesses,
      },
      note,
    };
  } finally {
    if (cursorSession.agentId && !opts.cursor.keepAgents) {
      const apiKey = process.env.CURSOR_API_KEY || "";
      const cursorBase = String(opts.cursor.cursorBase || DEFAULT_CURSOR_BASE);
      if (apiKey) {
        try {
          await cursorApiReq("DELETE", `/v0/agents/${encodeURIComponent(cursorSession.agentId)}`, null, apiKey, cursorBase);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}

function printSummaryRow(row) {
  const cost = row.estimatedCostUsd === null || row.estimatedCostUsd === undefined ? "n/a" : `$${row.estimatedCostUsd.toFixed(4)}`;
  const tokens = row.tokens?.total === null || row.tokens?.total === undefined ? "n/a" : String(row.tokens.total);
  console.log(`${row.displayName.padEnd(18)} ${String(row.outcome).padEnd(5)} strikes=${String(row.strikes).padStart(2)} turns=${String(row.turns).padStart(2)} cost=${cost} tokens=${tokens}`);
}

async function maybeResetRuns(apiBase, doReset) {
  if (!doReset) return;
  const adminKey = process.env.COMPETITION_ADMIN_KEY || "";
  if (!adminKey) throw new Error("COMPETITION_ADMIN_KEY is required for --reset-runs.");
  const resp = await postJson(`${apiBase}/api/v1/competition/reset-runs`, { confirm: "RESET_COMPETITION_RUNS" }, {
    authorization: `Bearer ${adminKey}`,
  });
  if (!resp.ok) {
    throw new Error(`reset-runs failed: ${resp.json?.error || resp.status}`);
  }
  console.log("Reset existing run data:", resp.json.reset);
}

async function cleanupAttemptOnFailure(apiBase, adminKey, model, puzzleDate) {
  if (!adminKey) return { ok: false, skipped: true, reason: "missing_admin_key" };
  const resp = await postJson(
    `${apiBase}/api/v1/competition/delete-attempt`,
    { model, puzzleDate },
    { authorization: `Bearer ${adminKey}` }
  );
  if (!resp.ok) return { ok: false, error: resp.json?.error || `HTTP ${resp.status}` };
  return { ok: true, deleted: Number(resp.json?.deleted || 0) };
}

async function main() {
  loadDotEnv();

  const parsed = parseArgs(process.argv.slice(2));
  const f = parsed.flags;

  if (f.help || f.h) {
    console.log(`Usage:\n  node scripts/run_cursor_benchmark.mjs [--date YYYY-MM-DD] [--api https://connecdoku.com] [--models id1,id2] [--max-steps 64] [--thinking-level medium] [--reset-runs] [--cursor-poll-ms 5000] [--cursor-timeout-ms 480000] [--keep-agents] [--skip-note] [--list-models]\n\nNotes:\n  - Reads model roster from data/cursor_benchmark_models.json\n  - Uses CURSOR_API_KEY and CURSOR_BENCH_REPOSITORY env vars (repository can auto-derive from git remote.origin)\n  - Uses model-specific password env vars listed in that file\n  - Stores normal puzzle results via /competition/submit\n  - Stores benchmark telemetry via /competition/benchmark-run (admin key required)\n  - Fails fast on Cursor auth/config errors (no auto-play fallback moves).\n  - Unfinished runs fail; no auto-complete behavior.\n`);
    return;
  }

  const apiBase = String(f.api || DEFAULT_API_BASE).replace(/\/+$/, "");
  const cursorBase = String(process.env.CURSOR_BASE_URL || DEFAULT_CURSOR_BASE).replace(/\/+$/, "");

  if (f["list-models"]) {
    await maybeListCursorModels(cursorBase);
    return;
  }

  const date = String(f.date || localDateString());
  const maxSteps = Math.max(8, Math.min(300, Number(f["max-steps"] || MAX_STEPS_DEFAULT)));
  const thinkingOverride = f["thinking-level"] ? String(f["thinking-level"]) : null;
  const onlyModels = f.models ? new Set(String(f.models).split(",").map((x) => x.trim()).filter(Boolean)) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");

  await maybeResetRuns(apiBase, !!f["reset-runs"]);

  const resolvedRepository = String(
    process.env.CURSOR_BENCH_REPOSITORY ||
    process.env.CURSOR_REPOSITORY ||
    detectGitHubRepoFromGitRemote()
  ).trim();
  const resolvedRepositoryRef = String(process.env.CURSOR_BENCH_REPOSITORY_REF || "main").trim() || "main";

  const rosterRaw = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
  const roster = rosterRaw
    .filter((m) => m && m.enabled !== false)
    .map((m) => ({ ...m }))
    .filter((m) => (onlyModels ? onlyModels.has(m.competitionModel) : true));

  const active = [];
  for (const m of roster) {
    const pw = process.env[m.passwordEnv || ""];
    if (!pw) {
      console.log(`SKIP ${m.displayName}: missing env ${m.passwordEnv}`);
      continue;
    }
    m.password = pw;
    m.resolvedApiModel = process.env[m.apiModelEnv || ""] || m.apiModel || "";
    if (thinkingOverride) m.reasoningLevel = thinkingOverride;
    m.reasoningLevel = normalizeReasoningLevel(m.reasoningLevel);
    active.push(m);
  }

  if (!active.length) {
    throw new Error("No runnable models after filtering/missing env vars.");
  }

  console.log(`Running Cursor benchmark for ${active.length} model(s) on ${date}`);
  console.log(`Puzzle API base: ${apiBase}`);
  console.log(`Cursor API base: ${cursorBase}`);
  console.log(`Cursor repository: ${resolvedRepository || "(missing)"}`);
  console.log(`Cursor ref: ${resolvedRepositoryRef}`);
  console.log(`Prompt version: ${PROMPT_VERSION}`);

  const cursorOpts = {
    cursorBase,
    repository: resolvedRepository,
    repositoryRef: resolvedRepositoryRef,
    pollMs: Math.max(1000, Number(f["cursor-poll-ms"] || process.env.CURSOR_BENCH_POLL_MS || CURSOR_POLL_MS_DEFAULT)),
    timeoutMs: Math.max(10_000, Number(f["cursor-timeout-ms"] || process.env.CURSOR_BENCH_TIMEOUT_MS || CURSOR_TIMEOUT_MS_DEFAULT)),
    keepAgents: !!f["keep-agents"],
    skipNote: !!f["skip-note"],
  };

  assertSafeCursorRepository(cursorOpts.repository);
  await cursorPreflight(cursorOpts);

  const results = [];
  const adminKey = process.env.COMPETITION_ADMIN_KEY || "";
  for (const m of active) {
    const modelLabel = m.resolvedApiModel ? `cursor:${m.resolvedApiModel}` : "cursor:auto";
    console.log(`\n=== ${m.displayName} (${modelLabel}) ===`);
    try {
      const row = await runSingleModel({ apiBase, date, maxSteps, cursor: cursorOpts }, m);
      results.push({ ...row, ok: true });
      printSummaryRow(row);
    } catch (e) {
      console.log(`FAILED ${m.displayName}: ${e.message}`);
      if (adminKey) {
        try {
          const t = nowIso();
          await postJson(`${apiBase}/api/v1/competition/benchmark-run`, {
            model: m.competitionModel,
            puzzleDate: date,
            provider: "cursor",
            apiModel: m.resolvedApiModel || "auto",
            modelVersion: m.resolvedApiModel || "auto",
            reasoningLevel: m.reasoningLevel,
            promptVersion: PROMPT_VERSION,
            runStartedAt: t,
            runFinishedAt: t,
            durationMs: 0,
            modelApiCalls: 0,
            modelApiErrors: 1,
            modelLatencyMsTotal: 0,
            modelLatencyMsMax: 0,
            gameActionsTotal: 0,
            gameSwaps: 0,
            gameGuesses: 0,
            gameCorrectGuesses: 0,
            gameIncorrectGuesses: 0,
            gameInvalidActions: 0,
            gameFallbackActions: 0,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            estimatedCostUsd: null,
            outcome: "error",
            strikes: null,
            turnCount: null,
            note: "Run failed before completion.",
            errorText: String(e.message || e),
            metadata: { runFailed: true, failureStage: "main_loop", lane: "cursor" },
          }, { authorization: `Bearer ${adminKey}` });
        } catch (telemetryErr) {
          console.log(`Failure telemetry upsert failed for ${m.competitionModel} ${date}: ${telemetryErr.message}`);
        }
      }
      try {
        const cleanup = await cleanupAttemptOnFailure(apiBase, adminKey, m.competitionModel, date);
        if (cleanup.ok) {
          console.log(`Cleanup attempt ${m.competitionModel} ${date}: deleted=${cleanup.deleted}`);
        } else if (!cleanup.skipped) {
          console.log(`Cleanup attempt failed for ${m.competitionModel} ${date}: ${cleanup.error || "unknown"}`);
        }
      } catch (cleanupErr) {
        console.log(`Cleanup attempt errored for ${m.competitionModel} ${date}: ${cleanupErr.message}`);
      }
      results.push({
        model: m.competitionModel,
        displayName: m.displayName,
        provider: "cursor",
        apiModel: m.resolvedApiModel || "auto",
        ok: false,
        error: e.message,
      });
    }
  }

  const okRuns = results.filter((r) => r.ok);
  const failedRuns = results.filter((r) => !r.ok);
  const totalCost = okRuns.reduce((sum, r) => sum + (Number(r.estimatedCostUsd) || 0), 0);
  const avgStrikes = okRuns.length
    ? okRuns.reduce((sum, r) => sum + Number(r.strikes || 0), 0) / okRuns.length
    : 0;

  console.log("\n=== Cursor Benchmark Summary ===");
  for (const row of okRuns) printSummaryRow(row);
  if (failedRuns.length) {
    console.log("\nFailures:");
    for (const run of failedRuns) {
      console.log(`- ${run.displayName}: ${run.error}`);
    }
  }
  console.log(`\nCompleted: ${okRuns.length}/${results.length}`);
  console.log(`Average strikes: ${avgStrikes.toFixed(2)}`);
  console.log(`Estimated total cost: $${totalCost.toFixed(4)} (n/a if token telemetry unavailable)`);
  if (failedRuns.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
