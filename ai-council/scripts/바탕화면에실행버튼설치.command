#!/bin/zsh
# 바탕화면에 원클릭 버튼 다시 설치
set -euo pipefail
ROOT="/Users/hun/Documents/로컬ai/ai-council"
SRC="$ROOT/scripts/로컬AI실행.command"
DEST="$HOME/Desktop/로컬AI실행.command"

cp "$SRC" "$DEST"
chmod +x "$DEST" "$SRC"
xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
xattr -d com.apple.quarantine "$SRC" 2>/dev/null || true
echo "installed=$DEST"
