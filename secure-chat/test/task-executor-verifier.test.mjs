import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskManagerStore } from "../src/task/task-manager-store.mjs";
import { createTaskExecutor } from "../src/executor/task-executor.mjs";
import { createTaskOrchestrator } from "../src/executor/task-orchestrator.mjs";
import { verifyTaskOutcome } from "../src/verifier/task-verifier.mjs";
import { createEvidenceRecord } from "../src/evidence/evidence.mjs";
import { createBuiltinToolRegistry } from "../src/tools/tool-registry.mjs";

test("verifier rejects inferred-only success claims", () => {
  const result = verifyTaskOutcome({
    task: {
      task_id: "task-verify-1",
      evidence: [
        createEvidenceRecord({
          epistemic: "INFERRED",
          claim: "분명히 성공했을 것이다",
          source: "model",
          evidenceId: "ev-inf-1",
        }),
      ],
    },
  });
  assert.equal(result.result, "FAIL");
});

test("orchestrator runs system.status to SUCCESS with verified evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-"));
  try {
    const store = new TaskManagerStore(join(dir, "tasks.json"), {
      idFactory: () => "task-orch-status-1",
    });
    await store.initialize();
    await store.create({
      goal: "로컬 런타임 상태 확인",
      approvalRequired: false,
    });

    const executor = createTaskExecutor({
      toolRegistry: createBuiltinToolRegistry(),
      runStatus: async () => ({
        schema: "local-ai.system-command-result.v1",
        command: "system.status",
        checked_at: "2026-08-14T03:00:00.000Z",
        runtime: {
          overall: "ok",
          services: [
            {
              service: "secure-chat",
              status: "ok",
              model: null,
              pid: 1,
              last_health_check: "2026-08-14T03:00:00.000Z",
              version: "1.2.0",
              error: null,
            },
            {
              service: "llm_conversation",
              status: "ok",
              model: "qwen3.6:35b",
              pid: null,
              last_health_check: "2026-08-14T03:00:00.000Z",
              version: "1.2.0",
              error: null,
            },
          ],
        },
        evidence: [],
        tasks: { epistemic: "VERIFIED", summary: { total: 0 } },
      }),
    });
    const orch = createTaskOrchestrator({ taskStore: store, executor });
    const result = await orch.run({
      taskId: "task-orch-status-1",
      toolName: "system.status",
      channel: "local_owner_app",
      hasApproval: false,
    });
    assert.equal(result.phase, "SUCCESS");
    assert.equal(result.verification.result, "PASS");
    assert.equal(result.task.status, "SUCCESS");
    assert.ok(result.task.evidence.some((item) => item.epistemic === "VERIFIED"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator does not auto-execute web_task and goes NEEDS_REPLAN", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-web-"));
  try {
    const store = new TaskManagerStore(join(dir, "tasks.json"), {
      idFactory: () => "task-orch-web-1",
    });
    await store.initialize();
    await store.create({
      goal: "웹 작업 실행",
      approvalRequired: true,
    });
    const orch = createTaskOrchestrator({
      taskStore: store,
      executor: createTaskExecutor({ toolRegistry: createBuiltinToolRegistry() }),
    });
    const waiting = await orch.run({
      taskId: "task-orch-web-1",
      toolName: "web_task.execute",
      channel: "local_owner_app",
      hasApproval: false,
    });
    assert.equal(waiting.phase, "WAITING_APPROVAL");

    const deferred = await orch.run({
      taskId: "task-orch-web-1",
      toolName: "web_task.execute",
      channel: "local_owner_app",
      hasApproval: true,
    });
    assert.equal(deferred.phase, "NEEDS_REPLAN");
    assert.equal(deferred.execution.deferred, true);
    assert.match(deferred.execution.reason, /existing_module/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("telegram channel cannot run effect tools through orchestrator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-tg-"));
  try {
    const store = new TaskManagerStore(join(dir, "tasks.json"), {
      idFactory: () => "task-orch-tg-1",
    });
    await store.initialize();
    await store.create({ goal: "텔레그램에서 실행 시도", approvalRequired: false });
    const orch = createTaskOrchestrator({
      taskStore: store,
      executor: createTaskExecutor(),
    });
    const result = await orch.run({
      taskId: "task-orch-tg-1",
      toolName: "owner.action.execute",
      channel: "telegram",
      hasApproval: true,
    });
    assert.equal(result.phase, "FAILED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
