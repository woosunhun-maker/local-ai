import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore, approvalSigningPayload } from "../src/approval-store.mjs";
import { GrowthCoordinator } from "../src/growth/coordinator.mjs";
import { GrowthProposalStore } from "../src/growth/proposal-store.mjs";

function safeDraft() {
  return {
    schema: "local-ai.growth.structured-draft.v1",
    templateId: "performance_diagnostics_v1",
    facts: { sampleCount: 20, medianLatencyMs: 420, p95LatencyMs: 7_000, failureCount: 1 },
  };
}

function proposalContent() {
  return {
    title: "합성 성능 개선 제안",
    summary: "외부 조언을 격리한 합성 제안입니다.",
    scopes: ["performance"],
    changes: [{ id: "latency", area: "performance", recommendation: "합성 벤치마크로 먼저 검증합니다." }],
    evidence: [{ id: "synthetic", type: "synthetic_test", sourceKind: "synthetic", summary: "합성 입력만 사용합니다.", digest: null }],
    tests: [{ id: "latency_unit", kind: "unit", runnerId: "node_unit", fixture: "synthetic", description: "합성 지연 시험입니다." }],
    rollback: { strategy: "restore_checkpoint", checkpointRequired: true, description: "검증 실패 시 체크포인트를 복원합니다." },
  };
}

async function fixture(dispatchAdapter = null) {
  const root = await mkdtemp(join(tmpdir(), "local-ai-growth-coordinator-"));
  const clock = { value: Date.parse("2026-08-05T01:00:00.000Z") };
  const approvalStore = new ApprovalStore(join(root, "approvals.json"), { now: () => clock.value });
  const proposalStore = new GrowthProposalStore(join(root, "proposals"));
  const coordinator = new GrowthCoordinator({
    rootPath: join(root, "growth"),
    approvalStore,
    proposalStore,
    dispatchAdapter,
    now: () => clock.value,
  });
  await approvalStore.initialize();
  await coordinator.initialize();
  return { root, clock, approvalStore, proposalStore, coordinator };
}

async function approve(approvalStore) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await approvalStore.registerDeviceKey(
    "test-iphone",
    publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  );
  const pending = (await approvalStore.listPending())[0];
  const signatureDER = sign("sha256", approvalSigningPayload(pending, "approved"), privateKey).toString("base64");
  await approvalStore.decide({ id: pending.id, deviceId: "test-iphone", decision: "approved", signatureDER });
  return pending;
}

test("external transport is off by default and does not consume an approval", async () => {
  const { coordinator, approvalStore } = await fixture();
  const prepared = await coordinator.prepareConsultation(safeDraft());
  await approve(approvalStore);
  await assert.rejects(coordinator.dispatchApprovedRequest(prepared.requestId), /transport_disabled/);
  const stored = await approvalStore.read();
  assert.equal(stored.requests[0].status, "approved");
});

test("approved exact payload is dispatched once and subsequent calls reuse the receipt", async () => {
  let calls = 0;
  const adapter = async ({ correlationId, payloadCanonical }) => {
    calls += 1;
    assert.ok(correlationId);
    assert.match(payloadCanonical, /performance_diagnostics_v1/);
    return { responseText: "격리할 합성 외부 자문", providerRequestId: "synthetic-provider-1" };
  };
  const { coordinator, approvalStore } = await fixture(adapter);
  const prepared = await coordinator.prepareConsultation(safeDraft());
  assert.equal(await coordinator.dispatchApprovedRequest(prepared.requestId), null);
  await approve(approvalStore);
  const first = await coordinator.dispatchApprovedRequest(prepared.requestId);
  const second = await coordinator.dispatchApprovedRequest(prepared.requestId);
  assert.equal(calls, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receipt.correlationId, first.receipt.correlationId);
  assert.equal(second.externalResponse, first.externalResponse);

  await assert.rejects(
    coordinator.quarantineAdvice({ requestId: prepared.requestId, correlationId: "WRONG_CORRELATION_1", proposalContent: proposalContent() }),
    /correlation_mismatch/,
  );
  const proposal = await coordinator.quarantineAdvice({
    requestId: prepared.requestId,
    correlationId: first.receipt.correlationId,
    proposalContent: proposalContent(),
  });
  assert.equal(proposal.source.responseText, "격리할 합성 외부 자문");
  assert.equal(proposal.trust, "untrusted_external_advice");
});

test("an uncertain network result is never automatically retried", async () => {
  let calls = 0;
  const { coordinator, approvalStore } = await fixture(async () => {
    calls += 1;
    throw new Error("synthetic_network_interruption");
  });
  const prepared = await coordinator.prepareConsultation(safeDraft());
  await approve(approvalStore);
  await assert.rejects(coordinator.dispatchApprovedRequest(prepared.requestId), /synthetic_network_interruption/);
  await assert.rejects(coordinator.dispatchApprovedRequest(prepared.requestId), /in_doubt_no_retry/);
  assert.equal(calls, 1);
});
