#!/bin/zsh
# health monitor 소스를 PrivateAI 런타임에 동기화하고 LaunchAgent를 갱신한다.
set -euo pipefail

readonly SOURCE_ROOT="/Users/hun/Documents/로컬ai/secure-chat/ops/health"
readonly TARGET_DIR="/Users/hun/PrivateAI/app/health"
readonly AGENT_ROOT="/Users/hun/Library/LaunchAgents"
readonly LABEL="com.local.privateai.health-monitor"
readonly DOMAIN="gui/$(/usr/bin/id -u)"

/bin/mkdir -p "$TARGET_DIR" "/Users/hun/PrivateAI/logs/health" "/Users/hun/PrivateAI/data/health"
/bin/chmod 700 "$TARGET_DIR" "/Users/hun/PrivateAI/logs/health" "/Users/hun/PrivateAI/data/health"

/bin/cp "${SOURCE_ROOT}/local-ai-health-monitor.mjs" "${TARGET_DIR}/local-ai-health-monitor.mjs"
/bin/chmod 700 "${TARGET_DIR}/local-ai-health-monitor.mjs"

temporary="$(/usr/bin/mktemp "${AGENT_ROOT}/.${LABEL}.XXXXXX")"
/bin/cp "${SOURCE_ROOT}/${LABEL}.plist" "$temporary"
/bin/chmod 600 "$temporary"
/bin/mv -f "$temporary" "${AGENT_ROOT}/${LABEL}.plist"

/bin/launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
/bin/sleep 0.2
/bin/launchctl bootstrap "$DOMAIN" "${AGENT_ROOT}/${LABEL}.plist"
/bin/launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

/opt/homebrew/bin/node --check "${TARGET_DIR}/local-ai-health-monitor.mjs"
print "health-monitor 동기화 완료: ${LABEL}"
