#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"

launchctl unload "$LAUNCH_DIR/com.baehayeong.local-ai.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.baehayeong.ollama.plist" 2>/dev/null || true

if [[ -f "$ROOT/logs/ollama.pid" ]]; then
  kill "$(cat "$ROOT/logs/ollama.pid")" 2>/dev/null || true
  rm -f "$ROOT/logs/ollama.pid"
fi

pkill -f "$ROOT/bot.py" 2>/dev/null || true
echo "로컬 AI 봇과 Ollama 서버를 멈췄다."
echo "다시 켜려면: $ROOT/scripts/start.sh"
echo "로그인 자동 실행을 다시 켜려면: $ROOT/scripts/setup.sh"
