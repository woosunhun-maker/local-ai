import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore, approvalSigningPayload } from "../src/approval-store.mjs";
import {
  OwnerCodexTaskCoordinator,
  ownerCodexApprovalDeviceId,
  ownerCodexDeviceHash,
} from "../src/codex/owner-task-coordinator.mjs";
import { createOwnerCodexPlan } from "../src/codex/owner-task-plan.mjs";
import { CodexTaskStore } from "../src/codex/task-store.mjs";

const START = Date.parse("2026-08-08T00:00:00.000Z");
const DEVICE = "owner-iphone-0001";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-ai-owner-codex-")));
  const clock = { value: START };
  const approvalStore = new ApprovalStore(join(root, "approvals.json"), { now: () => clock.value });
  const taskStore = new CodexTaskStore(join(root, "tasks.json"), { now: () => clock.value });
  const sourceRoot = join(root, "source");
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await writeFile(join(sourceRoot, "src", "safe.mjs"), "export const safe = true;\n");
  await approvalStore.initialize();
  await taskStore.initialize();
  const coordinator = new OwnerCodexTaskCoordinator({ taskStore, approvalStore, sourceRoot, now: () => clock.value });
  return { root, sourceRoot, clock, approvalStore, taskStore, coordinator };
}

function keyPair() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...keys,
    publicKeyDER: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function request(index = 1, overrides = {}) {
  return {
    intent: "inspect",
    request: `승인 후에만 실행할 합성 점검 ${index}`,
    idempotencyKey: `owner-request-${String(index).padStart(4, "0")}`,
    ...overrides,
  };
}

async function approve(coordinator, approval, privateKey, decision = "approved") {
  const signatureDER = sign("sha256", approvalSigningPayload(approval, decision), privateKey).toString("base64");
  return coordinator.decide(DEVICE, approval.id, decision, signatureDER);
}

test("owner task is immutable, device-bound, idempotent, and unclaimable before signed approval", async () => {
  const { coordinator, sourceRoot, taskStore } = await fixture();
  const keys = keyPair();
  await coordinator.registerApprovalKey(DEVICE, keys.publicKeyDER);
  const prepared = await coordinator.prepare(DEVICE, request());
  assert.equal(prepared.created, true);
  assert.equal(prepared.task.status, "awaiting_approval");
  assert.equal(prepared.approval.kind, "codex.execute");
  assert.equal(prepared.approval.payloadSha256, prepared.task.planSha256);
  assert.deepEqual(prepared.approval.dataCategories, ["known_identifier_scrubbed_code_snapshot", "task_instruction"]);
  const signedPlan = JSON.parse(prepared.approval.payload);
  assert.equal(signedPlan.schema, "local-ai.codex-task-plan.v3");
  assert.equal(signedPlan.request, request().request);
  assert.equal(signedPlan.sourceFileCount, 1);
  assert.equal(signedPlan.sourceTotalBytes, Buffer.byteLength("export const safe = true;\n", "utf8"));
  assert.deepEqual(signedPlan.execution, {
    mode: "isolated_inspect_and_draft",
    codexVersion: "codex-cli 0.147.0-alpha.1.2",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    provider: "openai_codex",
    externalTransfer: true,
    transferredData: ["task_instruction", "known_identifier_scrubbed_code_snapshot"],
    sourcePolicy: "allowlisted_known_identifier_scrubbed_code_v2",
    ownerSourcePermission: "read_only",
    draftValidation: "trusted_apply_isolated_copy_only",
    toolNetwork: false,
    modelHostFileTools: false,
    osProcessSandbox: false,
    clientAuthentication: "codex_auth_used",
    sourceApply: false,
  });

  const lease = await taskStore.acquireWorkerLease({ workerId: "owner-worker-before-approval" });
  assert.equal(await taskStore.claimNext(lease), null);
  await taskStore.releaseWorkerLease(lease);

  await writeFile(join(sourceRoot, "src", "unused.mjs"), "export const unused = true;\n");
  const duplicate = await coordinator.replay(DEVICE, request());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, prepared.task.id);
  assert.equal(duplicate.task.planSha256, prepared.task.planSha256);
  assert.equal(duplicate.approval.id, prepared.approval.id);
  await assert.rejects(
    coordinator.replay(DEVICE, request(1, { request: "같은 키로 바꾼 요청" })),
    /codex_task_replay_mismatch/,
  );
  assert.equal(await coordinator.replay(DEVICE, request(99)), null);
  assert.equal(await coordinator.get("another-owner-device", prepared.task.id), null);

  const decided = await approve(coordinator, prepared.approval, keys.privateKey);
  assert.equal(decided.status, "approved");
  assert.equal(decided.task.status, "queued");
  const retry = await approve(coordinator, prepared.approval, keys.privateKey);
  assert.equal(retry.status, "approved");
  assert.equal(retry.task.status, "queued");
});

test("consumed approval plus awaiting task is reconciled after a crash without a second execution", async () => {
  const { coordinator, approvalStore, taskStore } = await fixture();
  const keys = keyPair();
  await coordinator.registerApprovalKey(DEVICE, keys.publicKeyDER);
  const prepared = await coordinator.prepare(DEVICE, request(2));
  const signatureDER = sign("sha256", approvalSigningPayload(prepared.approval, "approved"), keys.privateKey).toString("base64");
  await approvalStore.decide({
    id: prepared.approval.id,
    deviceId: ownerCodexApprovalDeviceId(DEVICE),
    decision: "approved",
    signatureDER,
  });
  await approvalStore.consumeApproved(prepared.approval.id, prepared.task.planSha256);
  assert.equal((await taskStore.get(prepared.task.id)).status, "awaiting_approval");

  const recovered = await coordinator.get(DEVICE, prepared.task.id);
  assert.equal(recovered.task.status, "queued");
  assert.equal(recovered.approval, null);
  await coordinator.reconcileAll();
  assert.equal((await taskStore.get(prepared.task.id)).status, "queued");
});

test("expired approvals are swept before the durable awaiting limit is applied", async () => {
  const { coordinator, clock } = await fixture();
  for (let index = 10; index < 13; index += 1) {
    const prepared = await coordinator.prepare(DEVICE, request(index));
    assert.equal(prepared.task.status, "awaiting_approval");
  }
  clock.value += 11 * 60_000;
  const next = await coordinator.prepare(DEVICE, request(13));
  assert.equal(next.task.status, "awaiting_approval");
  const tasks = await coordinator.list(DEVICE, { limit: 10 });
  assert.equal(tasks.filter((entry) => entry.status === "expired").length, 3);
});

test("owner result exposes only bounded safe metadata and never enters Telegram delivery", async () => {
  const { coordinator, taskStore } = await fixture();
  const keys = keyPair();
  await coordinator.registerApprovalKey(DEVICE, keys.publicKeyDER);
  const prepared = await coordinator.prepare(DEVICE, request(20, { intent: "draft" }));
  await approve(coordinator, prepared.approval, keys.privateKey);
  const lease = await taskStore.acquireWorkerLease({ workerId: "owner-worker-result" });
  const running = await taskStore.claimNext(lease);
  assert.equal(running.ingress, "owner_app");
  const patch = [
    "diff --git a/src/safe.mjs b/src/safe.mjs",
    "index 0000000..1111111 100644",
    "--- a/src/safe.mjs",
    "+++ b/src/safe.mjs",
    "@@ -1 +1 @@",
    "-export const safe = true;",
    "+export const safe = false;",
    "",
  ].join("\n");
  await taskStore.transition(running.id, "running", "succeeded", {
    code: "codex_task_succeeded",
    summary: "격리 복제본에서 안전한 초안을 만들었습니다.",
    changedFileCount: 1,
    changedPaths: ["src/safe.mjs"],
    patch,
    patchSha256: createHash("sha256").update(patch, "utf8").digest("hex"),
  }, { workerLease: lease });
  await taskStore.releaseWorkerLease(lease);

  assert.deepEqual(await taskStore.listUndelivered(), []);
  const detail = await coordinator.get(DEVICE, prepared.task.id);
  assert.equal(detail.approval, null);
  assert.deepEqual(detail.task.result, {
    code: "codex_task_succeeded",
    summary: "격리 복제본에서 안전한 초안을 만들었습니다.",
    changedFileCount: 1,
    changedPaths: ["src/safe.mjs"],
    patch,
    patchSha256: createHash("sha256").update(patch, "utf8").digest("hex"),
  });
  const serialized = JSON.stringify(detail.task);
  assert.equal(serialized.includes(request(20, { intent: "draft" }).request), false);
  assert.equal(serialized.includes("changedFiles"), false);
  assert.equal(serialized.includes("workerId"), false);
});

test("owner task request policy allows code security work and blocks local operational data", async () => {
  const { coordinator } = await fixture();
  const allowed = await coordinator.prepare(DEVICE, {
    intent: "inspect",
    request: "승인 재생 공격 방어 로직을 점검해줘",
    idempotencyKey: "owner-security-0001",
  });
  assert.equal(allowed.task.status, "awaiting_approval");
  await assert.rejects(
    coordinator.prepare(DEVICE, {
      intent: "inspect",
      request: "합성 직원 장부와 계좌 원문을 분석해줘",
      idempotencyKey: "owner-local-data-0001",
    }),
    /codex_task_local_only_intent/,
  );
});

test("awaiting and queued work share one durable three-slot reservation", async () => {
  const { coordinator, taskStore } = await fixture();
  const prepared = [];
  for (let index = 40; index < 43; index += 1) prepared.push(await coordinator.prepare(DEVICE, request(index)));
  await assert.rejects(
    taskStore.enqueue({
      botId: "1234567890",
      ownerId: "100000001",
      chatId: "100000001",
      ownerGeneration: "b".repeat(32),
      updateId: 940,
      messageId: 941,
      intent: "inspect",
      request: "합성 legacy 코드 점검",
    }),
    /codex_task_queue_full/,
  );
  const keys = keyPair();
  await coordinator.registerApprovalKey(DEVICE, keys.publicKeyDER);
  const decided = await approve(coordinator, prepared[0].approval, keys.privateKey);
  assert.equal(decided.task.status, "queued");
  assert.equal((await taskStore.get(prepared[1].task.id)).status, "awaiting_approval");
});

test("periodic reconciliation releases an expired owner reservation for legacy queued work", async () => {
  const { coordinator, clock, taskStore } = await fixture();
  for (let index = 50; index < 53; index += 1) await coordinator.prepare(DEVICE, request(index));
  clock.value += 11 * 60_000;
  await coordinator.reconcileAll();
  const queued = await taskStore.enqueue({
    botId: "1234567890",
    ownerId: "100000001",
    chatId: "100000001",
    ownerGeneration: "c".repeat(32),
    updateId: 950,
    messageId: 951,
    intent: "inspect",
    request: "합성 legacy 코드 점검",
  });
  assert.equal(queued.job.status, "queued");
});

test("owner terminal tasks and exact Codex approvals are retained for seven days while active work survives", async () => {
  const { coordinator, approvalStore, clock, taskStore } = await fixture();
  const keys = keyPair();
  await coordinator.registerApprovalKey(DEVICE, keys.publicKeyDER);
  const terminal = await coordinator.prepare(DEVICE, request(60));
  await approve(coordinator, terminal.approval, keys.privateKey);
  const lease = await taskStore.acquireWorkerLease({ workerId: "owner-retention-worker" });
  const running = await taskStore.claimNext(lease);
  await taskStore.transition(running.id, "running", "succeeded", {
    code: "codex_task_succeeded",
    summary: "합성 보안 점검을 완료했습니다.",
    changedFileCount: 0,
    changedPaths: [],
    patch: null,
    patchSha256: null,
  }, { workerLease: lease });
  await taskStore.releaseWorkerLease(lease);

  clock.value += 8 * 24 * 60 * 60_000;
  const active = await coordinator.prepare(DEVICE, request(61));
  const pruned = await coordinator.pruneRetention();
  assert.deepEqual(pruned, { removedTaskCount: 1, removedApprovalCount: 1 });
  assert.equal(await taskStore.get(terminal.task.id), null);
  assert.equal(await approvalStore.get(terminal.approval.id), null);
  assert.equal((await taskStore.get(active.task.id)).status, "awaiting_approval");
  assert.equal((await approvalStore.get(active.approval.id)).status, "pending");
});

test("owner terminal retention keeps only the newest configured count", async () => {
  const { coordinator, clock, taskStore } = await fixture();
  const keys = keyPair();
  await coordinator.registerApprovalKey(DEVICE, keys.publicKeyDER);
  const completed = [];
  for (const index of [70, 71]) {
    const prepared = await coordinator.prepare(DEVICE, request(index));
    await approve(coordinator, prepared.approval, keys.privateKey);
    const lease = await taskStore.acquireWorkerLease({ workerId: `owner-cap-${index}` });
    const running = await taskStore.claimNext(lease);
    await taskStore.transition(running.id, "running", "succeeded", {
      code: "codex_task_succeeded",
      summary: `합성 점검 ${index} 완료`,
      changedFileCount: 0,
      changedPaths: [],
      patch: null,
      patchSha256: null,
    }, { workerLease: lease });
    await taskStore.releaseWorkerLease(lease);
    completed.push(prepared.task.id);
    clock.value += 1_000;
  }
  const removed = await taskStore.pruneOwnerAppTerminal({ maxAgeMs: 7 * 24 * 60 * 60_000, maxCount: 1 });
  assert.deepEqual(removed.map((entry) => entry.id), [completed[0]]);
  assert.equal(await taskStore.get(completed[0]), null);
  assert.equal((await taskStore.get(completed[1])).status, "succeeded");
});

test("a task-store-only crash point recreates the exact fixed-id approval", async () => {
  const { coordinator, approvalStore, taskStore } = await fixture();
  const ownerDeviceHash = ownerCodexDeviceHash(DEVICE);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const input = request(30);
  const plan = createOwnerCodexPlan({
    taskId: id,
    ownerDeviceHash,
    idempotencyKey: input.idempotencyKey,
    intent: input.intent,
    request: input.request,
    sourceManifestSha256: "a".repeat(64),
    sourceFileCount: 1,
    sourceTotalBytes: 26,
  });
  await taskStore.createOwnerAppTask({
    id,
    ownerDeviceHash,
    idempotencyKey: input.idempotencyKey,
    approvalRequestId: id,
    planCanonical: plan.canonical,
    planSha256: plan.sha256,
    intent: input.intent,
    request: input.request,
  });
  assert.equal(await approvalStore.get(id), null);
  await coordinator.reconcileAll();
  const restored = await approvalStore.get(id);
  assert.equal(restored.id, id);
  assert.equal(restored.payload, plan.canonical);
});

test("v2 Telegram queues migrate to quarantined terminal records without changing request bindings", async () => {
  const { root, taskStore } = await fixture();
  const source = await taskStore.enqueue({
    botId: "1234567890",
    ownerId: "100000001",
    chatId: "100000001",
    ownerGeneration: "a".repeat(32),
    updateId: 900,
    messageId: 901,
    intent: "inspect",
    request: "마이그레이션 합성 작업",
  });
  const currentPath = join(root, "tasks.json");
  const v3 = JSON.parse(await readFile(currentPath, "utf8"));
  const legacyJob = { ...v3.jobs[0] };
  for (const key of ["ingress", "ownerDeviceHash", "idempotencyKey", "approvalRequestId", "planCanonical", "planSha256"]) delete legacyJob[key];
  legacyJob.version = 2;
  await writeFile(currentPath, `${JSON.stringify({ version: 2, jobs: [legacyJob] })}\n`, { mode: 0o600 });
  const restarted = new CodexTaskStore(currentPath);
  await restarted.initialize();
  const migrated = await restarted.get(source.job.id);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.ingress, "telegram");
  assert.equal(migrated.requestSha256, source.job.requestSha256);
  assert.equal(migrated.status, "interrupted_uncertain");
  assert.equal(migrated.result.code, "codex_owner_app_approval_required");
  assert.ok(migrated.quarantinedAt);
  const lease = await restarted.acquireWorkerLease({ workerId: "migration-no-claim" });
  assert.equal(await restarted.claimNext(lease), null);
  await restarted.releaseWorkerLease(lease);
});
