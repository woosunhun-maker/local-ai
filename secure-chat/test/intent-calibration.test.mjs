import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../src/growth/canonical.mjs";
import {
  INTENT_CALIBRATION_CASES,
  INTENT_CALIBRATION_SCHEMA,
  runIntentCalibration,
} from "../src/trust/intent-calibration.mjs";
import {
  compileIntentHypothesis,
  INTENT_HYPOTHESIS_SCHEMA,
} from "../src/trust/intent-negotiation.mjs";

const hash = (character) => character.repeat(64);

function slot(key, value) {
  return { key, state: "confirmed", source: "user", value_sha256: canonicalSha256(value) };
}

function compiledFor(input) {
  const utterance = input.utterance;
  let objective;
  let slots = [];
  let preparations = [];
  if (utterance.startsWith("안녕")) {
    objective = { kind: "conversation.answer", summary: "인사에 답한다.", effect_class: "none" };
  } else if (utterance.includes("중요 메일")) {
    objective = { kind: "mail.important.list", summary: "중요 메일을 읽는다.", effect_class: "private_read" };
    slots = [slot("provider", "gmail"), slot("max_results", 5), slot("unread_only", true)];
  } else if (utterance.includes("바로 결제")) {
    objective = { kind: "unregistered.coupang.purchase", summary: "지원하지 않는 구매다.", effect_class: "irreversible_write" };
  } else {
    objective = { kind: "coupang.cart.add", summary: "생수 후보를 찾는다.", effect_class: "reversible_write" };
    slots = [slot("query", "생수")];
    preparations = [{ kind: "coupang.search", effect_class: "public_read" }];
  }
  return compileIntentHypothesis({
    schema: INTENT_HYPOTHESIS_SCHEMA,
    hypothesis_id: `intent-hypothesis.calibration.${canonicalSha256(utterance).slice(0, 12)}`,
    request_sha256: canonicalSha256(utterance),
    ingress: input.ingress,
    objective,
    confidence_bps: 9_000,
    slots,
    ambiguities: [],
    preparations,
    created_at: "2026-08-05T08:00:00.000Z",
  });
}

test("synthetic calibration reports only bounded aggregate conformance", async () => {
  let clock = 0;
  const report = await runIntentCalibration({
    analyze: async (input) => compiledFor(input),
    now: () => { clock += 10; return clock; },
  });
  assert.equal(report.schema, INTENT_CALIBRATION_SCHEMA);
  assert.equal(report.total, INTENT_CALIBRATION_CASES.length);
  assert.equal(report.passed, report.total);
  assert.equal(report.pass_bps, 10_000);
  assert.equal(report.model, "qwen3.6:35b");
  assert.equal(report.latency.total_ms, report.total * 10);
  const serialized = JSON.stringify(report);
  for (const testCase of INTENT_CALIBRATION_CASES) {
    assert.equal(serialized.includes(testCase.utterance), false);
    assert.equal(serialized.includes(testCase.case_id), false);
  }
});

test("model errors and unsafe outcomes become aggregate failure counters", async () => {
  let calls = 0;
  const report = await runIntentCalibration({
    cases: INTENT_CALIBRATION_CASES.slice(0, 2),
    analyze: async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic-private-detail");
      return compileIntentHypothesis({
        schema: INTENT_HYPOTHESIS_SCHEMA,
        hypothesis_id: "intent-hypothesis.unsafe-test",
        request_sha256: hash("a"),
        ingress: input.ingress,
        objective: { kind: "conversation.answer", summary: "잘못 분류했다.", effect_class: "none" },
        confidence_bps: 9_000,
        slots: [],
        ambiguities: [],
        preparations: [],
        created_at: "2026-08-05T08:00:00.000Z",
      });
    },
    now: () => 0,
  });
  assert.equal(report.failed, 2);
  assert.equal(report.failures.model_error, 1);
  assert.equal(report.failures.action_mismatch, 1);
  assert.equal(JSON.stringify(report).includes("synthetic-private-detail"), false);
});

test("calibration cases are synthetic, owner-app-only, and structurally closed", async () => {
  await assert.rejects(runIntentCalibration({ cases: [{ ...INTENT_CALIBRATION_CASES[0], ingress: "telegram" }] }), /invalid_intent_calibration_ingress/u);
  await assert.rejects(runIntentCalibration({ cases: [{ ...INTENT_CALIBRATION_CASES[0], extra: true }] }), /invalid_intent_calibration_case/u);
});
