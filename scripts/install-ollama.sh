#!/usr/bin/env bash
# 공식 macOS 앱을 이 프로필에 설치한다. CLI tgz만으로는 llama-server가 없다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/bin"
APP_DIR="$HOME/Applications"
APP="$APP_DIR/Ollama.app"
URL="https://ollama.com/download/Ollama.dmg"
TMP="$(mktemp -d)"
MOUNT="$TMP/mnt"

mkdir -p "$BIN_DIR" "$APP_DIR"

echo "공식 Ollama.dmg 다운로드 중..."
curl -L --fail --progress-bar -o "$TMP/Ollama.dmg" "$URL"

echo "디스크 이미지 마운트..."
mkdir -p "$MOUNT"
hdiutil attach "$TMP/Ollama.dmg" -nobrowse -readonly -mountpoint "$MOUNT"

if [[ ! -d "$MOUNT/Ollama.app" ]]; then
  echo "DMG 안에 Ollama.app이 없다." >&2
  ls -la "$MOUNT" || true
  hdiutil detach "$MOUNT" -quiet || true
  exit 1
fi

echo "Ollama.app 설치: $APP"
rm -rf "$APP"
ditto "$MOUNT/Ollama.app" "$APP"
hdiutil detach "$MOUNT" -quiet || true

# 프로젝트 bin에서 바로 쓰도록 연결한다.
OLLAMA_BIN="$APP/Contents/Resources/ollama"
if [[ ! -x "$OLLAMA_BIN" ]]; then
  OLLAMA_BIN="$(find "$APP/Contents" -name ollama -type f | head -1)"
fi
if [[ -z "$OLLAMA_BIN" || ! -x "$OLLAMA_BIN" ]]; then
  echo "Ollama.app 안에서 ollama 실행 파일을 찾지 못했다." >&2
  find "$APP/Contents" -maxdepth 4 -type f | head
  exit 1
fi

ln -sfn "$OLLAMA_BIN" "$BIN_DIR/ollama"
# llama-server는 앱 리소스 옆에 있어야 FindLlamaServer가 찾는다.
if [[ -x "$APP/Contents/Resources/llama-server" ]]; then
  ln -sfn "$APP/Contents/Resources/llama-server" "$BIN_DIR/llama-server"
fi
if [[ -d "$APP/Contents/Resources/lib" ]]; then
  ln -sfn "$APP/Contents/Resources/lib" "$BIN_DIR/lib"
fi

rm -rf "$TMP"
echo "설치됨: $APP"
"$BIN_DIR/ollama" --version
ls -la "$APP/Contents/Resources" | head
