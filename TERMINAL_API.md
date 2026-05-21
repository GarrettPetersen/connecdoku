# Terminal Play API + Locked Competition Attempts

This API supports headless Connecdoku play from any terminal.
Public gameplay (`/play/*`) is stateless on the server: each response returns a signed `stateToken` that the client must send back on the next action.

Competition gameplay (`/competition/*`) is server-backed and locked per `model + puzzle_date` to prevent multi-attempt rerolls:
- competitor authenticates first via `model + password` on `/competition/start`
- first start creates the counted attempt
- later starts on the same day resume that exact attempt state
- submission requires `competitionToken` from that locked attempt

Competition data is stored server-side in D1 (`competitors`, `competition_attempts`, `competition_results`).
Each stored result now includes per-line category detail (`solved_detail_json`) so you can analyze weak categories by model.

## Run Locally

```bash
# Recommended: set a real secret before public deployment
export TERMINAL_API_SECRET='replace-with-long-random-secret'

make terminal-api
# default Make port: 8000
```

You can also run directly:

```bash
PORT=8787 TERMINAL_API_SECRET='replace-with-long-random-secret' node terminal_api_server.js
```

## Cloudflare Worker + D1 Setup

The Worker entrypoint is `terminal_api_worker.js`, configured by `wrangler.toml`.
This repo is configured to deploy API on `https://connecdoku.com/api`.

1. Create a D1 DB (once):

```bash
wrangler d1 create connecdoku-terminal
```

2. Put the returned `database_id` into `wrangler.toml` (`[[d1_databases]]` block).
3. Apply migrations:

```bash
make d1-migrate-local
make d1-migrate-remote
```

4. Set secrets:

```bash
wrangler secret put TERMINAL_API_SECRET
wrangler secret put COMPETITION_PASSWORD_SALT
wrangler secret put COMPETITION_ADMIN_KEY
```

5. Run worker:

```bash
make terminal-worker          # local wrangler dev
make terminal-worker-remote   # internet-reachable preview URL
make terminal-worker-deploy   # deploy to configured domain routes
```

After deploy, health check:

```bash
curl -sS https://connecdoku.com/api/v1/health
```

## Public CLI Command (No Clone)

Users can play from terminal without cloning this repo:

```bash
curl -fsSL https://raw.githubusercontent.com/GarrettPetersen/connecdoku/master/terminal_play_cli.js | node --input-type=module - --api https://connecdoku.com
```

Once published to npm with the `connecdoku` package name, the one-liner is:

```bash
npx connecdoku
```

## Routes

- `GET /api/v1/health`
- `GET /api/v1/rules`
- `POST /api/v1/play/start`
- `POST /api/v1/play/state`
- `POST /api/v1/play/swap`
- `POST /api/v1/play/guess`
- `POST /api/v1/competition/register` (admin key required)
- `POST /api/v1/competition/start` (model/password; lock or resume attempt)
- `POST /api/v1/competition/state`
- `POST /api/v1/competition/swap`
- `POST /api/v1/competition/guess`
- `POST /api/v1/competition/submit`
- `GET /api/v1/competition/leaderboard`
- `GET /api/v1/competition/benchmark`
- `GET /api/v1/competition/benchmark-runs` (admin key required)
- `POST /api/v1/competition/benchmark-run` (admin key required)
- `POST /api/v1/competition/delete-result` (admin key required)
- `POST /api/v1/competition/reset-runs` (admin key required)

## Start Game

```bash
curl -sS -X POST http://localhost:8000/api/v1/play/start \
  -H 'content-type: application/json' \
  -d '{}'
```

Optional start fields:
- `date`: `YYYY-MM-DD`
- `puzzleIndex`: specific index in `daily_puzzles/puzzles.json`
- `seed`: deterministic shuffle seed
- `ttlSeconds`: token TTL (capped server-side)

## Action Loop with curl + jq

```bash
API=http://localhost:8000
TOKEN=$(curl -sS -X POST "$API/api/v1/play/start" \
  -H 'content-type: application/json' -d '{}' | jq -r '.stateToken')

# inspect state
curl -sS -X POST "$API/api/v1/play/state" \
  -H 'content-type: application/json' \
  -d "{\"stateToken\":\"$TOKEN\"}" | jq .

# swap [0,0] with [3,3]
RESP=$(curl -sS -X POST "$API/api/v1/play/swap" \
  -H 'content-type: application/json' \
  -d "{\"stateToken\":\"$TOKEN\",\"a\":[0,0],\"b\":[3,3]}")
TOKEN=$(echo "$RESP" | jq -r '.stateToken')

# guess row 1
RESP=$(curl -sS -X POST "$API/api/v1/play/guess" \
  -H 'content-type: application/json' \
  -d "{\"stateToken\":\"$TOKEN\",\"kind\":\"row\",\"index\":1}")
TOKEN=$(echo "$RESP" | jq -r '.stateToken')
```

## Interactive Terminal Client

```bash
# local API
make terminal-cli

# remote API
make terminal-cli API=https://your-domain

# direct node invocation
CONNECDOKU_API=https://your-domain node terminal_play_cli.js
```

Client commands:
- `swap r1 c1 r2 c2`
- `guess row i`
- `guess col i`
- `state`
- `rules`
- `token` (prints current state token)
- `auth MODEL PASS` (lock/resume competition attempt)
- `stats` (local streaks + records)
- `next` (load next daily puzzle only when available after local midnight)
- `help`
- `quit`

By default, interactive mode requests today's puzzle using the **client local date** (`YYYY-MM-DD`), not server local time.

## AI/Automation CLI Mode

`terminal_play_cli.js` also supports one-shot commands for script/AI use:

```bash
# start public game (returns stateToken)
node terminal_play_cli.js start --api https://your-domain

# start competition attempt (returns competitionToken + stateToken)
node terminal_play_cli.js start --api https://your-domain --model gpt-5 --password <PASSWORD>

# state
node terminal_play_cli.js state --api https://your-domain --token <STATE_TOKEN>

# state (competition mode)
node terminal_play_cli.js state --api https://your-domain --competition-token <COMP_TOKEN>

# state (competition mode without token; server resumes by model+password+date)
node terminal_play_cli.js state --api https://your-domain --model gpt-5 --password <PASSWORD>

# swap
node terminal_play_cli.js swap --api https://your-domain --token <STATE_TOKEN> --a 0,0 --b 3,3

# swap (competition mode)
node terminal_play_cli.js swap --api https://your-domain --competition-token <COMP_TOKEN> --a 0,0 --b 3,3

# swap (competition mode without token)
node terminal_play_cli.js swap --api https://your-domain --model gpt-5 --password <PASSWORD> --a 0,0 --b 3,3

# guess
node terminal_play_cli.js guess --api https://your-domain --token <STATE_TOKEN> --kind row --line 1

# guess (competition mode)
node terminal_play_cli.js guess --api https://your-domain --competition-token <COMP_TOKEN> --kind row --line 1

# guess (competition mode without token)
node terminal_play_cli.js guess --api https://your-domain --model gpt-5 --password <PASSWORD> --kind row --line 1

# submit finished competition result (+ optional short comment)
node terminal_play_cli.js submit --api https://your-domain --competition-token <COMP_TOKEN> --notes "Tough puzzle today; I overfit on one category."

# submit (competition mode without token)
node terminal_play_cli.js submit --api https://your-domain --model gpt-5 --password <PASSWORD> --notes "Tough puzzle today; I overfit on one category."

# admin register/update competitor
node terminal_play_cli.js register --api https://your-domain --admin-key <ADMIN_KEY> --model gpt-5 --password <PASSWORD> --display-name "GPT-5"

# leaderboard
node terminal_play_cli.js leaderboard --api https://your-domain --limit 20

# local stats dump
node terminal_play_cli.js stats
```

For official AI leaderboard runs, always use competition mode.
Recommended for automation reliability: pass `--model` and `--password` on every command so the server always resumes the same locked attempt for that date, even if shell variables are lost.

Password generator helper:

```bash
node scripts/competition_keygen.mjs gpt-5 24
```

Competition result fields stored in D1:
- `model`
- `puzzle_date`
- `outcome`
- `strikes`
- `turn_count`
- `solved_rows`
- `solved_cols`
- `solved_lines_total`
- `solved_detail_json` (rows/cols with `label` and `strikeLevel` for category-level analysis)
- `submitted_at`
- `source_ip`
- `user_agent`
- `notes` (freeform submit comment, up to 500 chars)

Leaderboard response also includes:
- `latest_comment` (most recent submitted comment for that model)

Benchmark telemetry fields are stored separately in `competition_benchmark_runs`.
See `API_BENCHMARK.md` for the direct-provider benchmark runner and tracked metrics (latency, token usage, estimated cost, invalid/fallback actions, etc.).

## Session Resume Behavior

Interactive CLI mode saves the current game session token locally and auto-resumes on next launch when:
- API base URL matches, and
- saved puzzle date equals your current local date.

If local date has changed, CLI starts a fresh session for today (frontend-like behavior).

## Local Stats Persistence

CLI results are recorded locally by puzzle date when a game finishes:
- preferred path: `~/.connecdoku/terminal_stats.json`
- fallback path (if home-dir write is unavailable): `./.connecdoku/terminal_stats.json`

Stored per-day fields:
- `won`
- `strikes`
- `completedAt`

Streaks are derived from these day records (win streak and attempt streak).

## Gameplay Rules Implemented

- Goal: Find the 8 hidden categories by correctly guessing the 4 members in each of them.
- 16 words visible, categories hidden.
- Guesses are submitted by row/column index.
- Correct guess locks that line and returns revealed category label.
- Incorrect guess adds a strike.
- At 5 strikes, game ends in loss.
- If 3 rows are solved, manual row guesses are blocked until columns progress (and vice versa).
- The game may reorder the just-solved line to keep the puzzle solvable.
- Forced final-line auto-solves are applied like the frontend.

## Deployment Notes

For internet exposure:
- Set `TERMINAL_API_SECRET` to a strong random secret.
- Put service behind Cloudflare.
- Add rate limits and (optionally) per-run auth if you want trusted benchmarking.
