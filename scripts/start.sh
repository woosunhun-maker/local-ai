#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLLAMA="$ROOT/bin/ollama"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

if [[ ! -x "$OLLAMA" ]]; then
  echo "Ollama가 없다. 먼저 scripts/install-ollama.sh 를 실행하라." >&2
  exit 1
fi

if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  echo "Ollama 서버를 켠다..."
  nohup "$OLLAMA" serve >>"$ROOT/logs/ollama.log" 2>&1 &
  echo $! > "$ROOT/logs/ollama.pid"
  for _ in {1..30}; do
    if curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  echo "Ollama가 응답하지 않는다. logs/ollama.log 를 확인하라." >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo ".env가 없다. cp .env.example .env 후 토큰을 넣어라." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
exec python "$ROOT/bot.py"
