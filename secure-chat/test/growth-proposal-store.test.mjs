import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUntrustedProposal, transitionProposalState } from "../src/growth/proposal.mjs";
import { GrowthProposalStore } from "../src/growth/proposal-store.mjs";

const HASH = "a".repeat(64);

function createPending() {
  return createUntrustedProposal(
    {
      outboundRequestSha256: HASH,
      provider: "synthetic-provider",
      model: "synthetic-model",
      externalResponse: "합성 외부 자문이며 실행되지 않습니다.",
      content: {
        title: "합성 저장 제안",
        summary: "원문 외부 응답을 실행하지 않고 제안으로 격리합니다.",
        scopes: ["privacy"],
        changes: [{ id: "privacy_gate", area: "privacy", recommendation: "고정된 개인정보 보호 검사를 유지합니다." }],
        evidence: [{ id: "synthetic_case", type: "synthetic_test", sourceKind: "synthetic", summary: "합성값만 사용한 시험입니다.", digest: null }],
        tests: [{ id: "privacy_unit", kind: "unit", runnerId: "node_unit", fixture: "synthetic", description: "격리와 상태 전이를 검증합니다." }],
        rollback: { strategy: "restore_checkpoint", checkpointRequired: true, description: "적용 전 체크포인트로 복원합니다." },
      },
    },
    { now: "2030-01-01T00:00:00.000Z", id: "SYNTHETICSTORE001" },
  );
}

test("proposal store appends immutable hash-linked records with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-growth-store-"));
  const store = new GrowthProposalStore(join(root, "proposals"));
  await store.initialize();
  const pending = createPending();
  const firstWrite = await store.append(pending);
  assert.equal((await stat(firstWrite.recordPath)).mode & 0o777, 0o600);
  assert.equal((await store.readLatest(pending.id)).integrity.recordSha256, pending.integrity.recordSha256);

  const approved = transitionProposalState(
    pending,
    "approved",
    {
      approval: {
        requestId: "SYNTHETICSTOREAPPROVAL",
        nonce: "SYNTHETIC_STORE_NONCE_000000000001",
        expiresAt: "2030-01-01T00:05:00.000Z",
        keyId: "SYNTHETICKEY01",
        signature: "S".repeat(64),
      },
    },
    { now: "2030-01-01T00:01:00.000Z", verifyApproval: () => true },
  );
  await store.append(approved);
  assert.equal((await store.readLatest(pending.id)).lifecycle.status, "approved");

  await assert.rejects(() => store.append(approved), /stale or disconnected/);
});
