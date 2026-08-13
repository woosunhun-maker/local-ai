#!/bin/zsh
# 로컬 AI 원클릭: KeepAlive 서버를 깨우고 브라우저만 연다
set -euo pipefail

LABEL="com.local.ai-council.web"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
URL="http://127.0.0.1:18792/"
UID_NUM="$(id -u)"

if [[ ! -f "$PLIST" ]]; then
  osascript -e 'display dialog "상시 실행 설정(plist)이 없습니다." buttons {"확인"} default button 1 with title "Local AI"'
  exit 1
fi

# Documents/Terminal 잔여 프로세스 정리 후 launchd에 맡김
pkill -f "/Users/hun/Documents/로컬ai/ai-council/scripts/serve_local.py" 2>/dev/null || true
sleep 0.2

launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST" >/dev/null 2>&1 || true
launchctl enable "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true

for _ in {1..50}; do
  if curl -sS -m 1 "${URL}health" >/dev/null 2>&1; then
    open "$URL"
    osascript -e 'display notification "로컬 AI 상시 실행 연결됨 (Terminal 불필요)" with title "Local AI"'
    exit 0
  fi
  sleep 0.2
done

DETAIL="$(tail -n 20 /Users/hun/PrivateAI/app/ai-council/logs/web.stderr.log 2>/dev/null || true)"
osascript -e 'display dialog "로컬 AI 서버 연결 실패\n'"$DETAIL"'" buttons {"확인"} default button 1 with title "Local AI"'
exit 1
