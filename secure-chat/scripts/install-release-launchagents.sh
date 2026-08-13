#!/bin/zsh
set -euo pipefail

readonly PRIVATE_ROOT="/Users/hun/PrivateAI"
readonly SOURCE_ROOT="${PRIVATE_ROOT}/app/secure-chat"
readonly AGENT_ROOT="/Users/hun/Library/LaunchAgents"
readonly SECURE_CHAT_LABEL="com.local.privateai.secure-chat"
readonly GROWTH_LABEL="com.local.privateai.growth-monitor"
readonly TELEGRAM_LABEL="com.local.privateai.telegram-general"
readonly CODEX_WORKER_LABEL="com.local.privateai.codex-worker"
readonly SECURE_CHAT_PLIST="${AGENT_ROOT}/${SECURE_CHAT_LABEL}.plist"
readonly GROWTH_PLIST="${AGENT_ROOT}/${GROWTH_LABEL}.plist"
readonly TELEGRAM_PLIST="${AGENT_ROOT}/${TELEGRAM_LABEL}.plist"
readonly CODEX_WORKER_PLIST="${AGENT_ROOT}/${CODEX_WORKER_LABEL}.plist"
readonly SOURCE_GROWTH_PLIST="${SOURCE_ROOT}/scripts/${GROWTH_LABEL}.plist"
readonly SOURCE_TELEGRAM_PLIST="${SOURCE_ROOT}/scripts/${TELEGRAM_LABEL}.plist"
readonly SOURCE_CODEX_WORKER_PLIST="${SOURCE_ROOT}/scripts/${CODEX_WORKER_LABEL}.plist"
readonly TELEGRAM_LAUNCHER="${SOURCE_ROOT}/scripts/launch-telegram-general.sh"
readonly CODEX_WORKER_LAUNCHER="${SOURCE_ROOT}/scripts/launch-codex-worker.sh"
readonly DOMAIN="gui/$(/usr/bin/id -u)"
readonly KERNEL_LOCK_HELPER="${SOURCE_ROOT}/scripts/kernel-lock.zsh"
readonly RUNTIME_MUTATION_LOCK="${PRIVATE_ROOT}/tmp/runtime-mutation.lock"

mode="${1:-install}"
if (( $# > 1 )) || [[ "$mode" != "install" && "$mode" != "--verify-only" && "$mode" != "--install-only" ]]; then
  print -u2 "Usage: $0 [--verify-only|--install-only]"
  exit 64
fi

stage_root=""
rollback_root=""
plists_replaced=false
installation_committed=false
had_growth_plist=false
had_telegram_plist=false
had_codex_worker_plist=false

atomic_replace() {
  local source="$1"
  local destination="$2"
  local temporary
  temporary="$(/usr/bin/mktemp "${AGENT_ROOT}/.$(/usr/bin/basename "$destination").XXXXXX")"
  /bin/cp -p "$source" "$temporary"
  /bin/chmod 600 "$temporary"
  /bin/mv -f "$temporary" "$destination"
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

bootstrap_agent() {
  local label="$1"
  local plist="$2"
  local attempt
  local bootstrap_error=""
  for attempt in {1..5}; do
    print "Bootstrapping LaunchAgent: ${label} (attempt ${attempt}/5)"
    if bootstrap_error="$(/bin/launchctl bootstrap "$DOMAIN" "$plist" 2>&1)"; then
      return 0
    fi
    print -u2 "Bootstrap attempt ${attempt} failed for ${label}: ${bootstrap_error}"
    wait_for_unloaded_agent "$label" 50 || true
    /bin/sleep 0.25
  done
  print -u2 "LaunchAgent bootstrap failed after retries: ${label}"
  return 1
}

reload_agent() {
  local label="$1"
  local plist="$2"
  print "Reloading LaunchAgent: ${label}"
  bootout_agent "$label"
  wait_for_unloaded_agent "$label" 50
  bootstrap_agent "$label" "$plist"
}

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
      return 0
    fi
    /bin/sleep 1
  done
  print -u2 "LaunchAgent did not reach running state: ${label}"
  return 1
}

wait_for_disabled_agent() {
  local label="$1"
  local attempts="${2:-30}"
  local attempt
  local job_info
  for attempt in {1..${attempts}}; do
    job_info="$(/bin/launchctl print "${DOMAIN}/${label}" 2>/dev/null || true)"
    if print -r -- "$job_info" | /usr/bin/grep -q 'state = not running' && \
       print -r -- "$job_info" | /usr/bin/grep -q 'last exit code = 0'; then
      return 0
    fi
    /bin/sleep 1
  done
  print -u2 "LaunchAgent did not exit safely disabled: ${label}"
  return 1
}

telegram_is_ready() {
  /bin/zsh "$TELEGRAM_LAUNCHER" --check >/dev/null 2>&1
}

codex_worker_is_ready() {
  /bin/zsh "$CODEX_WORKER_LAUNCHER" --check >/dev/null 2>&1
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

restore_launchagents() {
  local restart_services="${1:-true}"
  local restore_failed=false
  bootout_agent "$TELEGRAM_LABEL"
  bootout_agent "$CODEX_WORKER_LABEL"
  bootout_agent "$GROWTH_LABEL"
  bootout_agent "$SECURE_CHAT_LABEL"
  wait_for_unloaded_agent "$TELEGRAM_LABEL" 50 || restore_failed=true
  wait_for_unloaded_agent "$CODEX_WORKER_LABEL" 50 || restore_failed=true
  wait_for_unloaded_agent "$GROWTH_LABEL" 50 || restore_failed=true
  wait_for_unloaded_agent "$SECURE_CHAT_LABEL" 50 || restore_failed=true

  if [[ -f "${rollback_root}/${SECURE_CHAT_LABEL}.plist" ]]; then
    atomic_replace "${rollback_root}/${SECURE_CHAT_LABEL}.plist" "$SECURE_CHAT_PLIST" || restore_failed=true
  else
    /bin/rm -f -- "$SECURE_CHAT_PLIST" || restore_failed=true
  fi
  if [[ "$had_growth_plist" == true ]]; then
    atomic_replace "${rollback_root}/${GROWTH_LABEL}.plist" "$GROWTH_PLIST" || restore_failed=true
  else
    /bin/rm -f -- "$GROWTH_PLIST" || restore_failed=true
  fi
  if [[ "$had_telegram_plist" == true ]]; then
    atomic_replace "${rollback_root}/${TELEGRAM_LABEL}.plist" "$TELEGRAM_PLIST" || restore_failed=true
  else
    /bin/rm -f -- "$TELEGRAM_PLIST" || restore_failed=true
  fi
  if [[ "$had_codex_worker_plist" == true ]]; then
    atomic_replace "${rollback_root}/${CODEX_WORKER_LABEL}.plist" "$CODEX_WORKER_PLIST" || restore_failed=true
  else
    /bin/rm -f -- "$CODEX_WORKER_PLIST" || restore_failed=true
  fi

  # A mixed definition set is never safe to expose. In --install-only mode the
  # parent deployment owns service restoration after its runtime/data rollback,
  # so this child restores definitions and deliberately leaves every job down.
  if [[ "$restore_failed" == true ]]; then
    return 1
  fi
  if [[ "$restart_services" != true ]]; then
    return 0
  fi

  if [[ -f "$SECURE_CHAT_PLIST" ]]; then
    bootstrap_agent "$SECURE_CHAT_LABEL" "$SECURE_CHAT_PLIST" >/dev/null || restore_failed=true
  fi
  if [[ -f "$GROWTH_PLIST" ]]; then
    bootstrap_agent "$GROWTH_LABEL" "$GROWTH_PLIST" >/dev/null || restore_failed=true
  fi
  if [[ -f "$TELEGRAM_PLIST" ]] && telegram_is_ready; then
    bootstrap_agent "$TELEGRAM_LABEL" "$TELEGRAM_PLIST" >/dev/null || restore_failed=true
  fi
  if [[ -f "$CODEX_WORKER_PLIST" ]] && codex_worker_is_ready; then
    bootstrap_agent "$CODEX_WORKER_LABEL" "$CODEX_WORKER_PLIST" >/dev/null || restore_failed=true
  fi
  if [[ -f "$SECURE_CHAT_PLIST" ]]; then
    wait_for_health "http://127.0.0.1:18791/health" 90 >/dev/null 2>&1 || restore_failed=true
  fi
  [[ "$restore_failed" == false ]]
}

cleanup() {
  local exit_code=$?
  local preserve_rollback=false
  local restart_restored_services=true
  trap - EXIT INT TERM HUP

  if (( exit_code != 0 )) && [[ "$plists_replaced" == true && "$installation_committed" == false ]]; then
    print -u2 "LaunchAgent verification failed; restoring previous definitions."
    if [[ "$mode" == "--install-only" ]]; then
      restart_restored_services=false
    fi
    if ! restore_launchagents "$restart_restored_services"; then
      exit_code=1
      preserve_rollback=true
      print -u2 "Automatic LaunchAgent restore was incomplete; preserving rollback data at ${rollback_root}"
    fi
  fi
  if [[ -n "$stage_root" && "$stage_root" == "${PRIVATE_ROOT}/tmp/launchagents-stage-"* && -d "$stage_root" ]]; then
    /bin/rm -rf -- "$stage_root" || exit_code=1
  fi
  if [[ "$preserve_rollback" == false && -n "$rollback_root" && "$rollback_root" == "${PRIVATE_ROOT}/backups/secure-chat/.launchagents-rollback-"* && -d "$rollback_root" ]]; then
    /bin/rm -rf -- "$rollback_root" || exit_code=1
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [[ ! -f "$SECURE_CHAT_PLIST" || ! -f "$SOURCE_GROWTH_PLIST" || ! -f "$SOURCE_TELEGRAM_PLIST" || \
      ! -f "$SOURCE_CODEX_WORKER_PLIST" || ! -f "$TELEGRAM_LAUNCHER" || ! -f "$CODEX_WORKER_LAUNCHER" ]]; then
  print -u2 "Release LaunchAgent inputs are missing."
  exit 1
fi

acquire_runtime_mutation_lock
/bin/mkdir -p \
  "${PRIVATE_ROOT}/backups/secure-chat" \
  "${PRIVATE_ROOT}/logs/growth" \
  "${PRIVATE_ROOT}/logs/telegram-general" \
  "${PRIVATE_ROOT}/logs/codex-worker"
/bin/chmod 700 \
  "${PRIVATE_ROOT}/backups/secure-chat" \
  "${PRIVATE_ROOT}/logs/growth" \
  "${PRIVATE_ROOT}/logs/telegram-general" \
  "${PRIVATE_ROOT}/logs/codex-worker"
/usr/bin/touch \
  "${PRIVATE_ROOT}/logs/growth/monitor.stdout.log" \
  "${PRIVATE_ROOT}/logs/growth/monitor.stderr.log" \
  "${PRIVATE_ROOT}/logs/telegram-general/launchd.stdout.log" \
  "${PRIVATE_ROOT}/logs/telegram-general/launchd.stderr.log" \
  "${PRIVATE_ROOT}/logs/codex-worker/launchd.stdout.log" \
  "${PRIVATE_ROOT}/logs/codex-worker/launchd.stderr.log"
/bin/chmod 600 \
  "${PRIVATE_ROOT}/logs/growth/monitor.stdout.log" \
  "${PRIVATE_ROOT}/logs/growth/monitor.stderr.log" \
  "${PRIVATE_ROOT}/logs/telegram-general/launchd.stdout.log" \
  "${PRIVATE_ROOT}/logs/telegram-general/launchd.stderr.log" \
  "${PRIVATE_ROOT}/logs/codex-worker/launchd.stdout.log" \
  "${PRIVATE_ROOT}/logs/codex-worker/launchd.stderr.log"

stage_root="$(/usr/bin/mktemp -d "${PRIVATE_ROOT}/tmp/launchagents-stage-XXXXXX")"
rollback_root="$(/usr/bin/mktemp -d "${PRIVATE_ROOT}/backups/secure-chat/.launchagents-rollback-XXXXXX")"
/bin/chmod 700 "$stage_root" "$rollback_root"

/bin/cp -p "$SECURE_CHAT_PLIST" "${rollback_root}/${SECURE_CHAT_LABEL}.plist"
if [[ -f "$GROWTH_PLIST" ]]; then
  /bin/cp -p "$GROWTH_PLIST" "${rollback_root}/${GROWTH_LABEL}.plist"
  had_growth_plist=true
fi
if [[ -f "$TELEGRAM_PLIST" ]]; then
  /bin/cp -p "$TELEGRAM_PLIST" "${rollback_root}/${TELEGRAM_LABEL}.plist"
  had_telegram_plist=true
fi
if [[ -f "$CODEX_WORKER_PLIST" ]]; then
  /bin/cp -p "$CODEX_WORKER_PLIST" "${rollback_root}/${CODEX_WORKER_LABEL}.plist"
  had_codex_worker_plist=true
fi

/bin/cp -p "$SECURE_CHAT_PLIST" "${stage_root}/${SECURE_CHAT_LABEL}.plist"
if ! /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables" "${stage_root}/${SECURE_CHAT_LABEL}.plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "${stage_root}/${SECURE_CHAT_LABEL}.plist"
fi
if /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:LOCAL_AI_GROWTH_TRANSPORT" "${stage_root}/${SECURE_CHAT_LABEL}.plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:LOCAL_AI_GROWTH_TRANSPORT openclaw" "${stage_root}/${SECURE_CHAT_LABEL}.plist"
else
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:LOCAL_AI_GROWTH_TRANSPORT string openclaw" "${stage_root}/${SECURE_CHAT_LABEL}.plist"
fi
if /usr/libexec/PlistBuddy -c "Print :Umask" "${stage_root}/${SECURE_CHAT_LABEL}.plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :Umask 63" "${stage_root}/${SECURE_CHAT_LABEL}.plist"
else
  /usr/libexec/PlistBuddy -c "Add :Umask integer 63" "${stage_root}/${SECURE_CHAT_LABEL}.plist"
fi
/bin/cp -p "$SOURCE_GROWTH_PLIST" "${stage_root}/${GROWTH_LABEL}.plist"
/bin/cp -p "$SOURCE_TELEGRAM_PLIST" "${stage_root}/${TELEGRAM_LABEL}.plist"
/bin/cp -p "$SOURCE_CODEX_WORKER_PLIST" "${stage_root}/${CODEX_WORKER_LABEL}.plist"
/bin/chmod 600 "${stage_root}"/*.plist
/usr/bin/plutil -lint "${stage_root}"/*.plist >/dev/null
/bin/zsh -n "$TELEGRAM_LAUNCHER"
/bin/zsh -n "$CODEX_WORKER_LAUNCHER"

if [[ "$mode" == "--verify-only" ]]; then
  if telegram_is_ready; then telegram_mode="configured"; else telegram_mode="safely_disabled"; fi
  if codex_worker_is_ready; then codex_mode="configured"; else codex_mode="safely_disabled"; fi
  print "LaunchAgent inputs passed verification; Telegram=${telegram_mode}; Codex=${codex_mode}; nothing was installed."
  exit 0
fi

# Replace definitions only after the coherent service set is fully stopped.
for label in "$TELEGRAM_LABEL" "$CODEX_WORKER_LABEL" "$GROWTH_LABEL" "$SECURE_CHAT_LABEL"; do
  bootout_agent "$label"
done
for label in "$TELEGRAM_LABEL" "$CODEX_WORKER_LABEL" "$GROWTH_LABEL" "$SECURE_CHAT_LABEL"; do
  wait_for_unloaded_agent "$label" 50
done

plists_replaced=true
atomic_replace "${stage_root}/${SECURE_CHAT_LABEL}.plist" "$SECURE_CHAT_PLIST"
atomic_replace "${stage_root}/${GROWTH_LABEL}.plist" "$GROWTH_PLIST"
atomic_replace "${stage_root}/${TELEGRAM_LABEL}.plist" "$TELEGRAM_PLIST"
atomic_replace "${stage_root}/${CODEX_WORKER_LABEL}.plist" "$CODEX_WORKER_PLIST"

if [[ "$mode" == "--install-only" ]]; then
  installation_committed=true
  plists_replaced=false
  /bin/rm -rf -- "$rollback_root"
  rollback_root=""
  print "LaunchAgent definitions installed without starting services."
  exit 0
fi

reload_agent "$SECURE_CHAT_LABEL" "$SECURE_CHAT_PLIST"
wait_for_running_agent "$SECURE_CHAT_LABEL" 30
reload_agent "$GROWTH_LABEL" "$GROWTH_PLIST"
if telegram_is_ready; then telegram_ready=true; else telegram_ready=false; fi
reload_agent "$TELEGRAM_LABEL" "$TELEGRAM_PLIST"
if [[ "$telegram_ready" == true ]]; then
  wait_for_running_agent "$TELEGRAM_LABEL" 30
  telegram_mode="configured"
else
  wait_for_disabled_agent "$TELEGRAM_LABEL" 30
  telegram_mode="safely_disabled"
fi
if codex_worker_is_ready; then codex_ready=true; else codex_ready=false; fi
reload_agent "$CODEX_WORKER_LABEL" "$CODEX_WORKER_PLIST"
if [[ "$codex_ready" == true ]]; then
  wait_for_running_agent "$CODEX_WORKER_LABEL" 30
  codex_mode="configured"
else
  wait_for_disabled_agent "$CODEX_WORKER_LABEL" 30
  codex_mode="safely_disabled"
fi

wait_for_health "http://127.0.0.1:18791/health" 90
/bin/launchctl print "${DOMAIN}/${GROWTH_LABEL}" >/dev/null

# All installed services are verified. A cleanup problem must not roll back a
# known-good release, so commit before removing the temporary rollback copy.
installation_committed=true
plists_replaced=false
/bin/rm -rf -- "$rollback_root"
rollback_root=""

print "Release LaunchAgents installed and verified; Telegram=${telegram_mode}; Codex=${codex_mode}; rollback copy removed."
