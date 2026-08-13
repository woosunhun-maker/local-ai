#!/bin/zsh
set -u

readonly ROOT="/Users/hun/PrivateAI"
readonly NODE="/opt/homebrew/bin/node"
readonly CONFIG_PATH="${ROOT}/config/telegram-general.json"
readonly TELEGRAM_MAIN="${ROOT}/app/secure-chat/scripts/telegram-general.mjs"
readonly KEYCHAIN_SERVICE="local.privateai.telegram.bot-token"
readonly KEYCHAIN_ACCOUNT="local-ai"
readonly TOKEN_PATTERN='^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$'

check_only=false
if [[ "${1:-}" == "--check" ]]; then
  check_only=true
elif (( $# > 0 )); then
  print -u2 "Usage: $0 [--check]"
  exit 64
fi

disabled() {
  local reason="$1"
  if [[ "$check_only" == true ]]; then exit 1; fi
  print -- "{\"outcome\":\"disabled\",\"reason\":\"${reason}\"}"
  exit 0
}

[[ -x "$NODE" && -f "$TELEGRAM_MAIN" ]] || disabled "runtime_missing"
[[ -f "$CONFIG_PATH" ]] || disabled "configuration_missing"

"$NODE" -e '
  const fs = require("node:fs");
  try {
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const valid = value?.version === 1 && value?.enabled === true && /^[1-9][0-9]{5,19}$/.test(String(value?.ownerId ?? ""));
    process.exit(valid ? 0 : 1);
  } catch { process.exit(1); }
' "$CONFIG_PATH" >/dev/null 2>&1 || disabled "configuration_invalid"

token="$(/usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null)" || disabled "token_missing"
[[ "$token" =~ ${TOKEN_PATTERN} ]] || disabled "token_invalid"
token=""

if [[ "$check_only" == true ]]; then exit 0; fi
exec "$NODE" "$TELEGRAM_MAIN"
