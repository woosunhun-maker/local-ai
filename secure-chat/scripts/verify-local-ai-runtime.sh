#!/bin/zsh
# Local AI 상시 실행 상태를 한 번에 점검한다. 비밀값을 출력하지 않는다.
set -euo pipefail

readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly PRIVATE_ROOT="/Users/hun/PrivateAI"
failed=0

check_http() {
  local name="$1"
  local url="$2"
  local code
  code="$(/usr/bin/curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    print "OK   ${name} (${url})"
  else
    print "FAIL ${name} (${url}) code=${code:-none}"
    failed=1
  fi
}

check_agent() {
  local label="$1"
  local mode="${2:-running}"
  if /bin/launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1; then
    if [[ "$mode" == "interval" ]]; then
      print "OK   launchd ${label} (loaded, StartInterval)"
      return 0
    fi
    if /bin/launchctl print "${DOMAIN}/${label}" 2>/dev/null | /usr/bin/grep -q 'state = running'; then
      print "OK   launchd ${label} running"
    else
      print "FAIL launchd ${label} not running"
      failed=1
    fi
  else
    print "FAIL launchd ${label} not loaded"
    failed=1
  fi
}

print "=== Local AI runtime verify ==="
check_http "ollama" "http://127.0.0.1:11434/api/tags"
check_http "secure-chat" "http://127.0.0.1:18791/health"
check_http "ai-council" "http://127.0.0.1:18792/health"
check_http "open-webui" "http://127.0.0.1:3000/health"

check_agent "homebrew.mxcl.ollama"
check_agent "com.local.privateai.secure-chat"
check_agent "com.local.privateai.telegram-general"
check_agent "com.local.privateai.codex-worker"
check_agent "com.local.ai-council.web"
check_agent "com.local.privateai.health-monitor" "interval"

if [[ -f "${PRIVATE_ROOT}/data/health/current.json" ]]; then
  print "OK   health snapshot ${PRIVATE_ROOT}/data/health/current.json"
else
  print "FAIL health snapshot missing"
  failed=1
fi

if (( failed == 0 )); then
  print "=== PASS ==="
  exit 0
fi
print "=== FAIL ==="
exit 1
