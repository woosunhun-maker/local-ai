import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore, approvalSigningPayload } from "../src/approval-store.mjs";
import { createOwnerCodexPlan } from "../src/codex/owner-task-plan.mjs";
import { createFrozenOutboundRequest } from "../src/growth/outbound-request.mjs";

function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKeyDER: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

async function fixture(now = Date.parse("2026-08-05T10:00:00.000Z")) {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-approvals-"));
  const clock = { value: now };
  const store = new ApprovalStore(join(directory, "approvals.json"), { now: () => clock.value });
  await store.initialize();
  return { store, clock, path: store.path };
}

test("approval store keeps a zero-byte kernel lock and serializes concurrent writers", async () => {
  const { store, path } = await fixture();
  const peer = new ApprovalStore(path);
  await peer.initialize();
  const lockDetails = await stat(`${path}.lock`);
  assert.equal(lockDetails.isFile(), true);
  assert.equal(lockDetails.mode & 0o777, 0o600);
  assert.equal(lockDetails.size, 0);

  const created = await Promise.all(Array.from({ length: 8 }, (_, index) => {
    const target = index % 2 === 0 ? store : peer;
    return target.createRequest({
      kind: "system.change",
      title: `합성 잠금 ${index}`,
      summary: "동시 승인 저장 직렬화",
      payload: `synthetic-lock-payload-${index}`,
    }, 30_000, { id: `approval-lock-test-${String(index).padStart(4, "0")}` });
  }));
  assert.equal(created.length, 8);
  assert.equal((await store.read()).requests.length, 8);
});

test("concurrent first initialization cannot overwrite a completed approval mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-approval-init-race-"));
  const path = join(directory, "approvals.json");
  const first = new ApprovalStore(path);
  const second = new ApprovalStore(path);
  const originalWrite = first.write.bind(first);
  let releaseWrite;
  const release = new Promise((resolve) => { releaseWrite = resolve; });
  let enteredWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  let paused = false;
  first.write = async (value) => {
    if (!paused && value?.version === 1 && value.requests?.length === 0) {
      paused = true;
      enteredWrite();
      await release;
    }
    return originalWrite(value);
  };

  const firstInitialization = first.initialize();
  await entered;
  const secondFlow = (async () => {
    await second.initialize();
    return second.createRequest({
      kind: "system.change",
      title: "초기화 경쟁",
      summary: "후속 승인이 보존되어야 함",
      payload: "synthetic initialization race",
    }, 30_000, { id: "approval-init-race-0001" });
  })();
  releaseWrite();
  await Promise.all([firstInitialization, secondFlow]);
  assert.equal((await first.read()).requests.some((entry) => entry.id === "approval-init-race-0001"), true);
});

test("binds an approval to the exact payload, nonce, expiry, decision, and device key", async () => {
  const { store } = await fixture();
  const key = deviceKey();
  await store.registerDeviceKey("iphone-1", key.publicKeyDER);
  const request = await store.createRequest({
    kind: "system.change",
    title: "합성 설정 변경",
    summary: "정확한 변경문 서명",
    payload: '{"question":"synthetic failure code E_TEST"}',
    dataCategories: ["synthetic_test", "public_error_code"],
  });
  const signatureDER = sign("sha256", approvalSigningPayload(request, "approved"), key.privateKey).toString("base64");

  const decision = await store.decide({ id: request.id, deviceId: "iphone-1", decision: "approved", signatureDER });
  assert.equal(decision.status, "approved");
  assert.equal((await store.listPending()).length, 0);
  assert.equal((await store.consumeApproved(request.id, request.payloadSha256))?.status, "consumed");
  assert.equal(await store.consumeApproved(request.id, request.payloadSha256), null);
});

test("rejects a signature made for another decision or a changed request", async () => {
  const { store } = await fixture();
  const key = deviceKey();
  await store.registerDeviceKey("iphone-1", key.publicKeyDER);
  const request = await store.createRequest({
    kind: "system.change",
    title: "설정 변경",
    summary: "테스트 변경",
    payload: "exact change payload",
  });
  const wrongDecisionSignature = sign("sha256", approvalSigningPayload(request, "rejected"), key.privateKey).toString("base64");

  await assert.rejects(
    store.decide({ id: request.id, deviceId: "iphone-1", decision: "approved", signatureDER: wrongDecisionSignature }),
    /invalid_approval_signature/,
  );
});

test("expires pending approvals and refuses public-key replacement", async () => {
  const { store, clock } = await fixture();
  const first = deviceKey();
  const second = deviceKey();
  await store.registerDeviceKey("iphone-1", first.publicKeyDER);
  await assert.rejects(store.registerDeviceKey("iphone-1", second.publicKeyDER), /approval_key_already_registered/);
  await store.createRequest({
    kind: "model.install",
    title: "로컬 음성 모델 설치",
    summary: "고정 모델 다운로드",
    payload: "pinned model revision and sha256",
  }, 30_000);

  clock.value += 31_000;
  assert.deepEqual(await store.listPending(), []);
});

test("preserves a frozen growth request id, canonical payload, and digest exactly", async () => {
  const now = Date.parse("2026-08-05T10:00:00.000Z");
  const { store } = await fixture(now);
  const frozen = createFrozenOutboundRequest({
    schema: "local-ai.growth.structured-draft.v1",
    templateId: "performance_diagnostics_v1",
    facts: { sampleCount: 20, medianLatencyMs: 420, p95LatencyMs: 7_000, failureCount: 1 },
  }, {
    now,
    requestId: "SYNTHETICREQUEST01",
    nonce: "0123456789abcdef0123456789abcdef",
  });

  const pending = await store.createFrozenRequest(frozen, {
    title: "외부 성능 자문",
    summary: "합성 재현만 전송",
  });
  assert.equal(pending.id, frozen.requestId);
  assert.equal(pending.payload, frozen.payloadCanonical);
  assert.equal(pending.payloadSha256, frozen.payloadSha256);
  assert.equal(pending.frozenRequestSha256, frozen.requestSha256);

  const key = deviceKey();
  await store.registerDeviceKey("iphone-1", key.publicKeyDER);
  const signatureDER = sign("sha256", approvalSigningPayload(pending, "approved"), key.privateKey).toString("base64");
  await store.decide({ id: pending.id, deviceId: "iphone-1", decision: "approved", signatureDER });
  await assert.rejects(
    store.consumeApproved(pending.id, {
      payloadSha256: frozen.payloadSha256,
      frozenRequestSha256: "0".repeat(64),
      nonce: frozen.nonce,
      expiresAt: frozen.expiresAt,
    }),
    /frozen_request_binding_mismatch/,
  );
});

test("an approval cannot be consumed after its exact expiry", async () => {
  const { store, clock } = await fixture();
  const key = deviceKey();
  await store.registerDeviceKey("iphone-1", key.publicKeyDER);
  const request = await store.createRequest({
    kind: "system.change",
    title: "합성 변경",
    summary: "만료 재검사",
    payload: "synthetic exact change",
  }, 30_000);
  const signatureDER = sign("sha256", approvalSigningPayload(request, "approved"), key.privateKey).toString("base64");
  await store.decide({ id: request.id, deviceId: "iphone-1", decision: "approved", signatureDER });
  clock.value += 30_000;
  assert.equal(await store.consumeApproved(request.id, request.payloadSha256), null);
});

test("stored payload and approval proof tampering fail closed on read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-approval-tamper-"));
  const path = join(directory, "approvals.json");
  const store = new ApprovalStore(path);
  await store.initialize();
  const key = deviceKey();
  await store.registerDeviceKey("iphone-1", key.publicKeyDER);
  const request = await store.createRequest({
    kind: "system.change",
    title: "합성 변경",
    summary: "저장소 검증",
    payload: "synthetic exact change",
  });
  const signatureDER = sign("sha256", approvalSigningPayload(request, "approved"), key.privateKey).toString("base64");
  await store.decide({ id: request.id, deviceId: "iphone-1", decision: "approved", signatureDER });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  parsed.requests[0].payload = "tampered";
  await writeFile(path, JSON.stringify(parsed));
  await assert.rejects(store.read(), /payload_hash_mismatch/);
});

test("new approvals reject hidden fields instead of persisting caller-controlled schema", async () => {
  const { store } = await fixture();
  await assert.rejects(
    store.createRequest({
      kind: "system.change",
      title: "합성 변경",
      summary: "닫힌 입력 스키마",
      payload: "synthetic payload",
      hidden: "must-not-persist",
    }),
    /invalid_approval_request/,
  );
});

test("codex approvals cannot be decided with the generic device-key namespace", async () => {
  const { store } = await fixture();
  const key = deviceKey();
  await store.registerDeviceKey("owner-iphone-generic", key.publicKeyDER);
  const request = await store.createRequest({
    kind: "codex.execute",
    title: "Codex 합성 승인",
    summary: "전용 키 경계",
    payload: "synthetic codex plan",
  });
  const signatureDER = sign("sha256", approvalSigningPayload(request, "approved"), key.privateKey).toString("base64");
  await assert.rejects(
    store.decide({ id: request.id, deviceId: "owner-iphone-generic", decision: "approved", signatureDER }),
    /codex_dedicated_approval_required/,
  );
});

test("orphan retention deletes only strict v3 Codex plans and preserves unknown legacy payloads", async () => {
  const { store, clock } = await fixture();
  const plan = createOwnerCodexPlan({
    taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerDeviceHash: "b".repeat(64),
    idempotencyKey: "owner-retention-0001",
    intent: "inspect",
    request: "승인 경로 보안 점검",
    sourceManifestSha256: "c".repeat(64),
    sourceFileCount: 1,
    sourceTotalBytes: 26,
  });
  const current = await store.createRequest({
    kind: "codex.execute",
    title: "Codex v3 합성 승인",
    summary: "엄격한 orphan 정리",
    payload: plan.canonical,
  }, 30_000, { id: plan.taskId });
  const legacy = await store.createRequest({
    kind: "codex.execute",
    title: "Codex legacy 합성 승인",
    summary: "알 수 없는 과거 payload 보존",
    payload: "legacy-unknown-codex-payload",
  }, 30_000, { id: "legacy-codex-request-0001" });
  clock.value += 31_000;
  await store.listPending();
  assert.deepEqual(await store.pruneOrphanedCodexRequests([]), [current.id]);
  assert.equal(await store.get(current.id), null);
  assert.equal((await store.get(legacy.id)).status, "expired");
});
