import {
  canonicalSha256,
  canonicalizeJson,
  deepFreeze,
  isSha256,
} from "../growth/canonical.mjs";

export const MEMORY_RECORD_SCHEMA = "local-ai.memory-record.v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LABEL = /^[a-z][a-z0-9._-]{0,63}$/u;
const CATEGORIES = new Set(["preference", "profile_fact", "relationship", "standing_policy"]);
const SOURCES = new Set(["user_explicit", "user_observed", "model_inference", "imported"]);
const STATES = new Set(["candidate", "confirmed", "active", "revoked", "expired"]);
const TERMINAL_STATES = new Set(["revoked", "expired"]);

export class MemoryFirewallError extends Error {
  constructor(code) {
    super(code);
    this.name = "MemoryFirewallError";
    this.code = code;
  }
}

function fail(code) {
  throw new MemoryFirewallError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function normalizedText(value, code, maximum = 128) {
  if (typeof value !== "string") fail(code);
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) fail(code);
  return normalized;
}

function identifier(value, code) {
  const normalized = normalizedText(value, code);
  if (!ID.test(normalized)) fail(code);
  return normalized;
}

function label(value, code) {
  const normalized = normalizedText(value, code, 64).toLowerCase();
  if (!LABEL.test(normalized)) fail(code);
  return normalized;
}

function enumeration(value, choices, code) {
  if (!choices.has(value)) fail(code);
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

function integer(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function normalizeSource(value) {
  const input = plain(value, "invalid_memory_source");
  exactKeys(input, ["kind", "source_sha256"], "invalid_memory_source_fields");
  return {
    kind: enumeration(input.kind, SOURCES, "invalid_memory_source_kind"),
    source_sha256: digest(input.source_sha256, "invalid_memory_source_digest"),
  };
}

function normalizeRecord(value) {
  const input = plain(value, "invalid_memory_record");
  exactKeys(input, [
    "schema", "memory_id", "namespace", "subject_id", "category", "scope", "purpose",
    "value_sha256", "source", "confidence_bps", "state", "consent_ref", "created_at",
    "updated_at", "expires_at", "previous_record_sha256",
  ], "invalid_memory_record_fields");
  if (input.schema !== MEMORY_RECORD_SCHEMA) fail("unsupported_memory_record_schema");
  const createdAt = timestamp(input.created_at, "invalid_memory_created_at");
  const updatedAt = timestamp(input.updated_at, "invalid_memory_updated_at");
  const expiresAt = timestamp(input.expires_at, "invalid_memory_expires_at");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("memory_update_before_creation");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0 || lifetime > 366 * 24 * 60 * 60_000) fail("invalid_memory_retention_window");
  const state = enumeration(input.state, STATES, "invalid_memory_state");
  const consentRef = digest(input.consent_ref, "invalid_memory_consent_ref", true);
  if (["confirmed", "active"].includes(state) && consentRef === null) fail("memory_consent_required");
  return {
    schema: MEMORY_RECORD_SCHEMA,
    memory_id: identifier(input.memory_id, "invalid_memory_id"),
    namespace: identifier(input.namespace, "invalid_memory_namespace"),
    subject_id: identifier(input.subject_id, "invalid_memory_subject"),
    category: enumeration(input.category, CATEGORIES, "invalid_memory_category"),
    scope: label(input.scope, "invalid_memory_scope"),
    purpose: label(input.purpose, "invalid_memory_purpose"),
    value_sha256: digest(input.value_sha256, "invalid_memory_value_digest"),
    source: normalizeSource(input.source),
    confidence_bps: integer(input.confidence_bps, "invalid_memory_confidence", 0, 10_000),
    state,
    consent_ref: consentRef,
    created_at: createdAt,
    updated_at: updatedAt,
    expires_at: expiresAt,
    previous_record_sha256: digest(input.previous_record_sha256, "invalid_previous_memory_record", true),
  };
}

function compileRecord(record) {
  const normalized = normalizeRecord(record);
  const canonical = canonicalizeJson(normalized);
  return deepFreeze({ record: deepFreeze(normalized), canonical, sha256: canonicalSha256(normalized) });
}

export function createMemoryCandidate(value) {
  const input = plain(value, "invalid_memory_candidate");
  exactKeys(input, [
    "memory_id", "namespace", "subject_id", "category", "scope", "purpose", "value_sha256",
    "source", "confidence_bps", "created_at", "expires_at",
  ], "invalid_memory_candidate_fields");
  return compileRecord({
    schema: MEMORY_RECORD_SCHEMA,
    ...input,
    state: "candidate",
    consent_ref: null,
    updated_at: input.created_at,
    previous_record_sha256: null,
  });
}

export function validateCompiledMemory(value) {
  const input = plain(value, "invalid_compiled_memory");
  exactKeys(input, ["record", "canonical", "sha256"], "invalid_compiled_memory_fields");
  if (typeof input.canonical !== "string" || !isSha256(input.sha256)) fail("invalid_compiled_memory_binding");
  const recompiled = compileRecord(input.record);
  if (recompiled.canonical !== input.canonical || recompiled.sha256 !== input.sha256) fail("compiled_memory_tampered");
  return recompiled;
}

export function transitionMemory(value, transition) {
  const compiled = validateCompiledMemory(value);
  const input = plain(transition, "invalid_memory_transition");
  exactKeys(input, ["to", "at", "consent_ref"], "invalid_memory_transition_fields");
  const to = enumeration(input.to, STATES, "invalid_memory_transition_target");
  const at = timestamp(input.at, "invalid_memory_transition_time");
  const consentRef = digest(input.consent_ref, "invalid_memory_transition_consent", true);
  const current = compiled.record;
  if (TERMINAL_STATES.has(current.state)) fail("terminal_memory_record");
  if (Date.parse(at) < Date.parse(current.updated_at)) fail("memory_transition_time_regressed");

  const allowed = (
    (current.state === "candidate" && to === "confirmed")
    || (current.state === "confirmed" && to === "active")
    || (["candidate", "confirmed", "active"].includes(current.state) && to === "revoked")
    || (current.state === "active" && to === "expired")
  );
  if (!allowed) fail("invalid_memory_transition");

  if (to === "confirmed" && consentRef === null) fail("memory_confirmation_required");
  if (to === "active" && (consentRef === null || consentRef !== current.consent_ref)) fail("memory_activation_consent_mismatch");
  if (to === "expired" && Date.parse(at) < Date.parse(current.expires_at)) fail("memory_not_expired");

  return compileRecord({
    ...current,
    state: to,
    consent_ref: to === "confirmed" ? consentRef : current.consent_ref,
    updated_at: at,
    previous_record_sha256: compiled.sha256,
  });
}

function decision(decisionValue, code) {
  return Object.freeze({ decision: decisionValue, code });
}

export function evaluateMemoryRead(value, context) {
  const { record } = validateCompiledMemory(value);
  const input = validateMemoryReadContext(context);

  if (!input.owner_authenticated) return decision("deny", "memory_owner_not_authenticated");
  if (input.channel !== "local_owner_app") return decision("deny", "private_memory_channel_blocked");
  if (record.state !== "active") return decision("deny", "memory_not_active");
  if (Date.parse(input.now) >= Date.parse(record.expires_at)) return decision("deny", "memory_expired");
  if (record.namespace !== input.namespace || record.subject_id !== input.subject_id) return decision("deny", "memory_principal_mismatch");
  if (record.scope !== input.scope || record.purpose !== input.purpose) return decision("deny", "memory_purpose_mismatch");
  return decision("allow", "memory_read_allowed");
}

export function validateMemoryReadContext(context) {
  const input = plain(context, "invalid_memory_read_context");
  exactKeys(input, ["now", "namespace", "subject_id", "scope", "purpose", "channel", "owner_authenticated"], "invalid_memory_read_context_fields");
  const now = timestamp(input.now, "invalid_memory_read_time");
  const namespace = identifier(input.namespace, "invalid_memory_read_namespace");
  const subjectId = identifier(input.subject_id, "invalid_memory_read_subject");
  const scope = label(input.scope, "invalid_memory_read_scope");
  const purpose = label(input.purpose, "invalid_memory_read_purpose");
  const channel = enumeration(input.channel, new Set(["local_owner_app", "telegram", "voice"]), "invalid_memory_read_channel");
  if (typeof input.owner_authenticated !== "boolean") fail("invalid_memory_owner_authentication");
  return deepFreeze({
    now,
    namespace,
    subject_id: subjectId,
    scope,
    purpose,
    channel,
    owner_authenticated: input.owner_authenticated,
  });
}
