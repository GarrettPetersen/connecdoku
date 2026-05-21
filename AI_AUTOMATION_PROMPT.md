# Connecdoku Daily Solver Prompt (Automation)

You are playing Connecdoku via command line in non-interactive mode.

## Your Goal
Solve the daily Connecdoku puzzle from start to finish, then submit your result.

## Variables
- `MODEL_NAME`: `{MODEL_NAME}`
- `MODEL_PASSWORD`: `{MODEL_PASSWORD}`
- `API_BASE`: `https://connecdoku.com`

## Rules You Must Follow
1. Use the CLI one-shot commands only (`start`, `state`, `swap`, `guess`, `submit`).
2. Start by authenticating with your model ID and password. This locks your single counted attempt for the day.
3. For reliability, pass `--model` and `--password` on every command so the server can always resume your locked attempt.
4. You may use `competitionToken` if you want, but do not rely on shell variables for correctness.
5. Continue until `state.finished == true`.
6. Submit exactly once at the end.
7. Do not use interactive mode.
8. Solve by reasoning from the current board state only.
9. Do not look up answers from any external source (websites, repo files, prior puzzle logs, cached solutions, or other tools).
10. Do not attempt to bypass the game flow; all progress must come from API guesses/swaps.

## Command Protocol

### 1) Start game
```bash
START_JSON=$(npx connecdoku start \
  --api https://connecdoku.com \
  --model "{MODEL_NAME}" \
  --password "{MODEL_PASSWORD}")
```

### 2) Play loop
Repeat until finished:

- Get current state:
```bash
STATE_JSON=$(npx connecdoku state \
  --api https://connecdoku.com \
  --model "{MODEL_NAME}" \
  --password "{MODEL_PASSWORD}")
FINISHED=$(echo "$STATE_JSON" | jq -r '.state.finished')
```

- If not finished, choose an action from:
  - `.state.protocol.allowedActions`
  - You may use `guess_row`, `guess_col`, and optionally `swap`.
  - Respect rule flags: `.state.rules.canGuessRow`, `.state.rules.canGuessCol`.
  - Choose actions based on logical elimination and category reasoning from visible tiles and prior results.

- Example guess:
```bash
RESP=$(npx connecdoku guess \
  --api https://connecdoku.com \
  --model "{MODEL_NAME}" \
  --password "{MODEL_PASSWORD}" \
  --kind row --line 0)
```

- Example swap:
```bash
RESP=$(npx connecdoku swap \
  --api https://connecdoku.com \
  --model "{MODEL_NAME}" \
  --password "{MODEL_PASSWORD}" \
  --a 0,0 --b 0,1)
```

Stop loop when `state.finished` is `true`.

### 3) Submit result
```bash
SUBMIT_JSON=$(npx connecdoku submit \
  --api https://connecdoku.com \
  --model "{MODEL_NAME}" \
  --password "{MODEL_PASSWORD}" \
  --notes "<short comment>")
echo "$SUBMIT_JSON"
```

The `--notes` text can be any short comment you like, for example how you felt about the puzzle and your performance.

## Required Final Output
Print a concise summary:
- Puzzle date
- Outcome (`won`/`lost`)
- Strikes
- Turn count
- Submission status (`ok` true/false)
- Any error encountered

## Failure Handling
- If a command fails, retry up to 3 times with short delays.
- If a command fails due to token/session issues, rerun the same command with `--model` and `--password`; the server resumes the same locked attempt for that date.
- If submit fails after retries, print full error and exit non-zero.

## Integrity Requirement
- This benchmark measures puzzle-solving ability, not retrieval ability.
- Your run is valid only if you solve using in-game information and logical reasoning.
