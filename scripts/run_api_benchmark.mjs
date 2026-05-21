#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const MODELS_FILE = path.join(ROOT, "data", "api_benchmark_models.json");
const DEFAULT_API_BASE = "https://connecdoku.com";
const PROMPT_VERSION = "api-benchmark-v1";
const MAX_STEPS_DEFAULT = 64;
const NOTE_MAX_CHARS = 500;

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

async function postJson(url, body, headers = {}) {
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  const elapsedMs = Date.now() - started;
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { ok: res.ok && json.ok !== false, status: res.status, json, elapsedMs };
}

async function getJson(url, headers = {}) {
  const started = Date.now();
  const res = await fetch(url, { method: "GET", headers });
  const elapsedMs = Date.now() - started;
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { ok: res.ok && json.ok !== false, status: res.status, json, elapsedMs };
}

function trimText(s, max = NOTE_MAX_CHARS) {
  const str = String(s || "").trim().replace(/\s+/g, " ");
  return str.slice(0, max);
}

function extractTextFromOpenAIStyle(respJson) {
  const choice = respJson?.choices?.[0];
  const msg = choice?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((x) => (typeof x === "string" ? x : (x?.text || ""))).join("\n");
  }
  return "";
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
    "Return exactly one JSON object and no other text.",
    "Allowed JSON outputs:",
    '{"action":"guess","kind":"row","index":0,"brief_reason":"..."}',
    '{"action":"guess","kind":"col","index":1,"brief_reason":"..."}',
    '{"action":"swap","a":[0,0],"b":[1,1],"brief_reason":"..."}',
    "Keep brief_reason to <= 140 chars.",
    "Prioritize legal actions and avoid repeating clearly bad guesses.",
    "",
    `Model: ${modelMeta.displayName} (${modelMeta.provider})`,
    `Puzzle date: ${state?.puzzle?.date}`,
    `Turn: ${state?.turn}, Strikes: ${state?.strikes}/${state?.maxStrikes}`,
    `Can guess row: ${rules.canGuessRow}, can guess col: ${rules.canGuessCol}`,
    `Allowed actions: ${actions.join(", ")}`,
    `Solved rows: ${solvedRows}`,
    `Solved cols: ${solvedCols}`,
    "Board:",
    board,
    "",
    `Invalid actions so far: ${metrics.gameInvalidActions}`,
    `Fallback actions so far: ${metrics.gameFallbackActions}`,
  ].join("\n");
}

function buildNotePrompt(state, runStats) {
  return [
    "Write a short post-game note for a public benchmark table.",
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
  ].join("\n");
}

function normalizeAction(obj) {
  if (!obj || typeof obj !== "object") return null;
  const action = String(obj.action || "").toLowerCase();
  if (action === "guess") {
    const kind = String(obj.kind || "").toLowerCase();
    const index = Number(obj.index);
    if ((kind === "row" || kind === "col") && Number.isInteger(index) && index >= 0 && index <= 3) {
      return { action: "guess", kind, index, briefReason: trimText(obj.brief_reason || obj.reason || "", 140) };
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
      return { action: "swap", a, b, briefReason: trimText(obj.brief_reason || obj.reason || "", 140) };
    }
  }
  return null;
}

function fallbackAction(state) {
  // Prefer legal guess actions to drive the game forward.
  const canRow = !!state?.rules?.canGuessRow;
  const canCol = !!state?.rules?.canGuessCol;

  const solvedRows = new Set((state?.solved?.rows || []).map((x) => x.index));
  const solvedCols = new Set((state?.solved?.cols || []).map((x) => x.index));

  if (canRow) {
    for (let i = 0; i < 4; i++) {
      if (!solvedRows.has(i)) return { action: "guess", kind: "row", index: i, fallback: true };
    }
  }
  if (canCol) {
    for (let i = 0; i < 4; i++) {
      if (!solvedCols.has(i)) return { action: "guess", kind: "col", index: i, fallback: true };
    }
  }

  // Fallback swap on first two unlocked cells.
  const lockedRows = solvedRows;
  const lockedCols = solvedCols;
  const unlocked = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (!lockedRows.has(r) && !lockedCols.has(c)) unlocked.push([r, c]);
    }
  }
  if (unlocked.length >= 2) {
    return { action: "swap", a: unlocked[0], b: unlocked[1], fallback: true };
  }

  return { action: "guess", kind: canRow ? "row" : "col", index: 0, fallback: true };
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

async function callProviderModel(cfg, prompt, mode = "action") {
  const provider = cfg.provider;
  const model = cfg.resolvedApiModel;
  const reasoningLevel = cfg.reasoningLevel || "medium";
  const temperature = Number(cfg.temperature ?? 0.2);

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing.");
    const body = {
      model,
      temperature,
      messages: [
        { role: "system", content: mode === "note" ? "Return plain text only." : "You are a careful puzzle solver. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
    };
    if (mode !== "note") {
      body.response_format = { type: "json_object" };
    }
    // Some models support this; harmless if ignored.
    body.reasoning_effort = reasoningLevel;

    const resp = await postJson("https://api.openai.com/v1/chat/completions", body, {
      authorization: `Bearer ${apiKey}`,
    });
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
      temperature,
      system: "Return only JSON for action mode. For note mode, plain text only.",
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
        responseMimeType: mode === "note" ? "text/plain" : "application/json",
      },
    };
    const resp = await postJson(endpoint, body);
    if (!resp.ok) throw new Error(`Google error (${resp.status}): ${resp.json?.error?.message || resp.json?.error || "unknown"}`);
    const text = resp.json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("\n") || "";
    return {
      text,
      usage: normalizeUsage("google", resp.json),
      latencyMs: resp.elapsedMs,
      providerModel: model,
    };
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
      temperature,
      response_format: mode === "note" ? undefined : { type: "json_object" },
      messages: [
        { role: "system", content: "Return valid JSON only for action mode." },
        { role: "user", content: prompt },
      ],
    };
    const resp = await postJson(`${entry.base.replace(/\/+$/, "")}/chat/completions`, body, {
      authorization: `Bearer ${entry.key}`,
    });
    if (!resp.ok) throw new Error(`${provider} error (${resp.status}): ${resp.json?.error?.message || resp.json?.error || "unknown"}`);

    return {
      text: extractTextFromOpenAIStyle(resp.json),
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
    gameInvalidActions: 0,
    gameFallbackActions: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  const startResp = await postJson(`${apiBase}/api/v1/competition/start`, {
    model: modelCfg.competitionModel,
    password: modelCfg.password,
    date: opts.date,
  });

  if (!startResp.ok) {
    throw new Error(`start failed: ${startResp.json?.error || startResp.status}`);
  }

  let state = startResp.json.state;
  const competitionToken = startResp.json.competitionToken;
  if (!competitionToken) throw new Error("competitionToken missing from start response.");

  const actionTrace = [];
  let step = 0;

  while (!state.finished && step < opts.maxSteps) {
    const prompt = buildDecisionPrompt(state, stats, modelCfg);

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

      const parsed = parseJsonObjectLoose(modelResp.text);
      action = normalizeAction(parsed);
    } catch (e) {
      stats.modelApiErrors += 1;
      stats.gameInvalidActions += 1;
      action = null;
      actionTrace.push({ step, error: `model_call_error: ${e.message}` });
    }

    if (!action) {
      stats.gameFallbackActions += 1;
      action = fallbackAction(state);
    }

    stats.gameActionsTotal += 1;
    if (action.action === "swap") stats.gameSwaps += 1;
    if (action.action === "guess") stats.gameGuesses += 1;

    let playResp;
    if (action.action === "swap") {
      playResp = await postJson(`${apiBase}/api/v1/competition/swap`, {
        competitionToken,
        a: action.a,
        b: action.b,
      });
    } else {
      playResp = await postJson(`${apiBase}/api/v1/competition/guess`, {
        competitionToken,
        kind: action.kind,
        index: action.index,
      });
    }

    if (!playResp.ok) {
      stats.gameInvalidActions += 1;
      actionTrace.push({
        step,
        action,
        modelOutput: trimText(modelRespText, 280),
        apiError: playResp.json?.error || `HTTP ${playResp.status}`,
      });
      step += 1;
      continue;
    }

    if (action.action === "guess") {
      if (playResp.json?.result?.correct) stats.gameCorrectGuesses += 1;
      else stats.gameIncorrectGuesses += 1;
    }

    state = playResp.json.state;
    actionTrace.push({
      step,
      action,
      modelOutput: trimText(modelRespText, 280),
      strikes: state.strikes,
      turn: state.turn,
      finished: state.finished,
    });
    step += 1;
  }

  // If model stalled, force completion with deterministic fallback guesses.
  let forcedFinish = false;
  let guard = 0;
  while (!state.finished && guard < 32) {
    const fb = fallbackAction(state);
    const resp = fb.action === "swap"
      ? await postJson(`${apiBase}/api/v1/competition/swap`, { competitionToken, a: fb.a, b: fb.b })
      : await postJson(`${apiBase}/api/v1/competition/guess`, { competitionToken, kind: fb.kind, index: fb.index });
    stats.gameFallbackActions += 1;
    stats.gameActionsTotal += 1;
    if (fb.action === "swap") stats.gameSwaps += 1; else stats.gameGuesses += 1;
    if (resp.ok) {
      state = resp.json.state;
      if (fb.action === "guess") {
        if (resp.json?.result?.correct) stats.gameCorrectGuesses += 1;
        else stats.gameIncorrectGuesses += 1;
      }
    } else {
      stats.gameInvalidActions += 1;
    }
    guard += 1;
    forcedFinish = true;
  }

  let note = "";
  try {
    const notePrompt = buildNotePrompt(state, stats);
    const noteResp = await callProviderModel(modelCfg, notePrompt, "note");
    stats.modelApiCalls += 1;
    stats.modelLatencyMsTotal += noteResp.latencyMs;
    stats.modelLatencyMsMax = Math.max(stats.modelLatencyMsMax, noteResp.latencyMs);
    stats.inputTokens += Number(noteResp.usage.inputTokens || 0);
    stats.outputTokens += Number(noteResp.usage.outputTokens || 0);
    stats.totalTokens += Number(noteResp.usage.totalTokens || 0);
    note = trimText(noteResp.text, NOTE_MAX_CHARS);
  } catch (e) {
    stats.modelApiErrors += 1;
    note = trimText(`I fumbled the commentary step: ${e.message}`, NOTE_MAX_CHARS);
  }

  const submitResp = await postJson(`${apiBase}/api/v1/competition/submit`, {
    competitionToken,
    notes: note,
  });
  if (!submitResp.ok) {
    throw new Error(`submit failed: ${submitResp.json?.error || submitResp.status}`);
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
      forcedFinish,
      maxSteps: opts.maxSteps,
      actionTrace: actionTrace.slice(-40),
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
  for (const m of active) {
    console.log(`\n=== ${m.displayName} (${m.provider}:${m.resolvedApiModel}) ===`);
    try {
      const row = await runSingleModel({ apiBase, date, maxSteps }, m);
      results.push({ ...row, ok: true });
      printSummaryRow(row);
    } catch (e) {
      console.log(`FAILED ${m.displayName}: ${e.message}`);
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
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
