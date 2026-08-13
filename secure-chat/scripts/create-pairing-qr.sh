#!/bin/zsh
set -euo pipefail

readonly ROOT="/Users/hun/Documents/로컬ai/secure-chat"
readonly OUTPUT="/Users/hun/PrivateAI/data/secure-chat/pairing.png"

if [[ "$#" -gt 1 || ( "$#" -eq 1 && "${1:-}" != "--owner" ) ]]; then
  echo "사용법: create-pairing-qr.sh [--owner]" >&2
  exit 2
fi

if [[ -z "${LOCAL_AI_CHAT_PUBLIC_URL:-}" || "$LOCAL_AI_CHAT_PUBLIC_URL" != https://* ]]; then
  echo "오류: 승인된 HTTPS 주소를 LOCAL_AI_CHAT_PUBLIC_URL에 설정해야 합니다." >&2
  exit 1
fi

LOCAL_AI_CHAT_PUBLIC_URL="$LOCAL_AI_CHAT_PUBLIC_URL" \
  /opt/homebrew/bin/node "$ROOT/scripts/create-pairing.mjs" "$@" | \
  /usr/bin/swift "$ROOT/scripts/pairing-qr.swift" "$OUTPUT"

echo "QR에는 5분짜리 1회용 비밀이 포함됩니다. 사용 후 파일을 안전하게 폐기하세요."
