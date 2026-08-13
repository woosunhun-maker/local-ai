import assert from "node:assert/strict";
import test from "node:test";
import {
  createUntrustedProposal,
  PROPOSAL_TRUST,
  reviseUntrustedProposal,
  transitionProposalState,
  validateProposalRecord,
} from "../src/growth/proposal.mjs";

const DIGESTS = Object.freeze({
  request: "a".repeat(64),
  artifact: "b".repeat(64),
  rollback: "c".repeat(64),
  test: "d".repeat(64),
});

function content(summary = "합성 실패를 재현하고 고정 테스트로 회귀를 막는 제안입니다.") {
  return {
    title: "합성 응답 지연 개선 제안",
    summary,
    scopes: ["performance", "testing"],
    changes: [
      {
        id: "reduce_latency",
        area: "performance",
        recommendation: "합성 요청 경로의 중복 준비 단계를 줄이는 방안을 검토합니다.",
      },
    ],
    evidence: [
      {
        id: "synthetic_benchmark",
        type: "synthetic_test",
        sourceKind: "synthetic",
        summary: "가상 데이터 20회에서 동일한 지연 경향을 확인했습니다.",
        digest: null,
      },
    ],
    tests: [
      {
        id: "latency_unit",
        kind: "unit",
        runnerId: "node_unit",
        fixture: "synthetic",
        description: "고정 합성 입력에서 결과와 상태 전이를 검증합니다.",
      },
    ],
    rollback: {
      strategy: "restore_checkpoint",
      checkpointRequired: true,
      description: "적용 전 생성한 체크포인트로 복원합니다.",
    },
  };
}

function proposal() {
  return createUntrustedProposal(
    {
      outboundRequestSha256: DIGESTS.request,
      provider: "synthetic-provider",
      model: "synthetic-advisor-v1",
      externalResponse: "이 내용은 합성 외부 자문이며 실행 권한이 없습니다.",
      content: content(),
    },
    { now: "2030-01-01T00:00:00.000Z", id: "SYNTHETICPROPOSAL01" },
  );
}

test("external response is quarantined as a versioned, immutable untrusted proposal", () => {
  const record = proposal();
  assert.equal(validateProposalRecord(record), true);
  assert.equal(record.trust, PROPOSAL_TRUST);
  assert.equal(record.revision, 1);
  assert.equal(record.lifecycle.status, "pending");
  assert.equal(Object.isFrozen(record), true);
  assert.equal(record.source.responseText.includes("실행 권한이 없습니다"), true);
});

test("proposal schema rejects executable fields and non-synthetic test runners", () => {
  const executable = content();
  executable.changes[0].command = "synthetic-command";
  assert.throws(
    () => createUntrustedProposal({
      outboundRequestSha256: DIGESTS.request,
      provider: "synthetic-provider",
      model: "synthetic-advisor-v1",
      externalResponse: "합성 자문",
      content: executable,
    }),
    /invalid schema/,
  );

  const unsafeRunner = content();
  unsafeRunner.tests[0].runnerId = "arbitrary_shell";
  assert.throws(
    () => createUntrustedProposal({
      outboundRequestSha256: DIGESTS.request,
      provider: "synthetic-provider",
      model: "synthetic-advisor-v1",
      externalResponse: "합성 자문",
      content: unsafeRunner,
    }),
    /allowlisted runner/,
  );
});

test("revision increments and binds to the previous immutable record", () => {
  const first = proposal();
  const second = reviseUntrustedProposal(first, content("두 번째 합성 검토를 반영한 제안입니다."), {
    now: "2030-01-01T00:01:00.000Z",
  });
  assert.equal(second.revision, 2);
  assert.equal(second.recordVersion, 2);
  assert.equal(second.previousRecordSha256, first.integrity.recordSha256);
  assert.equal(second.revisionParentContentSha256, first.integrity.contentSha256);
  assert.equal(second.lifecycle.status, "pending");
  assert.notEqual(second.integrity.contentSha256, first.integrity.contentSha256);
  assert.equal(validateProposalRecord(second), true);
});

test("valid pending -> approved -> applied transition requires signature verification, tests, and rollback", () => {
  const pending = proposal();
  let observedSigningMessage = "";
  const approved = transitionProposalState(
    pending,
    "approved",
    {
      approval: {
        requestId: "SYNTHETICAPPROVAL01",
        nonce: "SYNTHETIC_APPROVAL_NONCE_00000001",
        expiresAt: "2030-01-01T00:05:00.000Z",
        keyId: "SYNTHETICKEY01",
        signature: "S".repeat(64),
      },
    },
    {
      now: "2030-01-01T00:02:00.000Z",
      verifyApproval: ({ signingMessage, proof }) => {
        observedSigningMessage = signingMessage;
        return signingMessage.includes(proof.payloadSha256) && proof.decision === "approved";
      },
    },
  );
  assert.equal(approved.lifecycle.status, "approved");
  assert.ok(observedSigningMessage.startsWith("localai-approval-v1\nSYNTHETICAPPROVAL01\n"));

  const applied = transitionProposalState(
    approved,
    "applied",
    {
      application: {
        artifactSha256: DIGESTS.artifact,
        rollbackCheckpointSha256: DIGESTS.rollback,
        testResults: [{ testId: "latency_unit", status: "passed", evidenceSha256: DIGESTS.test }],
      },
    },
    { now: "2030-01-01T00:03:00.000Z" },
  );
  assert.equal(applied.lifecycle.status, "applied");
  assert.equal(applied.lifecycle.application.actor, "fixed_runner");
  assert.equal(validateProposalRecord(applied), true);
});

test("invalid, expired, failed-test, and terminal transitions are blocked", () => {
  const pending = proposal();
  assert.throws(() => transitionProposalState(pending, "applied", {}), /Invalid proposal transition/);
  assert.throws(
    () => transitionProposalState(
      pending,
      "approved",
      {
        approval: {
          requestId: "SYNTHETICAPPROVAL01",
          nonce: "SYNTHETIC_APPROVAL_NONCE_00000001",
          expiresAt: "2030-01-01T00:01:00.000Z",
          keyId: "SYNTHETICKEY01",
          signature: "S".repeat(64),
        },
      },
      { now: "2030-01-01T00:02:00.000Z", verifyApproval: () => true },
    ),
    /expired/,
  );
  assert.throws(
    () => transitionProposalState(
      pending,
      "approved",
      {
        approval: {
          requestId: "SYNTHETICAPPROVAL01",
          nonce: "SYNTHETIC_APPROVAL_NONCE_00000001",
          expiresAt: "2030-01-01T00:05:00.000Z",
          keyId: "SYNTHETICKEY01",
          signature: "S".repeat(64),
        },
      },
      { now: "2030-01-01T00:02:00.000Z", verifyApproval: () => false },
    ),
    /verification failed/,
  );

  const approved = transitionProposalState(
    pending,
    "approved",
    {
      approval: {
        requestId: "SYNTHETICAPPROVAL02",
        nonce: "SYNTHETIC_APPROVAL_NONCE_00000002",
        expiresAt: "2030-01-01T00:05:00.000Z",
        keyId: "SYNTHETICKEY01",
        signature: "S".repeat(64),
      },
    },
    { now: "2030-01-01T00:02:00.000Z", verifyApproval: () => true },
  );
  assert.throws(
    () => transitionProposalState(
      approved,
      "applied",
      {
        application: {
          artifactSha256: DIGESTS.artifact,
          rollbackCheckpointSha256: DIGESTS.rollback,
          testResults: [{ testId: "latency_unit", status: "failed", evidenceSha256: DIGESTS.test }],
        },
      },
      { now: "2030-01-01T00:03:00.000Z" },
    ),
    /test result is invalid/,
  );

  const rejected = transitionProposalState(pending, "rejected", { reason: "합성 검토에서 보류" }, { now: "2030-01-01T00:02:00.000Z" });
  assert.equal(rejected.lifecycle.status, "rejected");
  assert.throws(() => transitionProposalState(rejected, "approved", {}), /Invalid proposal transition/);
});

test("proposal tampering is detected by content and record digests", () => {
  const record = proposal();
  const clone = JSON.parse(JSON.stringify(record));
  clone.content.summary = "변조된 합성 설명";
  assert.throws(() => validateProposalRecord(clone), /digest mismatch/);
});
