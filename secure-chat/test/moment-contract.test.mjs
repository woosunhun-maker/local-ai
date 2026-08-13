import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../src/growth/canonical.mjs";
import {
  APPROVAL_MOMENT_BINDING_SCHEMA,
  bindApprovalPreviewToMoment,
  compileApprovalPreview,
} from "../src/trust/approval-preview.mjs";
import {
  bindIntentPlanToMoment,
  intentPlanProvenanceId,
  INTENT_MOMENT_BINDING_SCHEMA,
} from "../src/trust/intent-moment-binding.mjs";
import { bindIntentToWebTask } from "../src/trust/intent-plan-binding.mjs";
import {
  compileIntentHypothesis,
  INTENT_HYPOTHESIS_SCHEMA,
} from "../src/trust/intent-negotiation.mjs";

import {
  CANONICALIZATION_VERSION,
  MOMENT_SCHEMA,
  compileMomentContract,
  evaluateExecutionGate,
  validateCompiledMoment,
} from "../src/trust/moment-contract.mjs";
import { validateWebTask } from "../src/web-task-policy.mjs";

const hash = (character) => character.repeat(64);

function candidate(overrides = {}) {
  const base = {
    schema: MOMENT_SCHEMA,
    canonicalization_version: CANONICALIZATION_VERSION,
    moment_id: "moment.cart.001",
    actor: {
      actor_id: "user.owner",
      authentication_context: "iphone_secure_enclave",
      authentication_evidence_sha256: hash("a"),
    },
    principal: {
      principal_id: "principal.owner",
      principal_namespace: "personal.owner",
      provider_account_id: "coupang.account.owner",
      tenant_id: null,
      resource_owner: "user.owner",
      data_subjects: ["user.owner"],
      affected_parties: [],
      co_principal_required: false,
    },
    intent: {
      intent_id: "intent.cart.001",
      version: 3,
      source_provenance: ["source.user-message.001"],
    },
    plan: {
      plan_sha256: hash("e"),
      effect_index: 0,
      depends_on: [],
    },
    action: {
      kind: "coupang.cart.add",
      effect_class: "reversible_write",
      executor_id: "adapter.coupang",
      parameters: {
        product_id: "12345",
        quantity: 1,
        expected_unit_price: 40_000,
        max_total_price: 50_000,
      },
      required_capability: {
        audience: "adapter.coupang",
        resource: "coupang.cart.owner",
        operation: "cart.add",
        provider_account_id: "coupang.account.owner",
        data_labels: ["account_action", "shopping"],
        money_minor: 50_000,
      },
    },
    preconditions: [
      { path: "/price", comparator: "maximum", expected: 50_000 },
      { path: "/quantity", comparator: "exact", expected: 1 },
      { path: "/recipient", comparator: "exact", expected: "owner" },
      { path: "/stock", comparator: "minimum", expected: 1 },
    ],
    authorization: {
      mode: "user_approval",
      grant_id: "approval.001",
      nonce: "nonce.0123456789abcdef",
      issued_at: "2026-08-05T00:00:00.000Z",
      not_before: "2026-08-05T00:00:00.000Z",
      expires_at: "2026-08-05T00:10:00.000Z",
      max_lifetime_ms: 600_000,
      max_uses: 1,
      revocation_epoch: 7,
    },
    capabilities: [{
      capability_id: "capability.cart.001",
      issuer: "broker.local",
      subject: "adapter.coupang",
      audience: "adapter.coupang",
      resource: "coupang.cart.owner",
      operations: ["cart.add"],
      provider_account_id: "coupang.account.owner",
      data_labels: ["account_action", "shopping"],
      max_money_minor: 50_000,
      max_uses: 1,
      not_before: "2026-08-05T00:00:00.000Z",
      expires_at: "2026-08-05T00:10:00.000Z",
      revocation_epoch: 7,
      delegation_parent: null,
      proof_sha256: hash("c"),
    }],
    policy: {
      version: "policy.2026-08-05.1",
      tcb_manifest_sha256: hash("d"),
      risk_tier: "high",
      decision: "require_approval",
    },
    disclosure: {
      recipient: "coupang.account.owner",
      purpose: "cart_management",
      sensitivity: "confidential",
      data_labels: ["account_action", "shopping"],
      retention_expires_at: "2026-08-06T00:00:00.000Z",
      max_bytes: 0,
    },
    budgets: {
      money_minor: 50_000,
      currency: "KRW",
      privacy_bytes: 0,
      attention_seconds: 30,
      notifications: 1,
      network_requests: 6,
    },
    effect: {
      effect_id: "effect.cart.001",
      rollback_kind: "reversible",
      provider_supports_idempotency: false,
    },
    verifier: {
      verifier_id: "verifier.coupang.readonly",
      principal_id: "principal.verifier",
      read_only: true,
      checks: ["functional_postconditions", "receipt_authenticity", "safety_invariants"],
      timeout_ms: 30_000,
    },
    provenance: {
      dag_root_sha256: hash("f"),
    },
    presentation: {
      channel: "iphone_local_app",
      bystander_exposure: "none",
      plain_language: "이 상품 한 개를 장바구니에 넣습니다.",
      consequences: "결제되지는 않으며 장바구니 내용만 바뀝니다.",
      no_action_result: "승인하지 않으면 장바구니는 바뀌지 않습니다.",
      rollback: "장바구니에서 다시 제거할 수 있습니다.",
      uncertainty: "실행 전에 가격과 재고를 다시 확인합니다.",
      choices: ["approve", "reject", "later", "stop_all"],
      comprehension_gate: "predict_effect",
    },
    memory: {
      namespace: "memory.owner",
      read_scopes: ["shopping_preferences"],
      write_mode: "candidate_only",
      scope: "shopping",
      purpose: "preference_learning",
      consent_ref: hash("0"),
      retention_expires_at: "2026-09-05T00:00:00.000Z",
    },
    created_at: "2026-08-04T23:59:50.000Z",
  };
  return merge(base, overrides);
}

function merge(base, overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return structuredClone(overrides);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function live(overrides = {}) {
  const base = {
    now: "2026-08-05T00:05:00.000Z",
    actor_authenticated: true,
    authentication_evidence_sha256: hash("a"),
    latest_intent_version: 3,
    policy_version: "policy.2026-08-05.1",
    tcb_manifest_sha256: hash("d"),
    revocation_epoch: 7,
    authorization_proof_verified: true,
    authorization_unconsumed: true,
    authorization_uses_remaining: 1,
    verified_capability_ids: ["capability.cart.001"],
    capability_uses_remaining: { "capability.cart.001": 1 },
    live_preconditions: { "/price": 49_000, "/quantity": 1, "/recipient": "owner", "/stock": 3 },
    budgets_remaining: {
      money_minor: 100_000,
      privacy_bytes: 0,
      attention_seconds: 60,
      notifications: 2,
      network_requests: 10,
    },
    co_principal_approvals_verified: false,
    bystander_exposure: "none",
  };
  return merge(base, overrides);
}

function slot(key, value) {
  return { key, state: "confirmed", source: "user", value_sha256: canonicalSha256(value) };
}

function exactIntentPlan() {
  const task = {
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://www.coupang.com/vp/products/12345?itemId=67890",
      productName: "테스트 생수 2L 6개",
      option: null,
      quantity: 1,
      expectedUnitPrice: 40_000,
      maxTotalPrice: 50_000,
      currency: "KRW",
    },
  };
  const hypothesis = compileIntentHypothesis({
    schema: INTENT_HYPOTHESIS_SCHEMA,
    hypothesis_id: "intent-hypothesis.moment.001",
    request_sha256: hash("9"),
    ingress: "local_owner_app",
    objective: {
      kind: "coupang.cart.add",
      summary: "선택한 생수를 장바구니에 넣는다.",
      effect_class: "reversible_write",
    },
    confidence_bps: 9_500,
    slots: [
      slot("product_url", task.parameters.productUrl),
      slot("product_name", task.parameters.productName),
      slot("option_decision", "none"),
      slot("quantity", task.parameters.quantity),
      slot("expected_unit_price", task.parameters.expectedUnitPrice),
      slot("max_total_price", task.parameters.maxTotalPrice),
      slot("currency", task.parameters.currency),
    ],
    ambiguities: [],
    preparations: [],
    created_at: "2026-08-05T00:00:00.000Z",
  });
  return {
    task,
    plan: validateWebTask(task),
    binding: bindIntentToWebTask(hypothesis, task),
    hypothesis,
  };
}

function momentForIntentPlan(bundle, overrides = {}) {
  const input = candidate(merge({
    plan: { plan_sha256: bundle.plan.sha256 },
    intent: { source_provenance: [intentPlanProvenanceId(bundle.binding)] },
  }, overrides));
  input.action.parameters = structuredClone(overrides.action?.parameters ?? bundle.plan.parameters);
  return compileMomentContract(input);
}

test("compiles one strict canonical contract and binds approval, action, capabilities, and idempotency", () => {
  const compiled = compileMomentContract(candidate());
  assert.match(compiled.sha256, /^[a-f0-9]{64}$/);
  assert.match(compiled.contract.authorization.payload_sha256, /^[a-f0-9]{64}$/);
  assert.equal(compiled.contract.authorization.payload_sha256, compiled.contract.bindings.approval_basis_sha256);
  assert.match(compiled.contract.effect.idempotency_key, /^[a-f0-9]{64}$/);
  assert.equal(validateCompiledMoment(compiled).sha256, compiled.sha256);
  assert.deepEqual(evaluateExecutionGate(compiled, live()), { decision: "allow", code: "execution_gate_passed" });
});

test("exact intent and normalized web plan stay bound through MomentContract", () => {
  const bundle = exactIntentPlan();
  const moment = momentForIntentPlan(bundle);
  const linkage = bindIntentPlanToMoment(bundle.hypothesis, bundle.binding, bundle.task, moment);
  assert.equal(linkage.schema, INTENT_MOMENT_BINDING_SCHEMA);
  assert.equal(linkage.action_plan_sha256, bundle.plan.sha256);
  assert.equal(linkage.moment_contract_sha256, moment.sha256);
  assert.equal(linkage.authorization_mode, "user_approval");
  assert.match(linkage.linkage_sha256, /^[a-f0-9]{64}$/u);
});

test("deterministic approval preview stays bound through the exact Moment approval payload", () => {
  const bundle = exactIntentPlan();
  const preview = compileApprovalPreview(bundle.task);
  const moment = momentForIntentPlan(bundle, { presentation: preview.preview.presentation });
  const binding = bindApprovalPreviewToMoment({
    compiled_intent: bundle.hypothesis,
    intent_plan_binding: bundle.binding,
    task: bundle.task,
    compiled_moment: moment,
    compiled_preview: preview,
  });
  assert.equal(binding.schema, APPROVAL_MOMENT_BINDING_SCHEMA);
  assert.equal(binding.preview_sha256, preview.sha256);
  assert.equal(binding.moment_contract_sha256, moment.sha256);
  assert.equal(binding.approval_payload_sha256, moment.contract.authorization.payload_sha256);
  assert.match(binding.binding_sha256, /^[a-f0-9]{64}$/u);
});

test("deceptive approval text and preview tampering fail before an approval can be shown", () => {
  const bundle = exactIntentPlan();
  const preview = compileApprovalPreview(bundle.task);
  const deceptiveMoment = momentForIntentPlan(bundle, {
    presentation: {
      plain_language: "아무 변화도 없습니다.",
      consequences: "결제되지 않습니다.",
    },
  });
  assert.throws(() => bindApprovalPreviewToMoment({
    compiled_intent: bundle.hypothesis,
    intent_plan_binding: bundle.binding,
    task: bundle.task,
    compiled_moment: deceptiveMoment,
    compiled_preview: preview,
  }), /approval_presentation_mismatch/u);

  const correctMoment = momentForIntentPlan(bundle, { presentation: preview.preview.presentation });
  const tamperedPreview = structuredClone(preview);
  tamperedPreview.preview.facts.quantity = 2;
  assert.throws(() => bindApprovalPreviewToMoment({
    compiled_intent: bundle.hypothesis,
    intent_plan_binding: bundle.binding,
    task: bundle.task,
    compiled_moment: correctMoment,
    compiled_preview: tamperedPreview,
  }), /approval_preview_tampered/u);
});

test("plan swaps, parameter drift, missing provenance, and approval downgrade fail closed", () => {
  const bundle = exactIntentPlan();
  const moment = momentForIntentPlan(bundle);
  const changedTask = structuredClone(bundle.task);
  changedTask.parameters.productName = "다른 생수";
  assert.throws(() => bindIntentPlanToMoment(bundle.hypothesis, bundle.binding, changedTask, moment), /intent_plan_replay_rejected/u);

  const driftedMoment = momentForIntentPlan(bundle, {
    action: { parameters: { ...bundle.plan.parameters, productName: "다른 생수" } },
  });
  assert.throws(() => bindIntentPlanToMoment(bundle.hypothesis, bundle.binding, bundle.task, driftedMoment), /moment_parameters_mismatch/u);

  const unboundInput = candidate(merge({
    plan: { plan_sha256: bundle.plan.sha256 },
  }, {}));
  unboundInput.action.parameters = structuredClone(bundle.plan.parameters);
  const unboundMoment = compileMomentContract(unboundInput);
  assert.throws(() => bindIntentPlanToMoment(bundle.hypothesis, bundle.binding, bundle.task, unboundMoment), /moment_intent_provenance_missing/u);

  const downgradedMoment = momentForIntentPlan(bundle, {
    authorization: { mode: "policy" },
    policy: { decision: "allow" },
  });
  assert.throws(() => bindIntentPlanToMoment(bundle.hypothesis, bundle.binding, bundle.task, downgradedMoment), /moment_user_approval_missing/u);

  const forgedBinding = structuredClone(bundle.binding);
  forgedBinding.request_sha256 = hash("8");
  const forgedBase = { ...forgedBinding };
  delete forgedBase.binding_sha256;
  forgedBinding.binding_sha256 = canonicalSha256(forgedBase);
  assert.throws(() => bindIntentPlanToMoment(bundle.hypothesis, forgedBinding, bundle.task, moment), /intent_plan_replay_mismatch/u);
});

test("canonical compilation is stable across parameter key order and set ordering", () => {
  const alternate = candidate({
    action: {
      parameters: {
        max_total_price: 50_000,
        expected_unit_price: 40_000,
        quantity: 1,
        product_id: "12345",
      },
      required_capability: { data_labels: ["shopping", "account_action"] },
    },
    capabilities: [{
      ...candidate().capabilities[0],
      data_labels: ["shopping", "account_action"],
    }],
    presentation: { choices: ["stop_all", "reject", "approve", "later"] },
  });
  assert.equal(compileMomentContract(alternate).canonical, compileMomentContract(candidate()).canonical);
});

test("unknown fields and post-compilation tampering fail closed", () => {
  assert.throws(() => compileMomentContract({ ...candidate(), surprise: true }), { message: "invalid_moment_contract_fields" });

  const compiled = compileMomentContract(candidate());
  const tampered = structuredClone(compiled);
  tampered.contract.action.parameters.quantity = 2;
  assert.throws(() => validateCompiledMoment(tampered), { message: "compiled_moment_tampered" });
});

test("changed live state, intent, policy, revocation, expiry, and replay cannot execute", () => {
  const compiled = compileMomentContract(candidate());
  assert.deepEqual(evaluateExecutionGate(compiled, live({ live_preconditions: { "/price": 50_001 } })), { decision: "deny", code: "stale_approval" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ latest_intent_version: 4 })), { decision: "deny", code: "stale_intent" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ policy_version: "policy.2026-08-05.2" })), { decision: "deny", code: "policy_version_changed" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ policy_version: null, tcb_manifest_sha256: null })), { decision: "pending", code: "policy_unavailable" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ revocation_epoch: 8 })), { decision: "deny", code: "authorization_revoked" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ now: "2026-08-05T00:10:00.000Z" })), { decision: "deny", code: "authorization_expired" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ authorization_unconsumed: false, authorization_uses_remaining: 0 })), { decision: "deny", code: "authorization_replay" });
});

test("capabilities are non-composable: partial grants cannot be unioned", () => {
  const baseCapability = candidate().capabilities[0];
  const compiled = compileMomentContract(candidate({
    capabilities: [
      { ...baseCapability, capability_id: "capability.partial.operation", provider_account_id: "other.account" },
      { ...baseCapability, capability_id: "capability.partial.account", operations: ["cart.read"] },
    ],
  }));
  const context = live({
    verified_capability_ids: ["capability.partial.account", "capability.partial.operation"],
    capability_uses_remaining: { "capability.partial.account": 1, "capability.partial.operation": 1 },
  });
  assert.deepEqual(evaluateExecutionGate(compiled, context), { decision: "deny", code: "capability_not_satisfied" });
});

test("principal account, budgets, co-principal approval, and bystander privacy stay first-class", () => {
  assert.throws(() => compileMomentContract(candidate({
    action: { required_capability: { provider_account_id: "other.account" } },
  })), { message: "required_capability_account_mismatch" });

  const compiled = compileMomentContract(candidate());
  assert.deepEqual(evaluateExecutionGate(compiled, live({ budgets_remaining: { money_minor: 49_999 } })), { decision: "pending", code: "budget_exhausted" });
  assert.deepEqual(evaluateExecutionGate(compiled, live({ bystander_exposure: "possible" })), { decision: "deny", code: "unsafe_presentation_channel" });

  const shared = compileMomentContract(candidate({ principal: { co_principal_required: true } }));
  assert.deepEqual(evaluateExecutionGate(shared, live()), { decision: "pending", code: "co_principal_approval_required" });
  assert.deepEqual(evaluateExecutionGate(shared, live({ co_principal_approvals_verified: true })), { decision: "allow", code: "execution_gate_passed" });
});
