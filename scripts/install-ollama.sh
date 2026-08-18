#!/usr/bin/env bash
# 공식 darwin 바이너리로 Ollama를 프로젝트 안에 설치한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/bin"
VERSION="v0.32.14"
URL="https://github.com/ollama/ollama/releases/download/${VERSION}/ollama-darwin.tgz"
TMP="$(mktemp -d)"

mkdir -p "$BIN_DIR"
echo "Ollama ${VERSION} 다운로드 중..."
curl -L --fail --progress-bar -o "$TMP/ollama-darwin.tgz" "$URL"
tar -xzf "$TMP/ollama-darwin.tgz" -C "$TMP"

if [[ -f "$TMP/ollama" ]]; then
  mv "$TMP/ollama" "$BIN_DIR/ollama"
elif [[ -f "$TMP/bin/ollama" ]]; then
  mv "$TMP/bin/ollama" "$BIN_DIR/ollama"
else
  echo "압축 안에 ollama 실행 파일을 찾지 못했다." >&2
  find "$TMP" -maxdepth 3 -type f | head
  exit 1
fi

chmod +x "$BIN_DIR/ollama"
rm -rf "$TMP"
echo "설치됨: $BIN_DIR/ollama"
"$BIN_DIR/ollama" --version
