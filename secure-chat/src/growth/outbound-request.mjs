import { randomBytes } from "node:crypto";
import { canonicalizeJson, deepFreeze, isSha256, sha256Hex } from "./canonical.mjs";
import {
  compileOutboundDraft,
  DLP_POLICY_VERSION,
  validateCompiledOutboundRequest,
} from "./dlp.mjs";

export const FROZEN_REQUEST_SCHEMA = "local-ai.growth.frozen-request.v1";
export const OUTBOUND_PAYLOAD_SCHEMA = "local-ai.growth.consultation-payload.v2";
export const APPROVAL_SIGNING_PREFIX = "localai-approval-v1";
export const APPROVAL_DECISIONS = Object.freeze(["approved", "rejected"]);

export const OUTBOUND_DESTINATIONS = Object.freeze({
  "openai-consultant-v1": Object.freeze({
    id: "openai-consultant-v1",
    provider: "openai",
    model: "gpt-5.6-sol",
    transport: "isolated_stateless_text",
  }),
});

const REQUEST_KEYS = new Set([
  "schema",
  "requestId",
  "createdAt",
  "expiresAt",
  "nonce",
  "payload",
  "payloadCanonical",
  "payloadSha256",
  "requestSha256",
]);
const PAYLOAD_KEYS = new Set(["schema", "destination", "policyVersion", "request", "responseContract"]);
const REQUEST_CONTENT_KEYS = new Set([
  "templateId",
  "facts",
  "purpose",
  "question",
  "dataCategories",
  "evidence",
]);
const RESPONSE_CONTRACT = Object.freeze({
  format: "structured_advice",
  fields: Object.freeze(["judgment", "evidence", "risks", "recommendation"]),
  tools: false,
  memory: false,
  attachments: false,
});

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError(`${path} has an invalid schema`);
  }
}

function timestamp(value, label) {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} is not a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizedJson(value) {
  return JSON.parse(canonicalizeJson(value));
}

function randomId() {
  return randomBytes(12).toString("base64url");
}

function randomNonce() {
  return randomBytes(24).toString("base64url");
}

function validateOpaqueValue(value, label, minimum = 16, maximum = 128) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function buildPayload(draft, destinationId) {
  const destination = OUTBOUND_DESTINATIONS[destinationId];
  if (!destination) throw new Error("Outbound destination is not allowlisted");
  const request = compileOutboundDraft(draft);
  return normalizedJson({
    schema: OUTBOUND_PAYLOAD_SCHEMA,
    destination,
    policyVersion: DLP_POLICY_VERSION,
    request,
    responseContract: RESPONSE_CONTRACT,
  });
}

export function frozenRequestDigestFromBinding(binding) {
  return sha256Hex(canonicalizeJson({
    schema: FROZEN_REQUEST_SCHEMA,
    requestId: binding.requestId,
    createdAt: timestamp(binding.createdAt, "createdAt"),
    expiresAt: timestamp(binding.expiresAt, "expiresAt"),
    nonce: binding.nonce,
    payloadSha256: binding.payloadSha256,
  }));
}

export function createFrozenOutboundRequest(draft, options = {}) {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new RangeError("ttlMs must be between 60 seconds and 24 hours");
  }
  const createdAt = timestamp(options.now ?? Date.now(), "now");
  const expiresAt = timestamp(Date.parse(createdAt) + ttlMs, "expiresAt");
  const requestId = options.requestId ?? randomId();
  const nonce = options.nonce ?? randomNonce();
  validateOpaqueValue(requestId, "requestId");
  validateOpaqueValue(nonce, "nonce", 32);

  const payload = buildPayload(draft, options.destinationId ?? "openai-consultant-v1");
  const payloadCanonical = canonicalizeJson(payload);
  const payloadSha256 = sha256Hex(payloadCanonical);
  const base = {
    schema: FROZEN_REQUEST_SCHEMA,
    requestId,
    createdAt,
    expiresAt,
    nonce,
    payload,
    payloadCanonical,
    payloadSha256,
  };
  const requestSha256 = frozenRequestDigestFromBinding(base);
  return deepFreeze({ ...base, requestSha256 });
}

export function validateFrozenOutboundRequest(request, options = {}) {
  exactKeys(request, REQUEST_KEYS, "request");
  if (request.schema !== FROZEN_REQUEST_SCHEMA) throw new Error("Unsupported frozen request schema");
  validateOpaqueValue(request.requestId, "requestId");
  validateOpaqueValue(request.nonce, "nonce", 32);
  exactKeys(request.payload, PAYLOAD_KEYS, "request.payload");
  exactKeys(request.payload.request, REQUEST_CONTENT_KEYS, "request.payload.request");
  if (request.payload.schema !== OUTBOUND_PAYLOAD_SCHEMA) throw new Error("Unsupported outbound payload schema");
  const destination = OUTBOUND_DESTINATIONS[request.payload.destination?.id];
  if (!destination || canonicalizeJson(destination) !== canonicalizeJson(request.payload.destination)) {
    throw new Error("Outbound destination is not allowlisted");
  }
  if (request.payload.policyVersion !== DLP_POLICY_VERSION) throw new Error("DLP policy version mismatch");
  if (canonicalizeJson(request.payload.responseContract) !== canonicalizeJson(RESPONSE_CONTRACT)) {
    throw new Error("Outbound response contract mismatch");
  }
  validateCompiledOutboundRequest(request.payload.request);
  if (canonicalizeJson(request.payload) !== request.payloadCanonical) throw new Error("Canonical payload mismatch");
  if (Buffer.byteLength(request.payloadCanonical, "utf8") > 16 * 1024) throw new Error("Canonical payload is too large");
  if (!isSha256(request.payloadSha256) || sha256Hex(request.payloadCanonical) !== request.payloadSha256) {
    throw new Error("Payload digest mismatch");
  }
  if (!isSha256(request.requestSha256) || frozenRequestDigestFromBinding(request) !== request.requestSha256) {
    throw new Error("Request digest mismatch");
  }
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > 24 * 60 * 60 * 1000) {
    throw new Error("Request expiry is invalid");
  }
  const at = options.at === undefined ? Date.now() : options.at instanceof Date ? options.at.getTime() : Number(options.at);
  if (!Number.isFinite(at)) throw new TypeError("Validation time is invalid");
  if (!options.allowExpired && at >= expiresAt) throw new Error("Frozen request has expired");
  return true;
}

export function buildApprovalSigningMessage(request, decision) {
  validateFrozenOutboundRequest(request, { allowExpired: true, at: Date.parse(request.createdAt) });
  return buildApprovalSigningMessageFromBinding(request, decision);
}

export function buildApprovalSigningMessageFromBinding(binding, decision) {
  if (!APPROVAL_DECISIONS.includes(decision)) throw new Error("Approval decision is invalid");
  validateOpaqueValue(binding.requestId, "requestId");
  validateOpaqueValue(binding.nonce, "nonce", 32);
  if (!isSha256(binding.payloadSha256)) throw new Error("Approval payload digest is invalid");
  const expiresAt = timestamp(binding.expiresAt, "expiresAt");
  return [
    APPROVAL_SIGNING_PREFIX,
    binding.requestId,
    binding.payloadSha256,
    binding.nonce,
    expiresAt,
    decision,
  ].join("\n");
}
