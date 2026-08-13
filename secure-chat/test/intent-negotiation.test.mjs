import assert from "node:assert/strict";
import test from "node:test";

import {
  INTENT_HYPOTHESIS_SCHEMA,
  compileIntentHypothesis,
  decideIntentNextStep,
} from "../src/trust/intent-negotiation.mjs";

const hash = (character) => character.repeat(64);

function slot(key, state = "confirmed", source = "user", digest = hash("b")) {
  return {
    key,
    state,
    source: state === "missing" ? "none" : source,
    value_sha256: state === "missing" ? null : digest,
  };
}

function candidate(overrides = {}) {
  return {
    schema: INTENT_HYPOTHESIS_SCHEMA,
    hypothesis_id: "intent-hypothesis.001",
    request_sha256: hash("a"),
    ingress: "local_owner_app",
    objective: {
      kind: "conversation.answer",
      summary: "사용자의 질문에 답한다.",
      effect_class: "none",
    },
    confidence_bps: 9_000,
    slots: [],
    ambiguities: [],
    preparations: [],
    created_at: "2026-08-05T01:00:00.000Z",
    ...overrides,
  };
}

test("ordinary conversation has no external effect and can be answered", () => {
  const compiled = compileIntentHypothesis(candidate());
  assert.match(compiled.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(decideIntentNextStep(compiled), { next: "answer", code: "no_external_effect" });
});

test("a vague cart request prepares only a safe public read instead of pretending it is understood", () => {
  const compiled = compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "사용자가 원하는 생수를 찾아 장바구니 추가 후보를 준비한다.",
      effect_class: "reversible_write",
    },
    confidence_bps: 8_500,
    slots: [
      slot("product_url", "missing"),
      slot("product_name", "missing"),
      slot("option_decision", "missing"),
      slot("quantity", "missing"),
      slot("expected_unit_price", "missing"),
      slot("max_total_price", "missing"),
      slot("currency", "inferred", "session_context"),
      slot("query", "confirmed", "user"),
    ],
    ambiguities: [{
      slot: "product_selection",
      material: true,
      blocks_effect: true,
      question: "어떤 상품과 용량, 묶음 수, 수량, 가격 한도를 적용할지 확정되지 않았습니다.",
    }],
    preparations: [{ kind: "coupang.search", effect_class: "public_read" }],
  }));
  assert.deepEqual(decideIntentNextStep(compiled), {
    next: "prepare",
    code: "safe_read_can_reduce_ambiguity",
    blocking_slots: [
      "expected_unit_price", "max_total_price", "option_decision", "product_name",
      "product_selection", "product_url", "quantity",
    ],
    preparation_kinds: ["coupang.search"],
  });
});

test("low confidence never blocks a profile-approved public read that can reduce ambiguity", () => {
  const compiled = compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "상품 후보를 공개 검색으로 확인한다.",
      effect_class: "reversible_write",
    },
    confidence_bps: 0,
    slots: [slot("query", "confirmed", "user")],
    preparations: [{ kind: "coupang.search", effect_class: "public_read" }],
  }));
  assert.equal(decideIntentNextStep(compiled).next, "prepare");
});

test("a fully specified cart effect still requires an exact preview and approval", () => {
  const required = [
    "product_url", "product_name", "option_decision", "quantity",
    "expected_unit_price", "max_total_price", "currency",
  ];
  const compiled = compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "선택된 생수 한 묶음을 장바구니에 추가한다.",
      effect_class: "reversible_write",
    },
    confidence_bps: 9_500,
    slots: required.map((key) => slot(key)),
  }));
  assert.deepEqual(decideIntentNextStep(compiled), {
    next: "request_approval",
    code: "exact_effect_preview_required",
  });
});

test("the model cannot downgrade a known write or invent a privileged preparation", () => {
  assert.throws(() => compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "장바구니를 바꾼다.",
      effect_class: "none",
    },
  })), /intent_effect_class_mismatch/u);

  assert.throws(() => compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "장바구니를 바꾼다.",
      effect_class: "reversible_write",
    },
    preparations: [{ kind: "coupang.cart.add", effect_class: "public_read" }],
  })), /unapproved_intent_preparation/u);

  assert.throws(() => compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "장바구니를 바꾼다.",
      effect_class: "reversible_write",
    },
    preparations: [{ kind: "coupang.search", effect_class: "none" }],
  })), /intent_preparation_effect_mismatch/u);
});

test("a preparation is not ready until its own parameters are resolved", () => {
  const compiled = compileIntentHypothesis(candidate({
    objective: {
      kind: "coupang.cart.add",
      summary: "검색어가 아직 없어 공개 검색도 시작하지 않는다.",
      effect_class: "reversible_write",
    },
    slots: [slot("query", "missing")],
    preparations: [{ kind: "coupang.search", effect_class: "public_read" }],
  }));
  assert.deepEqual(decideIntentNextStep(compiled), {
    next: "clarify",
    code: "material_information_missing",
    blocking_slots: [
      "currency", "expected_unit_price", "max_total_price", "option_decision",
      "product_name", "product_url", "quantity", "query",
    ],
  });
});

test("unknown effectful actions remain discussion-only until a code-owned profile exists", () => {
  const compiled = compileIntentHypothesis(candidate({
    objective: {
      kind: "unknown.device.control",
      summary: "등록되지 않은 장치를 제어한다.",
      effect_class: "reversible_write",
    },
  }));
  assert.deepEqual(decideIntentNextStep(compiled), {
    next: "discuss",
    code: "unregistered_action_profile",
  });
});

test("compiled intent hypotheses reject unknown fields and tampering", () => {
  assert.throws(() => compileIntentHypothesis({ ...candidate(), surprise: true }), /invalid_intent_hypothesis_fields/u);
  const compiled = compileIntentHypothesis(candidate());
  const tampered = structuredClone(compiled);
  tampered.hypothesis.objective.kind = "coupang.cart.add";
  assert.throws(() => decideIntentNextStep(tampered), /intent_effect_class_mismatch|compiled_intent_hypothesis_tampered/u);
});
