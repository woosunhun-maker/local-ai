import { randomUUID } from "node:crypto";

import {
  canonicalSha256,
  canonicalizeJson,
  deepFreeze,
  isSha256,
} from "../growth/canonical.mjs";
import {
  evaluateExecutionGate,
  validateCompiledMoment,
} from "./moment-contract.mjs";

export const EFFECT_EVENT_SCHEMA = "local-ai.effect-event.v0.1";

export const EFFECT_STATES = Object.freeze({
  PROPOSED: "proposed",
  AUTHORIZED: "authorized",
  CLAIMED: "claimed",
  OUTCOME_UNKNOWN: "outcome_unknown",
  VERIFIED_SUCCEEDED: "verified_succeeded",
  VERIFIED_NO_EFFECT: "verified_no_effect",
  VERIFIED_PARTIAL: "verified_partial",
  OUTCOME_DISPUTED: "outcome_disputed",
  ABORTED_PRE_DISPATCH: "aborted_pre_dispatch",
});

const PRE_DISPATCH = new Set([
  EFFECT_STATES.PROPOSED,
  EFFECT_STATES.AUTHORIZED,
  EFFECT_STATES.CLAIMED,
]);
const VERIFIED = new Set([
  EFFECT_STATES.VERIFIED_SUCCEEDED,
  EFFECT_STATES.VERIFIED_NO_EFFECT,
  EFFECT_STATES.VERIFIED_PARTIAL,
]);
const EVENT_TYPES = new Set([
  "proposed",
  "authorized",
  "claimed",
  "reclaimed",
  "dispatch_prepared",
  "egress_started",
  "evidence_added",
  "outcome_verified",
  "outcome_disputed",
  "aborted_pre_dispatch",
  "cancel_requested",
  "compensation_linked",
]);
const ABORT_REASONS = new Set([
  "rejected", "expired", "revoked", "stale_approval", "policy_block", "cancelled", "budget_exhausted", "capability_invalid",
]);
const EVIDENCE_KINDS = new Set([
  "provider_receipt", "provider_callback", "reconciliation_read", "provider_rejection", "user_dispute", "operator_observation",
]);
const SEMANTIC_RESULTS = new Set(["unknown", "succeeded", "no_effect", "partial", "conflict"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class EffectLedgerError extends Error {
  constructor(code) {
    super(code);
    this.name = "EffectLedgerError";
    this.code = code;
  }
}

function fail(code) {
  throw new EffectLedgerError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, expectedKeys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function identifier(value, code) {
  if (typeof value !== "string" || !ID.test(value)) fail(code);
  return value;
}

function digest(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (!isSha256(value)) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== "string") fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return value;
}

function integer(value, code, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(code);
  return value;
}

function boolean(value, code) {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function enumeration(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
  return value;
}

function optionalIdentifier(value, code) {
  return value === null ? null : identifier(value, code);
}

function json(value, code) {
  try {
    return JSON.parse(canonicalizeJson(value));
  } catch {
    fail(code);
  }
}

function eventWithoutDigest(event) {
  const copy = { ...event };
  delete copy.event_sha256;
  return copy;
}

function normalizeEvidence(value) {
  const input = plain(value, "invalid_effect_evidence");
  exactKeys(input, [
    "evidence_id", "kind", "evidence_sha256", "principal_namespace", "provider_account_id", "audience",
    "request_sha256", "provider_transaction_id", "attempt_nonce", "verifier_id", "read_only",
    "signature_verified", "independent", "semantic_result", "observed_at",
  ], "invalid_effect_evidence_fields");
  return {
    evidence_id: identifier(input.evidence_id, "invalid_evidence_id"),
    kind: enumeration(input.kind, EVIDENCE_KINDS, "invalid_evidence_kind"),
    evidence_sha256: digest(input.evidence_sha256, "invalid_evidence_digest"),
    principal_namespace: identifier(input.principal_namespace, "invalid_evidence_principal"),
    provider_account_id: identifier(input.provider_account_id, "invalid_evidence_account"),
    audience: identifier(input.audience, "invalid_evidence_audience"),
    request_sha256: digest(input.request_sha256, "invalid_evidence_request"),
    provider_transaction_id: optionalIdentifier(input.provider_transaction_id, "invalid_provider_transaction_id"),
    attempt_nonce: optionalIdentifier(input.attempt_nonce, "invalid_attempt_nonce"),
    verifier_id: identifier(input.verifier_id, "invalid_evidence_verifier"),
    read_only: boolean(input.read_only, "invalid_evidence_read_only"),
    signature_verified: boolean(input.signature_verified, "invalid_evidence_signature_state"),
    independent: boolean(input.independent, "invalid_evidence_independence"),
    semantic_result: enumeration(input.semantic_result, SEMANTIC_RESULTS, "invalid_semantic_result"),
    observed_at: timestamp(input.observed_at, "invalid_evidence_timestamp"),
  };
}

function normalizeMetadata(value) {
  const input = plain(value, "invalid_effect_metadata");
  exactKeys(input, ["event_id", "at"], "invalid_effect_metadata_fields");
  return {
    event_id: identifier(input.event_id, "invalid_effect_event_id"),
    at: timestamp(input.at, "invalid_effect_event_timestamp"),
  };
}

function emptyDerivedState(contract) {
  return {
    contract,
    state: null,
    fence: 0,
    dispatch_ticket: null,
    egress_started: false,
    approval_claim_id: null,
    budget_reservation_id: null,
    evidence: new Map(),
    evidence_digests: new Map(),
    provider_transactions: new Map(),
    cancel_requested: false,
    compensation_effect_keys: new Set(),
    last_at: null,
  };
}

function expectedContext(contract) {
  return {
    principal_namespace: contract.principal.principal_namespace,
    effect_id: contract.effect.effect_id,
    contract_sha256: null,
    idempotency_key: contract.effect.idempotency_key,
  };
}

function normalizeStoredEvent(value, expected, previous, sequence) {
  const input = plain(value, "invalid_effect_event");
  exactKeys(input, [
    "schema", "sequence", "event_id", "event_type", "principal_namespace", "effect_id", "contract_sha256",
    "idempotency_key", "from_state", "to_state", "at", "fence", "details", "previous_event_sha256", "event_sha256",
  ], "invalid_effect_event_fields");
  if (input.schema !== EFFECT_EVENT_SCHEMA) fail("unsupported_effect_event_schema");
  if (input.sequence !== sequence) fail("effect_event_sequence_mismatch");
  identifier(input.event_id, "invalid_effect_event_id");
  enumeration(input.event_type, EVENT_TYPES, "invalid_effect_event_type");
  if (input.principal_namespace !== expected.principal_namespace || input.effect_id !== expected.effect_id) fail("effect_event_key_mismatch");
  if (input.contract_sha256 !== expected.contract_sha256 || input.idempotency_key !== expected.idempotency_key) fail("effect_event_binding_mismatch");
  if (input.from_state !== null && !Object.values(EFFECT_STATES).includes(input.from_state)) fail("invalid_effect_from_state");
  if (input.to_state !== null && !Object.values(EFFECT_STATES).includes(input.to_state)) fail("invalid_effect_to_state");
  timestamp(input.at, "invalid_effect_event_timestamp");
  integer(input.fence, "invalid_effect_fence");
  json(input.details, "invalid_effect_event_details");
  const expectedPrevious = previous?.event_sha256 ?? null;
  if (input.previous_event_sha256 !== expectedPrevious) fail("effect_event_chain_mismatch");
  if (!isSha256(input.event_sha256) || canonicalSha256(eventWithoutDigest(input)) !== input.event_sha256) fail("effect_event_digest_mismatch");
  return input;
}

function applyEvent(derived, event) {
  if (derived.last_at !== null && Date.parse(event.at) < Date.parse(derived.last_at)) fail("effect_event_time_regression");
  if (event.from_state !== derived.state) fail("effect_event_state_conflict");
  if (event.fence < derived.fence) fail("effect_fence_regression");

  const details = event.details;
  switch (event.event_type) {
    case "proposed":
      exactKeys(plain(details, "invalid_proposed_details"), [], "invalid_proposed_detail_fields");
      if (derived.state !== null || event.to_state !== EFFECT_STATES.PROPOSED || event.fence !== 0) fail("invalid_proposed_transition");
      break;
    case "authorized":
      exactKeys(plain(details, "invalid_authorized_details"), ["gate_code"], "invalid_authorized_detail_fields");
      if (derived.state !== EFFECT_STATES.PROPOSED || event.to_state !== EFFECT_STATES.AUTHORIZED || event.fence !== 0) fail("invalid_authorized_transition");
      if (details.gate_code !== "execution_gate_passed") fail("effect_authorization_gate_missing");
      break;
    case "claimed":
      exactKeys(plain(details, "invalid_claim_details"), ["approval_claim_id", "budget_reservation_id"], "invalid_claim_detail_fields");
      if (derived.state !== EFFECT_STATES.AUTHORIZED || event.to_state !== EFFECT_STATES.CLAIMED || event.fence <= derived.fence) fail("invalid_claim_transition");
      identifier(details.approval_claim_id, "invalid_approval_claim_id");
      identifier(details.budget_reservation_id, "invalid_budget_reservation_id");
      derived.approval_claim_id = details.approval_claim_id;
      derived.budget_reservation_id = details.budget_reservation_id;
      break;
    case "reclaimed":
      exactKeys(plain(details, "invalid_reclaim_details"), ["previous_lease_dead_proof_sha256"], "invalid_reclaim_detail_fields");
      if (derived.state !== EFFECT_STATES.CLAIMED || event.to_state !== EFFECT_STATES.CLAIMED || event.fence <= derived.fence) fail("invalid_reclaim_transition");
      if (derived.dispatch_ticket !== null || !isSha256(details.previous_lease_dead_proof_sha256)) fail("unsafe_effect_reclaim");
      break;
    case "dispatch_prepared":
      exactKeys(plain(details, "invalid_dispatch_details"), ["dispatch_ticket", "egress_request_sha256"], "invalid_dispatch_detail_fields");
      if (derived.state !== EFFECT_STATES.CLAIMED || event.to_state !== EFFECT_STATES.OUTCOME_UNKNOWN || event.fence !== derived.fence) fail("invalid_dispatch_transition");
      identifier(details.dispatch_ticket, "invalid_dispatch_ticket");
      if (details.egress_request_sha256 !== derived.contract.bindings.action_sha256) fail("egress_request_mismatch");
      derived.dispatch_ticket = details.dispatch_ticket;
      break;
    case "egress_started":
      exactKeys(plain(details, "invalid_egress_details"), ["dispatch_ticket", "egress_request_sha256"], "invalid_egress_detail_fields");
      if (derived.state !== EFFECT_STATES.OUTCOME_UNKNOWN || event.to_state !== EFFECT_STATES.OUTCOME_UNKNOWN || event.fence !== derived.fence) fail("invalid_egress_event");
      if (derived.egress_started || details.dispatch_ticket !== derived.dispatch_ticket) fail("dispatch_ticket_replay");
      if (details.egress_request_sha256 !== derived.contract.bindings.action_sha256) fail("egress_request_mismatch");
      derived.egress_started = true;
      break;
    case "evidence_added": {
      exactKeys(plain(details, "invalid_evidence_details"), ["evidence"], "invalid_evidence_detail_fields");
      if (![EFFECT_STATES.OUTCOME_UNKNOWN, ...VERIFIED, EFFECT_STATES.OUTCOME_DISPUTED].includes(derived.state) || event.to_state !== derived.state) fail("invalid_evidence_state");
      const evidence = normalizeEvidence(details.evidence);
      if (!validEvidenceForContract(evidence, derived.contract)) fail("evidence_binding_mismatch");
      if (Date.parse(evidence.observed_at) > Date.parse(event.at)) fail("evidence_from_future");
      if (derived.evidence.has(evidence.evidence_id)) fail("duplicate_evidence_id");
      const existingDigest = derived.evidence_digests.get(evidence.evidence_id);
      if (existingDigest && existingDigest !== evidence.evidence_sha256) fail("conflicting_evidence_id");
      if (evidence.provider_transaction_id !== null) {
        const transactionDigest = derived.provider_transactions.get(evidence.provider_transaction_id);
        if (transactionDigest && transactionDigest !== evidence.evidence_sha256) fail("conflicting_provider_transaction");
        derived.provider_transactions.set(evidence.provider_transaction_id, evidence.evidence_sha256);
      }
      derived.evidence.set(evidence.evidence_id, evidence);
      derived.evidence_digests.set(evidence.evidence_id, evidence.evidence_sha256);
      break;
    }
    case "outcome_verified": {
      exactKeys(plain(details, "invalid_verification_details"), ["evidence_ids"], "invalid_verification_detail_fields");
      if (derived.state !== EFFECT_STATES.OUTCOME_UNKNOWN || !VERIFIED.has(event.to_state)) fail("invalid_verified_transition");
      const evidence = evidenceByIds(derived, details.evidence_ids, "verification");
      assertVerifiedEvidence(evidence, event.to_state, derived.contract);
      break;
    }
    case "outcome_disputed":
      exactKeys(plain(details, "invalid_dispute_details"), ["evidence_ids"], "invalid_dispute_detail_fields");
      if (![EFFECT_STATES.OUTCOME_UNKNOWN, ...VERIFIED].includes(derived.state) || event.to_state !== EFFECT_STATES.OUTCOME_DISPUTED) fail("invalid_disputed_transition");
      evidenceByIds(derived, details.evidence_ids, "dispute");
      break;
    case "aborted_pre_dispatch":
      exactKeys(plain(details, "invalid_abort_details"), ["reason"], "invalid_abort_detail_fields");
      if (!PRE_DISPATCH.has(derived.state) || event.to_state !== EFFECT_STATES.ABORTED_PRE_DISPATCH) fail("invalid_abort_transition");
      enumeration(details.reason, ABORT_REASONS, "invalid_abort_reason");
      break;
    case "cancel_requested":
      exactKeys(plain(details, "invalid_cancel_details"), [], "invalid_cancel_detail_fields");
      if (PRE_DISPATCH.has(derived.state) || derived.state === EFFECT_STATES.ABORTED_PRE_DISPATCH || event.to_state !== derived.state) fail("invalid_cancel_request_event");
      derived.cancel_requested = true;
      break;
    case "compensation_linked":
      exactKeys(plain(details, "invalid_compensation_details"), ["compensation_effect_key", "undo_verification_sha256"], "invalid_compensation_detail_fields");
      if (![EFFECT_STATES.VERIFIED_SUCCEEDED, EFFECT_STATES.VERIFIED_PARTIAL, EFFECT_STATES.OUTCOME_DISPUTED].includes(derived.state) || event.to_state !== derived.state) fail("invalid_compensation_link");
      identifier(details.compensation_effect_key, "invalid_compensation_effect_key");
      digest(details.undo_verification_sha256, "invalid_undo_verification");
      if (derived.compensation_effect_keys.has(details.compensation_effect_key)) fail("duplicate_compensation_link");
      derived.compensation_effect_keys.add(details.compensation_effect_key);
      break;
    default:
      fail("unsupported_effect_event_type");
  }

  derived.state = event.to_state;
  derived.fence = event.fence;
  derived.last_at = event.at;
}

function validEvidenceForContract(evidence, contract) {
  return evidence.principal_namespace === contract.principal.principal_namespace
    && evidence.provider_account_id === contract.principal.provider_account_id
    && evidence.audience === contract.action.required_capability?.audience
    && evidence.request_sha256 === contract.bindings.action_sha256
    && evidence.verifier_id === contract.verifier.verifier_id
    && evidence.read_only === contract.verifier.read_only;
}

function verificationTarget(semanticResult) {
  switch (semanticResult) {
    case "succeeded": return EFFECT_STATES.VERIFIED_SUCCEEDED;
    case "no_effect": return EFFECT_STATES.VERIFIED_NO_EFFECT;
    case "partial": return EFFECT_STATES.VERIFIED_PARTIAL;
    default: return null;
  }
}

function evidenceByIds(derived, evidenceIds, purpose) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || new Set(evidenceIds).size !== evidenceIds.length) {
    fail(`invalid_${purpose}_evidence_ids`);
  }
  return evidenceIds.map((id) => {
    const normalizedId = identifier(id, "invalid_evidence_id");
    const evidence = derived.evidence.get(normalizedId);
    if (!evidence) fail(`${purpose}_evidence_not_found`);
    if (!validEvidenceForContract(evidence, derived.contract)) fail("evidence_binding_mismatch");
    return evidence;
  });
}

function assertVerifiedEvidence(evidence, target, contract) {
  const results = new Set(evidence.map((entry) => entry.semantic_result));
  if (results.has("conflict") || results.size !== 1) fail("conflicting_verification_evidence");
  const semanticResult = [...results][0];
  if (verificationTarget(semanticResult) !== target) fail("verification_result_mismatch");
  const independentRead = evidence.some((entry) => entry.kind === "reconciliation_read" && entry.read_only && entry.independent);
  if (!independentRead) fail("independent_semantic_verification_required");
  if (["succeeded", "partial"].includes(semanticResult)) {
    const authenticReceipt = evidence.some((entry) => ["provider_receipt", "provider_callback"].includes(entry.kind) && entry.signature_verified);
    if (!authenticReceipt) fail("authentic_provider_receipt_required");
  }
  if (!contract.verifier.checks.includes("functional_postconditions") || !contract.verifier.checks.includes("safety_invariants")) {
    fail("contract_verifier_checks_incomplete");
  }
}

export class EffectLedgerReference {
  constructor(compiledMoment, events = []) {
    const compiled = validateCompiledMoment(compiledMoment);
    this.compiled = compiled;
    this.context = expectedContext(compiled.contract);
    this.context.contract_sha256 = compiled.sha256;
    this._events = [];
    this.derived = emptyDerivedState(compiled.contract);

    if (!Array.isArray(events)) fail("invalid_effect_event_log");
    for (let index = 0; index < events.length; index += 1) {
      const normalized = normalizeStoredEvent(events[index], this.context, this._events.at(-1), index + 1);
      if (this._events.some((entry) => entry.event_id === normalized.event_id)) fail("duplicate_effect_event_id");
      applyEvent(this.derived, normalized);
      this._events.push(deepFreeze(structuredClone(normalized)));
    }
  }

  get state() {
    return this.derived.state;
  }

  get fence() {
    return this.derived.fence;
  }

  get effectKey() {
    return `${this.context.principal_namespace}:${this.context.effect_id}`;
  }

  events() {
    return structuredClone(this._events);
  }

  append(eventType, toState, at, fence, details, eventId = randomUUID()) {
    const event = {
      schema: EFFECT_EVENT_SCHEMA,
      sequence: this._events.length + 1,
      event_id: identifier(eventId, "invalid_effect_event_id"),
      event_type: eventType,
      principal_namespace: this.context.principal_namespace,
      effect_id: this.context.effect_id,
      contract_sha256: this.context.contract_sha256,
      idempotency_key: this.context.idempotency_key,
      from_state: this.derived.state,
      to_state: toState,
      at: timestamp(at, "invalid_effect_event_timestamp"),
      fence: integer(fence, "invalid_effect_fence"),
      details: json(details, "invalid_effect_event_details"),
      previous_event_sha256: this._events.at(-1)?.event_sha256 ?? null,
    };
    if (this._events.some((entry) => entry.event_id === event.event_id)) fail("duplicate_effect_event_id");
    event.event_sha256 = canonicalSha256(event);
    const normalized = normalizeStoredEvent(event, this.context, this._events.at(-1), event.sequence);
    applyEvent(this.derived, normalized);
    this._events.push(deepFreeze(structuredClone(normalized)));
    return structuredClone(normalized);
  }

  propose(metadata) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("proposed", EFFECT_STATES.PROPOSED, at, 0, {}, event_id);
  }

  authorize(liveContext, metadata) {
    const { event_id, at } = normalizeMetadata(metadata);
    const gate = evaluateExecutionGate(this.compiled, liveContext);
    if (gate.decision !== "allow") fail(`execution_gate_${gate.decision}:${gate.code}`);
    return this.append("authorized", EFFECT_STATES.AUTHORIZED, at, 0, { gate_code: gate.code }, event_id);
  }

  claim({ fencing_token, approval_claim_id, budget_reservation_id, ...metadata }) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("claimed", EFFECT_STATES.CLAIMED, at, integer(fencing_token, "invalid_claim_fence", 1), {
      approval_claim_id: identifier(approval_claim_id, "invalid_approval_claim_id"),
      budget_reservation_id: identifier(budget_reservation_id, "invalid_budget_reservation_id"),
    }, event_id);
  }

  reclaim({ fencing_token, previous_lease_dead_proof_sha256, ...metadata }) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("reclaimed", EFFECT_STATES.CLAIMED, at, integer(fencing_token, "invalid_reclaim_fence", 1), {
      previous_lease_dead_proof_sha256: digest(previous_lease_dead_proof_sha256, "invalid_previous_lease_proof"),
    }, event_id);
  }

  prepareDispatch({ fencing_token, dispatch_ticket, egress_request_sha256, ...metadata }) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("dispatch_prepared", EFFECT_STATES.OUTCOME_UNKNOWN, at, integer(fencing_token, "invalid_dispatch_fence", 1), {
      dispatch_ticket: identifier(dispatch_ticket, "invalid_dispatch_ticket"),
      egress_request_sha256: digest(egress_request_sha256, "invalid_egress_request"),
    }, event_id);
  }

  startEgress({ fencing_token, dispatch_ticket, egress_request_sha256, ...metadata }) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("egress_started", EFFECT_STATES.OUTCOME_UNKNOWN, at, integer(fencing_token, "invalid_egress_fence", 1), {
      dispatch_ticket: identifier(dispatch_ticket, "invalid_dispatch_ticket"),
      egress_request_sha256: digest(egress_request_sha256, "invalid_egress_request"),
    }, event_id);
  }

  addEvidence(evidenceValue, metadata) {
    const { event_id, at } = normalizeMetadata(metadata);
    const evidence = normalizeEvidence(evidenceValue);
    if (!validEvidenceForContract(evidence, this.compiled.contract)) fail("evidence_binding_mismatch");
    return this.append("evidence_added", this.state, at, this.fence, { evidence }, event_id);
  }

  verifyOutcome(evidenceIds, metadata) {
    const { event_id, at } = normalizeMetadata(metadata);
    if (!Array.isArray(evidenceIds) || evidenceIds.length < 1 || new Set(evidenceIds).size !== evidenceIds.length) fail("invalid_verification_evidence_ids");
    const evidence = evidenceIds.map((id) => {
      const normalizedId = identifier(id, "invalid_evidence_id");
      const found = this.derived.evidence.get(normalizedId);
      if (!found) fail("verification_evidence_not_found");
      return found;
    });
    if (evidence.some((entry) => !validEvidenceForContract(entry, this.compiled.contract))) fail("evidence_binding_mismatch");
    const results = new Set(evidence.map((entry) => entry.semantic_result));
    if (results.has("conflict") || results.size !== 1) return this.disputeOutcome(evidenceIds, metadata);
    const semanticResult = [...results][0];
    const target = verificationTarget(semanticResult);
    if (!target) fail("outcome_still_unknown");

    const independentRead = evidence.some((entry) => entry.kind === "reconciliation_read" && entry.read_only && entry.independent);
    if (!independentRead) fail("independent_semantic_verification_required");
    if (["succeeded", "partial"].includes(semanticResult)) {
      const authenticReceipt = evidence.some((entry) => ["provider_receipt", "provider_callback"].includes(entry.kind) && entry.signature_verified);
      if (!authenticReceipt) fail("authentic_provider_receipt_required");
    }
    return this.append("outcome_verified", target, at, this.fence, { evidence_ids: [...evidenceIds].sort() }, event_id);
  }

  disputeOutcome(evidenceIds, metadata) {
    const { event_id, at } = normalizeMetadata(metadata);
    if (!Array.isArray(evidenceIds) || evidenceIds.length < 1) fail("invalid_dispute_evidence_ids");
    for (const id of evidenceIds) if (!this.derived.evidence.has(identifier(id, "invalid_evidence_id"))) fail("dispute_evidence_not_found");
    return this.append("outcome_disputed", EFFECT_STATES.OUTCOME_DISPUTED, at, this.fence, { evidence_ids: [...new Set(evidenceIds)].sort() }, event_id);
  }

  abortPreDispatch(reason, metadata) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("aborted_pre_dispatch", EFFECT_STATES.ABORTED_PRE_DISPATCH, at, this.fence, {
      reason: enumeration(reason, ABORT_REASONS, "invalid_abort_reason"),
    }, event_id);
  }

  requestCancel(metadata) {
    const normalized = normalizeMetadata(metadata);
    if (PRE_DISPATCH.has(this.state)) return this.abortPreDispatch("cancelled", normalized);
    return this.append("cancel_requested", this.state, normalized.at, this.fence, {}, normalized.event_id);
  }

  linkCompensation({ compensation_effect_key, undo_verification_sha256, ...metadata }) {
    const { event_id, at } = normalizeMetadata(metadata);
    return this.append("compensation_linked", this.state, at, this.fence, {
      compensation_effect_key: identifier(compensation_effect_key, "invalid_compensation_effect_key"),
      undo_verification_sha256: digest(undo_verification_sha256, "invalid_undo_verification"),
    }, event_id);
  }
}

export class EffectLedgerRegistryReference {
  constructor() {
    this.ledgers = new Map();
  }

  create(compiledMoment, events = []) {
    const ledger = new EffectLedgerReference(compiledMoment, events);
    const existing = this.ledgers.get(ledger.effectKey);
    if (existing) {
      if (existing.compiled.sha256 !== ledger.compiled.sha256) fail("effect_key_contract_conflict");
      fail("duplicate_effect_key");
    }
    this.ledgers.set(ledger.effectKey, ledger);
    return ledger;
  }

  get(effectKey) {
    return this.ledgers.get(effectKey) ?? null;
  }
}
