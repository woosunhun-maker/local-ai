import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../src/growth/canonical.mjs";
import {
  EFFECT_STATES,
  EffectLedgerReference,
} from "../src/trust/effect-ledger-reference.mjs";
import {
  CANONICALIZATION_VERSION,
  compileMomentContract,
  MOMENT_SCHEMA,
} from "../src/trust/moment-contract.mjs";

const hash = (character) => character.repeat(64);

function compiledMoment() {
  return compileMomentContract({
    schema: MOMENT_SCHEMA,
    canonicalization_version: CANONICALIZATION_VERSION,
    moment_id: "moment.cart.ledger.001",
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
      intent_id: "intent.cart.ledger.001",
      version: 1,
      source_provenance: ["source.user-message.ledger.001"],
    },
    plan: { plan_sha256: hash("e"), effect_index: 0, depends_on: [] },
    action: {
      kind: "coupang.cart.add",
      effect_class: "reversible_write",
      executor_id: "adapter.coupang",
      parameters: { product_id: "12345", quantity: 1, expected_unit_price: 40_000, max_total_price: 50_000 },
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
    ],
    authorization: {
      mode: "user_approval",
      grant_id: "approval.ledger.001",
      nonce: "nonce.ledger.0123456789",
      issued_at: "2026-08-05T00:00:00.000Z",
      not_before: "2026-08-05T00:00:00.000Z",
      expires_at: "2026-08-05T00:10:00.000Z",
      max_lifetime_ms: 600_000,
      max_uses: 1,
      revocation_epoch: 7,
    },
    capabilities: [{
      capability_id: "capability.cart.ledger.001",
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
      effect_id: "effect.cart.ledger.001",
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
    provenance: { dag_root_sha256: hash("f") },
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
  });
}

function live() {
  return {
    now: "2026-08-05T00:05:00.000Z",
    actor_authenticated: true,
    authentication_evidence_sha256: hash("a"),
    latest_intent_version: 1,
    policy_version: "policy.2026-08-05.1",
    tcb_manifest_sha256: hash("d"),
    revocation_epoch: 7,
    authorization_proof_verified: true,
    authorization_unconsumed: true,
    authorization_uses_remaining: 1,
    verified_capability_ids: ["capability.cart.ledger.001"],
    capability_uses_remaining: { "capability.cart.ledger.001": 1 },
    live_preconditions: { "/price": 49_000, "/quantity": 1 },
    budgets_remaining: { money_minor: 100_000, privacy_bytes: 0, attention_seconds: 60, notifications: 2, network_requests: 10 },
    co_principal_approvals_verified: false,
    bystander_exposure: "none",
  };
}

function evidence(compiled, overrides = {}) {
  return {
    evidence_id: "evidence.receipt.001",
    kind: "provider_receipt",
    evidence_sha256: hash("1"),
    principal_namespace: "personal.owner",
    provider_account_id: "coupang.account.owner",
    audience: "adapter.coupang",
    request_sha256: compiled.contract.bindings.action_sha256,
    provider_transaction_id: "provider.transaction.001",
    attempt_nonce: "attempt.001",
    verifier_id: "verifier.coupang.readonly",
    read_only: true,
    signature_verified: true,
    independent: false,
    semantic_result: "succeeded",
    observed_at: "2026-08-05T00:05:05.000Z",
    ...overrides,
  };
}

function executeToUnknown() {
  const compiled = compiledMoment();
  const ledger = new EffectLedgerReference(compiled);
  ledger.propose({ event_id: "event.001", at: "2026-08-05T00:04:59.000Z" });
  ledger.authorize(live(), { event_id: "event.002", at: "2026-08-05T00:05:00.000Z" });
  ledger.claim({
    event_id: "event.003",
    at: "2026-08-05T00:05:01.000Z",
    fencing_token: 1,
    approval_claim_id: "approval.claim.001",
    budget_reservation_id: "budget.reservation.001",
  });
  ledger.prepareDispatch({
    event_id: "event.004",
    at: "2026-08-05T00:05:02.000Z",
    fencing_token: 1,
    dispatch_ticket: "dispatch.ticket.001",
    egress_request_sha256: compiled.contract.bindings.action_sha256,
  });
  ledger.startEgress({
    event_id: "event.005",
    at: "2026-08-05T00:05:03.000Z",
    fencing_token: 1,
    dispatch_ticket: "dispatch.ticket.001",
    egress_request_sha256: compiled.contract.bindings.action_sha256,
  });
  return { compiled, ledger };
}

test("write success requires both an authentic receipt and independent read verification", () => {
  const { compiled, ledger } = executeToUnknown();
  ledger.addEvidence(evidence(compiled), { event_id: "event.006", at: "2026-08-05T00:05:06.000Z" });
  ledger.addEvidence(evidence(compiled, {
    evidence_id: "evidence.read.001",
    kind: "reconciliation_read",
    evidence_sha256: hash("2"),
    provider_transaction_id: null,
    attempt_nonce: null,
    signature_verified: false,
    independent: true,
    observed_at: "2026-08-05T00:05:07.000Z",
  }), { event_id: "event.007", at: "2026-08-05T00:05:08.000Z" });
  ledger.verifyOutcome(["evidence.receipt.001", "evidence.read.001"], {
    event_id: "event.008",
    at: "2026-08-05T00:05:09.000Z",
  });
  assert.equal(ledger.state, EFFECT_STATES.VERIFIED_SUCCEEDED);
  assert.equal(new EffectLedgerReference(compiled, ledger.events()).state, EFFECT_STATES.VERIFIED_SUCCEEDED);
});

test("evidence is bound to the code-owned verifier and cannot arrive from the future", () => {
  const { compiled, ledger } = executeToUnknown();
  assert.throws(() => ledger.addEvidence(evidence(compiled, { verifier_id: "verifier.attacker" }), {
    event_id: "event.006",
    at: "2026-08-05T00:05:06.000Z",
  }), /evidence_binding_mismatch/u);
  assert.throws(() => ledger.addEvidence(evidence(compiled, { observed_at: "2026-08-05T00:06:00.000Z" }), {
    event_id: "event.007",
    at: "2026-08-05T00:05:06.000Z",
  }), /evidence_from_future/u);
});

test("rehydration rejects a forged verified result that omits independent evidence", () => {
  const { compiled, ledger } = executeToUnknown();
  ledger.addEvidence(evidence(compiled), { event_id: "event.006", at: "2026-08-05T00:05:06.000Z" });
  const events = ledger.events();
  const forged = {
    ...events.at(-1),
    sequence: events.length + 1,
    event_id: "event.forged.verified",
    event_type: "outcome_verified",
    from_state: EFFECT_STATES.OUTCOME_UNKNOWN,
    to_state: EFFECT_STATES.VERIFIED_SUCCEEDED,
    at: "2026-08-05T00:05:07.000Z",
    fence: 1,
    details: { evidence_ids: ["evidence.receipt.001"] },
    previous_event_sha256: events.at(-1).event_sha256,
  };
  delete forged.event_sha256;
  forged.event_sha256 = canonicalSha256(forged);
  assert.throws(() => new EffectLedgerReference(compiled, [...events, forged]), /independent_semantic_verification_required/u);
});

test("event-specific detail fields are closed against hidden payloads", () => {
  const compiled = compiledMoment();
  const ledger = new EffectLedgerReference(compiled);
  ledger.propose({ event_id: "event.001", at: "2026-08-05T00:04:59.000Z" });
  const [event] = ledger.events();
  const forged = structuredClone(event);
  forged.details.hidden = "must-not-persist";
  delete forged.event_sha256;
  forged.event_sha256 = canonicalSha256(forged);
  assert.throws(() => new EffectLedgerReference(compiled, [forged]), /invalid_proposed_detail_fields/u);
});
