#!/bin/zsh
set -u

readonly ROOT="/Users/hun/PrivateAI"
readonly NODE="/opt/homebrew/bin/node"
readonly CONFIG_PATH="${ROOT}/config/codex-bridge.json"
readonly WORKER_MAIN="${ROOT}/app/secure-chat/scripts/codex-worker.mjs"
readonly CODEX_BIN="/Users/hun/PrivateAI/runtime/codex/0.147.0-alpha.1.2/codex"
readonly EXPECTED_CODEX_VERSION="codex-cli 0.147.0-alpha.1.2"
readonly EXPECTED_CODEX_MODEL="gpt-5.6-sol"

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

[[ -x "$NODE" && -f "$WORKER_MAIN" ]] || disabled "runtime_missing"
[[ -x "$CODEX_BIN" ]] || disabled "codex_binary_missing"
[[ -f "$CONFIG_PATH" ]] || disabled "configuration_missing"

"$NODE" -e '
  const fs = require("node:fs");
  try {
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const valid = value?.version === 1 && value?.enabled === true &&
      value?.mode === "isolated_inspect_and_draft" &&
      value?.codexVersion === process.argv[2] &&
      value?.model === process.argv[3];
    process.exit(valid ? 0 : 1);
  } catch { process.exit(1); }
' "$CONFIG_PATH" "$EXPECTED_CODEX_VERSION" "$EXPECTED_CODEX_MODEL" >/dev/null 2>&1 || disabled "configuration_invalid"

actual_version="$("$CODEX_BIN" --version 2>/dev/null)" || disabled "codex_version_unavailable"
[[ "$actual_version" == "$EXPECTED_CODEX_VERSION" ]] || disabled "codex_version_mismatch"

if [[ "$check_only" == true ]]; then exit 0; fi
exec "$NODE" "$WORKER_MAIN"
