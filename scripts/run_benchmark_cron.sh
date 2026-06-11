#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

LOG_DIR="${CONNECDOKU_BENCHMARK_LOG_DIR:-$ROOT/.cache/benchmark-cron}"
LOCK_DIR="${CONNECDOKU_BENCHMARK_LOCK_DIR:-$ROOT/.cache/benchmark-cron.lock}"
mkdir -p "$LOG_DIR" "$ROOT/.cache"

LOG_FILE="$LOG_DIR/benchmark-$(date +%F).log"
exec >> "$LOG_FILE" 2>&1

echo "[$(date -Is)] Starting scheduled benchmark"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date -Is)] Another benchmark run is still active; skipping."
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if [ -z "${COMPETITION_ADMIN_KEY:-}" ]; then
  if [ -n "${BENCHMARK_ADMIN_KEY:-}" ]; then
    export COMPETITION_ADMIN_KEY="$BENCHMARK_ADMIN_KEY"
  elif [ -n "${TERMINAL_API_ADMIN_KEY:-}" ]; then
    export COMPETITION_ADMIN_KEY="$TERMINAL_API_ADMIN_KEY"
  fi
fi

if [ -z "${COMPETITION_ADMIN_KEY:-}" ]; then
  echo "[$(date -Is)] Missing COMPETITION_ADMIN_KEY, BENCHMARK_ADMIN_KEY, or TERMINAL_API_ADMIN_KEY."
  exit 1
fi

export API_BENCH_HTTP_TIMEOUT_MS="${API_BENCH_HTTP_TIMEOUT_MS:-240000}"
export API_BENCH_MODEL_CALL_HARD_TIMEOUT_MS="${API_BENCH_MODEL_CALL_HARD_TIMEOUT_MS:-300000}"
export OPENAI_BENCH_MAX_RETRIES="${OPENAI_BENCH_MAX_RETRIES:-4}"

DATE="${DATE:-$(date +%F)}"
THINKING="${THINKING:-medium}"
MAX_STEPS="${MAX_STEPS:-64}"
CONCURRENCY="${CONCURRENCY:-32}"
LANES="${LANES:-direct,cursor}"
EXCLUDE_MODELS="${EXCLUDE_MODELS:-gpt-5.4,gpt-5.4-nano,gpt-5.3,opus-4.7,sonnet-4.6,haiku-4.5,kimi-k2.5,kimi-k2.6,composer-2}"

node scripts/run_all_benchmarks_parallel.mjs \
  --date "$DATE" \
  --max-steps "$MAX_STEPS" \
  --thinking-level "$THINKING" \
  --concurrency "$CONCURRENCY" \
  --lanes "$LANES" \
  --exclude-models "$EXCLUDE_MODELS" \
  --only-missing

status=$?
echo "[$(date -Is)] Scheduled benchmark finished with status $status"
exit "$status"
