#!/bin/zsh
# 더블클릭용: config/.env 만들고 TextEdit으로 연다. 키는 채팅에 붙이지 말 것.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/config/.env.example"
ENV_FILE="$ROOT/config/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

open -a TextEdit "$ENV_FILE"
osascript -e 'display notification "OPENAI_API_KEY / GEMINI_API_KEY 칸만 채운 뒤 저장하세요. 채팅에 붙여넣지 마세요." with title "AI Council"'
