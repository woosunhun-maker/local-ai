#!/bin/zsh
set -euo pipefail

readonly RELEASE_VERSION="1.2.0"
readonly RELEASE_BUILD="9"
readonly SOURCE_ROOT="/Users/hun/Documents/로컬ai/secure-chat"
readonly APP_ROOT="/Users/hun/PrivateAI/app"
readonly TARGET_ROOT="${APP_ROOT}/secure-chat"
readonly BACKUP_ROOT="/Users/hun/PrivateAI/backups/secure-chat"
readonly RELEASE_ID="${RELEASE_VERSION}-$(/bin/date -u +%Y%m%dT%H%M%SZ)"
readonly BACKUP_PATH="${BACKUP_ROOT}/${RELEASE_ID}"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly SECURE_CHAT_LABEL="com.local.privateai.secure-chat"
readonly GROWTH_LABEL="com.local.privateai.growth-monitor"
readonly TELEGRAM_LABEL="com.local.privateai.telegram-general"
readonly CODEX_WORKER_LABEL="com.local.privateai.codex-worker"
readonly AGENT_ROOT="/Users/hun/Library/LaunchAgents"
readonly KERNEL_LOCK_HELPER="${SOURCE_ROOT}/scripts/kernel-lock.zsh"
readonly RUNTIME_MUTATION_LOCK="/Users/hun/PrivateAI/tmp/runtime-mutation.lock"
readonly CODEX_TASK_DATA_PATH="/Users/hun/PrivateAI/data/codex-bridge/tasks.json"
readonly CODEX_TASK_LOCK_PATH="${CODEX_TASK_DATA_PATH}.lock"
readonly CODEX_WORKER_LOCK_PATH="${CODEX_TASK_DATA_PATH}.worker-lock"
readonly CODEX_WORKER_LEASE_PATH="${CODEX_TASK_DATA_PATH}.worker-lease"
readonly APPROVAL_DATA_PATH="/Users/hun/PrivateAI/data/secure-chat/approvals.json"
readonly APPROVAL_LOCK_PATH="${APPROVAL_DATA_PATH}.lock"
readonly AUTH_LOCK_PATH="/Users/hun/PrivateAI/data/secure-chat/auth.json.lock"

mode="${1:-deploy}"
if (( $# > 1 )) || [[ "$mode" != "deploy" && "$mode" != "--verify-only" ]]; then
  print -u2 "Usage: $0 [--verify-only]"
  exit 64
fi

stage_path=""
transaction_started=false
had_previous_runtime=false
deployment_committed=false
launchagent_rollback_root=""
had_secure_chat_plist=false
had_growth_plist=false
had_telegram_plist=false
had_codex_worker_plist=false
data_rollback_root=""
had_codex_task_data=false
had_codex_task_lock=false
had_codex_worker_lock=false
had_codex_worker_lease=false
had_approval_data=false
had_approval_lock=false
had_auth_lock=false
data_backup_captured=false
telegram_preflight_ready=false
codex_preflight_ready=false
post_commit_degraded=false

wait_for_health() {
  local url="$1"
  local attempts="${2:-90}"
  local code=""
  local attempt
  for attempt in {1..${attempts}}; do
    code="$(/usr/bin/curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
    if [[ "$code" == "200" ]]; then return 0; fi
    /bin/sleep 1
  done
  print -u2 "Health check failed: ${url}"
  return 1
}

wait_for_running_agent() {
  local label="$1"
  local attempts="${2:-30}"
  local attempt
  for attempt in {1..${attempts}}; do
    if /bin/launchctl print "${DOMAIN}/${label}" 2>/dev/null | /usr/bin/grep -q 'state = running'; then
      /bin/sleep 1
      if /bin/launchctl print "${DOMAIN}/${label}" 2>/dev/null | /usr/bin/grep -q 'state = running'; then
        return 0
      fi
    fi
    /bin/sleep 1
  done
  print -u2 "LaunchAgent did not remain running: ${label}"
  return 1
}

wait_for_codex_worker_ready() {
  local attempts="${1:-30}"
  local attempt
  for attempt in {1..${attempts}}; do
    if /opt/homebrew/bin/node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const moduleUrl = pathToFileURL(process.argv[1]).href;
      const { CodexTaskStore } = await import(moduleUrl);
      const store = new CodexTaskStore(process.argv[2]);
      process.exit(await store.workerReady() ? 0 : 1);
    ' "${TARGET_ROOT}/src/codex/task-store.mjs" "$CODEX_TASK_DATA_PATH" >/dev/null 2>&1; then
      /bin/sleep 1
      if /opt/homebrew/bin/node --input-type=module -e '
        import { pathToFileURL } from "node:url";
        const moduleUrl = pathToFileURL(process.argv[1]).href;
        const { CodexTaskStore } = await import(moduleUrl);
        const store = new CodexTaskStore(process.argv[2]);
        process.exit(await store.workerReady() ? 0 : 1);
      ' "${TARGET_ROOT}/src/codex/task-store.mjs" "$CODEX_TASK_DATA_PATH" >/dev/null 2>&1; then
        return 0
      fi
    fi
    /bin/sleep 1
  done
  print -u2 "Codex worker did not publish a stable durable lease."
  return 1
}

acquire_runtime_mutation_lock() {
  if [[ ! -f "$KERNEL_LOCK_HELPER" ]]; then
    print -u2 "Kernel lock helper is missing: ${KERNEL_LOCK_HELPER}"
    return 1
  fi
  source "$KERNEL_LOCK_HELPER"
  if ! local_ai_kernel_lock_acquire "$RUNTIME_MUTATION_LOCK"; then
    print -u2 "Another runtime mutation is active, or the shared lock boundary is unsafe."
    return 1
  fi
}

bootout_agent() {
  local label="$1"
  /bin/launchctl bootout "${DOMAIN}/${label}" >/dev/null 2>&1 || true
}

wait_for_unloaded_agent() {
  local label="$1"
  local attempts="${2:-50}"
  local attempt
  for attempt in {1..${attempts}}; do
    if ! /bin/launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 0.1
  done
  print -u2 "LaunchAgent did not unload within the bounded wait: ${label}"
  return 1
}

stop_runtime_services() {
  local label
  for label in "$TELEGRAM_LABEL" "$CODEX_WORKER_LABEL" "$GROWTH_LABEL" "$SECURE_CHAT_LABEL"; do
    bootout_agent "$label"
  done
  for label in "$TELEGRAM_LABEL" "$CODEX_WORKER_LABEL" "$GROWTH_LABEL" "$SECURE_CHAT_LABEL"; do
    wait_for_unloaded_agent "$label" 50
  done
}

atomic_restore_data_file() {
  local source="$1"
  local destination="$2"
  local destination_directory="${destination:h}"
  local temporary
  /bin/mkdir -p "$destination_directory" || return 1
  /bin/chmod 700 "$destination_directory" || return 1
  temporary="$(/usr/bin/mktemp "${destination_directory}/.$(/usr/bin/basename "$destination").rollback.XXXXXX")" || return 1
  if ! /bin/cp -p "$source" "$temporary"; then
    /bin/rm -f -- "$temporary" || true
    return 1
  fi
  if ! /bin/chmod 600 "$temporary"; then
    /bin/rm -f -- "$temporary" || true
    return 1
  fi
  if ! /bin/mv -f "$temporary" "$destination"; then
    /bin/rm -f -- "$temporary" || true
    return 1
  fi
}

capture_private_state_file() {
  local source="$1"
  local destination="$2"
  local mode_bits
  local owner_uid
  local link_count
  if [[ -L "$source" || ! -f "$source" ]]; then
    print -u2 "Rollback input is not a regular private file: ${source}"
    return 1
  fi
  mode_bits="$(/usr/bin/stat -f '%Lp' "$source")" || return 1
  owner_uid="$(/usr/bin/stat -f '%u' "$source")" || return 1
  link_count="$(/usr/bin/stat -f '%l' "$source")" || return 1
  if [[ "$mode_bits" != "600" || "$owner_uid" != "$(/usr/bin/id -u)" || "$link_count" != "1" ]]; then
    print -u2 "Rollback input has unsafe ownership or mode: ${source}"
    return 1
  fi
  /bin/cp -p "$source" "$destination" || return 1
  /bin/chmod 600 "$destination" || return 1
}

restore_private_state_file() {
  local existed="$1"
  local backup="$2"
  local destination="$3"
  if [[ "$existed" == true ]]; then
    atomic_restore_data_file "$backup" "$destination" || return 1
  else
    /bin/rm -f -- "$destination" || return 1
  fi
}

capture_data_state() {
  data_rollback_root="$(/usr/bin/mktemp -d "${BACKUP_ROOT}/.deploy-data-rollback-XXXXXX")" || return 1
  /bin/chmod 700 "$data_rollback_root" || return 1
  if [[ -e "$CODEX_TASK_DATA_PATH" || -L "$CODEX_TASK_DATA_PATH" ]]; then
    capture_private_state_file "$CODEX_TASK_DATA_PATH" "${data_rollback_root}/tasks.json" || return 1
    had_codex_task_data=true
  fi
  if [[ -e "$CODEX_TASK_LOCK_PATH" || -L "$CODEX_TASK_LOCK_PATH" ]]; then
    capture_private_state_file "$CODEX_TASK_LOCK_PATH" "${data_rollback_root}/tasks.lock" || return 1
    had_codex_task_lock=true
  fi
  if [[ -e "$CODEX_WORKER_LOCK_PATH" || -L "$CODEX_WORKER_LOCK_PATH" ]]; then
    capture_private_state_file "$CODEX_WORKER_LOCK_PATH" "${data_rollback_root}/tasks.worker-lock" || return 1
    had_codex_worker_lock=true
  fi
  if [[ -e "$CODEX_WORKER_LEASE_PATH" || -L "$CODEX_WORKER_LEASE_PATH" ]]; then
    capture_private_state_file "$CODEX_WORKER_LEASE_PATH" "${data_rollback_root}/tasks.worker-lease" || return 1
    had_codex_worker_lease=true
  fi
  if [[ -e "$APPROVAL_DATA_PATH" || -L "$APPROVAL_DATA_PATH" ]]; then
    capture_private_state_file "$APPROVAL_DATA_PATH" "${data_rollback_root}/approvals.json" || return 1
    had_approval_data=true
  fi
  if [[ -e "$APPROVAL_LOCK_PATH" || -L "$APPROVAL_LOCK_PATH" ]]; then
    capture_private_state_file "$APPROVAL_LOCK_PATH" "${data_rollback_root}/approvals.lock" || return 1
    had_approval_lock=true
  fi
  if [[ -e "$AUTH_LOCK_PATH" || -L "$AUTH_LOCK_PATH" ]]; then
    capture_private_state_file "$AUTH_LOCK_PATH" "${data_rollback_root}/auth.lock" || return 1
    had_auth_lock=true
  fi
  data_backup_captured=true
}

restore_data_state() {
  local restore_failed=false
  [[ "$data_backup_captured" == true ]] || return 0
  restore_private_state_file "$had_codex_task_data" "${data_rollback_root}/tasks.json" "$CODEX_TASK_DATA_PATH" || restore_failed=true
  restore_private_state_file "$had_codex_task_lock" "${data_rollback_root}/tasks.lock" "$CODEX_TASK_LOCK_PATH" || restore_failed=true
  restore_private_state_file "$had_codex_worker_lock" "${data_rollback_root}/tasks.worker-lock" "$CODEX_WORKER_LOCK_PATH" || restore_failed=true
  restore_private_state_file "$had_codex_worker_lease" "${data_rollback_root}/tasks.worker-lease" "$CODEX_WORKER_LEASE_PATH" || restore_failed=true
  restore_private_state_file "$had_approval_data" "${data_rollback_root}/approvals.json" "$APPROVAL_DATA_PATH" || restore_failed=true
  restore_private_state_file "$had_approval_lock" "${data_rollback_root}/approvals.lock" "$APPROVAL_LOCK_PATH" || restore_failed=true
  restore_private_state_file "$had_auth_lock" "${data_rollback_root}/auth.lock" "$AUTH_LOCK_PATH" || restore_failed=true
  [[ "$restore_failed" == false ]]
}

assert_no_active_codex_tasks() {
  [[ -f "$CODEX_TASK_DATA_PATH" ]] || return 0
  /opt/homebrew/bin/node -e '
    const fs = require("node:fs");
    const store = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (![2, 3].includes(store?.version) || !Array.isArray(store.jobs)) process.exit(2);
    if (store.jobs.some((job) => ["awaiting_approval", "queued", "running"].includes(job?.status))) process.exit(3);
  ' "$CODEX_TASK_DATA_PATH"
}

bootstrap_agent_if_present() {
  local label="$1"
  local plist="$2"
  local attempt
  local bootstrap_error=""
  [[ -f "$plist" ]] || return 0
  for attempt in {1..5}; do
    print "Bootstrapping LaunchAgent: ${label} (attempt ${attempt}/5)"
    if bootstrap_error="$(/bin/launchctl bootstrap "$DOMAIN" "$plist" 2>&1)"; then
      if /bin/launchctl kickstart "$DOMAIN/$label" >/dev/null 2>&1; then
        return 0
      fi
      print -u2 "Kickstart failed after bootstrap for ${label}; retrying from an unloaded state."
      bootout_agent "$label"
      wait_for_unloaded_agent "$label" 50 || true
      /bin/sleep 0.25
      continue
    fi
    print -u2 "Bootstrap attempt ${attempt} failed for ${label}: ${bootstrap_error}"
    wait_for_unloaded_agent "$label" 50 || true
    /bin/sleep 0.25
  done
  print -u2 "LaunchAgent bootstrap failed after retries: ${label}"
  return 1
}

atomic_restore_plist() {
  local source="$1"
  local destination="$2"
  local temporary
  temporary="$(/usr/bin/mktemp "${AGENT_ROOT}/.$(/usr/bin/basename "$destination").XXXXXX")"
  /bin/cp -p "$source" "$temporary"
  /bin/chmod 600 "$temporary"
  /bin/mv -f "$temporary" "$destination"
}

capture_launchagent_state() {
  launchagent_rollback_root="$(/usr/bin/mktemp -d "${BACKUP_ROOT}/.deploy-launchagents-rollback-XXXXXX")"
  /bin/chmod 700 "$launchagent_rollback_root"

  if [[ -f "${AGENT_ROOT}/${SECURE_CHAT_LABEL}.plist" ]]; then
    /bin/cp -p "${AGENT_ROOT}/${SECURE_CHAT_LABEL}.plist" "${launchagent_rollback_root}/${SECURE_CHAT_LABEL}.plist"
    had_secure_chat_plist=true
  fi
  if [[ -f "${AGENT_ROOT}/${GROWTH_LABEL}.plist" ]]; then
    /bin/cp -p "${AGENT_ROOT}/${GROWTH_LABEL}.plist" "${launchagent_rollback_root}/${GROWTH_LABEL}.plist"
    had_growth_plist=true
  fi
  if [[ -f "${AGENT_ROOT}/${TELEGRAM_LABEL}.plist" ]]; then
    /bin/cp -p "${AGENT_ROOT}/${TELEGRAM_LABEL}.plist" "${launchagent_rollback_root}/${TELEGRAM_LABEL}.plist"
    had_telegram_plist=true
  fi
  if [[ -f "${AGENT_ROOT}/${CODEX_WORKER_LABEL}.plist" ]]; then
    /bin/cp -p "${AGENT_ROOT}/${CODEX_WORKER_LABEL}.plist" "${launchagent_rollback_root}/${CODEX_WORKER_LABEL}.plist"
    had_codex_worker_plist=true
  fi
}

restore_launchagent_state() {
  local restore_failed=false
  local label
  local had_previous
  for label had_previous in \
    "$SECURE_CHAT_LABEL" "$had_secure_chat_plist" \
    "$GROWTH_LABEL" "$had_growth_plist" \
    "$TELEGRAM_LABEL" "$had_telegram_plist" \
    "$CODEX_WORKER_LABEL" "$had_codex_worker_plist"; do
    if [[ "$had_previous" == true ]]; then
      atomic_restore_plist "${launchagent_rollback_root}/${label}.plist" "${AGENT_ROOT}/${label}.plist" || restore_failed=true
    else
      /bin/rm -f -- "${AGENT_ROOT}/${label}.plist" || restore_failed=true
    fi
  done
  [[ "$restore_failed" == false ]]
}

restore_runtime_services() {
  stop_runtime_services || return 1

  bootstrap_agent_if_present "$SECURE_CHAT_LABEL" "${AGENT_ROOT}/${SECURE_CHAT_LABEL}.plist" || return 1
  bootstrap_agent_if_present "$GROWTH_LABEL" "${AGENT_ROOT}/${GROWTH_LABEL}.plist" || return 1
  if [[ -f "${TARGET_ROOT}/scripts/launch-telegram-general.sh" ]] && \
     /bin/zsh "${TARGET_ROOT}/scripts/launch-telegram-general.sh" --check >/dev/null 2>&1; then
    bootstrap_agent_if_present "$TELEGRAM_LABEL" "${AGENT_ROOT}/${TELEGRAM_LABEL}.plist" || return 1
  fi
  if [[ -f "${TARGET_ROOT}/scripts/launch-codex-worker.sh" ]] && \
     /bin/zsh "${TARGET_ROOT}/scripts/launch-codex-worker.sh" --check >/dev/null 2>&1; then
    bootstrap_agent_if_present "$CODEX_WORKER_LABEL" "${AGENT_ROOT}/${CODEX_WORKER_LABEL}.plist" || return 1
  fi
  wait_for_health "http://127.0.0.1:18791/health" 90
}

rollback_runtime() {
  local rollback_failed=false
  local runtime_restored=true
  local launchagents_restored=true
  print -u2 "Deployment verification failed; restoring the previous runtime."

  stop_runtime_services || rollback_failed=true

  if [[ "$had_previous_runtime" == true ]]; then
    if [[ -d "$BACKUP_PATH" ]]; then
      if [[ -e "$TARGET_ROOT" ]]; then
        /bin/rm -rf -- "$TARGET_ROOT" || runtime_restored=false
        if [[ -e "$TARGET_ROOT" ]]; then runtime_restored=false; fi
      fi
      if [[ "$runtime_restored" == true ]]; then
        /bin/mv "$BACKUP_PATH" "$TARGET_ROOT" || runtime_restored=false
      fi
    else
      # If BACKUP_PATH does not exist, interruption happened before the old
      # runtime move completed. The original TARGET_ROOT must still exist.
      if [[ ! -d "$TARGET_ROOT" ]]; then
        print -u2 "Rollback runtime is missing: ${BACKUP_PATH}"
        runtime_restored=false
      fi
    fi
  elif [[ -e "$TARGET_ROOT" ]]; then
    /bin/rm -rf -- "$TARGET_ROOT" || runtime_restored=false
    if [[ -e "$TARGET_ROOT" ]]; then runtime_restored=false; fi
  fi

  restore_launchagent_state || launchagents_restored=false
  restore_data_state || runtime_restored=false
  if [[ "$runtime_restored" == true && "$launchagents_restored" == true && "$had_previous_runtime" == true && -d "$TARGET_ROOT" ]]; then
    restore_runtime_services || rollback_failed=true
  fi
  if [[ "$runtime_restored" == false ]]; then
    print -u2 "Runtime restore was incomplete; rollback data was preserved at ${BACKUP_PATH}"
    rollback_failed=true
  fi
  if [[ "$launchagents_restored" == false ]]; then
    print -u2 "LaunchAgent restore was incomplete; services were left stopped."
    rollback_failed=true
  fi
  [[ "$rollback_failed" == false ]]
}

cleanup() {
  local exit_code=$?
  local preserve_rollback=false
  trap - EXIT INT TERM HUP

  if (( exit_code != 0 )) && [[ "$transaction_started" == true && "$deployment_committed" == false ]]; then
    if ! rollback_runtime; then
      exit_code=1
      preserve_rollback=true
    fi
  fi
  if [[ -n "$stage_path" && "$stage_path" == "${APP_ROOT}/.secure-chat-stage-"* && -d "$stage_path" ]]; then
    /bin/rm -rf -- "$stage_path" || exit_code=1
  fi
  if [[ "$preserve_rollback" == false && -n "$launchagent_rollback_root" && "$launchagent_rollback_root" == "${BACKUP_ROOT}/.deploy-launchagents-rollback-"* && -d "$launchagent_rollback_root" ]]; then
    /bin/rm -rf -- "$launchagent_rollback_root" || exit_code=1
  fi
  if [[ "$preserve_rollback" == false && -n "$data_rollback_root" && "$data_rollback_root" == "${BACKUP_ROOT}/.deploy-data-rollback-"* && -d "$data_rollback_root" ]]; then
    /bin/rm -rf -- "$data_rollback_root" || exit_code=1
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

ios_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "${SOURCE_ROOT}/ios/LocalAI/Resources/Info.plist")"
ios_build="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "${SOURCE_ROOT}/ios/LocalAI/Resources/Info.plist")"
server_version="$(/opt/homebrew/bin/node -p "require('${SOURCE_ROOT}/package.json').version")"
if [[ "$ios_version" != "$RELEASE_VERSION" || "$server_version" != "$RELEASE_VERSION" ]]; then
  print -u2 "Release version mismatch: iOS=${ios_version}, server=${server_version}, expected=${RELEASE_VERSION}"
  exit 1
fi
if [[ "$ios_build" != "$RELEASE_BUILD" ]]; then
  print -u2 "iOS build mismatch: ${ios_build}, expected=${RELEASE_BUILD}"
  exit 1
fi

acquire_runtime_mutation_lock
/bin/mkdir -p "$APP_ROOT" "$BACKUP_ROOT"
/bin/chmod 700 "$APP_ROOT" "$BACKUP_ROOT"
stage_path="$(/usr/bin/mktemp -d "${APP_ROOT}/.secure-chat-stage-XXXXXX")"
/bin/chmod 700 "$stage_path"

/usr/bin/rsync -a \
  "$SOURCE_ROOT/src" \
  "$SOURCE_ROOT/public" \
  "$SOURCE_ROOT/scripts" \
  "$SOURCE_ROOT/docs" \
  "$SOURCE_ROOT/test" \
  "$SOURCE_ROOT/package.json" \
  "$SOURCE_ROOT/README.md" \
  "$stage_path/"
/bin/chmod -R go-rwx "$stage_path"

/opt/homebrew/bin/node --check "$stage_path/src/server.mjs"
/opt/homebrew/bin/node --check "$stage_path/scripts/apply-openclaw-privacy-hardening.mjs"
/opt/homebrew/bin/node --check "$stage_path/scripts/telegram-general.mjs"
/opt/homebrew/bin/node --check "$stage_path/scripts/codex-worker.mjs"
/opt/homebrew/bin/node --check "$stage_path/scripts/migrate-codex-task-store.mjs"
/bin/zsh -n "$stage_path/scripts/deploy-runtime.sh"
/bin/zsh -n "$stage_path/scripts/install-release-launchagents.sh"
/bin/zsh -n "$stage_path/scripts/launch-telegram-general.sh"
/bin/zsh -n "$stage_path/scripts/launch-codex-worker.sh"
/bin/zsh -n "$stage_path/scripts/trash-old-localai-versions.sh"
/usr/bin/plutil -lint \
  "$stage_path/scripts/com.local.privateai.growth-monitor.plist" \
  "$stage_path/scripts/com.local.privateai.telegram-general.plist" \
  "$stage_path/scripts/com.local.privateai.codex-worker.plist" >/dev/null
(exec 9>&-; cd "$stage_path" && /opt/homebrew/bin/node --test)

if [[ "$mode" == "--verify-only" ]]; then
  print "Release ${RELEASE_VERSION} build ${RELEASE_BUILD} passed staged verification; no runtime was replaced."
  exit 0
fi

# Codex execution is a required part of this release. Validate the staged
# launcher, local configuration, pinned binary and client authentication path
# before stopping or replacing any live service.
if ! /bin/zsh "$stage_path/scripts/launch-codex-worker.sh" --check >/dev/null 2>&1; then
  print -u2 "Codex preflight failed; the live runtime was not modified."
  exit 1
fi
codex_preflight_ready=true
if /bin/zsh "$stage_path/scripts/launch-telegram-general.sh" --check >/dev/null 2>&1; then
  telegram_preflight_ready=true
fi

if [[ -e "$BACKUP_PATH" ]]; then
  print -u2 "Refusing to overwrite an existing rollback path: ${BACKUP_PATH}"
  exit 1
fi
if [[ -e "$TARGET_ROOT" ]]; then
  had_previous_runtime=true
fi
capture_launchagent_state
transaction_started=true
stop_runtime_services
assert_no_active_codex_tasks
capture_data_state
if [[ "$had_previous_runtime" == true ]]; then
  # Arm the rollback state before the first live-tree mutation. Cleanup also
  # inspects TARGET_ROOT/BACKUP_PATH, so an interrupt between mv and the next
  # assignment still restores the correct tree.
  /bin/mv "$TARGET_ROOT" "$BACKUP_PATH"
fi
/bin/mv "$stage_path" "$TARGET_ROOT"
stage_path=""
/bin/chmod 700 "$TARGET_ROOT"

# Test the exact deployed tree before any rollback copy is discarded.
(exec 9>&-; cd "$TARGET_ROOT" && /opt/homebrew/bin/node --test)
/opt/homebrew/bin/node "${TARGET_ROOT}/scripts/migrate-codex-task-store.mjs" >/dev/null
if [[ "$telegram_preflight_ready" == true ]]; then
  /bin/zsh "${TARGET_ROOT}/scripts/launch-telegram-general.sh" --check >/dev/null 2>&1
fi
/bin/zsh "${TARGET_ROOT}/scripts/launch-codex-worker.sh" --check >/dev/null 2>&1
"${TARGET_ROOT}/scripts/install-release-launchagents.sh" --install-only

# With the API still offline and the active-task gate at zero, the worker can
# safely establish its durable lease. Any failure here is still pre-commit and
# therefore restores the previous runtime, plists and data as one transaction.
bootstrap_agent_if_present "$CODEX_WORKER_LABEL" "${AGENT_ROOT}/${CODEX_WORKER_LABEL}.plist"
wait_for_running_agent "$CODEX_WORKER_LABEL" 30
wait_for_codex_worker_ready 30

# Offline migration and the required worker lease are now stable. Commit before
# exposing the API: immediately after server bootstrap an owner request could
# create or approve work, so task/approval data must never be rolled back from
# this point onward.
deployment_committed=true
transaction_started=false

if ! bootstrap_agent_if_present "$SECURE_CHAT_LABEL" "${AGENT_ROOT}/${SECURE_CHAT_LABEL}.plist" || \
   ! wait_for_running_agent "$SECURE_CHAT_LABEL" 30 || \
   ! wait_for_health "http://127.0.0.1:18791/health" 90; then
  bootout_agent "$SECURE_CHAT_LABEL"
  post_commit_degraded=true
  print -u2 "DEGRADED: Secure Chat API failed post-commit readiness and was safely stopped."
elif ! wait_for_codex_worker_ready 15; then
  bootout_agent "$CODEX_WORKER_LABEL"
  post_commit_degraded=true
  print -u2 "DEGRADED: Codex worker lost readiness after API exposure and was safely stopped."
fi

if ! bootstrap_agent_if_present "$GROWTH_LABEL" "${AGENT_ROOT}/${GROWTH_LABEL}.plist"; then
  print -u2 "Growth monitor remained safely stopped after the committed deployment."
fi
if [[ "$telegram_preflight_ready" == true ]]; then
  if ! bootstrap_agent_if_present "$TELEGRAM_LABEL" "${AGENT_ROOT}/${TELEGRAM_LABEL}.plist" || \
     ! wait_for_running_agent "$TELEGRAM_LABEL" 30; then
    bootout_agent "$TELEGRAM_LABEL"
    post_commit_degraded=true
    print -u2 "DEGRADED: Telegram relay remained safely stopped after the committed deployment."
  fi
fi
if ! wait_for_running_agent "$CODEX_WORKER_LABEL" 5 || ! wait_for_codex_worker_ready 5; then
  bootout_agent "$CODEX_WORKER_LABEL"
  post_commit_degraded=true
  print -u2 "DEGRADED: Codex worker lost readiness after the committed deployment and was safely stopped."
fi

if [[ "$had_previous_runtime" == true ]]; then
  /bin/rm -rf -- "$BACKUP_PATH"
fi
if [[ -n "$launchagent_rollback_root" ]]; then
  /bin/rm -rf -- "$launchagent_rollback_root"
  launchagent_rollback_root=""
fi
if [[ -n "$data_rollback_root" ]]; then
  /bin/rm -rf -- "$data_rollback_root"
  data_rollback_root=""
fi

if [[ "$post_commit_degraded" == true ]]; then
  print -u2 "DEGRADED: Runtime ${RELEASE_VERSION} build ${RELEASE_BUILD} was committed, but a required ready service is stopped. Rollback copies were removed to prevent duplicate task execution."
  exit 1
fi

print "Runtime ${RELEASE_VERSION} build ${RELEASE_BUILD} deployed and verified; rollback copy removed."
