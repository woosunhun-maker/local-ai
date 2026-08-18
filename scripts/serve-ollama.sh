#!/usr/bin/env bash
# 이미 켜진 로컬 Ollama가 있으면 그걸 쓰고, 꺼지면 이 프로필의 서버를 띄운다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -x "$HOME/Applications/Ollama.app/Contents/Resources/ollama" ]]; then
  OLLAMA="$HOME/Applications/Ollama.app/Contents/Resources/ollama"
elif [[ -x /Applications/Ollama.app/Contents/Resources/ollama ]]; then
  OLLAMA=/Applications/Ollama.app/Contents/Resources/ollama
else
  OLLAMA="$ROOT/bin/ollama"
fi
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11435}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/.ollama/models}"

mkdir -p "$HOME/.ollama/models" "$ROOT/logs"

if [[ ! -x "$OLLAMA" ]]; then
  echo "Ollama 실행 파일이 없다: $OLLAMA" >&2
  exit 1
fi

echo "Ollama 사용: $OLLAMA  host=$OLLAMA_HOST"
exec "$OLLAMA" serve
