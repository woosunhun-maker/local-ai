import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryCandidate,
  evaluateMemoryRead,
  transitionMemory,
  validateCompiledMemory,
} from "../src/trust/memory-firewall.mjs";

const hash = (character) => character.repeat(64);

function candidate(overrides = {}) {
  return createMemoryCandidate({
    memory_id: "memory.shopping.water.001",
    namespace: "memory.owner",
    subject_id: "user.owner",
    category: "preference",
    scope: "shopping",
    purpose: "product_selection",
    value_sha256: hash("a"),
    source: { kind: "model_inference", source_sha256: hash("b") },
    confidence_bps: 8_000,
    created_at: "2026-08-05T00:00:00.000Z",
    expires_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  });
}

function activate(value = candidate()) {
  const confirmed = transitionMemory(value, {
    to: "confirmed",
    at: "2026-08-05T00:01:00.000Z",
    consent_ref: hash("c"),
  });
  return transitionMemory(confirmed, {
    to: "active",
    at: "2026-08-05T00:01:01.000Z",
    consent_ref: hash("c"),
  });
}

function readContext(overrides = {}) {
  return {
    now: "2026-08-05T00:02:00.000Z",
    namespace: "memory.owner",
    subject_id: "user.owner",
    scope: "shopping",
    purpose: "product_selection",
    channel: "local_owner_app",
    owner_authenticated: true,
    ...overrides,
  };
}

test("inferred memories begin as unreadable candidates", () => {
  const memory = candidate();
  assert.equal(memory.record.state, "candidate");
  assert.equal(memory.record.consent_ref, null);
  assert.deepEqual(evaluateMemoryRead(memory, readContext()), { decision: "deny", code: "memory_not_active" });
});

test("one exact confirmation can activate a hash-chained memory", () => {
  const initial = candidate();
  assert.throws(() => transitionMemory(initial, {
    to: "confirmed",
    at: "2026-08-05T00:01:00.000Z",
    consent_ref: null,
  }), /memory_confirmation_required/u);

  const confirmed = transitionMemory(initial, {
    to: "confirmed",
    at: "2026-08-05T00:01:00.000Z",
    consent_ref: hash("c"),
  });
  const active = transitionMemory(confirmed, {
    to: "active",
    at: "2026-08-05T00:01:01.000Z",
    consent_ref: hash("c"),
  });
  assert.equal(confirmed.record.previous_record_sha256, initial.sha256);
  assert.equal(active.record.previous_record_sha256, confirmed.sha256);
  assert.deepEqual(evaluateMemoryRead(active, readContext()), { decision: "allow", code: "memory_read_allowed" });
});

test("Telegram and voice never receive private durable memory", () => {
  const active = activate();
  assert.deepEqual(evaluateMemoryRead(active, readContext({ channel: "telegram" })), {
    decision: "deny",
    code: "private_memory_channel_blocked",
  });
  assert.deepEqual(evaluateMemoryRead(active, readContext({ channel: "voice" })), {
    decision: "deny",
    code: "private_memory_channel_blocked",
  });
});

test("namespace, subject, scope, purpose, expiry, and revocation are enforced independently", () => {
  const active = activate();
  assert.equal(evaluateMemoryRead(active, readContext({ subject_id: "user.other" })).code, "memory_principal_mismatch");
  assert.equal(evaluateMemoryRead(active, readContext({ purpose: "marketing" })).code, "memory_purpose_mismatch");
  assert.equal(evaluateMemoryRead(active, readContext({ now: "2026-09-05T00:00:00.000Z" })).code, "memory_expired");

  const revoked = transitionMemory(active, {
    to: "revoked",
    at: "2026-08-05T00:03:00.000Z",
    consent_ref: null,
  });
  assert.equal(evaluateMemoryRead(revoked, readContext()).code, "memory_not_active");
  assert.throws(() => transitionMemory(revoked, {
    to: "active",
    at: "2026-08-05T00:04:00.000Z",
    consent_ref: hash("c"),
  }), /terminal_memory_record/u);
});

test("tampering and unsupported secret-like categories fail closed", () => {
  assert.throws(() => candidate({ category: "credential" }), /invalid_memory_category/u);
  const memory = candidate();
  const tampered = structuredClone(memory);
  tampered.record.confidence_bps = 10_000;
  assert.throws(() => validateCompiledMemory(tampered), /compiled_memory_tampered/u);
});
