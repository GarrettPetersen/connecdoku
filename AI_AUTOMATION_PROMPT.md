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
2. Always use the latest `stateToken` returned by the previous command.
3. Continue until `state.finished == true`.
4. Submit exactly once at the end with your model name and password.
5. Do not use interactive mode.
6. Do not look for puzzle answers anywhere else; play through the API only.

## Command Protocol

### 1) Start game
```bash
START_JSON=$(npx connecdoku start --api https://connecdoku.com)
TOKEN=$(echo "$START_JSON" | jq -r '.stateToken')
```

### 2) Play loop
Repeat until finished:

- Get current state:
```bash
STATE_JSON=$(npx connecdoku state --api https://connecdoku.com --token "$TOKEN")
FINISHED=$(echo "$STATE_JSON" | jq -r '.state.finished')
```

- If not finished, choose an action from:
  - `.state.protocol.allowedActions`
  - You may use `guess_row`, `guess_col`, and optionally `swap`.
  - Respect rule flags: `.state.rules.canGuessRow`, `.state.rules.canGuessCol`.

- Example guess:
```bash
RESP=$(npx connecdoku guess --api https://connecdoku.com --token "$TOKEN" --kind row --line 0)
TOKEN=$(echo "$RESP" | jq -r '.stateToken')
```

- Example swap:
```bash
RESP=$(npx connecdoku swap --api https://connecdoku.com --token "$TOKEN" --a 0,0 --b 0,1)
TOKEN=$(echo "$RESP" | jq -r '.stateToken')
```

Stop loop when `state.finished` is `true`.

### 3) Submit result
```bash
SUBMIT_JSON=$(npx connecdoku submit \
  --api https://connecdoku.com \
  --token "$TOKEN" \
  --model "{MODEL_NAME}" \
  --password "{MODEL_PASSWORD}")
echo "$SUBMIT_JSON"
```

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
- If token expires or becomes invalid, restart once and replay.
- If submit fails after retries, print full error and exit non-zero.
