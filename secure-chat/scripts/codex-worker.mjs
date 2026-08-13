#!/opt/homebrew/bin/node

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  CODEX_BINARY_PATH,
  CODEX_MODEL,
  CodexRunnerError,
  createCodexRunner,
  EXPECTED_CODEX_VERSION,
} from "../src/codex/runner.mjs";
import {
  createIsolatedWorkspace,
  IsolatedWorkspaceError,
  removeIsolatedWorkspace,
  SYNTHETIC_OWNER_ID,
} from "../src/codex/isolated-workspace.mjs";
import { restoreOwnerCodexPlan } from "../src/codex/owner-task-plan.mjs";
import { CodexTaskStore } from "../src/codex/task-store.mjs";

const ROOT = "/Users/hun/PrivateAI";
const CONFIG_PATH = `${ROOT}/config/codex-bridge.json`;
const TASK_PATH = `${ROOT}/data/codex-bridge/tasks.json`;
const SOURCE_ROOT = `${ROOT}/app/secure-chat`;
const WORKSPACE_ROOT = "/Users/Shared/LocalAI-Codex-Workspace";
const POLL_INTERVAL_MS = 1_000;
const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

function validateConfiguration(value) {
  if (
    value?.version !== 1 || value?.enabled !== true ||
    value?.mode !== "isolated_inspect_and_draft" ||
    value?.codexVersion !== EXPECTED_CODEX_VERSION ||
    value?.model !== CODEX_MODEL
  ) {
    throw new Error("codex_worker_configuration_invalid");
  }
  return Object.freeze({ model: value.model });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeFailure(error) {
  if (error instanceof CodexRunnerError) {
    return { code: error.code, summary: error.message };
  }
  if (error instanceof IsolatedWorkspaceError) {
    return { code: error.code, summary: "허용 코드와 알려진 식별자 검사를 통과한 격리 복사본을 준비하지 못해 작업을 차단했습니다." };
  }
  return { code: "codex_worker_failed", summary: "Codex 작업을 안전하게 완료하지 못했습니다. 원시 오류는 저장하지 않았습니다." };
}

export function executionBinding(job) {
  if (job.ingress !== "owner_app") {
    throw new CodexRunnerError("codex_owner_app_approval_required");
  }
  let plan;
  try {
    plan = restoreOwnerCodexPlan(job.planCanonical);
  } catch {
    throw new CodexRunnerError("codex_task_plan_mismatch");
  }
  if (
    plan.taskId !== job.id || plan.ownerDeviceHash !== job.ownerDeviceHash ||
    plan.idempotencyKey !== job.idempotencyKey || plan.intent !== job.intent ||
    plan.request !== job.request || plan.sha256 !== job.planSha256 ||
    job.approvalRequestId !== job.id
  ) throw new CodexRunnerError("codex_task_plan_mismatch");
  return Object.freeze({
    ownerId: SYNTHETIC_OWNER_ID,
    expectedSourceManifestSha256: plan.sourceManifestSha256,
    expectedSourceFileCount: plan.sourceFileCount,
    expectedSourceTotalBytes: plan.sourceTotalBytes,
  });
}

async function main() {
  const configuration = await readFile(CONFIG_PATH, "utf8").then(JSON.parse);
  const { model } = validateConfiguration(configuration);
  const store = new CodexTaskStore(TASK_PATH);
  await store.initialize();
  const workerId = `worker-${process.pid}-${randomBytes(4).toString("hex")}`;
  const workerLease = await store.acquireWorkerLease({ workerId, pid: process.pid });
  let heartbeatTimer = null;
  let heartbeatPromise = Promise.resolve();
  let heartbeatRunning = false;
  let leaseFailure = null;
  let stopping = false;
  let activeController = null;
  const stop = () => {
    stopping = true;
    activeController?.abort();
  };

  try {
    for (const jobId of await store.listTerminalJobIds()) {
      await removeIsolatedWorkspace({ jobId, workspaceRoot: WORKSPACE_ROOT }).catch(() => {});
    }
    const recovered = await store.recoverRunning(workerLease);
    const runCodex = createCodexRunner({
      binaryPath: CODEX_BINARY_PATH,
      expectedVersion: EXPECTED_CODEX_VERSION,
      workspaceRoot: WORKSPACE_ROOT,
      model,
    });
    const heartbeat = () => {
      if (heartbeatRunning || leaseFailure) return;
      heartbeatRunning = true;
      heartbeatPromise = store.heartbeatWorkerLease(workerLease)
        .catch((error) => {
          leaseFailure = error;
          stop();
        })
        .finally(() => { heartbeatRunning = false; });
    };
    heartbeatTimer = setInterval(heartbeat, LEASE_HEARTBEAT_INTERVAL_MS);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    process.once("SIGHUP", stop);
    process.stdout.write(`${JSON.stringify({ outcome: "running", recovered: recovered.length })}\n`);

    while (!stopping) {
      if (leaseFailure) throw leaseFailure;
      const job = await store.claimNext(workerLease);
      if (!job) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }

      activeController = new AbortController();
      try {
        if (stopping || leaseFailure) {
          activeController.abort();
          throw new CodexRunnerError("codex_aborted");
        }
        const binding = executionBinding(job);
        await createIsolatedWorkspace({
          jobId: job.id,
          sourceRoot: SOURCE_ROOT,
          ownerId: binding.ownerId,
          expectedSourceManifestSha256: binding.expectedSourceManifestSha256,
          expectedSourceFileCount: binding.expectedSourceFileCount,
          expectedSourceTotalBytes: binding.expectedSourceTotalBytes,
          workspaceRoot: WORKSPACE_ROOT,
        });
        const result = await runCodex({
          jobId: job.id,
          prompt: job.request,
          ownerId: binding.ownerId,
          intent: job.intent,
          expectedSourceManifestSha256: binding.expectedSourceManifestSha256,
          expectedSourceFileCount: binding.expectedSourceFileCount,
          expectedSourceTotalBytes: binding.expectedSourceTotalBytes,
          signal: activeController.signal,
        });
        if (stopping || leaseFailure) throw new CodexRunnerError("codex_aborted");
        const summary = result.needsOwnerApp
          ? `${result.summary}\n계속 진행하려면 Local AI 앱에서 지시해 주세요.`
          : result.summary;
        await store.transition(job.id, "running", "succeeded", {
          code: result.needsOwnerApp ? "codex_task_requires_owner_app" : "codex_task_succeeded",
          summary,
          changedFileCount: result.changedFileCount,
          changedPaths: result.changedPaths,
          patch: result.patch,
          patchSha256: result.patchSha256,
        }, { workerLease });
        await removeIsolatedWorkspace({ jobId: job.id, workspaceRoot: WORKSPACE_ROOT }).catch(() => {});
        process.stdout.write(`${JSON.stringify({ outcome: "succeeded", jobId: job.id.slice(0, 8) })}\n`);
      } catch (error) {
        const interrupted = stopping || leaseFailure || error?.code === "codex_aborted";
        const failure = safeFailure(error);
        await store.transition(job.id, "running", interrupted ? "interrupted_uncertain" : "failed", {
          code: interrupted ? "codex_task_interrupted_uncertain" : failure.code,
          summary: interrupted
            ? "실행 중 중단되어 결과를 확정할 수 없습니다. 자동으로 재시도하지 않습니다."
            : failure.summary,
          changedFileCount: 0,
          changedPaths: [],
          patch: null,
          patchSha256: null,
        }, { workerLease });
        await removeIsolatedWorkspace({ jobId: job.id, workspaceRoot: WORKSPACE_ROOT }).catch(() => {});
        process.stdout.write(`${JSON.stringify({ outcome: interrupted ? "interrupted_uncertain" : "failed", jobId: job.id.slice(0, 8) })}\n`);
      } finally {
        activeController = null;
      }
    }
    if (leaseFailure) throw leaseFailure;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeatPromise;
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGHUP", stop);
    await store.releaseWorkerLease(workerLease).catch((error) => {
      if (!leaseFailure) throw error;
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ outcome: "fatal", errorClass: error?.name ?? "Error" })}\n`);
    process.exitCode = 1;
  });
}
