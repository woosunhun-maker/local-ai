#!/usr/bin/env bash
# 텔레그램 봇 토큰을 .env에 넣고 봇 LaunchAgent를 켠다. 기존 채팅 ID는 유지한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${1:-}"

if [[ -z "$TOKEN" ]]; then
  echo "사용법: $0 'BotFather토큰'" >&2
  echo "기존 토큰이 있으면 그걸 그대로 넣는다. 토큰을 폐기하지 않는다." >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
fi

python3 - "$ROOT/.env" "$TOKEN" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
token = sys.argv[2]
text = path.read_text(encoding="utf-8") if path.exists() else ""
line = f"TELEGRAM_BOT_TOKEN={token}"
if any(row.startswith("TELEGRAM_BOT_TOKEN=") for row in text.splitlines()):
    out = []
    for row in text.splitlines():
        if row.startswith("TELEGRAM_BOT_TOKEN="):
            out.append(line)
        else:
            out.append(row)
    text = "\n".join(out) + "\n"
else:
    text = text + ("" if text.endswith("\n") or not text else "\n") + line + "\n"
path.write_text(text, encoding="utf-8")
PY

chmod +x "$ROOT/scripts/"*.sh
"$ROOT/scripts/setup.sh"
echo "토큰을 저장했다. 텔레그램에서 봇에게 /start 를 보내면 이 채팅이 주인으로 등록된다."
