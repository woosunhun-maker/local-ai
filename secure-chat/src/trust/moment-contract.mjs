import {
  canonicalSha256,
  canonicalizeJson,
  deepFreeze,
  isSha256,
} from "../growth/canonical.mjs";

export const MOMENT_SCHEMA = "local-ai.moment-contract.v0.1";
export const CANONICALIZATION_VERSION = "local-ai.canonical-json.v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL = /^[a-z][a-z0-9._-]{0,63}$/;
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/u;

export class MomentContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "MomentContractError";
    this.code = code;
  }
}

function fail(code) {
  throw new MomentContractError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
}

function text(value, code, maximum = 256) {
  if (typeof value !== "string") fail(code);
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) fail(code);
  return normalized;
}

function identifier(value, code) {
  const normalized = text(value, code, 128);
  if (!ID.test(normalized)) fail(code);
  return normalized;
}

function label(value, code) {
  const normalized = text(value, code, 64).toLowerCase();
  if (!LABEL.test(normalized)) fail(code);
  return normalized;
}

function enumeration(value, allowed, code) {
  if (!allowed.has(value)) fail(code);
  return value;
}

function boolean(value, code) {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function integer(value, code, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function timestamp(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return value;
}

function digest(value, code, nullable = false) {
  if (nullable && value === null) return null;
  if (!isSha256(value)) fail(code);
  return value;
}

function nullableIdentifier(value, code) {
  return value === null ? null : identifier(value, code);
}

function uniqueSorted(values, normalizer, code, maximum = 64) {
  if (!Array.isArray(values) || values.length > maximum) fail(code);
  const result = values.map((entry) => normalizer(entry, code));
  if (new Set(result).size !== result.length) fail(code);
  return result.sort();
}

function jsonValue(value, code) {
  try {
    return JSON.parse(canonicalizeJson(value));
  } catch {
    fail(code);
  }
}

function normalizeActor(value) {
  const input = plain(value, "invalid_actor");
  exactKeys(input, ["actor_id", "authentication_context", "authentication_evidence_sha256"], "invalid_actor_fields");
  return {
    actor_id: identifier(input.actor_id, "invalid_actor_id"),
    authentication_context: label(input.authentication_context, "invalid_authentication_context"),
    authentication_evidence_sha256: digest(input.authentication_evidence_sha256, "invalid_authentication_evidence"),
  };
}

function normalizePrincipal(value) {
  const input = plain(value, "invalid_principal");
  exactKeys(input, [
    "principal_id", "principal_namespace", "provider_account_id", "tenant_id", "resource_owner",
    "data_subjects", "affected_parties", "co_principal_required",
  ], "invalid_principal_fields");
  return {
    principal_id: identifier(input.principal_id, "invalid_principal_id"),
    principal_namespace: identifier(input.principal_namespace, "invalid_principal_namespace"),
    provider_account_id: identifier(input.provider_account_id, "invalid_provider_account_id"),
    tenant_id: nullableIdentifier(input.tenant_id, "invalid_tenant_id"),
    resource_owner: identifier(input.resource_owner, "invalid_resource_owner"),
    data_subjects: uniqueSorted(input.data_subjects, identifier, "invalid_data_subjects", 32),
    affected_parties: uniqueSorted(input.affected_parties, identifier, "invalid_affected_parties", 32),
    co_principal_required: boolean(input.co_principal_required, "invalid_co_principal_required"),
  };
}

function normalizeIntent(value) {
  const input = plain(value, "invalid_intent");
  exactKeys(input, ["intent_id", "version", "source_provenance"], "invalid_intent_fields");
  return {
    intent_id: identifier(input.intent_id, "invalid_intent_id"),
    version: integer(input.version, "invalid_intent_version", 1, 1_000_000),
    source_provenance: uniqueSorted(input.source_provenance, identifier, "invalid_source_provenance", 64),
  };
}

function normalizePlan(value) {
  const input = plain(value, "invalid_plan");
  exactKeys(input, ["plan_sha256", "effect_index", "depends_on"], "invalid_plan_fields");
  return {
    plan_sha256: digest(input.plan_sha256, "invalid_plan_digest"),
    effect_index: integer(input.effect_index, "invalid_effect_index", 0, 10_000),
    depends_on: uniqueSorted(input.depends_on, identifier, "invalid_effect_dependencies", 64),
  };
}

function normalizeRequiredCapability(value) {
  if (value === null) return null;
  const input = plain(value, "invalid_required_capability");
  exactKeys(input, [
    "audience", "resource", "operation", "provider_account_id", "data_labels", "money_minor",
  ], "invalid_required_capability_fields");
  return {
    audience: identifier(input.audience, "invalid_required_capability_audience"),
    resource: identifier(input.resource, "invalid_required_capability_resource"),
    operation: label(input.operation, "invalid_required_capability_operation"),
    provider_account_id: identifier(input.provider_account_id, "invalid_required_capability_account"),
    data_labels: uniqueSorted(input.data_labels, label, "invalid_required_capability_labels", 32),
    money_minor: integer(input.money_minor, "invalid_required_capability_money", 0, 1_000_000_000_000),
  };
}

function normalizeAction(value) {
  const input = plain(value, "invalid_action");
  exactKeys(input, ["kind", "effect_class", "executor_id", "parameters", "required_capability"], "invalid_action_fields");
  const effectClass = enumeration(input.effect_class, new Set(["none", "public_read", "private_read", "reversible_write", "irreversible_write"]), "invalid_effect_class");
  const requiredCapability = normalizeRequiredCapability(input.required_capability);
  if (effectClass === "none" && requiredCapability !== null) fail("unexpected_required_capability");
  if (effectClass !== "none" && requiredCapability === null) fail("required_capability_missing");
  return {
    kind: label(input.kind, "invalid_action_kind"),
    effect_class: effectClass,
    executor_id: identifier(input.executor_id, "invalid_executor_id"),
    parameters: jsonValue(input.parameters, "invalid_action_parameters"),
    required_capability: requiredCapability,
  };
}

function normalizePrecondition(value) {
  const input = plain(value, "invalid_precondition");
  exactKeys(input, ["path", "comparator", "expected"], "invalid_precondition_fields");
  const path = text(input.path, "invalid_precondition_path", 256);
  if (!JSON_POINTER.test(path)) fail("invalid_precondition_path");
  const comparator = enumeration(input.comparator, new Set(["exact", "maximum", "minimum", "set_equals", "sha256_equals"]), "invalid_precondition_comparator");
  const expected = jsonValue(input.expected, "invalid_precondition_expected");
  if (["maximum", "minimum"].includes(comparator) && (typeof expected !== "number" || !Number.isFinite(expected))) {
    fail("invalid_numeric_precondition");
  }
  if (comparator === "set_equals" && !Array.isArray(expected)) fail("invalid_set_precondition");
  if (comparator === "sha256_equals" && !isSha256(expected)) fail("invalid_hash_precondition");
  return { path, comparator, expected };
}

function normalizePreconditions(value) {
  if (!Array.isArray(value) || value.length > 64) fail("invalid_preconditions");
  const result = value.map(normalizePrecondition).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(result.map((entry) => entry.path)).size !== result.length) fail("duplicate_precondition_path");
  return result;
}

function normalizeAuthorization(value, effectClass, policyDecision) {
  const input = plain(value, "invalid_authorization");
  exactKeys(input, [
    "mode", "grant_id", "nonce", "issued_at", "not_before", "expires_at", "max_lifetime_ms", "max_uses", "revocation_epoch",
  ], "invalid_authorization_fields");
  const mode = enumeration(input.mode, new Set(["none", "policy", "user_approval"]), "invalid_authorization_mode");
  const normalized = {
    mode,
    grant_id: nullableIdentifier(input.grant_id, "invalid_authorization_grant_id"),
    nonce: nullableIdentifier(input.nonce, "invalid_authorization_nonce"),
    issued_at: timestamp(input.issued_at, "invalid_authorization_issued_at", true),
    not_before: timestamp(input.not_before, "invalid_authorization_not_before", true),
    expires_at: timestamp(input.expires_at, "invalid_authorization_expires_at", true),
    max_lifetime_ms: integer(input.max_lifetime_ms, "invalid_authorization_max_lifetime", 0, 30 * 24 * 60 * 60_000),
    max_uses: integer(input.max_uses, "invalid_authorization_max_uses", 0, 1_000_000),
    revocation_epoch: integer(input.revocation_epoch, "invalid_revocation_epoch", 0, 1_000_000_000),
  };
  if (mode === "none") {
    if (effectClass !== "none" || policyDecision !== "allow") fail("authorization_required");
    if ([normalized.grant_id, normalized.nonce, normalized.issued_at, normalized.not_before, normalized.expires_at].some((entry) => entry !== null) || normalized.max_lifetime_ms !== 0 || normalized.max_uses !== 0) {
      fail("invalid_none_authorization");
    }
  } else {
    if ([normalized.grant_id, normalized.nonce, normalized.issued_at, normalized.not_before, normalized.expires_at].some((entry) => entry === null)) {
      fail("incomplete_authorization");
    }
    if (normalized.max_uses < 1) fail("invalid_authorization_max_uses");
    const issued = Date.parse(normalized.issued_at);
    const notBefore = Date.parse(normalized.not_before);
    const expires = Date.parse(normalized.expires_at);
    if (notBefore < issued || expires <= notBefore || expires - issued > normalized.max_lifetime_ms) fail("invalid_authorization_window");
  }
  if (policyDecision === "require_approval" && mode !== "user_approval") fail("user_approval_required");
  if (policyDecision === "block") fail("blocked_contract_cannot_compile");
  return normalized;
}

function normalizeCapability(value) {
  const input = plain(value, "invalid_capability");
  exactKeys(input, [
    "capability_id", "issuer", "subject", "audience", "resource", "operations", "provider_account_id",
    "data_labels", "max_money_minor", "max_uses", "not_before", "expires_at", "revocation_epoch",
    "delegation_parent", "proof_sha256",
  ], "invalid_capability_fields");
  const notBefore = timestamp(input.not_before, "invalid_capability_not_before");
  const expiresAt = timestamp(input.expires_at, "invalid_capability_expires_at");
  if (Date.parse(expiresAt) <= Date.parse(notBefore) || Date.parse(expiresAt) - Date.parse(notBefore) > 30 * 24 * 60 * 60_000) {
    fail("invalid_capability_window");
  }
  return {
    capability_id: identifier(input.capability_id, "invalid_capability_id"),
    issuer: identifier(input.issuer, "invalid_capability_issuer"),
    subject: identifier(input.subject, "invalid_capability_subject"),
    audience: identifier(input.audience, "invalid_capability_audience"),
    resource: identifier(input.resource, "invalid_capability_resource"),
    operations: uniqueSorted(input.operations, label, "invalid_capability_operations", 32),
    provider_account_id: identifier(input.provider_account_id, "invalid_capability_provider_account"),
    data_labels: uniqueSorted(input.data_labels, label, "invalid_capability_data_labels", 32),
    max_money_minor: integer(input.max_money_minor, "invalid_capability_max_money", 0, 1_000_000_000_000),
    max_uses: integer(input.max_uses, "invalid_capability_max_uses", 1, 1_000_000),
    not_before: notBefore,
    expires_at: expiresAt,
    revocation_epoch: integer(input.revocation_epoch, "invalid_capability_revocation_epoch", 0, 1_000_000_000),
    delegation_parent: nullableIdentifier(input.delegation_parent, "invalid_delegation_parent"),
    proof_sha256: digest(input.proof_sha256, "invalid_capability_proof"),
  };
}

function normalizeCapabilities(value, action, principal) {
  if (!Array.isArray(value) || value.length > 32) fail("invalid_capabilities");
  const result = value.map(normalizeCapability).sort((left, right) => left.capability_id.localeCompare(right.capability_id));
  if (new Set(result.map((entry) => entry.capability_id)).size !== result.length) fail("duplicate_capability_id");
  for (const capability of result) {
    if (capability.subject !== action.executor_id) fail("capability_subject_mismatch");
    if (capability.delegation_parent !== null) fail("capability_delegation_not_supported_v0_1");
  }
  if (action.effect_class !== "none" && result.length === 0) fail("capability_missing");
  if (action.required_capability?.provider_account_id !== principal.provider_account_id) fail("required_capability_account_mismatch");
  return result;
}

function normalizePolicy(value) {
  const input = plain(value, "invalid_policy");
  exactKeys(input, ["version", "tcb_manifest_sha256", "risk_tier", "decision"], "invalid_policy_fields");
  return {
    version: identifier(input.version, "invalid_policy_version"),
    tcb_manifest_sha256: digest(input.tcb_manifest_sha256, "invalid_tcb_manifest"),
    risk_tier: enumeration(input.risk_tier, new Set(["low", "medium", "high", "critical"]), "invalid_risk_tier"),
    decision: enumeration(input.decision, new Set(["allow", "require_approval", "block"]), "invalid_policy_decision"),
  };
}

function normalizeDisclosure(value) {
  const input = plain(value, "invalid_disclosure");
  exactKeys(input, ["recipient", "purpose", "sensitivity", "data_labels", "retention_expires_at", "max_bytes"], "invalid_disclosure_fields");
  return {
    recipient: identifier(input.recipient, "invalid_disclosure_recipient"),
    purpose: label(input.purpose, "invalid_disclosure_purpose"),
    sensitivity: enumeration(input.sensitivity, new Set(["public", "internal", "confidential", "restricted"]), "invalid_disclosure_sensitivity"),
    data_labels: uniqueSorted(input.data_labels, label, "invalid_disclosure_labels", 64),
    retention_expires_at: timestamp(input.retention_expires_at, "invalid_disclosure_retention", true),
    max_bytes: integer(input.max_bytes, "invalid_disclosure_max_bytes", 0, 100_000_000),
  };
}

function normalizeBudgets(value) {
  const input = plain(value, "invalid_budgets");
  exactKeys(input, ["money_minor", "currency", "privacy_bytes", "attention_seconds", "notifications", "network_requests"], "invalid_budget_fields");
  return {
    money_minor: integer(input.money_minor, "invalid_money_budget", 0, 1_000_000_000_000),
    currency: enumeration(input.currency, new Set(["KRW", "USD", "NONE"]), "invalid_budget_currency"),
    privacy_bytes: integer(input.privacy_bytes, "invalid_privacy_budget", 0, 100_000_000),
    attention_seconds: integer(input.attention_seconds, "invalid_attention_budget", 0, 86_400),
    notifications: integer(input.notifications, "invalid_notification_budget", 0, 10_000),
    network_requests: integer(input.network_requests, "invalid_network_budget", 0, 1_000_000),
  };
}

function normalizeEffect(value) {
  const input = plain(value, "invalid_effect");
  exactKeys(input, ["effect_id", "rollback_kind", "provider_supports_idempotency"], "invalid_effect_fields");
  return {
    effect_id: identifier(input.effect_id, "invalid_effect_id"),
    rollback_kind: enumeration(input.rollback_kind, new Set(["none", "reversible", "compensating", "manual_only"]), "invalid_rollback_kind"),
    provider_supports_idempotency: boolean(input.provider_supports_idempotency, "invalid_provider_idempotency"),
  };
}

function normalizeVerifier(value, effectClass) {
  const input = plain(value, "invalid_verifier");
  exactKeys(input, ["verifier_id", "principal_id", "read_only", "checks", "timeout_ms"], "invalid_verifier_fields");
  const checks = uniqueSorted(input.checks, label, "invalid_verifier_checks", 16);
  const required = effectClass.endsWith("write")
    ? ["functional_postconditions", "receipt_authenticity", "safety_invariants"]
    : effectClass === "none" ? [] : ["functional_postconditions", "safety_invariants"];
  if (required.some((entry) => !checks.includes(entry))) fail("verifier_checks_incomplete");
  const readOnly = boolean(input.read_only, "invalid_verifier_read_only");
  if (effectClass !== "none" && !readOnly) fail("verifier_must_be_read_only");
  return {
    verifier_id: identifier(input.verifier_id, "invalid_verifier_id"),
    principal_id: identifier(input.principal_id, "invalid_verifier_principal"),
    read_only: readOnly,
    checks,
    timeout_ms: integer(input.timeout_ms, "invalid_verifier_timeout", 1, 300_000),
  };
}

function normalizeProvenance(value) {
  const input = plain(value, "invalid_provenance");
  exactKeys(input, ["dag_root_sha256"], "invalid_provenance_fields");
  return { dag_root_sha256: digest(input.dag_root_sha256, "invalid_provenance_root") };
}

function normalizePresentation(value, policy) {
  const input = plain(value, "invalid_presentation");
  exactKeys(input, [
    "channel", "bystander_exposure", "plain_language", "consequences", "no_action_result", "rollback", "uncertainty", "choices", "comprehension_gate",
  ], "invalid_presentation_fields");
  const choices = uniqueSorted(input.choices, label, "invalid_presentation_choices", 12);
  if (policy.decision === "require_approval" && (!choices.includes("approve") || !choices.includes("reject"))) {
    fail("approval_choices_missing");
  }
  const comprehensionGate = enumeration(input.comprehension_gate, new Set(["not_required", "predict_effect"]), "invalid_comprehension_gate");
  if (["high", "critical"].includes(policy.risk_tier) && comprehensionGate !== "predict_effect") fail("comprehension_gate_required");
  return {
    channel: label(input.channel, "invalid_presentation_channel"),
    bystander_exposure: enumeration(input.bystander_exposure, new Set(["none", "possible", "likely"]), "invalid_bystander_exposure"),
    plain_language: text(input.plain_language, "invalid_plain_language", 500),
    consequences: text(input.consequences, "invalid_consequences", 500),
    no_action_result: text(input.no_action_result, "invalid_no_action_result", 300),
    rollback: text(input.rollback, "invalid_rollback_presentation", 300),
    uncertainty: text(input.uncertainty, "invalid_uncertainty", 300),
    choices,
    comprehension_gate: comprehensionGate,
  };
}

function normalizeMemory(value) {
  const input = plain(value, "invalid_memory_policy");
  exactKeys(input, ["namespace", "read_scopes", "write_mode", "scope", "purpose", "consent_ref", "retention_expires_at"], "invalid_memory_policy_fields");
  const writeMode = enumeration(input.write_mode, new Set(["none", "candidate_only"]), "invalid_memory_write_mode");
  const consentRef = digest(input.consent_ref, "invalid_memory_consent_ref", true);
  if (writeMode === "candidate_only" && consentRef === null) fail("memory_candidate_consent_required");
  return {
    namespace: identifier(input.namespace, "invalid_memory_namespace"),
    read_scopes: uniqueSorted(input.read_scopes, label, "invalid_memory_read_scopes", 32),
    write_mode: writeMode,
    scope: label(input.scope, "invalid_memory_scope"),
    purpose: label(input.purpose, "invalid_memory_purpose"),
    consent_ref: consentRef,
    retention_expires_at: timestamp(input.retention_expires_at, "invalid_memory_retention", true),
  };
}

function approvalBasis(contract) {
  return {
    schema: contract.schema,
    canonicalization_version: contract.canonicalization_version,
    moment_id: contract.moment_id,
    actor: contract.actor,
    principal: contract.principal,
    intent: contract.intent,
    plan: contract.plan,
    action: contract.action,
    preconditions: contract.preconditions,
    authorization: {
      mode: contract.authorization.mode,
      grant_id: contract.authorization.grant_id,
      nonce: contract.authorization.nonce,
      issued_at: contract.authorization.issued_at,
      not_before: contract.authorization.not_before,
      expires_at: contract.authorization.expires_at,
      max_lifetime_ms: contract.authorization.max_lifetime_ms,
      max_uses: contract.authorization.max_uses,
      revocation_epoch: contract.authorization.revocation_epoch,
    },
    capabilities: contract.capabilities,
    policy: contract.policy,
    disclosure: contract.disclosure,
    budgets: contract.budgets,
    effect: {
      effect_id: contract.effect.effect_id,
      rollback_kind: contract.effect.rollback_kind,
      provider_supports_idempotency: contract.effect.provider_supports_idempotency,
    },
    verifier: contract.verifier,
    provenance: contract.provenance,
    presentation: contract.presentation,
    memory: contract.memory,
    created_at: contract.created_at,
  };
}

function deriveIdempotencyKey(contract, actionSha256) {
  return canonicalSha256({
    schema: "local-ai.effect-idempotency-key.v1",
    principal_namespace: contract.principal.principal_namespace,
    provider_account_id: contract.principal.provider_account_id,
    intent_id: contract.intent.intent_id,
    intent_version: contract.intent.version,
    effect_id: contract.effect.effect_id,
    action_sha256: actionSha256,
  });
}

function normalizeCandidate(value) {
  const input = plain(value, "invalid_moment_contract");
  exactKeys(input, [
    "schema", "canonicalization_version", "moment_id", "actor", "principal", "intent", "plan", "action", "preconditions",
    "authorization", "capabilities", "policy", "disclosure", "budgets", "effect", "verifier", "provenance", "presentation", "memory", "created_at",
  ], "invalid_moment_contract_fields");
  if (input.schema !== MOMENT_SCHEMA) fail("unsupported_moment_schema");
  if (input.canonicalization_version !== CANONICALIZATION_VERSION) fail("unsupported_canonicalization_version");
  const policy = normalizePolicy(input.policy);
  const principal = normalizePrincipal(input.principal);
  const action = normalizeAction(input.action);
  const authorization = normalizeAuthorization(input.authorization, action.effect_class, policy.decision);
  const capabilities = normalizeCapabilities(input.capabilities, action, principal);
  const disclosure = normalizeDisclosure(input.disclosure);
  const budgets = normalizeBudgets(input.budgets);
  if (budgets.privacy_bytes > disclosure.max_bytes) fail("privacy_budget_exceeds_disclosure");
  if (action.required_capability && action.required_capability.money_minor !== budgets.money_minor) fail("action_money_budget_mismatch");
  if (action.required_capability && canonicalizeJson(action.required_capability.data_labels) !== canonicalizeJson(disclosure.data_labels)) {
    fail("action_disclosure_labels_mismatch");
  }
  return {
    schema: MOMENT_SCHEMA,
    canonicalization_version: CANONICALIZATION_VERSION,
    moment_id: identifier(input.moment_id, "invalid_moment_id"),
    actor: normalizeActor(input.actor),
    principal,
    intent: normalizeIntent(input.intent),
    plan: normalizePlan(input.plan),
    action,
    preconditions: normalizePreconditions(input.preconditions),
    authorization,
    capabilities,
    policy,
    disclosure,
    budgets,
    effect: normalizeEffect(input.effect),
    verifier: normalizeVerifier(input.verifier, action.effect_class),
    provenance: normalizeProvenance(input.provenance),
    presentation: normalizePresentation(input.presentation, policy),
    memory: normalizeMemory(input.memory),
    created_at: timestamp(input.created_at, "invalid_moment_created_at"),
  };
}

export function compileMomentContract(candidate) {
  const normalized = normalizeCandidate(candidate);
  const actionSha256 = canonicalSha256(normalized.action);
  const preconditionsSha256 = canonicalSha256(normalized.preconditions);
  const capabilitiesSha256 = canonicalSha256(normalized.capabilities);
  const approvalBasisSha256 = canonicalSha256(approvalBasis(normalized));
  const contract = {
    ...normalized,
    authorization: { ...normalized.authorization, payload_sha256: approvalBasisSha256 },
    effect: { ...normalized.effect, idempotency_key: deriveIdempotencyKey(normalized, actionSha256) },
    bindings: {
      action_sha256: actionSha256,
      preconditions_sha256: preconditionsSha256,
      capabilities_sha256: capabilitiesSha256,
      approval_basis_sha256: approvalBasisSha256,
    },
  };
  const canonical = canonicalizeJson(contract);
  return deepFreeze({ contract: deepFreeze(contract), canonical, sha256: canonicalSha256(contract) });
}

function stripDerived(contract) {
  const input = plain(contract, "invalid_compiled_contract");
  exactKeys(input, [
    "schema", "canonicalization_version", "moment_id", "actor", "principal", "intent", "plan", "action", "preconditions",
    "authorization", "capabilities", "policy", "disclosure", "budgets", "effect", "verifier", "provenance", "presentation", "memory", "created_at", "bindings",
  ], "invalid_compiled_contract_fields");
  const authorization = plain(input.authorization, "invalid_authorization");
  const effect = plain(input.effect, "invalid_effect");
  exactKeys(authorization, [
    "mode", "grant_id", "nonce", "issued_at", "not_before", "expires_at", "max_lifetime_ms", "max_uses", "revocation_epoch", "payload_sha256",
  ], "invalid_compiled_authorization_fields");
  exactKeys(effect, ["effect_id", "rollback_kind", "provider_supports_idempotency", "idempotency_key"], "invalid_compiled_effect_fields");
  return {
    schema: input.schema,
    canonicalization_version: input.canonicalization_version,
    moment_id: input.moment_id,
    actor: input.actor,
    principal: input.principal,
    intent: input.intent,
    plan: input.plan,
    action: input.action,
    preconditions: input.preconditions,
    authorization: {
      mode: authorization.mode,
      grant_id: authorization.grant_id,
      nonce: authorization.nonce,
      issued_at: authorization.issued_at,
      not_before: authorization.not_before,
      expires_at: authorization.expires_at,
      max_lifetime_ms: authorization.max_lifetime_ms,
      max_uses: authorization.max_uses,
      revocation_epoch: authorization.revocation_epoch,
    },
    capabilities: input.capabilities,
    policy: input.policy,
    disclosure: input.disclosure,
    budgets: input.budgets,
    effect: {
      effect_id: effect.effect_id,
      rollback_kind: effect.rollback_kind,
      provider_supports_idempotency: effect.provider_supports_idempotency,
    },
    verifier: input.verifier,
    provenance: input.provenance,
    presentation: input.presentation,
    memory: input.memory,
    created_at: input.created_at,
  };
}

export function validateCompiledMoment(value) {
  const input = plain(value, "invalid_compiled_moment");
  exactKeys(input, ["contract", "canonical", "sha256"], "invalid_compiled_moment_fields");
  if (typeof input.canonical !== "string" || !isSha256(input.sha256)) fail("invalid_compiled_moment_binding");
  const recompiled = compileMomentContract(stripDerived(input.contract));
  if (recompiled.canonical !== input.canonical || recompiled.sha256 !== input.sha256) fail("compiled_moment_tampered");
  if (input.contract.authorization.payload_sha256 !== recompiled.contract.authorization.payload_sha256) fail("approval_payload_mismatch");
  if (input.contract.effect.idempotency_key !== recompiled.contract.effect.idempotency_key) fail("idempotency_key_mismatch");
  const bindings = plain(input.contract.bindings, "invalid_contract_bindings");
  exactKeys(bindings, ["action_sha256", "preconditions_sha256", "capabilities_sha256", "approval_basis_sha256"], "invalid_contract_binding_fields");
  if (canonicalizeJson(bindings) !== canonicalizeJson(recompiled.contract.bindings)) fail("contract_bindings_mismatch");
  return recompiled;
}

function compareSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const normalize = (value) => value.map((entry) => canonicalizeJson(entry)).sort();
  return canonicalizeJson(normalize(left)) === canonicalizeJson(normalize(right));
}

function preconditionMatches(precondition, actual) {
  switch (precondition.comparator) {
    case "exact": return canonicalizeJson(actual) === canonicalizeJson(precondition.expected);
    case "maximum": return typeof actual === "number" && Number.isFinite(actual) && actual <= precondition.expected;
    case "minimum": return typeof actual === "number" && Number.isFinite(actual) && actual >= precondition.expected;
    case "set_equals": return compareSet(actual, precondition.expected);
    case "sha256_equals": return canonicalSha256(actual) === precondition.expected;
    default: return false;
  }
}

function capabilityCovers(capability, required, contract, live, now) {
  if (!live.verified_capability_ids.includes(capability.capability_id)) return false;
  if (capability.subject !== contract.action.executor_id) return false;
  if (capability.audience !== required.audience || capability.resource !== required.resource) return false;
  if (!capability.operations.includes(required.operation)) return false;
  if (capability.provider_account_id !== required.provider_account_id) return false;
  if (required.data_labels.some((entry) => !capability.data_labels.includes(entry))) return false;
  if (required.money_minor > capability.max_money_minor) return false;
  if (capability.revocation_epoch !== live.revocation_epoch) return false;
  if (now < Date.parse(capability.not_before) || now >= Date.parse(capability.expires_at)) return false;
  if ((live.capability_uses_remaining[capability.capability_id] ?? 0) < 1) return false;
  return true;
}

function normalizeRemainingBudgets(value) {
  const input = plain(value, "invalid_live_budgets");
  exactKeys(input, ["money_minor", "privacy_bytes", "attention_seconds", "notifications", "network_requests"], "invalid_live_budget_fields");
  return {
    money_minor: integer(input.money_minor, "invalid_live_money_budget"),
    privacy_bytes: integer(input.privacy_bytes, "invalid_live_privacy_budget"),
    attention_seconds: integer(input.attention_seconds, "invalid_live_attention_budget"),
    notifications: integer(input.notifications, "invalid_live_notification_budget"),
    network_requests: integer(input.network_requests, "invalid_live_network_budget"),
  };
}

function normalizeLiveContext(value) {
  const input = plain(value, "invalid_live_context");
  exactKeys(input, [
    "now", "actor_authenticated", "authentication_evidence_sha256", "latest_intent_version", "policy_version",
    "tcb_manifest_sha256", "revocation_epoch", "authorization_proof_verified", "authorization_unconsumed",
    "authorization_uses_remaining", "verified_capability_ids", "capability_uses_remaining", "live_preconditions",
    "budgets_remaining", "co_principal_approvals_verified", "bystander_exposure",
  ], "invalid_live_context_fields");
  const uses = plain(input.capability_uses_remaining, "invalid_capability_uses_remaining");
  const normalizedUses = {};
  for (const [key, valueEntry] of Object.entries(uses)) normalizedUses[identifier(key, "invalid_live_capability_id")] = integer(valueEntry, "invalid_live_capability_uses");
  const preconditions = plain(input.live_preconditions, "invalid_live_preconditions");
  const normalizedPreconditions = {};
  for (const [path, actual] of Object.entries(preconditions)) {
    if (!JSON_POINTER.test(path)) fail("invalid_live_precondition_path");
    normalizedPreconditions[path] = jsonValue(actual, "invalid_live_precondition_value");
  }
  return {
    now: timestamp(input.now, "invalid_live_now"),
    actor_authenticated: boolean(input.actor_authenticated, "invalid_actor_authenticated"),
    authentication_evidence_sha256: digest(input.authentication_evidence_sha256, "invalid_live_authentication_evidence", true),
    latest_intent_version: integer(input.latest_intent_version, "invalid_latest_intent_version", 1),
    policy_version: input.policy_version === null ? null : identifier(input.policy_version, "invalid_live_policy_version"),
    tcb_manifest_sha256: digest(input.tcb_manifest_sha256, "invalid_live_tcb_manifest", true),
    revocation_epoch: integer(input.revocation_epoch, "invalid_live_revocation_epoch"),
    authorization_proof_verified: boolean(input.authorization_proof_verified, "invalid_authorization_proof_state"),
    authorization_unconsumed: boolean(input.authorization_unconsumed, "invalid_authorization_consumption_state"),
    authorization_uses_remaining: integer(input.authorization_uses_remaining, "invalid_authorization_uses_remaining"),
    verified_capability_ids: uniqueSorted(input.verified_capability_ids, identifier, "invalid_verified_capability_ids", 32),
    capability_uses_remaining: normalizedUses,
    live_preconditions: normalizedPreconditions,
    budgets_remaining: normalizeRemainingBudgets(input.budgets_remaining),
    co_principal_approvals_verified: boolean(input.co_principal_approvals_verified, "invalid_co_principal_approval_state"),
    bystander_exposure: enumeration(input.bystander_exposure, new Set(["none", "possible", "likely"]), "invalid_live_bystander_exposure"),
  };
}

function outcome(decision, code) {
  return Object.freeze({ decision, code });
}

export function evaluateExecutionGate(compiledValue, liveValue) {
  const { contract } = validateCompiledMoment(compiledValue);
  const live = normalizeLiveContext(liveValue);
  const now = Date.parse(live.now);

  if (!live.actor_authenticated || live.authentication_evidence_sha256 !== contract.actor.authentication_evidence_sha256) return outcome("deny", "actor_not_authenticated");
  if (live.latest_intent_version !== contract.intent.version) return outcome("deny", "stale_intent");
  if (live.policy_version === null || live.tcb_manifest_sha256 === null) return outcome("pending", "policy_unavailable");
  if (live.policy_version !== contract.policy.version) return outcome("deny", "policy_version_changed");
  if (live.tcb_manifest_sha256 !== contract.policy.tcb_manifest_sha256) return outcome("deny", "tcb_manifest_changed");
  if (live.revocation_epoch !== contract.authorization.revocation_epoch) return outcome("deny", "authorization_revoked");
  if (contract.policy.decision === "block") return outcome("deny", "policy_blocked");

  if (contract.authorization.mode !== "none") {
    if (now < Date.parse(contract.authorization.not_before)) return outcome("deny", "authorization_not_active");
    if (now >= Date.parse(contract.authorization.expires_at)) return outcome("deny", "authorization_expired");
    if (!live.authorization_proof_verified) return outcome("deny", "authorization_proof_invalid");
    if (!live.authorization_unconsumed || live.authorization_uses_remaining < 1) return outcome("deny", "authorization_replay");
  }

  for (const precondition of contract.preconditions) {
    if (!(precondition.path in live.live_preconditions)) return outcome("pending", "precondition_unavailable");
    if (!preconditionMatches(precondition, live.live_preconditions[precondition.path])) return outcome("deny", "stale_approval");
  }

  if (contract.action.required_capability) {
    const covered = contract.capabilities.some((capability) => capabilityCovers(capability, contract.action.required_capability, contract, live, now));
    if (!covered) return outcome("deny", "capability_not_satisfied");
  }

  const budgetFields = ["money_minor", "privacy_bytes", "attention_seconds", "notifications", "network_requests"];
  if (budgetFields.some((field) => contract.budgets[field] > live.budgets_remaining[field])) return outcome("pending", "budget_exhausted");
  if (contract.principal.co_principal_required && !live.co_principal_approvals_verified) return outcome("pending", "co_principal_approval_required");
  if (["confidential", "restricted"].includes(contract.disclosure.sensitivity) && live.bystander_exposure !== "none") {
    return outcome("deny", "unsafe_presentation_channel");
  }
  return outcome("allow", "execution_gate_passed");
}
