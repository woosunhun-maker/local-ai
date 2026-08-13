import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvidenceRecord,
  evidenceFromRuntimeService,
  assertNotInferredAsFact,
} from "../src/evidence/evidence.mjs";

test("evidence records require epistemic labels and strip nested secrets", () => {
  const record = createEvidenceRecord({
    epistemic: "VERIFIED",
    claim: "secure-chat status=ok",
    source: "system.runtime_health",
    evidenceId: "evidence-fixed-id-001",
    detail: {
      service: "secure-chat",
      nested: { token: "secret" },
      ok: true,
    },
  });
  assert.equal(record.epistemic, "VERIFIED");
  assert.equal(record.detail.service, "secure-chat");
  assert.equal(record.detail.ok, true);
  assert.equal(record.detail.nested, undefined);
});

test("runtime service rows become VERIFIED evidence", () => {
  const evidence = evidenceFromRuntimeService({
    service: "telegram-general",
    status: "ok",
    model: null,
    pid: 42,
    last_health_check: "2026-08-14T00:00:00.000Z",
    error: null,
  });
  assert.equal(evidence.epistemic, "VERIFIED");
  assert.match(evidence.claim, /telegram-general/);
  assert.equal(evidence.detail.pid, 42);
});

test("inferred evidence cannot be treated as fact", () => {
  const inferred = createEvidenceRecord({
    epistemic: "INFERRED",
    claim: "planning agent is probably running",
    source: "model_guess",
  });
  assert.throws(() => assertNotInferredAsFact(inferred), /inferred_or_unknown/);
});
