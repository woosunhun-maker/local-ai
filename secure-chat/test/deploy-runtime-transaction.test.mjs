import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

function shellFunction(source, name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "mu").exec(source);
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

test("runtime deployment stops the coherent service set and protects task data before migration", async () => {
  const deploy = await readFile(join(ROOT, "scripts", "deploy-runtime.sh"), "utf8");
  await execFileAsync("/bin/zsh", ["-n", join(ROOT, "scripts", "deploy-runtime.sh")]);
  const verifyExit = deploy.indexOf('if [[ "$mode" == "--verify-only" ]]');
  const stop = deploy.lastIndexOf("stop_runtime_services\nassert_no_active_codex_tasks\ncapture_data_state");
  const runtimeMove = deploy.indexOf('/bin/mv "$TARGET_ROOT" "$BACKUP_PATH"');
  const offlineMigration = deploy.indexOf('scripts/migrate-codex-task-store.mjs" >/dev/null');
  const installOnly = deploy.indexOf('install-release-launchagents.sh" --install-only');
  const workerStart = deploy.indexOf(
    'bootstrap_agent_if_present "$CODEX_WORKER_LABEL"',
    installOnly,
  );
  const workerLeaseReady = deploy.indexOf("wait_for_codex_worker_ready 30", workerStart);
  const serverStart = deploy.lastIndexOf('bootstrap_agent_if_present "$SECURE_CHAT_LABEL"');
  const commit = deploy.lastIndexOf("deployment_committed=true");
  assert.ok(verifyExit >= 0 && verifyExit < stop, "verify-only must exit before live mutation");
  assert.ok(stop >= 0 && stop < runtimeMove, "all services and active tasks must be resolved before tree replacement");
  assert.ok(runtimeMove < offlineMigration && offlineMigration < installOnly && installOnly < workerStart);
  assert.ok(workerStart < workerLeaseReady && workerLeaseReady < commit && commit < serverStart);
  const rollbackStart = deploy.indexOf("rollback_runtime() {");
  const restoreData = deploy.indexOf("  restore_data_state ||", rollbackStart);
  const restoreServices = deploy.indexOf("    restore_runtime_services ||", rollbackStart);
  assert.ok(restoreData >= 0 && restoreData < restoreServices);
  for (const sidecar of [
    "CODEX_TASK_LOCK_PATH",
    "CODEX_WORKER_LOCK_PATH",
    "CODEX_WORKER_LEASE_PATH",
    "APPROVAL_LOCK_PATH",
    "AUTH_LOCK_PATH",
  ]) {
    const reference = `"$${sidecar}"`;
    assert.equal(deploy.split("\n").some((line) => line.includes("capture_private_state_file") && line.includes(reference)), true);
    assert.equal(deploy.split("\n").some((line) => line.includes("restore_private_state_file") && line.includes(reference)), true);
  }
});

test("deployment requires Codex preflight before mutation and reports post-commit degradation as failure", async () => {
  const deploy = await readFile(join(ROOT, "scripts", "deploy-runtime.sh"), "utf8");
  const preflight = deploy.indexOf('if ! /bin/zsh "$stage_path/scripts/launch-codex-worker.sh" --check');
  const stop = deploy.lastIndexOf("stop_runtime_services\nassert_no_active_codex_tasks\ncapture_data_state");
  const commit = deploy.lastIndexOf("deployment_committed=true");
  const serverStart = deploy.lastIndexOf('bootstrap_agent_if_present "$SECURE_CHAT_LABEL"');
  const serverSafeStop = deploy.indexOf('bootout_agent "$SECURE_CHAT_LABEL"', serverStart);
  const postCommitCheck = deploy.indexOf('if ! wait_for_running_agent "$CODEX_WORKER_LABEL" 5', commit);
  const degradedExit = deploy.indexOf('if [[ "$post_commit_degraded" == true ]]', postCommitCheck);
  assert.ok(preflight >= 0 && preflight < stop, "required Codex preflight must fail before live mutation");
  assert.ok(commit >= 0 && commit < serverStart && serverStart < serverSafeStop);
  assert.match(deploy.slice(serverStart, serverSafeStop), /wait_for_health/u);
  assert.ok(serverSafeStop < postCommitCheck && postCommitCheck < degradedExit);
  assert.match(deploy.slice(degradedExit), /DEGRADED:[\s\S]*exit 1/u);
});

test("deployment explicitly starts a freshly bootstrapped LaunchAgent", async () => {
  const deploy = await readFile(join(ROOT, "scripts", "deploy-runtime.sh"), "utf8");
  const bootstrap = shellFunction(deploy, "bootstrap_agent_if_present");
  const registration = bootstrap.indexOf('/bin/launchctl bootstrap "$DOMAIN" "$plist"');
  const kickstart = bootstrap.indexOf('/bin/launchctl kickstart "$DOMAIN/$label"');
  const success = bootstrap.indexOf("return 0", kickstart);
  assert.ok(registration >= 0 && registration < kickstart && kickstart < success);
  assert.match(bootstrap.slice(kickstart, success), />\/dev\/null 2>&1/u);
});

test("rollback capture and restore failures cannot be mistaken for absent files or masked by later success", async () => {
  const deploy = await readFile(join(ROOT, "scripts", "deploy-runtime.sh"), "utf8");
  const directory = await mkdtemp(join(tmpdir(), "local-ai-deploy-rollback-failure-"));
  await chmod(directory, 0o700);
  const source = join(directory, "source.json");
  await writeFile(source, "{}\n", { mode: 0o600 });

  const captureHarness = join(directory, "capture.zsh");
  await writeFile(captureHarness, [
    "#!/bin/zsh",
    "set -euo pipefail",
    shellFunction(deploy, "capture_private_state_file"),
    'capture_private_state_file "$1" "$2" || exit 42',
    "",
  ].join("\n"), { mode: 0o700 });
  await assert.rejects(
    execFileAsync("/bin/zsh", [captureHarness, source, join(directory, "missing", "backup.json")]),
    (error) => error.code === 42,
  );
  const hardlink = join(directory, "source-hardlink.json");
  await link(source, hardlink);
  await assert.rejects(
    execFileAsync("/bin/zsh", [captureHarness, source, join(directory, "hardlink-backup.json")]),
    (error) => error.code === 42,
  );

  const restoreHarness = join(directory, "restore.zsh");
  await writeFile(restoreHarness, [
    "#!/bin/zsh",
    "set -euo pipefail",
    shellFunction(deploy, "atomic_restore_data_file"),
    shellFunction(deploy, "restore_private_state_file"),
    shellFunction(deploy, "restore_data_state"),
    'data_rollback_root="$1/backup"',
    'CODEX_TASK_DATA_PATH="$1/live/tasks.json"',
    'CODEX_TASK_LOCK_PATH="$1/live/tasks.json.lock"',
    'CODEX_WORKER_LOCK_PATH="$1/live/tasks.json.worker-lock"',
    'CODEX_WORKER_LEASE_PATH="$1/live/tasks.json.worker-lease"',
    'APPROVAL_DATA_PATH="$1/live/approvals.json"',
    'APPROVAL_LOCK_PATH="$1/live/approvals.json.lock"',
    'AUTH_LOCK_PATH="$1/live/auth.json.lock"',
    "data_backup_captured=true",
    "had_codex_task_data=true",
    "had_codex_task_lock=false",
    "had_codex_worker_lock=false",
    "had_codex_worker_lease=false",
    "had_approval_data=false",
    "had_approval_lock=false",
    "had_auth_lock=false",
    'mkdir -p "$1/backup" "$1/live"',
    'chmod 700 "$1/backup" "$1/live"',
    "restore_data_state || exit 43",
    "",
  ].join("\n"), { mode: 0o700 });
  await assert.rejects(
    execFileAsync("/bin/zsh", [restoreHarness, directory]),
    (error) => error.code === 43,
  );
});

test("LaunchAgent installer supports definition-only installation and stops all services before replacement", async () => {
  const installerPath = join(ROOT, "scripts", "install-release-launchagents.sh");
  const installer = await readFile(installerPath, "utf8");
  await execFileAsync("/bin/zsh", ["-n", installerPath]);
  assert.match(installer, /--install-only/u);
  const stopAll = installer.indexOf('for label in "$TELEGRAM_LABEL" "$CODEX_WORKER_LABEL" "$GROWTH_LABEL" "$SECURE_CHAT_LABEL"');
  const replace = installer.indexOf('atomic_replace "${stage_root}/${SECURE_CHAT_LABEL}.plist"');
  const installOnlyExit = installer.lastIndexOf('if [[ "$mode" == "--install-only" ]]');
  const reload = installer.indexOf('reload_agent "$SECURE_CHAT_LABEL"');
  assert.ok(stopAll >= 0 && stopAll < replace);
  assert.ok(replace < installOnlyExit && installOnlyExit < reload);
});

test("deployment and nested LaunchAgent installation share one persistent kernel mutation lock", async () => {
  const deployPath = join(ROOT, "scripts", "deploy-runtime.sh");
  const installerPath = join(ROOT, "scripts", "install-release-launchagents.sh");
  const helperPath = join(ROOT, "scripts", "kernel-lock.zsh");
  const [deploy, installer, helper] = await Promise.all([
    readFile(deployPath, "utf8"),
    readFile(installerPath, "utf8"),
    readFile(helperPath, "utf8"),
  ]);
  await Promise.all([
    execFileAsync("/bin/zsh", ["-n", deployPath]),
    execFileAsync("/bin/zsh", ["-n", installerPath]),
    execFileAsync("/bin/zsh", ["-n", helperPath]),
  ]);

  const lockPath = "/Users/hun/PrivateAI/tmp/runtime-mutation.lock";
  assert.ok(deploy.includes(lockPath));
  assert.ok(installer.includes("${PRIVATE_ROOT}/tmp/runtime-mutation.lock"));
  assert.match(helper, /\/usr\/bin\/lockf -s -t 0 9/u);
  assert.doesNotMatch(deploy, /secure-chat-deploy\.lock|owner-pid/u);
  assert.doesNotMatch(installer, /release-launchagents-install\.lock|owner-pid/u);
  assert.doesNotMatch(deploy, /rm[^\n]*RUNTIME_MUTATION_LOCK/u);
  assert.doesNotMatch(installer, /rm[^\n]*RUNTIME_MUTATION_LOCK/u);

  const deployAcquire = deploy.indexOf("acquire_runtime_mutation_lock\n");
  const deployStage = deploy.indexOf('stage_path="$(/usr/bin/mktemp');
  const nestedInstaller = deploy.indexOf('install-release-launchagents.sh" --install-only');
  const installerAcquire = installer.indexOf("acquire_runtime_mutation_lock\n");
  const installerStage = installer.indexOf('stage_root="$(/usr/bin/mktemp');
  assert.ok(deployAcquire >= 0 && deployAcquire < deployStage && deployStage < nestedInstaller);
  assert.ok(installerAcquire >= 0 && installerAcquire < installerStage);
  assert.doesNotMatch(deploy.slice(nestedInstaller - 80, nestedInstaller + 80), /exec 9>&-/u);
  assert.match(deploy, /\(exec 9>&-; cd "\$stage_path" && \/opt\/homebrew\/bin\/node --test\)/u);
});

test("install-only rollback restores definitions without exposing the uncommitted runtime", async () => {
  const installerPath = join(ROOT, "scripts", "install-release-launchagents.sh");
  const installer = await readFile(installerPath, "utf8");
  const restoreStart = installer.indexOf("restore_launchagents() {");
  const definitionFailureGate = installer.indexOf('if [[ "$restore_failed" == true ]]', restoreStart);
  const noRestartGate = installer.indexOf('if [[ "$restart_services" != true ]]', definitionFailureGate);
  const firstBootstrap = installer.indexOf('bootstrap_agent "$SECURE_CHAT_LABEL"', noRestartGate);
  const cleanupStart = installer.indexOf("cleanup() {");
  const installOnlyMode = installer.indexOf('if [[ "$mode" == "--install-only" ]]', cleanupStart);
  const definitionsOnly = installer.indexOf("restart_restored_services=false", installOnlyMode);
  const restoreCall = installer.indexOf('restore_launchagents "$restart_restored_services"', definitionsOnly);
  assert.ok(restoreStart >= 0 && restoreStart < definitionFailureGate);
  assert.ok(definitionFailureGate < noRestartGate && noRestartGate < firstBootstrap);
  assert.ok(cleanupStart < installOnlyMode && installOnlyMode < definitionsOnly && definitionsOnly < restoreCall);
  assert.doesNotMatch(installer.slice(noRestartGate, firstBootstrap), /bootstrap_agent|wait_for_health/u);
});
