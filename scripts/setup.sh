#!/usr/bin/env bash
# 가상환경, 의존성, LaunchAgent를 설치한다. 기존 .env는 덮어쓰지 않는다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/launchd"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$ROOT/data" "$ROOT/logs" "$ROOT/bin"

if [[ ! -d "$ROOT/.venv" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
pip install --upgrade pip
pip install -r "$ROOT/requirements.txt"

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo ".env를 새로 만들었다. TELEGRAM_BOT_TOKEN을 채워라. 기존 토큰이 있으면 그걸 그대로 쓴다."
else
  echo "기존 .env를 유지한다. 토큰은 지우지 않았다."
fi

mkdir -p "$LAUNCH_DIR"
for name in com.baehayeong.ollama.plist com.baehayeong.local-ai.plist; do
  sed "s|__HOME__|$HOME|g; s|__ROOT__|$ROOT|g" "$PLIST_SRC/$name" > "$LAUNCH_DIR/$name"
done

launchctl unload "$LAUNCH_DIR/com.baehayeong.ollama.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.baehayeong.local-ai.plist" 2>/dev/null || true
launchctl load "$LAUNCH_DIR/com.baehayeong.ollama.plist"
launchctl load "$LAUNCH_DIR/com.baehayeong.local-ai.plist"

echo "LaunchAgent를 등록했다. 로그인 시 Ollama와 텔레그램 봇이 자동으로 뜬다."
echo "지금 바로 켜려면: $ROOT/scripts/start.sh"
