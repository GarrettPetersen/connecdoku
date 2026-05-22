#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const DIRECT_MODELS_FILE = path.join(ROOT, "data", "api_benchmark_models.json");
const CURSOR_MODELS_FILE = path.join(ROOT, "data", "cursor_benchmark_models.json");
const DEFAULT_API_BASE = "https://connecdoku.com";
const DEFAULT_THINKING = "medium";
const DEFAULT_MAX_STEPS = 64;

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getEnabledModels(filePath) {
  const arr = readJson(filePath);
  return arr.filter((m) => m && m.enabled !== false);
}

function requireEnvVars(vars) {
  const missing = [];
  for (const key of vars) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

async function fetchJson(url, init = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { ok: false, error: text || `HTTP ${res.status}` };
    }
    return { ok: res.ok && json.ok !== false, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchExistingModelsForDate(apiBase, date, adminKey) {
  const url = `${apiBase}/api/v1/competition/benchmark-runs?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}&limit=1000`;
  const resp = await fetchJson(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${adminKey}`,
    },
  });
  if (!resp.ok) {
    throw new Error(`Failed to load existing benchmark runs for ${date}: ${resp.json?.error || `HTTP ${resp.status}`}`);
  }
  const set = new Set();
  const runs = Array.isArray(resp.json?.runs) ? resp.json.runs : [];
  for (const r of runs) {
    const model = String(r?.model || "").trim();
    if (model) set.add(model);
  }
  return set;
}

function runTask(task) {
  return new Promise((resolve) => {
    const child = spawn(task.cmd, task.args, {
      cwd: ROOT,
      env: { ...process.env, ...(task.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const prefix = `[${task.id}]`;
    child.stdout.on("data", (buf) => {
      const text = String(buf || "");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.log(`${prefix} ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      const text = String(buf || "");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.error(`${prefix} ${line}`);
      }
    });

    child.on("close", (code, signal) => {
      resolve({
        ...task,
        ok: code === 0,
        code,
        signal,
      });
    });
  });
}

async function runWithConcurrency(tasks, concurrency) {
  const queue = tasks.slice();
  const results = [];
  const workers = [];

  const worker = async () => {
    while (queue.length) {
      const task = queue.shift();
      const result = await runTask(task);
      results.push(result);
    }
  };

  const n = Math.max(1, Math.min(concurrency, tasks.length || 1));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  loadDotEnv();

  const parsed = parseArgs(process.argv.slice(2));
  const f = parsed.flags;

  if (f.help || f.h) {
    console.log(`Usage:\n  node scripts/run_all_benchmarks_parallel.mjs [--date YYYY-MM-DD] [--api https://connecdoku.com] [--thinking-level medium] [--max-steps 64] [--concurrency 16] [--lanes direct,cursor] [--only-missing]\n\nNotes:\n  - Runs one benchmark process per model in parallel.\n  - Uses scripts/run_api_benchmark.mjs for direct providers.\n  - Uses scripts/run_cursor_benchmark.mjs for Composer models.\n  - Date is shared across all tasks for fair same-day comparison.\n  - --only-missing skips models that already have a benchmark run for that date.\n`);
    return;
  }

  const date = String(f.date || localDateString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");

  const apiBase = String(f.api || DEFAULT_API_BASE).replace(/\/+$/, "");
  const thinking = String(f["thinking-level"] || DEFAULT_THINKING);
  const maxSteps = Math.max(8, Math.min(300, Number(f["max-steps"] || DEFAULT_MAX_STEPS)));
  const concurrency = Math.max(1, Math.min(64, Number(f.concurrency || 32)));
  const lanes = String(f.lanes || "direct,cursor").split(",").map((x) => x.trim()).filter(Boolean);
  const onlyMissing = !!f["only-missing"];

  requireEnvVars(["COMPETITION_ADMIN_KEY"]);

  const tasks = [];
  let existingForDate = new Set();
  if (onlyMissing) {
    existingForDate = await fetchExistingModelsForDate(apiBase, date, process.env.COMPETITION_ADMIN_KEY);
    console.log(`Idempotent mode: found ${existingForDate.size} existing model result(s) for ${date}.`);
  }

  if (lanes.includes("direct")) {
    const direct = getEnabledModels(DIRECT_MODELS_FILE);
    for (const m of direct) {
      if (onlyMissing && existingForDate.has(m.competitionModel)) continue;
      if (!process.env[m.passwordEnv || ""]) {
        throw new Error(`Missing password env for direct model ${m.competitionModel}: ${m.passwordEnv}`);
      }
      tasks.push({
        id: `direct:${m.competitionModel}`,
        lane: "direct",
        model: m.competitionModel,
        cmd: "node",
        args: [
          "scripts/run_api_benchmark.mjs",
          "--api", apiBase,
          "--date", date,
          "--models", m.competitionModel,
          "--thinking-level", thinking,
          "--max-steps", String(maxSteps),
        ],
      });
    }
  }

  if (lanes.includes("cursor")) {
    requireEnvVars(["CURSOR_API_KEY", "CURSOR_BENCH_REPOSITORY"]);
    const cursor = getEnabledModels(CURSOR_MODELS_FILE);
    for (const m of cursor) {
      if (onlyMissing && existingForDate.has(m.competitionModel)) continue;
      if (!process.env[m.passwordEnv || ""]) {
        throw new Error(`Missing password env for cursor model ${m.competitionModel}: ${m.passwordEnv}`);
      }
      tasks.push({
        id: `cursor:${m.competitionModel}`,
        lane: "cursor",
        model: m.competitionModel,
        cmd: "node",
        args: [
          "scripts/run_cursor_benchmark.mjs",
          "--api", apiBase,
          "--date", date,
          "--models", m.competitionModel,
          "--thinking-level", thinking,
          "--max-steps", String(maxSteps),
        ],
      });
    }
  }

  if (!tasks.length) {
    console.log(`No tasks to run for ${date}. All selected models already have results.`);
    return;
  }

  console.log(`Running ${tasks.length} benchmark tasks in parallel on ${date}`);
  console.log(`API base: ${apiBase}`);
  console.log(`Thinking: ${thinking}`);
  console.log(`Max steps: ${maxSteps}`);
  console.log(`Concurrency: ${concurrency}`);

  const started = Date.now();
  const results = await runWithConcurrency(tasks, concurrency);
  const elapsedMs = Date.now() - started;

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("\n=== Parallel Benchmark Summary ===");
  console.log(`Completed: ${ok.length}/${results.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
  if (failed.length) {
    console.log("Failures:");
    for (const f0 of failed) {
      console.log(`- ${f0.id} (exit=${f0.code}, signal=${f0.signal || "none"})`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
