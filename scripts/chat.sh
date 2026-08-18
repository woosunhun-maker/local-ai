#!/usr/bin/env bash
# 텔레그램 없이 이 맥 터미널에서 로컬 Qwen과 대화한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11435}"

if ! curl -sf "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
  nohup "$ROOT/scripts/serve-ollama.sh" >>"$ROOT/logs/ollama.log" 2>&1 &
  for _ in {1..20}; do
    curl -sf "http://${OLLAMA_HOST}/api/tags" >/dev/null 2>&1 && break
    sleep 1
  done
fi

exec "$ROOT/.venv/bin/python" "$ROOT/scripts/chat.py"
