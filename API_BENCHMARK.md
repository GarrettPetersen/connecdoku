# Direct API Benchmark System

This benchmark runs Connecdoku through provider APIs directly (OpenAI, Anthropic, Google, xAI, Moonshot, optional Cursor-compatible endpoint), without Cursor automation prompts.

## Goals

- Evaluate model puzzle skill under a consistent protocol.
- Keep one counted attempt per model/date via server-side locked attempts.
- Track both gameplay outcomes and benchmark telemetry (time/cost/reliability).

## What It Tracks

Existing game/result metrics (already in `competition_results`):
- outcome (`won` / `lost`)
- strikes
- turn count
- solved category detail
- model note

New benchmark telemetry (`competition_benchmark_runs`):
- provider and exact API model string used
- reasoning level and prompt version
- run duration
- model API calls and model API errors
- total and max model latency
- action counts: swaps, guesses, correct/incorrect guesses
- invalid actions and fallback actions
- token usage (input/output/total)
- estimated cost (from per-model price config)
- optional error text + metadata trace

These are the extra fields you typically expect in a respectable benchmark beyond raw win/loss.

## Model Roster

Roster file:
- `data/api_benchmark_models.json`

Each entry controls:
- competition model id (used in Connecdoku DB)
- provider (`openai`, `anthropic`, `google`, `xai`, `moonshot`, `cursor`)
- default API model string
- optional `apiModelEnv` override for exact version pinning
- `reasoningLevel` (single baseline across all models)
- `temperature`
- pricing assumptions for estimated cost

## Exact Model Versioning

For reproducibility, set exact model IDs via env vars (preferred):
- `BENCH_MODEL_GPT_5_5=...`
- `BENCH_MODEL_OPUS_4_7=...`
- etc.

The runner records the resolved `api_model` string into benchmark telemetry.

## Consistent Thinking Level

Use one thinking level for all models:

```bash
node scripts/run_api_benchmark.mjs --thinking-level medium
```

You can choose `low`, `medium`, or `high` as your benchmark baseline. Do not mix levels within one benchmark window.

## Run Benchmark

```bash
node scripts/run_api_benchmark.mjs --date 2026-05-21 --thinking-level medium
```

Useful options:
- `--models gpt-5.5,sonnet-4.6` (subset)
- `--max-steps 80`
- `--api https://connecdoku.com`
- `--reset-runs` (wipe previous run data first; admin key required)

## Reset Experimental Data

To wipe prior experimental runs while keeping competitor registrations:

```bash
curl -sS -X POST https://connecdoku.com/api/v1/competition/reset-runs \
  -H "authorization: Bearer $COMPETITION_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"confirm":"RESET_COMPETITION_RUNS"}'
```

Set `"wipeCompetitors": true` only if you intentionally want to remove competitor registrations as well.

## Creative Notes

The runner asks each model for a short post-game note with explicit instructions to be creative/specific (mistake, surprise, boast, insight). This keeps notes more interesting than generic templates.

## Safety / Integrity

- Locked first attempt per model/date prevents reroll cheating.
- Prompt explicitly forbids external-answer lookup.
- Invalid actions are counted and reported.
- Fallback actions are tracked so “self-driven” quality remains visible.
