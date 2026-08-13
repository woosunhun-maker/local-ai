import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { executionBinding } from "../scripts/codex-worker.mjs";
import { SYNTHETIC_OWNER_ID } from "../src/codex/isolated-workspace.mjs";
import { createOwnerCodexPlan } from "../src/codex/owner-task-plan.mjs";
import { CodexRunnerError } from "../src/codex/runner.mjs";

test("worker rejects every unsigned Telegram job before workspace or provider execution", () => {
  assert.throws(
    () => executionBinding({ ingress: "telegram", ownerId: "100000001" }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_owner_app_approval_required",
  );
});

test("worker restores and binds the exact signed owner-app source manifest", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ownerDeviceHash = "b".repeat(64);
  const idempotencyKey = "owner-worker-test-0001";
  const request = "승인 경로 보안 점검";
  const sourceManifestSha256 = "c".repeat(64);
  const plan = createOwnerCodexPlan({
    taskId: id,
    ownerDeviceHash,
    idempotencyKey,
    intent: "inspect",
    request,
    sourceManifestSha256,
    sourceFileCount: 1,
    sourceTotalBytes: 26,
  });
  const binding = executionBinding({
    id,
    ingress: "owner_app",
    ownerDeviceHash,
    idempotencyKey,
    approvalRequestId: id,
    planCanonical: plan.canonical,
    planSha256: plan.sha256,
    intent: "inspect",
    request,
  });
  assert.deepEqual(binding, {
    ownerId: SYNTHETIC_OWNER_ID,
    expectedSourceManifestSha256: sourceManifestSha256,
    expectedSourceFileCount: 1,
    expectedSourceTotalBytes: 26,
  });
  assert.throws(
    () => executionBinding({
      id,
      ingress: "owner_app",
      ownerDeviceHash,
      idempotencyKey,
      approvalRequestId: id,
      planCanonical: plan.canonical,
      planSha256: "d".repeat(64),
      intent: "inspect",
      request,
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_task_plan_mismatch",
  );
});

test("manual bridge smoke is local-only and cannot bypass owner-app approval", async () => {
  const smoke = await readFile(join(import.meta.dirname, "..", "scripts", "smoke-codex-bridge.mjs"), "utf8");
  assert.doesNotMatch(smoke, /createCodexRunner|createIsolatedWorkspace|runCodexTask/u);
  assert.match(smoke, /ownerAppApprovalRequired:\s*true/u);
  assert.match(smoke, /externalTransferPerformed:\s*false/u);
});
