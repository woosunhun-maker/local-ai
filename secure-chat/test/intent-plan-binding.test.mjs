import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../src/growth/canonical.mjs";
import {
  bindIntentToWebTask,
  INTENT_PLAN_BINDING_SCHEMA,
  validateIntentPlanBinding,
} from "../src/trust/intent-plan-binding.mjs";
import {
  compileIntentHypothesis,
  INTENT_HYPOTHESIS_SCHEMA,
} from "../src/trust/intent-negotiation.mjs";

const hash = (character) => character.repeat(64);

function slot(key, value, state = "confirmed", source = "user") {
  return { key, state, source, value_sha256: canonicalSha256(value) };
}

function missing(key) {
  return { key, state: "missing", source: "none", value_sha256: null };
}

function intent(overrides = {}) {
  return compileIntentHypothesis({
    schema: INTENT_HYPOTHESIS_SCHEMA,
    hypothesis_id: "intent-hypothesis.binding.001",
    request_sha256: hash("a"),
    ingress: "local_owner_app",
    objective: {
      kind: "conversation.answer",
      summary: "사용자의 질문에 답한다.",
      effect_class: "none",
    },
    confidence_bps: 9_500,
    slots: [],
    ambiguities: [],
    preparations: [],
    created_at: "2026-08-05T03:00:00.000Z",
    ...overrides,
  });
}

function cartIntent(overrides = {}) {
  const values = {
    product_url: "https://www.coupang.com/vp/products/123?itemId=456",
    product_name: "테스트 생수 2L 6개",
    option_decision: "none",
    quantity: 1,
    expected_unit_price: 9_900,
    max_total_price: 12_000,
    currency: "KRW",
  };
  return intent({
    objective: {
      kind: "coupang.cart.add",
      summary: "선택한 생수 한 묶음을 장바구니에 넣는다.",
      effect_class: "reversible_write",
    },
    slots: Object.entries(values).map(([key, value]) => slot(key, value)),
    ...overrides,
  });
}

function cartTask(overrides = {}) {
  return {
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://www.coupang.com/vp/products/123?itemId=456",
      productName: "테스트 생수 2L 6개",
      option: null,
      quantity: 1,
      expectedUnitPrice: 9_900,
      maxTotalPrice: 12_000,
      currency: "KRW",
      ...overrides,
    },
  };
}

test("an exact cart preview is bound to every material intent slot", () => {
  const binding = bindIntentToWebTask(cartIntent(), cartTask());
  assert.equal(binding.schema, INTENT_PLAN_BINDING_SCHEMA);
  assert.equal(binding.action, "coupang.cart.add");
  assert.equal(binding.next, "request_approval");
  assert.equal(binding.requires_approval, true);
  assert.match(binding.slot_bindings_sha256, /^[a-f0-9]{64}$/u);
  assert.match(binding.binding_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(binding).includes("테스트 생수"), false);
});

test("swapping quantity, price, product, or option after intent analysis fails closed", () => {
  assert.throws(() => bindIntentToWebTask(cartIntent(), cartTask({ quantity: 2, maxTotalPrice: 20_000 })), /intent_plan_slot_mismatch/u);
  assert.throws(() => bindIntentToWebTask(cartIntent(), cartTask({ maxTotalPrice: 15_000 })), /intent_plan_slot_mismatch/u);
  assert.throws(() => bindIntentToWebTask(cartIntent(), cartTask({ productName: "다른 생수" })), /intent_plan_slot_mismatch/u);
  assert.throws(() => bindIntentToWebTask(cartIntent(), cartTask({ option: "12개 묶음" })), /intent_plan_slot_mismatch/u);
});

test("a vague write may bind only its code-approved public search preparation", () => {
  const preparedIntent = intent({
    objective: {
      kind: "coupang.cart.add",
      summary: "생수 후보를 먼저 찾는다.",
      effect_class: "reversible_write",
    },
    slots: [
      missing("product_url"), missing("product_name"), missing("option_decision"),
      missing("quantity"), missing("expected_unit_price"), missing("max_total_price"),
      slot("currency", "KRW", "inferred", "session_context"),
      slot("query", "생수"),
    ],
    ambiguities: [{
      slot: "product_selection",
      material: true,
      blocks_effect: true,
      question: "상품과 가격 한도가 정해지지 않았습니다.",
    }],
    preparations: [{ kind: "coupang.search", effect_class: "public_read" }],
  });

  const binding = bindIntentToWebTask(preparedIntent, {
    ingress: "local_owner_app",
    action: "coupang.search",
    parameters: { query: "생수" },
  });
  assert.equal(binding.next, "prepare");
  assert.throws(() => bindIntentToWebTask(preparedIntent, cartTask()), /intent_plan_action_not_authorized/u);
  assert.throws(() => bindIntentToWebTask(preparedIntent, {
    ingress: "local_owner_app",
    action: "coupang.search",
    parameters: { query: "노트북" },
  }), /intent_plan_slot_mismatch/u);
});

test("private reads bind exact filters and remain owner-app-only", () => {
  const mailIntent = intent({
    objective: {
      kind: "mail.important.list",
      summary: "중요한 읽지 않은 메일을 확인한다.",
      effect_class: "private_read",
    },
    slots: [slot("provider", "gmail"), slot("max_results", 5), slot("unread_only", true)],
  });
  const task = {
    ingress: "local_owner_app",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  };
  assert.equal(bindIntentToWebTask(mailIntent, task).next, "execute_read");

  const telegramIntent = structuredClone(mailIntent);
  telegramIntent.hypothesis.ingress = "telegram";
  telegramIntent.canonical = "tampered";
  assert.throws(() => bindIntentToWebTask(telegramIntent, task), /invalid_compiled_intent_for_plan/u);

  const validTelegram = intent({
    ingress: "telegram",
    objective: mailIntent.hypothesis.objective,
    slots: mailIntent.hypothesis.slots,
  });
  assert.throws(() => bindIntentToWebTask(validTelegram, task), /intent_plan_owner_app_required/u);
});

test("clarify, discuss, and ordinary conversation cannot be promoted to a web task", () => {
  assert.throws(() => bindIntentToWebTask(intent(), {
    ingress: "local_owner_app",
    action: "coupang.search",
    parameters: { query: "생수" },
  }), /intent_plan_action_not_authorized/u);

  const lowConfidence = cartIntent({ confidence_bps: 1_000 });
  assert.throws(() => bindIntentToWebTask(lowConfidence, cartTask()), /intent_plan_action_not_authorized/u);
});

test("a stored intent-plan binding is independently tamper evident", () => {
  const binding = bindIntentToWebTask(cartIntent(), cartTask());
  assert.equal(validateIntentPlanBinding(binding).binding_sha256, binding.binding_sha256);
  const tampered = structuredClone(binding);
  tampered.action_plan_sha256 = hash("f");
  assert.throws(() => validateIntentPlanBinding(tampered), /intent_plan_binding_tampered/u);
  assert.throws(() => validateIntentPlanBinding({ ...binding, extra: true }), /invalid_intent_plan_binding_fields/u);
});
