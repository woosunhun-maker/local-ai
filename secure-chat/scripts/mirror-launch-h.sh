#!/bin/zsh
set -euo pipefail
# 아이폰 미러링이 켜진 상태에서 H 앱을 실기기에 띄운다.
# 잠금은 Face ID/암호로만 푼다. 이 스크립트는 암호를 넣지 않는다.

DEVICE="${LOCAL_AI_DEVICE_ID:-4B005B64-8C70-5382-9B54-4E24DA16B859}"
TOKEN_FILE="${1:-/tmp/mirror-token.txt}"
PIN_FILE="${2:-/tmp/mirror-pin-only.txt}"
PHRASE="${3:-미러링연결확인}"
MODE="${4:-auto}"

open -a "iPhone Mirroring"
sleep 1

if [[ ! -s "$TOKEN_FILE" ]]; then
  print -u2 "토큰 파일이 없다. 맥에서 /api/local-pair 를 먼저 만든다."
  exit 64
fi

export PHRASE
if [[ "$MODE" == "say" || ( "$MODE" == "auto" && ! -s "$PIN_FILE" ) ]]; then
  URL="$(/usr/bin/python3 -c 'from urllib.parse import quote; import os; print("localai://say?text="+quote(os.environ["PHRASE"]))')"
else
  if [[ ! -s "$PIN_FILE" ]]; then
    print -u2 "PIN 파일이 없다. 맥에서 /api/room/invite 를 먼저 만들거나 say 모드를 쓴다."
    exit 64
  fi
  export PIN="$(/bin/cat "$PIN_FILE")"
  URL="$(/usr/bin/python3 -c 'from urllib.parse import quote; import os; print("localai://mirror?pin="+quote(os.environ["PIN"])+"&text="+quote(os.environ["PHRASE"]))')"
fi
xcrun devicectl device process launch \
    --device "$DEVICE" \
    --terminate-existing \
    --payload-url "$URL" \
    com.hun.localai
