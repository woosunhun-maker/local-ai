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

TOKEN=""
if [[ -f "$ROOT/.env" ]]; then
  TOKEN="$(python3 - "$ROOT/.env" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text(encoding="utf-8")
for line in text.splitlines():
    if line.startswith("TELEGRAM_BOT_TOKEN="):
        print(line.split("=", 1)[1].strip())
        break
PY
)"
fi

if [[ -n "$TOKEN" ]]; then
  launchctl load "$LAUNCH_DIR/com.baehayeong.local-ai.plist"
  echo "LaunchAgent를 등록했다. 로그인 시 Ollama와 텔레그램 봇이 자동으로 뜬다."
else
  echo "Ollama LaunchAgent만 등록했다. TELEGRAM_BOT_TOKEN이 아직 비어 있어 봇은 켜지 않았다."
  echo "토큰을 넣은 뒤: $ROOT/scripts/set-token.sh '토큰값'"
fi
echo "지금 바로 켜려면: $ROOT/scripts/start.sh"
