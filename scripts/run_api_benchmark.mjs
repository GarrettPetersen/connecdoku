#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const MODELS_FILE = path.join(ROOT, "data", "api_benchmark_models.json");
const DEFAULT_API_BASE = "https://connecdoku.com";
const PROMPT_VERSION = "api-benchmark-v1";
const MAX_STEPS_DEFAULT = 64;
const MAX_ACTION_RETRIES = 3;
const NOTE_MAX_CHARS = 500;
const SCRATCHPAD_MAX_CHARS = 3000;
const TRACE_LIMIT = 200;
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

function httpTimeoutMs() {
  return Math.max(5000, Number(process.env.API_BENCH_HTTP_TIMEOUT_MS || HTTP_TIMEOUT_MS_DEFAULT));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body, headers = {}, timeoutOverrideMs = null) {
  const started = Date.now();
  const { res, json } = await fetchJsonWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  }, timeoutOverrideMs == null ? httpTimeoutMs() : Math.max(5000, Number(timeoutOverrideMs)));
  const elapsedMs = Date.now() - started;
  return { ok: res.ok && json.ok !== false, status: res.status, json, elapsedMs };
}

async function getJson(url, headers = {}, timeoutOverrideMs = null) {
  const started = Date.now();
  const { res, json } = await fetchJsonWithTimeout(
    url,
    { method: "GET", headers },
    timeoutOverrideMs == null ? httpTimeoutMs() : Math.max(5000, Number(timeoutOverrideMs))
  );
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

function extractTextFromOpenAIStyle(respJson) {
  const choice = respJson?.choices?.[0];
  const msg = choice?.message;
  if (!msg) return "";
  if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
  if (Array.isArray(msg.content)) {
    const contentText = msg.content.map((x) => (typeof x === "string" ? x : (x?.text || ""))).join("\n").trim();
    if (contentText) return contentText;
  }
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) return msg.reasoning_content;
  if (typeof choice?.text === "string" && choice.text.trim()) return choice.text;
  return "";
}

function extractTextFromOpenAIResponses(respJson) {
  if (!respJson || typeof respJson !== "object") return "";
  if (typeof respJson.output_text === "string") return respJson.output_text;
  const out = Array.isArray(respJson.output) ? respJson.output : [];
  const parts = [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n");
}

function parseJsonObjectLoose(text) {
  const src = String(text || "").trim();
  if (!src) return null;
  try {
    return JSON.parse(src);
  } catch {
    // Extract first balanced JSON object.
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

function parseSlashCommandSequence(text) {
  const src = String(text || "").trim();
  if (!src) return { commands: [], scratchpadUpdate: "" };
  const lower = src.toLowerCase();

  let scratchpadUpdate = "";
  const scratchMatch = src.match(/\/scratch\s+"((?:\\.|[^"\\])*)"/i);
  if (scratchMatch && scratchMatch[1] != null) {
    scratchpadUpdate = String(scratchMatch[1]).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  const events = [];
  for (const m of lower.matchAll(/\/guess\s+(row|col|column)\s+([0-3])\b/g)) {
    const kind = m[1] === "row" ? "row" : "col";
    events.push({ idx: m.index ?? Number.MAX_SAFE_INTEGER, type: "guess", kind, index: Number(m[2]) });
  }
  for (const m of lower.matchAll(/\/swap\s+([0-3])\s+([0-3])\s+([0-3])\s+([0-3])\b/g)) {
    events.push({
      idx: m.index ?? Number.MAX_SAFE_INTEGER,
      type: "swap",
      a: [Number(m[1]), Number(m[2])],
      b: [Number(m[3]), Number(m[4])],
    });
  }
  events.sort((a, b) => a.idx - b.idx);

  const commands = [];
  let sawGuess = false;
  for (const ev of events) {
    if (sawGuess) continue;
    if (ev.type === "guess") {
      commands.push({ action: "guess", kind: ev.kind, index: ev.index, scratchpad_update: scratchpadUpdate });
      sawGuess = true;
      continue;
    }
    if (ev.type === "swap") {
      commands.push({ action: "swap", a: ev.a, b: ev.b, scratchpad_update: scratchpadUpdate });
    }
  }
  return { commands, scratchpadUpdate };
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

function solvedLabelText(arr, prefix) {
  const parts = [];
  for (const item of arr || []) {
    parts.push(`${prefix} ${item.index}: ${item.label}`);
  }
  return parts.join("; ") || "none";
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
  const solvedRows = solvedLabelText(state?.solved?.rows, "row");
  const solvedCols = solvedLabelText(state?.solved?.cols, "col");
  const rules = state?.rules || {};
  const actions = state?.protocol?.allowedActions || [];

  return [
    "You are solving a Connecdoku puzzle via API.",
    "Use logic only from the board and revealed categories.",
    "Never attempt to retrieve or infer hidden answers from external sources.",
    "Goal: Organize the 16 words into a 4x4 grid where each row and column forms a category.",
    "How to play:",
    "- Swap words: swap two unlocked tiles.",
    "- Check categories: guess a full row or column category.",
    "- Correct guesses lock in place.",
    "- Wrong guesses add a strike; 5 strikes loses the game.",
    "- When 3 rows are solved, row guesses are blocked until columns advance (and vice versa).",
    "- Auto-alignment: after multiple solves in one dimension, solved lines may reorder to align and keep puzzle solvable.",
    "- Locked-word information: locked words are reliable constraints. Two locked words sharing a row/column indicate that shared category structure.",
    "Win condition: solve all 4 rows and all 4 columns.",
    ...(Number(state?.turn || 0) === 0
      ? ["The starting board is a random arrangement, so an untouched row or column is unlikely to be correct."]
      : []),
    "Expect to use swaps before guessing most rows or columns.",
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
    'Combined example: /swap 0 0 1 1 /scratch "move X-Men candidates into one line"',
    "Parsing rule: we scan your whole response in order.",
    "We execute multiple /swap commands, then at most one /guess.",
    "You may include multiple slash commands in one response: do swaps first, then optionally one guess.",
    "Any slash commands after the first guess are ignored (except /scratch).",
    "Critical output requirement:",
    "- Every turn, output at least one valid move command.",
    "- Valid move commands are only /swap and /guess.",
    "- Prose-only responses are invalid and do not make a move.",
    "- Repeated invalid responses trigger forced fallback guesses and can cause a loss.",
    'Persisted means: the first /scratch "..." is saved, carried into future turns, and included in end-of-run note context.',
    "You may include normal text, but only valid slash commands affect state.",
    "Prioritize legal actions and avoid repeating clearly bad guesses.",
    "",
    `Model: ${modelMeta.displayName} (${modelMeta.provider})`,
    `Puzzle date: ${state?.puzzle?.date}`,
    `Turn: ${state?.turn}, Strikes: ${state?.strikes}/${state?.maxStrikes}`,
    `Can guess row: ${rules.canGuessRow}, can guess col: ${rules.canGuessCol}`,
    "Allowed output actions: /swap and /guess.",
    "Output rule: include at least one valid slash move command in your response.",
    `Solved rows: ${solvedRows}`,
    `Solved cols: ${solvedCols}`,
    "Board:",
    board,
    "",
    `Invalid actions so far: ${metrics.gameInvalidActions}`,
    `Fallback actions so far: ${metrics.gameFallbackActions}`,
    `incorrect guesses: ${JSON.stringify(metrics.incorrectGuessWordSets || [])}`,
    `scratchpad: ${metrics.scratchpad || "(empty)"}`,
  ].join("\n");
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

function buildNotePrompt(state, runStats) {
  const solved = finalSolvedLabels(state);
  const revealedAfterLoss = revealedAfterLossLabels(state);
  return [
    "Write only the final note text for a public benchmark table.",
    "Do not explain the task, restate these instructions, or mention the prompt.",
    "Do not output move commands, JSON, code blocks, or labels.",
    "Do not output analysis before the note.",
    "Your entire response must be the note text itself.",
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
    "No analysis. No preamble. No commands. No JSON.",
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

function buildRepairPrompt(basePrompt, reason, lastOutput) {
  const details = trimText(lastOutput || "", 280);
  return [
    basePrompt,
    "",
    "Your previous response was invalid for this API turn.",
    `Reason: ${reason}`,
    details ? `You said: ${details}` : "You said: (empty)",
    "Now output a valid slash move command. Prose without a move is invalid.",
    'Accepted format: /swap r1 c1 r2 c2 OR /guess row i OR /guess col i, optional /scratch "..."',
    'Persisted means: /scratch text is saved for future turns and note context.',
    "Reply again with at least one valid slash move command.",
  ].join("\n");
}

function normalizeUsage(provider, json) {
  if (!json || typeof json !== "object") return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  if (provider === "anthropic") {
    const inputTokens = Number(json?.usage?.input_tokens || 0);
    const outputTokens = Number(json?.usage?.output_tokens || 0);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  if (provider === "google") {
    const u = json?.usageMetadata || {};
    const inputTokens = Number(u.promptTokenCount || u.cachedContentTokenCount || 0);
    const outputTokens = Number(u.candidatesTokenCount || 0);
    const totalTokens = Number(u.totalTokenCount || (inputTokens + outputTokens));
    return { inputTokens, outputTokens, totalTokens };
  }

  // OpenAI-compatible
  const usage = json?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || (inputTokens + outputTokens));
  return { inputTokens, outputTokens, totalTokens };
}

function estimateCostUsd(modelCfg, usage) {
  const inRate = Number(modelCfg.inputPricePerMTok || 0);
  const outRate = Number(modelCfg.outputPricePerMTok || 0);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;
  const inputCost = (Number(usage.inputTokens || 0) / 1_000_000) * inRate;
  const outputCost = (Number(usage.outputTokens || 0) / 1_000_000) * outRate;
  return Number((inputCost + outputCost).toFixed(8));
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

function geminiThinkingBudgetFor(level) {
  const normalized = normalizeReasoningLevel(level);
  if (normalized === "none") return 0;
  if (normalized === "low") return 512;
  if (normalized === "medium") return 2048;
  if (normalized === "high") return 8192;
  return 12288; // xhigh
}

function openAiErrorMessage(resp) {
  return String(resp?.json?.error?.message || resp?.json?.error || "unknown");
}

function isOpenAiUnsupportedTemperature(resp) {
  const msg = openAiErrorMessage(resp).toLowerCase();
  return resp?.status === 400 && msg.includes("temperature") && msg.includes("unsupported");
}

function isOpenAiUnsupportedReasoningEffort(resp) {
  const msg = openAiErrorMessage(resp).toLowerCase();
  return resp?.status === 400 && msg.includes("reasoning_effort") && msg.includes("unsupported");
}

function isOpenAiUnsupportedResponseFormat(resp) {
  const msg = openAiErrorMessage(resp).toLowerCase();
  return resp?.status === 400 && msg.includes("response_format") && msg.includes("unsupported");
}

function isOpenAiNotChatModel(resp) {
  const msg = openAiErrorMessage(resp).toLowerCase();
  return resp?.status === 404 && msg.includes("not a chat model");
}

function parseRetryDelayMs(message, fallbackMs = 65000) {
  const text = String(message || "");
  const secMatch = text.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (secMatch) {
    const sec = Number(secMatch[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  }
  return fallbackMs;
}

async function callProviderModel(cfg, prompt, mode = "action") {
  const provider = cfg.provider;
  const model = cfg.resolvedApiModel;
  const reasoningLevel = normalizeReasoningLevel(cfg.reasoningLevel || "medium");
  const temperature = Number(cfg.temperature ?? 0.2);

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing.");
    const baseBody = {
      model,
      messages: [
        { role: "system", content: mode === "note" ? "Return plain text only." : "You are a careful puzzle solver. Follow the user's command protocol exactly." },
        { role: "user", content: prompt },
      ],
    };
    let body = {
      ...baseBody,
      temperature,
    };
    // Some models support this; harmless if ignored.
    body.reasoning_effort = reasoningLevel;

    let resp = await postJson("https://api.openai.com/v1/chat/completions", body, {
      authorization: `Bearer ${apiKey}`,
    });
    if (!resp.ok && isOpenAiUnsupportedTemperature(resp)) {
      body = { ...body };
      delete body.temperature;
      resp = await postJson("https://api.openai.com/v1/chat/completions", body, {
        authorization: `Bearer ${apiKey}`,
      });
    }
    if (!resp.ok && isOpenAiUnsupportedReasoningEffort(resp)) {
      body = { ...body };
      delete body.reasoning_effort;
      resp = await postJson("https://api.openai.com/v1/chat/completions", body, {
        authorization: `Bearer ${apiKey}`,
      });
    }
    if (!resp.ok && isOpenAiNotChatModel(resp)) {
      const responsesBody = {
        model,
        input: [
          { role: "system", content: mode === "note" ? "Return plain text only." : "You are a careful puzzle solver. Follow the user's command protocol exactly." },
          { role: "user", content: prompt },
        ],
      };
      const rr = await postJson("https://api.openai.com/v1/responses", responsesBody, {
        authorization: `Bearer ${apiKey}`,
      });
      if (!rr.ok) {
        throw new Error(`OpenAI responses error (${rr.status}): ${rr.json?.error?.message || rr.json?.error || "unknown"}`);
      }
      return {
        text: extractTextFromOpenAIResponses(rr.json),
        usage: normalizeUsage("openai", rr.json),
        latencyMs: rr.elapsedMs,
        providerModel: rr.json?.model || model,
      };
    }
    if (!resp.ok) throw new Error(`OpenAI error (${resp.status}): ${resp.json?.error?.message || resp.json?.error || "unknown"}`);
    return {
      text: extractTextFromOpenAIStyle(resp.json),
      usage: normalizeUsage("openai", resp.json),
      latencyMs: resp.elapsedMs,
      providerModel: resp.json?.model || model,
    };
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing.");
    const body = {
      model,
      max_tokens: mode === "note" ? 180 : 240,
      system: "For note mode, plain text only. For action mode, follow the user's command protocol exactly.",
      messages: [{ role: "user", content: prompt }],
    };
    const resp = await postJson("https://api.anthropic.com/v1/messages", body, {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    });
    if (!resp.ok) throw new Error(`Anthropic error (${resp.status}): ${resp.json?.error?.message || resp.json?.error || "unknown"}`);
    const text = (resp.json?.content || [])
      .map((c) => (c?.type === "text" ? c.text : ""))
      .join("\n");
    return {
      text,
      usage: normalizeUsage("anthropic", resp.json),
      latencyMs: resp.elapsedMs,
      providerModel: resp.json?.model || model,
    };
  }

  if (provider === "google") {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY missing.");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        responseMimeType: "text/plain",
        thinkingConfig: {
          thinkingBudget: geminiThinkingBudgetFor(reasoningLevel),
        },
      },
    };
    const maxAttempts = Math.max(1, Number(process.env.GOOGLE_BENCH_MAX_RETRIES || 5));
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await postJson(endpoint, body);
      if (resp.ok) {
        const text = resp.json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("\n") || "";
        return {
          text,
          usage: normalizeUsage("google", resp.json),
          latencyMs: resp.elapsedMs,
          providerModel: model,
        };
      }
      const msg = resp.json?.error?.message || resp.json?.error || "unknown";
      lastErr = `Google error (${resp.status}): ${msg}`;
      if (resp.status !== 429 || attempt === maxAttempts) {
        throw new Error(lastErr);
      }
      const baseDelay = parseRetryDelayMs(msg, 65000);
      const jitterMs = Math.floor(Math.random() * 2000);
      const waitMs = baseDelay + jitterMs;
      console.log(`Google 429 for ${model}; retry ${attempt}/${maxAttempts} after ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
    throw new Error(lastErr || "Google request failed.");
  }

  if (provider === "xai" || provider === "moonshot" || provider === "cursor") {
    const map = {
      xai: { key: process.env.XAI_API_KEY, base: process.env.XAI_BASE_URL || "https://api.x.ai/v1" },
      moonshot: { key: process.env.MOONSHOT_API_KEY, base: process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1" },
      cursor: { key: process.env.CURSOR_API_KEY, base: process.env.CURSOR_BASE_URL || "" },
    };
    const entry = map[provider];
    if (!entry.key) throw new Error(`${provider.toUpperCase()} API key missing.`);
    if (!entry.base) throw new Error(`${provider.toUpperCase()} base URL missing. Set ${provider.toUpperCase()}_BASE_URL.`);

    const body = {
      model,
      max_tokens: mode === "note" ? 180 : 260,
      temperature,
      messages: [
        { role: "system", content: "Follow the user's command protocol exactly. For note mode, plain text only." },
        { role: "user", content: prompt },
      ],
    };
    if (provider === "xai") {
      // xAI documents reasoning_effort on grok-4.3.
      body.reasoning_effort = reasoningLevel === "xhigh" ? "high" : reasoningLevel;
    }
    const providerTimeoutMs = provider === "moonshot" ? Math.max(httpTimeoutMs(), 300000) : httpTimeoutMs();
    const resp = await postJson(`${entry.base.replace(/\/+$/, "")}/chat/completions`, body, {
      authorization: `Bearer ${entry.key}`,
    }, providerTimeoutMs);
    if (!resp.ok) throw new Error(`${provider} error (${resp.status}): ${resp.json?.error?.message || resp.json?.error || "unknown"}`);

    const extractedText = extractTextFromOpenAIStyle(resp.json);
    return {
      text: extractedText,
      usage: normalizeUsage(provider, resp.json),
      latencyMs: resp.elapsedMs,
      providerModel: resp.json?.model || model,
    };
  }

  throw new Error(`Unsupported provider '${provider}'.`);
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
    consecutiveSwaps: 0,
    forcedFallbackGuesses: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    lastModelApiError: "",
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
      provider: modelCfg.provider,
      apiModel: modelCfg.resolvedApiModel,
      outcome: startResp.json?.state?.outcome || "lost",
      strikes: Number(startResp.json?.state?.strikes ?? startClass.strikes ?? 0),
      turns: Number(startResp.json?.state?.turn ?? startClass.turnCount ?? 0),
      durationMs: 0,
      estimatedCostUsd: 0,
      tokens: { input: 0, output: 0, total: 0 },
      note: "Skipped: locked attempt already finished.",
      skipped: true,
    };
  }

  let state = startResp.json.state;
  const competitionToken = startResp.json.competitionToken;
  if (!competitionToken) throw new Error("competitionToken missing from start response.");

  const actionTrace = [];
  let step = 0;

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
        const modelResp = await callProviderModel(modelCfg, prompt, "action");
        stats.modelApiCalls += 1;
        stats.modelLatencyMsTotal += modelResp.latencyMs;
        stats.modelLatencyMsMax = Math.max(stats.modelLatencyMsMax, modelResp.latencyMs);
        stats.inputTokens += Number(modelResp.usage.inputTokens || 0);
        stats.outputTokens += Number(modelResp.usage.outputTokens || 0);
        stats.totalTokens += Number(modelResp.usage.totalTokens || 0);
        modelRespText = modelResp.text;
        lastModelOutput = modelRespText;
        stepSawModelResponse = true;

        const parsed = parseJsonObjectLoose(modelResp.text);
        action = normalizeAction(parsed);
        let parsedSequence = [];
        if (!action) {
          const seq = parseSlashCommandSequence(modelResp.text);
          parsedSequence = (seq.commands || []).map((x) => normalizeAction(x)).filter(Boolean);
          if (parsedSequence.length) action = parsedSequence[0];
        }
      } catch (e) {
        stats.modelApiErrors += 1;
        stats.gameInvalidActions += 1;
        stats.lastModelApiError = String(e?.message || e || "");
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
        const snippet = trimText(modelRespText, 200);
        repairReason = snippet
          ? `Response did not include a valid slash move command. Output: ${snippet}`
          : "Response did not include a valid slash move command.";
        actionTrace.push({
          step,
          attempt,
          reason: "invalid_action_json",
          modelOutput: trimText(modelRespText, 280),
        });
        if (attempt < MAX_ACTION_RETRIES - 1) stats.gameFallbackActions += 1;
        continue;
      }

      const commandsToRun = [];
      const parsedSeq = parseSlashCommandSequence(modelRespText).commands || [];
      if (action) {
        commandsToRun.push(action);
        if (parsedSeq.length > 1) {
          for (let i = 1; i < parsedSeq.length; i++) {
            const nx = normalizeAction(parsedSeq[i]);
            if (nx) commandsToRun.push(nx);
          }
        }
      }
      if (!commandsToRun.length) {
        stats.gameInvalidActions += 1;
        repairReason = "No valid command found.";
        continue;
      }

      let playResp = null;
      let lastAction = null;
      for (const cmd of commandsToRun) {
        lastAction = cmd;
        stats.gameActionsTotal += 1;
        if (cmd.action === "swap") {
          stats.gameSwaps += 1;
          stats.consecutiveSwaps += 1;
        } else {
          stats.gameGuesses += 1;
          stats.consecutiveSwaps = 0;
        }
        playResp = cmd.action === "swap"
          ? await postJson(`${apiBase}/api/v1/competition/swap`, { competitionToken, a: cmd.a, b: cmd.b })
          : await postJson(`${apiBase}/api/v1/competition/guess`, { competitionToken, kind: cmd.kind, index: cmd.index });
        if (!playResp.ok) break;

        if (cmd.scratchpadUpdate) stats.scratchpad = appendScratchpad(stats.scratchpad, cmd.scratchpadUpdate);
        if (cmd.action === "guess") {
          if (playResp.json?.result?.correct) stats.gameCorrectGuesses += 1;
          else {
            stats.gameIncorrectGuesses += 1;
            const guessed = lineWordsFromState(state, cmd.kind, cmd.index);
            if (Array.isArray(guessed) && guessed.length === 4) stats.incorrectGuessWordSets.push(guessed);
          }
        }
        const guessedWords = cmd.action === "guess" ? lineWordsFromState(state, cmd.kind, cmd.index) : null;
        state = playResp.json.state;
        actionTrace.push({
          step,
          attempt,
          reason: "action_accepted",
          action: cmd,
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
      }

      if (!playResp.ok) {
        stats.gameInvalidActions += 1;
        const apiError = playResp.json?.error || `HTTP ${playResp.status}`;
        const guessedWords = lastAction?.action === "guess" ? lineWordsFromState(state, lastAction.kind, lastAction.index) : null;
        repairReason = `Action rejected by game API: ${apiError}`;
        actionTrace.push({
          step,
          attempt,
          reason: "api_rejected",
          action: lastAction || action,
          guessedWords,
          modelOutput: trimText(modelRespText, 280),
          apiError,
        });
        // A syntactically valid action was proposed; surface game feedback and move on.
        stepSolved = true;
        break;
      }
      stepSolved = true;
      break;
    }

    if (!stepSolved) {
      if (!stepSawModelResponse) {
        const suffix = stats.lastModelApiError ? ` Last API error: ${stats.lastModelApiError}` : "";
        throw new Error(`Model API unavailable after retries at step ${step}.${suffix}`);
      }
      if (stats.modelApiCalls < 1) {
        const suffix = stats.lastModelApiError ? ` Last API error: ${stats.lastModelApiError}` : "";
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

  if (!state.finished) {
    if (stats.modelApiCalls < 1) {
      const suffix = stats.lastModelApiError ? ` Last API error: ${stats.lastModelApiError}` : "";
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
      throw new Error(`Model did not finish puzzle within ${opts.maxSteps} turns.`);
    }
  }

  if (stats.modelApiCalls < 1) {
    const suffix = stats.lastModelApiError ? ` Last API error: ${stats.lastModelApiError}` : "";
    throw new Error(`No successful model API calls.${suffix}`);
  }

  let note = "";
  try {
    const notePrompt = buildNotePrompt(state, stats);
    let noteText = "";
    let noteOk = false;
    const maxAttempts = modelCfg.provider === "moonshot" ? 4 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let prompt = notePrompt;
      if (attempt === 1) {
        prompt = buildNoteRepairPrompt(notePrompt, "Previous note was prompt echo or otherwise invalid.", noteText);
      } else if (attempt >= 2) {
        prompt = buildForcedOneSentenceNotePrompt(state, stats);
      }
      const noteResp = await callProviderModel(modelCfg, prompt, "note");
      stats.modelApiCalls += 1;
      stats.modelLatencyMsTotal += noteResp.latencyMs;
      stats.modelLatencyMsMax = Math.max(stats.modelLatencyMsMax, noteResp.latencyMs);
      stats.inputTokens += Number(noteResp.usage.inputTokens || 0);
      stats.outputTokens += Number(noteResp.usage.outputTokens || 0);
      stats.totalTokens += Number(noteResp.usage.totalTokens || 0);
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
  const estimatedCostUsd = estimateCostUsd(modelCfg, stats);

  const benchmarkBody = {
    model: modelCfg.competitionModel,
    puzzleDate: opts.date,
    provider: modelCfg.provider,
    apiModel: modelCfg.resolvedApiModel,
    modelVersion: modelCfg.resolvedApiModel,
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
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    totalTokens: stats.totalTokens,
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
      transcriptCompact: actionTrace.slice(-TRACE_LIMIT),
      promptHash: sha1(buildDecisionPrompt(state, stats, modelCfg)),
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
    provider: modelCfg.provider,
    apiModel: modelCfg.resolvedApiModel,
    outcome: state.outcome,
    strikes: state.strikes,
    turns: state.turn,
    durationMs,
    estimatedCostUsd,
    tokens: {
      input: stats.inputTokens,
      output: stats.outputTokens,
      total: stats.totalTokens,
    },
    fallback: {
      total: stats.gameFallbackActions,
      forcedGuesses: stats.forcedFallbackGuesses,
    },
    note,
  };
}

function printSummaryRow(row) {
  const cost = row.estimatedCostUsd === null || row.estimatedCostUsd === undefined ? "n/a" : `$${row.estimatedCostUsd.toFixed(4)}`;
  console.log(`${row.displayName.padEnd(18)} ${String(row.outcome).padEnd(5)} strikes=${String(row.strikes).padStart(2)} turns=${String(row.turns).padStart(2)} cost=${cost} tokens=${row.tokens.total}`);
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
    console.log(`Usage:\n  node scripts/run_api_benchmark.mjs [--date YYYY-MM-DD] [--api https://connecdoku.com] [--models id1,id2] [--max-steps 64] [--thinking-level medium] [--reset-runs]\n\nNotes:\n  - Reads model roster from data/api_benchmark_models.json\n  - Uses model-specific password env vars listed in that file\n  - Stores normal puzzle results via /competition/submit\n  - Stores benchmark telemetry via /competition/benchmark-run (admin key required)\n`);
    return;
  }

  const apiBase = String(f.api || DEFAULT_API_BASE).replace(/\/+$/, "");
  const date = String(f.date || localDateString());
  const maxSteps = Math.max(8, Math.min(300, Number(f["max-steps"] || MAX_STEPS_DEFAULT)));
  const thinkingOverride = f["thinking-level"] ? String(f["thinking-level"]) : null;
  const onlyModels = f.models ? new Set(String(f.models).split(",").map((x) => x.trim()).filter(Boolean)) : null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");

  await maybeResetRuns(apiBase, !!f["reset-runs"]);

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
    m.resolvedApiModel = process.env[m.apiModelEnv || ""] || m.apiModel;
    if (thinkingOverride) m.reasoningLevel = thinkingOverride;
    active.push(m);
  }

  if (!active.length) {
    throw new Error("No runnable models after filtering/missing env vars.");
  }

  console.log(`Running API benchmark for ${active.length} model(s) on ${date}`);
  console.log(`API base: ${apiBase}`);
  console.log(`Prompt version: ${PROMPT_VERSION}`);

  const results = [];
  const adminKey = process.env.COMPETITION_ADMIN_KEY || "";
  for (const m of active) {
    console.log(`\n=== ${m.displayName} (${m.provider}:${m.resolvedApiModel}) ===`);
    try {
      const row = await runSingleModel({ apiBase, date, maxSteps }, m);
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
            provider: m.provider,
            apiModel: m.resolvedApiModel,
            modelVersion: m.resolvedApiModel,
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
            metadata: { runFailed: true, failureStage: "main_loop" },
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
        provider: m.provider,
        apiModel: m.resolvedApiModel,
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

  console.log("\n=== Benchmark Summary ===");
  for (const row of okRuns) printSummaryRow(row);
  if (failedRuns.length) {
    console.log("\nFailures:");
    for (const f of failedRuns) {
      console.log(`- ${f.displayName}: ${f.error}`);
    }
  }
  console.log(`\nCompleted: ${okRuns.length}/${results.length}`);
  console.log(`Average strikes: ${avgStrikes.toFixed(2)}`);
  console.log(`Estimated total cost: $${totalCost.toFixed(4)}`);
  if (failedRuns.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
