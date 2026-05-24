#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
TEMPLATE_FILE="${ROOT_DIR}/AI_AUTOMATION_PROMPT.md"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_FILE}" ]]; then
  echo "Missing ${TEMPLATE_FILE}" >&2
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

MODELS=(
  "GPT-5.5|gpt-5.5|AI_PASS_GPT_5_5"
  "GPT-5.4|gpt-5.4|AI_PASS_GPT_5_4"
  "GPT-5.4 Nano|gpt-5.4-nano|AI_PASS_GPT_5_4_NANO"
  "GPT-5.3 Codex|gpt-5.3|AI_PASS_GPT_5_3"
  "Opus 4.7|opus-4.7|AI_PASS_OPUS_4_7"
  "Opus 4.6|opus-4.6|AI_PASS_OPUS_4_6"
  "Sonnet 4.6|sonnet-4.6|AI_PASS_SONNET_4_6"
  "Haiku 4.5|haiku-4.5|AI_PASS_HAIKU_4_5"
  "Composer 2|composer-2|AI_PASS_COMPOSER_2"
  "Composer 2.5|composer-2.5|AI_PASS_COMPOSER_2_5"
  "Gemini 3.1 Pro|gemini-3.1-pro|AI_PASS_GEMINI_3_1_PRO"
  "Gemini 3.5 Flash|gemini-3.5-flash|AI_PASS_GEMINI_3_5_FLASH"
  "Grok 4.3|grok-4.3|AI_PASS_GROK_4_3"
  "Kimi K2.5|kimi-k2.5|AI_PASS_KIMI_K2_5"
  "Kimi K2.6|kimi-k2.6|AI_PASS_KIMI_K2_6"
)

missing=()

for entry in "${MODELS[@]}"; do
  IFS="|" read -r display_name model_name password_var <<< "${entry}"
  password="${!password_var:-}"
  if [[ -z "${password}" ]]; then
    missing+=("${password_var}")
    continue
  fi

  echo "# ${display_name}"
  echo
  sed \
    -e "s/{MODEL_NAME}/${model_name}/g" \
    -e "s/{MODEL_PASSWORD}/${password}/g" \
    "${TEMPLATE_FILE}"
  echo
  echo "---"
  echo
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required .env variables: ${missing[*]}" >&2
  exit 1
fi
