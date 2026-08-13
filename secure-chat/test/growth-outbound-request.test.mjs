import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeJson, sha256Hex } from "../src/growth/canonical.mjs";
import {
  buildApprovalSigningMessage,
  createFrozenOutboundRequest,
  validateFrozenOutboundRequest,
} from "../src/growth/outbound-request.mjs";

function safeDraft(p95LatencyMs = 7_000) {
  return {
    schema: "local-ai.growth.structured-draft.v1",
    templateId: "performance_diagnostics_v1",
    facts: { sampleCount: 20, medianLatencyMs: 420, p95LatencyMs, failureCount: 1 },
  };
}

const FIXED_OPTIONS = Object.freeze({
  now: "2030-01-01T00:00:00.000Z",
  ttlMs: 300_000,
  requestId: "SYNTHETICREQ0001",
  nonce: "SYNTHETIC_NONCE_VALUE_000000000001",
});

test("canonical JSON is deterministic, normalized, and rejects unsupported values", () => {
  assert.equal(canonicalizeJson({ z: "e\u0301", a: -0 }), '{"a":0,"z":"é"}');
  assert.equal(canonicalizeJson({ a: 1, z: 2 }), canonicalizeJson({ z: 2, a: 1 }));
  assert.throws(() => canonicalizeJson({ unsafe: undefined }), /non-JSON/);
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non-finite/);
});

test("frozen request binds exact canonical payload, destination, nonce, and expiry", () => {
  const request = createFrozenOutboundRequest(safeDraft(), FIXED_OPTIONS);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.payload), true);
  assert.equal(request.payloadSha256, sha256Hex(request.payloadCanonical));
  assert.equal(validateFrozenOutboundRequest(request, { at: Date.parse("2030-01-01T00:04:59.000Z") }), true);
  assert.throws(() => validateFrozenOutboundRequest(request, { at: Date.parse("2030-01-01T00:05:00.000Z") }), /expired/);
  assert.throws(() => {
    request.payload.request.question = "변조";
  }, TypeError);
});

test("one structured fact change creates a different digest", () => {
  const first = createFrozenOutboundRequest(safeDraft(7_000), FIXED_OPTIONS);
  const second = createFrozenOutboundRequest(safeDraft(7_001), FIXED_OPTIONS);
  assert.notEqual(first.payloadCanonical, second.payloadCanonical);
  assert.notEqual(first.payloadSha256, second.payloadSha256);
});

test("exact-payload approval may remain pending for 24 hours but never longer", () => {
  const request = createFrozenOutboundRequest(safeDraft(), {
    ...FIXED_OPTIONS,
    ttlMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(request.expiresAt, "2030-01-02T00:00:00.000Z");
  assert.throws(
    () => createFrozenOutboundRequest(safeDraft(), { ...FIXED_OPTIONS, ttlMs: 24 * 60 * 60 * 1000 + 1 }),
    /24 hours/,
  );
});

test("Secure Enclave approval signing message uses the exact fixed six-line schema", () => {
  const request = createFrozenOutboundRequest(safeDraft(), FIXED_OPTIONS);
  assert.equal(
    buildApprovalSigningMessage(request, "approved"),
    [
      "localai-approval-v1",
      "SYNTHETICREQ0001",
      request.payloadSha256,
      "SYNTHETIC_NONCE_VALUE_000000000001",
      "2030-01-01T00:05:00.000Z",
      "approved",
    ].join("\n"),
  );
  assert.throws(() => buildApprovalSigningMessage(request, "maybe"), /decision/);
});

test("digest and canonical payload tampering are rejected", () => {
  const request = createFrozenOutboundRequest(safeDraft(), FIXED_OPTIONS);
  const tamperedDigest = { ...request, payloadSha256: "0".repeat(64) };
  assert.throws(() => validateFrozenOutboundRequest(tamperedDigest, { allowExpired: true }), /digest/);
  const tamperedCanonical = { ...request, payloadCanonical: `${request.payloadCanonical} ` };
  assert.throws(() => validateFrozenOutboundRequest(tamperedCanonical, { allowExpired: true }), /Canonical/);
});
