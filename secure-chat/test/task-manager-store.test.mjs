import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskManagerStore } from "../src/task/task-manager-store.mjs";
import { createEvidenceRecord } from "../src/evidence/evidence.mjs";

test("task manager enforces required fields and legal transitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-manager-"));
  try {
    const store = new TaskManagerStore(join(dir, "tasks.json"), {
      now: () => Date.parse("2026-08-14T02:00:00.000Z"),
      idFactory: () => "task-fixed-id-0001",
    });
    await store.initialize();
    const created = await store.create({
      goal: "쿠팡에서 공개 검색만",
      approvalRequired: true,
      evidence: [
        createEvidenceRecord({
          epistemic: "INFERRED",
          claim: "사용자가 검색을 원한 것으로 보임",
          source: "model_guess",
          evidenceId: "ev-infer-1",
        }),
      ],
    });
    assert.equal(created.status, "CREATED");
    assert.equal(created.approval_required, true);
    assert.equal(created.evidence[0].epistemic, "INFERRED");

    await store.transition(created.task_id, { toStatus: "ANALYZING", currentStep: "analyze" });
    await store.transition(created.task_id, { toStatus: "PLANNED", currentStep: "plan", nextStep: "await_approval" });
    await assert.rejects(
      () => store.transition(created.task_id, { toStatus: "EXECUTING" }),
      /approval_required_before_execute/,
    );
    const waiting = await store.transition(created.task_id, { toStatus: "WAITING_APPROVAL" });
    assert.equal(waiting.status, "WAITING_APPROVAL");
    await store.transition(created.task_id, { toStatus: "EXECUTING", currentStep: "execute" });
    await store.transition(created.task_id, {
      toStatus: "VERIFYING",
      evidence: [
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: "검색 결과 페이지 타이틀 확인",
          source: "browser_probe",
          evidenceId: "ev-verified-1",
        }),
      ],
    });
    const done = await store.transition(created.task_id, { toStatus: "SUCCESS", currentStep: "done", nextStep: null });
    assert.equal(done.status, "SUCCESS");
    assert.equal(done.evidence.at(-1).epistemic, "VERIFIED");
    assert.equal((await store.summary()).counts.SUCCESS, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("illegal transitions fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-manager-"));
  try {
    const store = new TaskManagerStore(join(dir, "tasks.json"), {
      idFactory: () => "task-fixed-id-0002",
    });
    await store.initialize();
    const created = await store.create({ goal: "상태만 확인", approvalRequired: false });
    await assert.rejects(
      () => store.transition(created.task_id, { toStatus: "SUCCESS" }),
      /invalid_task_transition/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
