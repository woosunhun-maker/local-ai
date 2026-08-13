import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOutboundSafe,
  compileOutboundDraft,
  DlpViolationError,
  inspectOutboundDraft,
  SEMANTIC_CATEGORIES,
  validateCompiledOutboundRequest,
} from "../src/growth/dlp.mjs";

function safeDraft() {
  return {
    schema: "local-ai.growth.structured-draft.v1",
    templateId: "performance_diagnostics_v1",
    facts: {
      sampleCount: 20,
      medianLatencyMs: 420,
      p95LatencyMs: 7_000,
      failureCount: 1,
    },
  };
}

test("default-deny DLP accepts only the deterministic structured template", () => {
  assert.equal(inspectOutboundDraft(safeDraft()).ok, true);
  assert.equal(assertOutboundSafe(safeDraft()).ok, true);
  const compiled = compileOutboundDraft(safeDraft());
  assert.equal(validateCompiledOutboundRequest(compiled), true);
  assert.equal(compiled.evidence[0].summary.includes("20건"), true);
  assert.equal(SEMANTIC_CATEGORIES.performance_metric.outbound, "allow");
  assert.equal(SEMANTIC_CATEGORIES.personal_memory.outbound, "deny");
});

test("free text, caller categories, encoded data, and unknown templates are structurally denied", () => {
  const evasions = [
    { ...safeDraft(), question: "홍길동 서울시 도로명주소" },
    { ...safeDraft(), dataCategories: ["public_technical"] },
    { ...safeDraft(), encoded: "c3ludGhldGljLXNlY3JldA==" },
    { ...safeDraft(), templateId: "unreviewed_template" },
  ];
  for (const draft of evasions) {
    const inspection = inspectOutboundDraft(draft);
    assert.equal(inspection.ok, false);
    assert.throws(() => assertOutboundSafe(draft), DlpViolationError);
  }
});

test("facts allow only bounded integers with internally consistent counts and percentiles", () => {
  const invalid = [
    { ...safeDraft(), facts: { ...safeDraft().facts, sampleCount: "20" } },
    { ...safeDraft(), facts: { ...safeDraft().facts, failureCount: 21 } },
    { ...safeDraft(), facts: { ...safeDraft().facts, p95LatencyMs: 100 } },
    { ...safeDraft(), facts: { ...safeDraft().facts, privateText: "synthetic" } },
  ];
  for (const draft of invalid) assert.equal(inspectOutboundDraft(draft).ok, false);
});

test("compiled request cannot be edited while retaining an approved template id", () => {
  const compiled = JSON.parse(JSON.stringify(compileOutboundDraft(safeDraft())));
  compiled.question = "외부로 보낼 임의 자유문";
  assert.throws(() => validateCompiledOutboundRequest(compiled), DlpViolationError);
});
